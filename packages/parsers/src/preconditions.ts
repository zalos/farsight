/**
 * Preconditions, read from the code (gates lane, 2026-10-10).
 *
 * A business reader asks of an action *what must be true before it goes through*: the record is
 * in the right status, the records loaded beside it are, nothing required is missing. Those facts
 * live inside use-cases, in four shapes, and before this pass none of them was a gate — the parser
 * filed each as a technical branch:
 *
 * 1. **A guard clause** on the record's own status, kind or flag: `if (x.status !== 'SUBMITTED')
 *    throw conflict(…)`, or an early `return` in a UI handler the team labelled `@business`.
 * 2. **A related record** loaded with it and compared the same way (`ctx.contractor.status`).
 * 3. **A blocker list** one throw refuses: `blockers.push(…)` under a comparison, then
 *    `if (blockers.length) throw …` — in the same function, or in the action that called the
 *    function returning the list (one hop).
 * 4. **A transition table**: `guard(ctx.invoice.status, 'APPROVED')` over a constant
 *    `{ VERIFIED: ['APPROVED', …], … }`, read inverted.
 *
 * Each becomes a `rule` node tagged `precondition` (`GraphNode.precondition`) with a `validates`
 * edge to the action, technique `precondition`, so it rides the gate machinery and the gate card.
 * A comparison whose arm only routes (no throw, no refusing return, no refused list) is a
 * decision, not a precondition, and is left alone. **Never guessed:** the record must resolve to a
 * table the graph knows, or the team must have labelled the arm `@business`.
 *
 * Also here: a role guard's constant argument (`requireOpsRole(p, ROLES.approve)`) read into
 * `meta.requires` on its `guards` edge, and the `action-gate` tag on a `@guard` that writes a
 * record's status — the action itself, never a gate on itself.
 */
import type { GraphEdge, GraphNode, GateClass, Precondition } from '@farsight/core';
import { CONFIG_CHECK_TAG } from '@farsight/core';
import { walk, isNode, type AstNode } from './walk.js';
import { STATUS_KEY, fieldKey, priorStatusesIn, type ConstTable, type EnumDecl } from './lifecycle.js';
import { leadingBranchLabel, trailingBranchLabel } from './shared/labels.js';

/** A field compared as a kind or a type is a state of the record too (`kind`, `type`, `fooType`). */
const KIND_KEY = /^(kind|type)$|(Kind|Type|_kind|_type)$/;
/** A boolean the record carries: `isActive`, `hasDocs`, `enabled`, `verified`. */
const FLAG_KEY = /^(is|has|can)[A-Z_]|^(active|enabled|allowed|verified|approved|locked|archived|deleted|blocked|disabled|paid|closed)$/;
/** The helpers a server answers a refusal with, and the status each means. */
const HELPER_STATUS: Record<string, number> = {
  badRequest: 400, unauthorized: 401, unauthorised: 401, forbidden: 403, notFound: 404,
  conflict: 409, gone: 410, preconditionFailed: 412, unprocessable: 422, unprocessableEntity: 422,
  tooManyRequests: 429, invalid: 422,
};
const HELPER_WORD: Record<number, string> = {
  400: 'bad request', 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 409: 'conflict',
  410: 'gone', 412: 'precondition failed', 422: 'unprocessable', 429: 'too many requests',
};

/** One refusing comparison inside one function body. */
export interface RefusalCheck {
  fromId: string;
  file: string;
  line: number;
  endLine: number;
  /** the compared object's member chain (`['ctx', 'contractor']`) */
  chain: string[];
  field: string;
  kind: Precondition['kind'];
  requires: string[];
  excludes: string[];
  refusal: 'throw' | 'return' | 'push';
  status?: number;
  helper?: string;
  message?: string;
  /** a `push` refusal: the list it pushes into */
  pushInto?: string;
  business?: string;
}
/** `if (list.length) throw …`: the list, and where it came from. */
export interface ListRefusal {
  fromId: string;
  list: string;
  line: number;
  status?: number;
  helper?: string;
  message?: string;
  /** the list is the result of calling this function (`const blockers = await completenessBlockers(…)`) */
  callee?: string;
}
/** `guard(ctx.invoice.status, 'APPROVED')`: a call handed the record's status and a literal status. */
export interface TransitionCall { fromId: string; callee: string; chain: string[]; field: string; to: string; line: number }
/** `const x = await repos.contractors.getContractor(…)` → x is a `contractors` record. */
export interface RepoBinding { fromId: string; name: string; collection: string }
/** A call handed a constant: `requireOpsRole(p, ROLES.approve)` / `requireRole(ADMIN_ROLES)`. */
export interface ConstArgCall { fromId: string; callee: string; line: number; ref: { table: string; key?: string } }

