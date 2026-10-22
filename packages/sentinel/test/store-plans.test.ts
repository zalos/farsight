// Plan admission in the ledger (PR 08 with PR 06): an exact plan revision and its pinned artifacts accepted from
// unbound stages in one transaction, the revision chain, a run advancing one admitted revision at a time, the
// plan as a collection root across reopen, and an attempt's invocation records accepted with its start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, type Ledger } from '../dist/store/ledger.js';
import { LedgerError } from '../dist/store/store-types.js';
import { FakeOwner, OBJECTS, attemptEnvelope, identityReceipt, runEnvelope, scratch, sha, workEnvelope } from './store-helpers.ts';

const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
let epochs = 0;

async function ledgerAt(t: { after(fn: () => void): void }, dir = scratch(t)) {
  const ledger = await openLedger(new FakeOwner(dir, `epoch-plan-${++epochs}`), { objects: OBJECTS });
  t.after(() => { try { ledger.close(); } catch { /* closed by the test */ } });
  return { dir, ledger };
}

/** A plan revision and its pinned records staged the way execution/plans.ts stages them: the plan links each one. */
function stagePlan(ledger: Ledger, tag: string, revision: number, kind: 'bootstrap' | 'analysis', previous: string | null, snapshotId: string | null = null) {
  const texts = { plan: `${tag} plan ${revision}`, profile: `${tag} profile`, lock: `${tag} lock ${revision}`, policy: `${tag} policy` };
  const pinned = kind === 'analysis' ? [sha(texts.lock), sha(texts.policy)] : [];
  const children = [sha(texts.profile), ...pinned];
  ledger.registerStaging(`${tag}.plan-${revision}`, [
    { id: sha(texts.plan), schema: 'sentinel-plan/draft-1', privacy: 'source-derived', links: children },
    { id: sha(texts.profile), schema: 'sentinel-execution-profile/draft-1', privacy: 'metadata' },
    ...(kind === 'analysis' ? [{ id: sha(texts.lock), schema: 'sentinel-rulelock/draft-1', privacy: 'metadata' as const }, { id: sha(texts.policy), schema: 'sentinel-effective-policy/1', privacy: 'metadata' as const }] : []),
  ]);
  const receipts = [texts.plan, texts.profile, ...(kind === 'analysis' ? [texts.lock, texts.policy] : [])].map(identityReceipt);
  return { runId: `run-${tag}`, revision, kind, digest: sha(`${tag} digest ${revision}`), previous, plan: sha(texts.plan),
    ruleLock: kind === 'analysis' ? sha(texts.lock) : null, policy: kind === 'analysis' ? sha(texts.policy) : null, profile: sha(texts.profile),
    snapshotId, stageIds: [`${tag}.plan-${revision}`], receipts };
}

function admitSnapshot(ledger: Ledger, id: string) {
  const m = `${id} manifest`, z = `${id} sidecar`;
  ledger.registerStaging(`${id}.roots`, [{ id: sha(m), schema: 'sentinel-snapshot/draft-1', privacy: 'source-derived' },
    { id: sha(z), schema: 'sentinel-capture-materialization/draft-1', privacy: 'source', links: [sha(m)] }]);
  return ledger.admitSnapshot({ snapshotId: id, stageIds: [`${id}.roots`], manifest: sha(m), materialization: sha(z), inventoryDigest: sha(`${id} inv`), receipts: [m, z].map(identityReceipt) });
}

