/**
 * One gate, answered (swarm-fixes round 2026-10-05, finding 4): what it is, the
 * words somebody wrote for it, what it sits on, the calls a request goes through
 * to meet it, and the tests that reach it — the fold behind the HUD's gate card,
 * `GET /api/gate`, the MCP `gate` tool and `describe_node`'s gate section. Pure
 * over a `GraphIndex`; every step is a lookup through the edge index.
 *
 * Also the one rule for a **config check**: a guard that checks the process —
 * the settings it was started with — rather than a request. The parser tags it
 * (`config-check`) from the guard's own text; a graph ingested before the tag
 * existed is read the same way from the node's snippet.
 */
import type { GraphNode, Loc } from './graph.js';
import type { GraphIndex, Journey, JourneySummary, JourneyGate } from './query.js';
import type { GateClass, GateTier } from './graph.js';
import { gateTierOf, GATE_CLASS_ORDER } from './gate-class.js';
import { testsCovering, EVIDENCE_RANK } from './metrics.js';
import { toCoverageRef, evidenceFacts, type CoverageTestRef, type EvidenceWord, type CoverageCounted, type CoverageFacts, type TestVerdict } from './coverage.js';
import { counted, type Counted } from './counts.js';
import { isConfigCheck } from './config-check.js';

export { configCheckOf, paramsText, isConfigCheck, CONFIG_CHECK_TAG } from './config-check.js';

/** A gate's name split into the identifier that declared it and the requirement somebody wrote (`requireX: words`). */
export function gateNameParts(name: string): { ident: string; phrase: string } {
  const i = name.indexOf(': ');
  return i > 0 ? { ident: name.slice(0, i), phrase: name.slice(i + 2) } : { ident: '', phrase: name };
}

/** A part a gate card names: enough to print it and open it. */
export interface GatePart {
  id: string;
  kind: GraphNode['kind'];
  name: string;
  loc?: Loc;
}
/** A call the gate stands in front of: the route, and how far below it the gate sits. */
export interface GateCall extends GatePart {
  /** 0 = the gate guards the route itself; n = the guarded part is n calls under the route */
  depth: number;
  method?: string;
  path?: string;
  /** the spec's one-line summary of the operation, when the route is in a contract */
  summary?: string;
  apiId?: string;
}

export interface GateCard {
  gate: GatePart & {
    /** `guard` (who may pass) or `rule` (what the data must look like) */
    gateKind: 'guard' | 'rule';
    /** the identifier and the requirement somebody wrote after the colon of `@guard` */
    ident: string;
    phrase: string;
    /** the plain-language sentence somebody wrote (`@business`), else undefined */
    business?: string;
    /** the first sentence of its doc comment */
    docs?: string;
    /** checks how the app was started, not a request */
    configCheck: boolean;
    /** declared in farsight.config.json rather than found in the code */
    declared: boolean;
    project?: string;
  };
  /** what the gate sits on directly — the functions and routes its `guards` / `validates` edges name */
  sitsOn: GatePart[];
  /** the routes a request passes through to meet it, nearest first */
  calls: GateCall[];
  /** the server-rendered pages that meet it on the way to drawing (a config check's usual reach) */
  pages: GatePart[];
  /** every route the graph knows, so a card can say *n of m* */
  routesInGraph: number;
  /** the tests that reach the gate itself or a call it guards, each once with its strongest class */
  tests: CoverageTestRef[];
  /** how many of `tests` reach the gate itself (the rest reach a guarded call) */
  testsOnGate: number;
  chip: CoverageFacts['chip'];
  evidenceWord: EvidenceWord;
  /** the tests' one verdict (`testVerdict()`): the word, what the run behind it said, every case by its own run */
  verdict: TestVerdict;
  counted: {
    sitsOn: Counted;
    calls: Counted;
    pages: Counted;
    tests: CoverageCounted;
  };
  /** the walk up to the calls stopped at its budget: the lists are a floor */
  truncated: boolean;
}

/** How far up from what a gate sits on the walk looks for the routes and pages that reach it. */
export const GATE_REACH_DEPTH = 8;
/** The most parts the walk visits before it stops and says the lists are a floor. */
export const GATE_REACH_BUDGET = 4000;

