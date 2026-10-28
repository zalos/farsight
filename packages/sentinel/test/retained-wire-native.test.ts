// The retained-wire controls for the 1.0.105 re-qualification: the brokered v6 turn on 1.0.105 and the native-v1
// stage run. Like retained-wire.test.ts, each records what one admitted run hands the operating system (argv with
// the seatbelt profile, environment, private state, the scratch tree, the piped prompt) and how the owned usage file,
// the JSONL stream and the share transcript come back, with machine paths and the proxy port as placeholders. The
// process launch is intercepted after admission and a fake child replays a recorded-shape stream: no login, no model.
//
// Genuine part only (SENTINEL_COPILOT_CODE=1): it qualifies the installed 1.0.105 bytes, found by digest.
// SENTINEL_RETAINED_WIRE_RECORD=1 rewrites the goldens from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { scratch } from './snapshot-helpers.ts';
import { DEFAULT_SETTINGS, parseSettings, effectivePolicy, ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { BudgetLedger, ModelBroker, bindProvider, envelopeIntent } from '../dist/review/providers/index.js';
import {
  COPILOT_1_0_105_PROFILE,
  COPILOT_AGENT_PROFILE,
  qualifyInstalledNativeCopilot,
} from '../dist/review/providers/cli-copilot-profile.js';
import { COPILOT_RUNNER, publicProvenance } from '../dist/review/runner.js';

const genuine = process.env.SENTINEL_COPILOT_CODE === '1';
const record = process.env.SENTINEL_RETAINED_WIRE_RECORD === '1';
const model = 'gpt-6-luna';
const SELECTOR = { host: 'https://github.com', login: 'original-fixture-user' };
const golden = (name: string) => new URL(`./fixtures/retained-wire/${name}.json`, import.meta.url);

function settingsFor(profile: { id: string; executableDigest: string; runtimeDigest: string }, digest: string) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    hostedApiReviewEnabled: false,
    grants: [
      { actions: ['paid.admit'], principals: ['human'], confirm: 'never', scope: { providers: ['native-copilot'] } },
    ],
    providers: [
      {
        id: 'native-copilot',
        kind: 'copilot-cli',
        endpoint: 'https://api.githubcopilot.com',
        credential: null,
        disclosure: 'hosted',
        copilotProfile: {
          id: profile.id,
          executableDigest: profile.executableDigest,
          runtimeDigest: profile.runtimeDigest,
          profileDigest: digest,
        },
        budget: { maxTokens: 816000, maxCost: null, currency: null },
        models: [
          {
            id: 'luna',
            model,
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
              source: 'original retained-wire declaration',
              recordedAt: '2026-10-27',
            },
            capability: {
              schema: 'sentinel-model-capability/draft-1',
              kind: 'copilot-cli',
              origin: 'https://api.githubcopilot.com',
              model,
              listed: true,
              revision: null,
              probedAt: '2026-10-27T00:00:00.000000000Z',
            },
          },
        ],
      },
    ],
  };
}

async function admitted(t: { after(fn: () => void): void }, profile: typeof COPILOT_1_0_105_PROFILE) {
  const dir = scratch(t, 'retained-wire-native-'),
    copilotHome = join(dir, 'copilot-home');
  mkdirSync(copilotHome, { mode: 0o700 });
  writeFileSync(
    join(copilotHome, 'config.json'),
    JSON.stringify({ lastLoggedInUser: SELECTOR, loggedInUsers: [SELECTOR] }),
  );
  const prior = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = copilotHome;
  t.after(() => {
    if (prior === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prior;
  });
  const runtime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 30000 }, profile);
  const parsed = parseSettings(Buffer.from(JSON.stringify(settingsFor(profile, runtime.profileDigest))));
  const policy = effectivePolicy({
    trust: 'adopted',
    settings: parsed,
    settingsDigest: canonicalDigest(parsed),
    repoConfig: null,
    repoConfigDigest: null,
  });
  const binding = bindProvider(policy, 'native-copilot', 'luna');
  const ledger = await BudgetLedger.open(join(dir, 'budget.sqlite'));
  t.after(() => ledger.close());
  const book = new ReceiptBook(join(dir, 'receipts'));
  const stateDigest = canonicalDigest({ retainedWire: 'original-state', profile: profile.id });
  const receipt = issueReceipt(
    book,
    { channel: 'owner-cli', principal: 'owner' },
    {
      intent: envelopeIntent(binding, 'original-run', binding.settingsBudget),
      stateDigest,
      policyRevision: policy.revision,
    },
    { now: new Date(), ttlMs: 60000 },
  );
  const broker = new ModelBroker({
    ledger,
    credentials: async () => {
      throw Error('a native subscription reads no credential');
    },
    epoch: 'original-epoch',
  });
  const envelope = await broker.openEnvelope({
    binding,
    policy,
    runId: 'original-run',
    budget: binding.settingsBudget,
    requestedBy: { principal: 'human', channel: 'owner-cli' },
    stateDigest,
    receipt: { book, id: receipt.id },
  });
  return { broker, envelope, binding, ledger };
}

