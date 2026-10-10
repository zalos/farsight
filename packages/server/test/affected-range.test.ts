/**
 * A commit range placed on the journeys — core `affectedRange()` → `farsight-affected v1` — and the release
 * readiness brief, core `readiness()` (round 2026-10-10, proposal 6). The graph is `examples/invoice-app`
 * ingested in process; the spine is synthetic: three commits, the last two touching `finalizeInvoice`.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GraphStore, stitchHttp, buildIndex, setFreshnessMeta, journeyTree, affectedRange, readiness, readinessCsvRows, t,
  AFFECTED_RANGE_KINDS, AFFECTED_GRANULARITY, AFFECTED_GATE_KINDS, AFFECTED_CONTRACT_STATUS, AFFECTED_RUN_STATUS,
  AFFECTED_EVIDENCE, AFFECTED_VERDICT_CLASS, AFFECTED_TEST_LEVELS, AFFECTED_TEST_RUNNERS, READINESS_HOLD_REASONS, countedProblems,
} from '@farsight/core';
import type { GraphIndex, JourneyTree, AffectedV1 } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repoRoot, 'examples/invoice-app');
const SCHEMA = () => JSON.parse(readFileSync(join(repoRoot, 'schemas', 'farsight-affected-v1.schema.json'), 'utf8'));
const identity = { source_digest: {}, farsight: 'test', generated_at: '2026-10-10T00:00:00Z' };

let index: GraphIndex;
let tree: JourneyTree;

// the synthetic spine: c1 touches the README only, c2 and c3 the function that finalizes an invoice
const SPINE = [
  { sha: 'c1', subject: 'docs: a note', at: '2026-09-20T00:00:00Z' },
  { sha: 'c2', subject: 'fix(invoices): finalize checks the lines', at: '2026-09-25T00:00:00Z' },
  { sha: 'c3', subject: 'fix(invoices): number before the ledger', at: '2026-10-01T00:00:00Z' },
];

before(async () => {
  const store = new GraphStore();
  const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
  store.roots[fragment.repo] = fixture;
  store.addFragment(fragment);
  stitchHttp(store);
  const { nodes, edges } = store.toJSON();
  index = buildIndex(nodes, edges);
  setFreshnessMeta(index, store.meta);
  tree = journeyTree(index, store.meta.journeys);
});

function finalizeRange(): AffectedV1 {
  return affectedRange(index, {
    repo: 'invoice-app',
    range: { kind: 'commits', from: 'c1', to: 'c3' },
    commits: SPINE.slice(1),
    files: [{ path: 'src/server/invoiceService.ts', status: 'M', ranges: [[60, 66]] }, { path: 'README.md', status: 'M', ranges: [[1, 2]] }],
    history: [...SPINE].reverse(),
    tree,
    identity,
  });
}

test('a range lands on the function its hunks sit in, and reaches the journeys that run it with their storyline place', () => {
  const doc = finalizeRange();
  assert.deepEqual(doc.changed.map((c) => c.name), ['finalizeInvoice']);
  assert.equal(doc.files.find((f) => f.path === 'src/server/invoiceService.ts')!.granularity, 'lines');
  assert.equal(doc.files.find((f) => f.path === 'README.md')!.granularity, 'none');
  const names = doc.journeys.map((j) => j.name).sort();
  assert.deepEqual(names, ['Billing cycle', 'Draft and send an invoice']);
  for (const j of doc.journeys) assert.equal(j.hop, 0, `${j.name} runs the changed function itself`);
  const cycle = doc.journeys.find((j) => j.name === 'Billing cycle')!;
  assert.deepEqual(cycle.storylines.map((s) => [s.id, s.step, s.of, s.branch_of]), [['invoice', 2, 2, null]]);
  const branch = doc.journeys.find((j) => j.name === 'Draft and send an invoice')!;
  assert.equal(branch.storylines[0]!.branch_of, 'invoice-app::flow::new-invoice');
  assert.ok(branch.storylines[0]!.when);
});

test('the changed path names its gates, the record write with the status the lifecycle moves, and the call', () => {
  const doc = finalizeRange();
  assert.ok(doc.gates.some((g) => g.name === 'requireScope: billing:admin'), 'the scope check on finalize');
  const inv = doc.writes.find((w) => w.name === 'invoices' && w.writer_name === 'finalizeInvoice');
  assert.ok(inv, 'finalizeInvoice writes invoices');
  assert.deepEqual(inv!.moves, [{ from: null, to: 'open' }]);
  assert.ok(doc.contracts.some((c) => c.name === 'POST /invoices/:id/finalize' && c.method === 'POST'));
});

test('the tests are each case once, nearest first, with its own last run, and the verdict sums', () => {
  const doc = finalizeRange();
  const ids = doc.tests.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'each case once');
  const fin = doc.tests.find((x) => x.title.startsWith('finalizeInvoice assigns a number'));
  assert.ok(fin, 'the unit case that reaches finalizeInvoice');
  assert.equal(fin!.hop, 0);
  assert.equal(fin!.status, 'skipped');
  const v = doc.verdict;
  assert.equal(v.passed + v.failed + v.skipped + v.flaky + v.no_run, doc.tests.length);
  // commits since the last run: the spine's commits after it
  assert.equal(v.commits_since, SPINE.filter((c) => c.at > v.last_run!).length);
  assert.equal(doc.bound, 'floor', 'README.md changed and defines nothing the graph indexed');
  for (const [k, c] of Object.entries(doc.counted)) assert.deepEqual(countedProblems(c, k), []);
  assert.equal(doc.counted.tests.n, doc.tests.length);
  assert.equal(doc.counted.journeys.n, doc.journeys.length);
});

test('a changed spec file selects its own cases at hop 0', () => {
  const doc = affectedRange(index, {
    repo: 'invoice-app', range: { kind: 'pr', number: 7, title: 'test: tighten', head: 'h', base: 'b' },
    commits: [SPINE[2]!], files: [{ path: 'test/invoiceService.test.ts', status: 'M', ranges: [[21, 21]] }], identity,
  });
  assert.ok(doc.tests.length > 0);
  assert.ok(doc.tests.every((x) => x.file === 'test/invoiceService.test.ts' && x.hop === 0));
  assert.equal(doc.range.pr!.number, 7);
});

test('farsight-affected v1 validates against its schema, and its enums cannot drift from the code', () => {
  const schema = SCHEMA();
  assert.deepEqual(validate(JSON.parse(JSON.stringify(finalizeRange())), schema), []);
  assert.ok(validate({ schema: 'farsight-affected v1' }, schema).length > 0, 'the schema rejects a broken document');
  const d = schema.$defs;
  assert.deepEqual(schema.properties.range.properties.kind.enum, [...AFFECTED_RANGE_KINDS]);
  assert.deepEqual([...AFFECTED_RANGE_KINDS], ['commits', 'pr']);
  assert.deepEqual(d.granularity.enum, [...AFFECTED_GRANULARITY]);
  assert.deepEqual([...AFFECTED_GRANULARITY], ['lines', 'file', 'none']);
  assert.deepEqual(d.gateKind.enum, [...AFFECTED_GATE_KINDS]);
  assert.deepEqual([...AFFECTED_GATE_KINDS], ['guard', 'rule']);
  assert.deepEqual(d.contract.enum, [...AFFECTED_CONTRACT_STATUS]);
  assert.deepEqual([...AFFECTED_CONTRACT_STATUS], ['both', 'spec-only', 'code-only', 'declared', null]);
  assert.deepEqual(d.runStatus.enum, [...AFFECTED_RUN_STATUS]);
  assert.deepEqual([...AFFECTED_RUN_STATUS], ['passed', 'failed', 'skipped', 'flaky', 'unknown', null]);
  assert.deepEqual(d.evidenceClass.enum, [...AFFECTED_EVIDENCE]);
  assert.deepEqual([...AFFECTED_EVIDENCE], ['declared', 'reached', 'observed']);
  assert.deepEqual(d.verdictClass.enum, [...AFFECTED_VERDICT_CLASS]);
  assert.deepEqual([...AFFECTED_VERDICT_CLASS], ['none', 'declared', 'reached', 'observed', 'stale']);
  assert.deepEqual(d.level.enum, [...AFFECTED_TEST_LEVELS]);
  assert.deepEqual([...AFFECTED_TEST_LEVELS], ['unit', 'integration', 'e2e']);
  assert.deepEqual(d.runner.enum, [...AFFECTED_TEST_RUNNERS]);
  assert.deepEqual([...AFFECTED_TEST_RUNNERS], ['vitest', 'jest', 'node:test', 'playwright', 'cypress', 'junit', 'other']);
  assert.deepEqual(d.bound ?? schema.properties.bound.enum, ['exact', 'floor']);
});

test('the readiness brief: one row per step and branch, ship or hold by the stated policy', () => {
  const r = readiness(index, tree, 'invoice', { commitsSince: (_repo, _parts, since) => SPINE.filter((c) => c.at > since).length })!;
  const st = tree.storylines.find((s) => s.id === 'invoice')!;
  assert.equal(r.rows.length, st.journeys.length + st.branches.length, 'rows = the storyline’s steps and branches');
  assert.deepEqual(r.rows.map((x) => x.label), ['1', '1b', '2']);
  assert.equal(r.rows[1]!.kind, 'branch');
  for (const row of r.rows) {
    const held = [!row.built.all && 'notBuilt', row.failed > 0 && 'failed', row.skipped > 0 && 'skipped'].filter(Boolean);
    assert.deepEqual(row.hold, held, `${row.label} holds for exactly the policy's reasons`);
    assert.equal(row.ship, held.length === 0);
    for (const h of row.hold) assert.ok((READINESS_HOLD_REASONS as readonly string[]).includes(h));
    if (row.lastGreen) assert.equal(row.commitsSince, SPINE.filter((c) => c.at > row.lastGreen!).length);
  }
  assert.equal(r.counted.ship.n + r.counted.hold.n, r.rows.length);
  for (const [k, c] of Object.entries(r.counted)) assert.deepEqual(countedProblems(c, k), []);
  assert.ok(r.rules.length > 0);
  const csv = readinessCsvRows(r, (k) => t(k, 'professional'));
  assert.equal(csv.rows.length, r.rows.length);
  assert.equal(readiness(index, tree, 'nope'), undefined);
});
