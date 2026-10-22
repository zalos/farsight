// The owner's background service (PR 09): a run handed to it survives the command that started it, duplicate starts
// join one run, pause/resume/cancel reach the coordinator, a killed service's run resumes with each output accepted
// once, and authority arrives only as an owner receipt spent once (or the adopted grants): never from a hello.
// The service runs in its own process over the synthetic diamond plan; this test process plays the owner's CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptedPolicy, adoptWorkspaceSettings, confirmRunForService, workspaceOf } from '../dist/service/local.js';
import { connectService, readServiceDescriptor } from '../dist/service/owner-service.js';
import { connectOwnerSocket } from '../dist/transport/ipc.js';
import { initWorkspace } from '../dist/cli/init.js';
import { argumentsOf } from '../dist/execution/recovery.js';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { removeScratch } from './execution-helpers.ts';
import { publications } from './coordinator-helpers.ts';

const CHILD = fileURLToPath(new URL('./helpers/service-child.ts', import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();
after(async () => {
  for (const c of children) c.kill('SIGKILL');
  roots.forEach(removeScratch);
});

const hex = (n: number, c: string) => c.repeat(n);
const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };

/** A workspace with adopted settings and two prepared plan records, its trust in a private state folder. */
function setup(label: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `sentinel-svc-${label}-`));
  roots.push(root);
  const path = join(root, 'ws');
  mkdirSync(path, { mode: 0o700 });
  const env = { ...process.env, XDG_STATE_HOME: join(root, 'state') };
  const ws = workspaceOf(path, env);
  initWorkspace({ workspace: path });
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  const policy = adoptedPolicy(ws);
  assert.ok('policy' in policy);
  mkdirSync(ws.planDir, { recursive: true, mode: 0o700 });
  const plans = ['1', '2'].map(c => {
    const planId = `plan-${hex(32, c)}`;
    writeFileSync(join(ws.planDir, `${planId}.json`), JSON.stringify({
      schema: 'sentinel-plan-record/draft-1', planId, planDigest: `sha256:${hex(64, c)}`, snapshotId: 'snap-synthetic', policyRevision: policy.policy.revision,
    }), { mode: 0o600 });
    return planId;
  });
  return { root, ws, env, plans };
}

type Setup = ReturnType<typeof setup>;

async function serve(s: Setup, behaviour = 'slow-ok'): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CHILD, s.ws.path, join(s.root, 'adapters'), behaviour],
    { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  let err = '';
  child.stderr!.on('data', d => { err += d; });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', d => { if (String(d).includes('listening')) resolve(); });
    child.once('exit', code => reject(new Error(`service exited ${code}: ${err.slice(0, 500)}`)));
  });
  return child;
}

const stopped = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => new Promise<void>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  child.once('exit', () => resolve());
  child.kill(signal);
});

/** The owner's CLI: confirm the run here (a receipt minted in this process), then hand it over on a fresh connection. */
async function start(s: Setup, planId: string): Promise<any> {
  const confirmed = confirmRunForService(s.ws, { command: 'run', planId, confirm: true, now: new Date() });
  assert.ok('receiptId' in confirmed, JSON.stringify(confirmed));
  const client = (await connectService(s.ws))!;
  try { return await client.request('run.start', { planId, receiptId: confirmed.receiptId }); } finally { client.close(); }
}

async function ask(s: Setup, op: string, body: Record<string, unknown>): Promise<any> {
  const client = (await connectService(s.ws))!;
  try { return await client.request(op, body, { timeoutMs: 60_000 }); } finally { client.close(); }
}

/** Waits for the run to end (the service's own wait, re-asked until it does). */
async function waitEnd(s: Setup, runId: string): Promise<any> {
  for (;;) {
    const r = await ask(s, 'run.wait', { runId, timeoutMs: 20_000 });
    if (r.outcome !== 'submitted') return r;
  }
}

async function publishedCounts(s: Setup, runId: string) {
  const store = await openStore(s.ws.storePath);
  try { return Object.fromEntries(publications(store, runId)); } finally { store.close(); }
}

