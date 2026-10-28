// Claude Code native mode (claude-code-2.1.282-darwin-arm64-native-v1): the argv, the stream-json monitor, the binding
// bounds, the release gate and its qualification record, the multi-connection proxy, zero contact under the native-v1
// seatbelt, and (with the installed bytes, SENTINEL_CLAUDE_CODE=1) the isolation controls and the recorded-wire replay
// of one admitted run. No login, no model call: the process launch is intercepted and a fake child replays a
// recorded-shape stream; the token is a synthetic value from a fake credential source.
// SENTINEL_RETAINED_WIRE_RECORD=1 rewrites the golden from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { scratch } from './snapshot-helpers.ts';
import { D, TERMS } from './provider-helpers.ts';
import { DEFAULT_SETTINGS, parseSettings, effectivePolicy, ReceiptBook } from '../dist/policy/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { BudgetLedger, ModelBroker, bindProvider, envelopeIntent } from '../dist/review/providers/index.js';
import { cliKind } from '../dist/review/providers/registry.js';
import { safeInputPath } from '../dist/review/providers/cli-copilot-agent.js';
import { COPILOT_AGENT_PROFILE } from '../dist/review/providers/cli-copilot-profile.js';
import {
  CLAUDE_AGENT_PROFILE,
  CLAUDE_NATIVE_PROFILE,
  CLAUDE_PROFILES,
  claudeAgentEnvironment,
  claudeAgentSeatbeltPolicy,
  claudeProfileById,
  claudeProfileMode,
  cleanupNativeClaudeSetup,
  nativeClaudeAgentSetup,
  qualifyInstalledNativeClaude,
} from '../dist/review/providers/cli-native-profile.js';
import {
  CLAUDE_DENIED_TOOLS,
  CLAUDE_OUTPUT_TOOL,
  CLAUDE_READ_TOOLS,
  CLAUDE_STAGE_PLUGIN,
  CLAUDE_STAGE_PLUGIN_MANIFEST,
  ClaudeAgentDecoder,
  claudeAgentArguments,
} from '../dist/review/providers/cli-native-agent.js';
import { sandboxArgv } from '../dist/review/providers/sandboxed-cli.js';
import { nativeOutputSchema } from '../dist/review/native.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openNativeClaudeProxy } from '../dist/review/providers/cli-native-proxy.js';
import { RUNNER_QUALIFICATIONS, runnerQualification, runnerQualified } from '../dist/review/qualification.js';
import { CLAUDE_RUNNER, NativeRunFailure, publicProvenance } from '../dist/review/runner.js';
import { promoteStagePack } from '../dist/review/packs.js';

const code = (c: string) => (e: any) => e?.code === c;
const genuine = process.env.SENTINEL_CLAUDE_CODE === '1';
const record = process.env.SENTINEL_RETAINED_WIRE_RECORD === '1';
const model = 'claude-sonnet-5-5';
const WORK = '/private/tmp/sentinel-claude-agent-original/work';
const SCHEMA = JSON.stringify({ type: 'object' });
const golden = new URL('./fixtures/retained-wire/claude-2.1.282-native.json', import.meta.url);
/** A synthetic token: printable ASCII, never a real one. It must reach descriptor 3 and nothing else. */
const TOKEN = 'original-synthetic-claude-token-' + 'x'.repeat(40);
const REF = 'keychain:farsight/claude-example';

const line = (v: unknown) => JSON.stringify(v) + '\n';
const init = (m = model) => line({ type: 'system', subtype: 'init', cwd: WORK, model: m, tools: CLAUDE_READ_TOOLS });
const assistant = (id: string, content: unknown[], m: string = model) =>
  line({ type: 'assistant', message: { id, role: 'assistant', model: m, content } });
const toolUse = (name: string, input: unknown, id = 'toolu_' + name) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, isError = false) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, ...(isError ? { is_error: true } : {}) }],
    },
  });
const ANSWER = Object.freeze({
  observations: [{ path: 'src/a.ts', line: 1, kind: 'note', claim: 'An original constant is exported.' }],
  inspected: ['src/a.ts'],
});
const result = (over: Record<string, unknown> = {}) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: '',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 900, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 80 },
    modelUsage: {
      [model]: { inputTokens: 900, cacheCreationInputTokens: 100, cacheReadInputTokens: 0, outputTokens: 80 },
    },
    structured_output: ANSWER,
    ...over,
  });
const STREAM = [
  init(),
  assistant('msg_1', [toolUse('Read', { file_path: WORK + '/src/a.ts' }), toolUse('Glob', { pattern: '**/*.ts' })]),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Read' }] } }),
  assistant('msg_2', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)]),
  result(),
].join('');
const decode = (text: string, maxTurns = 4) => {
  const d = new ClaudeAgentDecoder(WORK, maxTurns);
  d.push(Buffer.from(text));
  return { d, out: () => d.finish() };
};

