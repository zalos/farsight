// PR 21/22 integration: the agentic review stage, the trusted in-process operation over the real broker and model
// ledger, crash recovery with a real SIGKILL, epoch fencing, and the owner command helpers as the canonical CLI calls
// them (admit, then the helper). Local mock endpoints only; the one real local-Ollama probe is opt-in
// (FARSIGHT_LIVE_OLLAMA=1) and lists models without generating anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { admit, ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { validateEnvelope } from '../dist/index.js';
import {
  planReviewWork,
  isReviewWork,
  assertAgenticOnly,
  createModelReviewOperation,
  recoverModelWork,
  LedgerCheckpointStore,
  guidedSpec,
  runSession,
} from '../dist/review/index.js';
import {
  BudgetLedger,
  ModelBroker,
  bindProvider,
  probeIntent,
  probeModel,
  reconcileIntent,
  reconcileReservation,
  inspectEnvelopes,
  probeConfigured,
} from '../dist/review/providers/index.js';
import { needsStore } from './snapshot-helpers.ts';
import { D, NOW, json, mockEndpoint, ollamaReply, scratchDir, trustedPolicy } from './provider-helpers.ts';

const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const HUMAN = { principal: 'human' as const, channel: 'owner-cli' as const };
const SRC = "import { db } from './db';\nexport const q = (r) => db.query('SELECT ' + r.query.name);\n";
const bytes = Buffer.from(SRC);
const FILE = { relativePath: 'src/query.ts', content: sha(bytes), bytes: bytes.byteLength };
const read = async (id: string) => {
  if (id !== FILE.content) throw new Error('unknown content');
  return bytes;
};
const LIMITS = { maxSliceLines: 200, maxSliceBytes: 65536, maxToolCalls: 20, maxServedBytes: 262144 };
const BUDGET = {
  maxSteps: 8,
  maxInvalidReplies: 1,
  maxInputBytes: 4 * 1024 * 1024,
  maxOutputTokens: 64,
  deadlineMs: 60_000,
};
const RESOURCES = { deadlineMs: 120_000, memoryBytes: 268_435_456, cpuQuota: 1, maxPids: 1, maxOutputBytes: 4_194_304 };
const spec = (attemptId: string) =>
  guidedSpec({
    runId: 'run-1',
    attemptId,
    snapshotId: 'snap-1',
    sourceId: 'web',
    limits: LIMITS,
    budget: BUDGET,
    check: {
      checkId: 'chk-1',
      familyId: 'sentinel.sql.dynamic-query',
      revisionDigest: sha('rule'),
      ruleText: 'Untrusted text concatenated into SQL.',
      files: [FILE],
    },
  });

/** A mock Ollama that reads once, then concludes with a cited finding; `hangOn` leaves that call unanswered. */
const reviewer = (hangOn?: number) => {
  let n = 0;
  return (req: { body: string }, res: any) => {
    n++;
    if (n === hangOn) return;
    const msgs = JSON.parse(req.body).messages;
    const last = JSON.parse(msgs[msgs.length - 1].content);
    const content = last.evidence
      ? JSON.stringify({
          action: 'final',
          verdict: 'finding',
          inspected: ['src/query.ts'],
          claims: [{ statement: 'Request text reaches SQL.', citations: [last.evidence[0].id] }],
        })
      : JSON.stringify({ action: 'read', path: 'src/query.ts', startLine: 1, endLine: 2 });
    json(res, 200, ollamaReply({ message: { role: 'assistant', content } }));
  };
};

async function rig(t: any, origin: string, ledgerPath: string, epoch: string) {
  const policy = trustedPolicy({ ollama: origin });
  const binding = bindProvider(policy, 'local-review', 'review');
  const ledger = await BudgetLedger.open(ledgerPath);
  t.after(() => ledger.close());
  const broker = new ModelBroker({
    ledger,
    credentials: async () => {
      throw new Error('no credential');
    },
    epoch,
    now: () => NOW,
  });
  const envelope = await broker.openEnvelope({
    binding,
    policy,
    runId: 'run-1',
    budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
    requestedBy: HUMAN,
    stateDigest: D(`plan-${epoch}`),
  });
  return { policy, binding, ledger, broker, envelope };
}

