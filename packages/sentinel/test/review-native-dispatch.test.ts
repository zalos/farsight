// A native agent stage dispatched from a scan. The foundation-preview path is planned canonically with the general
// review selected on an adopted native-mode pin: the review's spec seals its native stage, the coordinator hands the
// admitted unit to the pin's runner through the registry, and the run publishes through the same path a brokered
// review does: cited observations, one native review record, one agent provenance record (mode, transcript,
// secondary models, cost), and the retained transcript and instruction record. Claude's pending qualification
// refuses the plan unless the runner flag is on. No login and no model: with the installed Copilot 1.0.105 bytes
// (SENTINEL_COPILOT_CODE=1) the one sandboxed launch is intercepted and a fake child replays a recorded-shape stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { reviewRuntime } from '../dist/service/review-adapter.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { initWorkspace } from '../dist/cli/init.js';
import { loadPlan } from '../dist/execution/plans.js';
import { readReviewSpec, reviewSeedsFor } from '../dist/review/plan.js';
import { promoteStagePack } from '../dist/review/packs.js';
import { openSnapshot } from '../dist/snapshot/materialize.js';
import { publicRegistry } from '../dist/service/scanner-profile.js';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PROVENANCE_SCHEMA,
  NATIVE_INSTRUCTIONS_SCHEMA,
  NATIVE_REVIEW_SCHEMA,
  lineSpan,
  readPublishedNativeReview,
  runNativeReview,
} from '../dist/review/native-dispatch.js';
import { admitsMode, prepareAdmittedReview } from '../dist/review/dispatch.js';
import { bindProvider } from '../dist/review/providers/index.js';
import { executablePlan } from '../dist/execution/plan.js';
import { readPublishedInstructions } from '../dist/review/instructions.js';
import {
  COPILOT_1_0_105_PROFILE,
  COPILOT_AGENT_PROFILE,
  qualifyInstalledNativeCopilot,
} from '../dist/review/providers/cli-copilot-profile.js';
import { CLAUDE_AGENT_PROFILE } from '../dist/review/providers/cli-native-profile.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { needsStore, unlock } from './snapshot-helpers.ts';

const genuine = process.env.SENTINEL_COPILOT_CODE === '1';
const code = (c: string) => (e: any) => e?.code === c;
const D = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const SELECTOR = { host: 'https://github.com', login: 'original-fixture-user' };
const SKILL = fileURLToPath(new URL('./fixtures/stage-packs/skills/invoice-approvals', import.meta.url));
const UPSTREAM = 'export const upstream = (t: string) => t;\n';
const AUTH = 'export const check = (a: string, b: string) =>\n  a == b;\n';

const limits = (contextTokens: number) => ({
  maxRequestBytes: 65536,
  maxResponseBytes: 16384,
  timeoutMs: 60000,
  maxOutputTokens: 512,
  contextTokens,
  maxMessages: 32,
  templateTokensPerMessage: 8,
});
const capability = (kind: string, origin: string, model: string) => ({
  schema: 'sentinel-model-capability/draft-1',
  kind,
  origin,
  model,
  listed: true,
  revision: null,
  probedAt: '2026-10-28T00:00:00.000000000Z',
});
const TERMS = { retention: 'unknown', training: 'unknown', source: 'original fixture', recordedAt: '2026-10-28' };
const copilotProvider = (profileDigest: string) => ({
  id: 'native-copilot',
  kind: 'copilot-cli',
  endpoint: 'https://api.githubcopilot.com',
  credential: null,
  disclosure: 'hosted',
  copilotProfile: {
    id: COPILOT_AGENT_PROFILE.id,
    executableDigest: COPILOT_AGENT_PROFILE.executableDigest,
    runtimeDigest: COPILOT_AGENT_PROFILE.runtimeDigest,
    profileDigest,
  },
  budget: { maxTokens: 20000, maxCost: null, currency: null },
  models: [
    {
      id: 'luna',
      model: 'gpt-6-luna',
      limits: limits(272000),
      pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
      terms: TERMS,
      capability: capability('copilot-cli', 'https://api.githubcopilot.com', 'gpt-6-luna'),
    },
  ],
});
const claudeProvider = () => ({
  id: 'native-claude',
  kind: 'claude-cli',
  endpoint: 'https://api.anthropic.com',
  credential: 'keychain:farsight/claude-example',
  disclosure: 'hosted',
  nativeProfile: {
    id: CLAUDE_AGENT_PROFILE.id,
    executableDigest: CLAUDE_AGENT_PROFILE.executableDigest,
    helperDigest: D('synthetic-helper'),
    profileDigest: D('synthetic-profile'),
  },
  budget: { maxTokens: 60000, maxCost: null, currency: null },
  models: [
    {
      id: 'sonnet',
      model: 'claude-sonnet-5-5',
      limits: { ...limits(200000), maxOutputTokens: 8192 },
      pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
      terms: TERMS,
      capability: capability('claude-cli', 'https://api.anthropic.com', 'claude-sonnet-5-5'),
    },
  ],
});

