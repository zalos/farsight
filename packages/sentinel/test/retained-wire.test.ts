// The retained-wire control for the qualified Copilot brokered profile (copilot-1.0.103-darwin-arm64-seatbelt-v6).
// It records what one admitted brokered turn hands the operating system: the exact /bin/sh → sandbox-exec argv with
// the seatbelt profile, the constructed environment, the two private state files, the piped Sentinel wire, and how
// the owned usage file is read back into a settled reservation. The golden file holds those bytes with the
// machine-local paths and the proxy port replaced by placeholders; any refactor of the CLI runner must leave them
// byte-identical. No login, no keychain read and no model call: the process launch is intercepted after admission,
// the selected account is a synthetic one, and the fake child writes a recorded usage file and visible reply.
//
// The genuine part needs the pinned 1.0.103 launcher first on PATH and its package cache (SENTINEL_COPILOT_CODE=1,
// as the other local Copilot code controls). SENTINEL_RETAINED_WIRE_RECORD=1 rewrites the golden from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scratch } from './snapshot-helpers.ts';
import { DEFAULT_SETTINGS, parseSettings, effectivePolicy, ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { BudgetLedger, ModelBroker, bindProvider, envelopeIntent } from '../dist/review/providers/index.js';
import { COPILOT_NATIVE_PROFILE, qualifyInstalledNativeCopilot } from '../dist/review/providers/cli-copilot-profile.js';

const GOLDEN = new URL('./fixtures/retained-wire/copilot-1.0.103-brokered.json', import.meta.url);
const model = COPILOT_NATIVE_PROFILE.model;
const genuine = process.env.SENTINEL_COPILOT_CODE === '1';
const record = process.env.SENTINEL_RETAINED_WIRE_RECORD === '1';
const MESSAGES = Object.freeze([
  { role: 'system' as const, content: 'original retained-wire Sentinel prompt\nAnswer with one JSON object.' },
  { role: 'user' as const, content: 'original captured scope: src/original.ts' },
  { role: 'assistant' as const, content: '{"action":"read","path":"src/original.ts"}' },
  { role: 'user' as const, content: 'original bounded evidence <untrusted>&</untrusted>' },
]);
const USAGE = Object.freeze({
  currentModel: model,
  totalUserRequests: 1,
  modelMetrics: {
    [model]: {
      requests: { count: 1, cost: 0 },
      usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  },
});
const REPLY = 'original visible brokered reply\n';
const SELECTOR = { host: 'https://github.com', login: 'original-fixture-user' };

export function settingsFor(profileDigest: string) {
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
          id: COPILOT_NATIVE_PROFILE.id,
          executableDigest: COPILOT_NATIVE_PROFILE.executableDigest,
          runtimeDigest: COPILOT_NATIVE_PROFILE.runtimeDigest,
          profileDigest,
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
    reviewModels: { stages: [{ stage: 'general', providerId: 'native-copilot', modelId: 'luna' }], segments: [] },
  };
}

interface Launch {
  file: string;
  args: string[];
  options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: string[] };
  stdin: string;
  state: Record<string, { mode: string; bytes: string }>;
  directories: Record<string, string[]>;
}

