import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOOK_EVENTS, prepareHooks } from '../dist/hooks.js';
import type { EchoContext, EchoProfile } from '../src/types.ts';

const profile: EchoProfile = {
  identity: { individual: 'example', project: 'example-project' },
  backend: { mode: 'managed', url: 'http://127.0.0.1:3311' },
  model: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'example-model' },
  web: { port: 4490 }, hooks: { claude: false, codex: false }, skills: { directories: [] },
  budget: { briefMaxChars: 1500, modelMaxTokens: 256, timeoutMs: 5000 },
};

test('only events with current memory behavior are registered', () => {
  assert.deepEqual(HOOK_EVENTS, ['SessionStart', 'UserPromptSubmit']);
});

async function fixture(): Promise<{ root: string; ctx: EchoContext; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), 'echo-hooks-'));
  // Shell-sensitive characters must remain literal throughout the runner chain.
  const directory = join(root, "private ' folder $(touch ECHO_HOOK_MUST_NOT_EXIST)");
  await mkdir(directory);
  const executable = join(directory, "echo ' command.mjs");
  await writeFile(executable, `import { writeFileSync } from 'node:fs';\nlet input = '';\nfor await (const chunk of process.stdin) input += chunk;\nwriteFileSync(process.env.ECHO_TEST_OUTPUT, JSON.stringify({ args: process.argv.slice(2), input }));\nprocess.exit(Number(process.env.ECHO_TEST_EXIT ?? 0));\n`);
  const ctx: EchoContext = {
    configPath: join(directory, "echo ' settings.json"),
    config: { version: 1, defaultProfile: 'personal', profiles: { personal: profile } },
    profileId: 'personal', profile, directory, dataDirectory: join(directory, 'data'),
  };
  return { root, ctx, executable };
}

for (const host of ['claude', 'codex'] as const) {
  test(`${host} preparation creates one portable hook set without enabling the host`, { skip: process.platform === 'win32' }, async t => {
    const { root, ctx, executable } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await prepareHooks(ctx, host, executable);
    assert.equal(result.directory, join(ctx.directory, 'plugins', 'personal', host));
    assert.match(result.instructions, /Prepared for review; hooks are not enabled/);
    assert.match(result.instructions, /do not save conversation content/);
    assert.match(result.instructions, host === 'claude' ? /claude --plugin-dir/ : /codex plugin marketplace add/);
    assert.equal(ctx.profile.hooks[host], false, 'explicit helper does not mutate configuration');
    const manifest = JSON.parse(await readFile(join(result.directory, host === 'claude' ? '.claude-plugin' : '.codex-plugin', 'plugin.json'), 'utf8'));
    assert.match(manifest.name, /^echo-personal-/);
    assert.equal(manifest.hooks, host === 'codex' ? './hooks/hooks.json' : undefined, 'Claude default discovery must not be registered a second time');
    const hookFile = JSON.parse(await readFile(join(result.directory, 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hookFile.hooks), [...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) {
      assert.equal(hookFile.hooks[event].length, 1);
      assert.equal(hookFile.hooks[event][0].hooks.length, 1);
      assert.equal(hookFile.hooks[event][0].hooks[0].timeout, 5);
    }
    if (host === 'codex') {
      const catalog = JSON.parse(await readFile(join(result.directory, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
      assert.equal(catalog.plugins[0].name, manifest.name);
      assert.equal(catalog.plugins[0].source.path, './');
      assert.equal(catalog.plugins[0].policy.installation, 'AVAILABLE');
    }
    assert.equal((await stat(join(result.directory, 'scripts', 'echo-hook.mjs'))).mode & 0o777, 0o700);
    await assert.rejects(access(join(ctx.directory, '.claude', 'settings.json')));
    await assert.rejects(access(join(ctx.directory, '.codex', 'config.toml')));
    assert.deepEqual(await prepareHooks(ctx, host, executable), result, 'preparation is repeatable');
  });

  test(`${host} generated command forwards input and literal paths, with no context output`, { skip: process.platform === 'win32' }, async t => {
    const { root, ctx, executable } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const { directory } = await prepareHooks(ctx, host, executable);
    const hookFile = JSON.parse(await readFile(join(directory, 'hooks', 'hooks.json'), 'utf8'));
    const command = hookFile.hooks.UserPromptSubmit[0].hooks[0].command;
    const output = join(root, 'received.json');
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'synthetic-session', prompt: 'synthetic only' });
    const env = { ...process.env, ECHO_TEST_OUTPUT: output, [host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT']: directory };
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, input, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      args: ['hook', '--config', ctx.configPath, '--profile', 'personal', '--host', host], input,
    });
    await assert.rejects(access(join(root, 'ECHO_HOOK_MUST_NOT_EXIST')));
    const failure = spawnSync('/bin/sh', ['-c', command], { cwd: root, input, encoding: 'utf8', env: { ...env, ECHO_TEST_EXIT: '1' } });
    assert.equal(failure.status, 1, 'runner preserves a failed session binding');
    assert.equal(failure.stdout, '');
  });
}

test('preparation rejects a path-traversing profile and missing or relative executables', { skip: process.platform === 'win32' }, async t => {
  const { root, ctx, executable } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareHooks({ ...ctx, profileId: '../work' }, 'claude', executable), /profile name/);
  await assert.rejects(prepareHooks(ctx, 'claude', 'relative.mjs'), /absolute/);
  await assert.rejects(prepareHooks(ctx, 'claude', join(root, 'missing.mjs')), /Build or install/);
  await assert.rejects(prepareHooks(ctx, 'claude', root), /Build or install/);
});

test('different profile spellings produce distinct plugin identities', { skip: process.platform === 'win32' }, async t => {
  const { root, ctx, executable } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const names: string[] = [];
  for (const profileId of ['Work-A', 'work-a', 'work_a']) {
    const { directory } = await prepareHooks({ ...ctx, profileId }, 'codex', executable);
    names.push(JSON.parse(await readFile(join(directory, '.codex-plugin', 'plugin.json'), 'utf8')).name);
  }
  assert.equal(new Set(names).size, names.length);
});