/** A workspace with the foundation preview and the general review on `provider`, adopted, and its store. */
async function workspace(
  t: any,
  provider: any,
  extra: Record<string, unknown> = {},
  files: Readonly<Record<string, string>> = {},
) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-native-dispatch-')));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ws');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src/auth.ts'), AUTH);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(path, rel, '..'), { recursive: true });
    writeFileSync(join(path, rel), text);
  }
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  const file = join(path, '.farsight/sentinel/settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(
    file,
    JSON.stringify({
      ...settings,
      hostedReviewSecretScan: 'when-selected',
      grants: [
        ...(settings.grants ?? []),
        { actions: ['paid.admit'], principals: ['human'], confirm: 'never', scope: { providers: [provider.id] } },
      ],
      providers: [provider],
      reviewModels: {
        stages: [{ stage: 'general', providerId: provider.id, modelId: provider.models[0].id }],
        segments: [],
      },
      ...extra,
    }),
  );
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  promoteRulePack(ws, {
    packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
    confirm: true,
    now: new Date(),
  });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* closed */
    }
  });
  return { dir, path, ws, adopted, store };
}
const plan = (w: Awaited<ReturnType<typeof workspace>>, work: string) =>
  planWorkspaceCanonical(w.store, {
    workspace: w.path,
    trustDir: w.ws.trustDir,
    policy: (w.adopted as any).policy,
    scratchRoot: work,
    now: new Date(),
  });

test("a line span is that line's bytes without its break, the whole file without a line, refused past the end", () => {
  const bytes = Buffer.from(AUTH);
  assert.deepEqual(lineSpan(bytes, 1), { startByte: 0, endByte: 46 });
  assert.equal(bytes.subarray(lineSpan(bytes, 2).startByte, lineSpan(bytes, 2).endByte).toString(), '  a == b;');
  // The empty line after the final break is not a line of the file.
  assert.throws(() => lineSpan(bytes, 3), code('sentinel.review.outputSchema'));
  assert.deepEqual(lineSpan(bytes, null), { startByte: 0, endByte: bytes.byteLength });
  assert.throws(() => lineSpan(bytes, 4), code('sentinel.review.outputSchema'));
});

test(
  'on a pin that runs its own loop the review plans native: its spec seals the stage, runner, output and budget',
  needsStore,
  async (t) => {
    const w = await workspace(t, copilotProvider(D('synthetic-copilot-profile')));
    const work = scratchUnder(w.store);
    try {
      const planned = await plan(w, work);
      const { plan: admitted } = await loadPlan(w.store, planned.disclosure.runId, planned.disclosure.revision);
      const units = admitted.units.filter((u: any) => u.review);
      assert.equal(units.length, 1);
      const spec = await readReviewSpec(w.store, units[0]);
      assert.deepEqual(spec.native, {
        stage: 'review-general',
        runner: 'copilot-cli',
        produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
        // Copilot's turn and time bounds; the tokens are the provider's budget within the model's context.
        budget: { turns: 3, tokens: 20000, seconds: 120 },
      });
    } finally {
      removeScratch(work);
    }
  },
);

