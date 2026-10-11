import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { contextFingerprint } from '../dist/sessions.js';
import { connectionPath, describeInstallation, globalConfigPath, preflightConnection, readConnection, resolveInstallation, writeConnection } from '../dist/installation.js';

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'echo-installation-'));
  try { await run(await realpath(folder)); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test('global path uses only an absolute XDG directory and never implicitly selects global memory', async () => {
  const xdg = process.env.XDG_CONFIG_HOME;
  assert.equal(globalConfigPath(), join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'farsight-echo', 'settings.json'));
  await fixture(async root => {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const globalPath = join(root, 'global', 'settings.json');
    await saveConfig(globalPath, defaultConfig());
    assert.deepEqual(resolveInstallation({ cwd: workspace, globalPath }), {
      scope: 'workspace', configPath: join(workspace, '.echo', 'settings.json'), workspaceRoot: workspace,
    });
    assert.deepEqual(resolveInstallation({ cwd: workspace, globalPath, scope: 'global', profileId: 'personal' }), {
      scope: 'global', configPath: globalPath, profileId: 'personal',
    });
  });
});

test('selection rejects conflicting flags and invalid profiles before discovery', async () => {
  await fixture(async cwd => {
    assert.throws(() => resolveInstallation({ cwd, scope: 'global', configPath: 'settings.json' }), /either/);
    for (const scope of ['all', 'personal', '', 'GLOBAL']) assert.throws(() => resolveInstallation({ cwd, scope }), /scope/);
    for (const profileId of ['', '../work', 'Work', 'constructor', 'a'.repeat(49)]) {
      assert.throws(() => resolveInstallation({ cwd, profileId }), /profile/);
    }
    assert.deepEqual(resolveInstallation({ cwd, configPath: './custom/settings.json', profileId: 'work' }), {
      scope: 'custom', configPath: join(cwd, 'custom', 'settings.json'), profileId: 'work',
    });
  });
});

test('nested commands discover the nearest workspace and never cross a nested Git root', async () => {
  await fixture(async root => {
    const outer = join(root, 'outer'), inner = join(outer, 'inner'), deep = join(inner, 'src');
    const globalPath = join(root, 'shared', 'settings.json');
    await mkdir(deep, { recursive: true });
    await mkdir(join(outer, '.git'));
    await writeConnection(outer, { configPath: globalPath, profileId: 'personal' });
    assert.equal(resolveInstallation({ cwd: deep, globalPath }).connectionPath, connectionPath(outer));
    await writeFile(join(inner, '.git'), 'gitdir: elsewhere\n');
    assert.deepEqual(resolveInstallation({ cwd: deep, globalPath }), {
      scope: 'workspace', configPath: join(inner, '.echo', 'settings.json'), workspaceRoot: inner,
    });
    await rm(join(inner, '.git'));
    await saveConfig(join(inner, '.echo', 'settings.json'), defaultConfig());
    assert.equal(resolveInstallation({ cwd: deep, globalPath }).configPath, join(inner, '.echo', 'settings.json'));
  });
});

test('a connection wins over local settings unless workspace selection is explicit', async () => {
  await fixture(async cwd => {
    const globalPath = join(cwd, 'shared', 'settings.json');
    const localPath = join(cwd, '.echo', 'settings.json');
    await saveConfig(localPath, defaultConfig());
    await writeConnection(cwd, { configPath: globalPath, profileId: 'personal' });
    const selected = resolveInstallation({ cwd, globalPath });
    assert.equal(selected.scope, 'global');
    assert.equal(selected.profileId, 'personal');
    assert.equal(selected.configPath, globalPath);
    assert.equal(resolveInstallation({ cwd, globalPath, profileId: 'work' }).profileId, 'work');
    for (const bypass of [{ scope: 'workspace' }, { ignoreConnection: true }]) {
      const resolved = resolveInstallation({ cwd, globalPath, ...bypass });
      assert.equal(resolved.configPath, localPath);
      assert.equal(resolved.connectionPath, undefined);
    }
  });
});

test('missing or malformed bound settings cannot silently fall back to valid local settings', async () => {
  await fixture(async cwd => {
    await saveConfig(join(cwd, '.echo', 'settings.json'), defaultConfig());
    const missing = join(cwd, 'global', 'settings.json');
    await writeConnection(cwd, { configPath: missing, profileId: 'work' });
    const selected = resolveInstallation({ cwd, globalPath: missing });
    assert.equal(selected.configPath, missing);
    assert.throws(() => loadContext(selected.configPath, selected.profileId), /could not be read/);
    await writeFile(connectionPath(cwd), '{"version": 2}');
    assert.throws(() => resolveInstallation({ cwd }), /connection/);
    assert.equal(resolveInstallation({ cwd, scope: 'workspace' }).configPath, join(cwd, '.echo', 'settings.json'));
  });
});

