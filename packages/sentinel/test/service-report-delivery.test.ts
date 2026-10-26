// A1 only: canonical retained document and one-format generation, before any service delivery/cache is installed.
// Every report starts with a genuine owner-admitted canonical plan and Coordinator publication of the shipped worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { withStoreReadBudget } from '../dist/store/read-budget.js';
import { fullReport, fullReportFormat, renderingOf, assessRun } from '../dist/service/full-report.js';
import { initWorkspace } from '../dist/cli/init.js';
import { workspaceOf, adoptedPolicy, adoptWorkspaceSettings, promoteRulePack } from '../dist/service/local.js';
import { planWorkspaceCanonical, executeRun, rerunRun } from '../dist/service/canonical.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { scratch, removeScratch as removeRoot } from './execution-helpers.ts';
const code = (c: string) => (e: any) => e?.code === c;
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
async function published(t: any) {
  const s = scratch('report-delivery'),
    path = join(s.root, 'workspace');
  mkdirSync(join(path, 'src'), { recursive: true });
  const file = join(path, 'src', 'lookup.ts');
  writeFileSync(file, 'export const lookup = (id: string) => db.query("SELECT * FROM invoice WHERE id = " + id);\n');
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(s.root, 'state') });
  initWorkspace({ workspace: path });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal(
    promoteRulePack(ws, {
      packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
      confirm: true,
      now: new Date(),
    }).outcome,
    'prepared',
  );
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath),
    work = scratchUnder(store);
  t.after(() => {
    removeScratch(work);
    store.close();
    removeRoot(s.root);
  });
  const p = await planWorkspaceCanonical(store, {
    workspace: path,
    trustDir: ws.trustDir,
    policy: adopted.policy,
    scratchRoot: work,
    now: new Date(),
  });
  assert.equal(
    (await executeRun(store, p.disclosure.runId, { scratchRoot: work, trustDir: ws.trustDir })).state,
    'completed',
  );
  return {
    store,
    ws,
    work,
    policy: adopted.policy,
    file,
    request: {
      store,
      runId: p.disclosure.runId,
      workspace: path,
      trustDir: ws.trustDir,
      disclosure: 'shareable' as const,
      now: new Date(),
    },
  };
}

