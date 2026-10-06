/**
 * A record's status lifecycle, read from the code (swarm-fixes round 2026-10-05, finding 7).
 *
 * Three facts, each read where the code states it, and joined only where they agree:
 *
 * 1. **The statuses** — an enum the code declares: a SQL `CHECK (status IN ('A', 'B', …))` on the
 *    record's own column (the database's word, so it binds the record outright), or a TypeScript
 *    declaration — `const S = ['A', 'B'] as const`, `z.enum([...])`, `type T = 'A' | 'B'`, a string
 *    `enum` — that a field of the same name is declared with (`status: z.enum(S)`, `status: T`). A
 *    TypeScript enum binds a record only when every status the code writes to that record's field
 *    is one of its members and no other enum declared for that field also fits; otherwise nothing.
 * 2. **The writes** — inside a function, the field set to a literal status: an assignment
 *    (`invoice.status = 'PAID'`), the patch of an update call (`repo.transition(id, { status:
 *    'PAID' })` — the last object-literal argument; an earlier one is the filter), or a SQL
 *    `UPDATE t SET status = 'PAID'`. A write is credited to a record only when the call it is part
 *    of (or, for an assignment, the function itself) reaches exactly one record whose lifecycle
 *    has that field and that status. The writer is the function node: never guessed.
 * 3. **The prior status** — `from` only when the same function compares the field to exactly one
 *    status (`if (x.status !== 'SUBMITTED') throw …`, a filter `{ status: 'COMPILED' }`, a SQL
 *    `WHERE status = 'FAILED'`).
 *
 * Pure over what the adapter collected; `linkLifecycles` writes `GraphNode.lifecycle` on table nodes.
 */
import type { GraphEdge, GraphNode, LifecycleSource, LifecycleTransition, RecordLifecycle } from '@farsight/core';
import { walk, isNode, memberChain, type AstNode } from './walk.js';

/** A field that holds a status: `status`, `state`, `bcSyncStatus`, `bc_sync_status`. */
export const STATUS_KEY = /^(status|state)$|(Status|State|_status|_state)$/;
/** `bcSyncStatus` and `bc_sync_status` are one field. */
export const fieldKey = (s: string): string => s.replace(/_/g, '').toLowerCase();

export interface EnumDecl {
  kind: LifecycleSource['kind'];
  name?: string;
  values: string[];
  /** `z.enum(NAME)` / `(typeof NAME)[number]`: the values live in another declaration */
  ref?: string;
  file: string;
  line: number;
}
export interface FieldUse { field: string; enumName?: string; values?: string[]; file: string; line: number }
export interface StatusWrite {
  fromId: string;
  field: string;
  value: string;
  line: number;
  via: LifecycleTransition['via'];
  /** update-call: the call's member chain (`repos.invoices.transition`) */
  callee?: string[];
  /** sql: the table the statement updates */
  table?: string;
}
export interface StatusCompare { fromId: string; field: string; value: string }

