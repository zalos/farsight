// The state of play — the front door's first answer (round 2026-10-10, proposal 5).
//
// A good overview document opens with *read this if* and *state of play*: the commit it was written against,
// what is built and walkable, what was validated by a run, what is still open, and how to re-check each number.
// Farsight holds every one of those facts in folds that already exist; this module only gathers them into three
// columns, each number a `Counted` with its unit, its scope and the command that prints it again (`recheck`).
// Nothing here is a new count: journeys and screens from the design surface, operations from the API surface,
// storylines from the journey tree, verdict words and runs from the tests catalogue, freshness from
// `freshness.ts`, the history from `historyFact()`. The viewer's front door, `GET /api/state`, MCP
// `graph_overview` and `farsight state` print this one object.
import type { ConfigMeta, TestRef } from './graph.js';
import type { GraphMeta } from './store.js';
import type { GraphIndex } from './query.js';
import { counted, countedText, breakdownText, type Counted, type CountPart } from './counts.js';
import { t, type Register } from './strings.js';
import { designSurface } from './design.js';
import { apiSurface } from './openapi.js';
import { journeyTree } from './journeys.js';
import { testsSurface, type TestsSurface } from './tests.js';
import { testNodes, type EvidenceWord } from './coverage.js';
import { freshnessFact, codeAtOfIndex, fillFreshness, freshnessVars, type FreshnessFact, type FreshnessRun } from './freshness.js';
import { historySentence, type HistoryFact } from './history.js';
import type { BuildInfo } from './version.js';

const SRC = 'core state-of-play.ts stateOfPlay';
const SCOPE = 'count.scope.workspace' as const;

/** The CLI and MCP calls that print each number again. `farsight state` prints the whole card. */
export const RECHECK = {
  state: { cli: 'farsight state', mcp: 'graph_overview' },
  journeys: { cli: 'farsight journeys', mcp: 'journeys' },
  apis: { cli: 'farsight api list', mcp: 'api_surface' },
  design: { cli: 'farsight design list', mcp: 'design_surface' },
  tests: { cli: 'farsight tests list', mcp: 'test_coverage' },
  history: { cli: 'farsight history --repo <name>', mcp: 'graph_overview' },
} as const;

export interface StateOfPlay {
  /** what the card is as of: the sources, the sync, when it was written, the code's commit and the build that wrote it */
  provenance: { sources: string[]; sync?: number; generatedAt?: string; commit?: string; farsight?: BuildInfo };
  built: {
    /** journeys whose every screen is built, of the journeys the designs declare */
    journeys: Counted;
    /** screens built, of the screens the designs declare */
    screens: Counted;
    /** operations with code behind them, of the operations the API surfaces list */
    operations: Counted;
    storylines: Counted;
    branches: Counted;
  };
  validated: {
    /** journeys by their one verdict word (`testVerdict()` — the tests catalogue's journey rows), strongest first; the word is lane V's */
    byVerdict: { word: EvidenceWord; journeys: Counted }[];
    /** the newest end-to-end run and its one freshness fact; null when no end-to-end case has a run */
    lastE2e: { at: string; fresh?: FreshnessFact } | null;
    /** every case by its own last run — passed · failed · skipped · flaky · no run recorded */
    cases: Counted;
  };
  open: {
    screensNotBuilt: Counted;
    /** the names of the screens designed and not built, as the design names them (first five) */
    notBuiltNames: string[];
    /** operations a contract declares that no code serves (a spec-only source is not a gap and is left out) */
    operationsNotImplemented: Counted;
    blindSpots: Counted;
    /** the blind spots' own sentences, as the tests catalogue prints them */
    blindSpotSentences: string[];
    drift: Counted;
    /** the commits fact, one sentence with both halves; null when no history store could be read */
    history: HistoryFact | null;
  };
  /** the words the application leans on: the config files' glossary, per source */
  glossary: (NonNullable<ConfigMeta['glossary']>[number] & { repo: string })[];
}

const CLS_ORDER: Record<EvidenceWord['cls'], number> = { observed: 0, stale: 1, reached: 2, declared: 3, none: 4 };

/**
 * Fold the state of play over a scope. `tests` takes the tests catalogue a server already folded (it is the
 * costly part); `history` the history fact a server read from its store (core never opens a database).
 */
