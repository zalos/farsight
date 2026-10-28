// Copilot native mode: argv, the JSONL decoder, the owned usage file, the output schema and the profiles. Portable
// controls replay synthetic event streams shaped like the CLI's own (recorded once in a debug dry run); no login,
// no model call. The genuine controls (SENTINEL_COPILOT_CODE=1) qualify the installed 1.0.105 bytes and run its
// sandboxed `--help` and pure argument parser over the copied runtime, with no authentication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  copilotSeatbeltPolicy,
  nativeCopilotSetup,
  cleanupNativeCopilotSetup,
  verifyNativeCopilotSetup,
} from '../dist/review/providers/cli-copilot-profile.js';
import { openNativeCopilotProxy } from '../dist/review/providers/cli-copilot-proxy.js';
import { nativeOutputSchema, parseFinalAnswer, NATIVE_OUTPUT_SCHEMAS } from '../dist/review/native.js';
import {
  COPILOT_RUNNER,
  CLAUDE_RUNNER,
  NativeRunFailure,
  agentRunner,
  publicProvenance,
} from '../dist/review/runner.js';

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
    () => agentRunner('unregistered-runner'),
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
      // The CLI's own path manager, from the pinned runtime, built as these flags build it (-C work, no --add-dir,
      // --disallow-temp-dir): view and glob may reach the scratch tree and nothing else the seatbelt leaves readable.
      const work = join(setup.ownedRoot, 'work');
      mkdirSync(join(work, 'src'), { recursive: true });
      writeFileSync(join(work, 'src/original.ts'), 'export const original = 1;\n');
      const pathProbe = join(setup.ownedRoot, 'native-paths.cjs'),
        outside = [
          join(setup.ownedRoot, 'state/config.json'),
          join(setup.ownedRoot, 'runtime/app.js'),
          join(homedir(), 'Library/Keychains/login.keychain-db'),
          '/etc/passwd',
          '/private/tmp',
          join(work, '../state/config.json'),
        ];
      writeFileSync(
        pathProbe,
        `const assert=require('node:assert/strict'),cli=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/cli-native.node')}),runtime=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/runtime.node')});const o=cli.cliParse(['copilot',...${JSON.stringify(args)}]).rootOptions;assert.equal(o.C,${JSON.stringify(work)});assert.equal(o.disallowTempDir,true);assert.equal(o.addDir,undefined);assert.equal(o.allowAllPaths,undefined);(async()=>{const m=await runtime.pathManagerCreateRestricted(o.C,[],!o.disallowTempDir);const within=async p=>await m.isPathWithinAllowedDirectories(p);assert.deepEqual(await m.getDirectories(),[o.C]);assert.equal(await within(${JSON.stringify(join(work, 'src/original.ts'))}),true);for(const p of ${JSON.stringify(outside)})assert.equal(await within(p),false,p);console.log('native-paths-confined')})().catch(e=>{console.error(e&&e.message);process.exitCode=1});`,
      );
      const confined = spawnSync('/usr/bin/sandbox-exec', ['-p', purePolicy, process.execPath, pathProbe], {
        cwd: setup.ownedRoot + '/home',
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16384,
      });
      assert.equal(confined.status, 0, 'pinned path manager probe: ' + confined.stderr?.slice(-600));
      assert.match(confined.stdout, /native-paths-confined/);
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

for (const [name, args] of [
  ['view without a path', { view_range: [1, 2] }],
  ['view with an unknown argument', { path: `${WORK}/src/server/auth.ts`, follow: true }],
  ['view with a non-numeric range', { path: `${WORK}/src/server/auth.ts`, view_range: ['1'] }],
  ['glob without a pattern', { path: WORK }],
  ['glob with an absolute pattern', { pattern: '/etc/*' }],
  ['glob with a home pattern', { pattern: '~/Library/Keychains/*' }],
  ['glob with a parent step', { pattern: '../state/*.json' }],
  ['glob rooted outside the tree', { pattern: '*.json', path: '/private/tmp/sentinel-copilot-original/state' }],
  ['glob with an unknown argument', { pattern: '**/*.ts', root: '/' }],
  ['a call with no argument object', undefined],
] as const)
  test('the stream monitor fails closed on ' + name, () => {
    const tool = name.startsWith('glob') ? 'glob' : 'view';
    const bytes = Buffer.from(
      ev('model.call_start') + ev('tool.execution_start', { toolName: tool, ...(args ? { arguments: args } : {}) }),
    );
    assert.throws(
      () => new CopilotAgentDecoder(WORK, 3).push(bytes),
      (e: any) => e.code === 'sentinel.provider.malformedResponse' && e.nativeCopilot?.reason === 'disallowed-event',
    );
  });