test('a plan revision and its pinned artifacts are admitted in one transaction; the plan is a root across reopen', async t => {
  const { dir, ledger } = await ledgerAt(t);
  const boot = ledger.admitPlan(stagePlan(ledger, 'a', 1, 'bootstrap', null));
  assert.deepEqual({ ...boot, sequence: 0, admittedAt: '' }, { runId: 'run-a', revision: 1, kind: 'bootstrap', digest: sha('a digest 1'), previous: null,
    plan: sha('a plan 1'), ruleLock: null, policy: null, profile: sha('a profile'), snapshotId: null, sequence: 0, admittedAt: '' });
  admitSnapshot(ledger, 'snap-a');
  const analysis = ledger.admitPlan(stagePlan(ledger, 'a', 2, 'analysis', sha('a digest 1'), 'snap-a'));
  assert.deepEqual(ledger.latestPlan('run-a'), analysis);
  const gc = ledger.gcSnapshot();
  assert.deepEqual(gc.staged, [], 'every stage was released');
  for (const p of [boot.plan, analysis.plan]) assert.ok(gc.referenced.includes(p), 'each plan is a root');
  for (const c of [analysis.ruleLock!, analysis.policy!, analysis.profile]) assert.ok(gc.links.some(([p, ch]) => p === analysis.plan && ch === c), 'pins reachable from the plan');
  const events = ledger.readEvents({ after: 0, limit: 500 }).events.filter(e => e.kind === 'plan-admitted').map(e => e.payload);
  assert.deepEqual(events, [{ runId: 'run-a', revision: 1, digest: sha('a digest 1') }, { runId: 'run-a', revision: 2, digest: sha('a digest 2') }]);
  ledger.close();
  const again = await openLedger(new FakeOwner(dir, `epoch-plan-${++epochs}`), { objects: OBJECTS });
  t.after(() => again.close());
  assert.deepEqual(again.getPlan('run-a', 2), analysis, 'the record survives reopen');
  assert.ok(again.gcSnapshot().referenced.includes(analysis.plan));
  assert.deepEqual(again.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('plan admission refuses a broken chain, a missing snapshot, wrong pins, unreachable or unstaged records, and a reused revision', async t => {
  const { ledger } = await ledgerAt(t);
  const before = () => ledger.currentSequence();
  // Revision 2 without revision 1, and revision 1 naming a predecessor.
  assert.throws(() => ledger.admitPlan(stagePlan(ledger, 'b', 2, 'bootstrap', sha('nothing'))), code('sentinel.store.conflict'), 'no revision 1 to follow');
  assert.throws(() => ledger.admitPlan({ ...stagePlan(ledger, 'c', 1, 'bootstrap', null), previous: sha('x') }), code('sentinel.store.invalidInput'));
  ledger.admitPlan(stagePlan(ledger, 'd', 1, 'bootstrap', null));
  admitSnapshot(ledger, 'snap-d');
  let n = before();
  assert.throws(() => ledger.admitPlan(stagePlan(ledger, 'd', 2, 'analysis', sha('not the digest'), 'snap-d')), code('sentinel.store.conflict'));
  assert.equal(ledger.getPlan('run-d', 2), undefined);
  assert.ok(before() > n, 'only the staging was recorded');
  n = before();
  assert.throws(() => ledger.admitPlan({ ...stagePlan(ledger, 'e', 1, 'bootstrap', null), runId: 'run-d', stageIds: ['e.plan-1'] }), code('sentinel.store.conflict'), 'a reused revision');
  // An analysis plan must pin a snapshot that was admitted, and a lock and a policy; a bootstrap plan none of them.
  ledger.admitPlan(stagePlan(ledger, 'f', 1, 'bootstrap', null));
  assert.throws(() => ledger.admitPlan(stagePlan(ledger, 'f', 2, 'analysis', sha('f digest 1'), 'snap-unknown')), code('sentinel.store.notFound'));
  assert.throws(() => ledger.admitPlan({ ...stagePlan(ledger, 'g', 1, 'bootstrap', null), policy: sha('g policy') }), code('sentinel.store.invalidInput'));
  // An extra staged record nothing links to, and a pinned record that was not staged.
  const extra = stagePlan(ledger, 'h', 1, 'bootstrap', null);
  ledger.registerStaging('h.extra', [{ id: sha('h orphan'), schema: 'text/plain', privacy: 'metadata' }]);
  assert.throws(() => ledger.admitPlan({ ...extra, stageIds: [...extra.stageIds, 'h.extra'], receipts: [...extra.receipts, identityReceipt('h orphan')] }), code('sentinel.store.stagingMismatch'));
  assert.throws(() => ledger.admitPlan({ ...extra, profile: sha('h other profile') }), code('sentinel.store.stagingMismatch'));
  assert.equal(ledger.getPlan('run-h', 1), undefined, 'nothing committed');
  assert.ok(ledger.gcSnapshot().staged.includes(extra.plan), 'its stage stays pinned');
  ledger.admitPlan(extra);
  // Admitted rows are immutable.
  assert.deepEqual(ledger.checkIntegrity(), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('a run advances one admitted plan revision at a time, and takes work only from an admitted revision', async t => {
  const { ledger } = await ledgerAt(t);
  const e = ledger.epoch;
  ledger.admitPlan(stagePlan(ledger, 'run', 1, 'bootstrap', null));
  admitSnapshot(ledger, 'snap-1');
  ledger.createRun(runEnvelope(e, { id: 'run-run', snapshotId: 'snap-1', planRevision: 1 }) as never);
  assert.equal(ledger.getRun('run-run')!.planRevision, 1);
  assert.throws(() => ledger.createWork(workEnvelope(e, { id: 'work-x', runId: 'run-run', planRevision: 2 }) as never), code('sentinel.store.wrongState'), 'revision 2 is not admitted');
  assert.throws(() => ledger.advanceRunPlan('run-run', 2), code('sentinel.store.notFound'));
  ledger.admitPlan(stagePlan(ledger, 'run', 2, 'analysis', sha('run digest 1'), 'snap-1'));
  assert.throws(() => ledger.createWork(workEnvelope(e, { id: 'work-x', runId: 'run-run', planRevision: 2 }) as never), code('sentinel.store.wrongState'), 'not the run\'s revision yet');
  ledger.createWork(workEnvelope(e, { id: 'work-boot', runId: 'run-run', planRevision: 1 }) as never);
  assert.throws(() => ledger.advanceRunPlan('run-run', 3), code('sentinel.store.conflict'));
  ledger.advanceRunPlan('run-run', 2);
  const run = ledger.getRun('run-run')!;
  assert.equal(run.planRevision, 2);
  assert.equal(run.envelope.planRevision, 1, 'the creation envelope stays as recorded');
  ledger.createWork(workEnvelope(e, { id: 'work-x', runId: 'run-run', planRevision: 2 }) as never);
  assert.throws(() => ledger.advanceRunPlan('run-run', 2), code('sentinel.store.conflict'), 'never twice');
  assert.equal(ledger.readEvents({ after: 0, limit: 500 }).events.filter(x => x.kind === 'run-plan-advanced').length, 1);
});

test('an attempt\'s invocation record is accepted with its start, so a failed attempt still names a durable record', async t => {
  const { ledger } = await ledgerAt(t);
  const e = ledger.epoch;
  ledger.createRun(runEnvelope(e) as never);
  ledger.createWork(workEnvelope(e) as never);
  const W = { id: 'work-pattern-api', revision: 1 };
  const invocation = 'invocation record', binding = 'execution binding';
  ledger.registerStaging('att.records', [{ id: sha(invocation), schema: 'sentinel-invocation/draft-1', privacy: 'metadata', links: [sha(binding)] },
    { id: sha(binding), schema: 'sentinel-execution-binding/draft-1', privacy: 'metadata' }]);
  const records = { stageId: 'att.records', receipts: [invocation, binding].map(identityReceipt) };
  const attempt = attemptEnvelope(e, { id: 'att-1', ordinal: 1, work: W, invocation: sha(invocation) });
  assert.throws(() => ledger.startAttempt({ ...attempt, invocation: sha('other') } as never, { records }), code('sentinel.store.invalidInput'));
  ledger.startAttempt(attempt as never, { records });
  ledger.endAttempt({ work: W, attemptId: 'att-1', state: 'failed', endedAt: '2026-10-21T12:01:00Z', workState: 'failed', error: { code: 'sentinel.execution.workerExited', retryable: false } });
  const gc = ledger.gcSnapshot();
  assert.deepEqual(gc.staged, []);
  assert.ok(gc.retained.includes(sha(invocation)), 'the failed attempt keeps its invocation record');
  assert.ok(gc.links.some(([p, c]) => p === sha(invocation) && c === sha(binding)), 'and the binding it links');
  assert.ok(ledger.objectsOf(sha(binding)).length === 1, 'both are accepted artifacts');
});