export function stateOfPlay(
  index: GraphIndex,
  meta: GraphMeta | undefined,
  opts: { scope?: Set<string> | null; tests?: TestsSurface; history?: HistoryFact | null } = {},
): StateOfPlay {
  const scope = opts.scope ?? null;
  const designs = designSurface(index, scope);
  const apis = apiSurface(index, scope);
  const tree = journeyTree(index, meta?.journeys, scope);
  const tests = opts.tests ?? testsSurface(index, scope, meta?.tests);

  // ── built and walkable ──
  const flows = new Map<string, { status: string }>();
  for (const d of designs) for (const f of d.flows) flows.set(f.nodeId, f);
  const flowsBuilt = [...flows.values()].filter((f) => f.status === 'both').length;
  const designed = designs.reduce((s, d) => s + d.counts.designed, 0);
  const screensBuilt = designs.reduce((s, d) => s + d.counts.built, 0);
  const designOnly = designs.reduce((s, d) => s + d.counts.designOnly, 0);
  const opsAll = apis.reduce((s, a) => s + a.counts.operations, 0);
  const opsImpl = apis.reduce((s, a) => s + a.counts.implemented, 0);
  const opsGap = apis.filter((a) => !a.specSource).reduce((s, a) => s + a.counts.notImplemented, 0);
  const branches = tree.storylines.reduce((s, x) => s + x.branches.length, 0);

  const built = {
    journeys: counted(flowsBuilt, 'count.unit.journeysBuilt', SCOPE, `${SRC} ← designSurface().flows[].status = both`, { of: flows.size, bizUnit: 'count.unit.journeysBuilt', recheck: RECHECK.state }),
    screens: counted(screensBuilt, 'state.unit.screensBuilt', SCOPE, `${SRC} ← designSurface().counts.built / .designed`, { of: designed, bizUnit: 'state.unit.screensBuilt', recheck: RECHECK.design }),
    operations: counted(opsImpl, 'state.unit.operations', SCOPE, `${SRC} ← apiSurface().counts.implemented / .operations`, { of: opsAll, recheck: RECHECK.apis }),
    storylines: counted(tree.storylines.length, 'count.unit.storylines', SCOPE, `${SRC} ← journeyTree().storylines`, { bizUnit: 'count.unit.storylines', recheck: RECHECK.journeys }),
    branches: counted(branches, 'count.part.storylineBranches', SCOPE, `${SRC} ← journeyTree().storylines[].branches`, { bizUnit: 'count.part.storylineBranches', recheck: RECHECK.journeys }),
  };

  // ── validated by a run ──
  const byKey = new Map<string, { word: EvidenceWord; n: number }>();
  for (const r of tests.journeys) {
    const word = r.coverage.verdict?.word ?? r.coverage.evidenceWord;
    if (!word) continue;
    const hit = byKey.get(word.key);
    if (hit) hit.n++; else byKey.set(word.key, { word, n: 1 });
  }
  const byVerdict = [...byKey.values()]
    .sort((a, b) => CLS_ORDER[a.word.cls] - CLS_ORDER[b.word.cls] || b.n - a.n || (a.word.key < b.word.key ? -1 : 1))
    .map((v) => ({ word: v.word, journeys: counted(v.n, 'count.unit.journeys', SCOPE, `${SRC} ← testsSurface().journeys[].coverage.verdict.word`, { bizUnit: 'count.unit.journeys', recheck: { cli: 'farsight tests matrix', mcp: 'test_coverage' } }) }));

  const e2eRuns: FreshnessRun[] = [];
  let newest = '';
  for (const t of testNodes(index, scope)) {
    const ref: TestRef = t.test!;
    if (ref.level !== 'e2e' || !ref.run || ref.inactive) continue;
    const run = ref.run;
    e2eRuns.push({ freshness: run.freshness, ...(run.changedBy ? { changedBy: run.changedBy } : {}), at: run.at, ...(run.commit ? { commit: run.commit } : {}), repo: t.loc?.repo ?? t.id.split('::')[0] });
    if (run.at > newest) newest = run.at;
  }
  const lastE2e = newest ? { at: newest, fresh: freshnessFact(e2eRuns, codeAtOfIndex(index)) } : null;

  const runs = { passed: 0, failed: 0, skipped: 0, flaky: 0, noRun: 0 };
  let cases = 0;
  for (const c of tests.sources) {
    cases += c.cases;
    const r = c.runs;
    if (!r) { runs.noRun += c.cases; continue; }
    runs.passed += r.passed; runs.failed += r.failed; runs.skipped += r.skipped; runs.flaky += r.flaky;
    // a verdict nobody recorded and no run at all read as one absence, as on the Tests page's cards
    runs.noRun += r.unknown + r.noRun;
  }
  const caseParts: CountPart[] = [
    { key: 'count.part.passed', n: runs.passed }, { key: 'count.part.failed', n: runs.failed },
    { key: 'count.part.skipped', n: runs.skipped }, { key: 'count.part.flaky', n: runs.flaky },
    { key: 'count.part.noRun', n: runs.noRun },
  ];

  const validated = {
    byVerdict,
    lastE2e,
    cases: counted(cases, 'count.unit.cases', SCOPE, `${SRC} ← testsSurface().sources[].runs`, { bizUnit: 'journey.biz.countTests', breakdown: caseParts, recheck: RECHECK.tests }),
  };

  // ── still open ──
  const notBuiltNames = designs.flatMap((d) => d.screens.filter((s) => s.status === 'design-only').map((s) => s.name)).slice(0, 5);
  const drift = designs.reduce((s, d) => s + d.counts.drift, 0);
  const open = {
    screensNotBuilt: counted(designOnly, 'state.unit.screensNotBuilt', SCOPE, `${SRC} ← designSurface().counts.designOnly`, { bizUnit: 'state.unit.screensNotBuilt', recheck: RECHECK.design }),
    notBuiltNames,
    operationsNotImplemented: counted(opsGap, 'state.unit.operationsNotImplemented', SCOPE, `${SRC} ← apiSurface().counts.notImplemented (spec-only sources left out)`, { recheck: RECHECK.apis }),
    blindSpots: counted(tests.blindSpots.length, 'state.unit.blindSpots', SCOPE, `${SRC} ← testsSurface().blindSpots`, { bizUnit: 'state.unit.blindSpots', recheck: RECHECK.tests }),
    blindSpotSentences: tests.blindSpots,
    drift: counted(drift, 'state.unit.drift', SCOPE, `${SRC} ← designSurface().counts.drift`, { bizUnit: 'state.unit.drift', recheck: RECHECK.design }),
    history: opts.history ?? null,
  };

  const repos = [...new Set([...index.byId.values()].map((n) => n.loc?.repo ?? n.id.split('::')[0]!))]
    .filter((r) => !scope || scope.has(r)).sort();
  const glossary = repos.flatMap((repo) => (meta?.config?.[repo]?.glossary ?? []).map((g) => ({ ...g, repo })));

  return {
    provenance: {
      sources: repos,
      ...(meta?.sync != null ? { sync: meta.sync } : {}),
      ...(meta?.generatedAt ? { generatedAt: meta.generatedAt } : {}),
      ...(meta?.commit ? { commit: meta.commit } : {}),
      ...(meta?.farsight ? { farsight: meta.farsight } : {}),
    },
    built, validated, open, glossary,
  };
}