const strLit = (n: unknown): string | undefined =>
  isNode(n) && (n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string' ? n.value : undefined;
const keyName = (k: unknown): string | undefined =>
  isNode(k) ? (typeof k.name === 'string' ? k.name : typeof k.value === 'string' ? k.value : undefined) : undefined;
/** every element a string literal, at least two of them: an enumeration, not a list of one */
function literalList(n: unknown): string[] | undefined {
  if (!isNode(n) || n.type !== 'ArrayExpression') return undefined;
  const els = (n.elements as unknown[]) ?? [];
  const out = els.map(strLit);
  return out.length >= 2 && out.every((x): x is string => x !== undefined) ? out : undefined;
}
function unionList(n: unknown): string[] | undefined {
  if (!isNode(n) || n.type !== 'TSUnionType') return undefined;
  const out = ((n.types as AstNode[]) ?? []).map((x) => (x.type === 'TSLiteralType' ? strLit(x.literal) : undefined));
  return out.length >= 2 && out.every((x): x is string => x !== undefined) ? out : undefined;
}
/** `(typeof NAME)[number]` → NAME */
function typeofIndexRef(n: unknown): string | undefined {
  if (!isNode(n) || n.type !== 'TSIndexedAccessType') return undefined;
  let o = n.objectType as AstNode | undefined;
  if (o?.type === 'TSParenthesizedType') o = o.typeAnnotation as AstNode;
  return o?.type === 'TSTypeQuery' && isNode(o.exprName) && typeof (o.exprName as AstNode).name === 'string' ? String((o.exprName as AstNode).name) : undefined;
}
/** `z.enum([...])` or `z.enum(NAME)` → its values or its reference */
function zodEnum(n: unknown): { values?: string[]; ref?: string } | undefined {
  if (!isNode(n) || n.type !== 'CallExpression') return undefined;
  const c = memberChain(n.callee);
  if (c.length !== 2 || c[0] !== 'z' || c[1] !== 'enum') return undefined;
  const a = ((n.arguments as AstNode[]) ?? [])[0];
  const values = literalList(a);
  if (values) return { values };
  return isNode(a) && a.type === 'Identifier' ? { ref: String(a.name) } : undefined;
}

/** The enum declarations and the status fields declared with one, anywhere in a file. */
export function collectEnums(program: AstNode, file: string, line: (o: number) => number): { decls: EnumDecl[]; uses: FieldUse[] } {
  const decls: EnumDecl[] = [];
  const uses: FieldUse[] = [];
  walk(program, (n) => {
    if (n.type === 'VariableDeclarator' && isNode(n.id) && (n.id as AstNode).type === 'Identifier' && isNode(n.init)) {
      const name = String((n.id as AstNode).name);
      const init = n.init as AstNode;
      const at = line(n.start ?? 0);
      if (init.type === 'TSAsExpression') {
        const values = literalList(init.expression);
        if (values) decls.push({ kind: 'const-array', name, values, file, line: at });
      }
      const z = zodEnum(init);
      if (z) decls.push({ kind: 'zod-enum', name, values: z.values ?? [], ...(z.ref ? { ref: z.ref } : {}), file, line: at });
    }
    if (n.type === 'TSTypeAliasDeclaration' && isNode(n.id)) {
      const name = String((n.id as AstNode).name);
      const values = unionList(n.typeAnnotation);
      const ref = typeofIndexRef(n.typeAnnotation);
      if (values) decls.push({ kind: 'union', name, values, file, line: line(n.start ?? 0) });
      else if (ref) decls.push({ kind: 'union', name, values: [], ref, file, line: line(n.start ?? 0) });
    }
    if (n.type === 'TSEnumDeclaration' && isNode(n.id)) {
      const body = n.body as AstNode | undefined;
      const members = ((body?.members ?? n.members) as AstNode[]) ?? [];
      const values = members.map((m) => strLit(m.initializer) ?? (m.initializer ? undefined : keyName(m.id)));
      if (values.length >= 2 && values.every((x): x is string => x !== undefined)) {
        decls.push({ kind: 'ts-enum', name: String((n.id as AstNode).name), values, file, line: line(n.start ?? 0) });
      }
    }
    // `status: z.enum(S)` / `status: statusSchema` in an object literal (a zod object, mostly)
    if (n.type === 'Property') {
      const field = keyName(n.key);
      if (field && STATUS_KEY.test(field)) {
        const z = zodEnum(n.value);
        if (z?.values) uses.push({ field, values: z.values, file, line: line(n.start ?? 0) });
        else if (z?.ref) uses.push({ field, enumName: z.ref, file, line: line(n.start ?? 0) });
        else if (isNode(n.value) && (n.value as AstNode).type === 'Identifier') uses.push({ field, enumName: String((n.value as AstNode).name), file, line: line(n.start ?? 0) });
      }
    }
    // `status: InvoiceStatus` in an interface or a type literal
    if (n.type === 'TSPropertySignature') {
      const field = keyName(n.key);
      const ann = (n.typeAnnotation as AstNode | undefined)?.typeAnnotation as AstNode | undefined;
      if (field && STATUS_KEY.test(field) && ann) {
        const values = unionList(ann);
        if (values) uses.push({ field, values, file, line: line(n.start ?? 0) });
        else if (ann.type === 'TSTypeReference' && isNode(ann.typeName) && typeof (ann.typeName as AstNode).name === 'string') {
          uses.push({ field, enumName: String((ann.typeName as AstNode).name), file, line: line(n.start ?? 0) });
        } else {
          const ref = typeofIndexRef(ann);
          if (ref) uses.push({ field, enumName: ref, file, line: line(n.start ?? 0) });
        }
      }
    }
  });
  return { decls, uses };
}

/** SQL text: `UPDATE t SET <status> = 'X' … WHERE <status> = 'Y'` → the writes and the compares. */
export function sqlStatusFacts(text: string): { table: string; sets: { field: string; value: string }[]; wheres: { field: string; value: string }[] }[] {
  const out: { table: string; sets: { field: string; value: string }[]; wheres: { field: string; value: string }[] }[] = [];
  const t = text.replace(/--[^\n]*/g, ' ');
  for (const m of t.matchAll(/\bupdate\s+(?:only\s+)?([\w."`]+)(?:\s+(?:as\s+)?[\w"]+)?\s+set\b([\s\S]*?)(?=;|$)/gi)) {
    const table = m[1]!.replace(/["`]/g, '').split('.').pop()!.toLowerCase();
    const rest = m[2]!;
    const wi = rest.search(/\bwhere\b/i);
    const setPart = wi >= 0 ? rest.slice(0, wi) : rest;
    const wherePart = wi >= 0 ? rest.slice(wi) : '';
    const pick = (s: string) => [...s.matchAll(/\b(\w+)\s*=\s*'([^']+)'/g)]
      .filter((x) => STATUS_KEY.test(x[1]!)).map((x) => ({ field: x[1]!, value: x[2]! }));
    const sets = pick(setPart);
    if (sets.length) out.push({ table, sets, wheres: pick(wherePart) });
  }
  return out;
}

/** `throw …` / `return …`, or a block that ends in one: the branch leaves the function. */
function exits(n: AstNode | undefined): boolean {
  if (!n) return false;
  if (n.type === 'ThrowStatement' || n.type === 'ReturnStatement' || n.type === 'ContinueStatement' || n.type === 'BreakStatement') return true;
  if (n.type === 'BlockStatement') { const b = (n.body as AstNode[]) ?? []; return exits(b[b.length - 1]); }
  return false;
}

/**
 * Does this comparison, where it sits, mean *the status is the literal* at the code that follows?
 * `if (x.status === 'A') { … }` and `if (x.status !== 'A') throw …` both do; `if (x.status === 'A')
 * throw …` says it is *not* A, and a comparison under `||` or outside an `if` test says nothing.
 */
function priorIs(cmp: AstNode, parents: AstNode[]): boolean {
  let positive = cmp.operator === '===' || cmp.operator === '==';
  let child: AstNode = cmp;
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]!;
    if (p.type === 'UnaryExpression' && p.operator === '!') { positive = !positive; child = p; continue; }
    if (p.type === 'ParenthesizedExpression' || p.type === 'ChainExpression') { child = p; continue; }
    if (p.type === 'LogicalExpression' && p.operator === '&&') { child = p; continue; }
    if (p.type === 'IfStatement' && p.test === child) return exits(p.consequent as AstNode) ? !positive : positive;
    return false;
  }
  return false;
}

/** The status writes and compares inside one function body. */
export function collectStatusFacts(body: AstNode | null, fromId: string, line: (o: number) => number): { writes: StatusWrite[]; compares: StatusCompare[] } {
  const writes: StatusWrite[] = [];
  const compares: StatusCompare[] = [];
  if (!body) return { writes, compares };
  const statusProps = (obj: AstNode): { field: string; value: string; at: number }[] =>
    ((obj.properties as AstNode[]) ?? []).flatMap((p) => {
      if (p.type !== 'Property') return [];
      const field = keyName(p.key);
      const value = strLit(p.value);
      return field && value !== undefined && STATUS_KEY.test(field) ? [{ field, value, at: line(p.start ?? 0) }] : [];
    });
  walk(body, (n, parents) => {
    if (n.type === 'CallExpression') {
      const objs = ((n.arguments as AstNode[]) ?? []).filter((a) => isNode(a) && a.type === 'ObjectExpression');
      if (!objs.length) return;
      const callee = memberChain(n.callee);
      // the last object literal is the patch; an earlier one is the filter (`update(where, patch)`)
      objs.forEach((o, i) => {
        for (const s of statusProps(o)) {
          if (i === objs.length - 1) writes.push({ fromId, field: s.field, value: s.value, line: s.at, via: 'update-call', callee });
          else compares.push({ fromId, field: s.field, value: s.value });
        }
      });
      return;
    }
    if (n.type === 'AssignmentExpression' && n.operator === '=') {
      const c = memberChain(n.left);
      const field = c[c.length - 1];
      const value = strLit(n.right);
      if (c.length >= 2 && field && value !== undefined && STATUS_KEY.test(field)) writes.push({ fromId, field, value, line: line(n.start ?? 0), via: 'assignment' });
      return;
    }
    if (n.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(String(n.operator))) {
      for (const [a, b] of [[n.left, n.right], [n.right, n.left]] as const) {
        const value = strLit(b);
        const c = memberChain(a);
        const field = c[c.length - 1];
        if (value === undefined || !field || !STATUS_KEY.test(field)) continue;
        // only a comparison that says what the status *was* when the write runs
        if (priorIs(n, parents)) compares.push({ fromId, field, value });
      }
      return;
    }
    const text = isNode(n) && (n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string' ? n.value
      : n.type === 'TemplateLiteral' ? ((n.quasis as AstNode[]) ?? []).map((q) => (q.value as { cooked?: string })?.cooked ?? '').join('$x') : undefined;
    if (text && /\bupdate\b/i.test(text)) {
      for (const f of sqlStatusFacts(text)) {
        for (const s of f.sets) writes.push({ fromId, field: s.field, value: s.value, line: line(n.start ?? 0), via: 'sql', table: f.table });
        for (const w of f.wheres) compares.push({ fromId, field: w.field, value: w.value });
      }
    }
  });
  return { writes, compares };
}

export interface LifecycleFacts {
  decls: EnumDecl[];
  uses: FieldUse[];
  writes: StatusWrite[];
  compares: StatusCompare[];
  /** table id → its SQL CHECK lists */
  checks: Map<string, { column: string; values: string[] }[]>;
}

/** the same test-double paths the call resolution sets aside (tsjs.ts TEST_DOUBLE) */
const TEST_DOUBLE = /(^|[\/\-_.])(in-?memory|mock|fake|stub|noop|dummy|fixtures?)([\/\-_.]|$)/i;
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Join the facts on the graph: a lifecycle on each table node whose statuses the code declares,
 * with the transitions a function performs. Mutates `nodes` (sets `lifecycle`); returns how many.
 */
export function linkLifecycles(repo: string, nodes: Map<string, GraphNode>, edges: GraphEdge[], f: LifecycleFacts): number {
  // ── the enum declarations, by name (a name declared twice resolves only in its own file) ──
  const byName = new Map<string, EnumDecl[]>();
  for (const d of f.decls) if (d.name) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const lookup = (name: string, file: string): EnumDecl | undefined => {
    const all = byName.get(name) ?? [];
    return all.length === 1 ? all[0] : all.find((d) => d.file === file);
  };
  const valuesOf = (d: EnumDecl, depth = 0): { values: string[]; root: EnumDecl } | undefined => {
    if (d.values.length) return { values: d.values, root: d };
    if (!d.ref || depth > 3) return undefined;
    const r = lookup(d.ref, d.file);
    return r ? valuesOf(r, depth + 1) : undefined;
  };
  // a fixture or a mock declares the same set to imitate the record; it is not where the record's statuses live
  const real = (d: { file: string }): boolean => !TEST_DOUBLE.test(d.file);
  const sourceOf = (d: EnumDecl): LifecycleSource => ({ kind: d.kind, ...(d.name ? { name: d.name } : {}), path: d.file, line: d.line });

  // ── which records a write reaches ──
  const out = new Map<string, GraphEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const writtenFrom = (id: string, hops: number, seen = new Set<string>()): Set<string> => {
    const tables = new Set<string>();
    if (seen.has(id)) return tables;
    seen.add(id);
    for (const e of out.get(id) ?? []) {
      if (e.kind === 'writes' && nodes.get(e.to)?.kind === 'table') tables.add(e.to);
      else if (e.kind === 'calls' && hops > 0 && !e.meta?.deferred) for (const t of writtenFrom(e.to, hops - 1, seen)) tables.add(t);
    }
    return tables;
  };
  const tablesOf = (w: StatusWrite): Set<string> => {
    if (w.via === 'sql' && w.table) return new Set([`${repo}::table::${w.table}`]);
    if (w.via === 'update-call' && w.callee?.length) {
      const c = w.callee;
      if (c.length === 3 && c[0] === 'db') return new Set([`${repo}::table::${c[1]}`]);
      const tail = c[c.length - 1]!;
      const tables = new Set<string>();
      for (const e of out.get(w.fromId) ?? []) {
        const to = nodes.get(e.to);
        if (e.kind !== 'calls' || !to || !(to.name === tail || to.name.endsWith(`.${tail}`))) continue;
        for (const t of writtenFrom(e.to, 2)) tables.add(t);
      }
      return tables;
    }
    return writtenFrom(w.fromId, 1);
  };
  // a write in an in-memory twin or a mock imitates the record; the production writer is the one that counts
  const reached = f.writes.filter((w) => real({ file: w.fromId.split('::')[1] ?? '' })).map((w) => ({ w, tables: tablesOf(w) }));

  // ── the statuses of each record ──
  let count = 0;
  for (const node of nodes.values()) {
    if (node.kind !== 'table') continue;
    let life: RecordLifecycle | undefined;
    const checks = (f.checks.get(node.id) ?? []).filter((c) => STATUS_KEY.test(c.column));
    const check = checks.find((c) => /^(status|state)$/i.test(c.column)) ?? (checks.length === 1 ? checks[0] : undefined);
    if (check) {
      const also = f.decls.filter(real).map((d) => ({ d, v: valuesOf(d) })).filter((x) => x.v && sameSet(x.v.values, check.values) && x.v.root === x.d);
      life = {
        field: check.column, statuses: check.values, transitions: [],
        provenance: [{ kind: 'sql-check', path: node.loc?.path ?? '', line: node.loc?.line ?? 0 }, ...also.slice(0, 3).map((x) => sourceOf(x.d))],
      };
    } else {
      // a TypeScript enum binds the record only when every status written to that field of it fits one enum
      const writtenHere = reached.filter((r) => r.tables.size === 1 && r.tables.has(node.id));
      const fields = [...new Set(writtenHere.map((r) => fieldKey(r.w.field)))];
      const field = fields.find((x) => x === 'status' || x === 'state') ?? (fields.length === 1 ? fields[0] : undefined);
      if (!field) continue;
      const values = new Set(writtenHere.filter((r) => fieldKey(r.w.field) === field).map((r) => r.w.value));
      const fits = new Map<string, { values: string[]; src: EnumDecl }>();
      for (const u of f.uses.filter(real)) {
        if (fieldKey(u.field) !== field) continue;
        const d = u.values ? { values: u.values, root: { kind: 'zod-enum', values: u.values, file: u.file, line: u.line } as EnumDecl } : u.enumName ? (() => { const x = lookup(u.enumName!, u.file); return x ? valuesOf(x) : undefined; })() : undefined;
        if (!d || ![...values].every((v) => d.values.includes(v))) continue;
        fits.set([...d.values].sort().join('|'), { values: d.values, src: d.root });
      }
      if (fits.size !== 1) continue;
      const only = [...fits.values()][0]!;
      const fieldName = writtenHere.find((r) => fieldKey(r.w.field) === field)!.w.field;
      life = { field: fieldName, statuses: only.values, transitions: [], provenance: [sourceOf(only.src)] };
    }
    node.lifecycle = life;
    count++;
  }

  // ── the transitions, each with the function that performs it ──
  const comparesBy = new Map<string, StatusCompare[]>();
  for (const c of f.compares) comparesBy.set(c.fromId, [...(comparesBy.get(c.fromId) ?? []), c]);
  for (const { w, tables } of reached) {
    const hits = [...tables].map((t) => nodes.get(t)).filter((n): n is GraphNode =>
      !!n?.lifecycle && fieldKey(n.lifecycle.field) === fieldKey(w.field) && n.lifecycle.statuses.includes(w.value));
    if (hits.length !== 1) continue;
    const life = hits[0]!.lifecycle!;
    const prior = [...new Set((comparesBy.get(w.fromId) ?? []).filter((c) => fieldKey(c.field) === fieldKey(life.field) && life.statuses.includes(c.value) && c.value !== w.value).map((c) => c.value))];
    const tr: LifecycleTransition = { ...(prior.length === 1 ? { from: prior[0] } : {}), to: w.value, by: w.fromId, via: w.via, line: w.line };
    if (life.transitions.some((x) => x.to === tr.to && x.by === tr.by && x.from === tr.from)) continue;
    life.transitions.push(tr);
  }
  for (const node of nodes.values()) {
    const life = node.lifecycle;
    if (!life) continue;
    life.transitions.sort((a, b) => life.statuses.indexOf(a.to) - life.statuses.indexOf(b.to) || a.by.localeCompare(b.by) || (a.line ?? 0) - (b.line ?? 0));
  }
  return count;
}
