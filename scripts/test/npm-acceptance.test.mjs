// scripts/npm-acceptance.mjs against stand-in farsight-cli and farsight-sentinel tarballs packed here (no
// dependencies, so npm needs no registry): the six combinations, URL installs and the lockfile, the toolchain and
// workspace isolation, pending gates that follow the installed package's capabilities, a claimed capability with
// no verifier failing, uninstall keeping retained data, and the exit codes. CI's sentinel-package job runs the
// same runner on the real tarballs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COMBINATIONS, MODES, Pending, mcpHandshake, isolatedEnv, isolatedToolchain, pendingByCapability, runAcceptance, summarize,
} from '../npm-acceptance.mjs';
import { CAPABILITIES, standIns } from './helpers/acceptance-standins.mjs';

const RUNNER = resolve('scripts/npm-acceptance.mjs');

const expect = { farsight: '0.4.0', sentinel: '0.1.0', commit: 'abc1234' };
const quiet = () => {};
const status = (report, combination, id) => report.results.find((r) => r.combination === combination && r.id === id)?.status;

test('the toolchain is exactly node, npm and npx, and the environment carries no pnpm, npm config or NODE_PATH', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'acceptance-env-'));
  try {
    const bin = isolatedToolchain(scratch);
    assert.deepEqual(readdirSync(bin).sort(), ['node', 'npm', 'npx']);
    const env = isolatedEnv(scratch, bin, [], { PATH: '/somewhere/with/pnpm', NODE_PATH: '/ws/node_modules', PNPM_HOME: '/p', npm_config_registry: 'https://x', COREPACK_HOME: '/c', HOME: '/home/real' });
    assert.equal(env.NODE_PATH, undefined);
    assert.equal(env.PNPM_HOME, undefined);
    assert.equal(env.COREPACK_HOME, undefined);
    assert.notEqual(env.npm_config_registry, 'https://x');
    assert.ok(env.HOME.startsWith(scratch), 'its own HOME');
    assert.deepEqual(env.PATH.split(':'), [bin, '/usr/bin', '/bin']);
    // whatever the host has installed next to node (pnpm, a global farsight), none of it is reachable
    const probe = spawnSync('/bin/sh', ['-c', 'command -v pnpm || command -v corepack || command -v farsight || echo none'], { env, encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), 'none');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('a pending gate follows the installed capability; a claimed capability without a check fails', () => {
  const gate = { id: 'sentinel.adopt-plan-run', capability: 'scan-cli', what: 'plan and run' };
  assert.throws(() => pendingByCapability({ capabilities: CAPABILITIES() }, gate), (e) => e instanceof Pending && e.blockedBy === 'PR 09');
  assert.throws(() => pendingByCapability({ capabilities: CAPABILITIES({ 'scan-cli': 'available-draft' }) }, gate),
    (e) => !(e instanceof Pending) && /reports scan-cli as available-draft, but this acceptance has no check for "plan and run" yet/.test(e.message));
  assert.throws(() => pendingByCapability({ capabilities: [] }, gate), (e) => !(e instanceof Pending) && /lists no capability scan-cli/.test(e.message));
  assert.deepEqual(summarize([{ status: 'passed' }, { status: 'pending', blockedBy: 'PR 19' }, { status: 'pending', blockedBy: 'PR 09' }, { status: 'failed' }]),
    { passed: 1, failed: 1, pending: 2, blockedBy: ['PR 09', 'PR 19'] });
});

test('six combinations from URLs: alone and together, global and project-local, lockfile, uninstall keeps data', async () => {
  const s = standIns();
  try {
    const report = await runAcceptance({ farsight: s.farsight, sentinel: s.sentinel, expect, log: quiet });
    const combos = [...new Set(report.results.map((r) => r.combination))];
    assert.deepEqual(combos, COMBINATIONS.flatMap((c) => MODES.map((m) => `${c.join('+')}/${m}`)));
    assert.equal(report.summary.failed, 0, JSON.stringify(report.results.filter((r) => r.status === 'failed'), null, 2));
    for (const url of Object.values(report.sources)) assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/download\//, 'installed from a URL');
    for (const mode of MODES) {
      assert.equal(status(report, `farsight/${mode}`, 'consumer.only-the-chosen-packages'), 'passed', 'Farsight alone has no Sentinel');
      assert.equal(status(report, `sentinel/${mode}`, 'consumer.only-the-chosen-packages'), 'passed', 'Sentinel alone has no Farsight');
      assert.equal(status(report, `farsight+sentinel/${mode}`, 'combined.uninstall-sentinel-keeps-data-and-farsight'), 'passed');
      assert.equal(status(report, `farsight+sentinel/${mode}`, 'combined.host-handshake'), 'pending');
      assert.equal(status(report, `sentinel/${mode}`, 'sentinel.adopt-plan-run'), 'pending');
      assert.equal(status(report, `farsight/${mode}`, 'farsight.mcp-handshake'), 'passed');
    }
    assert.equal(status(report, 'farsight+sentinel/local', 'consumer.lockfile-reproduces-url-install'), 'passed');
    assert.equal(status(report, 'farsight/global', 'consumer.lockfile-reproduces-url-install'), undefined, 'a global install has no lockfile to check');
    assert.deepEqual(report.summary.blockedBy, ['PR 09', 'PR 19', 'PR 23a', 'PR 24']);
  } finally { s.done(); }
});

test('wrong versions and provenance fail: Sentinel printing Farsight\'s version, a stamp of another version', async () => {
  const s = standIns({ sentinelVersionLine: 'farsight-sentinel 0.4.0', stampVersion: '0.4.0' });
  try {
    const report = await runAcceptance({ sentinel: s.sentinel, expect, modes: ['global'], log: quiet });
    assert.equal(status(report, 'sentinel/global', 'sentinel.version'), 'failed');
    assert.equal(status(report, 'sentinel/global', 'sentinel.build-provenance'), 'failed');
    const wrongFarsight = await runAcceptance({ farsight: s.farsight, expect: { ...expect, farsight: '9.9.9' }, modes: ['local'], log: quiet });
    assert.equal(status(wrongFarsight, 'farsight/local', 'farsight.version'), 'failed');
    assert.equal(status(wrongFarsight, 'farsight/local', 'farsight.serve'), 'failed', '/api/version names another version');
  } finally { s.done(); }
});

test('exit codes: pending gates block by default (2); --allow-pending reports them (0); a claimed capability without a check fails (1)', () => {
  const s = standIns();
  const claimed = standIns({ sentinelCaps: CAPABILITIES({ reports: 'available' }) });
  try {
    const cli = (...args) => spawnSync(process.execPath, [RUNNER, '--expect-farsight', '0.4.0', '--expect-sentinel', '0.1.0', '--modes', 'global', ...args], { encoding: 'utf8', timeout: 300_000 });
    const blocked = cli('--sentinel', s.sentinel);
    assert.equal(blocked.status, 2, 'without a flag, a pending gate blocks');
    assert.match(blocked.stdout, /0 failed, 5 pending \(blocked by PR 09, PR 19, PR 23a\)/);
    assert.match(blocked.stdout, /pending gates block: a release needs every gate passed/);
    const dev = cli('--sentinel', s.sentinel, '--allow-pending');
    assert.equal(dev.status, 0, dev.stderr + dev.stdout);
    assert.match(dev.stdout, /--allow-pending: a development check, not a release gate/);
    assert.equal(cli('--sentinel', s.sentinel, '--require-complete').status, 1, 'the old flag is unknown, not a silent no-op');
    const fails = cli('--sentinel', claimed.sentinel, '--allow-pending');
    assert.equal(fails.status, 1, '--allow-pending never excuses a failure');
    assert.match(fails.stdout, /failed\s+sentinel\/global sentinel\.report-offline — run admission must pass first/);
    const report = join(s.dir, 'report.json');
    assert.equal(cli('--farsight', s.farsight, '--only', 'farsight', '--report', report).status, 0, 'Farsight alone has no pending gate');
    assert.ok(existsSync(report));
  } finally { s.done(); claimed.done(); }
});

// A failed launch must not leave publication waiting for the handshake timeout.
test('MCP process exit is an immediate failed handshake', async () => {
  await assert.rejects(mcpHandshake(process.execPath, ['-e', 'process.exit(7)'], { cwd: process.cwd(), env: process.env, timeoutMs: 30000 }), /MCP exited \(7\)/);
});