test('native argv: only Read and Glob, every runner and writer denied, restricted, no hooks, no MCP, never bare', () => {
  const args = claudeAgentArguments({
    systemPromptPath: '<owned>/system.txt',
    workDir: '<owned>/work',
    model,
    maxTurns: 4,
    maxUsd: '0.50',
    jsonSchema: SCHEMA,
    pluginDir: '<owned>/work/.claude/sentinel-stage',
  });
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual([...CLAUDE_READ_TOOLS], ['Read', 'Glob']);
  assert.equal(after('--tools'), 'Read,Glob');
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task'])
    assert.ok(CLAUDE_DENIED_TOOLS.includes(t));
  assert.equal(after('--disallowedTools'), CLAUDE_DENIED_TOOLS.join(','));
  assert.ok(args.includes('--restricted') && args.includes('--strict-mcp-config') && args.includes('--print'));
  assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(after('--settings'), '{"disableAllHooks":true}');
  assert.equal(after('--permission-mode'), 'dontAsk');
  assert.equal(after('--permission-prompts'), 'none');
  assert.equal(after('--plugin-dir'), '<owned>/work/.claude/sentinel-stage', 'skills arrive as one session plugin');
  assert.ok(!args.includes('--setting-sources'), 'restricted mode reads no settings source; none is named');
  assert.equal(after('--output-format'), 'stream-json');
  assert.equal(after('--max-turns'), '4');
  assert.equal(after('--max-budget-usd'), '0.50');
  assert.equal(after('--json-schema'), SCHEMA);
  assert.equal(after('--system-prompt-file'), '<owned>/system.txt');
  assert.equal(after('--add-dir'), '<owned>/work');
  assert.ok(args.includes('--no-session-persistence'));
  for (const never of ['--bare', '--dangerously-skip-permissions', '--safe-mode', '--disable-slash-commands'])
    assert.ok(!args.includes(never), never);
  const uncapped = claudeAgentArguments({
    systemPromptPath: 's',
    workDir: 'w',
    model,
    maxTurns: 1,
    jsonSchema: SCHEMA,
  });
  assert.ok(!uncapped.includes('--max-budget-usd'), 'no dollar cap unless the stage names one');
  assert.ok(!uncapped.includes('--plugin-dir'), 'no plugin without promoted skills');
});

test('the stream monitor reads the reads, the turns, the schema-checked answer and every model the run used', () => {
  const r = decode(STREAM).out();
  assert.equal(r.reportedModel, model);
  assert.deepEqual(JSON.parse(r.finalAnswer), ANSWER);
  assert.equal(r.turns, 2);
  assert.deepEqual(r.filesRead, ['src/a.ts']);
  assert.deepEqual(
    r.tools.map((t: any) => [t.tool, t.path]),
    [
      ['Read', 'src/a.ts'],
      ['Glob', null],
      [CLAUDE_OUTPUT_TOOL, null],
    ],
  );
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 80, requests: 2 });
  // A background model counts too: the larger of the loop's usage and the per-model sum.
  const both = decode(
    STREAM.replace(
      result(),
      result({
        modelUsage: {
          [model]: { inputTokens: 900, cacheCreationInputTokens: 100, cacheReadInputTokens: 0, outputTokens: 80 },
          'claude-small-background': { inputTokens: 500, outputTokens: 20 },
        },
      }),
    ),
  ).out();
  assert.deepEqual(both.usage, { inputTokens: 1500, outputTokens: 100, requests: 2 });
});

test('the stream monitor stops the run on a tool, path, turn, identity or answer outside the profile', () => {
  const bad: [string, string, string][] = [
    ['Bash', assistant('m', [toolUse('Bash', { command: 'id' })]), 'sentinel.provider.malformedResponse'],
    [
      'Write',
      assistant('m', [toolUse('Write', { file_path: WORK + '/x', content: '' })]),
      'sentinel.provider.malformedResponse',
    ],
    [
      'Read outside',
      assistant('m', [toolUse('Read', { file_path: '/etc/passwd' })]),
      'sentinel.provider.malformedResponse',
    ],
    [
      'Read parent',
      assistant('m', [toolUse('Read', { file_path: WORK + '/../system.txt' })]),
      'sentinel.provider.malformedResponse',
    ],
    [
      'Read extra key',
      assistant('m', [toolUse('Read', { file_path: WORK + '/a', pages: '1' })]),
      'sentinel.provider.malformedResponse',
    ],
    [
      'Glob absolute',
      assistant('m', [toolUse('Glob', { pattern: '/Users/**' })]),
      'sentinel.provider.malformedResponse',
    ],
    ['Glob parent', assistant('m', [toolUse('Glob', { pattern: '../**' })]), 'sentinel.provider.malformedResponse'],
    [
      'Glob path outside',
      assistant('m', [toolUse('Glob', { pattern: '*', path: '/private/tmp' })]),
      'sentinel.provider.malformedResponse',
    ],
    [
      'output not an object',
      assistant('m', [toolUse(CLAUDE_OUTPUT_TOOL, 'text')]),
      'sentinel.provider.malformedResponse',
    ],
  ];
  for (const [name, event, c] of bad) assert.throws(() => decode(init() + event), code(c), name);
  // One more model request than the stage allows.
  assert.throws(
    () => decode(init() + assistant('a', []) + assistant('b', []) + assistant('c', []), 2),
    code('sentinel.provider.budgetExhausted'),
  );
  // Repeated stream events of one message are one turn.
  assert.doesNotThrow(() => decode(init() + assistant('a', []) + assistant('a', []) + assistant('b', []), 2));
  // Answers: an error result, a text-only result, another model, missing usage, an event after the result.
  const answered = init() + assistant('m', []);
  for (const [name, text, c] of [
    ['error result', answered + result({ is_error: true }), 'sentinel.provider.malformedResponse'],
    [
      'text only',
      answered + result({ structured_output: undefined, result: '{}' }),
      'sentinel.provider.malformedResponse',
    ],
    [
      'another model',
      answered + result({ modelUsage: { other: { inputTokens: 1, outputTokens: 1 } } }),
      'sentinel.provider.identityMismatch',
    ],
    ['usage missing', answered + result({ usage: { input_tokens: 1 } }), 'sentinel.provider.malformedResponse'],
    ['no answering message', init() + result(), 'sentinel.provider.identityMismatch'],
  ] as const)
    assert.throws(() => decode(text).out(), code(c), name);
  assert.throws(() => decode(STREAM + init()), code('sentinel.provider.malformedResponse'), 'nothing after the result');
  assert.throws(() => decode(init() + init()), code('sentinel.provider.identityMalformed'), 'one init');
  const d = new ClaudeAgentDecoder(WORK, 4);
  assert.throws(() => d.push(Buffer.from([0xff, 0x0a])), code('sentinel.provider.malformedResponse'), 'strict UTF-8');
  // The partial ledger a failed run keeps: what was read before the refusal.
  const partial = new ClaudeAgentDecoder(WORK, 4);
  partial.push(
    Buffer.from(
      init() + assistant('m1', [toolUse('Read', { file_path: WORK + '/src/a.ts' })]) + toolResult('toolu_Read'),
    ),
  );
  assert.throws(() => partial.push(Buffer.from(assistant('m2', [toolUse('Bash', { command: 'id' })]))));
  assert.deepEqual(partial.partial().filesRead, ['src/a.ts']);
  assert.equal(partial.partial().turns, 2);
});

