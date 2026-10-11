#!/usr/bin/env node
// Explicit integration check: installs the packed artifact and downloads the pinned engine.
// No model, API key, existing memory store or real agent session is involved.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const scratch = mkdtempSync(join(tmpdir(), 'echo-package-'));
const artifact = join(root, 'build', 'echo', `farsight-echo-${version}.tgz`);
const occupiedProfile = createServer();
let serving;
async function stopServe() {
  if (!serving || serving.exitCode !== null || serving.signalCode !== null) return;
  const child = serving;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
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
    const ports = [candidate, candidate + 1, candidate + 2, candidate + 46023, candidate + 50];
    if ((await Promise.all(ports.map(free))).every(Boolean)) { base = candidate; break; }
  }
  assert.ok(base, 'a free engine port block is required');
  settings.profiles.personal.backend.url = `http://127.0.0.1:${base}`;
  settings.profiles.personal.web.port = base + 50;
  writeFileSync(config, JSON.stringify(settings, null, 2) + '\n');
  const duplicate = await cli(['init']).then(() => false, () => true);
  assert.ok(duplicate, 'init must preserve existing settings');
  await cli(['install-runtime']);
  // A running profile must not prevent the disposable smoke test from starting.
  // Older builds reused this configured port and failed before saving any content.
  await new Promise((resolve, reject) => {
    occupiedProfile.once('error', reject);
    occupiedProfile.listen(base, '127.0.0.1', resolve);
  });
  const checks = JSON.parse((await cli(['smoke'])).stdout);
  assert.deepEqual(checks.map(check => [check.name, check.ok]), [
    ['remember-recall', true], ['restart-persistence', true], ['store-isolation', true],
  ]);
  assert.ok(occupiedProfile.listening, 'smoke must leave the configured profile listener running');
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), settings, 'smoke must preserve saved settings');
  await new Promise(resolve => occupiedProfile.close(resolve));
  // Exercise the actual installed commands and host-specific files against the
  // pinned engine. No real agent host or conversation is involved.
  const workspace = join(scratch, 'workspace');
  mkdirSync(join(workspace, '.vscode'), { recursive: true });
  writeFileSync(join(workspace, '.vscode', 'settings.json'), '{"chat.useClaudeHooks":false}\n');
  const installed = JSON.parse((await cli(['hooks', '--host', 'all', '--install', '--workspace', workspace])).stdout);
  assert.equal(installed.changedPaths.length, 3);
  assert.deepEqual(JSON.parse((await cli(['hooks', '--host', 'all', '--install', '--workspace', workspace])).stdout).changedPaths, []);
  serving = spawn(process.execPath, [entry, 'serve', '--config', config], { cwd: scratch, stdio: 'ignore' });
  const readyUntil = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < readyUntil) {
    try {
      const response = await fetch(`http://127.0.0.1:${base + 50}/api/checks`, { signal: AbortSignal.timeout(1500) });
      const data = await response.json();
      ready = data.checks?.some(check => check.name === 'backend' && check.ok);
      if (ready) break;
    } catch {}
    if (serving.exitCode !== null) break;
    await delay(250);
  }
  assert.ok(ready, 'installed serve must start its backend and memory bridge');
  const remembered = JSON.parse((await cli(['remember', '--content', 'Echo verification phrase: amber lighthouse', '--topic', 'synthetic-check'])).stdout);
  assert.ok(remembered.id);
  const recalled = JSON.parse((await cli(['recall', '--query', 'What is my Echo verification phrase?'])).stdout);
  assert.equal(recalled.memories[0].id, remembered.id);
  for (const [host, file] of [['claude', '.claude/settings.local.json'], ['codex', '.codex/hooks.json'], ['vscode', '.github/hooks/echo.json']]) {
    const hooks = JSON.parse(readFileSync(join(workspace, file), 'utf8')).hooks;
    const command = host === 'vscode' ? hooks.UserPromptSubmit[0].command : hooks.UserPromptSubmit[0].hooks[0].command;
    const pending = run('/bin/sh', ['-c', command], { cwd: workspace, timeout: 6000 });
    pending.child.stdin.end(JSON.stringify({ session_id: `package-${host}`, hook_event_name: 'UserPromptSubmit', prompt: 'What is my Echo verification phrase?' }));
    const output = JSON.parse((await pending).stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, 'UserPromptSubmit');
    assert.ok(output.additionalContext.includes('amber lighthouse'), `${host} receives the saved memory`);
    assert.ok(output.additionalContext.length <= settings.profiles.personal.budget.briefMaxChars);
  }
  await stopServe();
  for (const port of [base, base + 1, base + 2, base + 46023, base + 50]) assert.ok(await free(port), 'serve releases owned ports');
  console.log('Echo tarball: clean install, isolated smoke, explicit save/recall, all three installed prompt hooks and shutdown passed.');
} finally {
  await stopServe();
  if (occupiedProfile.listening) await new Promise(resolve => occupiedProfile.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