export interface PreconditionFacts {
  checks: RefusalCheck[];
  lists: ListRefusal[];
  /** function id → the local lists it returns */
  returned: Map<string, Set<string>>;
  transitions: TransitionCall[];
  bindings: RepoBinding[];
  constArgs: ConstArgCall[];
  /** function id → the constant tables it indexes (`T[from]`) */
  tableRefs: Map<string, Set<string>>;
  tables: ConstTable[];
}

export function emptyPreconditionFacts(): PreconditionFacts {
  return { checks: [], lists: [], returned: new Map(), transitions: [], bindings: [], constArgs: [], tableRefs: new Map(), tables: [] };
}

// ── reading one body ───────────────────────────────────────────────────────

const unwrap = (n: unknown): AstNode | undefined => {
  let x = isNode(n) ? n : undefined;
  while (x && (x.type === 'ChainExpression' || x.type === 'ParenthesizedExpression' || x.type === 'TSNonNullExpression' || x.type === 'AwaitExpression' || x.type === 'TSAsExpression')) {
    x = (x.expression ?? x.argument) as AstNode | undefined;
  }
  return x;
};
/** `a.b?.c` → ['a', 'b', 'c']; a computed member or a call ends the chain (`[]`). */
function chainOf(n: unknown): string[] {
  const x = unwrap(n);
  if (!x) return [];
  if (x.type === 'Identifier') return [String(x.name)];
  if (x.type === 'ThisExpression') return ['this'];
  if ((x.type === 'MemberExpression' || x.type === 'StaticMemberExpression') && !x.computed) {
    const p = x.property as AstNode | undefined;
    const name = p && (p.type === 'Identifier' || p.type === 'IdentifierName') ? String(p.name) : undefined;
    const head = chainOf(x.object);
    return name && head.length ? [...head, name] : [];
  }
  return [];
}
const strLit = (n: unknown): string | undefined => {
  const x = unwrap(n);
  return x && (x.type === 'Literal' || x.type === 'StringLiteral') && typeof x.value === 'string' ? x.value : undefined;
};
const numLit = (n: unknown): number | undefined => {
  const x = unwrap(n);
  return x && (x.type === 'Literal' || x.type === 'NumericLiteral') && typeof x.value === 'number' ? x.value : undefined;
};
/** The first string the refusal says: a literal, or a template with its holes as `…`. */
function messageIn(n: unknown): string | undefined {
  let found: string | undefined;
  walk(n, (x) => {
    if (found) return false;
    if ((x.type === 'Literal' || x.type === 'StringLiteral') && typeof x.value === 'string' && /\s/.test(x.value)) { found = x.value; return false; }
    if (x.type === 'TemplateLiteral') {
      const q = ((x.quasis as AstNode[]) ?? []).map((p) => (p.value as { cooked?: string })?.cooked ?? '');
      const t = q.join('…').replace(/\s+/g, ' ').trim();
      if (/[a-z]{3}/i.test(t)) { found = t; return false; }
    }
    return undefined;
  });
  return found?.slice(0, 200);
}
/** A 4xx the refusal names: a helper (`conflict(…)`), `.status(409)`, or `{ status: 409 }`. */
function statusIn(n: unknown): { status?: number; helper?: string } {
  let out: { status?: number; helper?: string } = {};
  walk(n, (x) => {
    if (out.status) return false;
    if (x.type === 'CallExpression' || x.type === 'NewExpression') {
      const c = chainOf(x.callee);
      const tail = c[c.length - 1];
      if (tail && HELPER_STATUS[tail]) { out = { status: HELPER_STATUS[tail], helper: tail }; return false; }
      if (tail === 'status') { const v = numLit(((x.arguments as AstNode[]) ?? [])[0]); if (v && v >= 400 && v < 500) { out = { status: v }; return false; } }
      if (tail && !out.helper && /^[a-z]\w*$/.test(tail) && x.type === 'CallExpression') out.helper = tail;
    }
    if (x.type === 'Property') {
      const k = isNode(x.key) ? (x.key as AstNode).name ?? (x.key as AstNode).value : undefined;
      const v = numLit(x.value);
      if ((k === 'status' || k === 'statusCode') && v && v >= 400 && v < 500) { out = { ...out, status: v }; return false; }
    }
    return undefined;
  });
  return out;
}
/** The statements of an arm, a block or one statement. */
const stmtsOf = (n: AstNode | undefined): AstNode[] => !n ? [] : n.type === 'BlockStatement' ? ((n.body as AstNode[]) ?? []).filter(isNode) : [n];