test('the stream monitor accepts the two known read shapes inside the scratch tree', () => {
  const d = new CopilotAgentDecoder(WORK, 3);
  d.push(
    Buffer.from(
      ev('model.call_start') +
        ev('tool.execution_start', { toolName: 'glob', arguments: { pattern: 'src/**/*.ts' } }) +
        ev('tool.execution_start', { toolName: 'glob', arguments: { pattern: '*.ts', path: `${WORK}/src` } }) +
        ev('tool.execution_start', {
          toolName: 'view',
          arguments: { path: `${WORK}/src/server/auth.ts`, view_range: [1, 20] },
        }) +
        ev('assistant.message', { model: 'gpt-6-luna', phase: 'final_answer', content: '{}' }) +
        JSON.stringify({ type: 'result', exitCode: 0 }) +
        '\n',
    ),
  );
  const out = d.finish();
  assert.deepEqual(out.tools, [
    { tool: 'glob', path: null },
    { tool: 'glob', path: 'src' },
    { tool: 'view', path: 'src/server/auth.ts' },
  ]);
  assert.deepEqual(out.filesRead, ['src', 'src/server/auth.ts']);
});

const nativeStage = {
  id: 'review',
  kind: 'agent' as const,
  mode: 'native' as const,
  runner: 'copilot-cli' as const,
  model: 'gpt-6-luna',
  produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
  budget: { turns: 3, tokens: 20000, seconds: 120 },
};
const settledResult = (finalAnswer: string) => ({
  finalAnswer,
  reportedModel: 'gpt-6-luna',
  turns: 2,
  tools: [{ tool: 'view', path: 'src/server/auth.ts' }],
  filesRead: ['src/server/auth.ts'],
  usage: { inputTokens: 9000, outputTokens: 100, requests: 2 },
  events: new Uint8Array(Buffer.from('{"type":"result","exitCode":0}\n')),
  share: new Uint8Array(Buffer.from('# Copilot CLI Session\n')),
});
const nativeContext = (runAgent: () => Promise<unknown>) => ({
  native: {
    broker: { runAgent } as any,
    envelope: {} as any,
    binding: { model: 'gpt-6-luna', copilotProfile: { id: COPILOT_AGENT_PROFILE.id } } as any,
    operationId: 'original-native-stage',
  },
});
// The credential path probe asks the macOS login keychain; elsewhere it refuses before any run, by design.
test(
  'a settled native run that fails its schema or budget keeps a private failed-attempt record and publishes nothing',
  { skip: process.platform !== 'darwin' && 'the credential path probe needs the macOS login keychain' },
  async () => {
    const inputs = [{ relativePath: 'src/server/auth.ts', bytes: Buffer.from('export const a = 1;\n') }];
    const failure = await COPILOT_RUNNER.run(
      nativeStage,
      inputs,
      nativeContext(async () => ({
        result: settledResult('I could not decide.'),
        installation: { source: 'path', executable: '/original/bin/copilot' },
        identity: { requestedModel: 'gpt-6-luna', returnedModel: 'gpt-6-luna' },
        usage: { inputTokens: 9000, outputTokens: 100 },
      })),
    ).then(
      () => assert.fail('a schema failure publishes nothing'),
      (e: any) => e,
    );
    assert(failure instanceof NativeRunFailure);
    assert.equal(failure.code, 'sentinel.review.outputSchema');
    assert.equal(failure.retained.disclosure, 'private-only');
    assert.equal(failure.retained.withholding, 'accepted-secret-fold-before-read');
    assert.equal(failure.retained.finalAnswer, 'I could not decide.');
    assert.deepEqual(failure.retained.filesRead, ['src/server/auth.ts']);
    assert.equal(Buffer.from(failure.retained.share).toString(), '# Copilot CLI Session\n');
    assert.deepEqual(failure.retained.provenance.tokens, { input: 9000, output: 100, certainty: 'confirmed' });
    assert.deepEqual(failure.retained.provenance.cost, { basis: 'unobserved', reason: 'subscription' });
    assert.deepEqual(failure.retained.provenance.installation, {
      source: 'path',
      executablePath: '/original/bin/copilot',
    });
    assert.deepEqual(publicProvenance(failure.retained.provenance).installation, {
      source: 'path',
      executablePath: '<redacted>',
    });
    const overBudget = Object.assign(new Error('over budget'), {
      code: 'sentinel.provider.budgetExhausted',
      agentResult: settledResult('{"observations":[],"inspected":[]}'),
      agentInstallation: { source: 'homebrew-cask', executable: '/original/cask/copilot' },
    });
    const budget = await COPILOT_RUNNER.run(
      nativeStage,
      inputs,
      nativeContext(async () => {
        throw overBudget;
      }),
    ).then(
      () => assert.fail('an over-budget run publishes nothing'),
      (e: any) => e,
    );
    assert(budget instanceof NativeRunFailure);
    assert.equal(budget.code, 'sentinel.provider.budgetExhausted');
    assert.equal(budget.retained.completed, true);
    assert.equal(budget.retained.provenance.turns, 2);
    assert.deepEqual(budget.retained.provenance.installation, {
      source: 'homebrew-cask',
      executablePath: '/original/cask/copilot',
    });
    // Stopped before completing (a denied tool, here): the bounded partial stream and the installation are kept,
    // usage is uncertain and the cost is unobserved for that reason, never zero.
    const partialStream = Buffer.from('{"type":"tool.execution_start","data":{"toolName":"bash"}}\n');
    const denied = Object.assign(new Error('denied tool'), {
      code: 'sentinel.provider.malformedResponse',
      agentPartial: {
        turns: 1,
        tools: [{ tool: 'view', path: 'src/server/auth.ts' }],
        filesRead: ['src/server/auth.ts'],
        events: 9,
        stream: new Uint8Array(partialStream),
      },
      agentInstallation: { source: 'path', executable: '/original/bin/copilot' },
    });
    const stopped = await COPILOT_RUNNER.run(
      nativeStage,
      inputs,
      nativeContext(async () => {
        throw denied;
      }),
    ).then(
      () => assert.fail('a stopped run publishes nothing'),
      (e: any) => e,
    );
    assert(stopped instanceof NativeRunFailure);
    assert.equal(stopped.code, 'sentinel.provider.malformedResponse');
    assert.equal(stopped.retained.completed, false);
    assert.equal(stopped.retained.finalAnswer, null);
    assert.deepEqual(stopped.retained.filesRead, ['src/server/auth.ts']);
    assert.equal(Buffer.from(stopped.retained.transcript).toString(), partialStream.toString());
    assert.deepEqual(stopped.retained.provenance.tokens, { input: null, output: null, certainty: 'uncertain' });
    assert.deepEqual(stopped.retained.provenance.cost, { basis: 'unobserved', reason: 'usage-unknown' });
    assert.equal(stopped.retained.provenance.installation?.executablePath, '/original/bin/copilot');
  },
);