test('the identity is the model that answered, never the one init names; other models are kept apart', () => {
  // Sol's replay: init says Sonnet, the answering message says Haiku. Refused, never reported as Sonnet.
  const haiku = 'claude-haiku-4-5-20251001';
  const swapped = init() + assistant('m1', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)], haiku) + result();
  assert.throws(() => decode(swapped).out(), code('sentinel.provider.identityMismatch'));
  // Two answering models in one run: refused.
  const mixed =
    init() + assistant('m1', [], model) + assistant('m2', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)], haiku) + result();
  assert.throws(() => decode(mixed).out(), code('sentinel.provider.identityMismatch'));
  // An answering message without a model: malformed.
  assert.throws(
    () => decode(init() + line({ type: 'assistant', message: { id: 'm1', content: [] } })),
    code('sentinel.provider.identityMalformed'),
  );
  // The alias answering as its own dated snapshot is that snapshot, with its usage; a background model is secondary.
  const dated = model + '-20261001';
  const snapshot = decode(
    init() +
      assistant('m1', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)], dated) +
      result({
        modelUsage: {
          [dated]: { inputTokens: 900, cacheCreationInputTokens: 100, cacheReadInputTokens: 0, outputTokens: 80 },
          'claude-small-background': { inputTokens: 5, outputTokens: 1 },
        },
      }),
  ).out();
  assert.equal(snapshot.reportedModel, dated);
  assert.deepEqual(snapshot.secondaryModels, ['claude-small-background']);
  // The answering model must have reported usage.
  assert.throws(
    () =>
      decode(
        init() + assistant('m1', [], dated) + result({ modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } } }),
      ).out(),
    code('sentinel.provider.identityMismatch'),
  );
});

test('a file is read only when a Read of it succeeded: a Glob naming it, or a failed Read, reads nothing', () => {
  // Sol's replay: only `Glob {path: "src/a.ts"}`, then an answer citing src/a.ts as inspected.
  const globOnly = decode(
    init() +
      assistant('m1', [toolUse('Glob', { pattern: '*', path: 'src/a.ts' })]) +
      toolResult('toolu_Glob') +
      assistant('m2', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)]) +
      result(),
  ).out();
  assert.deepEqual(globOnly.filesRead, []);
  assert.throws(
    () =>
      nativeOutputSchema('sentinel.review-observations/v1').validate(
        ANSWER,
        new Set(['src/a.ts']),
        new Set(globOnly.filesRead),
      ),
    code('sentinel.review.outputSchema'),
    'an observation on a file the transcript never read fails the stage schema',
  );
  // A Read whose result is an error, or that never got a result, reads nothing; a successful one reads its file.
  const failed = decode(
    init() +
      assistant('m1', [
        toolUse('Read', { file_path: WORK + '/src/missing.ts' }, 'toolu_r1'),
        toolUse('Read', { file_path: WORK + '/src/pending.ts' }, 'toolu_r2'),
        toolUse('Read', { file_path: WORK + '/src/a.ts' }, 'toolu_r3'),
      ]) +
      toolResult('toolu_r1', true) +
      toolResult('toolu_r3') +
      assistant('m2', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)]) +
      result(),
  ).out();
  assert.deepEqual(failed.filesRead, ['src/a.ts']);
  // A result for a tool use never issued, or a tool-use id issued twice, is refused.
  assert.throws(() => decode(init() + toolResult('toolu_never')), code('sentinel.provider.malformedResponse'));
  assert.throws(
    () =>
      decode(
        init() +
          assistant('m1', [toolUse('Read', { file_path: WORK + '/src/a.ts' }, 'toolu_x')]) +
          assistant('m2', [toolUse('Glob', { pattern: '*' }, 'toolu_x')]),
      ),
    code('sentinel.provider.malformedResponse'),
  );
});

test("the turn limit holds for the CLI's own count and for every message, which must carry a well-formed id", () => {
  // Sol's replay: num_turns 5 with maxTurns 2 and one assistant id. Refused.
  const one = init() + assistant('m1', [toolUse(CLAUDE_OUTPUT_TOOL, ANSWER)]);
  assert.throws(() => decode(one + result({ num_turns: 5 }), 2).out(), code('sentinel.provider.budgetExhausted'));
  assert.throws(
    () => decode(one + result({ num_turns: undefined }), 2).out(),
    code('sentinel.provider.malformedResponse'),
  );
  assert.throws(() => decode(one + result({ num_turns: -1 }), 2).out(), code('sentinel.provider.malformedResponse'));
  assert.equal(decode(one + result({ num_turns: 2 }), 2).out().turns, 2);
  for (const bad of [undefined, '', 'msg 1', 'x'.repeat(201), 7])
    assert.throws(
      () => decode(init() + line({ type: 'assistant', message: { id: bad, model, content: [] } })),
      code('sentinel.provider.malformedResponse'),
      String(bad),
    );
});

test('no input may carry a name a CLI reads as its own instructions or configuration, at any depth or case', () => {
  for (const p of ['CLAUDE.md', 'docs/claude.md', 'CLAUDE.local.md', 'AGENTS.md', 'pkg/Agents.MD', 'GEMINI.md'])
    assert.throws(() => safeInputPath(p), code('sentinel.provider.invalidProfile'), p);
  for (const p of ['.claude/skills/x/SKILL.md', 'pkg/.claude/settings.json', 'a/.GitHub/copilot-instructions.md'])
    assert.throws(() => safeInputPath(p), code('sentinel.provider.invalidProfile'), p);
  for (const p of ['src/a.ts', 'docs/claude-notes.md', 'claude/index.ts', '.github']) assert.equal(safeInputPath(p), p);
});

