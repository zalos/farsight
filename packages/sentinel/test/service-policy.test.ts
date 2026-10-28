// The owner's policy decides every write the service takes, with real adopted settings (PR 06's adoption, admission
// and receipts; nothing mocked): pause and cancel are decided like a start, an agent gets exactly what the adopted
// grants give it, and an owner receipt authorizes one action on one plan under one policy revision, once, while it is
// valid. The service runs in this process over a real store; no run executes (authorization is decided first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptedPolicy, adoptWorkspaceSettings, confirmForService, workspaceOf } from '../dist/service/local.js';
import { OwnerService } from '../dist/service/owner-service.js';
import { currentPlan } from '../dist/service/canonical.js';
import { registryFor, syntheticPlan, syntheticServiceDrivers } from './coordinator-helpers.ts';
import { requestedByOf } from '../dist/cli/actor.js';
import { DEFAULT_SETTINGS, SETTINGS_PATH } from '../dist/policy/index.js';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';

const QUALIFIED =
  qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !==
  undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };
const PLAN_A = `run-${'a'.repeat(32)}`;
const PLAN_B = `run-${'b'.repeat(32)}`;
const agent = requestedByOf({ kind: 'service-connection', granted: { principal: 'agent', channel: 'mcp' } });
const owner = requestedByOf({ kind: 'service-connection', granted: { principal: 'agent', channel: 'local-service' } });

/**
 * A workspace whose adopted settings carry `settings`, with two runs admitted through the real plan admission (the
 * synthetic four-unit plan, pinned to that adopted policy). Nothing executes in this suite: writes are decided first.
 */
