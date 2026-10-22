// Stand-in farsight-cli and farsight-sentinel tarballs for the release scripts' tests: no dependencies, so npm
// installs them with no registry; each answers exactly what scripts/npm-acceptance.mjs asks of the real package.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export const CAPABILITIES = (overrides = {}) => ['scan-cli', 'reports', 'replay-bundles', 'mcp', 'farsight-host-bridge', 'ledger'].map((id) => ({
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

export function standIns({ sentinelCaps = CAPABILITIES(), sentinelVersionLine, sentinelVersion = '0.1.0', stampVersion, postinstallMarker } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-standins-'));
  const farsight = pack(dir, 'farsight-cli', '0.4.0', { 'bin/farsight.mjs': FARSIGHT_BIN }, { bin: { farsight: 'bin/farsight.mjs' } });
  const sentinel = pack(dir, 'farsight-sentinel', sentinelVersion, {
    'bin/sentinel.mjs': SENTINEL_BIN(sentinelCaps, sentinelVersionLine),
    'dist/store/index.mjs': SENTINEL_STORE,
    'dist/build-stamp.json': JSON.stringify({ name: 'farsight-sentinel', version: stampVersion ?? sentinelVersion, built: '2026-10-22T00:00:00Z', commit: 'abc1234' }),
  }, { bin: { 'farsight-sentinel': 'bin/sentinel.mjs' }, exports: { './store': { import: './dist/store/index.mjs' }, './package.json': './package.json' },
    // an inert marker: proves whether a substituted tarball's install script ever ran
    ...(postinstallMarker ? { scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(postinstallMarker)}, 'ran')"` } } : {}) });
  return { dir, farsight, sentinel, done: () => rmSync(dir, { recursive: true, force: true }) };
}