test('two workspaces reuse exactly one shared profile without changing its memory identity', async () => {
  await fixture(async root => {
    const globalPath = join(root, 'global', 'settings.json');
    await saveConfig(globalPath, defaultConfig());
    const contexts = [];
    for (const name of ['first', 'second']) {
      const cwd = join(root, name);
      await mkdir(cwd);
      await writeConnection(cwd, { configPath: globalPath, profileId: 'work' });
      const selected = resolveInstallation({ cwd, globalPath });
      contexts.push(loadContext(selected.configPath, selected.profileId));
    }
    assert.equal(contexts[0]!.dataDirectory, contexts[1]!.dataDirectory);
    assert.equal(contextFingerprint(contexts[0]!), contextFingerprint(contexts[1]!));
    assert.equal(contexts[0]!.profile.identity.project, 'default');
    assert.equal(contexts[1]!.profile.identity.project, 'default');
  });
});

test('connection writes are private, idempotent and back up exact original contents', async () => {
  await fixture(async root => {
    const binding = { configPath: join(root, 'global', 'settings.json'), profileId: 'personal' };
    assert.equal(readConnection(root), undefined);
    const created = await writeConnection(root, binding);
    assert.equal(created.changed, true);
    assert.equal((await stat(created.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(created.path))).mode & 0o777, 0o700);
    const original = ` { "profileId": "personal", "version": 1, "configPath": ${JSON.stringify(binding.configPath)} } \n`;
    await writeFile(created.path, original);
    assert.equal((await writeConnection(root, binding)).changed, false);
    assert.equal(await readFile(created.path, 'utf8'), original);
    assert.deepEqual(await readdir(dirname(created.path)), ['connection.json']);
    const replaced = await writeConnection(root, { ...binding, profileId: 'work' });
    assert.equal(replaced.changed, true);
    assert.ok(replaced.backupPath);
    assert.equal(await readFile(replaced.backupPath, 'utf8'), original);
    assert.equal((await stat(replaced.backupPath)).mode & 0o777, 0o600);
    assert.deepEqual(readConnection(root), { version: 1, ...binding, profileId: 'work' });
  });
});

test('binding parsing rejects ambiguity, unknown fields, invalid UTF-8 and oversized data', async () => {
  await fixture(async root => {
    await mkdir(join(root, '.echo'));
    const binding = { version: 1, configPath: join(root, 'settings.json'), profileId: 'work' };
    const invalid = [
      '', 'null', '[]', '{}', JSON.stringify({ ...binding, extra: true }),
      JSON.stringify({ ...binding, configPath: './settings.json' }),
      JSON.stringify({ ...binding, profileId: '../work' }),
      JSON.stringify({ ...binding, profileId: { name: 'work' } }),
      '{"version":1,"version":1,"configPath":"/tmp/settings.json","profileId":"work"}',
      '{"version":1,"configPath":"/tmp/settings.json","profileId":"work","profile\\u0049d":"personal"}',
      ' '.repeat(16_385), Buffer.from([0xff, 0xfe]),
    ];
    for (const text of invalid) {
      await writeFile(connectionPath(root), text);
      assert.throws(() => readConnection(root), /connection/);
      await assert.rejects(writeConnection(root, binding));
    }
    const quoted = { ...binding, configPath: join(root, 'a "profileId":,{}[x]', 'settings.json') };
    await writeFile(connectionPath(root), JSON.stringify(quoted));
    assert.throws(() => readConnection(root), /not trusted/);
    await writeConnection(root, quoted);
    assert.deepEqual(readConnection(root), quoted);
  });
});

test('symbolic workspace, settings directory, connection and backups paths are refused', async () => {
  await fixture(async root => {
    const outside = join(root, 'outside'), workspace = join(root, 'workspace');
    await mkdir(outside);
    await mkdir(workspace);
    const binding = { configPath: join(outside, 'settings.json'), profileId: 'work' };
    const alias = join(root, 'alias');
    await symlink(workspace, alias);
    assert.throws(() => readConnection(alias));
    await assert.rejects(writeConnection(alias, binding));
    await symlink(outside, join(workspace, '.echo'));
    assert.throws(() => resolveInstallation({ cwd: workspace }));
    await assert.rejects(writeConnection(workspace, binding));
    await rm(join(workspace, '.echo'));
    await mkdir(join(workspace, '.echo'));
    await writeFile(join(outside, 'binding.json'), JSON.stringify({ version: 1, ...binding }));
    await symlink(join(outside, 'binding.json'), connectionPath(workspace));
    assert.throws(() => readConnection(workspace));
    await assert.rejects(writeConnection(workspace, binding));
    await rm(connectionPath(workspace));
    await writeConnection(workspace, binding);
    await symlink(outside, join(workspace, '.echo', 'backups'));
    await assert.rejects(writeConnection(workspace, { ...binding, profileId: 'personal' }));
    assert.equal(readConnection(workspace)?.profileId, 'work');
    assert.deepEqual(await readdir(outside), ['binding.json']);
  });
});