const LIMITS = {
  maxRequestBytes: 65536,
  maxResponseBytes: 16384,
  timeoutMs: 180000,
  maxOutputTokens: 8192,
  contextTokens: 200000,
  maxMessages: 32,
  templateTokensPerMessage: 8,
};
function settingsFor(digests: { helperDigest: string; profileDigest: string }, over: Record<string, unknown> = {}) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    hostedApiReviewEnabled: false,
    nativeClaudeReviewEnabled: true,
    grants: [
      { actions: ['paid.admit'], principals: ['human'], confirm: 'never', scope: { providers: ['native-claude'] } },
    ],
    providers: [
      {
        id: 'native-claude',
        kind: 'claude-cli',
        endpoint: 'https://api.anthropic.com',
        credential: REF,
        disclosure: 'hosted',
        nativeProfile: {
          id: CLAUDE_AGENT_PROFILE.id,
          executableDigest: CLAUDE_AGENT_PROFILE.executableDigest,
          ...digests,
        },
        budget: { maxTokens: 120000, maxCost: null, currency: null },
        models: [
          {
            id: 'sonnet',
            model,
            limits: LIMITS,
            pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
            terms: TERMS,
            capability: {
              schema: 'sentinel-model-capability/draft-1',
              kind: 'claude-cli',
              origin: 'https://api.anthropic.com',
              model,
              listed: true,
              revision: null,
              probedAt: '2026-10-28T00:00:00.000000000Z',
            },
          },
        ],
        ...over,
      },
    ],
  } as any;
}
const policyOf = (settings: unknown) => {
  const parsed = parseSettings(Buffer.from(JSON.stringify(settings)));
  return effectivePolicy({
    trust: 'adopted',
    settings: parsed,
    settingsDigest: canonicalDigest(parsed),
    repoConfig: null,
    repoConfigDigest: null,
  });
};
const SYNTHETIC = { helperDigest: D('synthetic-helper'), profileDigest: D('synthetic-profile') };

test('the native profile binds an adopted token reference and any Claude model; the brokered one keeps its bounds', () => {
  assert.deepEqual(
    CLAUDE_PROFILES.map((p: any) => [p.id, claudeProfileMode(p)]),
    [
      [CLAUDE_NATIVE_PROFILE.id, 'brokered'],
      [CLAUDE_AGENT_PROFILE.id, 'native'],
    ],
  );
  assert.equal(CLAUDE_AGENT_PROFILE.executableDigest, CLAUDE_NATIVE_PROFILE.executableDigest, 'same 2.1.282 bytes');
  assert.equal(claudeProfileById('claude-code-2.1.282-darwin-arm64-native-v0'), undefined);
  const binding = bindProvider(policyOf(settingsFor(SYNTHETIC)), 'native-claude', 'sonnet');
  const kind = cliKind('claude-cli')!;
  assert.equal(kind.mode(binding), 'native');
  assert.equal(kind.credentialSource(binding), 'reference');
  for (const [name, over, modelOver] of [
    ['no reference', { credential: null }, {}],
    [
      'a Copilot pin beside it',
      {
        copilotProfile: {
          id: COPILOT_AGENT_PROFILE.id,
          executableDigest: COPILOT_AGENT_PROFILE.executableDigest,
          runtimeDigest: COPILOT_AGENT_PROFILE.runtimeDigest,
          profileDigest: SYNTHETIC.profileDigest,
        },
      },
      {},
    ],
    ['another endpoint', { endpoint: 'https://example.invalid' }, {}],
    ['local disclosure', { disclosure: 'local-only' }, {}],
    ['a priced budget', { budget: { maxTokens: 1, maxCost: '1.00', currency: 'USD' } }, {}],
    ['a non-Claude model', {}, { model: 'gpt-6-luna' }],
    ['an oversized context', {}, { limits: { ...LIMITS, contextTokens: 1500000 } }],
  ] as const) {
    // The kind's own bounds, directly: the settings contract refuses several of these earlier as well.
    const s = settingsFor(SYNTHETIC, over as Record<string, unknown>);
    const m = { ...s.providers[0].models[0], ...(modelOver as Record<string, unknown>) };
    assert.throws(() => kind.checkBinding(s.providers[0], m, m.limits), code('sentinel.provider.invalidProfile'), name);
  }
  // The brokered pin still reads the vendor login and nothing else.
  const brokered = settingsFor(SYNTHETIC, {
    credential: null,
    nativeProfile: {
      id: CLAUDE_NATIVE_PROFILE.id,
      executableDigest: CLAUDE_NATIVE_PROFILE.executableDigest,
      ...SYNTHETIC,
    },
  });
  brokered.providers[0].models[0].model = 'claude-haiku-4-5-20251001';
  brokered.providers[0].models[0].capability.model = 'claude-haiku-4-5-20251001';
  brokered.providers[0].models[0].limits = { ...LIMITS, maxOutputTokens: 4096 };
  const b = bindProvider(policyOf(brokered), 'native-claude', 'sonnet');
  assert.equal(kind.mode(b), 'brokered');
  assert.equal(kind.credentialSource(b), 'vendor');
  // Identity: an alias answers as its own dated snapshot, nothing looser.
  const same = kind.agent!.sameModel!;
  assert.equal(same(model, model), true);
  assert.equal(same(model, model + '-20261001'), true);
  for (const other of [model + '-latest', model + '-2026100', 'claude-sonnet-5', model + '-20261001-x'])
    assert.equal(same(model, other), false, other);
});