test(
  'a Claude native pin plans only with the runner flag on: its qualification record is pending its live acceptance',
  needsStore,
  async (t) => {
    const off = await workspace(t, claudeProvider(), { nativeClaudeReviewEnabled: false });
    const work = scratchUnder(off.store);
    try {
      await assert.rejects(plan(off, work), code('sentinel.provider.nativeClaudeDisabled'));
    } finally {
      removeScratch(work);
    }
    const on = await workspace(t, claudeProvider(), { nativeClaudeReviewEnabled: true });
    const work2 = scratchUnder(on.store);
    try {
      const planned = await plan(on, work2);
      const { plan: admitted } = await loadPlan(on.store, planned.disclosure.runId, planned.disclosure.revision);
      const spec = await readReviewSpec(
        on.store,
        admitted.units.find((u: any) => u.review),
      );
      assert.equal(spec.native?.runner, 'claude-cli');
      assert.deepEqual(spec.native?.budget, { turns: 4, tokens: 60000, seconds: 180 });
    } finally {
      removeScratch(work2);
    }
  },
);

/** Intercepts the one sandboxed Copilot native launch and replays a recorded-shape run over the scratch tree. */
function intercept(t: { after(fn: () => void): void }, launches: string[][]) {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof import('node:child_process');
  const real = cp.spawn;
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
  cp.spawn = ((...given: unknown[]) => {
    const [file, args] = given as [string, string[]];
    if (file !== '/bin/sh' || args?.[2] !== 'sentinel-copilot-agent') return (real as any).apply(cp, given);
    launches.push([...args]);
    const work = after(args, '-C'),
      share = after(args, '--share');
    writeFileSync(
      after(args, '--usage-output-file'),
      JSON.stringify({
        currentModel: 'gpt-6-luna',
        totalUserRequests: 1,
        modelMetrics: {
          'gpt-6-luna': {
            requests: { count: 2, cost: 1 },
            usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(share, '# Copilot CLI Session\n\noriginal share transcript\n', { mode: 0o600 });
    const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data }) + '\n';
    const answer = JSON.stringify({
      observations: [
        { path: 'src/auth.ts', line: 2, kind: 'risk', claim: 'The token is compared with ==.' },
        { path: 'upstream/auth.ts', line: 1, kind: 'note', claim: 'A captured file that merely sits under upstream/.' },
      ],
      inspected: ['src/auth.ts', 'upstream/auth.ts'],
    });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, pid: 2147483644, stdio: [stdin, stdout, stderr] });
    stdin.resume();
    stdin.on('finish', () => {
      stdout.end(
        [
          ev('assistant.turn_start', { turnId: '0' }),
          ev('model.call_start', { model: 'gpt-6-luna' }),
          ev('assistant.message', { model: 'gpt-6-luna', content: '', toolRequests: [{ name: 'view' }] }),
          ev('tool.execution_start', { toolName: 'view', arguments: { path: `${work}/src/auth.ts` } }),
          ev('tool.execution_complete', { success: true }),
          ev('tool.execution_start', { toolName: 'view', arguments: { path: `${work}/upstream/auth.ts` } }),
          ev('tool.execution_complete', { success: true }),
          ev('assistant.turn_end', { turnId: '0' }),
          ev('assistant.turn_start', { turnId: '1' }),
          ev('model.call_start', { model: 'gpt-6-luna' }),
          ev('assistant.message', { model: 'gpt-6-luna', phase: 'final_answer', content: answer }),
          ev('assistant.turn_end', { turnId: '1' }),
          JSON.stringify({ type: 'result', exitCode: 0 }) + '\n',
        ].join(''),
      );
      stderr.end(`Session exported to: ${share}\n`);
      setImmediate(() => child.emit('close', 0, null));
    });
    setImmediate(() => child.emit('spawn'));
    return child;
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  t.after(() => {
    cp.spawn = real;
    syncBuiltinESMExports();
  });
}

test(
  'a scan runs the native review through its runner and publishes observations, provenance and the retained run',
  { ...needsStore, skip: needsStore.skip || (!genuine && 'needs the installed Copilot 1.0.105 bytes; no login') },
  async (t) => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-native-dispatch-copilot-')));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, 'copilot'), { mode: 0o700 });
    writeFileSync(
      join(home, 'copilot/config.json'),
      JSON.stringify({ lastLoggedInUser: SELECTOR, loggedInUsers: [SELECTOR] }),
    );
    const prior = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = join(home, 'copilot');
    t.after(() => {
      if (prior === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = prior;
    });
    const runtime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 30000 }, COPILOT_AGENT_PROFILE);
    // A captured source file literally under `upstream/`: an ordinary input, cited and read back by its position.
    const w = await workspace(t, copilotProvider(runtime.profileDigest), {}, { 'upstream/auth.ts': UPSTREAM });
    const launches: string[][] = [];
    intercept(t, launches);
    const work = scratchUnder(w.store);
    const review = await reviewRuntime(w.store, w.ws, true);
    t.after(() => review.close());
    try {
      const planned = await plan(w, work);
      const runId = planned.disclosure.runId;
      const summary = await executeRun(w.store, runId, { scratchRoot: work, trustDir: w.ws.trustDir, review });
      assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
      assert.equal(launches.length, 1, 'one sandboxed Copilot process ran the whole native stage');
      const { plan: admitted } = await loadPlan(w.store, runId, planned.disclosure.revision);
      const unit = admitted.units.find((u: any) => u.review)!;
      const ref = { id: unit.id, revision: unit.revision };
      assert.equal(w.store.ledger.getWork(ref)!.state, 'published');
      const pub = w.store.ledger.getPublication(ref)!;
      const read = async (schema: string) => {
        const outs = pub.outputs.filter((o: any) => o.schema === schema);
        return Promise.all(outs.map(async (o: any) => JSON.parse((await w.store.readArtifact(o.id)).toString('utf8'))));
      };
      const [record] = await read(NATIVE_REVIEW_SCHEMA);
      const [provenance] = await read(AGENT_PROVENANCE_SCHEMA);
      const observations = await read('sentinel-observation/draft-1');
      // The native record binds the admitted unit and what came back.
      assert.equal(record.specDigest, unit.review.specDigest);
      assert.equal(record.attemptId, pub.attemptId);
      assert.deepEqual(record.filesRead, ['src/auth.ts', 'upstream/auth.ts']);
      assert.deepEqual(record.upstream, [], 'no bound upstream artifact');
      assert.deepEqual(record.secondaryModels, []);
      assert.deepEqual(record.output.value.inspected, ['src/auth.ts', 'upstream/auth.ts']);
      assert.deepEqual(
        record.observations,
        observations.map((o: any) => o.id),
      );
      // The provenance record: native mode, the pinned runner, the transcript, confirmed tokens, cost unobserved.
      assert.equal(provenance.kind, 'agent');
      assert.equal(provenance.mode, 'native');
      assert.equal(provenance.runner, 'copilot-cli');
      assert.equal(provenance.runnerVersion, '1.0.105');
      assert.equal(provenance.executableDigest, COPILOT_AGENT_PROFILE.executableDigest);
      assert.equal(provenance.where, 'sandboxed-cli');
      assert.deepEqual(provenance.unit, ref);
      assert.equal(provenance.attempt, pub.attemptId);
      assert.deepEqual(provenance.model, {
        requested: 'gpt-6-luna',
        reported: 'gpt-6-luna',
        identitySource: 'host-reported',
      });
      assert.deepEqual(provenance.tokens, { input: 1234, output: 56, certainty: 'confirmed' });
      assert.deepEqual(provenance.cost, { basis: 'unobserved', reason: 'subscription' });
      assert.deepEqual(provenance.wires, []);
      assert.equal(provenance.transcript, record.transcript);
      assert.equal(record.provenance, (await import('../dist/policy/digest.js')).canonicalDigest(provenance));
      // The retained run: the transcript and the instruction record are published with it.
      const ids = new Set(pub.outputs.map((o: any) => o.id));
      assert.ok(ids.has(record.transcript) && ids.has(record.instructions));
      const transcript = (await w.store.readArtifact(record.transcript)).toString('utf8');
      assert.match(transcript, /"final_answer"/);
      const instructions = JSON.parse((await w.store.readArtifact(record.instructions)).toString('utf8'));
      assert.equal(instructions.schema, NATIVE_INSTRUCTIONS_SCHEMA);
      assert.deepEqual(
        instructions.inputs.map((i: any) => i.relativePath),
        ['src/auth.ts', 'upstream/auth.ts'],
      );
      assert.deepEqual(
        provenance.read,
        unit.inputs.map((i: any) => i.content),
        'every allowed input, none dropped',
      );
      assert.match(instructions.task.text, /src\/auth\.ts/);
      // Two cited observations: one on line 2 of src/auth.ts, one on the captured upstream/auth.ts.
      assert.equal(observations.length, 2);
      const obs = observations.find((o: any) => o.evidence[0].relativePath === 'src/auth.ts')!;
      const under = observations.find((o: any) => o.evidence[0].relativePath === 'upstream/auth.ts')!;
      assert.equal(
        Buffer.from(UPSTREAM).subarray(under.evidence[0].span.startByte, under.evidence[0].span.endByte).toString(),
        UPSTREAM.trimEnd(),
      );
      assert.equal(obs.producer.kind, 'model-review');
      assert.equal(obs.producer.model.returnedModel, 'gpt-6-luna');
      assert.equal(obs.originalSeverity, 'risk');
      assert.equal(obs.message, 'The token is compared with ==.');
      assert.equal(obs.evidence.length, 1);
      const cited = Buffer.from(AUTH).subarray(obs.evidence[0].span.startByte, obs.evidence[0].span.endByte);
      assert.equal(cited.toString(), '  a == b;');
      assert.equal(obs.evidence[0].relativePath, 'src/auth.ts');
      // The attempt's usage is the settled reservation.
      const attempt = w.store.ledger.getAttempt(pub.attemptId)!;
      assert.deepEqual(attempt.envelope.usage, { certainty: 'confirmed', inputTokens: 1234, outputTokens: 56 });
      // Read back through the authenticating reader: the same record, provenance, stream and observations.
      const trace = await readPublishedNativeReview(w.store, ref);
      assert.equal(trace.authority, 'accepted-coordinator-native-review');
      assert.deepEqual(trace.record, record);
      assert.deepEqual(trace.provenance, provenance);
      assert.deepEqual(trace.observations, observations);
      assert.equal(Buffer.from(trace.transcript).toString('utf8'), transcript);
      assert.equal(trace.instructions.schema, NATIVE_INSTRUCTIONS_SCHEMA);
      // Neither reader accepts the other's publication, and a deterministic unit is no review at all.
      await assert.rejects(readPublishedInstructions(w.store, ref), code('sentinel.review.integrity'));
      const other = admitted.units.find((u: any) => !u.review && w.store.ledger.getPublication(u))!;
      await assert.rejects(
        readPublishedNativeReview(w.store, { id: other.id, revision: other.revision }),
        code('sentinel.review.integrity'),
      );
    } finally {
      removeScratch(work);
    }
  },
);

test(
  'a declared native stage gives its review its skills and budget; a brokered stage or another runner is refused',
  needsStore,
  async (t) => {
    const w = await workspace(t, copilotProvider(D('synthetic-copilot-profile')));
    const work = scratchUnder(w.store);
    try {
      const planned = await plan(w, work);
      const { plan: admitted } = await loadPlan(w.store, planned.disclosure.runId, planned.disclosure.revision);
      const deterministic = { ...admitted, units: admitted.units.filter((u: any) => !u.review) };
      const { snapshot } = await openSnapshot(w.store, admitted.pins.snapshotId!);
      const skill = promoteStagePack(w.ws.trustDir, SKILL, { confirm: true });
      const triage = {
        id: 'triage',
        kind: 'agent',
        mode: 'native',
        runner: 'copilot-cli',
        model: 'gpt-6-luna',
        fanOut: 'per-source',
        skills: ['skills/invoice-approvals@1'],
        budget: { turns: 2, tokens: 10000, seconds: 60 },
      };
      const seedsWith = (stage: any) =>
        reviewSeedsFor(deterministic, { snapshot }, (w.adopted as any).policy, publicRegistry(), [], {
          trustDir: w.ws.trustDir,
          stages: [stage],
          stageOf: { general: 'triage' },
        } as any);
      const built = seedsWith(triage);
      assert.equal(built.seeds.length, 1);
      const record = JSON.parse(
        Buffer.from(built.artifacts.find((a: any) => a.id === built.seeds[0].review.spec)!.bytes).toString('utf8'),
      );
      assert.deepEqual(record.spec.native, {
        stage: 'triage',
        runner: 'copilot-cli',
        skills: ['skills/invoice-approvals@1'],
        produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
        budget: { turns: 2, tokens: 10000, seconds: 60 },
      });
      assert.deepEqual(record.spec.packs, [{ ref: 'skills/invoice-approvals@1', digest: skill.digest }]);
      assert.throws(() => seedsWith({ ...triage, mode: 'brokered' }), code('sentinel.review.invalidInput'));
      assert.throws(() => seedsWith({ ...triage, runner: 'claude-cli' }), code('sentinel.review.invalidInput'));
      assert.throws(
        () => seedsWith({ ...triage, prompt: 'stages/review@1#instructions.md' }),
        code('sentinel.review.invalidInput'),
      );
    } finally {
      removeScratch(work);
    }
  },
);

const sha = (b: Uint8Array) => 'sha256:' + createHash('sha256').update(b).digest('hex');
/** A runner stand-in that seals a record and answers one claim on the input `cite` picks; no process, no model. */
const stubRunner = (cite: (inputs: readonly { relativePath: string }[]) => string) => ({
  id: 'copilot-cli' as const,
  modes: Object.freeze(['brokered', 'native'] as const),
  qualify: () => Promise.reject(Error('not used')),
  async run(stage: any, inputs: readonly { relativePath: string; bytes: Uint8Array }[], context: any) {
    const record = {
      schema: 'sentinel-native-instructions/draft-1',
      disclosure: 'private-only',
      withholding: 'accepted-secret-fold-before-read',
      stage: stage.id,
      instructions: { ref: null, digest: D('original instructions'), bytes: new Uint8Array([1]) },
      inputs: inputs.map((i) => ({ relativePath: i.relativePath, digest: sha(i.bytes) })),
      task: { digest: sha(Buffer.from('t')), text: 't' },
      skills: [],
      packs: [],
    };
    await context.native.retain(record);
    const path = cite(inputs);
    return {
      mode: 'native',
      output: {
        name: 'observations',
        schema: 'sentinel.review-observations/v1',
        value: { observations: [{ path, line: null, kind: 'note', claim: 'An original claim.' }], inspected: [path] },
      },
      transcript: Buffer.from('{}\n'),
      share: new Uint8Array(0),
      filesRead: [path],
      tools: [],
      instructions: new Uint8Array([1]),
      task: 't',
      packs: [],
      instructionRecord: record,
      skills: [],
      secondaryModels: [],
      provenance: {
        mode: 'native',
        runner: 'copilot-cli',
        runnerVersion: '1.0.105',
        profileId: COPILOT_AGENT_PROFILE.id,
        executableDigest: null,
        installation: null,
        model: { requested: 'gpt-6-luna', reported: 'gpt-6-luna', identitySource: 'host-reported' },
        promptDigest: D('original prompt'),
        skillDigests: [],
        turns: 1,
        tokens: { input: 1, output: 1, certainty: 'confirmed' },
        cost: { basis: 'unobserved', reason: 'subscription' },
        deadline: { grantedMs: 1000, usedMs: 1 },
        where: 'sandboxed-cli',
      },
    };
  },
});

test(
  'a claim on an upstream input has no captured location to cite, so it is refused and nothing publishes',
  needsStore,
  async (t) => {
    const w = await workspace(t, copilotProvider(D('synthetic-copilot-profile')));
    const work = scratchUnder(w.store);
    try {
      const planned = await plan(w, work);
      const { plan: admitted } = await loadPlan(w.store, planned.disclosure.runId, planned.disclosure.revision);
      const unit = admitted.units.find((u: any) => u.review)!;
      const spec = await readReviewSpec(w.store, unit);
      const run = (cite: (inputs: readonly { relativePath: string }[]) => string) =>
        runNativeReview({
          store: w.store,
          unit,
          attemptId: 'attempt-original',
          spec,
          runtime: { broker: {}, ledger: { reservationOf: () => null } } as any,
          envelope: { id: 'menv-original' } as any,
          binding: () => ({ model: 'gpt-6-luna' }) as any,
          runner: stubRunner(cite) as any,
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 60000,
          // One bound upstream artifact (here a captured file's bytes, standing in for a published output).
          stageInputs: [
            {
              decl: { stage: 'preview', output: 'findings' },
              state: 'resolved',
              artifacts: [spec.scope.files[0]!.content],
              producers: [],
              secretFold: 'applied',
            },
          ] as any,
        });
      await assert.rejects(
        run((inputs) => inputs.find((i) => i.relativePath.startsWith('upstream/'))!.relativePath),
        code('sentinel.review.outputSchema'),
      );
      // The same claim on a captured file publishes, with one authenticated citation.
      const published = await run(() => 'src/auth.ts');
      const observations = published.records.filter((r: any) => r.schema === 'sentinel-observation/draft-1');
      assert.equal(observations.length, 1);
      assert.equal((observations[0]!.value as any).evidence.length, 1);
      assert.deepEqual((observations[0]!.value as any).evidence[0].span, { startByte: 0, endByte: AUTH.length });
    } finally {
      removeScratch(work);
    }
  },
);

test(
  'the run resolves exactly the packs its admitted spec sealed: a trust folder that resolves other bytes is refused',
  needsStore,
  async (t) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-native-packs-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const [sealedDir, changedDir] = [join(dir, 'sealed'), join(dir, 'changed')];
    mkdirSync(sealedDir, { mode: 0o700 });
    mkdirSync(changedDir, { mode: 0o700 });
    const sealed = promoteStagePack(sealedDir, SKILL, { confirm: true });
    // The same reference, other bytes: a copy of the skill with one line changed and its manifest re-pinned.
    const copy = join(dir, 'invoice-approvals');
    mkdirSync(copy);
    const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8') + '\nOne more original line.\n';
    writeFileSync(join(copy, 'SKILL.md'), text);
    const manifest = JSON.parse(readFileSync(join(SKILL, 'sentinel-stage-pack.json'), 'utf8'));
    manifest.files = [{ path: 'SKILL.md', digest: sha(Buffer.from(text)) }];
    writeFileSync(join(copy, 'sentinel-stage-pack.json'), JSON.stringify(manifest));
    const changed = promoteStagePack(changedDir, copy, { confirm: true });
    assert.notEqual(changed.digest, sealed.digest);
    let calls = 0;
    const { COPILOT_RUNNER } = await import('../dist/review/runner.js');
    await assert.rejects(
      COPILOT_RUNNER.run(
        {
          id: 'triage',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'gpt-6-luna',
          skills: ['skills/invoice-approvals@1'],
          produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
          budget: { turns: 2, tokens: 1000, seconds: 30 },
        },
        [{ relativePath: 'src/auth.ts', bytes: Buffer.from(AUTH) }],
        {
          native: {
            broker: { runAgent: () => (calls++, Promise.reject(Error('never'))) } as any,
            envelope: {} as any,
            binding: { model: 'gpt-6-luna' } as any,
            operationId: 'op-original',
            trustDir: changedDir,
            retain: async () => {},
            packs: [{ ref: 'skills/invoice-approvals@1', digest: sealed.digest }],
          },
        },
      ),
      code('sentinel.review.packChanged'),
    );
    assert.equal(calls, 0, 'refused before the credential probe, any reservation or any launch');
  },
);

