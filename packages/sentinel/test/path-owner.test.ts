import { pathOwnerFixture } from './path-owner-helpers.ts';
// Actual adopted owner policy, promotion, public bootstrap and fixed retained task preparation. No receipt or
// producer authority is fabricated. Source files are removed before preparation and later execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitRepo, scratch, needsStore } from './snapshot-helpers.ts';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { PATHS_APP } from './paths-fixtures.ts';
import { openStore } from '../dist/store/index.js';
import { initWorkspace } from '../dist/cli/init.js';
import {
  workspaceOf,
  adoptWorkspaceSettings,
  adoptedPolicy,
  promoteRulePack,
  prepareWorkspacePaths,
  runPlan,
  fullReportIn,
  previewReport,
  followWorkspaceRun,
} from '../dist/service/local.js';
import { planWorkspaceCanonical, executeRun } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { loadPlan } from '../dist/execution/plans.js';
import { readPathRequestFile } from '../dist/service/path-request-file.js';
import { preparePathTask, acceptPathTask } from '../dist/service/path-task.js';
const invalid = (e: any) => ['sentinel.paths.invalidInput', 'sentinel.paths.unbound'].includes(e.code);
const owner = pathOwnerFixture;

test(
  'the exact owner preview waits without writes; accepted path task joins pending and executes the fixed child only after separate run admission',
  needsStore,
  async (t) => {
    const f = await owner(t);
    let store = await openStore(f.ws.storePath);
    const sequence = store.ledger.currentSequence();
    store.close();
    const waiting = await f.call();
    assert.equal(waiting.exitCode, 4, JSON.stringify(waiting));
    assert.equal(waiting.command, 'paths');
    assert.deepEqual(waiting.facts.preview.queries, f.request.queries);
    assert.deepEqual(waiting.facts.preview.bounds, f.request.bounds);
    assert.equal(waiting.facts.preview.requiredHeld >= 1, true);
    store = await openStore(f.ws.storePath);
    assert.deepEqual(
      store.ledger.readEvents({ after: sequence, limit: 100 }).events.map((e) => e.kind),
      ['epoch-opened', 'epoch-opened'],
      'only the owner operation and verification reopen epochs; no plan/stage/run/work/attempt',
    );
    assert.equal(store.ledger.latestPlan(waiting.facts.runId), undefined);
    store.close();
    const prepared = await f.call(true);
    assert.equal(prepared.outcome, 'prepared', JSON.stringify(prepared));
    assert.equal(prepared.facts.runId, waiting.facts.runId);
    store = await openStore(f.ws.storePath);
    const admitted = await loadPlan(store, prepared.facts.runId, 1),
      after = store.ledger.currentSequence();
    assert.equal(store.ledger.countAttempts(admitted.plan.units[0]), 0);
    assert.equal(store.ledger.getRun(prepared.facts.runId).state, 'planned');
    store.close();
    const kept = await f.call(true);
    assert.equal(kept.outcome, 'kept');
    assert.equal(kept.facts.runId, prepared.facts.runId);
    store = await openStore(f.ws.storePath);
    assert.deepEqual(
      store.ledger.readEvents({ after, limit: 100 }).events.map((e) => e.kind),
      ['epoch-opened', 'epoch-opened'],
    );
    store.close();
    const ran = await runPlan(f.ws, { planId: prepared.facts.runId, confirm: true, now: new Date() });
    assert.equal(ran.facts.state, 'completed', JSON.stringify(ran));
    store = await openStore(f.ws.storePath);
    assert.ok(store.ledger.getPublication(admitted.plan.units[0]));
    store.close();
    const minimal = await previewReport(f.ws, { runId: prepared.facts.runId, now: new Date() });
    assert.equal(minimal.structuralPaths.length, 1);
    assert.equal(minimal.structuralPaths[0].evidence.results[0].outcome, 'reached');
    for (const format of ['json', 'md', 'html', 'sarif'] as const) {
      const report = await fullReportIn(f.ws, {
        runId: prepared.facts.runId,
        disclosure: 'shareable',
        format,
        confirm: false,
        now: new Date(),
      });
      assert.ok(report.text, JSON.stringify(report));
      if (format === 'json') {
        const doc = JSON.parse(report.text);
        assert.equal(doc.structuralPaths.length, 1);
        assert.equal(doc.counts.pathQueries.n, 1);
        assert.equal(doc.findings.length, 0);
        assert.equal(
          doc.counts.pathQueries.breakdown.reduce((n: any, p: any) => n + p.n, 0),
          1,
        );
        assert.ok(doc.gaps.length > 0);
      } else if (format === 'sarif') {
        const doc = JSON.parse(report.text);
        assert.equal(doc.runs[0].properties.structuralPaths.length, 1);
        assert.equal(doc.runs[0].results.length, 0);
      } else assert.match(report.text, /Structural call reachability/);
    }
    const next = await f.call(true);
    assert.equal(next.outcome, 'prepared');
    assert.notEqual(next.facts.runId, prepared.facts.runId);
    assert.equal(next.facts.generation, 1);
  },
);

