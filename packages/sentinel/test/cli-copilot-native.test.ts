// Copilot native mode: argv, the JSONL decoder, the owned usage file, the output schema and the profiles. Portable
// controls replay synthetic event streams shaped like the CLI's own (recorded once in a debug dry run); no login,
// no model call. The genuine controls (SENTINEL_COPILOT_CODE=1) qualify the installed 1.0.105 bytes and run its
// sandboxed `--help` and pure argument parser over the copied runtime, with no authentication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COPILOT_READ_TOOLS,
  CopilotAgentDecoder,
  copilotAgentArguments,
  decodeCopilotAgentUsage,
  safeInputPath,
} from '../dist/review/providers/cli-copilot-agent.js';
import {
  COPILOT_NATIVE_PROFILE,
  COPILOT_1_0_105_PROFILE,
  COPILOT_AGENT_PROFILE,
  COPILOT_PROFILES,
  copilotProfileById,
  copilotProfileMode,
  copilotRuntimeInstallation,
  qualifyInstalledNativeCopilot,
  nativeCopilotSetup,
  cleanupNativeCopilotSetup,
  verifyNativeCopilotSetup,
} from '../dist/review/providers/cli-copilot-profile.js';
import { nativeOutputSchema, parseFinalAnswer, NATIVE_OUTPUT_SCHEMAS } from '../dist/review/native.js';
import { COPILOT_RUNNER, CLAUDE_RUNNER, agentRunner } from '../dist/review/runner.js';

const WORK = '/private/tmp/sentinel-copilot-original/work';
const ev = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, data, id: 'original', timestamp: '2026-10-28T00:00:00.000Z', ...extra }) + '\n';
/** The shape of the recorded dry run: two requests, one `view`, a final answer, the result. */
function stream(opts: { tool?: string; path?: string; final?: string; requests?: number; exit?: number } = {}) {
  const lines = [ev('session.info'), ev('user.message', { content: 'original task' })];
  const requests = opts.requests ?? 2;
  for (let i = 0; i < requests; i++) {
    lines.push(ev('assistant.turn_start', { turnId: String(i) }), ev('model.call_start', { model: 'gpt-6-luna' }));
    if (i === 0 && requests > 1) {
      lines.push(
        ev('assistant.message', { model: 'gpt-6-luna', content: '', toolRequests: [{ name: opts.tool ?? 'view' }] }),
        ev('tool.execution_start', {
          toolName: opts.tool ?? 'view',
          arguments: { path: opts.path ?? `${WORK}/src/server/auth.ts` },
        }),
        ev('tool.execution_complete', { success: true }),
      );
    }
    if (i === requests - 1)
      lines.push(
        ev('assistant.message', {
          model: 'gpt-6-luna',
          phase: 'final_answer',
          content: opts.final ?? '{"observations":[],"inspected":["src/server/auth.ts"]}',
        }),
      );
    lines.push(ev('assistant.turn_end', { turnId: String(i) }));
  }
  lines.push(JSON.stringify({ type: 'result', exitCode: opts.exit ?? 0, usage: { premiumRequests: 1 } }) + '\n');
  return Buffer.from(lines.join(''));
}
const usage = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      totalUserRequests: 1,
      currentModel: 'gpt-6-luna',
      modelMetrics: {
        'gpt-6-luna': {
          requests: { count: 2, cost: 1 },
          usage: { inputTokens: 9000, outputTokens: 120, cacheReadTokens: 4000, cacheWriteTokens: 4000 },
        },
      },
      ...over,
    }),
  );