test(
  "the sealed mode and runner are the pin's before any envelope opens: a re-adopted brokered pin is refused",
  needsStore,
  async (t) => {
    const native = copilotProvider(D('synthetic-copilot-profile'));
    const w = await workspace(t, native);
    const work = scratchUnder(w.store);
    try {
      const planned = await plan(w, work);
      const runId = planned.disclosure.runId;
      const admitted = await loadPlan(w.store, runId, planned.disclosure.revision);
      const unit = admitted.plan.units.find((u: any) => u.review)!;
      const spec = await readReviewSpec(w.store, unit);
      // The pure check, every way round.
      const bind = (provider: any) => {
        const settings = JSON.parse(readFileSync(join(w.path, '.farsight/sentinel/settings.json'), 'utf8'));
        writeFileSync(
          join(w.path, '.farsight/sentinel/settings.json'),
          JSON.stringify({ ...settings, providers: [provider] }),
        );
        assert.equal(adoptWorkspaceSettings(w.ws, { confirm: true, now: new Date() }).outcome, 'prepared');
        const policy = (adoptedPolicy(w.ws) as any).policy;
        return { policy, binding: bindProvider(policy, provider.id, provider.models[0].id) };
      };
      const nativeBinding = bind(native).binding;
      assert.equal(admitsMode(spec, nativeBinding), true);
      assert.equal(admitsMode({ ...spec, native: { ...spec.native!, runner: 'claude-cli' } }, nativeBinding), false);
      assert.equal(admitsMode({ ...spec, native: undefined }, nativeBinding), false);
      const brokered = {
        ...native,
        copilotProfile: {
          id: COPILOT_1_0_105_PROFILE.id,
          executableDigest: COPILOT_1_0_105_PROFILE.executableDigest,
          runtimeDigest: COPILOT_1_0_105_PROFILE.runtimeDigest,
          profileDigest: D('synthetic-brokered-profile'),
        },
      };
      const { policy } = bind(brokered);
      assert.equal(admitsMode(spec, bindProvider(policy, brokered.id, 'luna')), false);
      // Through admission: the brokered pin refuses the native unit, and no envelope ever opens.
      let opened = 0;
      const lease = scratchUnder(w.store);
      try {
        const bound = await executablePlan(
          w.store,
          admitted,
          w.store.ledger.getRun(runId)!.envelope,
          planned.disclosure.revision,
          publicRegistry(w.ws.trustDir),
          lease,
        );
        await assert.rejects(
          prepareAdmittedReview(
            w.store,
            bound,
            { id: unit.id, revision: unit.revision },
            {
              trustDir: w.ws.trustDir,
              ledger: { loadCheckpoint: () => null } as any,
              broker: { openEnvelope: () => (opened++, Promise.reject(Error('never'))) } as any,
              currentPolicy: () => policy,
              requestedBy: { principal: 'human', channel: 'owner-cli' },
            },
          ),
          code('sentinel.execution.planInvalid'),
        );
      } finally {
        removeScratch(lease);
      }
      assert.equal(opened, 0, 'refused before the envelope opens');
      // The control: with the native pin adopted again, the same admission reaches the envelope.
      const again = bind(native).policy;
      const lease2 = scratchUnder(w.store);
      try {
        const bound = await executablePlan(
          w.store,
          admitted,
          w.store.ledger.getRun(runId)!.envelope,
          planned.disclosure.revision,
          publicRegistry(w.ws.trustDir),
          lease2,
        );
        await assert.rejects(
          prepareAdmittedReview(
            w.store,
            bound,
            { id: unit.id, revision: unit.revision },
            {
              trustDir: w.ws.trustDir,
              ledger: { loadCheckpoint: () => null } as any,
              broker: { openEnvelope: () => (opened++, Promise.reject(Error('never'))) } as any,
              currentPolicy: () => again,
              requestedBy: { principal: 'human', channel: 'owner-cli' },
            },
          ),
          /never/,
        );
      } finally {
        removeScratch(lease2);
      }
      assert.equal(opened, 1, 'the native pin reaches the envelope');
    } finally {
      removeScratch(work);
    }
  },
);