// Zero contact for the native profile: the exact native-v1 seatbelt rules (built by the same function, with Node as the
// one executable it may run) reach only the owned loopback proxy, and the proxy refuses an unlisted CONNECT before any
// upstream byte. macOS sandbox-exec only; nothing here is Docker-gated and no Copilot code or login is needed.
test(
  'the native profile reaches only the child proxy, which refuses an unlisted destination before any upstream byte',
  { skip: process.platform !== 'darwin' && 'macOS sandbox-exec' },
  async (t) => {
    const owned = realpathSync(mkdtempSync('/private/tmp/sentinel-zero-contact-'));
    t.after(() => spawnSync('/bin/rm', ['-rf', owned]));
    for (const d of ['home', 'state', 'tmp', 'work']) mkdirSync(join(owned, d));
    const proxy = await openNativeCopilotProxy({
      deadlineAt: Date.now() + 20000,
      maxUpstreamBytes: 4096,
      maxDownstreamBytes: 4096,
    });
    t.after(() => proxy.close());
    const policy = copilotSeatbeltPolicy({
      executable: process.execPath,
      ownedRoot: owned,
      ownerHome: homedir(),
      proxyPort: proxy.port,
    });
    const probe = join(owned, 'zero-contact.mjs');
    writeFileSync(
      probe,
      `import { connect } from 'node:net';
const attempt = (host, port, send) => new Promise((resolve) => {
  const s = connect({ host, port }, () => { if (send) s.write(send); else { s.destroy(); resolve('connected'); } });
  let got = '';
  s.on('data', (b) => { got += b; });
  s.on('error', (e) => resolve('error:' + e.code));
  s.on('close', () => resolve(got ? 'reply' : 'closed'));
  setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
});
console.log(JSON.stringify({
  publicHost: await attempt('1.1.1.1', 443),
  otherLoopback: await attempt('127.0.0.1', 9),
  proxy: await attempt('127.0.0.1', ${proxy.port}),
  unlisted: await attempt('127.0.0.1', ${proxy.port}, 'CONNECT example.invalid:443 HTTP/1.1\\r\\nHost: example.invalid:443\\r\\n\\r\\n'),
}));
`,
    );
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, probe], {
        cwd: join(owned, 'home'),
        env: { PATH: '/usr/bin:/bin', HOME: homedir() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (b) => (text += b));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(Error('probe exit ' + code))));
    });
    assert.deepEqual(JSON.parse(out), {
      publicHost: 'error:EPERM',
      otherLoopback: 'error:EPERM',
      proxy: 'connected',
      unlisted: 'closed',
    });
    const seen = proxy.observation();
    assert.equal(seen.upstreamWireBytes, 0, 'no byte left for any destination');
    assert.equal(seen.downstreamWireBytes, 0);
    assert.equal(seen.endedBy, 'open', 'an unlisted socket is refused without ending the proxy');
  },
);
