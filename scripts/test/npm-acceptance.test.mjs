// scripts/npm-acceptance.mjs against stand-in farsight-cli and farsight-sentinel tarballs packed here (no
// dependencies, so npm needs no registry): the six combinations, URL installs and the lockfile, the toolchain and
// workspace isolation, pending gates that follow the installed package's capabilities, a claimed capability with
// no verifier failing, uninstall keeping retained data, and the exit codes. CI's sentinel-package job runs the
// same runner on the real tarballs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COMBINATIONS, MODES, Pending, isolatedEnv, isolatedToolchain, pendingByCapability, runAcceptance, summarize,
} from '../npm-acceptance.mjs';

const RUNNER = resolve('scripts/npm-acceptance.mjs');

const FARSIGHT_BIN = `#!/usr/bin/env node
// stand-in farsight: --version, ingest (reads the glossary), serve (/api/version), mcp (stdio handshake)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const [cmd, ...args] = process.argv.slice(2);
const opt = (n) => args[args.indexOf(n) + 1];
if (cmd === '--version') { console.log('farsight ' + VERSION + ' · built 2026-10-22 · commit abc1234'); process.exit(0); }
if (cmd === 'ingest') {
  const config = existsSync('farsight.config.json') ? JSON.parse(readFileSync('farsight.config.json', 'utf8')) : {};
  const nodes = Object.entries(config.glossary ?? {}).map(([name, g]) => ({ id: 'acceptance-app::' + name, name, label: g.label }));
  writeFileSync(opt('--out'), JSON.stringify({ nodes: [{ id: 'acceptance-app::src/index.ts' }, ...nodes], edges: [] }));
  process.exit(0);
}
if (cmd === 'serve') {
  createServer((req, res) => res.end(JSON.stringify({ farsight: { version: VERSION }, session: { readOnly: args.includes('--read-only') } })))
    .listen(Number(opt('--port')), '127.0.0.1');
} else if (cmd === 'mcp') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf('\\n')) >= 0;) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'farsight' }, capabilities: {} } }) + '\\n');
      if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'graph_overview' }] } }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else { process.exit(2); }
`;

const SENTINEL_BIN = (capabilities, versionLine) => `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const [cmd, flag] = process.argv.slice(2);
if (cmd === '--version') { console.log(${versionLine ? JSON.stringify(versionLine) : "'farsight-sentinel ' + VERSION + ' (contracts draft-1)'"}); process.exit(0); }
if (cmd === '--help') { console.log('farsight-sentinel\\nusage: farsight-sentinel --help'); process.exit(0); }
if (cmd === 'capabilities' && flag === '--json') { console.log(JSON.stringify({ version: VERSION, capabilities: ${JSON.stringify(capabilities)} })); process.exit(0); }
process.exit(3);
`;

// A store with the real facade's qualification check and a file it keeps: enough to prove the data outlives an uninstall.
const SENTINEL_STORE = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const SQLITE_RELEASE_POLICY = { qualified: [{ host: process.platform + '-' + process.arch, sqlite: process.versions.sqlite }] };
export const qualificationFor = (p, host, sqlite) => p.qualified.find((q) => q.host === host && q.sqlite === sqlite);
export async function openStore(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const ledger = join(path, 'ledger.json');
  const data = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : { created: new Date().toISOString(), opens: 0 };
  data.opens++;
  writeFileSync(ledger, JSON.stringify(data));
  const epoch = 'epoch-' + randomUUID();
  return { epoch, inspect: async () => ({ ok: true }), close() {} };
}
`;

const CAPABILITIES = (overrides = {}) => ['scan-cli', 'reports', 'replay-bundles', 'mcp', 'farsight-host-bridge', 'ledger'].map((id) => ({
  id, state: overrides[id] ?? (id === 'ledger' ? 'available-draft' : 'unavailable'), plannedIn: { 'scan-cli': 'PR 09', reports: 'PR 19', 'replay-bundles': 'PR 26', mcp: 'PR 23a', 'farsight-host-bridge': 'PR 24', ledger: 'PR 03' }[id],
}));

function pack(dir, name, version, files, extra = {}) {
  const pkg = join(dir, name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version, type: 'module', ...extra }, null, 2));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(pkg, path, '..'), { recursive: true });
    writeFileSync(join(pkg, path), text);
    if (path.startsWith('bin/')) chmodSync(join(pkg, path), 0o755);
  }
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: pkg, stdio: 'ignore', env: { ...process.env, npm_config_dry_run: 'false' } });
  return join(dir, `${name}-${version}.tgz`);
}

function standIns({ sentinelCaps = CAPABILITIES(), sentinelVersionLine, sentinelVersion = '0.1.0', stampVersion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-standins-'));
  const farsight = pack(dir, 'farsight-cli', '0.4.0', { 'bin/farsight.mjs': FARSIGHT_BIN }, { bin: { farsight: 'bin/farsight.mjs' } });
  const sentinel = pack(dir, 'farsight-sentinel', sentinelVersion, {
    'bin/sentinel.mjs': SENTINEL_BIN(sentinelCaps, sentinelVersionLine),
    'dist/store/index.mjs': SENTINEL_STORE,
    'dist/build-stamp.json': JSON.stringify({ name: 'farsight-sentinel', version: stampVersion ?? sentinelVersion, built: '2026-10-22T00:00:00Z', commit: 'abc1234' }),
  }, { bin: { 'farsight-sentinel': 'bin/sentinel.mjs' }, exports: { './store': { import: './dist/store/index.mjs' }, './package.json': './package.json' } });
  return { dir, farsight, sentinel, done: () => rmSync(dir, { recursive: true, force: true }) };
}

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
    assert.deepEqual(report.summary.blockedBy, ['PR 09', 'PR 19', 'PR 23a', 'PR 24', 'PR 26']);
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

test('exit codes: 0 with pending gates, 2 under --require-complete, 1 when a capability is claimed without a check', () => {
  const s = standIns();
  const claimed = standIns({ sentinelCaps: CAPABILITIES({ reports: 'available' }) });
  try {
    const cli = (...args) => spawnSync(process.execPath, [RUNNER, '--expect-farsight', '0.4.0', '--expect-sentinel', '0.1.0', '--modes', 'global', ...args], { encoding: 'utf8', timeout: 300_000 });
    const pending = cli('--sentinel', s.sentinel);
    assert.equal(pending.status, 0, pending.stderr + pending.stdout);
    assert.match(pending.stdout, /0 failed, 7 pending \(blocked by PR 09, PR 19, PR 23a, PR 26\)/);
    assert.equal(cli('--sentinel', s.sentinel, '--require-complete').status, 2);
    const fails = cli('--sentinel', claimed.sentinel);
    assert.equal(fails.status, 1);
    assert.match(fails.stdout, /failed\s+sentinel\/global sentinel\.report-offline — the installed Sentinel reports reports as available/);
    const report = join(s.dir, 'report.json');
    assert.equal(cli('--farsight', s.farsight, '--only', 'farsight', '--report', report).status, 0);
    assert.ok(existsSync(report));
  } finally { s.done(); claimed.done(); }
});
