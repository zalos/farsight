/**
 * Who may do what — the role × action table (outsider round 2026-10-13, worklist F4).
 *
 * Folded from the `guards` edges a role guard writes: the parser reads the role list a guard is handed at each call
 * site from the constant argument (`requireOpsRole(p, ROLES.approve)` → `meta.requires = 'ops.approver'`,
 * `meta.requiresFrom = 'ROLES.approve'`, parsers `preconditions.ts`). One row per action the guard sits on — the
 * route, never the route and its handler twice — with the roles the code lists, where the list was read from, the
 * journeys and screens whose walk reaches the action, and the tests that reach it with the one `testVerdict()`.
 *
 * A **role guard** is a guard with at least one such edge. The same guard on an action whose list was not read from
 * a constant (an inline array, a computed value) is still a row: `rolesRead: false`, no roles — the table says it
 * could not read them rather than leaving the action out.
 *
 * Code is the source of truth: the roles come only from `meta.requires`. Who *holds* a role is data the code does
 * not carry; the table never says.
 *
 * Pure over a `GraphIndex`; every step is a lookup through the edge index, and the journeys come from
 * `flowWalks()` (cached per index). `rolesFor(index, { action })` is the entry point another fold (Ask) calls.
 */
import type { GraphNode, Loc } from './graph.js';
import type { GraphIndex } from './query.js';
import { humanizeName } from './query.js';
import { flowWalks } from './affected.js';
import { testsCovering, EVIDENCE_RANK } from './metrics.js';
import { toCoverageRef, evidenceFacts, type CoverageTestRef, type EvidenceWord, type TestVerdict } from './coverage.js';
import { counted, countedText, type Counted } from './counts.js';
import { t as tr } from './strings.js';

/** The action a role guard stands in front of: a route (or a server function nothing routes to). */
export interface RoleAction {
  id: string;
  kind: GraphNode['kind'];
  name: string;
  method?: string;
  path?: string;
  /** the API's own one-line summary of the operation */
  summary?: string;
  /** the words a person wrote for it (`@business` on the route or its handler) */
  business?: string;
  /** the handler the route calls, when the guard sits on both */
  handler?: string;
  loc?: Loc;
}

export interface RoleRow {
  action: RoleAction;
  /** what the business register calls the action: its `@business` words, else the API summary, else its name in words */
  words: string;
  guard: { id: string; name: string; business?: string; loc?: Loc };
  /** the roles the code lists for this action, in the code's order; empty when `rolesRead` is false */
  roles: string[];
  /** false: the guard sits on the action, but its role list was not read from a constant */
  rolesRead: boolean;
  /** the constant the list was read from (`OPS_INVOICE_ACTION_ROLES.approve`) */
  requiresFrom?: string;
  /** the journeys whose walk reaches the action, by name */
  journeys: { id: string; name: string }[];
  /** the screens whose segment reaches it, each with its journey */
  screens: { flow: string; id: string; name: string }[];
  /** the tests that reach the action (its route or its handler), each once with its strongest class; the one a person
   * should read first leads (a passed case whose name speaks of a role or a refusal) */
  tests: CoverageTestRef[];
  evidenceWord: EvidenceWord;
  /** the one verdict over those tests (`testVerdict()`), scope one part */
  verdict: TestVerdict;
}

export interface RoleTable {
  rows: RoleRow[];
  /** every role any row lists, the widest list's order first */
  roles: string[];
  counted: {
    /** actions behind a role guard; breakdown roles read · roles not read */
    actions: Counted;
    /** distinct roles the code names */
    roles: Counted;
    /** actions a case reaches whose own last run passed, of the actions (each case by its own run, as `runs` counts) */
    passed: Counted;
  };
}

export interface RoleQuery {
  /** one source */
  repo?: string;
  /** a role (`ops.admin`) or its last word (`admin`): only the actions that list it */
  role?: string;
  /** a node id, or words matched against the action's name, path, summary and `@business` words */
  action?: string;
  /** one guard's rows (the gate card's *who may do what*) */
  guard?: string;
  /** only the actions one journey's walk reaches (a flow node id) */
  flow?: string;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'who', 'may', 'can', 'is', 'it', 'do', 'does', 'and', 'or', 'on', 'in']);

