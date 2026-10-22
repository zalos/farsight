// PR 21/22 as a consumer meets it: the bundled `farsight-sentinel` tarball (scripts/pack-sentinel.mjs) installed in a
// clean folder, its third-party dependencies linked from the workspace (nothing fetched), type-checked strictly and
// run through its published subpaths only: binding from adopted settings, an envelope, the in-process operation over
// a local mock model, a SIGKILL mid-call, recovery under a new epoch, and the owner helpers' admitted reconciliation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsStore } from './snapshot-helpers.ts';
import { json, mockEndpoint, ollamaReply, scratchDir } from './provider-helpers.ts';

const pkgDir = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

const CONSUMER = `
import { BudgetLedger, ModelBroker, bindProvider, reconcileIntent, reconcileReservation, inspectEnvelopes, type ProviderBinding } from 'farsight-sentinel/review/providers';
import { createModelReviewOperation, guidedSpec, planReviewWork, recoverModelWork, type ModelOperationOutcome } from 'farsight-sentinel/review';
import { effectivePolicy, admit, ReceiptBook, DEFAULT_SETTINGS } from 'farsight-sentinel/policy';
import type { SettingsEnvelope } from 'farsight-sentinel/contracts';
import { createHash } from 'node:crypto';
const [mode, origin, ledgerPath, receipts] = process.argv.slice(2) as [string, string, string, string];
const sha = (b: Uint8Array | string) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const NOW = new Date('2026-10-22T12:00:00.000Z');
const limits = { maxRequestBytes: 65536, maxResponseBytes: 65536, timeoutMs: 5000, maxOutputTokens: 64, contextTokens: 16384, maxMessages: 16, templateTokensPerMessage: 8 };
const settings: SettingsEnvelope = { ...structuredClone(DEFAULT_SETTINGS), grants: [{ actions: ['paid.admit'], principals: ['human'], confirm: 'never', scope: { providers: ['local-review'] } }],
  providers: [{ id: 'local-review', kind: 'ollama', endpoint: origin, credential: null, disclosure: 'local-only', budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
    models: [{ id: 'review', model: 'review-model:1', limits, pricing: { kind: 'no-fee', basis: 'local-runtime' }, terms: null,
      capability: { schema: 'sentinel-model-capability/draft-1', kind: 'ollama', origin, model: 'review-model:1', listed: true, revision: null, probedAt: '2026-10-22T11:00:00.000000000Z' } }] }] };
const policy = effectivePolicy({ trust: 'adopted', settings, settingsDigest: sha('settings'), repoConfig: null, repoConfigDigest: null });
const binding: ProviderBinding = bindProvider(policy, 'local-review', 'review');
const epoch = mode === 'first' ? 'epoch-a' : 'epoch-b';
const ledger = await BudgetLedger.open(ledgerPath);
const broker = new ModelBroker({ ledger, credentials: async () => { throw new Error('none'); }, epoch, now: () => NOW });
const envelope = await broker.openEnvelope({ binding, policy, runId: 'run-1', budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' }, requestedBy: { principal: 'human', channel: 'owner-cli' }, stateDigest: sha(epoch) });
const src = Buffer.from("import { db } from './db';\\nexport const q = (r) => db.query('SELECT ' + r.query.name);\\n");
const file = { relativePath: 'src/query.ts', content: sha(src), bytes: src.byteLength };
const spec = guidedSpec({ runId: 'run-1', attemptId: mode === 'first' ? 'att-1' : 'att-2', snapshotId: 'snap-1', sourceId: 'web',
  limits: { maxSliceLines: 100, maxSliceBytes: 65536, maxToolCalls: 10, maxServedBytes: 262144 }, budget: { maxSteps: 6, maxInvalidReplies: 1, maxInputBytes: 1048576, maxOutputTokens: 64, deadlineMs: 60000 },
  check: { checkId: 'chk-1', familyId: 'sentinel.sql.dynamic-query', revisionDigest: sha('rule'), ruleText: 'Untrusted text concatenated into SQL.', files: [file] } });
const [unit] = planReviewWork({ runId: 'run-1', planRevision: 2, coordinatorEpoch: epoch, createdAt: '2026-10-22T12:00:00Z', dependencies: [],
  resources: { deadlineMs: 120000, memoryBytes: 268435456, cpuQuota: 1, maxPids: 1, maxOutputBytes: 4194304 }, specs: [spec] });
const op = createModelReviewOperation({ broker, ledger, envelope, binding: () => bindProvider(policy, 'local-review', 'review'), now: () => NOW });
if (mode === 'first') { process.stdout.write('started\\n'); await op.run({ work: unit!.work, spec: unit!.spec, attemptId: 'att-1', epoch, read: async () => src }); }
else {
  const recovered = recoverModelWork(ledger, ['epoch-a'], NOW);
  const out: ModelOperationOutcome = await op.run({ work: unit!.work, spec: unit!.spec, attemptId: 'att-2', epoch, read: async () => src });
  const open = inspectEnvelopes(ledger, { runId: 'run-1' }).flatMap(e => e.open);
  const uncertain = open.find(r => r.state === 'uncertain')!;
  const usage = { inputTokens: 90, outputTokens: 4, cost: '0' };
  const { intent, stateDigest } = reconcileIntent(ledger, uncertain.id, usage);
  void new ReceiptBook(receipts);
  const admission = admit({ intent, requestedBy: { principal: 'human', channel: 'owner-cli' }, policy, capability: () => ({ available: true, detail: 'stub' }),
    credential: () => ({ basis: 'local-only', detail: 'loopback' }), stateDigest, now: NOW }).record;
  let refused = '';
  try { reconcileReservation(ledger, admission, uncertain.id, usage, NOW); } catch (e) { refused = (e as { code: string }).code; }
  process.stdout.write(JSON.stringify({ recovered, outcome: (out.records[0]!.value as { outcome: string }).outcome, usage: out.usage.certainty, coverage: out.coverage.length,
    uncertain: uncertain.state, refused, envelopes: inspectEnvelopes(ledger, {}).length }));
}
ledger.close();
`;