test('the agentic stage plans its own work units, covers no check, and refuses coverage attributed to it', () => {
  const units = planReviewWork({
    runId: 'run-1',
    planRevision: 2,
    coordinatorEpoch: 'epoch-a',
    createdAt: '2026-10-22T12:00:00Z',
    dependencies: [{ id: 'work-parse', revision: 1 }],
    resources: RESOURCES,
    specs: [spec('att-1')],
  });
  assert.equal(units.length, 1);
  const w = units[0]!.work;
  assert.ok(validateEnvelope('work', w).ok);
  assert.deepEqual(
    [w.stage.kind, w.stage.contract, w.state, isReviewWork(w)],
    ['agentic', 'sentinel.stage.review.guided', 'pending', true],
  );
  assert.ok(!('checks' in w), 'a review unit carries no checks to cover');
  assert.throws(
    () => assertAgenticOnly([w], [{ workId: w.id }]),
    (e: any) => e.code === 'sentinel.review.integrity',
  );
  assertAgenticOnly([w], [{ workId: 'work-pattern-scan' }]);
  assert.throws(
    () =>
      planReviewWork({
        runId: 'run-1',
        planRevision: 2,
        coordinatorEpoch: 'epoch-a',
        createdAt: '2026-10-22T12:00:00Z',
        dependencies: [],
        resources: RESOURCES,
        specs: [spec('att-1'), spec('att-2')],
      }),
    (e: any) => e.code === 'sentinel.review.invalidInput',
    'one session is one unit, whatever the attempt',
  );
});

test(
  'the in-process operation publishes a record and observations, no coverage, and the ledger’s usage',
  needsStore,
  async (t) => {
    const ep = await mockEndpoint(t, reviewer());
    const r = await rig(t, ep.origin, join(scratchDir(t), 'models.db'), 'epoch-a');
    const [unit] = planReviewWork({
      runId: 'run-1',
      planRevision: 2,
      coordinatorEpoch: 'epoch-a',
      createdAt: '2026-10-22T12:00:00Z',
      dependencies: [],
      resources: RESOURCES,
      specs: [spec('att-1')],
    });
    const op = createModelReviewOperation({
      broker: r.broker,
      ledger: r.ledger,
      envelope: r.envelope,
      binding: () => bindProvider(r.policy, 'local-review', 'review'),
      now: () => NOW,
    });
    const out = await op.run({ work: unit!.work, spec: unit!.spec, attemptId: 'att-1', epoch: 'epoch-a', read });
    assert.deepEqual(out.coverage, []);
    assert.deepEqual(
      out.records.map((x) => x.schema),
      ['sentinel-review-record/draft-1', 'sentinel-observation/draft-1'],
    );
    assert.ok(
      validateEnvelope('review', out.records[0]!.value).ok && validateEnvelope('observation', out.records[1]!.value).ok,
    );
    assert.deepEqual(out.usage, {
      certainty: 'confirmed',
      inputTokens: 80,
      outputTokens: 6,
      monetaryCost: '0',
      currency: 'USD',
    });
    assert.equal(
      r.ledger.loadCheckpoint(unit!.spec.sessionId)!.epoch,
      'epoch-a',
      'checkpoints live in the model ledger under the epoch',
    );
    await assert.rejects(
      op.run({
        work: { ...unit!.work, stage: { ...unit!.work.stage, kind: 'coded' } },
        spec: unit!.spec,
        attemptId: 'att-1',
        epoch: 'epoch-a',
        read,
      }),
      (e: any) => e.code === 'sentinel.review.invalidInput',
    );
  },
);