/** One intercepted launch of the Copilot sandbox; every other spawn is the real one. */
function interceptCopilotSpawn(t: { after(fn: () => void): void }, launches: Launch[]) {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof import('node:child_process');
  const real = cp.spawn;
  const fake = (...given: unknown[]) => {
    const [file, args, options] = given as [string, string[], Record<string, any>];
    if (file !== '/bin/sh' || args?.[2] !== 'sentinel-copilot') return (real as any).apply(cp, given);
    const owned = args[args.indexOf('--usage-output-file') + 1]!.replace(/\/state\/usage\.json$/, '');
    const state: Launch['state'] = {};
    for (const name of readdirSync(join(owned, 'state')).sort()) {
      const path = join(owned, 'state', name);
      state[name] = { mode: (statSync(path).mode & 0o777).toString(8), bytes: readFileSync(path, 'utf8') };
    }
    const directories: Launch['directories'] = {};
    for (const d of ['home', 'tmp']) directories[d] = readdirSync(join(owned, d)).sort();
    const launch: Launch = {
      file,
      args: [...args],
      options: {
        cwd: options.cwd,
        env: { ...options.env },
        detached: options.detached,
        stdio: [...options.stdio],
      },
      stdin: '',
      state,
      directories,
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
      writeFileSync(args[args.indexOf('--usage-output-file') + 1]!, JSON.stringify(USAGE), { mode: 0o600 });
      stdout.end(Buffer.from(REPLY));
      stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  cp.spawn = fake as typeof cp.spawn;
  syncBuiltinESMExports();
  t.after(() => {
    cp.spawn = real;
    syncBuiltinESMExports();
  });
}

/** Machine-local paths and the ephemeral proxy port become placeholders; nothing else is touched. */
export function normalizeLaunch(launch: Launch, home: string) {
  const owned = launch.args[launch.args.indexOf('--usage-output-file') + 1]!.replace(/\/state\/usage\.json$/, '');
  const executable = launch.args[5]!;
  const port = /127\.0\.0\.1:(\d+)$/.exec(launch.options.env.HTTPS_PROXY ?? '')?.[1];
  assert(port, 'the proxy port is in the constructed environment');
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
  return deep(launch) as Launch;
}

test(
  'the qualified Copilot brokered turn hands the OS the retained argv, seatbelt profile, environment, state files, wire and usage capture',
  { skip: !genuine && 'needs the pinned Copilot 1.0.103 launcher first on PATH and its package cache; no login' },
  async (t) => {
    const dir = scratch(t, 'retained-wire-'),
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
    const runtime = await qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 20000 });
    const parsed = parseSettings(Buffer.from(JSON.stringify(settingsFor(runtime.profileDigest))));
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
    const stateDigest = canonicalDigest({ retainedWire: 'original-state' });
    const budget = binding.settingsBudget;
    const receipt = issueReceipt(
      book,
      { channel: 'owner-cli', principal: 'owner' },
      { intent: envelopeIntent(binding, 'original-run', budget), stateDigest, policyRevision: policy.revision },
      { now: new Date(), ttlMs: 60000 },
    );
    const broker = new ModelBroker({
      ledger,
      credentials: async () => {
        throw Error('a native subscription reads no credential');
      },
      epoch: 'original-epoch',
    });
    const env = await broker.openEnvelope({
      binding,
      policy,
      runId: 'original-run',
      budget,
      requestedBy: { principal: 'human', channel: 'owner-cli' },
      stateDigest,
      receipt: { book, id: receipt.id },
    });
    const wire = broker.renderRequest(binding, MESSAGES, 512)!;
    const launches: Launch[] = [];
    interceptCopilotSpawn(t, launches);
    const reply = await broker.generate(env, binding, {
      operationId: 'original-retained-wire-turn',
      messages: MESSAGES,
      maxOutputTokens: 512,
      expectedWireDigest: canonicalDigest(wire),
      deadlineAt: Date.now() + 55000,
    });
    assert.equal(launches.length, 1, 'exactly one sandboxed process per brokered turn');
    const observed = {
      profile: COPILOT_NATIVE_PROFILE.id,
      wire,
      wireDigest: canonicalDigest(wire),
      launch: normalizeLaunch(launches[0]!, homedir()),
      usageFile: JSON.stringify(USAGE),
      reply: {
        content: reply.content,
        finish: reply.finish,
        truncated: reply.truncated,
        identity: reply.identity,
        usage: reply.usage,
      },
      reservation: {
        state: reply.reservation.state,
        reservedTokens: reply.reservation.tokens,
        accountingBasis: reply.reservation.accountingBasis ?? null,
        usedInputTokens: reply.reservation.usedInputTokens,
        usedOutputTokens: reply.reservation.usedOutputTokens,
        usedCostNanos: reply.reservation.usedCostNanos === null ? null : String(reply.reservation.usedCostNanos),
      },
    };
    if (record) writeFileSync(GOLDEN, JSON.stringify(observed, null, 2) + '\n');
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(observed, golden);
  },
);
