import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext, saveConfig } from '../dist/config.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
test('unattended init saves the chosen model only in its selected profile and preserves existing settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'echo-cli-'));
  const config = join(directory, 'settings.json');
  try {
    const args = [entry, 'init', '--config', config, '--profile', 'work', '--model', 'synthetic-local-model'];
    await run(process.execPath, args);
    const before = readFileSync(config, 'utf8');
    const value = JSON.parse(before);
    assert.equal(value.profiles.work.model.model, 'synthetic-local-model');
    assert.equal(value.profiles.personal.model.model, '');
    assert.equal(value.profiles.work.hooks.claude, false);
    assert.equal(value.profiles.work.hooks.codex, false);
    await assert.rejects(run(process.execPath, args));
    assert.equal(readFileSync(config, 'utf8'), before);
    const ctx = loadContext(config);
    ctx.config.profiles.personal!.backend = { mode: 'external', url: 'http://127.0.0.1:19998' };
    await saveConfig(config, ctx.config);
    await assert.rejects(run(process.execPath, [entry, 'doctor', '--config', config]), (error: any) => {
      const checks = JSON.parse(error.stdout);
      return checks.some((check: any) => check.name === 'backend' && !check.ok);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