test('policy denial precedes missing/FIFO request reads and creates no path records', needsStore, async (t) => {
  const f = await owner(t);
  writeFileSync(
    f.settings,
    JSON.stringify({ ...f.value, grants: f.value.grants.filter((g: any) => !g.actions.includes('capture.source')) }),
  );
  adoptWorkspaceSettings(f.ws, { confirm: true, now: new Date() });
  const fifo = join(f.dir, 'request.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  for (const requestFile of [join(f.dir, 'absent'), fifo]) {
    const started = performance.now();
    const refused = await prepareWorkspacePaths(f.ws, {
      ancestorRunId: f.request.ancestor.runId,
      requestFile,
      confirm: true,
      now: new Date(),
    });
    assert.equal(refused.reasonCode, 'sentinel.admission.noGrant');
    assert.ok(performance.now() - started < 1000);
  }
});

test('request reader refuses links, hardlinks, FIFO, oversized, writable and malformed input promptly', (t) => {
  const dir = scratch(t),
    regular = join(dir, 'regular.json');
  writeFileSync(regular, '{}', { mode: 0o600 });
  const link = join(dir, 'link'),
    hard = join(dir, 'hard'),
    fifo = join(dir, 'fifo');
  symlinkSync(regular, link);
  linkSync(regular, hard);
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const big = join(dir, 'big');
  writeFileSync(big, Buffer.alloc((1 << 20) + 1));
  const bad = join(dir, 'bad');
  writeFileSync(bad, Buffer.from([255]));
  const writable = join(dir, 'writable');
  writeFileSync(writable, '{}');
  chmodSync(writable, 0o666);
  for (const path of [link, hard, fifo, big, bad, writable]) {
    const started = performance.now();
    assert.throws(() => readPathRequestFile(path, () => {}), invalid);
    assert.ok(performance.now() - started < 1000);
  }
});

test(
  'a genuine exact admission-before-run window is recovered as the same pending generation',
  needsStore,
  async (t) => {
    const f = await owner(t),
      p = adoptedPolicy(f.ws);
    assert.ok('policy' in p);
    const store = await openStore(f.ws.storePath);
    try {
      const timing = { signal: new AbortController().signal, deadlineAt: performance.now() + 60000 },
        terms = { trustDir: f.ws.trustDir, policy: p.policy, now: new Date() };
      const candidate = await preparePathTask(store, f.request, terms, timing);
      const { admitPlan } = await import('../dist/execution/plans.js');
      await admitPlan(store, {
        plan: candidate.plan,
        ruleLock: candidate.current.lock,
        policy: p.policy,
        profile: candidate.profile.record,
        pathRequest: { document: candidate.request.value, proof: candidate.proof, timing: candidate.timing },
      });
      assert.equal(store.ledger.getRun(candidate.plan.runId), null);
      const recovered = await preparePathTask(store, f.request, terms, timing);
      assert.equal(recovered.plan.digest, candidate.plan.digest);
      assert.equal(recovered.existing, true);
      const accepted = await acceptPathTask(store, recovered, terms);
      assert.equal(accepted.outcome, 'kept');
      assert.equal(store.ledger.getRun(accepted.runId).state, 'planned');
    } finally {
      store.close();
    }
  },
);