test('a connection without the owner\'s receipt gets only what the grants give agents; a hello or a claim gives nothing', needsStore, async () => {
  const s = setup('authority');
  const child = await serve(s);
  try {
    const d = readServiceDescriptor(s.ws)!;
    for (const kind of ['cli', 'mcp', 'http-bridge'] as const) {
      const c = await connectOwnerSocket(d.address, { storeId: d.storeId, ownerNonce: d.ownerNonce }, kind);
      try {
        const r: any = await c.request('run.start', { planId: s.plans[0] });
        assert.equal(r.outcome, 'configuration-failure', kind);
        assert.equal(r.reasonCode, 'sentinel.admission.noGrant', `${kind}: the default grants give agents nothing`);
        assert.equal(r.verdicts.policy.allowed, false);
        await assert.rejects(async () => c.request('run.start', { planId: s.plans[0], principal: 'human' }), /payloadClaim/);
        const forged: any = await c.request('run.start', { planId: s.plans[0], receiptId: 'receipt-forged' });
        assert.equal(forged.reasonCode, 'sentinel.receipt.unknown');
        await assert.rejects(c.request('run.start', { planId: s.plans[0], extra: 'x' }), /requestInvalid/);
        await assert.rejects(c.request('settings.adopt', {}), /unknownOperation/);
      } finally { c.close(); }
    }
    // A receipt confirms one plan: spent on another it is refused, and the run it names never started.
    const other = confirmRunForService(s.ws, { command: 'run', planId: s.plans[1]!, confirm: true, now: new Date() });
    assert.ok('receiptId' in other);
    const mismatch = await ask(s, 'run.start', { planId: s.plans[0], receiptId: other.receiptId });
    assert.equal(mismatch.reasonCode, 'sentinel.receipt.mismatch');
    const status = await ask(s, 'run.status', { runId: s.plans[0] });
    assert.equal(status.reasonCode, 'sentinel.service.runUnknown');
    // Without --confirm the owner's own CLI issues nothing.
    const unconfirmed = confirmRunForService(s.ws, { command: 'run', planId: s.plans[0]!, confirm: false, now: new Date() });
    assert.ok('result' in unconfirmed);
    assert.equal(unconfirmed.result.outcome, 'awaiting-confirmation');
    assert.equal(unconfirmed.result.exitCode, 4);
  } finally { await stopped(child); }
  assert.equal(readServiceDescriptor(s.ws), undefined, 'a stopped service removes its descriptor');
});

test('duplicate starts join one run, a receipt is spent once, and the run survives its callers disconnecting', needsStore, async () => {
  const s = setup('duplicate');
  const child = await serve(s);
  try {
    const planId = s.plans[0]!;
    const confirmed = confirmRunForService(s.ws, { command: 'run', planId, confirm: true, now: new Date() });
    assert.ok('receiptId' in confirmed);
    const second = confirmRunForService(s.ws, { command: 'run', planId, confirm: true, now: new Date() });
    assert.ok('receiptId' in second);
    const [a, b] = await Promise.all([confirmed.receiptId, second.receiptId].map(async receiptId => {
      const c = (await connectService(s.ws))!;
      const r = await c.request('run.start', { planId, receiptId });
      c.close(); // the caller goes away at once
      return r as any;
    }));
    assert.deepEqual([a.outcome, b.outcome], ['submitted', 'submitted']);
    assert.deepEqual([a.facts.runId, b.facts.runId], [planId, planId]);
    assert.deepEqual([a.facts.joined, b.facts.joined].sort(), [false, true], 'one start began the run; the other joined it');
    const reused = await ask(s, 'run.start', { planId, receiptId: confirmed.receiptId });
    assert.equal(reused.reasonCode, 'sentinel.receipt.alreadyUsed');
    const busy = await start(s, s.plans[1]!);
    assert.equal(busy.reasonCode, 'sentinel.service.anotherRunActive', 'one run executes at a time');
    const end = await waitEnd(s, planId);
    assert.equal(end.facts.state, 'completed');
    // A start of a finished run prints its result again and executes nothing.
    const again = await start(s, planId);
    assert.equal(again.facts.state, 'completed');
    assert.notEqual(again.outcome, 'submitted');
  } finally { await stopped(child); }
  assert.deepEqual(await publishedCounts(s, s.plans[0]!), { 'work-A-1': 1, 'work-B-1': 1, 'work-C-1': 1, 'work-D-1': 1 });
});