interface Refusal { refusal: RefusalCheck['refusal']; status?: number; helper?: string; message?: string; pushInto?: string; bare?: boolean }
/** Does this arm refuse, and how? `undefined` when it only routes. */
function refusalOf(arm: AstNode | undefined): Refusal | undefined {
  const st = stmtsOf(arm);
  const last = st[st.length - 1];
  if (!last) return undefined;
  if (last.type === 'ThrowStatement') return { refusal: 'throw', ...statusIn(last.argument), message: messageIn(last.argument) };
  if (last.type === 'ReturnStatement') {
    const s = statusIn(st);
    const arg = unwrap(last.argument);
    if (s.status) return { refusal: 'return', ...s, message: messageIn(st) };
    const bare = !arg || (arg.type === 'Literal' && (arg.value === null || arg.value === false)) || (arg.type === 'Identifier' && arg.name === 'undefined');
    return bare ? { refusal: 'return', bare: true } : undefined;
  }
  // every statement a push into the same list: a blocker list
  const pushes = st.map((s) => {
    const e = s.type === 'ExpressionStatement' ? unwrap(s.expression) : undefined;
    if (e?.type !== 'CallExpression') return undefined;
    const c = chainOf(e.callee);
    return c.length === 2 && c[1] === 'push' ? { list: c[0]!, message: messageIn(e.arguments) } : undefined;
  });
  if (pushes.length && pushes.every((p) => p && p.list === pushes[0]!.list)) return { refusal: 'push', pushInto: pushes[0]!.list, message: pushes[0]!.message };
  return undefined;
}

interface Atom { chain: string[]; field: string; kind: Precondition['kind']; requires: string[]; excludes: string[] }
/** What one atom of a test says must hold for the code after it — read as *this is what refuses*. */
function atomOf(n: unknown, negated: boolean): Atom | undefined {
  const x = unwrap(n);
  if (!x) return undefined;
  if (x.type === 'UnaryExpression' && x.operator === '!') return atomOf(x.argument, !negated);
  if (x.type === 'BinaryExpression') {
    const op = String(x.operator);
    // `x.lines.length < 1` / `=== 0` / `<= 0`: refuses an empty list
    {
      const c = chainOf(x.left);
      const v = numLit(x.right);
      if (c.length >= 3 && c[c.length - 1] === 'length' && v !== undefined) {
        const empty = (op === '<' && v === 1) || ((op === '===' || op === '==') && v === 0) || (op === '<=' && v === 0);
        return empty && !negated ? { chain: c.slice(0, -2), field: c[c.length - 2]!, kind: 'present', requires: [], excludes: [] } : undefined;
      }
    }
    if (!['===', '!==', '==', '!='].includes(op)) return undefined;
    for (const [a, b] of [[x.left, x.right], [x.right, x.left]] as const) {
      const value = strLit(b);
      const c = chainOf(a);
      const field = c[c.length - 1];
      if (value === undefined || c.length < 2 || !field || !(STATUS_KEY.test(field) || KIND_KEY.test(field))) continue;
      // the test is what refuses: `!==` refuses every other value → the record must be `value`
      const equal = (op === '===' || op === '==') !== negated;
      return { chain: c.slice(0, -1), field, kind: 'state', requires: equal ? [] : [value], excludes: equal ? [value] : [] };
    }
    return undefined;
  }
  // `!x.lines.length` refuses an empty list; `!x.isActive` refuses a flag left clear
  const c = chainOf(x);
  if (c.length >= 3 && c[c.length - 1] === 'length' && negated) return { chain: c.slice(0, -2), field: c[c.length - 2]!, kind: 'present', requires: [], excludes: [] };
  const field = c[c.length - 1];
  if (c.length >= 2 && field && FLAG_KEY.test(field)) return { chain: c.slice(0, -1), field, kind: 'flag', requires: negated ? ['true'] : [], excludes: negated ? [] : ['true'] };
  return undefined;
}
/** Every atom whose truth alone refuses: each side of `||`, and the comparisons under `&&` (the rest are presence checks). */
function atomsOf(test: unknown): Atom[] {
  const x = unwrap(test);
  if (!x) return [];
  if (x.type === 'LogicalExpression' && (x.operator === '||' || x.operator === '&&')) return [...atomsOf(x.left), ...atomsOf(x.right)];
  const a = atomOf(x, false);
  return a ? [a] : [];
}