/** One line per number, the three columns as three blocks — what `graph_overview` and `farsight state` print. */
export function stateOfPlayLines(s: StateOfPlay, opts: { register?: Register } = {}): string[] {
  const register = opts.register ?? 'professional';
  const w = (c: Counted) => countedText(c, { register, scope: false });
  const re = (c: Counted) => (c.recheck ? `  — re-check: ${c.recheck.cli}${c.recheck.mcp ? ` · MCP ${c.recheck.mcp}` : ''}` : '');
  const p = s.provenance;
  const out: string[] = [];
  out.push(`${t('state.title', register)} — ${[
    p.sources.join(', '),
    p.sync != null ? t('state.asOf', register).replace('{n}', String(p.sync)) : '',
    p.generatedAt ? p.generatedAt.replace('T', ' ').slice(0, 16) : '',
    p.commit ? t('state.codeAt', register).replace('{c}', p.commit.slice(0, 7)) : t('state.codeAtNone', register),
    p.farsight ? t('state.drawnBy', register).replace('{b}', `${p.farsight.version}${p.farsight.commit ? ` · ${p.farsight.commit}` : ''}`) : '',
  ].filter(Boolean).join(' · ')}`);
  out.push(`${t('state.col.built', register)}:`);
  for (const c of [s.built.journeys, s.built.screens, s.built.operations]) out.push(`- ${w(c)}${re(c)}`);
  out.push(`- ${w(s.built.storylines)} · ${w(s.built.branches)}${re(s.built.storylines)}`);
  out.push(`${t('state.col.validated', register)}:`);
  for (const v of s.validated.byVerdict) if (v.word.cls !== 'none') out.push(`- ${w(v.journeys)} ${t(v.word.key, register)}${re(v.journeys)}`);
  if (s.validated.lastE2e) {
    const f = s.validated.lastE2e.fresh;
    out.push(`- ${t('state.lastE2e', register).replace('{date}', s.validated.lastE2e.at.slice(0, 10))}${f ? ` · ${fillFreshness(t(f.key, register), freshnessVars(f))}` : ''}`);
  } else out.push(`- ${t('state.noE2e', register)}`);
  out.push(`- ${w(s.validated.cases)}: ${breakdownText(s.validated.cases, register)}${re(s.validated.cases)}`);
  out.push(`${t('state.col.open', register)}:`);
  out.push(`- ${w(s.open.screensNotBuilt)}${s.open.notBuiltNames.length ? ` (${s.open.notBuiltNames.join(', ')})` : ''}${re(s.open.screensNotBuilt)}`);
  for (const c of [s.open.operationsNotImplemented, s.open.blindSpots, s.open.drift]) out.push(`- ${w(c)}${re(c)}`);
  out.push(`- ${s.open.history ? `${historySentence(s.open.history, register)}${re(s.open.history.read)}` : t('state.historyNone', register)}`);
  return out;
}