function repoOf(n: { id: string; loc?: Loc }): string {
  return n.loc?.repo ?? n.id.split('::')[0]!;
}
function wordsOf(n: GraphNode | undefined): string | undefined {
  const b = n?.facets?.business;
  return b?.label?.trim() || b?.description?.trim() || undefined;
}
function splitRoles(s: unknown): string[] {
  return typeof s === 'string' ? s.split(/,\s*/).map((x) => x.trim()).filter(Boolean) : [];
}
/** `ops.approver` → *approver*: the last part of a role, in words. */
export function roleWord(role: string): string {
  return humanizeName(role.split(/[.:/]/).pop() || role).toLowerCase();
}

const LEVEL_ORDER: Record<string, number> = { unit: 0, integration: 1, e2e: 2 };
/**
 * Which test a row quotes first: a case (never a coverage run) whose own last run passed; then one whose name speaks
 * of a role, a refusal or one of this action's roles — the name orders the list and is quoted as written, never read
 * as a fact; then the narrower level; then by name.
 */
function proofOrder(roles: string[]): (a: CoverageTestRef, b: CoverageTestRef) => number {
  const words = ['role', '403', 'forbidden', 'refus', ...roles.map(roleWord)];
  const speaks = (t: CoverageTestRef) => Number(words.some((w) => t.name.toLowerCase().includes(w)));
  return (a, b) => Number(a.runLevel) - Number(b.runLevel)
    || Number(b.status === 'passed') - Number(a.status === 'passed')
    || speaks(b) - speaks(a)
    || (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3)
    || a.name.localeCompare(b.name);
}
/** A case (not a coverage run, not skipped in the file) whose own last run passed reaches the action. */
function passedCase(r: RoleRow): boolean {
  return r.tests.some((t) => !t.runLevel && !t.inactive && t.status === 'passed');
}

const cache = new WeakMap<GraphIndex, RoleRow[]>();

/** Every row, unfiltered — folded once per index. */
function allRows(index: GraphIndex): RoleRow[] {
  const hit = cache.get(index);
  if (hit) return hit;
  const rows: RoleRow[] = [];
  let walks: ReturnType<typeof flowWalks> | undefined;
  for (const g of index.byId.values()) {
    if (g.kind !== 'guard') continue;
    const out = (index.out.get(g.id) ?? []).filter((e) => e.kind === 'guards');
    if (!out.some((e) => typeof e.meta?.requires === 'string')) continue;
    // a handler the guard's route edge names is the same action: one row, on the route
    const twins = new Set(out.map((e) => e.meta?.handler).filter((h): h is string => typeof h === 'string'));
    const seen = new Set<string>();
    for (const e of out) {
      const t = index.byId.get(e.to);
      if (!t || seen.has(t.id) || (t.kind !== 'route' && twins.has(t.id))) continue;
      seen.add(t.id);
      const handlerId = typeof e.meta?.handler === 'string' ? e.meta.handler : undefined;
      const handlerEdge = handlerId ? out.find((x) => x.to === handlerId) : undefined;
      const requires = typeof e.meta?.requires === 'string' ? e.meta.requires : handlerEdge?.meta?.requires;
      const requiresFrom = (typeof e.meta?.requiresFrom === 'string' ? e.meta.requiresFrom : handlerEdge?.meta?.requiresFrom) as string | undefined;
      const handler = handlerId ? index.byId.get(handlerId) : undefined;
      const m = t.kind === 'route' ? /^([A-Z]+)\s+(\S+)/.exec(t.name) : null;
      const business = wordsOf(t) ?? wordsOf(handler);
      const action: RoleAction = {
        id: t.id, kind: t.kind, name: t.name,
        ...(m ? { method: m[1], path: m[2] } : {}),
        ...(t.contract?.summary?.trim() ? { summary: t.contract.summary.trim() } : {}),
        ...(business ? { business } : {}),
        ...(handler ? { handler: handler.id } : {}),
        ...(t.loc ? { loc: t.loc } : handler?.loc ? { loc: handler.loc } : {}),
      };
      // the tests: the action's own, then its handler's — one row per test, its strongest class
      const byTest = new Map<string, CoverageTestRef>();
      for (const id of [t.id, handler?.id]) {
        if (!id) continue;
        const n = index.byId.get(id);
        for (const c of testsCovering(index, id)) {
          const ref = toCoverageRef(index, c, n);
          const have = byTest.get(c.id);
          if (!have || EVIDENCE_RANK[have.evidence]! < EVIDENCE_RANK[ref.evidence]!) byTest.set(c.id, ref);
        }
      }
      const tests = [...byTest.values()].sort(proofOrder(splitRoles(requires)));
      const facts = evidenceFacts(tests, 'count.scope.node', `roleTable().rows[${t.id}].tests`);
      // where a person meets it: the journeys and screens whose walk reaches the route or its handler
      walks ??= flowWalks(index);
      const journeys: RoleRow['journeys'] = [];
      const screens: RoleRow['screens'] = [];
      const hits = (s: Set<string>) => s.has(t.id) || (!!handler && s.has(handler.id));
      for (const w of walks) {
        if (!hits(w.nodes)) continue;
        journeys.push({ id: w.id, name: w.name });
        for (const sc of w.screens) if (hits(sc.nodes)) screens.push({ flow: w.id, id: sc.screenId, name: sc.name });
      }
      const roles = splitRoles(requires);
      rows.push({
        action,
        words: business ?? action.summary ?? humanizeName(t.name),
        guard: { id: g.id, name: g.name, ...(wordsOf(g) ? { business: wordsOf(g)! } : {}), ...(g.loc ? { loc: g.loc } : {}) },
        roles, rolesRead: roles.length > 0,
        ...(roles.length && requiresFrom ? { requiresFrom } : {}),
        journeys, screens, tests,
        evidenceWord: facts.evidenceWord,
        verdict: facts.verdict,
      });
    }
  }
  rows.sort((a, b) => repoOf(a.action).localeCompare(repoOf(b.action)) || (a.action.path ?? a.action.name).localeCompare(b.action.path ?? b.action.name)
    || (a.action.method ?? '').localeCompare(b.action.method ?? '') || a.guard.name.localeCompare(b.guard.name));
  cache.set(index, rows);
  return rows;
}