test('installation descriptions follow existing canonical aliases and distinguish custom settings', async () => {
  await fixture(async root => {
    const globalPath = join(root, 'global', 'settings.json');
    await saveConfig(globalPath, defaultConfig());
    const alias = join(root, 'alias.json');
    await symlink(globalPath, alias);
    assert.deepEqual(describeInstallation(alias, globalPath), { scope: 'global', configPath: globalPath });
    const local = join(root, 'workspace', '.echo', 'settings.json');
    assert.deepEqual(describeInstallation(local, globalPath), { scope: 'workspace', configPath: local, workspaceRoot: join(root, 'workspace') });
    assert.deepEqual(describeInstallation(join(root, 'custom.json'), globalPath), { scope: 'custom', configPath: join(root, 'custom.json') });
  });
});

test('connection preflight validates proposed and existing bindings without creating files', async () => {
  await fixture(async root => {
    const binding = { configPath: join(root, 'global', 'settings.json'), profileId: 'work' };
    preflightConnection(root, binding);
    assert.deepEqual(await readdir(root), []);
    assert.throws(() => preflightConnection(root, { ...binding, configPath: './settings.json' }));
    assert.throws(() => preflightConnection(root, { ...binding, profileId: '../work' }));
    assert.deepEqual(await readdir(root), []);
    await mkdir(join(root, '.echo'));
    await writeFile(connectionPath(root), '{"version":2}');
    assert.throws(() => preflightConnection(root, binding));
    assert.equal(await readFile(connectionPath(root), 'utf8'), '{"version":2}');
    assert.deepEqual(await readdir(join(root, '.echo')), ['connection.json']);
  });
});

test('invalid backup paths fail preflight and writes before any local permissions or files change', async () => {
  await fixture(async root => {
    const outside = join(root, 'outside'), workspace = join(root, 'workspace');
    await mkdir(outside);
    await mkdir(workspace);
    const binding = { configPath: join(outside, 'settings.json'), profileId: 'work' };
    await writeConnection(workspace, binding);
    const local = join(workspace, '.echo'), backups = join(local, 'backups');
    const original = await readFile(connectionPath(workspace), 'utf8');
    await chmod(local, 0o750);
    for (const type of ['file', 'symlink']) {
      if (type === 'file') await writeFile(backups, 'preserve');
      else await symlink(outside, backups);
      const changed = { ...binding, profileId: 'personal' };
      assert.throws(() => preflightConnection(workspace, changed));
      await assert.rejects(writeConnection(workspace, changed));
      assert.equal((await stat(local)).mode & 0o777, 0o750);
      assert.equal(await readFile(connectionPath(workspace), 'utf8'), original);
      assert.deepEqual((await readdir(local)).sort(), ['backups', 'connection.json']);
      assert.deepEqual(await readdir(outside), []);
      if (type === 'file') assert.equal(await readFile(backups, 'utf8'), 'preserve');
      await rm(backups);
    }
  });
});

test('connection preflight refuses unwritable parent directories without changing their permissions', { skip: process.getuid?.() === 0 }, async () => {
  await fixture(async root => {
    const binding = { configPath: join(root, 'global', 'settings.json'), profileId: 'work' };
    await chmod(root, 0o500);
    try {
      assert.throws(() => preflightConnection(root, binding), /permission/);
      await assert.rejects(writeConnection(root, binding), /permission/);
      assert.deepEqual(await readdir(root), []);
    } finally { await chmod(root, 0o700); }
    await writeConnection(root, binding);
    const changed = { ...binding, profileId: 'personal' };
    const local = join(root, '.echo'), backups = join(local, 'backups');
    await mkdir(backups);
    for (const path of [local, backups]) {
      await chmod(path, 0o500);
      try {
        assert.throws(() => preflightConnection(root, changed), /permission/);
        await assert.rejects(writeConnection(root, changed), /permission/);
        assert.equal((await stat(path)).mode & 0o777, 0o500);
        assert.equal(readConnection(root)?.profileId, 'work');
        assert.deepEqual(await readdir(backups), []);
      } finally { await chmod(path, 0o700); }
    }
  });
});