test('native argv offers only the read tools, keeps shell and write denied and pipes the prompt', () => {
  const args = copilotAgentArguments({
    usagePath: '/o/state/usage.json',
    sharePath: '/o/state/transcript.md',
    workDir: '/o/work',
    model: 'gpt-6-luna',
  });
  assert.deepEqual([...COPILOT_READ_TOOLS], ['view', 'glob']);
  const at = args.indexOf('--available-tools');
  assert.deepEqual(args.slice(at + 1, at + 3), ['view', 'glob']);
  assert.equal(args[at + 3], '--excluded-tools');
  for (const pair of [
    ['--deny-tool', 'shell'],
    ['--deny-tool', 'write'],
    ['--output-format', 'json'],
    ['--share', '/o/state/transcript.md'],
    ['--usage-output-file', '/o/state/usage.json'],
    ['-C', '/o/work'],
    ['--model', 'gpt-6-luna'],
  ])
    assert(
      args.some((a, i) => a === pair[0] && args[i + 1] === pair[1]),
      pair.join(' '),
    );
  for (const flag of [
    '--trust-folder',
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--no-auto-update',
    '--disallow-temp-dir',
    '--no-bash-env',
  ])
    assert(args.includes(flag), flag);
  for (const flag of ['-p', '--prompt', '--allow-all', '--allow-all-tools', '--yolo', '--allow-all-paths', '-s'])
    assert.equal(args.includes(flag), false, flag);
  assert.equal(args.includes('--no-custom-instructions'), false, 'the scratch instructions file is read');
});

test('the decoder reads the final answer, the reads and the turns, and makes paths scratch-relative', () => {
  const d = new CopilotAgentDecoder(WORK, 3),
    bytes = stream();
  for (let i = 0; i < bytes.length; i += 7) d.push(bytes.subarray(i, i + 7));
  const out = d.finish();
  assert.equal(out.finalAnswer, '{"observations":[],"inspected":["src/server/auth.ts"]}');
  assert.equal(out.reportedModel, 'gpt-6-luna');
  assert.equal(out.turns, 2);
  assert.deepEqual(out.filesRead, ['src/server/auth.ts']);
  assert.deepEqual(out.tools, [{ tool: 'view', path: 'src/server/auth.ts' }]);
  for (const path of ['/etc/passwd', `${WORK}/../state/config.json`, '/private/tmp/sentinel-copilot-original'])
    assert.throws(
      () => new CopilotAgentDecoder(WORK, 3).push(stream({ path })),
      (e: any) => e.code === 'sentinel.provider.malformedResponse' && e.nativeCopilot?.reason === 'disallowed-event',
      'a read outside the scratch tree stops the run: ' + path,
    );
});

for (const [name, bytes, code] of [
  ['a shell tool', stream({ tool: 'bash' }), 'sentinel.provider.malformedResponse'],
  ['the ripgrep tool the sandbox cannot run', stream({ tool: 'rg' }), 'sentinel.provider.malformedResponse'],
  ['a write tool', stream({ tool: 'apply_patch' }), 'sentinel.provider.malformedResponse'],
  ['one request past the turn budget', stream({ requests: 4 }), 'sentinel.provider.budgetExhausted'],
  ['invalid JSON', Buffer.from('{"type":\n'), 'sentinel.provider.malformedResponse'],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), 'sentinel.provider.malformedResponse'],
] as const)
  test('the decoder refuses ' + name + ' as it arrives', () => {
    const d = new CopilotAgentDecoder(WORK, 3);
    assert.throws(
      () => d.push(bytes),
      (e: any) => e.code === code && e.spend === 'possible',
    );
  });

for (const [name, bytes] of [
  ['no final answer', stream({ final: '   ' })],
  ['a failing result', stream({ exit: 1 })],
  ['no result event', Buffer.from(stream().toString().split('\n').slice(0, -2).join('\n') + '\n')],
] as const)
  test('the decoder never completes with ' + name, () => {
    const d = new CopilotAgentDecoder(WORK, 3);
    d.push(bytes);
    assert.throws(
      () => d.finish(),
      (e: any) => e.code?.startsWith('sentinel.provider.'),
    );
  });

