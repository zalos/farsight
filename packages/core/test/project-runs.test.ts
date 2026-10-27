// A case skipped on one browser project by its own written condition is not a skipped case (outsider demo 2026-10-13,
// F3): the reference app's storyline-wide e2e case passed on `desktop-1440` and was skipped on `mobile-390` by its own
// `test.skip(viewport < 1024, "…designed for desktop…")`, the fold kept the weakest status, and the readiness brief
// held every journey the case declares — *0 of 6 ship* beside a front door that said *passed*.
//  - the fold over a case's projects: failed or flaky anywhere stays so; else passed on any project is passed, with
//    the projects (and the skip's own reason) kept on the fold; skipped everywhere stays skipped;
//  - the index re-folds `run` from `runs[]`, so a graph an older build wrote reads the same;
//  - the verdict says both projects; readiness holds only when no project passed, and names the project and reason.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex,
  foldRuns,
  readiness,
  journey,
  journeySummary,
  screensFor,
  journeyCoverage,
  projectSplitWords,
  heldWords,
  STRINGS,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, JourneyTree, TestRun } from '../dist/index.js';

const R = 'app';
const AT = '2026-10-08T22:35:00.000Z';
const run = (status: TestRun['status'], project: string, reason?: string): TestRun => ({
  id: 'r',
  at: AT,
  status,
  freshness: 'unknown',
  stale: false,
  project,
  report: 'e2e/results.json',
  ...(reason ? { reason } : {}),
});
const REASON = 'The walk crosses the ops console, which is designed for desktop';

test('foldRuns: passed on one project and skipped by its own condition on another folds to passed, keeping both', () => {
  const f = foldRuns([run('passed', 'desktop-1440'), run('skipped', 'mobile-390', REASON)])!;
  assert.equal(f.status, 'passed');
  assert.equal(f.project, undefined, 'two projects ran it: the fold names none');
  assert.deepEqual(f.projects, [
    { project: 'desktop-1440', status: 'passed' },
    { project: 'mobile-390', status: 'skipped', reason: REASON },
  ]);
  // a fail is a fail, wherever it happened
  assert.equal(foldRuns([run('passed', 'a'), run('failed', 'b')])!.status, 'failed');
  assert.equal(foldRuns([run('passed', 'a'), run('flaky', 'b')])!.status, 'flaky');
  assert.equal(foldRuns([run('skipped', 'a'), run('failed', 'b'), run('passed', 'c')])!.status, 'failed');
  // skipped on every project stays skipped, with each reason kept
  const s = foldRuns([run('skipped', 'desktop-1440', 'live only'), run('skipped', 'mobile-390', REASON)])!;
  assert.equal(s.status, 'skipped');
  assert.deepEqual(
    s.projects!.map((p) => p.reason),
    ['live only', REASON],
  );
  // one project: as before, its reason on the run itself
  const one = foldRuns([run('skipped', 'desktop-1440', 'live only')])!;
  assert.equal(one.reason, 'live only');
  assert.equal(one.project, 'desktop-1440');
  assert.equal(one.projects, undefined);
});

const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge => ({
  id: `${kind}|${from}|${to}`,
  kind,
  from,
  to,
  ...(meta ? { meta } : {}),
});
const FLOW = `${R}::flow::f`,
  PAGE = `${R}::page::/a`,
  ROUTE = `${R}::route::POST /api/x`,
  E2E = `${R}::test::e.spec.ts::walks`;

/** The reference app's shape: one own e2e case, its `runs[]` per project, and `run` as an older build folded it (skipped). */
function app(runs: TestRun[]) {
  const nodes = [
    { id: FLOW, kind: 'flow', name: 'F', tags: [], design: { id: 'f', name: 'F' } },
    {
      id: PAGE,
      kind: 'page',
      name: '/a',
      tags: [],
      loc: { repo: R, path: 'a.tsx', line: 1 },
      design: { id: 'S-01', status: 'both' },
    },
    { id: ROUTE, kind: 'route', name: 'POST /api/x', tags: [], loc: { repo: R, path: 'r.ts', line: 2 } },
    {
      id: E2E,
      kind: 'test',
      name: 'walks',
      tags: ['test'],
      loc: { repo: R, path: 'e.spec.ts', line: 1 },
      test: {
        level: 'e2e',
        runner: 'playwright',
        suite: [],
        file: 'e.spec.ts',
        declares: ['f'],
        runs,
        // what the weakest-status fold wrote into a graph before this change
        run: { ...runs[0]!, status: runs.some((r) => r.status === 'skipped') ? 'skipped' : runs[0]!.status },
      },
    },
  ] as GraphNode[];
  const edges = [
    edge('renders', FLOW, PAGE),
    edge('http', PAGE, ROUTE, { line: 3 }),
    edge('covers', E2E, PAGE, { evidence: 'declared' }),
    edge('covers', E2E, ROUTE, { evidence: 'declared' }),
  ];
  return buildIndex(nodes, edges);
}
const tree = () =>
  ({
    storylines: [
      {
        id: 's',
        name: 'S',
        repo: R,
        branches: [],
        journeys: [
          {
            nodeId: FLOW,
            id: 'f',
            name: 'F',
            repo: R,
            built: 1,
            total: 1,
            status: 'both',
            screens: [],
            docs: [],
            operations: [],
          },
        ],
      },
    ],
  }) as unknown as JourneyTree;