function partOf(n: GraphNode): GatePart {
  return { id: n.id, kind: n.kind, name: n.name, ...(n.loc ? { loc: n.loc } : {}) };
}
function firstSentence(s: string | undefined): string | undefined {
  const text = String(s ?? '').trim();
  if (!text) return undefined;
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const out = (m ? m[0] : text).replace(/\s+/g, ' ').trim();
  return out.length > 280 ? out.slice(0, 277).replace(/\s+\S*$/, '') + '…' : out;
}
function routeFacts(n: GraphNode): Pick<GateCall, 'method' | 'path' | 'summary' | 'apiId'> {
  const m = /^([A-Z]+)\s+(\S+)/.exec(n.name);
  const c = n.contract;
  return {
    ...(m ? { method: m[1], path: m[2] } : {}),
    ...(c?.summary ? { summary: c.summary } : {}),
    ...(c?.apiId ? { apiId: c.apiId } : {}),
  };
}

/**
 * Everything the gate card says about one gate. Undefined when the id is not a
 * guard or a rule in this graph.
 */
export function gateCard(index: GraphIndex, gateId: string): GateCard | undefined {
  const node = index.byId.get(gateId);
  if (!node || (node.kind !== 'guard' && node.kind !== 'rule')) return undefined;
  const { ident, phrase } = gateNameParts(node.name);
  // authored words only: the docs' first sentence is its own field, so the card can tell the two apart
  const business = node.facets?.business?.description?.trim() || undefined;

  // what it sits on: its own guards / validates edges
  const sitsOn: GatePart[] = [];
  const seenOn = new Set<string>();
  for (const e of index.out.get(gateId) ?? []) {
    if (e.kind !== 'guards' && e.kind !== 'validates') continue;
    const t = index.byId.get(e.to);
    if (!t || seenOn.has(t.id)) continue;
    seenOn.add(t.id);
    sitsOn.push(partOf(t));
  }

  // the calls a request goes through to meet it: up the `calls` and `renders`
  // edges from what it sits on, stopping at the first route or page on each path
  const calls = new Map<string, GateCall>();
  const pages = new Map<string, GatePart>();
  const depthOf = new Map<string, number>();
  let frontier = [...seenOn];
  for (const id of frontier) depthOf.set(id, 0);
  let visited = frontier.length;
  let truncated = false;
  for (let depth = 0; depth <= GATE_REACH_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const n = index.byId.get(id);
      if (!n) continue;
      if (n.kind === 'route') { if (!calls.has(id)) calls.set(id, { ...partOf(n), depth, ...routeFacts(n) }); continue; }
      if (n.kind === 'page') { if (!pages.has(id)) pages.set(id, partOf(n)); continue; }
      if (depth === GATE_REACH_DEPTH) { truncated = true; continue; }
      for (const e of index.in.get(id) ?? []) {
        if (e.kind !== 'calls' && e.kind !== 'renders') continue;
        if (depthOf.has(e.from)) continue;
        if (visited >= GATE_REACH_BUDGET) { truncated = true; break; }
        depthOf.set(e.from, depth + 1);
        visited++;
        next.push(e.from);
      }
    }
    frontier = next;
  }
  const callList = [...calls.values()].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  const pageList = [...pages.values()].sort((a, b) => a.name.localeCompare(b.name));
  let routesInGraph = 0;
  for (const n of index.byId.values()) if (n.kind === 'route') routesInGraph++;

  // the tests: the gate's own, then each guarded call's — one row per test, its strongest class
  const byTest = new Map<string, CoverageTestRef>();
  const take = (id: string) => {
    const n = index.byId.get(id);
    for (const t of testsCovering(index, id)) {
      const ref = toCoverageRef(index, t, n);
      const have = byTest.get(t.id);
      if (!have || EVIDENCE_RANK[have.evidence]! < EVIDENCE_RANK[ref.evidence]!) byTest.set(t.id, ref);
    }
  };
  take(gateId);
  const onGate = new Set(byTest.keys());
  for (const c of callList) take(c.id);
  const tests = [...byTest.values()].sort((a, b) => Number(b.reaches.nodeId === gateId) - Number(a.reaches.nodeId === gateId)
    || a.level.localeCompare(b.level) || a.name.localeCompare(b.name));
  const facts = evidenceFacts(tests, 'count.scope.gate', 'gateCard().tests');

  const src = `gateCard(${gateId})`;
  return {
    gate: {
      ...partOf(node), gateKind: node.kind === 'rule' ? 'rule' : 'guard', ident, phrase,
      ...(business ? { business } : {}),
      ...(firstSentence(node.docs) ? { docs: firstSentence(node.docs)! } : {}),
      configCheck: isConfigCheck(node),
      declared: !!node.tags?.includes('declared'),
      ...(node.project?.name ? { project: node.project.name } : {}),
    },
    sitsOn,
    calls: callList,
    pages: pageList,
    routesInGraph,
    tests,
    testsOnGate: onGate.size,
    chip: facts.chip,
    evidenceWord: facts.evidenceWord,
    verdict: facts.verdict,
    counted: {
      sitsOn: counted(sitsOn.length, 'count.unit.gateSitsOn', 'count.scope.gate', `${src}.sitsOn.length`),
      calls: counted(callList.length, 'count.unit.gateCalls', 'count.scope.gate', `${src}.calls.length`, {
        of: routesInGraph,
        bizUnit: 'count.unit.gateCalls',
        breakdown: [
          { key: 'count.part.gateCallsOwn', n: callList.filter((c) => c.depth === 0).length },
          { key: 'count.part.gateCallsUnder', n: callList.filter((c) => c.depth > 0).length },
        ],
      }),
      pages: counted(pageList.length, 'count.unit.gatePages', 'count.scope.gate', `${src}.pages.length`, { bizUnit: 'count.unit.gatePages' }),
      tests: facts.counted,
    },
    truncated,
  };
}