test('the owned usage file names exactly the requested model and one user request', () => {
  assert.deepEqual(decodeCopilotAgentUsage(usage(), 'gpt-6-luna'), {
    inputTokens: 9000,
    outputTokens: 120,
    requests: 2,
  });
  for (const bad of [
    usage({ currentModel: 'auto' }),
    usage({ totalUserRequests: 2 }),
    usage({ modelMetrics: { 'gpt-6-luna': { requests: { count: 1 }, usage: {} }, other: {} } }),
    usage({ modelMetrics: { 'gpt-6-luna': { requests: { count: 0 }, usage: { inputTokens: 1, outputTokens: 1 } } } }),
    Buffer.from('{"truncated":'),
  ])
    assert.throws(
      () => decodeCopilotAgentUsage(bad, 'gpt-6-luna'),
      (e: any) => e.code?.startsWith('sentinel.'),
    );
});

test('native inputs are plain relative paths, never configuration the CLI would load', () => {
  assert.equal(safeInputPath('src/server/auth.ts'), 'src/server/auth.ts');
  for (const bad of [
    '/etc/passwd',
    '../outside.ts',
    'src/../../x',
    'src//x',
    './x',
    '.github/copilot-instructions.md',
    '.github/skills/x/SKILL.md',
    '.claude/settings.json',
    '.copilot/config.json',
    'a\0b',
    '',
  ])
    assert.throws(
      () => safeInputPath(bad),
      (e: any) => e.code === 'sentinel.provider.invalidProfile',
      bad,
    );
});

test('the observations schema accepts only cited claims on inputs the transcript shows were read', () => {
  assert.deepEqual([...NATIVE_OUTPUT_SCHEMAS], ['sentinel.review-observations/v1']);
  const schema = nativeOutputSchema('sentinel.review-observations/v1'),
    inputs = new Set(['src/server/auth.ts', 'src/server/routes.ts']),
    read = new Set(['src/server/auth.ts']);
  const good = {
    observations: [{ path: 'src/server/auth.ts', line: 12, kind: 'risk', claim: 'The token is compared with ==.' }],
    inspected: ['src/server/auth.ts'],
  };
  assert.deepEqual(schema.validate(structuredClone(good), inputs, read), good);
  assert.deepEqual(schema.validate({ observations: [], inspected: [] }, inputs, read), {
    observations: [],
    inspected: [],
  });
  for (const bad of [
    { ...good, extra: true },
    { observations: good.observations },
    { ...good, inspected: ['src/server/routes.ts'] },
    { ...good, inspected: ['src/other.ts'] },
    { ...good, observations: [{ ...good.observations[0], path: 'src/server/routes.ts' }] },
    { ...good, observations: [{ ...good.observations[0], line: 0 }] },
    { ...good, observations: [{ ...good.observations[0], kind: 'finding' }] },
    { ...good, observations: [{ ...good.observations[0], claim: '' }] },
    { ...good, observations: [{ ...good.observations[0], claim: 'x\u0007' }] },
    { ...good, observations: [{ ...good.observations[0], severity: 'high' }] },
    { ...good, observations: Array(33).fill(good.observations[0]) },
  ])
    assert.throws(
      () => schema.validate(bad, inputs, read),
      (e: any) => e.code === 'sentinel.review.outputSchema',
      JSON.stringify(bad),
    );
  assert.throws(
    () => nativeOutputSchema('sentinel.unknown/v1'),
    (e: any) => e.code === 'sentinel.review.outputSchema',
  );
});

test('the final answer is one JSON object, bare or as the one fenced block that is the whole answer', () => {
  assert.deepEqual(parseFinalAnswer(' {"a":1}\n'), { a: 1 });
  assert.deepEqual(parseFinalAnswer('```json\n{"a":1}\n```'), { a: 1 });
  for (const bad of ['Here is the answer: {"a":1}', '```json\n{"a":1}\n```\nmore', 'none'])
    assert.throws(
      () => parseFinalAnswer(bad),
      (e: any) => e.code === 'sentinel.review.outputSchema',
    );
});