test('the qualification records: Copilot native-v1 is complete, Claude native-v1 waits for its live acceptance', () => {
  const ids = RUNNER_QUALIFICATIONS.map((r: any) => r.profileId);
  assert.deepEqual(ids, [
    'copilot-1.0.103-darwin-arm64-seatbelt-v6',
    'copilot-1.0.105-darwin-arm64-native-v1',
    CLAUDE_AGENT_PROFILE.id,
  ]);
  const onPlatform = process.platform === 'darwin' && process.arch === 'arm64';
  assert.equal(runnerQualified('copilot-1.0.105-darwin-arm64-native-v1'), onPlatform);
  assert.equal(runnerQualified(CLAUDE_AGENT_PROFILE.id), false, 'controls pass; the live acceptance is pending');
  assert.equal(runnerQualified(CLAUDE_NATIVE_PROFILE.id), false, 'the brokered Claude profile has no record');
  if (onPlatform) assert.equal(runnerQualification(CLAUDE_AGENT_PROFILE.id)?.liveAcceptance.state, 'pending');
  // So the gate needs the owner's flag: on, it opens; off, it stays shut.
  const gate = cliKind('claude-cli')!.releaseGate!;
  const on = settingsFor(SYNTHETIC),
    off = { ...settingsFor(SYNTHETIC), nativeClaudeReviewEnabled: false };
  assert.equal(gate.open(policyOf(on).settings, on.providers[0]), true);
  assert.equal(gate.open(policyOf(off).settings, off.providers[0]), false);
});

test('the native proxy takes a few connections in turn, each to the one authority, and refuses one more', async (t) => {
  const proxy = await openNativeClaudeProxy({
    deadlineAt: Date.now() + 10000,
    maxUpstreamBytes: 4096,
    maxDownstreamBytes: 4096,
    maxConnections: 2,
  });
  t.after(() => proxy.close());
  const openClose = () =>
    new Promise<void>((resolve) => {
      const s = connect(proxy.port, '127.0.0.1', () => s.destroy());
      s.on('close', () => resolve());
      s.on('error', () => resolve());
    });
  await openClose();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(proxy.observation().endedBy, 'open', 'a closed connection ends its own pair, not the gate');
  await openClose();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(proxy.observation().endedBy, 'open');
  await openClose();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(proxy.observation().endedBy, 'refused', 'one more than the bound refuses the gate');
  assert.equal(proxy.observation().upstreamWireBytes, 0);
  await assert.rejects(
    openNativeClaudeProxy({
      deadlineAt: Date.now() + 1000,
      maxUpstreamBytes: 1,
      maxDownstreamBytes: 1,
      maxConnections: 17,
    }),
    code('sentinel.provider.invalidProfile'),
  );
});

// Zero contact for native-v1: the exact native-v1 seatbelt rules (built by the same function, with Node as the one
// executable it may run) reach only the owned loopback proxy, which refuses an unlisted CONNECT before any upstream
// byte; the only writable folders are the owned config, home and tmp. macOS sandbox-exec only; no Claude code or login.
test(
  'native-v1 reaches only the child proxy, writes only its owned folders, and the proxy refuses an unlisted host',
  { skip: process.platform !== 'darwin' && 'macOS sandbox-exec' },
  async (t) => {
    const owned = realpathSync(mkdtempSync('/private/tmp/sentinel-claude-zero-contact-'));
    t.after(() => spawnSync('/bin/rm', ['-rf', owned]));
    for (const d of ['config', 'home', 'tmp', 'work']) mkdirSync(join(owned, d));
    const outside = realpathSync(mkdtempSync('/private/tmp/sentinel-claude-outside-'));
    t.after(() => spawnSync('/bin/rm', ['-rf', outside]));
    writeFileSync(join(outside, 'private.txt'), 'original outside bytes');
    const proxy = await openNativeClaudeProxy({
      deadlineAt: Date.now() + 20000,
      maxUpstreamBytes: 4096,
      maxDownstreamBytes: 4096,
      maxConnections: 8,
    });
    t.after(() => proxy.close());
    const policy = claudeAgentSeatbeltPolicy({ executable: process.execPath, ownedRoot: owned, proxyPort: proxy.port });
    const probe = join(owned, 'zero-contact.mjs');
    writeFileSync(
      probe,
      `import { connect } from 'node:net';
import { writeFileSync, readFileSync } from 'node:fs';
const attempt = (host, port, send) => new Promise((resolve) => {
  const s = connect({ host, port }, () => { if (send) s.write(send); else { s.destroy(); resolve('connected'); } });
  let got = '';
  s.on('data', (b) => { got += b; });
  s.on('error', (e) => resolve('error:' + e.code));
  s.on('close', () => resolve(got ? 'reply' : 'closed'));
  setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
});
const write = (p) => { try { writeFileSync(p, 'x'); return 'written'; } catch (e) { return 'error:' + e.code; } };
const read = (p) => { try { readFileSync(p); return 'read'; } catch (e) { return 'error:' + e.code; } };
console.log(JSON.stringify({
  publicHost: await attempt('1.1.1.1', 443),
  otherLoopback: await attempt('127.0.0.1', 9),
  proxy: await attempt('127.0.0.1', ${proxy.port}),
  writeTmp: write(${JSON.stringify(join(owned, 'tmp/x'))}),
  writeConfig: write(${JSON.stringify(join(owned, 'config/x'))}),
  writeWork: write(${JSON.stringify(join(owned, 'work/x'))}),
  writeOutside: write(${JSON.stringify(join(outside, 'x'))}),
  readOutside: read(${JSON.stringify(join(outside, 'private.txt'))}),
  unlisted: await attempt('127.0.0.1', ${proxy.port}, 'CONNECT example.invalid:443 HTTP/1.1\\r\\nHost: example.invalid:443\\r\\n\\r\\n'),
}));
`,
    );
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, probe], {
        cwd: join(owned, 'work'),
        env: { ...claudeAgentEnvironment({ ownedRoot: owned, proxyPort: proxy.port }) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '',
        err = '';
      child.stdout.on('data', (b) => (text += b));
      child.stderr.on('data', (b) => (err += b));
      child.on('error', reject);
      child.on('close', (c) => (c === 0 ? resolve(text) : reject(Error('probe exit ' + c + ' ' + err.slice(-400)))));
    });
    assert.deepEqual(JSON.parse(out), {
      publicHost: 'error:EPERM',
      otherLoopback: 'error:EPERM',
      proxy: 'connected',
      writeTmp: 'written',
      writeConfig: 'written',
      writeWork: 'error:EPERM',
      writeOutside: 'error:EPERM',
      readOutside: 'error:EPERM',
      unlisted: 'closed',
    });
    const seen = proxy.observation();
    assert.equal(seen.upstreamWireBytes, 0, 'no byte left for any destination');
    assert.equal(seen.downstreamWireBytes, 0);
    assert.equal(seen.endedBy, 'refused', 'an unlisted destination refuses the whole gate');
  },
);