test('pause lets work in flight finish and resume needs the owner again; cancel stops the run', needsStore, async () => {
  const s = setup('controls');
  const child = await serve(s);
  try {
    const planId = s.plans[0]!;
    assert.equal((await start(s, planId)).outcome, 'submitted');
    const paused = await ask(s, 'run.pause', { runId: planId });
    assert.equal(paused.outcome, 'requested');
    const end = await waitEnd(s, planId);
    assert.equal(end.facts.state, 'paused');
    assert.equal(end.reasonCode, 'sentinel.service.runNotCompleted');
    assert.equal((await ask(s, 'run.pause', { runId: planId })).reasonCode, 'sentinel.service.runNotActive');
    // Resume is a start: the owner confirms again, and the run continues from the ledger.
    assert.equal((await start(s, planId)).outcome, 'submitted');
    assert.equal((await waitEnd(s, planId)).facts.state, 'completed');
    assert.deepEqual(await (async () => {
      const r = await ask(s, 'run.status', { runId: planId, limit: 50 });
      return r.facts.state;
    })(), 'completed');

    const other = s.plans[1]!;
    assert.equal((await start(s, other)).outcome, 'submitted');
    assert.equal((await ask(s, 'run.cancel', { runId: other })).outcome, 'requested');
    const canceled = await waitEnd(s, other);
    assert.equal(canceled.facts.state, 'canceled');
    assert.equal(canceled.reasonCode, 'sentinel.service.runNotCompleted');
    assert.equal((await ask(s, 'run.cancel', { runId: other })).reasonCode, 'sentinel.service.runNotActive');
  } finally { await stopped(child); }
  assert.deepEqual(await publishedCounts(s, s.plans[0]!), { 'work-A-1': 1, 'work-B-1': 1, 'work-C-1': 1, 'work-D-1': 1 });
});

const psWorks = (() => { try { return Array.isArray(argumentsOf(process.pid)); } catch { return false; } })();

test('a service killed mid-run: its run reads as interrupted, and resumes with each output accepted once', { skip: (!psWorks && 'recovery verifies workers by their arguments, which this host does not report') || needsStore.skip }, async () => {
  const s = setup('restart');
  const planId = s.plans[0]!;
  let child = await serve(s);
  assert.equal((await start(s, planId)).outcome, 'submitted');
  // Kill it while an attempt is in flight: no pause, no cleanup, its descriptor and socket left behind.
  for (let i = 0; ; i++) {
    const r = await ask(s, 'run.status', { runId: planId, limit: 50 });
    if (r.facts.events.some((e: { kind: string }) => e.kind === 'attempt-started')) break;
    assert.ok(i < 200, 'an attempt started');
    await new Promise(res => setTimeout(res, 25));
  }
  await stopped(child, 'SIGKILL');
  assert.equal(await connectService(s.ws), undefined, 'a dead service is not reached through its stale descriptor');

  child = await serve(s);
  try {
    const interrupted = await ask(s, 'run.wait', { runId: planId, timeoutMs: 0 });
    assert.equal(interrupted.reasonCode, 'sentinel.service.runInterrupted', 'nothing executes it, so it is not reported as running');
    assert.equal((await start(s, planId)).outcome, 'submitted');
    assert.equal((await waitEnd(s, planId)).facts.state, 'completed');
  } finally { await stopped(child); }
  assert.deepEqual(await publishedCounts(s, planId), { 'work-A-1': 1, 'work-B-1': 1, 'work-C-1': 1, 'work-D-1': 1 });
});