async function workspace(
  t: { after(fn: () => void | Promise<void>): void },
  settings: Record<string, unknown>,
  stateDir?: string,
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-svcpol-')));
  const ws = workspaceOf(join(root, 'ws'), { ...process.env, XDG_STATE_HOME: stateDir ?? join(root, 'state') });
  mkdirSync(join(ws.path, '.farsight', 'sentinel'), { recursive: true, mode: 0o700 });
  const adopt = (s: Record<string, unknown>) => {
    writeFileSync(join(ws.path, SETTINGS_PATH), JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), ...s }), {
      mode: 0o600,
    });
    adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
    const p = adoptedPolicy(ws);
    assert.ok('policy' in p);
    return p.policy;
  };
  const policy = adopt(settings);
  const store = await openStore(ws.storePath);
  const registry = registryFor(root);
  for (const runId of [PLAN_A, PLAN_B]) await syntheticPlan(store, root, {}, { runId, policy, registry });
  const service = new OwnerService(store, ws, {
    registry,
    drivers: await syntheticServiceDrivers(store, registry, PLAN_A),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const plan = (runId: string) => currentPlan(store, runId);
  const receipt = async (action: 'run.start' | 'run.pause' | 'run.cancel', planId: string, at = new Date()) => {
    const c = confirmForService(ws, {
      command: action.slice(4),
      action,
      plan: await plan(planId),
      planId,
      confirm: true,
      now: at,
      storeId: store.storeId,
    });
    assert.ok('receiptId' in c, JSON.stringify(c));
    return c.receiptId;
  };
  return { ws, service, adopt, receipt, plan, storeId: store.storeId };
}

const OWNER_GRANTS = [
  {
    actions: ['capture.source', 'run.start', 'run.pause', 'run.cancel'],
    principals: ['human'],
    scope: { profiles: ['static'] },
  },
];

test(
  'pause and cancel are decided by the adopted policy: no grant, no write, for the owner as for anyone',
  needsStore,
  async (t) => {
    const w = await workspace(t, {
      grants: [{ actions: ['capture.source', 'run.start'], principals: ['human'], scope: { profiles: ['static'] } }],
    });
    for (const action of ['run.pause', 'run.cancel'] as const) {
      const c = confirmForService(w.ws, {
        command: action.slice(4),
        action,
        plan: await w.plan(PLAN_A),
        planId: PLAN_A,
        confirm: true,
        now: new Date(),
        storeId: w.storeId,
      });
      assert.ok('result' in c, `${action}: the owner's own CLI issues no receipt the policy does not grant`);
      assert.deepEqual(
        [c.result.outcome, c.result.reasonCode],
        ['configuration-failure', 'sentinel.admission.noGrant'],
      );
      const r: any = await w.service.handle(action, { runId: PLAN_A }, agent);
      assert.deepEqual(
        [r.outcome, r.reasonCode],
        ['configuration-failure', 'sentinel.admission.noGrant'],
        `${action}: nor does the service`,
      );
    }
  },
);

test(
  'an agent gets exactly what the grants give it: confirmation by default, the write only when explicitly allowed',
  needsStore,
  async (t) => {
    const w = await workspace(t, {
      grants: [
        ...OWNER_GRANTS,
        {
          actions: ['run.pause', 'run.cancel'],
          principals: ['agent'],
          confirm: 'agent',
          scope: { profiles: ['static'] },
        },
      ],
    });
    for (const action of ['run.pause', 'run.cancel'] as const) {
      const r: any = await w.service.handle(action, { runId: PLAN_A }, agent);
      assert.equal(r.outcome, 'awaiting-confirmation', `${action}: an agent's write waits for a person`);
      assert.equal(r.exitCode, 4);
    }
    // The same request from the owner's own CLI connection is still an agent's: being on the socket is not ownership.
    assert.equal(
      ((await w.service.handle('run.cancel', { runId: PLAN_A }, owner)) as any).outcome,
      'awaiting-confirmation',
    );

    // Another workspace whose adopted settings explicitly grant agents cancel, with agent actions allowed.
    const w2 = await workspace(t, {
      agentActions: 'allow',
      grants: [...OWNER_GRANTS, { actions: ['run.cancel'], principals: ['agent'], scope: { profiles: ['static'] } }],
    });
    const allowed: any = await w2.service.handle('run.cancel', { runId: PLAN_A }, agent);
    assert.equal(
      allowed.verdicts.policy.reasonCode,
      'sentinel.admission.granted',
      'an explicit grant with agent actions allowed admits it',
    );
    assert.equal(allowed.reasonCode, 'sentinel.service.runUnknown', 'admitted, then answered on the run itself');
    assert.equal(
      ((await w2.service.handle('run.pause', { runId: PLAN_A }, agent)) as any).reasonCode,
      'sentinel.admission.noGrant',
      'cancel granted is not pause granted',
    );
    // A settings change retires the runs admitted under the old policy, for every requester.
    w2.adopt({ agentActions: 'allow', grants: OWNER_GRANTS });
    assert.equal(
      ((await w2.service.handle('run.cancel', { runId: PLAN_A }, agent)) as any).reasonCode,
      'sentinel.service.policyChanged',
    );
  },
);

test(
  'an owner receipt authorizes one action, on one plan, under one policy revision, once, while it is valid',
  needsStore,
  async (t) => {
    const w = await workspace(t, { grants: OWNER_GRANTS });
    const r = async (op: string, runId: string, receiptId: string) =>
      (await w.service.handle(op, { runId, receiptId }, agent)) as any;

    const pause = await w.receipt('run.pause', PLAN_A);
    assert.equal(
      (await r('run.cancel', PLAN_A, pause)).reasonCode,
      'sentinel.receipt.mismatch',
      'a pause receipt does not cancel',
    );
    assert.equal(
      (await r('run.pause', PLAN_B, pause)).reasonCode,
      'sentinel.receipt.mismatch',
      'nor pause another plan',
    );
    const spent = await r('run.pause', PLAN_A, pause);
    assert.equal(spent.verdicts.policy.reasonCode, 'sentinel.service.ownerReceipt');
    assert.equal(spent.reasonCode, 'sentinel.service.runNotActive', 'authorized, then answered on the run itself');
    assert.equal((await r('run.pause', PLAN_A, pause)).reasonCode, 'sentinel.receipt.alreadyUsed', 'spent once');

    const start = await w.receipt('run.start', PLAN_A);
    assert.equal(
      (await r('run.cancel', PLAN_A, start)).reasonCode,
      'sentinel.receipt.mismatch',
      'a start receipt does not cancel',
    );

    // A receipt outlives neither its expiry nor the policy it was given under.
    const old = await w.receipt('run.cancel', PLAN_A, new Date(Date.now() - 11 * 60_000));
    assert.equal((await r('run.cancel', PLAN_A, old)).reasonCode, 'sentinel.receipt.expired');
    // A receipt id the owner never issued is unknown, however it is spelled.
    assert.equal((await r('run.cancel', PLAN_A, 'receipt-forged')).reasonCode, 'sentinel.receipt.unknown');
    await assert.rejects(
      w.service.handle('run.cancel', { runId: PLAN_A, receiptId: '../escape' }, agent),
      /requestInvalid/,
    );
    // After the settings change, the run's admitted plan is under a policy no longer adopted: the receipt given under
    // the old one is never even consulted.
    const cancel = await w.receipt('run.cancel', PLAN_B);
    w.adopt({ grants: [...OWNER_GRANTS, { actions: ['rule.promote'], principals: ['human'] }] });
    assert.equal(
      (await r('run.cancel', PLAN_B, cancel)).reasonCode,
      'sentinel.service.policyChanged',
      'the policy changed since the receipt was given',
    );
  },
);

test(
  'a receipt is bound to its workspace, store and run: an identical twin workspace refuses it',
  needsStore,
  async (t) => {
    // Two workspaces with the same settings and plan records: the same policy revision and the same plan digests.
    // One owner (one private state, one receipt book), two workspaces.
    const state = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-owner-state-')));
    t.after(() => rmSync(state, { recursive: true, force: true }));
    const a = await workspace(t, { grants: OWNER_GRANTS }, state);
    const b = await workspace(t, { grants: OWNER_GRANTS }, state);
    const policy = (ws: typeof a.ws) => {
      const p = adoptedPolicy(ws);
      assert.ok('policy' in p);
      return p.policy.revision;
    };
    assert.equal(policy(a.ws), policy(b.ws), 'the twins share a policy revision');
    assert.notEqual(a.storeId, b.storeId);
    const r = async (w: typeof a, op: string, receiptId: string) =>
      (await w.service.handle(
        op,
        op === 'run.start' ? { planId: PLAN_A, receiptId } : { runId: PLAN_A, receiptId },
        agent,
      )) as any;

    for (const op of ['run.pause', 'run.cancel', 'run.start'] as const) {
      const forA = await a.receipt(op, PLAN_A);
      assert.equal((await r(b, op, forA)).reasonCode, 'sentinel.receipt.mismatch', `${op}: A's receipt is not B's`);
    }
    // Naming B's store while confirming in A still binds A's workspace: B refuses it too.
    const crossed = confirmForService(a.ws, {
      command: 'pause',
      action: 'run.pause',
      plan: await a.plan(PLAN_A),
      planId: PLAN_A,
      confirm: true,
      now: new Date(),
      storeId: b.storeId,
    });
    assert.ok('receiptId' in crossed);
    assert.equal((await r(b, 'run.pause', crossed.receiptId)).reasonCode, 'sentinel.receipt.mismatch');
    // The same receipt kind on its own instance is accepted.
    const own = await a.receipt('run.pause', PLAN_A);
    assert.equal((await r(a, 'run.pause', own)).verdicts.policy.reasonCode, 'sentinel.service.ownerReceipt');
    // And a receipt for one run is not one for another run of the same instance.
    const otherRun = await a.receipt('run.pause', PLAN_B);
    assert.equal((await r(a, 'run.pause', otherRun)).reasonCode, 'sentinel.receipt.mismatch');
    // Without a store, the owner's own CLI issues nothing: a receipt that names no store could be spent anywhere.
    const unbound = confirmForService(a.ws, {
      command: 'pause',
      action: 'run.pause',
      plan: await a.plan(PLAN_A),
      planId: PLAN_A,
      confirm: true,
      now: new Date(),
    });
    assert.ok('result' in unbound && unbound.result.reasonCode === 'sentinel.service.notRunning');
  },
);