test(
  'genuine 2.1.282: the native-v1 setup runs the pinned bytes only, help lists the native flags, another program is refused',
  { skip: !genuine && 'explicit installed Claude Code 2.1.282 code qualification; no authentication' },
  async () => {
    const timing = { deadlineAt: Date.now() + 60000 };
    const runtime = await qualifyInstalledNativeClaude(timing, CLAUDE_AGENT_PROFILE);
    assert.equal(runtime.profileId, CLAUDE_AGENT_PROFILE.id);
    const setup = await nativeClaudeAgentSetup(runtime, 12345, timing);
    try {
      const run = (args: string[]) =>
        spawnSync('/usr/bin/sandbox-exec', ['-p', setup.policy, setup.executable, ...args], {
          cwd: setup.ownedRoot + '/work',
          env: { ...setup.env },
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 1024 * 1024,
        });
      const version = run(['--version']);
      assert.equal(version.status, 0, 'sandboxed version: ' + version.stderr.slice(0, 600));
      assert.match(version.stdout, /^2\.1\.282 \(Claude Code\)/);
      const help = run(['--help']);
      assert.equal(help.status, 0, 'sandboxed help: ' + help.stderr.slice(0, 600));
      for (const flag of [
        '--json-schema',
        '--tools',
        '--disallowedTools',
        '--restricted',
        '--permission-mode',
        '--permission-prompts',
        '--strict-mcp-config',
        '--setting-sources',
        '--no-session-persistence',
        '--max-budget-usd',
        '--add-dir',
      ])
        assert.ok(help.stdout.includes(flag), flag);
      // Hidden from help on 2.1.282 but defined in the pinned bytes: recorded in the PR body, not assumed absent.
      for (const hidden of ['--max-turns', '--system-prompt-file'])
        assert.ok(!help.stdout.includes(hidden + ' '), hidden);
      const forbidden = spawnSync('/usr/bin/sandbox-exec', ['-p', setup.policy, '/bin/cat', '/etc/passwd'], {
        env: { ...setup.env },
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(forbidden.status, 0, 'the sandbox refuses executing a different program');
      assert.equal(setup.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3');
      assert.equal(setup.env.HOME, setup.ownedRoot + '/home');
      assert.equal(setup.env.CLAUDE_CONFIG_DIR, setup.ownedRoot + '/config');
    } finally {
      await cleanupNativeClaudeSetup(setup);
    }
    assert.equal(existsSync(setup.ownedRoot), false);
  },
);

// Startup to the first request, on the pinned bytes, with no model call: the exact native-v1 setup, argv, plugin and
// a synthetic token on descriptor 3, against a local listener on the proxy port that refuses every tunnel. The CLI
// parses every flag (the two hidden ones included), offers only Read, Glob and its output tool, lists the promoted
// skill, and tries only the one authority through the proxy; with descriptor 3 empty it is not logged in and tries
// nothing. Nothing leaves the machine: the seatbelt allows the listener's port only.
test(
  'genuine 2.1.282 startup: every flag parses, the toolset and skill are as pinned, the token on descriptor 3 is used',
  { skip: !genuine && 'explicit installed Claude Code 2.1.282 startup; no authentication, no model call' },
  async (t) => {
    const connects: string[] = [];
    const listener = createServer((s) => {
      let h = '';
      s.on('error', () => {});
      s.on('data', (b) => {
        h += b;
        if (!h.includes('\r\n\r\n')) return;
        connects.push(h.split('\r\n')[0]!);
        s.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      });
    });
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
    t.after(() => listener.close());
    const port = (listener.address() as { port: number }).port;
    const timing = { deadlineAt: Date.now() + 120000 };
    const runtime = await qualifyInstalledNativeClaude(timing, CLAUDE_AGENT_PROFILE);
    const startup = async (token: string) => {
      const setup = await nativeClaudeAgentSetup(runtime, port, timing);
      try {
        const work = setup.ownedRoot + '/work',
          plugin = join(work, CLAUDE_STAGE_PLUGIN);
        writeFileSync(setup.ownedRoot + '/system.txt', 'Original startup instructions.\n');
        mkdirSync(work + '/src');
        writeFileSync(work + '/src/a.ts', 'export const original = 1;\n');
        mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
        writeFileSync(join(plugin, '.claude-plugin/plugin.json'), CLAUDE_STAGE_PLUGIN_MANIFEST);
        mkdirSync(join(plugin, 'skills/invoice-approvals'), { recursive: true });
        writeFileSync(join(plugin, 'skills/invoice-approvals/SKILL.md'), readFileSync(join(SKILL, 'SKILL.md')));
        const args = claudeAgentArguments({
          systemPromptPath: setup.ownedRoot + '/system.txt',
          workDir: work,
          model,
          maxTurns: 2,
          maxUsd: '0.01',
          jsonSchema: JSON.stringify(nativeOutputSchema('sentinel.review-observations/v1').jsonSchema),
          pluginDir: plugin,
        });
        const child = spawn(
          '/bin/sh',
          [...sandboxArgv('sentinel-claude-startup', setup.policy, setup.executable, args)],
          {
            cwd: work,
            env: { ...setup.env },
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout!.on('data', (b) => (out += b));
        child.stderr!.resume();
        (child.stdio[3] as NodeJS.WritableStream).end(token);
        child.stdin!.end('Original startup task.');
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
        const [exit, signal] = await new Promise<[number | null, string | null]>((r) =>
          child.on('close', (c, s) => r([c, s])),
        );
        clearTimeout(timer);
        const events = out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        return { exit, signal, events, work };
      } finally {
        await cleanupNativeClaudeSetup(setup);
      }
    };
    const signed = await startup(TOKEN);
    assert.equal(signed.signal, null, 'no crash on the pinned bytes under native-v1');
    assert.notEqual(signed.exit, 0, 'the refused tunnel ends the run as an error');
    const init = signed.events.find((e: any) => e.type === 'system' && e.subtype === 'init');
    assert.ok(init, 'every flag parsed and the session started');
    assert.deepEqual([...init.tools].sort(), ['Glob', CLAUDE_OUTPUT_TOOL, 'Read'].sort());
    assert.deepEqual(init.mcp_servers, []);
    assert.equal(init.permissionMode, 'dontAsk');
    assert.equal(init.model, model);
    assert.equal(init.cwd, signed.work);
    assert.ok(init.skills.includes('sentinel-stage:invoice-approvals'), 'the promoted skill is listed');
    const end = signed.events.find((e: any) => e.type === 'result');
    assert.equal(end.is_error, true);
    assert.ok(connects.length >= 1 && connects.length <= 16, `${connects.length} tunnels`);
    assert.ok(
      connects.every((c) => c === 'CONNECT api.anthropic.com:443 HTTP/1.1'),
      'the one authority only',
    );
    connects.length = 0;
    const unsigned = await startup('');
    assert.equal(unsigned.signal, null);
    assert.match(unsigned.events.find((e: any) => e.type === 'result')?.result ?? '', /Not logged in/);
    assert.equal(connects.length, 0, 'with descriptor 3 empty the CLI has no login and tries nothing');
  },
);

interface Launch {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: string[];
  stdin: string;
  fd3: string;
  owned: Record<string, string>;
}
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
const sha = (b: Buffer) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const tree = (root: string, skip: (rel: string) => boolean): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n),
        rel = relative(root, p);
      if (statSync(p).isDirectory()) walk(p);
      else if (!skip(rel)) out[rel] = `${(statSync(p).mode & 0o777).toString(8)} ${sha(readFileSync(p))}`;
    }
  };
  walk(root);
  return out;
};

/** Intercepts the one sandboxed Claude launch; the fake child reads descriptor 3, then stdin, then replays `stream`. */
function intercept(t: { after(fn: () => void): void }, launches: Launch[], stream: (owned: string) => string) {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as typeof import('node:child_process');
  const real = cp.spawn;
  cp.spawn = ((...given: unknown[]) => {
    const [file, args, options] = given as [string, string[], Record<string, any>];
    if (file !== '/bin/sh' || args?.[2] !== 'sentinel-claude-agent') return (real as any).apply(cp, given);
    const owned = after(args, '--system-prompt-file').replace(/\/system\.txt$/, '');
    const launch: Launch = {
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [...options.stdio],
      stdin: '',
      fd3: '',
      owned: tree(owned, (rel) => rel.startsWith('home/') || rel.startsWith('tmp/') || rel.startsWith('config/')),
    };
    launches.push(launch);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough(),
      fd3 = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, pid: 2147483645, stdio: [stdin, stdout, stderr, fd3] });
    const token: Buffer[] = [],
      chunks: Buffer[] = [];
    fd3.on('data', (b: Buffer) => token.push(b));
    fd3.on('finish', () => (launch.fd3 = Buffer.concat(token).toString('utf8')));
    stdin.on('data', (b: Buffer) => chunks.push(b));
    stdin.on('finish', () => {
      launch.stdin = Buffer.concat(chunks).toString('utf8');
      stdout.end(stream(owned));
      stderr.end();
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

async function admitted(t: { after(fn: () => void): void }, flag = true) {
  const dir = scratch(t, 'claude-native-wire-');
  const runtime = await qualifyInstalledNativeClaude({ deadlineAt: Date.now() + 30000 }, CLAUDE_AGENT_PROFILE);
  const policy = policyOf({
    ...settingsFor({ helperDigest: runtime.helperDigest, profileDigest: runtime.profileDigest }),
    nativeClaudeReviewEnabled: flag,
  });
  const binding = bindProvider(policy, 'native-claude', 'sonnet');
  const ledger = await BudgetLedger.open(join(dir, 'budget.sqlite'));
  t.after(() => ledger.close());
  const book = new ReceiptBook(join(dir, 'receipts'));
  const stateDigest = canonicalDigest({ retainedWire: 'original-claude-state' });
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
  const reads: string[] = [];
  const broker = new ModelBroker({
    ledger,
    credentials: async (ref: string) => {
      reads.push(ref);
      return TOKEN;
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
  return { broker, envelope, binding, ledger, dir, reads };
}

const STAGE = Object.freeze({
  id: 'review',
  kind: 'agent' as const,
  mode: 'native' as const,
  runner: 'claude-cli' as const,
  model,
  skills: ['skills/invoice-approvals@1'],
  produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
  budget: { turns: 4, tokens: 60000, seconds: 180, usd: '0.50' },
});
const INPUTS = Object.freeze([
  { relativePath: 'src/a.ts', bytes: Buffer.from('export const original = 1;\n') },
  { relativePath: 'src/b.ts', bytes: Buffer.from('export const second = 2;\n') },
]);
const SKILL = fileURLToPath(new URL('./fixtures/stage-packs/skills/invoice-approvals', import.meta.url));
const replay = (owned: string) => STREAM.split(WORK).join(owned + '/work');

function normalize<T>(value: T, launch: Launch): T {
  const owned = after(launch.args, '--system-prompt-file').replace(/\/system\.txt$/, '');
  const executable = launch.args[5]!;
  const port = /127\.0\.0\.1:(\d+)$/.exec(launch.env.HTTPS_PROXY ?? '')?.[1];
  assert(port);
  const text = (s: string) =>
    s
      .split(owned)
      .join('<owned>')
      .split(executable)
      .join('<executable>')
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

test(
  'the recorded native-v1 run replays: the token on descriptor 3 only, a sealed scratch tree, a schema-valid answer',
  { skip: !genuine && 'needs the installed Claude Code 2.1.282 bytes and the built helper; no login' },
  async (t) => {
    const { broker, envelope, binding, dir, reads } = await admitted(t);
    assert.deepEqual(reads, [REF], 'the broker read the adopted reference once, at admission');
    const trustDir = join(dir, 'trust');
    mkdirSync(trustDir);
    promoteStagePack(trustDir, SKILL, { confirm: true });
    const launches: Launch[] = [];
    intercept(t, launches, replay);
    const sealed: unknown[] = [];
    const run = await CLAUDE_RUNNER.run(STAGE, INPUTS, {
      native: {
        broker,
        envelope,
        binding,
        operationId: 'original-claude-op',
        trustDir,
        retain: async (r: unknown) => void sealed.push(r),
      },
    });
    assert.equal(launches.length, 1);
    const launch = launches[0]!;
    assert.equal(launch.fd3, TOKEN, 'the token crossed descriptor 3, once');
    const everywhere = JSON.stringify([launch.args, launch.env, launch.stdin, launch.owned, run, sealed]);
    assert.ok(!everywhere.includes(TOKEN), 'the token is in no argv, environment, input, file or record');
    assert.deepEqual(launch.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);
    assert.equal(run.mode, 'native');
    if (run.mode !== 'native') return;
    assert.deepEqual(run.output.value, ANSWER);
    assert.deepEqual(run.filesRead, ['src/a.ts']);
    assert.equal(run.provenance.runner, 'claude-cli');
    assert.equal(run.provenance.profileId, CLAUDE_AGENT_PROFILE.id);
    assert.equal(run.provenance.runnerVersion, '2.1.282');
    assert.deepEqual(run.provenance.tokens, { input: 1000, output: 80, certainty: 'confirmed' });
    assert.deepEqual(run.provenance.cost, { basis: 'unobserved', reason: 'subscription' });
    assert.equal(run.provenance.model.reported, model);
    assert.deepEqual(run.secondaryModels, []);
    assert.equal(publicProvenance(run.provenance).installation?.executablePath, '<redacted>');
    assert.equal(sealed.length, 1, 'the instruction record was sealed before the run');
    const observed = normalize(
      {
        profile: CLAUDE_AGENT_PROFILE.id,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        stdin: launch.stdin,
        owned: launch.owned,
        // The stream names the scratch tree's random path: the digest is of the text with it as a placeholder.
        transcript: Buffer.from(run.transcript).toString('utf8'),
      },
      launch,
    );
    (observed as any).transcriptDigest = sha(Buffer.from((observed as any).transcript));
    delete (observed as any).transcript;
    if (record) writeFileSync(golden, JSON.stringify(observed, null, 2) + '\n');
    assert.deepEqual(observed, JSON.parse(readFileSync(golden, 'utf8')));
  },
);

test(
  'a refused tool stops the run: no output, the partial ledger kept privately, usage uncertain',
  { skip: !genuine && 'needs the installed Claude Code 2.1.282 bytes and the built helper; no login' },
  async (t) => {
    const { broker, envelope, binding } = await admitted(t);
    const launches: Launch[] = [];
    intercept(
      t,
      launches,
      (owned) =>
        init() +
        assistant('m1', [toolUse('Read', { file_path: owned + '/work/src/a.ts' })]) +
        toolResult('toolu_Read') +
        assistant('m2', [toolUse('Bash', { command: 'cat /etc/passwd' })]),
    );
    const stage = { ...STAGE, skills: [] };
    await assert.rejects(
      CLAUDE_RUNNER.run(stage, INPUTS, {
        native: { broker, envelope, binding, operationId: 'original-refused-op', retain: async () => {} },
      }),
      (e: any) => {
        assert.ok(e instanceof NativeRunFailure);
        assert.equal(e.code, 'sentinel.provider.malformedResponse');
        assert.equal(e.retained.completed, false);
        assert.deepEqual(e.retained.filesRead, ['src/a.ts']);
        assert.deepEqual(e.retained.provenance.tokens, { input: null, output: null, certainty: 'uncertain' });
        assert.deepEqual(e.retained.provenance.cost, { basis: 'unobserved', reason: 'usage-unknown' });
        assert.ok(Buffer.from(e.retained.transcript).toString().includes('"Bash"'));
        return true;
      },
    );
    assert.equal(launches.length, 1);
  },
);

test(
  'without a qualified record or the owner flag, a native Claude run is refused before anything launches',
  { skip: !genuine && 'needs the installed Claude Code 2.1.282 bytes and the built helper; no login' },
  async (t) => {
    const { broker, envelope, binding } = await admitted(t, false);
    const launches: Launch[] = [];
    intercept(t, launches, replay);
    await assert.rejects(
      CLAUDE_RUNNER.run({ ...STAGE, skills: [] }, INPUTS, {
        native: { broker, envelope, binding, operationId: 'original-gated-op', retain: async () => {} },
      }),
      code('sentinel.provider.nativeClaudeDisabled'),
    );
    assert.equal(launches.length, 0);
  },
);

test('a stage dollar ceiling is a decimal the CLI enforces; Copilot, which cannot, refuses one', async () => {
  const { COPILOT_RUNNER } = await import('../dist/review/runner.js');
  for (const [runner, stage] of [
    [CLAUDE_RUNNER, { ...STAGE, budget: { ...STAGE.budget, usd: '1e3' } }],
    [CLAUDE_RUNNER, { ...STAGE, budget: { ...STAGE.budget, usd: '-1' } }],
    [COPILOT_RUNNER, { ...STAGE, runner: 'copilot-cli', budget: { ...STAGE.budget, usd: '0.50' } }],
  ] as const)
    await assert.rejects(runner.run(stage as any, INPUTS, { native: {} as any }), code('sentinel.review.nativeBudget'));
});
