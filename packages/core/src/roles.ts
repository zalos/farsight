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
import { counted, type Counted } from './counts.js';

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
  /** the tests that reach the action (its route or its handler), each once with its strongest class */
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
    /** actions whose tests' one verdict is *passed*, of the actions */
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
      const tests = [...byTest.values()].sort((a, b) => Number(b.status === 'passed') - Number(a.status === 'passed')
        || a.level.localeCompare(b.level) || a.name.localeCompare(b.name));
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

function matchesAction(r: RoleRow, q: string): boolean {
  if (r.action.id === q || r.action.handler === q) return true;
  const hay = [r.action.name, r.action.summary, r.action.business, r.words, r.action.handler?.split('::').slice(-2).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
  const tokens = q.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w && !STOP.has(w));
  return tokens.length > 0 && tokens.every((w) => hay.includes(w) || (w.endsWith('s') && hay.includes(w.slice(0, -1))));
}
function matchesRole(r: RoleRow, q: string): boolean {
  const w = q.toLowerCase();
  return r.roles.some((x) => x.toLowerCase() === w || roleWord(x) === w);
}

/** The role × action table, narrowed by `q`. Every number a `Counted` over the rows it returns. */
export function roleTable(index: GraphIndex, q: RoleQuery = {}): RoleTable {
  const rows = allRows(index).filter((r) => (!q.repo || repoOf(r.action) === q.repo)
    && (!q.guard || r.guard.id === q.guard)
    && (!q.role || matchesRole(r, q.role))
    && (!q.action || matchesAction(r, q.action)));
  // the roles in the order the widest list names them, then any a narrower list adds
  const roles: string[] = [];
  for (const r of rows.slice().sort((a, b) => b.roles.length - a.roles.length)) for (const x of r.roles) if (!roles.includes(x)) roles.push(x);
  const src = 'roleTable()';
  const read = rows.filter((r) => r.rolesRead).length;
  const passed = rows.filter((r) => r.verdict.status === 'passed').length;
  return {
    rows, roles,
    counted: {
      actions: counted(rows.length, 'count.unit.roleActions', 'count.scope.workspace', `${src}.rows.length`, {
        bizUnit: 'count.unit.roleActions',
        breakdown: [{ key: 'count.part.rolesRead', n: read }, { key: 'count.part.rolesUnread', n: rows.length - read }],
        recheck: { cli: 'farsight roles', mcp: 'roles' },
      }),
      roles: counted(roles.length, 'count.unit.roles', 'count.scope.workspace', `${src}.roles.length`, { bizUnit: 'count.unit.roles', recheck: { cli: 'farsight roles', mcp: 'roles' } }),
      passed: counted(passed, 'count.unit.roleActionsPassed', 'count.scope.workspace', `${src}.rows[verdict.status = passed]`, {
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