interface Launch {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: string[];
  stdin: string;
  state: Record<string, string>;
  work: Record<string, string>;
}
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
const sha = (b: Buffer) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const tree = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = `${(statSync(p).mode & 0o777).toString(8)} ${sha(readFileSync(p))}`;
    }
  };
  walk(root);
  return out;
};

/** Intercepts the one sandboxed Copilot launch; `reply` writes what the CLI would and returns stdout/stderr bytes. */
function intercept(
  t: { after(fn: () => void): void },
  label: string,
  launches: Launch[],
  reply: (args: string[]) => { stdout: Buffer; stderr: Buffer },
) {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof import('node:child_process');
  const real = cp.spawn;
  cp.spawn = ((...given: unknown[]) => {
    const [file, args, options] = given as [string, string[], Record<string, any>];
    if (file !== '/bin/sh' || args?.[2] !== label) return (real as any).apply(cp, given);
    const owned = after(args, '--usage-output-file').replace(/\/state\/usage\.json$/, '');
    const state: Record<string, string> = {};
    for (const n of readdirSync(join(owned, 'state')).sort()) state[n] = readFileSync(join(owned, 'state', n), 'utf8');
    const work: Record<string, string> = existsSync(join(owned, 'work')) ? tree(join(owned, 'work')) : {};
    const launch: Launch = {
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [...options.stdio],
      stdin: '',
      state,
      work,
    };
    launches.push(launch);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, pid: 2147483646, stdio: [stdin, stdout, stderr] });
    const chunks: Buffer[] = [];
    stdin.on('data', (b: Buffer) => chunks.push(b));
    stdin.on('finish', () => {
      launch.stdin = Buffer.concat(chunks).toString('utf8');
      const out = reply(args);
      stdout.end(out.stdout);
      stderr.end(out.stderr);
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

function normalize<T>(value: T, launch: Launch, home: string): T {
  const owned = after(launch.args, '--usage-output-file').replace(/\/state\/usage\.json$/, '');
  const executable = launch.args[5]!;
  const port = /127\.0\.0\.1:(\d+)$/.exec(launch.env.HTTPS_PROXY ?? '')?.[1];
  assert(port);
  const text = (s: string) =>
    s
      .split(owned)
      .join('<owned>')
      .split(executable)
      .join('<executable>')
      .split(home)
      .join('<home>')
      .split(`localhost:${port}`)
      .join('localhost:<port>')
      .split(`127.0.0.1:${port}`)
      .join('127.0.0.1:<port>');
  const deep = (v: unknown): unknown =>
    typeof v === 'string'
      ? text(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
          : v;
  return deep(value) as T;
}

function compare(name: string, observed: unknown) {
  if (record) writeFileSync(golden(name), JSON.stringify(observed, null, 2) + '\n');
  assert.deepEqual(observed, JSON.parse(readFileSync(golden(name), 'utf8')));
}

const MESSAGES = Object.freeze([
  { role: 'system' as const, content: 'original retained-wire Sentinel prompt\nAnswer with one JSON object.' },
  { role: 'user' as const, content: 'original captured scope: src/original.ts' },
]);
const USAGE = (requests: number) =>
  JSON.stringify({
    currentModel: model,
    totalUserRequests: 1,
    modelMetrics: {
      [model]: {
        requests: { count: requests, cost: 1 },
        usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  });

test(
  'the brokered v6 turn re-qualified on 1.0.105 hands the OS the same retained launch on the 1.0.105 bytes',
  { skip: !genuine && 'needs the installed Copilot 1.0.105 bytes; no login' },
  async (t) => {
    const { broker, envelope, binding } = await admitted(t, COPILOT_1_0_105_PROFILE);
    const wire = broker.renderRequest(binding, MESSAGES, 512)!;
    const launches: Launch[] = [];
    intercept(t, 'sentinel-copilot', launches, (args) => {
      writeFileSync(after(args, '--usage-output-file'), USAGE(1), { mode: 0o600 });
      return { stdout: Buffer.from('original visible brokered reply\n'), stderr: Buffer.alloc(0) };
    });
    const reply = await broker.generate(envelope, binding, {
      operationId: 'original-retained-wire-turn-105',
      messages: MESSAGES,
      maxOutputTokens: 512,
      expectedWireDigest: canonicalDigest(wire),
      deadlineAt: Date.now() + 55000,
    });
    assert.equal(launches.length, 1);
    compare('copilot-1.0.105-brokered', {
      profile: COPILOT_1_0_105_PROFILE.id,
      launch: normalize(launches[0]!, launches[0]!, homedir()),
      reply: { content: reply.content, identity: reply.identity, usage: reply.usage },
      reservation: { state: reply.reservation.state, reserved: reply.reservation.tokens },
    });
  },
);

test(
  'the native-v1 stage run hands the OS its scratch tree, read-only tool set and piped task, and retains the stream',
  { skip: !genuine && 'needs the installed Copilot 1.0.105 bytes; no login' },
  async (t) => {
    const { broker, envelope, binding, ledger } = await admitted(t, COPILOT_AGENT_PROFILE);
    const launches: Launch[] = [];
    intercept(t, 'sentinel-copilot-agent', launches, (args) => {
      const work = after(args, '-C'),
        share = after(args, '--share');
      writeFileSync(after(args, '--usage-output-file'), USAGE(2), { mode: 0o600 });
      writeFileSync(share, '# Copilot CLI Session\n\noriginal share transcript\n', { mode: 0o600 });
      const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data }) + '\n';
      const answer = JSON.stringify({
        observations: [{ path: 'src/auth.ts', line: 2, kind: 'risk', claim: 'The token is compared with ==.' }],
        inspected: ['src/auth.ts'],
      });
      return {
        stdout: Buffer.from(
          [
            ev('assistant.turn_start', { turnId: '0' }),
            ev('model.call_start', { model }),
            ev('assistant.message', { model, content: '', toolRequests: [{ name: 'view' }] }),
            ev('tool.execution_start', { toolName: 'view', arguments: { path: `${work}/src/auth.ts` } }),
            ev('tool.execution_complete', { success: true }),
            ev('assistant.turn_end', { turnId: '0' }),
            ev('assistant.turn_start', { turnId: '1' }),
            ev('model.call_start', { model }),
            ev('assistant.message', { model, phase: 'final_answer', content: answer }),
            ev('assistant.turn_end', { turnId: '1' }),
            JSON.stringify({ type: 'result', exitCode: 0 }) + '\n',
          ].join(''),
        ),
        stderr: Buffer.from(`Session exported to: ${share}\n`),
      };
    });
    const stage = {
      id: 'review',
      kind: 'agent' as const,
      mode: 'native' as const,
      runner: 'copilot-cli' as const,
      model,
      produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
      budget: { turns: 3, tokens: 20000, seconds: 120 },
    };
    const inputs = [
      {
        relativePath: 'src/auth.ts',
        bytes: Buffer.from('export const check = (a: string, b: string) =>\n  a == b;\n'),
      },
      { relativePath: 'src/routes.ts', bytes: Buffer.from('export const routes = [];\n') },
    ];
    const ran = await COPILOT_RUNNER.run(stage, inputs, {
      native: { broker, envelope, binding, operationId: 'original-native-stage' },
    });
    assert.equal(ran.mode, 'native');
    if (ran.mode !== 'native') return;
    const result = ran;
    assert.equal(launches.length, 1, 'one sandboxed process for the whole native stage');
    assert.deepEqual(result.filesRead, ['src/auth.ts'], 'the transcript lists the files read');
    const totals = ledger.totals(envelope.id);
    assert.equal(totals.byState.settled, 1, 'the stage token budget was reserved and settled by the owned usage file');
    assert.match(
      result.provenance.installation?.executablePath ?? '',
      /\/copilot$/,
      'the exact path is kept privately',
    );
    const shown = publicProvenance(result.provenance);
    const { usedMs, ...deadline } = shown.deadline;
    assert(Number.isSafeInteger(usedMs) && usedMs >= 0);
    compare('copilot-1.0.105-native', {
      profile: COPILOT_AGENT_PROFILE.id,
      launch: normalize(launches[0]!, launches[0]!, homedir()),
      task: result.task,
      instructions: Buffer.from(result.instructions).toString('utf8'),
      output: result.output,
      tools: result.tools,
      provenance: { ...shown, deadline },
      transcriptBytes: result.transcript.byteLength,
      share: Buffer.from(result.share).toString('utf8'),
    });
  },
);
