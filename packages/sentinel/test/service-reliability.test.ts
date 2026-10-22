// Public service recovery: retained bootstrap evidence, durable fatal diagnostics and their disclosure boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { unlock } from './snapshot-helpers.ts';
const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };
test('public retry and rerun recover an ended bootstrap as a fresh child over retained inputs', needsStore, async (t) => {
    const { foundationProfile, foundationRegistry, profileDigest, OPERATIONS, RESOURCES, PARSE } = await import('../dist/service/trusted-profile.js');
    const { executionProfileRecord } = await import('../dist/execution/profile.js');
    const { followWorkspaceRun } = await import('../dist/service/local.js');
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-bootfail-')));
    t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
    const path = join(dir, 'ws');
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
    const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
    initWorkspace({ workspace: path });
    adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
    promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() });
    const adopted = adoptedPolicy(ws);
    assert.ok('policy' in adopted);
    const store = await openStore(ws.storePath);
    t.after(() => { try {
        store.close();
    }
    catch { /* closed */ } });
    const work = scratchUnder(store);
    try {
        // Capture really publishes, but parse is unbound: the ended parent has accepted bootstrap state to preserve.
        const base = foundationProfile(foundationRegistry());
        const planner = { ...base.planner, operations: { capture: OPERATIONS.capture, inventory: OPERATIONS.inventory } };
        const record = executionProfileRecord(planner, RESOURCES, PARSE);
        const unbound = { ...base, planner, record, digest: profileDigest(record) };
        const opts = { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date(), profile: unbound };
        let failedRun = '';
        await assert.rejects(planWorkspaceCanonical(store, opts), (e: any) => { failedRun = e.facts?.runId; return e.code === 'sentinel.service.bootstrapFailed'; });
        assert.equal(store.ledger.getRun(failedRun)!.state, 'completed');
        assert.equal(store.ledger.getRun(failedRun)!.outcome, 'execution-failure');
        const parentPlan = (await loadPlan(store, failedRun, 1)).plan;
        const capture = parentPlan.units.find(u => u.stage === 'capture')!;
        assert.ok(store.ledger.getPublication({ id: capture.id, revision: capture.revision }));
        // The same content again names the same finished run, at once, executing nothing.
        const events = store.ledger.readEvents({ runId: failedRun, after: 0, limit: 500 }).events.length;
        await assert.rejects(planWorkspaceCanonical(store, opts), (e: any) => e.code === 'sentinel.service.bootstrapFailed' && e.facts.runId === failedRun);
        assert.equal(store.ledger.readEvents({ runId: failedRun, after: 0, limit: 500 }).events.length, events, 'nothing ran again');
        // A rerun plans a new run after it, under the shipped profile.
        store.close();
        writeFileSync(join(path, 'src/users.ts'), 'export const changedAfterFailure = true;\n');
        const next = await followWorkspaceRun(ws, { mode: 'rerun', runId: failedRun, confirm: true, now: new Date() });
        const retried = await followWorkspaceRun(ws, { mode: 'retry', runId: failedRun, confirm: true, now: new Date() });
        for (const followed of [next, retried]) {
            assert.ok(['prepared', 'kept'].includes(followed.outcome), JSON.stringify(followed));
            assert.equal(followed.facts.parentId, failedRun);
            assert.notEqual(followed.facts.runId, failedRun);
            assert.equal((followed.facts.preview as any).checks, 0);
            assert.deepEqual((followed.facts.preview as any).prerequisites, []);
        }
        const reopened = await openStore(ws.storePath);
        try {
            assert.equal(reopened.ledger.getRun(failedRun)!.outcome, 'execution-failure');
            const child = reopened.ledger.getRun(next.facts.runId as string)!;
            assert.equal(child.envelope.snapshotId, reopened.ledger.getRun(failedRun)!.envelope.snapshotId);
            assert.equal(child.envelope.parentId, failedRun);
            assert.equal(child.state, 'running');
            assert.equal(reopened.ledger.listAttempts({ id: capture.id, revision: capture.revision }).length, 1, 'the parent capture was never run again');
            assert.ok(reopened.ledger.getPlan(child.id, 2), 'a new analysis is prepared under the current profile');
        }
        finally {
            reopened.close();
        }
    }
    finally {
        removeScratch(work);
    }
});
test('fatal finalization failure is retained for wait, status and report after the service and store restart', needsStore, async (t) => {
    const { DatabaseSync } = await import('node:sqlite');
    const { OwnerService } = await import('../dist/service/owner-service.js');
    const { confirmForService, reportIn } = await import('../dist/service/local.js');
    const { currentPlan } = await import('../dist/service/canonical.js');
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-sol-runtime-')));
    t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
    const path = join(dir, 'ws');
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src/query.ts'), 'export const q = "SELECT * FROM t WHERE id=" + id;\n');
    const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
    initWorkspace({ workspace: path });
    adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
    promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('foundation-preview')!), confirm: true, now: new Date() });
    const adopted = adoptedPolicy(ws);
    assert.ok('policy' in adopted);
    let store = await openStore(ws.storePath);
    t.after(() => { try {
        store.close();
    }
    catch { } });
    const work = scratchUnder(store);
    let planned;
    try {
        planned = await planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
    }
    finally {
        removeScratch(work);
    }
    const id = planned.disclosure.runId;
    // Actual SQLite abort at the terminal-state write, after the real worker's publication. No coordinator mock.
    const db = new DatabaseSync(join(ws.storePath, 'ledger.sqlite'));
    db.exec("CREATE TRIGGER sol_deny_completion BEFORE UPDATE OF state ON runs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'SOL terminal-state write failed'); END");
    const service = new OwnerService(store, ws);
    const plan = await currentPlan(store, id);
    const receipt = confirmForService(ws, { command: 'run', action: 'run.start', plan, planId: id, confirm: true, now: new Date(), storeId: store.storeId });
    assert.ok('receiptId' in receipt);
    const started: any = await service.handle('run.start', { planId: id, receiptId: receipt.receiptId }, { principal: 'agent', channel: 'local-service' });
    assert.equal(started.outcome, 'submitted');
    const before: any = await service.handle('run.wait', { runId: id, timeoutMs: 10000 }, { principal: 'agent', channel: 'local-service' });
    assert.ok(before.facts.error, JSON.stringify(before));
    db.exec('DROP TRIGGER sol_deny_completion');
    db.close();
    await service.stop();
    store.close();
    store = await openStore(ws.storePath);
    const fresh = new OwnerService(store, ws);
    const after: any = await fresh.handle('run.wait', { runId: id, timeoutMs: 100 }, { principal: 'agent', channel: 'local-service' });
    const report = await reportIn(store, ws, { runId: id, now: new Date() });
    await fresh.stop();
    assert.equal(after.facts.error, before.facts.error, 'actual fatal runtime failure remains after reopening');
    const status: any = await fresh.handle('run.status', { runId: id }, { principal: 'agent', channel: 'local-service' });
    assert.equal(status.facts.error, before.facts.error);
    assert.equal((report as any).facts.error, before.facts.error);
    assert.equal(after.facts.lastFailure.storeId, store.storeId);
    assert.equal(after.facts.lastFailure.runId, id);
    assert.equal(after.facts.lastFailure.planRevision, 2);
    assert.equal(after.facts.lastFailure.code, 'sentinel.store.conflict');
    assert.ok(!JSON.stringify({ before, after, report, status }).includes('SOL terminal-state write failed'), 'raw SQLite text is withheld');
});
test('runtime diagnostic codes are bounded and a copied record cannot cross a store binding', needsStore, async (t) => {
    const { recordRunFailure, runFailureFacts } = await import('../dist/service/run-failure.js');
    const { syntheticPlan } = await import('./coordinator-helpers.ts');
    const { Coordinator } = await import('../dist/execution/coordinator.js');
    const { readFileSync, cpSync } = await import('node:fs');
    const { removeScratch, scratch, storeIn } = await import('./execution-helpers.ts');
    const a = scratch('service-diagnostic-a');
    const b = scratch('service-diagnostic-b');
    t.after(() => { removeScratch(a.root); removeScratch(b.root); });
    const stores = [await storeIn(a.root), await storeIn(b.root)];
    t.after(() => stores.forEach(s => s.close()));
    for (const [i, s] of [a, b].entries()) {
        const p = await syntheticPlan(stores[i], s.root);
        const c = await Coordinator.open({ store: stores[i], runId: p.runId, run: p.run, registry: p.registry, scratchRoot: s.work });
        c.pause();
        await c.run();
    }
    recordRunFailure(stores[0], 'run-e4', { code: 'sentinel.SOURCE_SECRET_MARKER', message: 'SOURCE_SECRET_MARKER' });
    const file = join(stores[0].storePath, 'execution/service-errors/run-e4.json');
    assert.ok(!readFileSync(file, 'utf8').includes('SOURCE_SECRET_MARKER'));
    assert.equal(runFailureFacts(stores[0], 'run-e4').error, 'sentinel.service.executionFailed');
    const dir = join(stores[1].storePath, 'execution/service-errors');
    mkdirSync(dir, { mode: 0o700 });
    cpSync(file, join(dir, 'run-e4.json'));
    assert.deepEqual(runFailureFacts(stores[1], 'run-e4'), {}, 'a different store does not inherit this run failure');
});