// ── what an action needs (gates lane, 2026-10-10) ─────────────────────────────

/** One thing an action needs before it goes through: a gate on its walk, with its tier, its words and its one verdict. */
export interface ActionPrecondition {
  /** the gate's node id (a planned gate's synthetic id) */
  id: string;
  tier: GateTier;
  class: GateClass;
  /** a precondition's record and field, and the values it must / must not hold */
  record?: string;
  field?: string;
  requires?: string[];
  excludes?: string[];
  /** the record is the one the action writes, or one loaded beside it */
  relation?: 'own' | 'related';
  /** the roles or scopes a guard was handed here (`ops.approver`) */
  role?: string;
  /** the words: a precondition's sentence, a guard's `@guard` requirement, else its name */
  words: string;
  wordsFrom: 'business' | 'message' | 'humanize' | 'guard' | 'name';
  /** the gate card's one verdict for it (`gateCard().verdict` — `testVerdict()`): its word and how many tests reach it */
  evidence?: { word: EvidenceWord; tests: number; status?: TestVerdict['status'] };
  /** `path:line` */
  loc?: string;
  planned?: true;
}
/** A record move the action makes, and whether the code checks the status it moves from. */
export interface ActionMove {
  record: string;
  table: string;
  field: string;
  from?: string;
  fromAny?: string[];
  to: string;
  by: string;
  /** the code compares the prior status (a guard clause or a transition table): false = *not checked by the code* */
  checked: boolean;
}
/** What one action needs, in the order a reader meets it: who, the record's own state, the records around it, policy, then the technical checks. */
export interface ActionPreconditions {
  /** the route the action calls, else the function that starts it */
  action: string;
  moves: ActionMove[];
  preconditions: ActionPrecondition[];
  /** the preconditions counted, each once, by tier (scope: one action) */
  counted: Counted;
}

const CLASS_RANK = new Map<GateClass, number>(GATE_CLASS_ORDER.map((c, i) => [c, i]));
const CARD_FACTS = new WeakMap<GraphIndex, Map<string, ActionPrecondition['evidence'] | null>>();
/** The gate card's verdict for one gate, folded once per index. */
function evidenceOf(index: GraphIndex, id: string): ActionPrecondition['evidence'] | undefined {
  let m = CARD_FACTS.get(index);
  if (!m) { m = new Map(); CARD_FACTS.set(index, m); }
  if (m.has(id)) return m.get(id) ?? undefined;
  const card = gateCard(index, id);
  const ev = card ? { word: card.verdict.word, tests: card.tests.length, ...(card.verdict.status ? { status: card.verdict.status } : {}) } : null;
  m.set(id, ev);
  return ev ?? undefined;
}