test('readiness ships a journey whose own case passed on one project and was skipped by its condition on another — a note, not a hold', () => {
  const index = app([run('passed', 'desktop-1440'), run('skipped', 'mobile-390', REASON)]);
  assert.equal(index.byId.get(E2E)!.test!.run!.status, 'passed', 'the index re-folds a graph an older build wrote');
  const row = readiness(index, tree(), 's')!.rows[0]!;
  assert.equal(row.ship, true);
  assert.deepEqual(row.hold, []);
  assert.deepEqual(row.notes.projectSkips, [
    {
      id: E2E,
      name: 'walks',
      passedOn: ['desktop-1440'],
      skippedOn: [{ project: 'mobile-390', reason: REASON }],
      words: {
        text: `note: walks — passed on desktop-1440 · skipped on mobile-390 (${REASON})`,
        biz: `note: walks — passed on desktop-1440; not run on mobile-390 (${REASON}) by its own condition`,
      },
    },
  ]);
  assert.equal(row.skipped, 0, 'the case is not counted skipped');
});

test('readiness holds when no project passed, and names the project and the written reason', () => {
  const index = app([run('skipped', 'desktop-1440', 'live only'), run('skipped', 'mobile-390', REASON)]);
  const row = readiness(index, tree(), 's')!.rows[0]!;
  assert.deepEqual(row.hold, ['skipped']);
  assert.deepEqual(
    row.holdCases.map(({ where: _w, ...c }) => c),
    [
      {
        id: E2E,
        name: 'walks',
        status: 'skipped',
        projects: [
          { project: 'desktop-1440', status: 'skipped', reason: 'live only' },
          { project: 'mobile-390', status: 'skipped', reason: REASON },
        ],
      },
    ],
  );
  assert.equal(row.holdCases[0]!.where!.text, `skipped on desktop-1440 (live only), mobile-390 (${REASON})`);
});

test('the verdict says both projects in one sentence, in both registers, and keeps its word', () => {
  const index = app([run('passed', 'desktop-1440'), run('skipped', 'mobile-390', REASON)]);
  const j = journey(index, FLOW);
  const cov = journeyCoverage(index, j, journeySummary(index, j, screensFor(index, FLOW)))!;
  const v = cov.journey.verdict;
  assert.equal(v.skipped, 0);
  const { words, ...split } = v.projectSplit!;
  assert.deepEqual(split, {
    n: 1,
    passedOn: ['desktop-1440'],
    skippedOn: [{ project: 'mobile-390', reasons: [REASON] }],
  });
  assert.equal(words!.text, `passed on desktop-1440 · skipped on mobile-390 (${REASON})`);
  assert.equal(projectSplitWords(v.projectSplit!, false), `passed on desktop-1440 · skipped on mobile-390 (${REASON})`);
  assert.match(projectSplitWords(v.projectSplit!, true), /not run on mobile-390/);
  for (const k of [
    'tests.projectSplit',
    'tests.projectSplitMany',
    'tests.biz.projectSplit',
    'tests.projectSkipped',
    'tests.skippedOn',
    'readiness.note.projectSkip',
    'readiness.held.line',
  ]) {
    assert.ok(STRINGS[k]?.define, k);
    assert.ok(STRINGS[k]?.professional, k);
  }
});

test('a journey the brief holds carries the brief’s one line beside its word; one that ships carries none', () => {
  const cov = (runs: TestRun[]) => {
    const index = app(runs);
    const j = journey(index, FLOW);
    return journeyCoverage(index, j, journeySummary(index, j, screensFor(index, FLOW)))!.journey;
  };
  assert.equal(
    cov([run('passed', 'desktop-1440'), run('skipped', 'mobile-390', REASON)]).held,
    undefined,
    'it ships: nothing is paired',
  );
  const held = cov([run('skipped', 'desktop-1440', 'live only'), run('skipped', 'mobile-390', REASON)]).held!;
  assert.deepEqual(held.reasons, ['skipped']);
  // beside a chip: the brief's reason alone; the tip and the brief name the case and where it skipped
  assert.equal(heldWords(held), 'held in the release brief: its own case was skipped');
  assert.equal(
    heldWords(held, false, 'professional', { full: true }),
    `held in the release brief: its own case was skipped — walks (skipped on desktop-1440 (live only), mobile-390 (${REASON}))`,
  );
  assert.match(held.words!.fullBiz, /^held back in the release brief: .*not run on desktop-1440/);
  // the brief and the chip read one rule: the same cases
  const r = readiness(
    app([run('skipped', 'desktop-1440', 'live only'), run('skipped', 'mobile-390', REASON)]),
    tree(),
    's',
  )!.rows[0]!;
  assert.deepEqual(r.holdCases, held.cases);
});

test('a hold on a case one project ran and skipped names that project and the reason it wrote', () => {
  const index = app([run('skipped', 'live', 'runs only with E2E_LIVE=1')]);
  const row = readiness(index, tree(), 's')!.rows[0]!;
  assert.deepEqual(row.hold, ['skipped']);
  assert.equal(row.holdCases[0]!.where!.text, 'skipped on live (runs only with E2E_LIVE=1)');
  assert.equal(row.holdCases[0]!.where!.biz, 'not run on live (runs only with E2E_LIVE=1)');
  assert.equal(row.holdCases[0]!.where!.short, 'skipped on live');
});