test(
  'SIGKILL mid-call: recovery fences the epoch, the sent call stays charged as uncertain, and the resumed session never re-sends it',
  needsStore,
  async (t) => {
    const ep = await mockEndpoint(t, reviewer(2));
    const dir = scratchDir(t);
    const ledgerPath = join(dir, 'models.db');
    // A coordinator process under epoch-a runs the unit and is killed while its second call is in flight.
    const lib = (p: string) => new URL(`../dist/${p}`, import.meta.url).href;
    const helpers = new URL('./provider-helpers.ts', import.meta.url).href;
    const child = `
    const { BudgetLedger, ModelBroker, bindProvider } = await import(${JSON.stringify(lib('review/providers/index.js'))});
    const { createModelReviewOperation, planReviewWork, guidedSpec } = await import(${JSON.stringify(lib('review/index.js'))});
    const { trustedPolicy, D, NOW } = await import(${JSON.stringify(helpers)});
    const policy = trustedPolicy({ ollama: ${JSON.stringify(ep.origin)} });
    const binding = bindProvider(policy, 'local-review', 'review');
    const ledger = await BudgetLedger.open(${JSON.stringify(ledgerPath)});
    const broker = new ModelBroker({ ledger, credentials: async () => { throw new Error('none'); }, epoch: 'epoch-a', now: () => NOW });
    const envelope = await broker.openEnvelope({ binding, policy, runId: 'run-1', budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' }, requestedBy: { principal: 'human', channel: 'owner-cli' }, stateDigest: D('plan-a') });
    const spec = guidedSpec(${JSON.stringify({
      runId: 'run-1',
      attemptId: 'att-1',
      snapshotId: 'snap-1',
      sourceId: 'web',
      limits: LIMITS,
      budget: BUDGET,
      check: {
        checkId: 'chk-1',
        familyId: 'sentinel.sql.dynamic-query',
        revisionDigest: sha('rule'),
        ruleText: 'Untrusted text concatenated into SQL.',
        files: [FILE],
      },
    })});
    const [unit] = planReviewWork({ runId: 'run-1', planRevision: 2, coordinatorEpoch: 'epoch-a', createdAt: '2026-10-22T12:00:00Z', dependencies: [], resources: ${JSON.stringify(RESOURCES)}, specs: [spec] });
    const op = createModelReviewOperation({ broker, ledger, envelope, binding: () => bindProvider(policy, 'local-review', 'review'), now: () => NOW });
    const bytes = Buffer.from(${JSON.stringify(SRC)});
    process.stdout.write('started\\n');
    await op.run({ work: unit.work, spec: unit.spec, attemptId: 'att-1', epoch: 'epoch-a', read: async () => bytes });`;
    const p = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', child],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
    });
    const deadline = Date.now() + 20_000;
    while (ep.seen.length < 2) {
      if (Date.now() > deadline || p.exitCode !== null)
        throw new Error(`the child never reached its second call: ${err}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));

    // The new coordinator, epoch-b, recovers.
    const r = await rig(t, ep.origin, ledgerPath, 'epoch-b');
    const sessionId = spec('att-2').sessionId;
    assert.equal(
      r.ledger.loadCheckpoint(sessionId)!.epoch,
      'epoch-a',
      'the checkpoint after the first settled call survived',
    );
    const before = r.ledger.listEnvelopes({ limit: 10 }).find((e) => e.totals.byState.dispatched === 1)!;
    assert.ok(before, 'the killed call is dispatched in the ledger');
    assert.deepEqual(recoverModelWork(r.ledger, ['epoch-a'], NOW), { released: 0, uncertain: 1 });
    assert.equal(r.ledger.isFenced('epoch-a'), true);
    // The fenced process can neither checkpoint nor reserve any more.
    assert.throws(
      () => r.ledger.saveCheckpoint(sessionId, 'epoch-a', '{}', '2026-10-22T12:00:00Z'),
      (e: any) => e.code === 'sentinel.provider.epochFenced',
    );
    assert.throws(
      () =>
        r.ledger.reserve({
          envelopeId: before.id,
          operationId: 'late',
          tokens: 1,
          costNanos: 0n,
          epoch: 'epoch-a',
          at: '2026-10-22T12:00:00Z',
        }),
      (e: any) => e.code === 'sentinel.provider.epochFenced',
    );
    // The new attempt resumes the same session, under a new envelope: the uncertain operation is not sent again.
    const [unit] = planReviewWork({
      runId: 'run-1',
      planRevision: 2,
      coordinatorEpoch: 'epoch-b',
      createdAt: '2026-10-22T12:00:00Z',
      dependencies: [],
      resources: RESOURCES,
      specs: [spec('att-2')],
    });
    const op = createModelReviewOperation({
      broker: r.broker,
      ledger: r.ledger,
      envelope: r.envelope,
      binding: () => bindProvider(r.policy, 'local-review', 'review'),
      now: () => NOW,
    });
    const out = await op.run({ work: unit!.work, spec: unit!.spec, attemptId: 'att-2', epoch: 'epoch-b', read });
    assert.equal(ep.seen.length, 2, 'no request was sent after the crash');
    const record = out.records[0]!.value as any;
    assert.equal(record.outcome, 'unfinished');
    assert.ok(record.frontiers.some((f: any) => f.reasonCode === 'sentinel.review.frontier.uncertainUsage'));
    assert.equal(out.usage.certainty, 'unknown');
    assert.equal(r.ledger.loadCheckpoint(sessionId)!.epoch, 'epoch-b', 'the session was handed over');
    const totals = r.ledger.listEnvelopes({ limit: 10 }).find((e) => e.id === before.id)!.totals;
    assert.equal(totals.byState.uncertain, 1, 'the killed call stays charged until the owner reconciles it');
  },
);

test(
  'owner helpers decide their own intent; the only authority is the owner\u2019s receipt, spent once; inspection is a bounded read',
  needsStore,
  async (t) => {
    const ep = await mockEndpoint(t, (req, res) =>
      req.path === '/api/tags'
        ? json(res, 200, { models: [{ name: 'review-model:1', model: 'review-model:1', digest: 'd'.repeat(64) }] })
        : undefined,
    );
    const dir = scratchDir(t);
    const r = await rig(t, ep.origin, join(dir, 'models.db'), 'epoch-a');
    const book = new ReceiptBook(join(dir, 'receipts'));
    const issue = (intent: any, stateDigest: string) => ({
      book,
      id: issueReceipt(
        book,
        { channel: 'owner-cli', principal: 'owner' },
        { intent, stateDigest, policyRevision: r.policy.revision },
        { now: NOW, ttlMs: 600_000 },
      ).id,
    });
    // The CLI's preview: admit without a receipt says awaiting confirmation (exit 4).
    const p = probeIntent(r.policy, 'local-review', 'review');
    assert.deepEqual([p.intent.action, p.intent.effects], ['tool.acquire', ['network']]);
    const preview = admit({
      intent: p.intent,
      requestedBy: HUMAN,
      policy: r.policy,
      capability: () => ({ available: true, detail: 'stub' }),
      credential: () => ({ basis: 'local-only', detail: 'x' }),
      stateDigest: p.stateDigest,
      now: NOW,
    });
    assert.equal(preview.record.outcome, 'awaiting-confirmation');
    // No receipt, a forged admission-shaped object, or an agent channel: nothing runs.
    await assert.rejects(
      probeModel(r.policy, 'local-review', 'review', { requestedBy: HUMAN }, { credentials: async () => '', now: NOW }),
      (e: any) => e.code === 'sentinel.provider.receiptRequired',
    );
    await assert.rejects(
      probeModel(
        r.policy,
        'local-review',
        'review',
        { requestedBy: HUMAN, receipt: { book, id: 'receipt-forged' } } as any,
        { credentials: async () => '', now: NOW },
      ),
      (e: any) => /receipt/i.test(e.code ?? e.message),
    );
    await assert.rejects(
      probeModel(
        r.policy,
        'local-review',
        'review',
        { requestedBy: { principal: 'agent', channel: 'mcp' }, receipt: issue(p.intent, p.stateDigest) },
        { credentials: async () => '', now: NOW },
      ),
      (e: any) => e.code === 'sentinel.provider.notAdmitted',
    );
    assert.equal(ep.seen.length, 0);
    const rc = issue(p.intent, p.stateDigest);
    const probed = await probeModel(
      r.policy,
      'local-review',
      'review',
      { requestedBy: HUMAN, receipt: rc },
      { credentials: async () => '', now: NOW },
    );
    assert.deepEqual(
      [probed.settingsPatch.path, probed.capability.revision],
      ['/providers/0/models/0/capability', `sha256:${'d'.repeat(64)}`],
    );
    await assert.rejects(
      probeModel(
        r.policy,
        'local-review',
        'review',
        { requestedBy: HUMAN, receipt: rc },
        { credentials: async () => '', now: NOW },
      ),
      (e: any) => /already used/.test(e.message),
      'spent once',
    );

    // An uncertain reservation, reconciled under the owner's receipt. These grants admit paid.admit without asking:
    // the receipt is still required and spent exactly once by the helper.
    const res = r.ledger.dispatch(
      r.ledger.reserve({
        envelopeId: r.envelope.id,
        operationId: 'op-u',
        tokens: 300,
        costNanos: 0n,
        epoch: 'epoch-a',
        at: '2026-10-22T12:00:00Z',
      }).id,
      '2026-10-22T12:00:00Z',
    );
    r.ledger.markUncertain(res.id, '2026-10-22T12:00:00Z', 'timeout');
    const usage = { inputTokens: 120, outputTokens: 10, cost: '0' };
    const ri = reconcileIntent(r.ledger, res.id, usage);
    assert.throws(
      () => reconcileReservation(r.ledger, r.policy, res.id, usage, { requestedBy: HUMAN }, NOW),
      (e: any) => e.code === 'sentinel.provider.receiptRequired',
    );
    const other = reconcileIntent(r.ledger, res.id, { ...usage, inputTokens: 1 });
    assert.throws(
      () =>
        reconcileReservation(
          r.ledger,
          r.policy,
          res.id,
          usage,
          { requestedBy: HUMAN, receipt: issue(other.intent, other.stateDigest) },
          NOW,
        ),
      (e: any) => /different action, input/.test(e.message),
      'a receipt for other usage',
    );
    const receipt = issue(ri.intent, ri.stateDigest);
    const settled = reconcileReservation(r.ledger, r.policy, res.id, usage, { requestedBy: HUMAN, receipt }, NOW);
    assert.equal(settled.state, 'settled');
    assert.match(settled.reconciledBy!, /^sha256:/);
    assert.throws(
      () => reconcileIntent(r.ledger, res.id, usage),
      (e: any) => e.code === 'sentinel.provider.reservationState',
      'a settled reservation is not reconciled twice',
    );

    const listed = inspectEnvelopes(r.ledger, { runId: 'run-1', limit: 500 });
    assert.equal(listed.length, 1);
    assert.deepEqual(
      [listed[0]!.providerId, listed[0]!.chargedTokens, listed[0]!.open.length],
      ['local-review', 130, 0],
    );
    assert.ok(JSON.stringify(listed).length < 4096);
  },
);

test('the ledger checkpoint store resumes only valid checkpoints of this session', needsStore, async (t) => {
  const ledger = await BudgetLedger.open(join(scratchDir(t), 'models.db'));
  t.after(() => ledger.close());
  const store = new LedgerCheckpointStore(ledger, 'epoch-a', () => NOW);
  const caller = {
    kind: 'mock' as const,
    async call() {
      return {
        content: JSON.stringify({ action: 'final', verdict: 'no-finding', claims: [], inspected: [] }),
        truncated: false,
        identity: {
          requestedModel: 'm',
          returnedModel: 'm',
          immutableRevision: null,
          source: 'self-reported' as const,
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const { record } = await runSession(spec('att-1'), { caller, checkpoints: store, read });
  assert.equal(record.outcome, 'completed');
  ledger.saveCheckpoint(
    spec('att-1').sessionId,
    'epoch-a',
    '{"schema":"sentinel-review-checkpoint/draft-1"}',
    '2026-10-22T12:00:00Z',
  );
  await assert.rejects(store.load(spec('att-1').sessionId), (e: any) => e.code === 'sentinel.review.checkpoint');
  assert.throws(
    () => ledger.saveCheckpoint('s', 'epoch-a', 'x'.repeat(5 * 1024 * 1024), '2026-10-22T12:00:00Z'),
    (e: any) => e.code === 'sentinel.provider.ledgerInvalid',
  );
  ledger.saveCheckpoint('shared', 'epoch-a', '{}', '2026-10-22T12:00:00Z');
  assert.throws(
    () => ledger.saveCheckpoint('shared', 'epoch-b', '{}', '2026-10-22T12:00:00Z'),
    (e: any) => e.code === 'sentinel.provider.epochFenced',
    'one live writer per session',
  );
});

test(
  'opt-in: a real probe of the local Ollama lists an installed model, with no generation',
  { skip: process.env.FARSIGHT_LIVE_OLLAMA === '1' ? false : 'set FARSIGHT_LIVE_OLLAMA=1 to probe a local Ollama' },
  async () => {
    const model = process.env.FARSIGHT_LIVE_OLLAMA_MODEL ?? 'qwen3:4b';
    const policy = trustedPolicy({
      ollama: 'http://127.0.0.1:11434',
      models: {
        'local-review': [
          {
            id: 'review',
            model,
            limits: {
              maxRequestBytes: 65536,
              maxResponseBytes: 1048576,
              timeoutMs: 5000,
              maxOutputTokens: 64,
              contextTokens: 4096,
              maxMessages: 8,
              templateTokensPerMessage: 16,
            },
            pricing: { kind: 'no-fee', basis: 'local-runtime' },
            terms: null,
            capability: null,
          },
        ],
      },
    });
    const rec = await probeConfigured(policy, 'local-review', 'review', {
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      now: new Date(),
    });
    assert.equal(rec.model, model);
    assert.match(String(rec.revision), /^sha256:[0-9a-f]{64}$/);
  },
);
