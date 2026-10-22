// scripts/npm-consumer.mjs: the consumer is clean of the caller's npm configuration and leaves
// nothing behind when npm fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanNpmEnv, npmConsumer } from '../npm-consumer.mjs';

test('inherited npm configuration is dropped; config, cache and state are task-local; HOME is kept', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'npm-env-'));
  try {
    const env = cleanNpmEnv(scratch, {
      HOME: '/home/dev', PATH: '/bin', npm_config_registry: 'https://mirror.example.invalid/',
      NPM_CONFIG_USERCONFIG: '/home/dev/.npmrc', npm_config_user_agent: 'pnpm/9.0.0', npm_lifecycle_event: 'test',
    });
    assert.equal(env.HOME, '/home/dev');
    assert.equal(env.PATH, '/bin');
    assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(env.npm_config_user_agent, undefined);
    assert.equal(env.npm_lifecycle_event, undefined);
    assert.equal(env.npm_config_registry, undefined, 'a registry is not inherited implicitly');
    assert.equal(env.npm_config_userconfig, join(scratch, 'npmrc'));
    assert.equal(env.npm_config_globalconfig, join(scratch, 'global-npmrc'));
    assert.equal(readFileSync(env.npm_config_userconfig, 'utf8'), '');
    assert.ok(env.npm_config_cache.startsWith(scratch) && env.XDG_CONFIG_HOME.startsWith(scratch));
    assert.equal(cleanNpmEnv(scratch, { FARSIGHT_NPM_REGISTRY: 'https://mirror.example.invalid/' }).npm_config_registry,
      'https://mirror.example.invalid/', 'an explicit registry is carried over');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('npm sees only the task-local config files', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'npm-env-'));
  try {
    const env = cleanNpmEnv(scratch, { ...process.env, npm_config_userconfig: '/nonexistent/caller.npmrc', npm_config_fund: 'true' });
    assert.equal(execFileSync('npm', ['config', 'get', 'userconfig'], { env, encoding: 'utf8' }).trim(), join(scratch, 'npmrc'));
    assert.equal(execFileSync('npm', ['config', 'get', 'globalconfig'], { env, encoding: 'utf8' }).trim(), join(scratch, 'global-npmrc'));
    assert.equal(execFileSync('npm', ['config', 'get', 'fund'], { env, encoding: 'utf8' }).trim(), 'false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the caller's .npmrc settings (save-exact through an inherited userconfig) do not apply", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'npm-env-'));
  try {
    const caller = join(scratch, 'caller.npmrc');
    writeFileSync(caller, 'save-exact=true\n');
    const inherited = { ...process.env, npm_config_userconfig: caller, NPM_CONFIG_SAVE_EXACT: 'true' };
    assert.equal(execFileSync('npm', ['config', 'get', 'save-exact'], { env: inherited, encoding: 'utf8' }).trim(), 'true', 'the repro applies it');
    const local = mkdtempSync(join(scratch, 'consumer-'));
    assert.equal(execFileSync('npm', ['config', 'get', 'save-exact'], { env: cleanNpmEnv(local, inherited), encoding: 'utf8' }).trim(), 'false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('a failed install removes the scratch consumer and names the npm step', async () => {
  const prefix = `npm-consumer-fail-${process.pid}-`;
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
  const missing = join(tmpdir(), `absent-${process.pid}.tgz`);
  assert.equal(existsSync(missing), false);
  await assert.rejects(npmConsumer(prefix, [missing]), /npm install failed in a clean consumer/);
  assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)), before);
});
