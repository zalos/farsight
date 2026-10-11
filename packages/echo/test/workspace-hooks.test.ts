import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '../dist/config.js';
import { HOOK_EVENTS, prepareHooks } from '../dist/hooks.js';
import { installWorkspaceHooks } from '../dist/workspace-hooks.js';
import type { EchoContext } from '../src/types.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'echo-workspace-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace ' $(touch ECHO_MUST_NOT_EXIST)");
  const directory = join(workspace, '.echo');
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "echo ' cli.mjs");
  await writeFile(executable, `import {writeFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;writeFileSync(process.env.ECHO_TEST_OUTPUT,JSON.stringify({args:process.argv.slice(2),input}));console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'saved-memory'}}));`);
  const config = defaultConfig();
  const ctx: EchoContext = { directory, config, configPath: join(directory, "settings ' file.json"), profileId: 'personal', profile: config.profiles.personal!, dataDirectory: join(directory, 'profiles', 'personal') };
  const paths = { claude: join(workspace, '.claude', 'settings.local.json'), codex: join(workspace, '.codex', 'hooks.json'), vscode: join(workspace, '.github', 'hooks', 'echo.json') };
  return { root, workspace, ctx, executable, paths };
}
async function save(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
const options = { vscodeUserSettingsPaths: [] };

test('all workspace hosts install once, preserve unrelated settings and back up exact originals', async t => {
  const { ctx, executable, workspace, paths } = await fixture(t);
  const command = { type: 'command', command: 'echo existing', timeout: 17 };
  await save(paths.claude, { permissions: { allow: ['Read'] }, hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [command] }], SomeFutureEvent: [{ hooks: [command] }] } });
  await save(paths.codex, { hooks: { Stop: [{ hooks: [command] }] } });
  await save(paths.vscode, { hooks: { SessionStart: [command] } });
  const originals = await Promise.all(Object.values(paths).map(path => readFile(path, 'utf8')));
  const first = await installWorkspaceHooks(ctx, 'all', executable, workspace, options);
  assert.deepEqual(first.changedPaths, Object.values(paths));
  assert.match(first.instructions, /review and trust these exact hook definitions/);
  const claude = JSON.parse(await readFile(paths.claude, 'utf8'));
  assert.deepEqual(claude.permissions, { allow: ['Read'] });
  assert.deepEqual(claude.hooks.UserPromptSubmit[0], { matcher: '*', hooks: [command] });
  assert.deepEqual(claude.hooks.SomeFutureEvent, [{ hooks: [command] }]);
  for (const host of ['claude', 'codex', 'vscode'] as const) {
    const doc = JSON.parse(await readFile(paths[host], 'utf8'));
    for (const event of HOOK_EVENTS) {
      const last = doc.hooks[event].at(-1);
      const hook = host === 'vscode' ? last : last.hooks[0];
      assert.equal(hook.timeout, 5);
      assert.match(hook.command, new RegExp(`farsight-echo-workspace-v1:${host}$`));
    }
    assert.equal((await stat(paths[host])).mode & 0o777, 0o600);
  }
  const [backup] = await readdir(join(ctx.directory, 'backups'));
  assert.ok(backup);
  for (const [index, path] of Object.values(paths).entries()) {
    assert.equal(await readFile(join(ctx.directory, 'backups', backup!, path.slice(workspace.length + 1)), 'utf8'), originals[index]);
  }
  const before = await Promise.all(Object.values(paths).map(path => stat(path)));
  const second = await installWorkspaceHooks(ctx, 'all', executable, workspace, options);
  assert.deepEqual(second.changedPaths, []);
  assert.deepEqual(await Promise.all(Object.values(paths).map(path => stat(path).then(info => info.mtimeMs))), before.map(info => info.mtimeMs));
  assert.equal((await readdir(join(ctx.directory, 'backups'))).length, 1);
});

test('updating an Echo installation changes only owned hooks, including mixed existing groups', async t => {
  const { ctx, executable, workspace, paths } = await fixture(t);
  await installWorkspaceHooks(ctx, 'claude', executable, workspace, options);
  const doc = JSON.parse(await readFile(paths.claude, 'utf8'));
  const other = { type: 'command', command: 'echo echo-memory-but-not-owned' };
  doc.hooks.Stop[0].hooks.push(other);
  await save(paths.claude, doc);
  const updated = { ...ctx, profileId: 'work', profile: ctx.config.profiles.work! };
  await installWorkspaceHooks(updated, 'claude', executable, workspace, options);
  const result = JSON.parse(await readFile(paths.claude, 'utf8'));
  assert.deepEqual(result.hooks.Stop[0].hooks, [other]);
  assert.equal(result.hooks.Stop.length, 2);
  assert.match(result.hooks.Stop[1].hooks[0].command, /'--profile' 'work'/);
});