test('installed tarball: owner-bound binding, the in-process operation, SIGKILL recovery and receipt-gated reconciliation through public subpaths', needsStore, async t => {
  const dir = scratchDir(t, 'sentinel-review-consumer-');
  run(process.execPath, [join(repo, 'scripts/pack-sentinel.mjs')], repo);
  const tgz = join(repo, 'build/sentinel', readdirSync(join(repo, 'build/sentinel')).find(f => f.endsWith('.tgz'))!);
  const app = join(dir, 'consumer');
  const installed = join(app, 'node_modules/farsight-sentinel');
  mkdirSync(installed, { recursive: true });
  run('tar', ['-xzf', tgz, '-C', installed, '--strip-components=1'], dir);
  const shipped = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  for (const sub of ['./review', './review/providers', './policy', './contracts']) assert.ok(shipped.exports[sub], sub);
  assert.ok(readdirSync(join(installed, 'schemas')).includes('sentinel-review-record.draft-1.schema.json'));
  for (const dep of Object.keys(shipped.dependencies ?? {})) {
    const target = join(app, 'node_modules', dep);
    mkdirSync(join(target, '..'), { recursive: true });
    const from = [join(pkgDir, 'node_modules', dep), join(repo, 'node_modules', dep), join(repo, 'packages/code-parser/node_modules', dep)].find(p => existsSync(p));
    assert.ok(from, `dependency ${dep} is in the workspace`);
    symlinkSync(realpathSync(from!), target);
  }
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  writeFileSync(join(app, 'consumer.ts'), CONSUMER);
  mkdirSync(join(app, 'node_modules/@types'), { recursive: true });
  if (!existsSync(join(app, 'node_modules/@types/node'))) symlinkSync(realpathSync(join(pkgDir, 'node_modules/@types/node')), join(app, 'node_modules/@types/node'));
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
    types: ['node'], skipLibCheck: false }, include: ['consumer.ts'] }));
  run(process.execPath, [realpathSync(join(repo, 'node_modules/typescript/bin/tsc')), '-p', 'tsconfig.json'], app);

  let n = 0;
  const ep = await mockEndpoint(t, (req, res) => {
    n++;
    if (n === 2) return; // the second call never answers: the first process is killed waiting for it
    const msgs = JSON.parse(req.body).messages;
    const last = JSON.parse(msgs[msgs.length - 1].content);
    json(res, 200, ollamaReply({ message: { role: 'assistant', content: last.evidence
      ? JSON.stringify({ action: 'final', verdict: 'finding', inspected: ['src/query.ts'], claims: [{ statement: 'Request text reaches SQL.', citations: [last.evidence[0].id] }] })
      : JSON.stringify({ action: 'read', path: 'src/query.ts', startLine: 1, endLine: 2 }) } }));
  });
  const ledgerPath = join(dir, 'models.db');
  const args = ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'consumer.ts'];
  const first = spawn(process.execPath, [...args, 'first', ep.origin, ledgerPath, join(dir, 'receipts')], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  first.stderr.on('data', d => { err += d; });
  const until = Date.now() + 30_000;
  while (ep.seen.length < 2) {
    if (Date.now() > until || first.exitCode !== null) throw new Error(`the first process never reached its second call: ${err}`);
    await new Promise(r => setTimeout(r, 25));
  }
  first.kill('SIGKILL');
  await new Promise(r => first.once('exit', r));
  const out = JSON.parse(run(process.execPath, [...args, 'second', ep.origin, ledgerPath, join(dir, 'receipts')], app));
  assert.deepEqual(out, { recovered: { released: 0, uncertain: 1 }, outcome: 'unfinished', usage: 'unknown', coverage: 0, uncertain: 'uncertain',
    refused: 'sentinel.provider.receiptRequired', envelopes: 1 });
  assert.equal(ep.seen.length, 2, 'the uncertain call was never sent again');
});