/** One gate of the walk as a thing the action needs. */
function preconditionOf(index: GraphIndex, g: JourneyGate): ActionPrecondition {
  const node = index.byId.get(g.id);
  const t = node ? gateTierOf(node) : { tier: g.tier ?? 'business', class: g.class ?? 'authorisation' };
  const pre = node?.precondition;
  const { ident, phrase } = gateNameParts(g.name);
  const words = pre?.words ?? (phrase && ident ? phrase : g.name);
  const loc = pre ? `${pre.path}:${pre.line}` : node?.loc ? `${node.loc.path}:${node.loc.line}` : undefined;
  const ev = node ? evidenceOf(index, g.id) : undefined;
  return {
    id: g.id, tier: g.tier ?? t.tier, class: g.class ?? t.class,
    ...(pre ? { record: pre.record, field: pre.field, requires: pre.requires, ...(pre.excludes ? { excludes: pre.excludes } : {}), relation: pre.relation } : {}),
    ...(g.requires ? { role: g.requires } : {}),
    words, wordsFrom: pre ? pre.wordsFrom : phrase && ident ? 'guard' : 'name',
    ...(ev ? { evidence: ev } : {}),
    ...(loc ? { loc } : {}),
    ...(g.planned ? { planned: true as const } : {}),
  };
}

/** The order the hand-off reads: identity → authorisation → the record's own state → related records → completeness → policy → technical. */
function needOrder(a: ActionPrecondition, b: ActionPrecondition): number {
  const r = (x: ActionPrecondition) => (CLASS_RANK.get(x.class) ?? 99) * 2 + (x.relation === 'related' ? 1 : 0);
  return r(a) - r(b);
}

/**
 * Every moment's `preconditions`: the gates its steps meet (config checks apart, as everywhere), each
 * once, with tier, class, words and the gate card's verdict; and the record moves it makes, each
 * saying whether the code checks the status it moves from. Pure over the walk; the verdict is the
 * gate card's own, folded once per gate per index.
 */
export function withJourneyPreconditions(index: GraphIndex, j: Journey, summary: JourneySummary): JourneySummary {
  const stepAt = new Map(j.steps.map((s) => [s.order, s] as const));
  for (const sg of summary.segments) {
    for (const mo of sg.moments) {
      const seen = new Map<string, ActionPrecondition>();
      const inRange = new Set<string>();
      const tables: GraphNode[] = [];
      for (let o = mo.from; o <= mo.to; o++) {
        const st = stepAt.get(o);
        if (!st) continue;
        inRange.add(st.nodeId);
        const n = index.byId.get(st.nodeId);
        if (n?.kind === 'table' && n.lifecycle && !tables.includes(n)) tables.push(n);
        for (const g of st.gates) {
          if (g.config || seen.has(g.id)) continue;
          seen.set(g.id, preconditionOf(index, g));
        }
      }
      const needs = [...seen.values()].sort(needOrder);
      const moves: ActionMove[] = [];
      for (const t of tables) {
        for (const tr of t.lifecycle!.transitions) {
          if (!inRange.has(tr.by)) continue;
          const checked = !!tr.from || !!tr.fromAny?.length
            || needs.some((p) => p.relation === 'own' && p.field && index.byId.get(p.id)?.precondition?.table === t.id && p.field.replace(/_/g, '').toLowerCase() === t.lifecycle!.field.replace(/_/g, '').toLowerCase() && !!p.requires?.length);
          if (moves.some((m) => m.table === t.id && m.to === tr.to && m.by === tr.by)) continue;
          moves.push({ record: t.name, table: t.id, field: t.lifecycle!.field, ...(tr.from ? { from: tr.from } : {}), ...(tr.fromAny ? { fromAny: tr.fromAny } : {}), to: tr.to, by: tr.by, checked });
        }
      }
      if (!needs.length && !moves.length) continue;
      const callNode = mo.callStep != null ? stepAt.get(mo.callStep)?.nodeId : undefined;
      const action = callNode ?? stepAt.get(mo.actionStep)?.nodeId ?? '';
      const tiers = (k: GateTier) => needs.filter((p) => p.tier === k).length;
      mo.preconditions = {
        action, moves, preconditions: needs,
        counted: counted(needs.length, 'count.unit.preconditions', 'count.scope.action', `journeySummary().segments[${sg.index}].moments[${mo.index}].preconditions`, {
          bizUnit: 'count.unit.preconditions',
          breakdown: [
            { key: 'count.part.tierBusiness', n: tiers('business') },
            { key: 'count.part.tierPolicy', n: tiers('policy') },
            { key: 'count.unit.gatesTechnical', n: tiers('technical') },
          ],
        }),
      };
    }
  }
  return summary;
}