test('workspace hooks preserve literal paths, input and additional context for every host', async t => {
  const { root, ctx, executable, workspace, paths } = await fixture(t);
  await installWorkspaceHooks(ctx, 'all', executable, workspace, options);
  for (const host of ['claude', 'codex', 'vscode'] as const) {
    const doc = JSON.parse(await readFile(paths[host], 'utf8'));
    const hook = host === 'vscode' ? doc.hooks.UserPromptSubmit[0] : doc.hooks.UserPromptSubmit[0].hooks[0];
    const output = join(root, `${host}.json`), input = '{"prompt":"synthetic"}';
    const result = spawnSync('/bin/sh', ['-c', hook.command], { cwd: workspace, input, encoding: 'utf8', env: { ...process.env, ECHO_TEST_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, 'saved-memory');
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { input, args: ['hook', '--config', ctx.configPath, '--profile', 'personal', '--host', host, '--workspace', workspace] });
    await assert.rejects(access(join(workspace, 'ECHO_MUST_NOT_EXIST')));
  }
});

test('malformed files and symbolic hook destinations fail before another host is changed', async t => {
  const { root, ctx, executable, workspace, paths } = await fixture(t);
  await save(paths.claude, { permissions: { allow: ['Read'] } });
  const original = await readFile(paths.claude, 'utf8');
  await save(paths.vscode, { hooks: { UserPromptSubmit: {} } });
  await assert.rejects(installWorkspaceHooks(ctx, 'all', executable, workspace, options), /structure/);
  assert.equal(await readFile(paths.claude, 'utf8'), original);
  await assert.rejects(access(paths.codex));
  await writeFile(paths.vscode, '{"hooks":{"Stop":[]},"hooks":{}}');
  await assert.rejects(installWorkspaceHooks(ctx, 'all', executable, workspace, options), /structure/);
  await writeFile(paths.vscode, '{"hooks":{"Stop":null}}');
  await assert.rejects(installWorkspaceHooks(ctx, 'all', executable, workspace, options), /structure/);
  await rm(paths.vscode);
  await symlink(join(root, 'outside.json'), paths.vscode);
  await assert.rejects(installWorkspaceHooks(ctx, 'all', executable, workspace, options));
  assert.equal(await readFile(paths.claude, 'utf8'), original);
});

test('VS Code Claude-hook loading prevents duplicate installation across separate calls and JSONC settings', async t => {
  const { root, ctx, executable, workspace, paths } = await fixture(t);
  const user = join(root, 'user-settings.json');
  await writeFile(user, '{ // settings\n "chat.useClaudeHooks": true, "example": "https://example.com/*literal*/", }');
  const opts = { vscodeUserSettingsPaths: [user] };
  await assert.rejects(installWorkspaceHooks(ctx, 'all', executable, workspace, opts), /chat.useClaudeHooks/);
  await assert.rejects(access(paths.claude));
  await installWorkspaceHooks(ctx, 'vscode', executable, workspace, opts);
  await assert.rejects(installWorkspaceHooks(ctx, 'claude', executable, workspace, opts), /chat.useClaudeHooks/);
  await save(join(workspace, '.vscode', 'settings.json'), { 'chat.useClaudeHooks': false });
  const saved = await readFile(user, 'utf8');
  await installWorkspaceHooks(ctx, 'all', executable, workspace, opts);
  assert.equal(await readFile(user, 'utf8'), saved, 'global preferences are read but never changed');
});

test('VS Code preparation remains review-only and emits its flat native format', async t => {
  const { ctx, executable, paths } = await fixture(t);
  const result = await prepareHooks(ctx, 'vscode', executable);
  assert.match(result.instructions, /Local agent/);
  const doc = JSON.parse(await readFile(join(result.directory, 'echo.json'), 'utf8'));
  assert.deepEqual(Object.keys(doc.hooks), [...HOOK_EVENTS]);
  assert.equal(doc.hooks.UserPromptSubmit[0].type, 'command');
  await assert.rejects(access(paths.vscode));
});

test('reconnecting one host retargets every installed Echo host to one profile', async t => {
  const { ctx, executable, workspace, paths } = await fixture(t);
  await installWorkspaceHooks(ctx, 'all', executable, workspace, options);
  const global = { ...ctx, configPath: join(ctx.directory, 'shared-settings.json'), profileId: 'work', profile: ctx.config.profiles.work! };
  const changed = await installWorkspaceHooks(global, 'claude', executable, workspace, options);
  assert.deepEqual(changed.hosts, ['claude', 'codex', 'vscode']);
  for (const host of changed.hosts) {
    const events = JSON.parse(await readFile(paths[host], 'utf8')).hooks;
    const command = host === 'vscode' ? events.UserPromptSubmit[0].command : events.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.includes("'--profile' 'work'"));
    assert.ok(command.includes('shared-settings.json'));
  }
});