/** `if (list.length)` / `> 0` / `!== 0` / `>= 1`: the list refuses when it is not empty. */
function nonEmptyListTest(test: unknown): string | undefined {
  const x = unwrap(test);
  if (!x) return undefined;
  const c = chainOf(x);
  if (c.length === 2 && c[1] === 'length') return c[0];
  if (x.type === 'BinaryExpression') {
    const l = chainOf(x.left);
    const v = numLit(x.right);
    const op = String(x.operator);
    if (l.length === 2 && l[1] === 'length' && v !== undefined && ((op === '>' && v === 0) || ((op === '!==' || op === '!=') && v === 0) || (op === '>=' && v === 1))) return l[0];
  }
  return undefined;
}

/**
 * The refusing comparisons, refused lists, transition calls and repository bindings in one function
 * body. `source` gives the `@business` labels the same way `extractBranches` reads them.
 */
export function collectPreconditionFacts(body: AstNode | null, fromId: string, file: string, source: string, line: (o: number) => number, into: PreconditionFacts): void {
  if (!body) return;
  const localLists = new Set<string>();
  const callResult = new Map<string, string>();
  walk(body, (n, parents) => {
    // a nested function declared inside is its own declaration (the adapter walks it as one)
    if (n !== body && n.type === 'FunctionDeclaration') return false;
    if (n.type === 'VariableDeclarator' && isNode(n.id) && (n.id as AstNode).type === 'Identifier') {
      const name = String((n.id as AstNode).name);
      const init = unwrap(n.init);
      if (init?.type === 'ArrayExpression' && !((init.elements as unknown[]) ?? []).length) localLists.add(name);
      if (init?.type === 'CallExpression') {
        const c = chainOf(init.callee);
        if (c.length) callResult.set(name, c[c.length - 1]!);
        // `repos.contractors.getContractor(…)` / `db.contractors.findOne(…)`
        if (c.length === 3 && /^(get|find|load|fetch|read|lookup|select)/i.test(c[2]!)) into.bindings.push({ fromId, name, collection: c[1]! });
      }
    }
    if (n.type === 'ReturnStatement') {
      const a = unwrap(n.argument);
      if (a?.type === 'Identifier' && localLists.has(String(a.name))) {
        const s = into.returned.get(fromId) ?? new Set<string>();
        s.add(String(a.name));
        into.returned.set(fromId, s);
      }
    }
    if ((n.type === 'MemberExpression' || n.type === 'ComputedMemberExpression') && n.computed) {
      const c = chainOf(n.object);
      if (c.length === 1 && /^[A-Z][A-Z0-9_]+$/.test(c[0]!)) {
        const s = into.tableRefs.get(fromId) ?? new Set<string>();
        s.add(c[0]!);
        into.tableRefs.set(fromId, s);
      }
    }
    if (n.type === 'CallExpression') {
      const c = chainOf(n.callee);
      const callee = c[c.length - 1];
      const args = ((n.arguments as AstNode[]) ?? []);
      if (callee && args.length >= 2) {
        const statusArg = args.map(chainOf).find((a) => a.length >= 2 && STATUS_KEY.test(a[a.length - 1]!));
        const to = args.map(strLit).find((v) => v !== undefined);
        if (statusArg && to !== undefined && !args.some((a) => unwrap(a)?.type === 'ObjectExpression')) {
          into.transitions.push({ fromId, callee, chain: statusArg.slice(0, -1), field: statusArg[statusArg.length - 1]!, to, line: line(n.start ?? 0) });
        }
      }
      if (callee) {
        for (const a of args) {
          const ac = chainOf(a);
          if (ac.length >= 1 && ac.length <= 2 && /^[A-Z][A-Z0-9_]+$/.test(ac[0]!)) {
            into.constArgs.push({ fromId, callee, line: line(n.start ?? 0), ref: { table: ac[0]!, ...(ac[1] ? { key: ac[1] } : {}) } });
          }
        }
      }
    }
    if (n.type !== 'IfStatement' || !isNode(n.test)) return undefined;
    const test = n.test as AstNode;
    const consequent = n.consequent as AstNode;
    const refusal = refusalOf(consequent);
    if (!refusal) return undefined;
    // the team's words for this fork: above the `if`, at the end of its test line, or on the arm
    const business = leadingBranchLabel(source, n.start ?? 0) ?? trailingBranchLabel(source, test.start ?? 0)
      ?? trailingBranchLabel(source, consequent.start ?? 0);
    // `if (blockers.length) throw …`: the list refuses
    const list = refusal.refusal !== 'push' ? nonEmptyListTest(test) : undefined;
    if (list) {
      into.lists.push({ fromId, list, line: line(test.start ?? 0), ...(refusal.status ? { status: refusal.status } : {}), ...(refusal.helper ? { helper: refusal.helper } : {}),
        ...(refusal.message ? { message: refusal.message } : {}), ...(callResult.has(list) ? { callee: callResult.get(list) } : {}) });
      return undefined;
    }
    // a bare early return refuses only where the team said so (a UI handler's `@business` arm)
    if (refusal.bare && !business) return undefined;
    void parents;
    for (const a of atomsOf(test)) {
      into.checks.push({
        fromId, file, line: line(test.start ?? 0), endLine: line(n.end ?? 0), chain: a.chain, field: a.field, kind: a.kind,
        requires: a.requires, excludes: a.excludes, refusal: refusal.refusal,
        ...(refusal.status ? { status: refusal.status } : {}), ...(refusal.helper ? { helper: refusal.helper } : {}),
        ...(refusal.message ? { message: refusal.message } : {}), ...(refusal.pushInto ? { pushInto: refusal.pushInto } : {}),
        ...(business ? { business } : {}),
      });
    }
    return undefined;
  });
}