test('the 1.0.103 record is kept beside the 1.0.105 re-qualification and its native profile', () => {
  assert.deepEqual(
    COPILOT_PROFILES.map((p) => p.id),
    [
      'copilot-1.0.103-darwin-arm64-seatbelt-v6',
      'copilot-1.0.105-darwin-arm64-seatbelt-v6',
      'copilot-1.0.105-darwin-arm64-native-v1',
    ],
  );
  assert.equal(COPILOT_NATIVE_PROFILE.executableDigest.slice(7, 19), '1c81150e4bd7');
  assert.equal(COPILOT_NATIVE_PROFILE.runtimeDigest.slice(7, 19), '3d0df03e4145');
  assert.equal(COPILOT_1_0_105_PROFILE.executableDigest.slice(7, 19), '5fd7d15ff02d');
  assert.equal(COPILOT_1_0_105_PROFILE.runtimeDigest.slice(7, 19), 'aad20f2ab2d4');
  assert.equal(COPILOT_AGENT_PROFILE.runtimeDigest, COPILOT_1_0_105_PROFILE.runtimeDigest);
  assert.deepEqual(COPILOT_PROFILES.map(copilotProfileMode), ['brokered', 'brokered', 'native']);
  assert.equal(copilotProfileById('copilot-1.0.103-darwin-arm64-seatbelt-v5'), undefined);
  assert.deepEqual([...COPILOT_RUNNER.modes], ['brokered', 'native']);
  assert.deepEqual([...CLAUDE_RUNNER.modes], ['brokered']);
  assert.equal(agentRunner('copilot-cli'), COPILOT_RUNNER);
  assert.throws(
    () => agentRunner('hosted-api'),
    (e: any) => e.code === 'sentinel.provider.invalidProfile',
  );
});

test('a configured Copilot path is absolute or refused before any file is read', async () => {
  const prior = process.env.SENTINEL_COPILOT_EXECUTABLE;
  process.env.SENTINEL_COPILOT_EXECUTABLE = 'relative/copilot';
  try {
    await assert.rejects(
      qualifyInstalledNativeCopilot({ deadlineAt: Date.now() + 2000 }, COPILOT_1_0_105_PROFILE),
      (e: any) => e.code === 'sentinel.provider.capabilityUntested',
    );
  } finally {
    if (prior === undefined) delete process.env.SENTINEL_COPILOT_EXECUTABLE;
    else process.env.SENTINEL_COPILOT_EXECUTABLE = prior;
  }
});