test(
  'the public owner command accepts only the request flag, discloses a linked plan and never launches during preparation',
  needsStore,
  async (t) => {
    const f = await owner(t),
      cli = join(import.meta.dirname, '../dist/cli.js'),
      env = { ...process.env, XDG_STATE_HOME: join(f.dir, 'owner') };
    const call = (args: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...args, '--workspace', f.path, '--json'], {
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      return { status: r.status, body: JSON.parse(r.stdout) };
    };
    const missing = call(['paths', f.request.ancestor.runId]);
    assert.equal(missing.status, 3);
    assert.equal(missing.body.reasonCode, 'sentinel.args.missingValue');
    const alias = call(['paths', f.request.ancestor.runId, '--request', f.requestFile, '--source', 'workspace']);
    assert.equal(alias.status, 3);
    assert.equal(alias.body.reasonCode, 'sentinel.args.unknownFlag');
    const waiting = call(['paths', f.request.ancestor.runId, '--request', f.requestFile]);
    assert.equal(waiting.status, 4, JSON.stringify(waiting));
    const prepared = call(['paths', f.request.ancestor.runId, '--request', f.requestFile, '--confirm']);
    assert.equal(prepared.status, 0, JSON.stringify(prepared));
    assert.equal(prepared.body.facts.runId, waiting.body.facts.runId);
    const store = await openStore(f.ws.storePath);
    try {
      const plan = await loadPlan(store, prepared.body.facts.runId, 1);
      assert.ok(plan.pathRequest);
      for (const u of plan.plan.units) assert.equal(store.ledger.countAttempts(u), 0);
    } finally {
      store.close();
    }
  },
);

test(
  'rerun OF a completed path task pins a genuine immediate request ancestor; successful retry stays empty',
  needsStore,
  async (t) => {
    const f = await owner(t),
      first = await f.call(true),
      id = first.facts.runId;
    assert.equal((await runPlan(f.ws, { planId: id, confirm: true, now: new Date() })).facts.state, 'completed');
    const before = await fullReportIn(f.ws, {
      runId: id,
      disclosure: 'shareable',
      format: 'json',
      confirm: false,
      now: new Date('2026-10-23T00:00:00Z'),
    });
    const empty = await followWorkspaceRun(f.ws, { mode: 'retry', runId: id, confirm: true, now: new Date() });
    assert.equal(empty.reasonCode, 'sentinel.service.nothingToRetry');
    const invalid = await followWorkspaceRun(f.ws, {
      mode: 'rerun',
      runId: id,
      stages: ['unrelated-held-stage'],
      confirm: true,
      now: new Date(),
    });
    assert.equal(invalid.reasonCode, 'sentinel.service.stageUnknown');
    const waiting = await followWorkspaceRun(f.ws, {
      mode: 'rerun',
      runId: id,
      stages: first.facts.unitIds,
      confirm: false,
      now: new Date(),
    });
    assert.equal(waiting.exitCode, 4);
    assert.deepEqual(waiting.facts.preview.queries, f.request.queries);
    assert.deepEqual(waiting.facts.preview.parentSelection, first.facts.unitIds);
    const rerun = await followWorkspaceRun(f.ws, {
      mode: 'rerun',
      runId: id,
      stages: first.facts.unitIds,
      confirm: true,
      now: new Date(),
    });
    assert.equal(rerun.outcome, 'prepared', JSON.stringify(rerun));
    assert.notEqual(rerun.facts.runId, id);
    const store = await openStore(f.ws.storePath);
    try {
      const admitted = await loadPlan(store, rerun.facts.runId, 1);
      assert.equal(admitted.selection, null);
      assert.equal(admitted.pathRequest.ancestor.runId, id);
      assert.equal(admitted.pathRequest.ancestor.planDigest, first.facts.planDigest);
      assert.deepEqual(admitted.pathRequest.queries, f.request.queries);
    } finally {
      store.close();
    }
    const done = await runPlan(f.ws, { planId: rerun.facts.runId, confirm: true, now: new Date() });
    assert.equal(done.facts.state, 'completed', JSON.stringify(done));
    const after = await fullReportIn(f.ws, {
      runId: id,
      disclosure: 'shareable',
      format: 'json',
      confirm: false,
      now: new Date('2026-10-23T00:00:00Z'),
    });
    assert.equal(after.text, before.text, 'the parent accepted report is immutable');
    const child = await previewReport(f.ws, { runId: rerun.facts.runId, now: new Date() });
    assert.equal(child.structuralPaths[0].evidence.results[0].outcome, 'reached');
  },
);