/**
 * How closely a row matches the words of an action: 3 = its id, 2 = every word is in its method, path or handler
 * name, 1 = every word is in its summary or the words a person wrote for it, 0 = no match. A question names the
 * action by its verb, so the path wins over a sentence that merely mentions the word (*approve* is the approve
 * route, not the edit route whose sentence says *before it is approved*).
 */
function actionMatch(r: RoleRow, q: string): number {
  if (r.action.id === q || r.action.handler === q) return 3;
  const tokens = q.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w && !STOP.has(w));
  if (!tokens.length) return 0;
  const has = (hay: string) => tokens.every((w) => hay.includes(w) || (w.length > 3 && w.endsWith('s') && hay.includes(w.slice(0, -1))));
  if (has([r.action.name, r.action.handler?.split('::').slice(-2).join(' ')].filter(Boolean).join(' ').toLowerCase())) return 2;
  if (has([r.action.summary, r.action.business, r.words].filter(Boolean).join(' ').toLowerCase())) return 1;
  return 0;
}
/** The rows that match an action's words best: an id, else the path, else the sentence. */
function bestMatches(rows: RoleRow[], q: string): RoleRow[] {
  const scored = rows.map((r) => [r, actionMatch(r, q)] as const).filter(([, n]) => n > 0);
  const top = Math.max(0, ...scored.map(([, n]) => n));
  return scored.filter(([, n]) => n === top).map(([r]) => r);
}
function matchesRole(r: RoleRow, q: string): boolean {
  const w = q.toLowerCase();
  return r.roles.some((x) => x.toLowerCase() === w || roleWord(x) === w);
}

/** The role × action table, narrowed by `q`. Every number a `Counted` over the rows it returns. */
export function roleTable(index: GraphIndex, q: RoleQuery = {}): RoleTable {
  const scoped = allRows(index).filter((r) => (!q.repo || repoOf(r.action) === q.repo)
    && (!q.guard || r.guard.id === q.guard)
    && (!q.flow || r.journeys.some((j) => j.id === q.flow))
    && (!q.role || matchesRole(r, q.role)));
  const rows = q.action ? bestMatches(scoped, q.action) : scoped;
  // the roles in the order the widest list names them, then any a narrower list adds
  const roles: string[] = [];
  for (const r of rows.slice().sort((a, b) => b.roles.length - a.roles.length)) for (const x of r.roles) if (!roles.includes(x)) roles.push(x);
  const src = 'roleTable()';
  const read = rows.filter((r) => r.rolesRead).length;
  const passed = rows.filter(passedCase).length;
  return {
    rows, roles,
    counted: {
      actions: counted(rows.length, 'count.unit.roleActions', 'count.scope.workspace', `${src}.rows.length`, {
        bizUnit: 'count.unit.roleActions',
        breakdown: [{ key: 'count.part.rolesRead', n: read }, { key: 'count.part.rolesUnread', n: rows.length - read }],
        recheck: { cli: 'farsight roles', mcp: 'roles' },
      }),
      roles: counted(roles.length, 'count.unit.roles', 'count.scope.workspace', `${src}.roles.length`, { bizUnit: 'count.unit.roles', recheck: { cli: 'farsight roles', mcp: 'roles' } }),
      passed: counted(passed, 'count.unit.roleActionsPassed', 'count.scope.workspace', `${src}.rows[a case whose own last run passed]`, {
        of: rows.length, bizUnit: 'count.unit.roleActionsPassed', recheck: { cli: 'farsight roles', mcp: 'roles' },
      }),
    },
  };
}