test('genuine retained one-format deliveries equal all legacy renderings, identity and hashes after source removal', async (t) => {
  const f = await published(t),
    legacy = await fullReport(f.request);
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

test('the comparison baseline identity comes from the same genuine assessment as its document', async (t) => {
  const f = await published(t);
  rmSync(join(f.ws.path, 'src'), { recursive: true });
  const child = await rerunRun(f.store, f.request.runId, [], {
    workspace: f.ws.path,
    trustDir: f.ws.trustDir,
    policy: f.policy,
    scratchRoot: f.work,
    now: new Date(),
  });
  assert.ok(!('reasonCode' in child));
  assert.equal(
    (await executeRun(f.store, child.disclosure.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir })).state,
    'completed',
  );
  const expected = await assessRun(f.store, f.request.runId, { trustDir: f.ws.trustDir });
  const request = { ...f.request, runId: child.disclosure.runId, baselineRunId: f.request.runId };
  const one = await fullReportFormat(request, 'json'),
    legacy = await fullReport(request);
  assert.deepEqual(one.document, legacy.document);
  assert.deepEqual(one.baselineIdentity, {
    runId: expected.runId,
    planRevision: expected.planRevision,
    snapshotId: expected.snapshot.id,
    ledgerSequence: expected.ledgerSequence,
  });
  assert.deepEqual(
    legacy.baselineIdentity,
    one.baselineIdentity,
    'legacy all-format result gains the same additive identity',
  );
});

test('legacy evidence catches cannot convert byte/count exhaustion or cancellation into another report result', async (t) => {
  const f = await published(t);
  assert.equal((await fullReport(f.request)).document.findings.length, 1, 'unbudgeted legacy positive');
  for (const options of [{ reads: 0 }, { decodedBytes: 0 }, { encodedBytes: 0 }]) {
    await assert.rejects(fullReportFormat(f.request, 'json', options), code('sentinel.object.tooLarge'));
  }
  await assert.rejects(
    withStoreReadBudget(f.store, { reads: 0 }, () => fullReport(f.request)),
    code('sentinel.object.tooLarge'),
  );
  const controller = new AbortController();
  const task = fullReportFormat(f.request, 'html', { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(task, code('sentinel.execution.canceled'));
});

test('a genuine unrelated Coordinator publication retries once and returns a coherent report', async (t) => {
  const f = await published(t);
  const child = await rerunRun(f.store, f.request.runId, [], {
    workspace: f.ws.path,
    trustDir: f.ws.trustDir,
    policy: f.policy,
    scratchRoot: f.work,
    now: new Date(),
  });
  assert.ok(!('reasonCode' in child));
  const stable = await fullReportFormat(f.request, 'json');
  const registry = publicRegistry(f.ws.trustDir);
  const assets = await scannerExecution(f.store, child.disclosure.runId, f.ws.trustDir, f.work, registry);
  let task: ReturnType<typeof fullReportFormat> | undefined, publication: any;
  let generations = 0;
  const now = new Date(f.request.now),
    normal = now.toISOString.bind(now);
  now.toISOString = () => {
    generations++;
    return normal();
  };
  const coordinator = await Coordinator.open({
    ...assets,
    store: f.store,
    runId: child.disclosure.runId,
    registry,
    scratchRoot: f.work,
    hooks: {
      at(boundary, context) {
        if (boundary === 'after-objects' && !task) {
          publication = context;
          task = fullReportFormat({ ...f.request, now }, 'json');
          void task.catch(() => undefined);
        }
      },
    },
  });
  assert.equal((await coordinator.run()).state, 'completed');
  assert.ok(task && publication);
  assert.ok(f.store.ledger.getPublication(publication.work), 'the unrelated worker really published');
  const report = await task;
  assert.equal(generations, 2);
  assert.deepEqual(report.document, (await fullReport(f.request)).document);
  assert.equal(report.readUsage.reads, 2 * stable.readUsage.reads, 'both generations share physical-read accounting');
  assert.equal(report.generationSequence, f.store.ledger.currentSequence());
});

function drift(f: Awaited<ReturnType<typeof published>>, action?: () => void) {
  const now = new Date(f.request.now),
    normal = now.toISOString.bind(now);
  let count = 0;
  now.toISOString = () => {
    count++;
    f.store.ledger.registerStaging(`report-change-${count}`, [
      { id: `sha256:${'0'.repeat(64)}`, schema: 'application/octet-stream', privacy: 'source' },
    ]);
    action?.();
    return normal();
  };
  return { now, count: () => count };
}

test('continuous unrelated changes refuse with a retryable viewChanged after exactly two generations', async (t) => {
  const f = await published(t),
    change = drift(f);
  await assert.rejects(
    fullReportFormat({ ...f.request, now: change.now }, 'html'),
    (e: any) => e.code === 'sentinel.report.viewChanged' && e.retryable === true && e.facts.generations === 2,
  );
  assert.equal(change.count(), 2);
});

for (const changed of ['current', 'baseline'] as const)
  test(`a changed ${changed} executed revision refuses without adopting it on retry`, async (t) => {
    const f = await published(t);
    let request = f.request;
    if (changed === 'baseline') {
      const child = await rerunRun(f.store, f.request.runId, [], {
        workspace: f.ws.path,
        trustDir: f.ws.trustDir,
        policy: f.policy,
        scratchRoot: f.work,
        now: new Date(),
      });
      assert.ok(!('reasonCode' in child));
      assert.equal(
        (await executeRun(f.store, child.disclosure.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir })).state,
        'completed',
      );
      request = { ...f.request, runId: child.disclosure.runId, baselineRunId: f.request.runId } as typeof request;
    }
    const now = new Date(f.request.now),
      normal = now.toISOString.bind(now);
    let generations = 0;
    now.toISOString = () => {
      generations++;
      f.store.ledger.registerStaging('report-own-change', [
        { id: `sha256:${'0'.repeat(64)}`, schema: 'application/octet-stream', privacy: 'source' },
      ]);
      // Fault injection after authentic accepted publication: remove only this fixture's row guards to exercise
      // the report's independent fence. Production rejects this mutation; accepted evidence remains untouched.
      const db = new DatabaseSync(join(f.store.storePath, 'ledger.sqlite'));
      try {
        db.exec('DROP TRIGGER runs_plan_advance; DROP TRIGGER runs_terminal;');
        db.prepare('UPDATE runs SET plan_revision = 999 WHERE id = ?').run(f.request.runId);
      } finally {
        db.close();
      }
      return normal();
    };
    await assert.rejects(
      fullReportFormat({ ...request, now }, 'json'),
      (e: any) =>
        e.code === 'sentinel.report.evidenceUnbound' &&
        e.retryable === false &&
        e.facts.reason === 'the report run changed during generation',
    );
    assert.equal(generations, 1);
  });

test('a retry cannot reset the physical-read budget', async (t) => {
  const f = await published(t),
    stable = await fullReportFormat(f.request, 'json'),
    change = drift(f);
  await assert.rejects(
    fullReportFormat({ ...f.request, now: change.now }, 'json', { reads: stable.readUsage.reads }),
    code('sentinel.object.tooLarge'),
  );
  assert.equal(change.count(), 1, 'the second generation cannot reach rendering with an exhausted original budget');
});

test('cancellation wins over sequence drift without a retry', async (t) => {
  const f = await published(t),
    controller = new AbortController(),
    change = drift(f, () => controller.abort());
  await assert.rejects(
    fullReportFormat({ ...f.request, now: change.now }, 'json', { signal: controller.signal }),
    code('sentinel.execution.canceled'),
  );
  assert.equal(change.count(), 1);
});

test('the original cooperative deadline wins over sequence drift without a retry', async (t) => {
  const f = await published(t),
    change = drift(f, () => {
      const until = performance.now() + 600;
      while (performance.now() < until) {
        /* a synchronous report step cannot extend the original deadline */
      }
    });
  await assert.rejects(
    fullReportFormat({ ...f.request, now: change.now }, 'json', { durationMs: 500 }),
    code('sentinel.execution.deadlineExceeded'),
  );
  assert.equal(change.count(), 1);
});

test('a closed owner still refuses through the real report reader with its original typed error', async (t) => {
  const f = await published(t);
  const request = fullReportFormat(f.request, 'json');
  f.store.close();
  await assert.rejects(request, (e: any) => ['sentinel.store.closed', 'sentinel.store.ownerClosed'].includes(e.code));
});