// ── joining the facts on the graph ─────────────────────────────────────────

const norm = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
const singular = (s: string): string => s.replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/s$/, '');
/** `PENDING_CLIENT_APPROVAL` → `pending client approval`; `bcSyncStatus` → `bc sync status`. */
export function wordsOf(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
const orList = (xs: string[]): string => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;

/** The plain sentence when nobody wrote one: `contractor status must be active`. */
export function humanizePrecondition(p: Pick<Precondition, 'record' | 'field' | 'kind' | 'requires' | 'excludes'>): string {
  const rec = wordsOf(singular(p.record));
  const field = wordsOf(p.field);
  if (p.kind === 'present') return `${rec} ${field} must not be empty`;
  if (p.kind === 'flag') return `${rec} must ${p.requires.includes('true') ? '' : 'not '}be ${field}`.replace(/\s+/g, ' ');
  if (p.requires.length) return `${rec} ${field} must be ${orList(p.requires.map(wordsOf))}`;
  return `${rec} ${field} must not be ${orList((p.excludes ?? []).map(wordsOf))}`;
}
/** The code register's short form: `invoices.status = draft`, `contact_vendor_links.status ∉ {PENDING, REJECTED}`. */
export function codeFormOf(p: Pick<Precondition, 'record' | 'field' | 'kind' | 'requires' | 'excludes'>): string {
  const at = `${p.record}.${p.field}`;
  if (p.kind === 'present') return `${at} not empty`;
  if (p.requires.length === 1) return `${at} = ${p.requires[0]}`;
  if (p.requires.length > 1) return `${at} ∈ {${p.requires.join(', ')}}`;
  const ex = p.excludes ?? [];
  return ex.length === 1 ? `${at} ≠ ${ex[0]}` : `${at} ∉ {${ex.join(', ')}}`;
}
function classOf(kind: Precondition['kind'], words: string): GateClass {
  if (/duplicate|already exists|same number|twice/i.test(words)) return 'integrity';
  return kind === 'present' ? 'completeness' : 'record-state';
}
const elseOf = (r: { refusal: string; status?: number; helper?: string }): string =>
  r.status ? `${r.status} ${HELPER_WORD[r.status] ?? (r.helper ? wordsOf(r.helper) : 'refused')}`
  : r.helper ? `throw ${r.helper}` : r.refusal === 'return' ? 'nothing happens (returns early)' : 'refused';

export interface PreconditionLinkResult { preconditions: number; actionGates: number; roles: number; fromTables: number }

/**
 * Join the facts on the graph: preconditions on the actions (rule nodes + `validates` edges), the
 * transition table's prior statuses on the lifecycle's moves, a role guard's constant on its edge,
 * and the `action-gate` tag. Mutates `nodes` and `edges`. Run after `linkLifecycles`.
 */
export function linkPreconditions(repo: string, nodes: Map<string, GraphNode>, edges: GraphEdge[], f: PreconditionFacts, decls: EnumDecl[] = []): PreconditionLinkResult {
  const result: PreconditionLinkResult = { preconditions: 0, actionGates: 0, roles: 0, fromTables: 0 };
  const out = new Map<string, GraphEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const tables = [...nodes.values()].filter((n) => n.kind === 'table' && n.id.startsWith(`${repo}::`));

  // ── the record a word names: a repository binding, the table of that name, a unique table ending in it ──
  const tableFor = (word: string, collection?: string): GraphNode | undefined => {
    const key = (s: string) => singular(norm(s));
    if (collection) { const t = tables.find((x) => key(x.name) === key(collection)); if (t) return t; }
    const w = key(word);
    if (!w) return undefined;
    const exact = tables.filter((x) => key(x.name) === w);
    if (exact.length === 1) return exact[0];
    if (w.length < 4) return undefined;
    const ends = tables.filter((x) => key(x.name).endsWith(w));
    return ends.length === 1 ? ends[0] : undefined;
  };
  const bindingsBy = new Map<string, Map<string, string>>();
  for (const b of f.bindings) { const m = bindingsBy.get(b.fromId) ?? new Map<string, string>(); m.set(b.name, b.collection); bindingsBy.set(b.fromId, m); }

  // ── the actions: functions that move a record's status, the routes and the functions they call first ──
  const writes = new Map<string, Set<string>>(); // action id → the tables whose status it writes
  for (const t of tables) for (const tr of t.lifecycle?.transitions ?? []) {
    const s = writes.get(tr.by) ?? new Set<string>();
    s.add(t.id);
    writes.set(tr.by, s);
  }
  const actions = new Set<string>(writes.keys());
  // the records an action writes at all (its own writes, or a call's, one hop down) — `own` vs `related`
  const written = (id: string): Set<string> => {
    const s = new Set(writes.get(id) ?? []);
    for (const e of out.get(id) ?? []) {
      if (e.kind === 'writes') s.add(e.to);
      else if (e.kind === 'calls') for (const x of out.get(e.to) ?? []) if (x.kind === 'writes') s.add(x.to);
    }
    return s;
  };
  for (const n of nodes.values()) {
    if (n.kind !== 'route' || n.loc?.repo !== repo) continue;
    actions.add(n.id);
    for (const e of out.get(n.id) ?? []) if (e.kind === 'calls') actions.add(e.to);
  }
  // a refusal the team labelled is a precondition wherever it sits (a UI handler's early return)
  for (const c of f.checks) if (c.business && c.refusal !== 'push') actions.add(c.fromId);

  const callee = (from: string, name: string): string[] =>
    (out.get(from) ?? []).filter((e) => e.kind === 'calls' || e.kind === 'guards').map((e) => e.to)
      .filter((id) => { const n = nodes.get(id); const nm = n?.name.split(': ')[0] ?? ''; return nm === name || nm.endsWith(`.${name}`); });
  const checksBy = new Map<string, RefusalCheck[]>();
  for (const c of f.checks) checksBy.set(c.fromId, [...(checksBy.get(c.fromId) ?? []), c]);
  const listsBy = new Map<string, ListRefusal[]>();
  for (const l of f.lists) listsBy.set(l.fromId, [...(listsBy.get(l.fromId) ?? []), l]);

  type Found = Omit<Precondition, 'tier'> & { endLine: number; sources: number };
  const found = new Map<string, Found>();
  const add = (action: string, c: { file: string; line: number; endLine: number; chain: string[]; field: string; kind: Precondition['kind']; requires: string[]; excludes: string[]; business?: string; message?: string; fromId: string },
    refusedBy: { refusal: string; status?: number; helper?: string }, via: Precondition['via']): void => {
    const word = c.chain[c.chain.length - 1] ?? '';
    const own = writes.get(action);
    const table = tableFor(word, bindingsBy.get(c.fromId)?.get(word) ?? bindingsBy.get(action)?.get(word));
    if (!table && !c.business) return; // never guessed: a table the graph knows, or the team's own label
    const record = table?.name ?? word;
    const key = `${action}|${record}|${fieldKey(c.field)}|${c.kind}`;
    const have = found.get(key);
    if (have) {
      for (const v of c.requires) if (!have.requires.includes(v)) have.requires.push(v);
      for (const v of c.excludes) if (!(have.excludes ??= []).includes(v)) have.excludes.push(v);
      have.sources++;
      if (have.wordsFrom !== 'business') { have.words = ''; have.wordsFrom = 'humanize'; }
      return;
    }
    const words = c.business ?? c.message ?? '';
    found.set(key, {
      record, ...(table ? { table: table.id } : {}), field: c.field, requires: [...c.requires], ...(c.excludes.length ? { excludes: [...c.excludes] } : {}),
      kind: c.kind, else: elseOf(refusedBy), via, path: c.file, line: c.line, endLine: c.endLine,
      class: classOf(c.kind, words), words, wordsFrom: c.business ? 'business' : c.message ? 'message' : 'humanize',
      action, relation: table && (own?.has(table.id) || written(action).has(table.id)) ? 'own' : 'related', sources: 1,
    });
  };

  for (const action of actions) {
    // shapes 1 and 2: the action's own guard clauses
    const lists = listsBy.get(action) ?? [];
    for (const c of checksBy.get(action) ?? []) {
      if (c.refusal === 'push') {
        const l = lists.find((x) => x.list === c.pushInto && !x.callee);
        if (l) add(action, c, { refusal: 'throw', ...l }, 'blocker-list');
        continue;
      }
      add(action, c, c, 'guard-clause');
    }
    // shape 3, one hop: the list a called function returns, refused here
    for (const l of lists) {
      if (!l.callee) continue;
      for (const fid of callee(action, l.callee)) {
        const returned = f.returned.get(fid);
        if (!returned?.size) continue;
        for (const c of checksBy.get(fid) ?? []) if (c.refusal === 'push' && returned.has(c.pushInto!)) add(action, c, { refusal: 'throw', ...l }, 'blocker-list');
      }
    }
  }

  // ── shape 4: a transition table, read inverted ──
  const tablesByName = new Map<string, ConstTable[]>();
  for (const t of f.tables) tablesByName.set(t.name, [...(tablesByName.get(t.name) ?? []), t]);
  const tableReached = (fid: string, hops: number, seen = new Set<string>()): ConstTable[] => {
    if (seen.has(fid)) return [];
    seen.add(fid);
    const own = [...(f.tableRefs.get(fid) ?? [])].flatMap((n) => tablesByName.get(n) ?? []);
    if (own.length || hops <= 0) return own;
    return (out.get(fid) ?? []).filter((e) => e.kind === 'calls' || e.kind === 'guards').flatMap((e) => tableReached(e.to, hops - 1, seen));
  };
  for (const t of f.transitions) {
    if (!actions.has(t.fromId)) continue;
    const reached = callee(t.fromId, t.callee).flatMap((id) => tableReached(id, 2));
    const fitting = [...new Set(reached)].filter((tb) => tb.entries[t.to] !== undefined || priorStatusesIn(tb, t.to).length);
    if (fitting.length !== 1) continue;
    const froms = priorStatusesIn(fitting[0]!, t.to);
    if (!froms.length) continue;
    const word = t.chain[t.chain.length - 1] ?? '';
    const table = tableFor(word, bindingsBy.get(t.fromId)?.get(word));
    if (!table) continue;
    const fromNode = nodes.get(t.fromId);
    add(t.fromId, { file: fromNode?.loc?.path ?? '', line: t.line, endLine: t.line, chain: t.chain, field: t.field, kind: 'state', requires: froms, excludes: [], fromId: t.fromId },
      { refusal: 'throw', ...statusOfCallee(nodes, callee(t.fromId, t.callee)) }, 'transition-table');
    // the lifecycle's `? → to` move by this writer gains its prior statuses
    for (const tr of table.lifecycle?.transitions ?? []) {
      if (tr.by !== t.fromId || tr.to !== t.to || tr.from) continue;
      tr.fromAny = froms;
      if (froms.length === 1) tr.from = froms[0];
      result.fromTables++;
    }
  }

  // ── emit ──
  const seen = new Set<string>();
  for (const p of found.values()) {
    const action = nodes.get(p.action);
    if (!action?.loc) continue;
    const pre: Precondition = {
      record: p.record, ...(p.table ? { table: p.table } : {}), field: p.field, requires: p.requires, ...(p.excludes?.length ? { excludes: p.excludes } : {}),
      kind: p.kind, else: p.else, via: p.via, path: p.path, line: p.line, class: p.class,
      tier: p.class === 'integrity' ? 'policy' : 'business',
      words: p.words || humanizePrecondition(p), wordsFrom: p.words ? p.wordsFrom : 'humanize', action: p.action, relation: p.relation,
    };
    const id = `${repo}::precondition::${action.loc.path}::${action.name.split(': ')[0]}::${p.record}.${p.field}${p.kind === 'present' ? '#present' : ''}`;
    if (seen.has(id) || nodes.has(id)) continue;
    seen.add(id);
    nodes.set(id, {
      id, kind: 'rule', name: `${action.name.split(': ')[0]}: ${codeFormOf(pre)}`, lang: action.lang,
      loc: { repo, path: p.path, line: p.line, endLine: p.endLine },
      tags: ['precondition', ...(action.tags.filter((t) => !['auth', 'precondition', CONFIG_CHECK_TAG, 'action-gate', 'server-action', 'entrypoint'].includes(t) && !t.startsWith('work:')).slice(0, 4))],
      ...(pre.wordsFrom === 'business' ? { facets: { business: { description: pre.words } } } : {}),
      ...(action.project ? { project: action.project } : {}),
      precondition: pre,
    });
    edges.push({
      id: `pre${edges.length}`, kind: 'validates', from: id, to: p.action,
      meta: { via: 'precondition', line: p.line },
      resolution: { status: 'resolved', technique: 'precondition', confidence: 'HIGH',
        note: `${p.via === 'transition-table' ? 'a transition table' : p.via === 'blocker-list' ? 'a blocker list one throw refuses' : 'a refusing comparison'} on ${p.record}.${p.field}` },
    });
    result.preconditions++;
  }

  // ── a role guard's constant argument, on its guards edge ──
  for (const e of edges) {
    if (e.kind !== 'guards') continue;
    const g = nodes.get(e.from);
    if (g?.kind !== 'guard') continue;
    const ident = g.name.split(': ')[0]!;
    const call = f.constArgs.find((c) => c.fromId === e.to && c.callee === ident)
      // a route that inherits a handler's gate reads the handler's call
      ?? (typeof e.meta?.handler === 'string' ? f.constArgs.find((c) => c.fromId === e.meta!.handler && c.callee === ident) : undefined);
    if (!call) continue;
    const values = constValues(call.ref, f.tables, decls);
    if (!values?.length) continue;
    e.meta = { ...e.meta, requires: values.join(', '), requiresFrom: call.ref.key ? `${call.ref.table}.${call.ref.key}` : call.ref.table };
    result.roles++;
  }

  // ── the action marked as a gate: a @guard that writes a record's status is the action itself ──
  for (const id of writes.keys()) {
    const n = nodes.get(id);
    if (n?.kind !== 'guard') continue;
    if (!n.tags.includes('action-gate')) n.tags.push('action-gate');
    n.tags = n.tags.filter((t) => t !== CONFIG_CHECK_TAG);
    result.actionGates++;
  }
  return result;
}

function statusOfCallee(nodes: Map<string, GraphNode>, ids: string[]): { status?: number; helper?: string } {
  for (const id of ids) {
    const snip = nodes.get(id)?.snippet ?? '';
    for (const [helper, status] of Object.entries(HELPER_STATUS)) if (new RegExp(`\\b${helper}\\s*\\(`).test(snip)) return { status, helper };
  }
  return {};
}

function constValues(ref: ConstArgCall['ref'], tables: ConstTable[], decls: EnumDecl[]): string[] | undefined {
  if (ref.key) {
    const t = tables.filter((x) => x.name === ref.table);
    return t.length === 1 ? t[0]!.entries[ref.key] : undefined;
  }
  const d = decls.filter((x) => x.name === ref.table && x.values.length);
  return d.length === 1 ? d[0]!.values : undefined;
}