/** Who may do one action (or every action a guard sits on): the rows, nothing else. */
export function rolesFor(index: GraphIndex, q: { action?: string; guard?: string; repo?: string }): RoleRow[] {
  return roleTable(index, q).rows;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
/** The table as CSV, one row per action: what a spreadsheet or an auditor reads. */
export function rolesCsv(t: RoleTable): string {
  const head = ['action', 'method', 'path', 'roles', 'roles_read', 'requires_from', 'guard', 'journeys', 'screens', 'evidence_word', 'verdict', 'tests', 'first_test', 'first_test_at', 'first_test_status', 'node_id'];
  const lines = [head.join(',')];
  for (const r of t.rows) {
    const first = r.tests[0];
    lines.push([
      r.words, r.action.method ?? '', r.action.path ?? '', r.roles.join(' '), String(r.rolesRead), r.requiresFrom ?? '', r.guard.name.split(': ')[0]!,
      r.journeys.map((j) => j.name).join(' | '), r.screens.map((s) => s.name).join(' | '), r.evidenceWord.cls, r.verdict.status ?? '',
      String(r.tests.length), first ? `${first.name}${first.loc ? ` (${first.loc.path}:${first.loc.line})` : ''}` : '', first?.at ?? '', first?.status ?? '', r.action.id,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** The test a row quotes, as a person reads it: its name in quotes, where it lives, its own last run. */
function proofText(r: RoleRow, business: boolean): string {
  const first = r.tests[0];
  if (!first) return 'no test is known to reach it';
  const at = first.at ? ` ${first.at.slice(0, 10)}` : '';
  return `proven by “${first.name}”${business || !first.loc ? '' : ` — ${first.loc.path}:${first.loc.line}`}${first.status ? ` · ${first.status}${at}` : ' · no run recorded'}`
    + (r.tests.length > 1 ? ` (+${r.tests.length - 1} more)` : '');
}

/**
 * The table as lines for a terminal or an agent (MCP `roles`, `farsight roles`): the counts with their scope, then
 * one block per action. `business` drops code names and ids: the action in its words, the roles in words.
 */
export function roleTableLines(t: RoleTable, opts: { business?: boolean; cap?: number } = {}): string[] {
  const business = !!opts.business;
  const lens = business ? 'business' as const : 'hybrid' as const;
  const cap = opts.cap ?? 60;
  const out: string[] = [];
  if (!t.rows.length) {
    out.push('who may do what: no role check found — no check in the code is handed a named list of roles');
    return out;
  }
  out.push(`who may do what: ${[t.counted.actions, t.counted.roles, t.counted.passed].map((c) => countedText(c, { lens, scope: false })).join(' · ')} ${tr(t.counted.actions.scope, 'professional')}`);
  out.push(`roles the code names: ${t.roles.map((r) => (business ? roleWord(r) : r)).join(' · ')}`);
  for (const r of t.rows.slice(0, cap)) {
    const head = business ? r.words : `${r.action.method && r.action.path ? `${r.action.method} ${r.action.path}` : r.action.name} — ${r.words}`;
    out.push('');
    out.push(head);
    out.push(r.rolesRead
      ? `   may: ${r.roles.map((x) => (business ? roleWord(x) : x)).join(', ')}${business ? '' : ` (read from ${r.requiresFrom ?? 'a named list'} · ${r.guard.name.split(': ')[0]})`}`
      : `   may: roles not read — a role check stands in front of it, but its list is not a named list${business ? '' : ` (${r.guard.name.split(': ')[0]})`}`);
    if (r.journeys.length) out.push(`   met on: ${r.journeys.map((j) => {
      const sc = r.screens.filter((s) => s.flow === j.id).map((s) => s.name);
      return sc.length ? `${j.name} (${sc.join(', ')})` : j.name;
    }).join(' · ')}`);
    out.push(`   ${proofText(r, business)}`);
    if (!business) out.push(`   \`${r.action.id}\``);
  }
  if (t.rows.length > cap) out.push('', `… ${t.rows.length - cap} more actions (pass all, or narrow by role or action)`);
  out.push('', 'who holds each role is data the code does not carry, so this table cannot say');
  return out;
}