test(
  'pending and genuinely paused path task retry joins without creating another generation',
  needsStore,
  async (t) => {
    const f = await owner(t),
      first = await f.call(true),
      id = first.facts.runId;
    const pending = await followWorkspaceRun(f.ws, { mode: 'retry', runId: id, confirm: true, now: new Date() });
    assert.equal(pending.outcome, 'kept');
    assert.equal(pending.facts.runId, id);
    const { Coordinator } = await import('../dist/execution/coordinator.js');
    const { publicRegistry, scannerExecution } = await import('../dist/service/scanner-profile.js');
    const { WorkerSession } = await import('../dist/execution/protocol.js');
    const store = await openStore(f.ws.storePath),
      work = scratchUnder(store);
    const registry = publicRegistry(f.ws.trustDir),
      assets = await scannerExecution(store, id, f.ws.trustDir, work, registry);
    let coordinator: any;
    const receive = WorkerSession.prototype.receive;
    let dispatches = 0;
    const receiveMock = t.mock.method(WorkerSession.prototype, 'receive', function (message: any) {
      const step = receive.call(this, message);
      if (
        message.type === 'hello' &&
        message.adapterId === 'bounded-paths' &&
        step.send.some((m) => m.type === 'start')
      ) {
        dispatches++;
        queueMicrotask(() => coordinator.pause());
      }
      return step;
    });
    try {
      coordinator = await Coordinator.open({ ...assets, store, runId: id, registry, scratchRoot: work });
      assert.equal((await coordinator.run()).state, 'paused');
      assert.equal(dispatches, 1);
    } finally {
      receiveMock.mock.restore();
      removeScratch(work);
      store.close();
    }
    const paused = await followWorkspaceRun(f.ws, { mode: 'retry', runId: id, confirm: true, now: new Date() });
    assert.equal(paused.outcome, 'kept');
    assert.equal(paused.facts.runId, id);
    assert.equal(paused.facts.state, 'paused');
    const joined = await f.call(true);
    assert.equal(joined.outcome, 'kept');
    assert.equal(joined.facts.runId, id);
    assert.equal(joined.facts.generation, 0);
    const resumed = await runPlan(f.ws, { planId: id, confirm: true, now: new Date() });
    assert.equal(resumed.facts.state, 'completed', JSON.stringify(resumed));
  },
);

test(
  'retry of a genuinely canceled unpublished path task prepares only its active path unit and proves the canceled request ancestor',
  needsStore,
  async (t) => {
    const f = await owner(t),
      first: any = await f.call(true),
      id = first.facts.runId,
      { Coordinator } = await import('../dist/execution/coordinator.js'),
      { publicRegistry, scannerExecution } = await import('../dist/service/scanner-profile.js');
    const store = await openStore(f.ws.storePath),
      work = scratchUnder(store);
    try {
      const registry = publicRegistry(f.ws.trustDir),
        coordinator = await Coordinator.open({
          ...(await scannerExecution(store, id, f.ws.trustDir, work, registry)),
          store,
          runId: id,
          registry,
          scratchRoot: work,
        });
      coordinator.cancel();
      assert.equal((await coordinator.run()).state, 'canceled');
      for (const unit of (await loadPlan(store, id, 1)).plan.units)
        assert.equal(store.ledger.getPublication(unit), null);
    } finally {
      removeScratch(work);
      store.close();
    }
    const waiting: any = await followWorkspaceRun(f.ws, { mode: 'retry', runId: id, confirm: false, now: new Date() });
    assert.equal(waiting.exitCode, 4);
    assert.deepEqual(waiting.facts.preview.parentSelection, first.facts.unitIds);
    assert.equal(waiting.facts.preview.ancestor.runId, id);
    assert.ok(waiting.facts.preview.requiredHeld > 0);
    const retry: any = await followWorkspaceRun(f.ws, { mode: 'retry', runId: id, confirm: true, now: new Date() });
    assert.equal(retry.outcome, 'prepared', JSON.stringify(retry));
    assert.notEqual(retry.facts.runId, id);
    assert.equal(
      (await runPlan(f.ws, { planId: retry.facts.runId, confirm: true, now: new Date() })).facts.state,
      'completed',
    );
    const report: any = await previewReport(f.ws, { runId: retry.facts.runId, now: new Date() });
    assert.equal(report.structuralPaths[0].ancestor.runId, id);
    assert.equal(report.structuralPaths[0].evidence.results[0].outcome, 'reached');
    assert.equal(report.observations.length, 0);
  },
);
