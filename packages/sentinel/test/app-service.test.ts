// The service facade (app/service.ts) and its principals (app/principal.ts): who may call what, the scan command
// through the command line and the running service, and the composite start a plan with model stages needs. The
// model is a local fixture endpoint; nothing contacts a hosted provider or a real keychain.
import { test } from 'node:test';
import { sentinelExecutionWord } from '@farsight/core/dist/strings-sentinel-execution.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsStore, unlock } from './snapshot-helpers.ts';
import { json, mockEndpoint, ollamaReply, trustedPolicy } from './provider-helpers.ts';
import { agentPrincipal, claimOwnerMint, entryIsOwnerCli, isOwner, principalOf } from '../dist/app/principal.js';
import {
  HeldSentinelService,
  LocalSentinelService,
  RemoteSentinelService,
  scanPreviewOf,
} from '../dist/app/service.js';
import { initWorkspace } from '../dist/cli/init.js';
import { ActorError } from '../dist/cli/actor.js';
import { ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { bindProvider } from '../dist/review/providers/profile.js';
import {
  OWNER,
  adoptedPolicy,
  confirmForService,
  runPlan,
  envelopeBinding,
  receiptBook,
  runWriteBinding,
  workspaceOf,
} from '../dist/service/local.js';
import { currentPlan } from '../dist/service/canonical.js';
import { OwnerService } from '../dist/service/owner-service.js';
import { openStore } from '../dist/store/index.js';
import { BudgetLedger } from '../dist/review/providers/budget.js';
import { COPILOT_NATIVE_PROFILE } from '../dist/review/providers/cli-copilot-profile.js';
import { loadPlan } from '../dist/execution/plans.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const AGENT = { principal: 'agent', channel: 'mcp' } as const;

function scratchDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Stops the workspace's background service by the pid its private descriptor names, and waits for it. */
function stopService(env: { XDG_STATE_HOME: string }) {
  const dir = join(env.XDG_STATE_HOME, 'farsight', 'sentinel', 'trust', 'services');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const n of names) {
    const { pid } = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { pid: number };
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue;
    }
    for (let i = 0; i < 200; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      spawnSync('sleep', ['0.05']);
    }
  }
}

