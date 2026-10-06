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
import type { GraphIndex } from './query.js';
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