const genuine = process.env.SENTINEL_COPILOT_CODE === '1';
test(
  'genuine 1.0.105: resolved by digest, sandboxed help on the copied runtime, the native argv parses, mutation refuses',
  { skip: !genuine && 'explicit installed Copilot 1.0.105 code qualification; no authentication' },
  async () => {
    const timing = { deadlineAt: Date.now() + 60000 };
    for (const profile of [COPILOT_1_0_105_PROFILE, COPILOT_AGENT_PROFILE]) {
      const runtime = await qualifyInstalledNativeCopilot(timing, profile);
      assert.equal(runtime.profileId, profile.id);
      assert.equal(runtime.runtimeDigest, profile.runtimeDigest);
      assert.match(copilotRuntimeInstallation(runtime).source, /^(configured|path|homebrew-cask|known-location)$/);
    }
    const runtime = await qualifyInstalledNativeCopilot(timing, COPILOT_AGENT_PROFILE),
      setup = await nativeCopilotSetup(runtime, 12345, timing);
    try {
      await verifyNativeCopilotSetup(setup, timing);
      const help = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', setup.policy, setup.executable, '--no-auto-update', '--help'],
        { cwd: setup.ownedRoot + '/home', env: setup.env, encoding: 'utf8', timeout: 20000, maxBuffer: 262144 },
      );
      assert.equal(help.status, 0, 'auth-free copied-runtime help startup: ' + help.stderr.slice(0, 1000));
      assert.match(help.stdout, /--available-tools/);
      const version = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', setup.policy, setup.executable, '--no-auto-update', '--version'],
        { cwd: setup.ownedRoot + '/home', env: setup.env, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 },
      );
      assert.match(version.stdout, /1\.0\.105/, 'the private copy, not a newer cached runtime, is what runs');
      const args = copilotAgentArguments({
        usagePath: setup.ownedRoot + '/state/usage.json',
        sharePath: setup.ownedRoot + '/state/transcript.md',
        workDir: setup.ownedRoot + '/work',
        model: 'gpt-6-luna',
      });
      const probe = join(setup.ownedRoot, 'native-parse.cjs');
      writeFileSync(
        probe,
        `const assert=require('node:assert/strict'),cli=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/cli-native.node')});const parsed=cli.cliParse(['copilot',...${JSON.stringify(args)}]);assert.equal(parsed.kind,'run');const o=parsed.rootOptions;assert.deepEqual(o.availableTools,['view','glob']);assert.deepEqual(o.excludedTools,['mcp:*','custom:*']);assert.equal(o.outputFormat,'json');assert.equal(o.askUser,false);assert.notEqual(o.customInstructions,false);console.log('native-argv-parsed '+JSON.stringify({deny:o.denyTool??o.deniedTools??null,trust:o.trustFolder??null}))`,
      );
      const qp = (v: string) => JSON.stringify(v),
        purePolicy = [
          '(version 1)(deny default)',
          `(allow process-exec (literal ${qp(process.execPath)}))`,
          `(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (subpath ${qp(join(process.execPath, '../..'))}) (subpath ${qp(setup.ownedRoot)}) (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`,
          '(allow signal (target same-sandbox))(allow file-ioctl (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
          '(allow file-read-metadata (vnode-type DIRECTORY))(allow sysctl-read)(allow process-info* (target same-sandbox))(allow mach-priv-task-port (target same-sandbox))',
        ].join('\n');
      const parsed = spawnSync('/usr/bin/sandbox-exec', ['-p', purePolicy, process.execPath, probe], {
        cwd: setup.ownedRoot + '/home',
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16384,
      });
      assert.equal(parsed.status, 0, 'pure pinned native argument probe: ' + parsed.stderr?.slice(-600));
      assert.match(parsed.stdout, /native-argv-parsed/);
      const forbidden = spawnSync('/usr/bin/sandbox-exec', ['-p', setup.policy, '/bin/cat', '/etc/passwd'], {
        env: setup.env,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(forbidden.status, 0, 'the sandbox refuses executing a different program');
      const marker = join(setup.ownedRoot, 'runtime', 'cli-main.js');
      chmodSync(marker, 0o600);
      writeFileSync(marker, 'original changed private code');
      await assert.rejects(
        verifyNativeCopilotSetup(setup, timing),
        (e: any) => e.code === 'sentinel.provider.capabilityUntested',
      );
    } finally {
      await cleanupNativeCopilotSetup(setup);
    }
    assert.equal(existsSync(setup.ownedRoot), false);
  },
);

test('the recorded live native run replays: four inputs read, a schema-valid answer, two turns', () => {
  const recorded = readFileSync(
    new URL('./fixtures/retained-wire/copilot-1.0.105-native-live-events.jsonl', import.meta.url),
    'utf8',
  ).replaceAll('<owned>', '/private/tmp/sentinel-copilot-recorded');
  const d = new CopilotAgentDecoder('/private/tmp/sentinel-copilot-recorded/work', 3);
  d.push(Buffer.from(recorded));
  const out = d.finish();
  const inputs = ['src/server/routes.ts', 'src/server/auth.ts', 'src/server/approvals.ts', 'src/server/payments.ts'];
  assert.equal(out.turns, 2);
  assert.equal(out.reportedModel, 'gpt-6-luna');
  assert.deepEqual(
    out.filesRead,
    ['.github/copilot-instructions.md', ...inputs],
    'the transcript lists the files read',
  );
  const value = nativeOutputSchema('sentinel.review-observations/v1').validate(
    parseFinalAnswer(out.finalAnswer),
    new Set(inputs),
    new Set(out.filesRead),
  ) as { observations: unknown[]; inspected: string[] };
  assert.equal(value.observations.length, 4);
  assert.deepEqual(value.inspected, inputs);
  assert.throws(
    () => new CopilotAgentDecoder('/private/tmp/sentinel-copilot-recorded/work', 1).push(Buffer.from(recorded)),
    (e: any) => e.code === 'sentinel.provider.budgetExhausted',
    'the same run under a one-turn budget stops at its second request',
  );
});