/** The owner's executable in a private workspace and private state folders. */
function owner(ws: string, env: Record<string, string>) {
  return (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ws, env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

/**
 * Local (in this process, the store opened per call), Held (inside an owner service over the store it holds) and
 * Remote (the owner's side, through the service's own operations) answer every shared read and preview alike.
 */
async function facadeParity(ws: string, env: Record<string, string>, runId: string) {
  const wsOf = workspaceOf(ws, env);
  const now = new Date('2026-10-28T12:00:00.000Z');
  // One at a time: the local side opens the store for each call.
  const reads = async (facade: any, by: any) => {
    const out: any[] = [];
    for (const call of [
      () => facade.status(by, {}),
      () => facade.status(by, { runId, after: 0, limit: 5 }),
      () => facade.report(by, { now }),
      () => facade.report(by, { runId, now }),
      () => facade.scans(by, {}),
      () => facade.stage(by, { stageId: 'preview' }),
      () => facade.stage(by, { runId, stageId: 'nope' }),
      () => facade.startPreview(by, { runId, now }),
    ])
      out.push(await call());
    return out;
  };
  // Reads take any principal: an agent's, the only kind a test process can hold (no owner exists outside the CLI).
  const reader = agentPrincipal({ principal: 'agent', channel: 'cli' } as never);
  const local = await reads(new LocalSentinelService(wsOf), reader);
  const store = await openStore(wsOf.storePath);
  const service = new OwnerService(store, wsOf, { now: () => now });
  try {
    const agent = agentPrincipal(AGENT as never);
    const held = await reads(
      new HeldSentinelService(store, wsOf, { executing: () => false, registry: () => ({}) as never }),
      agent,
    );
    // The remote side's connection, answered by the service's own operations for a connection on the CLI channel.
    const connect = async () => ({
      storeId: store.storeId,
      request: (op: string, body: Record<string, unknown>) =>
        service.handle(op, body, { principal: 'agent', channel: 'cli' } as never),
      close() {},
    });
    const remote = await reads(new RemoteSentinelService(wsOf, connect), reader);
    const labels = [
      'status',
      'status page',
      'report',
      'report by id',
      'scans',
      'stage',
      'unknown stage',
      'start preview',
    ];
    for (let i = 0; i < labels.length; i++) {
      assert.deepEqual(held[i], local[i], `held = local: ${labels[i]}`);
      assert.deepEqual(remote[i], local[i], `remote = local: ${labels[i]}`);
    }
    assert.equal(local[0].facts.runId, runId);
    assert.equal(local[7].facts.planId, runId);
  } finally {
    await service.stop();
    store.close();
  }
}

/** The same executable, without blocking this process (a fixture endpoint here must keep answering). */
function ownerAsync(ws: string, env: Record<string, string>) {
  return (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      child.on('error', reject);
      child.on('exit', (status) => resolve({ status, stdout, stderr }));
    });
}

test('only an owner the command line minted is the owner; a copy, a parsed body or a forged object is refused', async (t) => {
  const principalJs = fileURLToPath(new URL('../dist/app/principal.js', import.meta.url));
  const notEntry = (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.ownerMintNotEntry';
  // This test process's entry is not the command line: even the first claim here is refused.
  assert.equal(entryIsOwnerCli(), false);
  assert.throws(() => claimOwnerMint(), notEntry);
  const probes = scratchDir(t, 'sentinel-mint-');
  // A fresh process whose entry is another program, importing the package first of anything: it cannot mint.
  const first = join(probes, 'first-importer.mjs');
  writeFileSync(
    first,
    `const { claimOwnerMint } = await import(${JSON.stringify(principalJs)});
     try { claimOwnerMint()(); console.log('minted'); } catch (e) { console.log(e.code); }\n`,
  );
  const library = spawnSync(process.execPath, [first], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.match(library.stdout, /^sentinel\.actor\.ownerMintNotEntry$/m, library.stdout + library.stderr);
  assert.doesNotMatch(library.stdout, /minted/);
  // The command line's own process: it mints its owner (a command that needs one answers) and holds the mint, so
  // another module there that asks after it (a preload checking as the process ends) is refused.
  const late = join(probes, 'late-importer.mjs');
  writeFileSync(
    late,
    `import { writeSync } from 'node:fs';
     const { claimOwnerMint } = await import(${JSON.stringify(principalJs)});
     process.on('exit', () => {
       try { claimOwnerMint(); writeSync(2, 'minted\\n'); } catch (e) { writeSync(2, e.code + '\\n'); }
     });\n`,
  );
  const probeWs = join(probes, 'ws');
  mkdirSync(probeWs);
  const cli = spawnSync(process.execPath, ['--import', late, CLI, 'scans', '--json'], {
    cwd: probeWs,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: join(probes, 'home'), XDG_STATE_HOME: join(probes, 'state') },
  });
  assert.equal(JSON.parse(cli.stdout).command, 'scans', cli.stdout + cli.stderr);
  assert.doesNotMatch(cli.stderr, /ownerMintNotEntry/, 'the command line minted its owner');
  assert.match(cli.stderr, /^sentinel\.actor\.ownerMintClaimed$/m, cli.stderr);
  assert.doesNotMatch(cli.stderr, /minted/);
  // No owner exists here; whatever is built to look like one is refused by every check.
  const me = { kind: 'owner', requestedBy: OWNER };
  assert.equal(isOwner(me), false);
  for (const forged of [
    structuredClone(me),
    { ...me },
    JSON.parse(JSON.stringify(me)),
    { kind: 'owner', requestedBy: { principal: 'human', channel: 'owner-cli' } },
    { kind: 'agent', requestedBy: { principal: 'human', channel: 'owner-cli' } },
    { kind: 'agent', requestedBy: { principal: 'agent', channel: 'owner-cli' } },
    null,
    'owner',
  ]) {
    assert.equal(isOwner(forged), false);
    assert.throws(
      () => principalOf(forged),
      (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.confirmNotOwner',
    );
  }
  // A connection is an agent on the channel its transport accepted, never the owner channel or a human.
  assert.equal(agentPrincipal({ principal: 'agent', channel: 'cli' } as never).kind, 'agent');
  for (const by of [
    { principal: 'agent', channel: 'owner-cli' },
    { principal: 'human', channel: 'mcp' },
  ])
    assert.throws(
      () => agentPrincipal(by as never),
      (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.ownerChannelNotGrantable',
    );
  // Every facade method refuses a forged owner before it reads or writes anything.
  const dir = scratchDir(t, 'sentinel-principal-');
  const ws = workspaceOf(join(dir, 'ws'), { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') });
  const forged = { kind: 'owner', requestedBy: OWNER } as never;
  const local = new LocalSentinelService(ws);
  const held = new HeldSentinelService({} as never, ws, { executing: () => false, registry: () => ({}) as never });
  const now = new Date();
  for (const facade of [local, held]) {
    for (const call of [
      () => facade.scan(forged, { confirm: true, now }),
      () => facade.scanPreview(forged, { now }),
      () => facade.plan(forged, { confirm: true, now }),
      () => facade.startPreview(forged, { now }),
      () => facade.rerun(forged, { mode: 'rerun', runId: 'run-x', stages: [], confirm: true, now }),
      () => facade.status(forged, {}),
      () => facade.report(forged, { now }),
      () => facade.scans(forged, {}),
      () => facade.stage(forged, { stageId: 'review' }),
    ])
      await assert.rejects(
        call(),
        (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.confirmNotOwner',
      );
  }
  assert.equal(existsSync(join(dir, 'ws')), false, 'nothing was created for a refused caller');
});

test('the scan preview names every binding the plan can use, a segment-only selection included', (t) => {
  const dir = scratchDir(t, 'sentinel-preview-models-');
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  initWorkspace({ workspace: ws });
  const path = join(ws, '.farsight', 'sentinel', 'settings.json');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  settings.providers = [structuredClone(trustedPolicy().settings.providers[0])];
  settings.providers[0].models[0].capability.revision = null;
  // No stage-wide selection: only one segment of the guided review has a model.
  settings.reviewModels = {
    stages: [],
    segments: [{ stage: 'guided', segmentId: 'guided-chk-1', providerId: 'local-review', modelId: 'review' }],
  };
  writeFileSync(path, JSON.stringify(settings));
  const preview = scanPreviewOf(workspaceOf(ws, env), agentPrincipal(AGENT as never), new Date());
  assert.equal(preview.outcome, 'awaiting-confirmation', JSON.stringify(preview));
  assert.deepEqual(preview.facts.models, [
    {
      stage: 'guided',
      segmentId: 'guided-chk-1',
      providerId: 'local-review',
      modelId: 'review',
      runner: 'ollama',
      model: 'review-model:1',
      budget: { maxTokens: 100000, maxCost: '0', currency: 'USD' },
    },
  ]);
  // An agent sees what would run and is told only the owner confirms it.
  assert.equal(preview.facts.ownerOnly, true);
});

test('the scan preview refuses a pipeline it cannot adopt or plan, and lists every problem it would plan with', (t) => {
  const dir = scratchDir(t, 'sentinel-preview-problems-');
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  initWorkspace({ workspace: ws, profile: 'agentic' });
  const wsOf = workspaceOf(ws, env);
  const by = agentPrincipal(AGENT as never);
  // As init wrote it: every problem is one plan goes on with (the tools not adopted, no provider for the review).
  const shipped = scanPreviewOf(wsOf, by, new Date());
  assert.equal(shipped.outcome, 'awaiting-confirmation', JSON.stringify(shipped));
  const problems = shipped.facts.pipeline.problems as { code: string; class: string; stage: string }[];
  assert.deepEqual(
    problems.map((p) => `${p.stage}:${p.code}:${p.class}`),
    [
      'secrets:sentinel.pipeline.toolNotAdopted:unavailable',
      'patterns:sentinel.pipeline.toolNotAdopted:unavailable',
      'review:sentinel.pipeline.runnerNotConfigured:unavailable',
    ],
  );
  // The packs the setup promotes count as promoted: no rule is reported as missing from the lock.
  assert.ok(!problems.some((p) => p.code === 'sentinel.pipeline.notPromoted'));
  assert.deepEqual(shipped.facts.models, [
    {
      stage: 'review',
      review: 'general',
      segmentId: null,
      providerId: null,
      modelId: null,
      runner: 'copilot-cli',
      model: 'gpt-6-luna',
      budget: null,
    },
  ]);
  const file = join(ws, '.farsight', 'sentinel', 'pipeline.json');
  const pipeline = JSON.parse(readFileSync(file, 'utf8'));
  // A stage naming a pack the owner never promoted: adoption would refuse it, so the scan is refused, nothing offered.
  const packed = structuredClone(pipeline);
  packed.stages.find((s: { id: string }) => s.id === 'review').prompt = 'stages/review@3#prompt.md';
  writeFileSync(file, JSON.stringify(packed));
  const unadoptable = scanPreviewOf(wsOf, by, new Date());
  assert.equal(unadoptable.outcome, 'configuration-failure');
  assert.equal(unadoptable.reasonCode, 'sentinel.pipeline.unknownPack');
  assert.equal(unadoptable.facts.confirmWith, undefined);
  // A native Claude stage while its runner is off: refused as plan would refuse it.
  const triage = structuredClone(pipeline);
  triage.stages.splice(-1, 0, {
    id: 'triage',
    kind: 'agent',
    mode: 'native',
    runner: 'claude-cli',
    model: 'claude-sonnet-5-5',
    needs: [{ stage: 'review', output: 'observations' }],
  });
  writeFileSync(file, JSON.stringify(triage));
  const off = scanPreviewOf(wsOf, by, new Date());
  assert.equal(off.outcome, 'configuration-failure', JSON.stringify(off.facts));
  assert.equal(off.reasonCode, 'sentinel.pipeline.flagDisabled');
  assert.equal(off.facts.ownerOnly, undefined, 'nothing to confirm');
});

test('the composite start binds the plan digest, its stages and each model binding with its budget', (t) => {
  const dir = scratchDir(t, 'sentinel-composite-');
  mkdirSync(join(dir, 'ws'));
  const ws = workspaceOf(join(dir, 'ws'), { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') });
  const book = new ReceiptBook(join(dir, 'receipts'));
  const now = new Date();
  const policyRevision = 'sha256:' + 'a'.repeat(64);
  const plan = {
    runId: 'run-composite',
    revision: 2,
    planDigest: 'sha256:' + 'b'.repeat(64),
    policyRevision,
    kind: 'analysis' as const,
    effects: ['local-artifacts', 'paid-inference'] as never,
    stages: ['check', 'review-general', 'review-guided'],
    model: {
      providerId: 'local-review',
      modelId: 'review',
      bindingDigest: 'sha256:' + 'c'.repeat(64),
      budget: { maxTokens: 1000, maxCost: '0', currency: 'USD' },
    },
  };
  const instance = { storeId: 'store-1', runId: plan.runId };
  const bind = (p: typeof plan) => ({ ...runWriteBinding(ws, 'run.start', p as never, instance), policyRevision });
  const id = issueReceipt(book, OWNER, bind(plan), { now, ttlMs: 60000 }).id;
  assert.doesNotThrow(() => book.check(id, bind(plan), now));
  const mismatch = (e: unknown) => (e as { code?: string }).code === 'sentinel.receipt.mismatch';
  // A later plan, another stage set, another budget or another binding is not what the owner confirmed.
  for (const changed of [
    { ...plan, planDigest: 'sha256:' + 'd'.repeat(64) },
    { ...plan, stages: ['check', 'review-guided'] },
    { ...plan, model: { ...plan.model, budget: { ...plan.model.budget, maxTokens: 2000 } } },
    { ...plan, model: { ...plan.model, bindingDigest: 'sha256:' + 'e'.repeat(64) } },
    { ...plan, model: { ...plan.model, modelId: 'other' } },
  ])
    assert.throws(() => book.check(id, bind(changed), now), mismatch);
  assert.throws(
    () =>
      book.check(
        id,
        { ...runWriteBinding(ws, 'run.start', plan as never, { ...instance, storeId: 'store-2' }), policyRevision },
        now,
      ),
    mismatch,
    'another store',
  );

  // An envelope receipt fits exactly the envelope review/dispatch.ts opens: this store, run, plan digest and binding.
  const policy = trustedPolicy();
  const binding = bindProvider(policy, 'local-review', 'review');
  const envelope = envelopeBinding(binding, plan, 'store-1', policy.revision, plan.model.budget);
  const envelopeId = issueReceipt(book, OWNER, envelope, { now, ttlMs: 60000 }).id;
  assert.doesNotThrow(() => book.check(envelopeId, envelope, now));
  for (const other of [
    envelopeBinding(
      binding,
      { ...plan, planDigest: 'sha256:' + 'f'.repeat(64) },
      'store-1',
      policy.revision,
      plan.model.budget,
    ),
    envelopeBinding(binding, { ...plan, runId: 'run-other' }, 'store-1', policy.revision, plan.model.budget),
    envelopeBinding(binding, plan, 'store-2', policy.revision, plan.model.budget),
    envelopeBinding(binding, plan, 'store-1', policy.revision, { ...plan.model.budget, maxTokens: 999 }),
  ])
    assert.throws(() => book.check(envelopeId, other, now), mismatch);
  // The start receipt is not an envelope receipt, nor the other way round.
  assert.throws(() => book.check(id, envelope, now), mismatch);
  assert.throws(() => book.check(envelopeId, bind(plan), now), mismatch);
});

test(
  'a first scan is init, scan, scan --confirm, report: ids printed and never retyped, and reads go through the running service',
  needsStore,
  async (t) => {
    const dir = scratchDir(t, 'sentinel-scan-');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(
      join(ws, 'src/users.ts'),
      'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n',
    );
    const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
    mkdirSync(env.HOME);
    t.after(() => stopService(env));
    const run = owner(ws, env);
    assert.equal(run('init').status, 0);
    // The preview: the owner setup the scan still needs, every stage in order and where it runs; nothing happens.
    const preview = run('scan');
    assert.equal(preview.status, 4, preview.stderr);
    assert.match(preview.stdout, /first, as the owner: adopt the settings sha256:[0-9a-f]{64} and the pipeline/);
    assert.match(preview.stdout, /then, as the owner: promote the foundation-preview rule pack/);
    assert.match(preview.stdout, /4\. preview \(tool\) · runs child · local-artifacts/);
    assert.match(preview.stdout, /stages: the static profile's defaults \(settings-configured reviews included\)/);
    assert.match(preview.stdout, /to confirm as the owner: farsight-sentinel scan --confirm/);
    assert.equal(JSON.parse(run('scans', '--json').stdout).facts.scans.length, 0, 'the preview captured nothing');
    // One confirmation: adopt, promote, plan and run. The next command needs no id.
    const scanned = run('scan', '--confirm');
    assert.equal(scanned.status, 2, scanned.stderr + scanned.stdout);
    assert.match(scanned.stdout, /^plan run-[0-9a-f]{32} · sha256:[0-9a-f]{64}$/m);
    assert.match(scanned.stdout, /^run run-[0-9a-f]{32} · completed$/m);
    assert.match(scanned.stdout, /next: farsight-sentinel report$/m);
    const runId = /^run (run-[0-9a-f]{32})/m.exec(scanned.stdout)![1]!;
    const report = run('report');
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, new RegExp(runId));
    const scans = JSON.parse(run('scans', '--json').stdout).facts.scans;
    assert.deepEqual(
      scans.map((s: { id: string; state: string }) => [s.id, s.state]),
      [[runId, 'completed']],
    );
    const status = run('status');
    assert.match(status.stdout, new RegExp(`run ${runId} · completed`));
    // The run records which path its plan took: the static profile's own pipeline plans as its defaults.
    assert.match(status.stdout, /stages: the static profile's defaults \(settings-configured reviews included\)/);
    assert.deepEqual(JSON.parse(run('status', '--json').stdout).facts.pipeline, {
      path: 'default-of',
      profile: 'static',
    });

    // The three sides of the facade give the same answers on the same retained run: in this process, inside the
    // service over the store it holds, and through the service's operations (the remote side's connection).
    await facadeParity(ws, env, runId);
    const stage = JSON.parse(run('stage', 'show', 'preview', '--json').stdout);
    assert.equal(stage.outcome, 'answered');
    assert.ok(stage.facts.units.length >= 1);
    assert.ok(stage.facts.units.every((u: { state: string }) => u.state === 'published'));
    assert.equal(JSON.parse(run('stage', 'show', 'nope', '--json').stdout).reasonCode, 'sentinel.service.stageUnknown');

    // Changed source, in the background: the service starts on demand, plans on the owner's receipt and runs.
    writeFileSync(join(ws, 'src/orders.ts'), 'export const list = () => db.query("SELECT * FROM orders");\n');
    const detached = run('scan', '--confirm', '--detach');
    assert.equal(detached.status, 0, detached.stderr + detached.stdout);
    assert.match(detached.stdout, /next: farsight-sentinel wait$/m);
    const second = /^run (run-[0-9a-f]{32})/m.exec(detached.stdout)![1]!;
    assert.notEqual(second, runId);
    const waited = run('wait');
    assert.equal(waited.status, 2, waited.stderr);
    assert.match(waited.stdout, new RegExp(`run ${second} · completed`));
    // While the service runs: status, scans, report, the shareable full report and a plan go through it.
    assert.equal(JSON.parse(run('status', '--json').stdout).facts.runId, second);
    assert.equal(JSON.parse(run('scans', '--json').stdout).facts.scans[0].id, second);
    assert.equal(run('report').status, 0);
    const full = run('report', '--full', '--json');
    assert.equal(full.status, 0, full.stderr + full.stdout);
    const fullFacts = JSON.parse(full.stdout).facts;
    assert.deepEqual([fullFacts.runId, fullFacts.through, fullFacts.disclosure], [second, 'service', 'shareable']);
    assert.match(String(fullFacts.formatDigest), /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      JSON.parse(run('report', '--full', '--disclosure', 'private', '--json').stdout).reasonCode,
      'sentinel.service.ownerServiceRunning',
    );
    const planned = JSON.parse(run('plan', '--json').stdout);
    assert.deepEqual([planned.outcome, planned.facts.planId], ['kept', second]);
    assert.equal(
      JSON.parse(run('run', second, '--confirm', '--json').stdout).reasonCode,
      'sentinel.service.ownerServiceRunning',
    );
    stopService(env);
  },
);

test(
  'model stages start only on the owner composite: the service spends the receipts it is handed, issues none, and an agent scan opens nothing',
  needsStore,
  async (t) => {
    const dir = scratchDir(t, 'sentinel-models-');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'original.ts'), 'export const original = (x: string) => x;\n');
    const ep = await mockEndpoint(t, (q, r) => {
      const last = JSON.parse(JSON.parse(q.body).messages.at(-1).content),
        reply = last.evidence
          ? {
              action: 'final',
              verdict: 'finding',
              claims: [
                { statement: 'Original fixture review candidate.', citations: last.evidence.map((e: any) => e.id) },
              ],
              inspected: ['src/original.ts'],
            }
          : { action: 'read', path: 'src/original.ts', startLine: 1, endLine: 1 };
      json(r, 200, ollamaReply({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
    });
    const env = { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
    mkdirSync(env.HOME);
    t.after(() => stopService(env));
    const run = owner(ws, env);
    assert.equal(run('init').status, 0);
    const path = join(ws, '.farsight', 'sentinel', 'settings.json'),
      settings = JSON.parse(readFileSync(path, 'utf8')),
      fixture = trustedPolicy({ ollama: ep.origin }).settings;
    settings.providers = [structuredClone(fixture.providers[0])];
    settings.providers[0].models[0].capability.revision = null;
    settings.reviewModels = {
      stages: [
        { stage: 'guided', providerId: 'local-review', modelId: 'review' },
        { stage: 'general', providerId: 'local-review', modelId: 'review' },
      ],
      segments: [],
    };
    settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
    settings.grants[0].scope.effects = ['local-artifacts', 'paid-inference'];
    writeFileSync(path, JSON.stringify(settings));
    // The scan preview names the model it would call, with its runner and budget.
    const preview = run('scan');
    assert.equal(preview.status, 4, preview.stderr);
    assert.match(
      preview.stdout,
      /model for guided: ollama review-model:1 through local-review · budget 100000 tokens, 0 USD/,
    );
    assert.equal(run('settings', 'adopt', '--confirm').status, 0);
    assert.equal(run('rules', 'promote', 'builtin:foundation-preview', '--confirm').status, 0);
    const planned = JSON.parse(run('plan', '--json').stdout);
    assert.equal(planned.exitCode, 0, JSON.stringify(planned));
    const planId = planned.facts.planId as string;
    assert.equal(ep.seen.length, 0);

    const wsOf = workspaceOf(ws, env);
    const book = receiptBook(wsOf);
    const store = await openStore(join(ws, '.farsight', 'sentinel', 'store'));
    const service = new OwnerService(store, wsOf);
    try {
      const plan = await currentPlan(store, planId);
      assert.ok(plan?.effects.includes('paid-inference'));
      assert.deepEqual(plan!.stages, ['preview', 'review-general', 'review-guided']);
      const receipts = () =>
        readdirSync(book.directory)
          .filter((n) => n.endsWith('.json'))
          .sort();
      const sequence = store.ledger.currentSequence();
      // A connection cannot bring an owner principal: whatever a body says, the service builds the caller's
      // principal from the channel (an agent); a body naming one is refused before any facade method runs.
      const forgedOwner = { kind: 'owner', requestedBy: { principal: 'human', channel: 'owner-cli' } };
      for (const [op, body] of [
        ['scan', { confirm: true, principal: forgedOwner }],
        ['plan', { owner: forgedOwner }],
        ['scans', { principal: 'human' }],
        ['stage.read', { stageId: 'preview', requestedBy: forgedOwner }],
        ['start.preview', { runId: planId, channel: 'owner-cli' }],
      ] as const)
        await assert.rejects(
          service.handle(op, body, AGENT),
          (e: any) => e.code === 'sentinel.service.requestInvalid',
          op,
        );
      await assert.rejects(
        service.handle('scans', {}, { principal: 'human', channel: 'owner-cli' } as never),
        (e: any) => e.code === 'sentinel.service.requestInvalid',
        'the owner channel never reaches the service',
      );
      // An agent (any connection) cannot confirm a scan: owner-only, nothing captured, admitted or opened.
      const agentScan: any = await service.handle('scan', { confirm: true }, AGENT);
      assert.equal(agentScan.reasonCode, 'sentinel.admission.ownerOnly');
      assert.equal(store.ledger.currentSequence(), sequence);
      assert.equal(existsSync(join(store.storePath, 'review-budget.sqlite')), false, 'no envelope opened');
      // A start's preview is the composite the owner would confirm, read only.
      const shown: any = await service.handle('start.preview', { runId: planId }, AGENT);
      assert.equal(shown.outcome, 'awaiting-confirmation');
      assert.deepEqual(shown.facts.stages, ['preview', 'review-general', 'review-guided']);
      assert.equal(shown.facts.models[0].runner, 'ollama');
      assert.equal(shown.facts.requiredFlag, '--confirm-models');
      // Without --confirm-models nothing is issued.
      const waiting = confirmForService(wsOf, {
        command: 'run',
        action: 'run.start',
        plan,
        planId,
        confirm: true,
        now: new Date(),
        storeId: store.storeId,
        models: false,
      });
      assert.ok('result' in waiting && waiting.result.facts.requiredFlag === '--confirm-models');
      const before = receipts();
      const confirmed = confirmForService(wsOf, {
        command: 'run',
        action: 'run.start',
        plan,
        planId,
        confirm: true,
        now: new Date(),
        storeId: store.storeId,
        models: true,
      });
      if (!('receiptId' in confirmed)) assert.fail(JSON.stringify(confirmed));
      assert.equal(confirmed.envelopeReceipts.length, 1, 'one envelope for the run’s one binding');
      const issued = receipts();
      assert.equal(issued.length, before.length + 2, 'the start receipt and the envelope receipt');
      const spent = (id: string) => existsSync(join(book.directory, `${id}.spent`));
      // The start receipt alone, or with a receipt for another envelope: refused, nothing spent or opened.
      // A genuine owner receipt for the same binding's envelope of another plan.
      const adopted = adoptedPolicy(wsOf);
      if (!('policy' in adopted)) assert.fail('settings not adopted');
      const binding = bindProvider(adopted.policy, 'local-review', 'review');
      const elsewhere = issueReceipt(
        book,
        OWNER,
        envelopeBinding(
          binding,
          { runId: planId, planDigest: 'sha256:' + '0'.repeat(64) },
          store.storeId,
          adopted.policy.revision,
          plan!.model!.budget,
        ),
        { now: new Date(), ttlMs: 60000 },
      ).id;
      for (const [envelopeReceipts, code] of [
        [undefined, 'sentinel.review.foregroundRequired'],
        [[elsewhere], 'sentinel.receipt.mismatch'],
        [[confirmed.envelopeReceipts[0]!, elsewhere], 'sentinel.receipt.mismatch'],
      ] as const) {
        const r: any = await service.handle(
          'run.start',
          { planId, receiptId: confirmed.receiptId, ...(envelopeReceipts ? { envelopeReceipts } : {}) },
          AGENT,
        );
        assert.equal(r.reasonCode, code, JSON.stringify(r));
        assert.equal(spent(confirmed.receiptId), false);
        assert.equal(spent(confirmed.envelopeReceipts[0]!), false);
        assert.equal(store.ledger.currentSequence(), sequence);
        assert.equal(ep.seen.length, 0);
      }
      // The composite: the service spends the start receipt and the envelope receipt for exactly its envelope.
      const started: any = await service.handle(
        'run.start',
        { planId, receiptId: confirmed.receiptId, envelopeReceipts: [...confirmed.envelopeReceipts] },
        AGENT,
      );
      assert.equal(started.outcome, 'submitted', JSON.stringify(started));
      let done: any;
      for (let i = 0; i < 40; i++) {
        done = await service.handle('run.wait', { runId: planId, timeoutMs: 5000 }, AGENT);
        if (done.outcome !== 'submitted') break;
      }
      assert.equal(done.facts.state, 'completed', JSON.stringify(done));
      assert.equal(ep.seen.length, 4, 'both review modes ran through the service');
      assert.equal(spent(confirmed.receiptId), true);
      assert.equal(spent(confirmed.envelopeReceipts[0]!), true);
      assert.deepEqual(receipts(), [...issued, `${elsewhere}.json`].sort(), 'the service issued no receipt');
      const ledger = await BudgetLedger.open(join(store.storePath, 'review-budget.sqlite'));
      try {
        assert.equal(ledger.listEnvelopes({ runId: planId, limit: 10 }).length, 1);
      } finally {
        ledger.close();
      }
      const status: any = await service.handle('run.status', { runId: planId }, AGENT);
      assert.deepEqual(status.facts.pipeline, { path: 'default-of', profile: 'static' });
    } finally {
      await service.stop();
      store.close();
    }

    // The command line's own composite: scan --confirm --detach hands the run, its models included, to the service.
    writeFileSync(join(ws, 'src', 'original.ts'), 'export const original = (x: string) => x + "!";\n');
    // Asynchronously: the fixture model answers in this process, which a synchronous child would block.
    const detached = await ownerAsync(ws, env)('scan', '--confirm', '--detach');
    assert.equal(detached.status, 0, detached.stderr + detached.stdout);
    const waited = await ownerAsync(ws, env)('wait');
    assert.equal(waited.status, 2, waited.stderr + waited.stdout);
    // The changed file's reviews are new sessions (an unchanged one would replay its retained exchanges).
    assert.ok(ep.seen.length > 4, 'the detached service called the model for the second scan');
    const status = JSON.parse(run('status', '--json').stdout).facts;
    assert.equal(status.state, 'completed');
    stopService(env);

    // In the foreground the same composite: the model envelope is decided and its receipt issued with the start,
    // never as a stage dispatches, and the run's review runtime hands that receipt to its own envelope only.
    const listing = () => new Set(readdirSync(book.directory).filter((n) => n.endsWith('.json')));
    writeFileSync(join(ws, 'src', 'original.ts'), 'export const original = (x: string) => x.trim();\n');
    const foreground = JSON.parse(run('plan', '--json').stdout).facts.planId as string;
    const before = listing();
    const calls = ep.seen.length;
    const ran = await runPlan(wsOf, { planId: foreground, confirm: true, confirmModels: true, now: new Date() });
    assert.equal(ran.facts.state, 'completed', JSON.stringify(ran));
    assert.ok(ep.seen.length > calls, 'the foreground run called the model');
    const issued = [...listing()].filter((n) => !before.has(n));
    const actions = issued.map((n) => JSON.parse(readFileSync(join(book.directory, n), 'utf8')).action).sort();
    // The one envelope receipt (and the start's own when its grant asks for confirmation), nothing issued later.
    assert.equal(actions.filter((a) => a === 'paid.admit').length, 1, JSON.stringify(actions));
    assert.ok(
      actions.every((a) => a === 'paid.admit' || a === 'run.start'),
      JSON.stringify(actions),
    );
    for (const n of issued) assert.ok(existsSync(join(book.directory, n.replace(/\.json$/, '.spent'))), n);

    // A start whose model envelope the adopted grants refuse is refused before anything starts or is spent.
    settings.grants = settings.grants.filter((g: { actions: string[] }) => !g.actions.includes('paid.admit'));
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(run('settings', 'adopt', '--confirm').status, 0);
    writeFileSync(join(ws, 'src', 'original.ts'), 'export const original = (x: string) => x.toUpperCase();\n');
    const denied = JSON.parse(run('plan', '--json').stdout).facts.planId as string;
    const events = JSON.parse(run('status', denied, '--json').stdout).facts.cursor;
    const beforeDenied = listing();
    const callsBeforeDenied = ep.seen.length;
    const refused = await runPlan(wsOf, { planId: denied, confirm: true, confirmModels: true, now: new Date() });
    assert.equal(refused.outcome, 'configuration-failure', JSON.stringify(refused));
    assert.match(String(refused.reasonCode), /^sentinel\.admission\./);
    assert.equal(ep.seen.length, callsBeforeDenied, 'no model was called');
    assert.equal(JSON.parse(run('status', denied, '--json').stdout).facts.cursor, events, 'nothing started');
    assert.deepEqual(listing(), beforeDenied, 'no receipt issued');

    // A start that admission denies, with its model envelope allowed, leaves no model receipt either: both are decided
    // before the set is issued.
    settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
    settings.grants[0].actions = settings.grants[0].actions.filter((a: string) => a !== 'run.start');
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(run('settings', 'adopt', '--confirm').status, 0);
    writeFileSync(join(ws, 'src', 'original.ts'), 'export const original = (x: string) => x.toLowerCase();\n');
    const startDenied = JSON.parse(run('plan', '--json').stdout).facts.planId as string;
    const beforeStart = listing();
    const callsBeforeStart = ep.seen.length;
    const eventsBeforeStart = JSON.parse(run('status', startDenied, '--json').stdout).facts.cursor;
    const notStarted = await runPlan(wsOf, {
      planId: startDenied,
      confirm: true,
      confirmModels: true,
      now: new Date(),
    });
    assert.equal(notStarted.outcome, 'configuration-failure', JSON.stringify(notStarted));
    assert.match(String(notStarted.reasonCode), /^sentinel\.admission\./);
    assert.deepEqual(listing(), beforeStart, 'no envelope receipt for a start that was not admitted');
    assert.equal(ep.seen.length, callsBeforeStart);
    assert.equal(JSON.parse(run('status', startDenied, '--json').stdout).facts.cursor, eventsBeforeStart);
  },
);

/**
 * The Copilot provider and binding the demo runbook tells the owner to add (original fixture terms; the executable's
 * pins are the shipped profile's), the paid-inference effects on the owner's start, and the owner's paid admission.
 */
function copilotFragment(settings: any) {
  const P = COPILOT_NATIVE_PROFILE;
  settings.providers = [
    {
      id: 'native-copilot',
      kind: 'copilot-cli',
      endpoint: 'https://api.githubcopilot.com',
      credential: null,
      disclosure: 'hosted',
      copilotProfile: {
        id: P.id,
        executableDigest: P.executableDigest,
        runtimeDigest: P.runtimeDigest,
        profileDigest: 'sha256:' + 'a'.repeat(64),
      },
      budget: { maxTokens: 544000, maxCost: null, currency: null },
      models: [
        {
          id: 'luna',
          model: P.model,
          limits: {
            maxRequestBytes: 65536,
            maxResponseBytes: 16384,
            timeoutMs: 60000,
            maxOutputTokens: 512,
            contextTokens: 272000,
            maxMessages: 32,
            templateTokensPerMessage: 8,
          },
          pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
          terms: {
            retention: 'unknown',
            training: 'unknown',
            source: 'original fixture terms',
            recordedAt: '2026-10-23',
          },
          capability: {
            schema: 'sentinel-model-capability/draft-1',
            kind: 'copilot-cli',
            origin: 'https://api.githubcopilot.com',
            model: P.model,
            listed: true,
            revision: null,
            probedAt: '2026-10-23T00:00:00.000000000Z',
          },
        },
      ],
    },
  ];
  settings.reviewModels = {
    stages: [{ stage: 'general', providerId: 'native-copilot', modelId: 'luna' }],
    segments: [],
  };
  settings.grants[0].scope.effects = ['local-artifacts', 'paid-inference', 'source-disclosure', 'network'];
  settings.grants.push({
    actions: ['paid.admit'],
    principals: ['human'],
    confirm: 'always',
    scope: { providers: ['native-copilot'] },
  });
  return settings;
}

test(
  'the review profile needs no container: its scan plans one review unit and no scanner, and reaches the model',
  needsStore,
  async (t) => {
    const dir = scratchDir(t, 'sentinel-review-profile-');
    const ws = join(dir, 'ws');
    const bin = join(dir, 'bin');
    mkdirSync(ws);
    mkdirSync(bin);
    writeFileSync(join(ws, 'original.ts'), 'export const original = "inert source";\n');
    // A Copilot that is not the qualified executable, and a Docker: neither may ever run.
    const markers = { copilot: join(dir, 'copilot-called'), docker: join(dir, 'docker-called') };
    for (const [name, marker] of Object.entries(markers))
      writeFileSync(join(bin, name), `#!/bin/sh\necho bad > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
    // Below the command line, a container connection is refused and remembered: this scan must never ask for one.
    const preload = join(dir, 'deny-containers.mjs');
    writeFileSync(
      preload,
      `import{writeFileSync}from'node:fs';import{ContainerBackend}from${JSON.stringify(new URL('../dist/execution/isolation.js', import.meta.url).href)};ContainerBackend.connect=async()=>{writeFileSync(${JSON.stringify(markers.docker)},'attempted');throw Error('no container in this scan');};`,
    );
    const env = { HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state'), PATH: `${bin}:/usr/bin:/bin` };
    mkdirSync(env.HOME);
    t.after(() => stopService(env));
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, ['--import', preload, CLI, ...args], {
        cwd: ws,
        env,
        encoding: 'utf8',
        timeout: 120000,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const init = run('init', '--profile', 'review');
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /profile: review — a Copilot review of the captured source/);
    assert.match(init.stdout, /this profile reviews without a secrets scan/);
    assert.match(init.stdout, /no container runtime/);
    const path = join(ws, '.farsight', 'sentinel', 'settings.json');
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.hostedReviewSecretScan, 'when-selected');
    assert.deepEqual(written.mandatoryRules, []);
    // Before the provider: the preview names the declared stage, its runner and model, and that nothing binds it.
    const bare = run('scan');
    assert.equal(bare.status, 4, bare.stderr);
    assert.match(bare.stdout, /model for review: copilot-cli gpt-6-luna · not configured/);
    assert.match(bare.stdout, /review: no adopted provider binds this model stage/);
    writeFileSync(path, JSON.stringify(copilotFragment(written)));

    const preview = JSON.parse(run('scan', '--json').stdout);
    assert.equal(preview.outcome, 'awaiting-confirmation', JSON.stringify(preview));
    assert.equal(preview.facts.pipeline.path.kind, 'declared');
    assert.deepEqual(
      preview.facts.stages.map((s: { id: string; kind: string }) => `${s.id}:${s.kind}`),
      ['capture:builtin', 'parse:builtin', 'inventory:builtin', 'review:agent', 'report:builtin'],
    );
    assert.ok(!preview.facts.stages.some((s: { where: string }) => s.where === 'container'), 'no container stage');
    assert.deepEqual(preview.facts.models, [
      {
        stage: 'review',
        segmentId: null,
        providerId: 'native-copilot',
        modelId: 'luna',
        runner: 'copilot-cli',
        model: COPILOT_NATIVE_PROFILE.model,
        budget: { maxTokens: 544000, maxCost: null, currency: null },
        review: 'general',
      },
    ]);
    assert.deepEqual(preview.facts.pipeline.problems, [], 'the provider binds the declared stage');
    assert.deepEqual(
      preview.facts.setup.map((x: { kind: string; pack?: string }) => x.pack ?? x.kind),
      ['adopt', 'foundation-preview'],
    );

    // One confirmation: the setup, the capture, the plan and the model binding; then the run.
    const scanned = JSON.parse(run('scan', '--confirm', '--json').stdout);
    assert.ok(scanned.facts.runId, JSON.stringify(scanned));
    const runId = scanned.facts.runId as string;
    const status = JSON.parse(run('status', '--json').stdout);
    assert.equal(status.facts.pipeline.path, 'declared');
    // The review reached model admission past the secret-scan gate (there is no secret scan and the settings say a
    // hosted review need not wait for one); this Copilot is not the qualified executable, so it is held there.
    assert.deepEqual(
      status.facts.held.map((h: Record<string, string>) => [h.stage, h.reasonCode, h.detail]),
      [['review-general', 'sentinel.provider.capabilityUntested', 'native-copilot luna']],
    );
    // A held unit names its declared stage and the outputs it reads (what a stage-input reason's words need).
    assert.deepEqual(
      status.facts.held.map((h: Record<string, string>) => [h.declaredStage, h.inputs]),
      [['review', 'capture.source']],
    );
    assert.equal(
      sentinelExecutionWord('sentinel.execution.stageInputMissing', {
        stage: status.facts.held[0].declaredStage,
        inputs: status.facts.held[0].inputs,
      }),
      'a stage input this work reads was not published: review reads capture.source',
    );
    const store = await openStore(join(ws, '.farsight', 'sentinel', 'store'));
    try {
      const current = await currentPlan(store, runId);
      const admitted = await loadPlan(store, runId, current!.revision);
      const analysis = admitted.plan.units.filter((u: any) => u.adapterId);
      assert.deepEqual(
        admitted.plan.units.filter((u: any) => u.review).map((u: any) => u.review.selection.providerId),
        ['native-copilot'],
        'exactly one review unit',
      );
      assert.ok(
        !analysis.some((u: any) => /gitleaks|semgrep|osv|trivy|zizmor/.test(String(u.adapterId))),
        'no scanner unit',
      );
      assert.deepEqual(
        admitted.plan.pins.rules.map((r: any) => r.adapterId),
        [],
        'no rule is selected',
      );
    } finally {
      store.close();
    }
    const book = receiptBook(workspaceOf(ws, env));
    const paid = readdirSync(book.directory)
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(book.directory, n), 'utf8')))
      .filter((r) => r.action === 'paid.admit');
    assert.equal(paid.length, 1, "the composite's one model envelope receipt");
    assert.equal(existsSync(markers.docker), false, 'no container was asked for');
    assert.equal(existsSync(markers.copilot), false, 'the unqualified Copilot never ran');
  },
);