test(
  'a native stage reads at most 1024 inputs: 1024 run with every one in the provenance, 1025 refuse before launch',
  needsStore,
  async (t) => {
    const w = await workspace(t, copilotProvider(D('synthetic-copilot-profile')));
    const work = scratchUnder(w.store);
    try {
      const planned = await plan(w, work);
      const { plan: admitted } = await loadPlan(w.store, planned.disclosure.runId, planned.disclosure.revision);
      const unit = admitted.units.find((u: any) => u.review)!;
      const spec = await readReviewSpec(w.store, unit);
      assert.equal(spec.scope.files.length, 1);
      let runs = 0;
      const stub = stubRunner(() => 'src/auth.ts');
      const counted = { ...stub, run: (...args: any[]) => (runs++, (stub.run as any)(...args)) };
      const run = (upstream: number) =>
        runNativeReview({
          store: w.store,
          unit,
          attemptId: 'attempt-original',
          spec,
          runtime: { broker: {}, ledger: { reservationOf: () => null } } as any,
          envelope: { id: 'menv-original' } as any,
          binding: () => ({ model: 'gpt-6-luna' }) as any,
          runner: counted as any,
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 60000,
          stageInputs: [
            {
              decl: { stage: 'preview', output: 'findings' },
              state: 'resolved',
              artifacts: Array(upstream).fill(spec.scope.files[0]!.content),
              producers: [],
              secretFold: 'applied',
            },
          ] as any,
        });
      const at = await run(1023);
      assert.equal(runs, 1, 'the 1024th input still runs');
      const provenance = at.records.find((r: any) => r.schema === AGENT_PROVENANCE_SCHEMA)!.value as any;
      assert.equal(provenance.read.length, 1024, 'every allowed input is named, none dropped');
      await assert.rejects(run(1024), code('sentinel.review.invalidInput'));
      assert.equal(runs, 1, 'the 1025th refuses before the runner, so no probe, reservation or launch');
    } finally {
      removeScratch(work);
    }
  },
);
