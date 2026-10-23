// A1 only: canonical retained document and one-format generation, before any service delivery/cache is installed.
// Every report starts with a genuine owner-admitted canonical plan and Coordinator publication of the shipped worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { withStoreReadBudget } from '../dist/store/read-budget.js';
import { fullReport, fullReportFormat, renderingOf, assessRun } from '../dist/service/full-report.js';
import { initWorkspace } from '../dist/cli/init.js';
import { workspaceOf, adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, scratchUnder, removeScratch } from '../dist/service/local.js';
import { planWorkspaceCanonical, executeRun, rerunRun } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { scratch, removeScratch as removeRoot } from './execution-helpers.ts';
const code = (c: string) => (e: any) => e?.code === c;
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
async function published(t: any) {
  const s = scratch('report-delivery'), path = join(s.root, 'workspace');
  mkdirSync(join(path, 'src'), { recursive: true });
  const file = join(path, 'src', 'lookup.ts');
  writeFileSync(file, 'export const lookup = (id: string) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(s.root, 'state') });
  initWorkspace({ workspace: path });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal(promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() }).outcome, 'prepared');
  const adopted = adoptedPolicy(ws); assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath), work = scratchUnder(ws);
  t.after(() => { store.close(); removeScratch(work); removeRoot(s.root); });
  const p = await planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
  assert.equal((await executeRun(store, p.disclosure.runId, { scratchRoot: work, trustDir: ws.trustDir })).state, 'completed');
  return { store, ws, work, policy: adopted.policy, file, request: { store, runId: p.disclosure.runId, workspace: path, trustDir: ws.trustDir, disclosure: 'shareable' as const, now: new Date() } };
}

test('genuine retained one-format deliveries equal all legacy renderings, identity and hashes after source removal', async t => {
  const f = await published(t), legacy = await fullReport(f.request);
  assert.equal(legacy.document.findings.length, 1);
  rmSync(join(f.ws.path, 'src'), { recursive: true });
  const before = f.store.ledger.currentSequence();
  const measurement: any[] = [];
  for (const format of ['json', 'md', 'html', 'sarif'] as const) {
    const one = await fullReportFormat(f.request, format);
    assert.deepEqual(one.document, legacy.document);
    assert.equal(one.text, renderingOf(legacy, format));
    assert.equal(one.documentDigest, sha(legacy.json));
    assert.equal(one.formatDigest, sha(one.text));
    assert.equal(one.formatBytes, Buffer.byteLength(one.text));
    assert.equal(one.currentIdentity.runId, f.request.runId);
    assert.equal(one.currentIdentity.planRevision, one.document.run.planRevision);
    assert.equal(one.currentIdentity.snapshotId, one.document.run.snapshotId);
    assert.equal(one.currentIdentity.ledgerSequence, one.document.ledgerSequence);
    assert.equal(one.baselineIdentity, undefined);
    assert.equal(one.readUsage.reads > 0, true);
    assert.ok(!('json' in one) && !('html' in one) && !('markdown' in one) && !('sarif' in one));
    assert.ok(Object.isFrozen(one));
    measurement.push({ format, bytes: one.formatBytes, ...one.readUsage });
  }
  assert.equal(f.store.ledger.currentSequence(), before, 'generation never writes to the held ledger');
  console.log(JSON.stringify({ measurement: 'genuine-shipped-preview-report-source-gone', formats: measurement }));
});

test('the comparison baseline identity comes from the same genuine assessment as its document', async t => {
  const f = await published(t);
  rmSync(join(f.ws.path, 'src'), { recursive: true });
  const child = await rerunRun(f.store, f.request.runId, [], { workspace: f.ws.path, trustDir: f.ws.trustDir, policy: f.policy, scratchRoot: f.work, now: new Date() });
  assert.ok(!('reasonCode' in child));
  assert.equal((await executeRun(f.store, child.disclosure.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir })).state, 'completed');
  const expected = await assessRun(f.store, f.request.runId, { trustDir: f.ws.trustDir });
  const request = { ...f.request, runId: child.disclosure.runId, baselineRunId: f.request.runId };
  const one = await fullReportFormat(request, 'json'), legacy = await fullReport(request);
  assert.deepEqual(one.document, legacy.document);
  assert.deepEqual(one.baselineIdentity, { runId: expected.runId, planRevision: expected.planRevision, snapshotId: expected.snapshot.id, ledgerSequence: expected.ledgerSequence });
  assert.deepEqual(legacy.baselineIdentity, one.baselineIdentity, 'legacy all-format result gains the same additive identity');
});

test('legacy evidence catches cannot convert byte/count exhaustion or cancellation into another report result', async t => {
  const f = await published(t);
  assert.equal((await fullReport(f.request)).document.findings.length, 1, 'unbudgeted legacy positive');
  for (const options of [{ reads: 0 }, { decodedBytes: 0 }, { encodedBytes: 0 }]) {
    await assert.rejects(fullReportFormat(f.request, 'json', options), code('sentinel.object.tooLarge'));
  }
  await assert.rejects(withStoreReadBudget(f.store, { reads: 0 }, () => fullReport(f.request)), code('sentinel.object.tooLarge'));
  const controller = new AbortController();
  const task = fullReportFormat(f.request, 'html', { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(task, code('sentinel.execution.canceled'));
});

test('the final identity/sequence fence refuses a genuine concurrent ledger change before returning bytes', async t => {
  const f = await published(t);
  const now = new Date();
  const normal = now.toISOString.bind(now);
  let changed = false;
  now.toISOString = () => {
    if (!changed) {
      changed = true;
      f.store.ledger.registerStaging('report-concurrent-change', [{ id: `sha256:${'0'.repeat(64)}`, schema: 'application/octet-stream', privacy: 'source' }]);
    }
    return normal();
  };
  await assert.rejects(fullReportFormat({ ...f.request, now }, 'html'), e => code('sentinel.report.evidenceUnbound')(e) && (e as any).facts.reason === 'the ledger changed during report generation');
  assert.equal(changed, true);
  f.store.ledger.abortStaging('report-concurrent-change');
});

test('a closed owner still refuses through the real report reader with its original typed error', async t => {
  const f = await published(t);
  const request = fullReportFormat(f.request, 'json');
  f.store.close();
  await assert.rejects(request, (e: any) => ['sentinel.store.closed', 'sentinel.store.ownerClosed'].includes(e.code));
});
