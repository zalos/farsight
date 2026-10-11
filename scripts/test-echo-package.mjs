#!/usr/bin/env node
// Explicit integration check: installs the packed artifact and downloads the pinned engine.
// No model, API key, existing memory store or real agent session is involved.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const scratch = mkdtempSync(join(tmpdir(), 'echo-package-'));
const artifact = join(root, 'build', 'echo', `farsight-echo-${version}.tgz`);
async function free(port) {
  return new Promise(resolve => {
    const socket = createServer();
    socket.once('error', () => resolve(false));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
}
try {
  const prefix = join(scratch, 'install');
  mkdirSync(prefix);
  await run('npm', ['install', '--prefix', prefix, '--omit=optional', '--no-audit', '--no-fund', artifact], { timeout: 180_000, maxBuffer: 4_000_000 });
  const entry = join(prefix, 'node_modules', 'farsight-echo', 'dist', 'echo.mjs');
  const config = join(scratch, 'settings', 'settings.json');
  const cli = args => run(process.execPath, [entry, ...args, '--config', config], { cwd: scratch, timeout: 180_000, maxBuffer: 4_000_000 });
  assert.match((await cli(['--help'])).stdout, /Echo/);
  await cli(['init']);
  const settings = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(settings.profiles.personal.hooks.claude, false);
  assert.equal(settings.profiles.personal.hooks.codex, false);
  // Other worktrees may be running the same smoke check. Select a separate block;
  // the runtime checks again immediately before starting and never adopts a listener.
  let base;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = randomInt(12000, 14000);
    const ports = [candidate, candidate + 1, candidate + 2, candidate + 46023, candidate + 10, candidate + 11, candidate + 12, candidate + 46033];
    if ((await Promise.all(ports.map(free))).every(Boolean)) { base = candidate; break; }
  }
  assert.ok(base, 'a free engine port block is required');
  settings.profiles.personal.backend.url = `http://127.0.0.1:${base}`;
  writeFileSync(config, JSON.stringify(settings, null, 2) + '\n');
  const duplicate = await cli(['init']).then(() => false, () => true);
  assert.ok(duplicate, 'init must preserve existing settings');
  await cli(['install-runtime']);
  const checks = JSON.parse((await cli(['smoke'])).stdout);
  assert.deepEqual(checks.map(check => [check.name, check.ok]), [
    ['remember-recall', true], ['restart-persistence', true], ['store-isolation', true],
  ]);
  console.log('Echo tarball: clean install, CLI, pinned engine, save/recall, restart and store isolation passed.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
