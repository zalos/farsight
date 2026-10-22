#!/usr/bin/env node
// The clean npm acceptance for a release: farsight-cli and farsight-sentinel installed the way a user with only Node
// and npm installs them, from URLs, alone and together, globally (a private --prefix) and into a project, then used.
// The same runner checks freshly packed tarballs (served over a loopback URL, so npm records a URL exactly as it
// would for a GitHub Release) and, through scripts/verify-release.mjs, the published release assets themselves.
//
// Six combinations: farsight alone, sentinel alone, both; each global and project-local. Each runs in its own
// scratch folder with a toolchain of exactly node, npm and npx (no pnpm, corepack, yarn or other global bins), no
// npm configuration from the caller, its own HOME, and no way to resolve a workspace package. Every check is a
// named gate with one status:
//   passed   it ran and held;
//   failed   it ran and did not hold, or something it needs is broken;
//   pending  it cannot run yet, and says why: the installed Sentinel reports the capability it needs as
//            unavailable (with the PR it is planned in), or this host cannot open the store. A pending gate is never
//            reported as passed; when the installed package says a pending capability is now available, the gate
//            fails until its verifier is written here, so nothing is claimed without being checked.
// Exit code 0 when nothing failed; 1 when a gate failed; 2 when `--require-complete` is set and a gate is pending
// (the release workflows set it for the final release).
//
//   node scripts/npm-acceptance.mjs --farsight build/farsight-cli-<v>.tgz --sentinel build/sentinel/farsight-sentinel-<v>.tgz \
//     [--expect-farsight <v>] [--expect-sentinel <v>] [--expect-commit <sha>] [--only farsight|sentinel|both] \
//     [--modes global,local] [--require-complete] [--report <file.json>]
//   (a URL in place of a file installs that URL directly)
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { cleanNpmEnv } from './npm-consumer.mjs';

const run = promisify(execFile);
export const PRODUCTS = Object.freeze({
  farsight: Object.freeze({ name: 'farsight-cli', bin: 'farsight' }),
  sentinel: Object.freeze({ name: 'farsight-sentinel', bin: 'farsight-sentinel' }),
});
export const COMBINATIONS = Object.freeze([['farsight'], ['sentinel'], ['farsight', 'sentinel']]);
export const MODES = Object.freeze(['global', 'local']);
/** Tools that must not be reachable from the consumer: a release consumer has only node, npm and npx. */
export const FORBIDDEN_TOOLS = Object.freeze(['pnpm', 'pnpx', 'corepack', 'yarn', 'yarnpkg', 'farsight', 'farsight-sentinel', 'farsight-echo']);

/**
 * Sentinel features the release needs but this build cannot do yet. Each names the capability the installed
 * package reports for it (`farsight-sentinel capabilities --json`), so the gate follows the package, not this list.
 */
export const PENDING_SENTINEL_GATES = Object.freeze([
  { id: 'sentinel.init-twice-preserves-config', capability: 'scan-cli', what: 'initialize a project twice; the second run keeps the first configuration' },
  { id: 'sentinel.adopt-plan-run', capability: 'scan-cli', what: 'adopt the settings, plan and run a deterministic scan' },
  { id: 'sentinel.interrupt-resume', capability: 'scan-cli', what: 'interrupt a scan and resume it' },
  { id: 'sentinel.report-offline', capability: 'reports', what: 'write the report and open it offline' },
  { id: 'sentinel.compare', capability: 'reports', what: 'compare two runs' },
  { id: 'sentinel.replay', capability: 'replay-bundles', what: 'export a replay bundle and restore it' },
  { id: 'sentinel.mcp-handshake', capability: 'mcp', what: 'the installed Sentinel MCP server answers a handshake' },
]);
export const PENDING_COMBINED_GATES = Object.freeze([
  { id: 'combined.host-handshake', capability: 'farsight-host-bridge', what: 'Farsight hosts the installed Sentinel and the two shake hands' },
]);

export class Pending extends Error {
  constructor(message, blockedBy) { super(message); this.blockedBy = blockedBy; }
}

/** A folder holding exactly node, npm and npx from this Node installation: the whole toolchain a consumer gets. */
export function isolatedToolchain(scratch, execPath = process.execPath) {
  const from = dirname(realpathSync(execPath));
  const bin = join(scratch, 'toolchain');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['node', 'npm', 'npx']) {
    const source = tool === 'node' ? realpathSync(execPath) : join(from, tool);
    if (!existsSync(source)) throw new Error(`${tool} is not beside ${execPath}; the acceptance needs the npm that ships with Node`);
    symlinkSync(source, join(bin, tool));
  }
  return bin;
}

/** The consumer environment: no npm configuration, no pnpm, no NODE_PATH, its own HOME, PATH = its bins only. */
export function isolatedEnv(scratch, toolchain, extraBins = [], base = process.env) {
  const kept = Object.fromEntries(Object.entries(base).filter(([k]) => !/^(?:PNPM_|COREPACK_|NODE_PATH$|NODE_OPTIONS$|YARN_|FARSIGHT_(?!NPM_REGISTRY$))/i.test(k)));
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  const env = cleanNpmEnv(scratch, kept);
  return { ...env, HOME: home, USERPROFILE: home, PATH: [...extraBins, toolchain, '/usr/bin', '/bin'].join(':'), npm_config_update_notifier: 'false' };
}

/** Serves local tarballs on a loopback port, so npm installs (and locks) a URL, as it would a release asset. */
export async function serveFiles(files) {
  const byName = new Map(files.map((f) => [basename(f), f]));
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').replace(/^\/download\//, ''));
    const file = byName.get(name);
    if (!file || req.method !== 'GET') { res.writeHead(404).end(); return; }
    const bytes = readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }).end(bytes);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  return { url: (file) => `http://127.0.0.1:${port}/download/${encodeURIComponent(basename(file))}`, close: () => new Promise((ok) => server.close(ok)) };
}

const freePort = () => new Promise((ok, fail) => {
  const s = createNetServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

const digestTree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
};

/** A small original application for Farsight to ingest; nothing from a checkout is needed. */
export function writeApplication(dir) {
  const files = {
    'package.json': JSON.stringify({ name: 'acceptance-app', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n',
    'src/invoices.ts': [
      'export interface Invoice { id: string; total: number; status: "draft" | "submitted" }',
      '/** @business Creates a draft invoice for a customer. */',
      'export function createInvoice(id: string, total: number): Invoice { return { id, total, status: "draft" }; }',
      'export function submitInvoice(invoice: Invoice): Invoice {',
      '  if (invoice.total <= 0) throw new Error("an invoice needs a positive total");',
      '  return { ...invoice, status: "submitted" };',
      '}',
      '',
    ].join('\n'),
    'src/index.ts': 'import { createInvoice, submitInvoice } from "./invoices.js";\nexport const run = () => submitInvoice(createInvoice("inv-1", 10));\n',
    'farsight.config.json': JSON.stringify({ glossary: { createInvoice: { label: 'Create invoice', description: 'Starts a draft invoice.' } } }, null, 2) + '\n',
  };
  for (const [path, text] of Object.entries(files)) {
    // A project-local consumer's own package.json holds its dependencies; it is the user's, never replaced.
    if (path === 'package.json' && existsSync(join(dir, path))) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill('SIGTERM');
  });
}

/** One MCP handshake over stdio: initialize, initialized, tools/list. Returns the server name and tool names. */
export async function mcpHandshake(command, args, { cwd, env, timeoutMs = 60_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const waiting = new Map();
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buffer += d;
    for (let nl; (nl = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      waiting.get(msg.id)?.(msg);
    }
  });
  const call = (id, method, params) => new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no answer to ${method} in ${timeoutMs} ms\n${stderr.slice(-2000)}`)), timeoutMs);
    waiting.set(id, (msg) => { clearTimeout(timer); msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'farsight-release-acceptance', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await call(2, 'tools/list', {});
    return { server: init.serverInfo?.name, protocol: init.protocolVersion, tools: (tools.tools ?? []).map((t) => t.name) };
  } finally {
    child.stdin.end();
    await stopChild(child);
  }
}

/** Runs every gate for one combination and mode; returns the gate results. Never throws for a product failure. */
export async function acceptOne({ products, mode, sources, expect, keep = false, log = () => {} }) {
  const label = `${products.join('+')}/${mode}`;
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `farsight-acceptance-${products.join('-')}-${mode}-`)));
  const results = [];
  const record = async (id, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ combination: label, id, status: 'passed', ms: Date.now() - started, ...(detail ? { detail: String(detail) } : {}) });
    } catch (error) {
      results.push({ combination: label, id, status: error instanceof Pending ? 'pending' : 'failed', ms: Date.now() - started,
        detail: String(error?.message ?? error).slice(0, 4000), ...(error instanceof Pending ? { blockedBy: error.blockedBy } : {}) });
    }
    const last = results.at(-1);
    log(`  ${last.status.padEnd(7)} ${label} ${id}${last.detail && last.status !== 'passed' ? ` — ${last.detail.split('\n')[0]}` : ''}`);
    return last.status === 'passed';
  };
  try {
    const toolchain = isolatedToolchain(scratch);
    const prefix = join(scratch, 'prefix');
    const app = join(scratch, 'app');
    mkdirSync(app, { recursive: true });
    const bins = mode === 'global' ? [join(prefix, 'bin')] : [join(app, 'node_modules', '.bin')];
    const env = isolatedEnv(scratch, toolchain, bins);
    const exec = (file, args, options = {}) => run(file, args, { cwd: app, env, timeout: 300_000, maxBuffer: 16_000_000, ...options });
    const npm = (args) => exec(join(toolchain, 'npm'), args).catch((e) => { throw new Error(`npm ${args.join(' ')}: ${e.stderr || e.message}`); });
    const installed = (key) => mode === 'global' ? join(prefix, 'lib', 'node_modules', PRODUCTS[key].name) : join(app, 'node_modules', PRODUCTS[key].name);
    const binOf = (key) => join(bins[0], PRODUCTS[key].bin);
    const install = (keys) => npm(mode === 'global' ? ['install', '-g', '--prefix', prefix, ...keys.map((k) => sources[k])] : ['install', ...keys.map((k) => sources[k])]);
    const uninstall = (key) => npm(mode === 'global' ? ['uninstall', '-g', '--prefix', prefix, PRODUCTS[key].name] : ['uninstall', PRODUCTS[key].name]);
    if (mode === 'local') await npm(['init', '-y']);

    const isolated = await record('consumer.toolchain-is-node-and-npm-only', async () => {
      const found = [];
      for (const tool of FORBIDDEN_TOOLS) {
        try { await exec('/bin/sh', ['-c', `command -v ${tool}`]); found.push(tool); } catch { /* not reachable: as wanted */ }
      }
      if (found.length) throw new Error(`reachable before install: ${found.join(', ')}`);
      return 'node, npm and npx only';
    });
    if (!isolated) return results;

    const ok = await record('consumer.install-from-urls', async () => {
      await install(products);
      return products.map((k) => `${PRODUCTS[k].name} ← ${sources[k]}`).join('; ');
    });
    if (!ok) return results;

    await record('consumer.no-workspace-resolution', async () => {
      const probe = "for (const s of ['@farsight/core', '@farsight/graph', '@farsight/sentinel', '@farsight/cli']) { try { await import(s); console.log(s); } catch {} }";
      const leaked = (await exec(join(toolchain, 'node'), ['--input-type=module', '-e', probe])).stdout.trim();
      if (leaked) throw new Error(`workspace packages resolved: ${leaked.split('\n').join(', ')}`);
      for (const tool of ['pnpm', 'corepack']) {
        try { await exec('/bin/sh', ['-c', `command -v ${tool}`]); throw new Error(`${tool} is reachable`); } catch (e) { if (/reachable/.test(e.message)) throw e; }
      }
      const top = mode === 'global' ? join(prefix, 'lib', 'node_modules') : join(app, 'node_modules');
      if (existsSync(join(top, '@farsight'))) throw new Error('an @farsight/* workspace package was installed');
      return 'no @farsight/* package, pnpm or corepack';
    });

    await record('consumer.only-the-chosen-packages', async () => {
      for (const key of Object.keys(PRODUCTS)) {
        const present = existsSync(installed(key));
        if (present !== products.includes(key)) throw new Error(`${PRODUCTS[key].name} is ${present ? 'installed' : 'missing'}`);
      }
      return `installed: ${products.map((k) => PRODUCTS[k].name).join(', ')}`;
    });

    if (mode === 'local') {
      await record('consumer.lockfile-reproduces-url-install', async () => {
        const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
        const before = {};
        for (const key of products) {
          const entry = lock.packages?.[`node_modules/${PRODUCTS[key].name}`];
          if (entry?.resolved !== sources[key]) throw new Error(`${PRODUCTS[key].name} is locked to ${entry?.resolved}, not ${sources[key]}`);
          if (!/^sha512-/.test(entry.integrity ?? '')) throw new Error(`${PRODUCTS[key].name} has no integrity in the lockfile`);
          before[key] = readFileSync(join(installed(key), 'package.json'), 'utf8');
        }
        rmSync(join(app, 'node_modules'), { recursive: true, force: true });
        await npm(['ci']);
        for (const key of products) {
          if (readFileSync(join(installed(key), 'package.json'), 'utf8') !== before[key]) throw new Error(`npm ci installed another ${PRODUCTS[key].name}`);
        }
        return 'npm ci from the lockfile reinstalled the same URLs and integrity';
      });
    }

    if (products.includes('farsight')) await farsightGates({ record, exec, app, binOf, expect, env, mode });
    let caps = null;
    if (products.includes('sentinel')) caps = await sentinelGates({ record, exec, app, binOf, installed, expect, toolchain, scratch, products });
    if (products.includes('farsight') && products.includes('sentinel')) {
      for (const g of PENDING_COMBINED_GATES) await record(g.id, () => pendingByCapability(caps, g));
      await record('combined.uninstall-sentinel-keeps-data-and-farsight', async () => {
        const store = join(scratch, 'sentinel-data', 'store');
        if (!existsSync(store)) throw new Pending('no Sentinel store was retained to check (see sentinel.store-retained)', 'sentinel.store-retained');
        const before = digestTree(store);
        await uninstall('sentinel');
        if (existsSync(installed('sentinel')) || existsSync(binOf('sentinel'))) throw new Error('farsight-sentinel is still installed after npm uninstall');
        const after = digestTree(store);
        if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('uninstalling farsight-sentinel changed its retained data');
        if (!existsSync(installed('farsight'))) throw new Error('uninstalling farsight-sentinel removed farsight-cli');
        const line = (await exec(binOf('farsight'), ['--version'])).stdout;
        if (!line.includes(`farsight ${expect.farsight ?? ''}`)) throw new Error(`farsight --version after uninstall: ${line}`);
        await exec(binOf('farsight'), ['ingest', '.', '--repo', 'acceptance-app', '--out', 'graph-after-uninstall.json']);
        if (!(JSON.parse(readFileSync(join(app, 'graph-after-uninstall.json'), 'utf8')).nodes?.length > 0)) throw new Error('ingest after uninstall wrote no nodes');
        await install(['sentinel']);
        const reopened = await storeProbe({ exec, installed: installed('sentinel'), toolchain, store, step: 'reopen' });
        return `retained ${Object.keys(before).length} store files unchanged; Farsight ran; reinstalled Sentinel reopened the store (epoch ${reopened.epoch})`;
      });
    }
    return results;
  } catch (error) {
    results.push({ combination: label, id: 'runner', status: 'failed', detail: String(error?.stack ?? error).slice(0, 4000) });
    return results;
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  }
}

async function farsightGates({ record, exec, app, binOf, expect, env }) {
  const farsight = binOf('farsight');
  await record('farsight.version', async () => {
    const line = (await exec(farsight, ['--version'])).stdout.trim();
    if (expect.farsight && !line.includes(`farsight ${expect.farsight} `) && !line.endsWith(`farsight ${expect.farsight}`)) throw new Error(`--version printed ${line}`);
    if (expect.commit && !line.includes(`commit ${expect.commit}`)) throw new Error(`--version printed ${line}, not commit ${expect.commit}`);
    return line;
  });
  await record('farsight.config-ingest-twice-preserves-config', async () => {
    writeApplication(app);
    const config = readFileSync(join(app, 'farsight.config.json'));
    const counts = [];
    for (const out of ['graph.json', 'graph-second.json']) {
      await exec(farsight, ['ingest', '.', '--repo', 'acceptance-app', '--out', out]);
      counts.push(JSON.parse(readFileSync(join(app, out), 'utf8')).nodes?.length ?? 0);
    }
    if (!counts.every((n) => n > 0)) throw new Error(`ingest wrote ${counts.join(' and ')} nodes`);
    if (!readFileSync(join(app, 'farsight.config.json')).equals(config)) throw new Error('ingest changed farsight.config.json');
    const graph = JSON.parse(readFileSync(join(app, 'graph.json'), 'utf8'));
    if (!graph.nodes.some((n) => String(n.label ?? n.name ?? '').includes('Create invoice') || JSON.stringify(n).includes('Create invoice'))) {
      throw new Error('the glossary from farsight.config.json did not reach the graph');
    }
    return `${counts[0]} nodes twice, farsight.config.json unchanged and applied`;
  });
  await record('farsight.serve', async () => {
    const port = await freePort();
    const server = spawn(farsight, ['serve', 'graph.json', '--port', String(port), '--read-only'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    server.stdout.on('data', (d) => { output += d; });
    server.stderr.on('data', (d) => { output += d; });
    try {
      for (let i = 0; i < 150; i++) {
        if (server.exitCode !== null) break;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/version`);
          if (res.ok) {
            const answer = await res.json();
            if (expect.farsight && answer.farsight?.version !== expect.farsight) throw new Error(`/api/version says ${answer.farsight?.version}`);
            if (answer.session?.readOnly !== true) throw new Error('the server is not read-only');
            return `/api/version on ${port}: ${answer.farsight?.version}`;
          }
        } catch (e) { if (/api\/version says|read-only/.test(e.message)) throw e; }
        await delay(200);
      }
      throw new Error(`serve did not answer /api/version\n${output.slice(-2000)}`);
    } finally { await stopChild(server); }
  });
  await record('farsight.mcp-handshake', async () => {
    const hello = await mcpHandshake(farsight, ['mcp', '--graph', 'graph.json'], { cwd: app, env });
    if (!hello.tools.includes('graph_overview')) throw new Error(`tools: ${hello.tools.join(', ')}`);
    return `${hello.server} (${hello.protocol}), ${hello.tools.length} tools`;
  });
}

/** Whether the installed Sentinel can do what a pending gate needs; never claims it can. */
export function pendingByCapability(caps, gate) {
  if (!caps) throw new Error('the installed Sentinel did not list its capabilities');
  const c = caps.capabilities?.find((x) => x.id === gate.capability);
  if (!c) throw new Error(`the installed Sentinel lists no capability ${gate.capability}`);
  if (c.state === 'unavailable') throw new Pending(`${gate.what}: the installed Sentinel reports ${gate.capability} unavailable (planned in ${c.plannedIn})`, c.plannedIn);
  throw new Error(`the installed Sentinel reports ${gate.capability} as ${c.state}, but this acceptance has no check for "${gate.what}" yet; add it before releasing`);
}

async function storeProbe({ exec, installed, toolchain, store, step }) {
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['./store']?.import;
  if (!entry) throw new Error('farsight-sentinel exports no ./store');
  const url = pathToFileURL(join(installed, entry)).href;
  const script = `
    const s = await import(${JSON.stringify(url)});
    const host = process.platform + '-' + process.arch;
    if (!s.qualificationFor(s.SQLITE_RELEASE_POLICY, host, process.versions.sqlite)) { console.log(JSON.stringify({ unqualified: host + ' SQLite ' + process.versions.sqlite })); process.exit(0); }
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(${JSON.stringify(store)}), { recursive: true, mode: 0o700 });
    const store = await s.openStore(${JSON.stringify(store)});
    try { const report = await store.inspect(); console.log(JSON.stringify({ epoch: store.epoch, ok: report.ok, step: ${JSON.stringify(step)} })); }
    finally { store.close(); }`;
  const out = JSON.parse((await exec(join(toolchain, 'node'), ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script])).stdout.trim().split('\n').at(-1));
  if (out.unqualified) throw new Pending(`this host cannot open a Sentinel store (${out.unqualified} is not in the release policy)`, `store qualification for ${out.unqualified}`);
  if (out.ok !== true) throw new Error(`the reopened store does not inspect ok (${step})`);
  return out;
}

async function sentinelGates({ record, exec, binOf, installed, expect, toolchain, scratch }) {
  const sentinel = binOf('sentinel');
  let caps = null;
  await record('sentinel.version', async () => {
    const line = (await exec(sentinel, ['--version'])).stdout.trim();
    if (expect.sentinel && !new RegExp(`(^|\\s)${expect.sentinel.replace(/[.+]/g, '\\$&')}(\\s|$|[^0-9A-Za-z.-])`).test(line)) throw new Error(`--version printed ${line}`);
    if (expect.farsight && expect.sentinel !== expect.farsight && line.includes(expect.farsight)) throw new Error(`--version names farsight-cli's version: ${line}`);
    return line;
  });
  await record('sentinel.help', async () => { const help = (await exec(sentinel, ['--help'])).stdout; if (!help.trim()) throw new Error('--help printed nothing'); return `${help.split('\n').length} lines`; });
  await record('sentinel.capabilities', async () => {
    caps = JSON.parse((await exec(sentinel, ['capabilities', '--json'])).stdout);
    if (expect.sentinel && caps.version !== expect.sentinel) throw new Error(`capabilities name version ${caps.version}`);
    return `${caps.capabilities.length} listed, ${caps.capabilities.filter((c) => c.state === 'unavailable').length} unavailable`;
  });
  await record('sentinel.build-provenance', async () => {
    const stampFile = join(installed('sentinel'), 'dist', 'build-stamp.json');
    if (!existsSync(stampFile)) throw new Error('the installed farsight-sentinel carries no dist/build-stamp.json');
    const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
    if (stamp.name !== 'farsight-sentinel') throw new Error(`the stamp names ${stamp.name}`);
    if (expect.sentinel && stamp.version !== expect.sentinel) throw new Error(`the stamp says ${stamp.version}`);
    if (expect.commit && stamp.commit !== expect.commit) throw new Error(`the stamp says commit ${stamp.commit}, not ${expect.commit}`);
    return `${stamp.version}, commit ${stamp.commit ?? 'unknown'}, built ${stamp.built}`;
  });
  await record('sentinel.store-retained', async () => {
    const store = join(scratch, 'sentinel-data', 'store');
    const first = await storeProbe({ exec, installed: installed('sentinel'), toolchain, store, step: 'create' });
    const second = await storeProbe({ exec, installed: installed('sentinel'), toolchain, store, step: 'reopen' });
    if (first.epoch === second.epoch) throw new Error('a reopen kept the same owner epoch');
    return `created, reopened under a new epoch`;
  });
  for (const g of PENDING_SENTINEL_GATES) await record(g.id, () => pendingByCapability(caps, g));
  return caps;
}

export function summarize(results) {
  const by = (s) => results.filter((r) => r.status === s);
  return { passed: by('passed').length, failed: by('failed').length, pending: by('pending').length,
    blockedBy: [...new Set(by('pending').map((r) => r.blockedBy))].sort() };
}

/** Everything: resolves the sources (serving local files over loopback), runs the chosen combinations. */
export async function runAcceptance({ farsight, sentinel, expect = {}, only, modes = MODES, keep = false, log = console.log }) {
  const local = [farsight, sentinel].filter((s) => s && !/^https?:\/\//.test(s)).map((s) => resolve(s));
  for (const file of local) if (!existsSync(file)) throw new Error(`${file} is missing`);
  const served = local.length ? await serveFiles(local) : null;
  const toUrl = (s) => (!s ? undefined : /^https?:\/\//.test(s) ? s : served.url(resolve(s)));
  const sources = { farsight: toUrl(farsight), sentinel: toUrl(sentinel) };
  try {
    const combos = COMBINATIONS.filter((c) => c.every((k) => sources[k])).filter((c) => !only || only === (c.length === 2 ? 'both' : c[0]));
    if (!combos.length) throw new Error('no combination can run: pass --farsight and/or --sentinel');
    const results = [];
    for (const products of combos) for (const mode of modes) results.push(...await acceptOne({ products, mode, sources, expect, keep, log }));
    return { sources, results, summary: summarize(results) };
  } finally { await served?.close(); }
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    farsight: { type: 'string' }, sentinel: { type: 'string' }, 'expect-farsight': { type: 'string' }, 'expect-sentinel': { type: 'string' },
    'expect-commit': { type: 'string' }, only: { type: 'string' }, modes: { type: 'string' }, 'require-complete': { type: 'boolean', default: false },
    report: { type: 'string' }, keep: { type: 'boolean', default: false },
  } });
  if (values.only && !['farsight', 'sentinel', 'both'].includes(values.only)) throw new Error('--only is farsight, sentinel or both');
  const modes = values.modes ? values.modes.split(',') : [...MODES];
  if (modes.some((m) => !MODES.includes(m))) throw new Error('--modes is a list of global and local');
  const report = await runAcceptance({
    farsight: values.farsight, sentinel: values.sentinel, only: values.only, modes, keep: values.keep,
    expect: { farsight: values['expect-farsight'], sentinel: values['expect-sentinel'], commit: values['expect-commit'] },
  });
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n');
  const s = report.summary;
  console.log(`\nnpm acceptance: ${s.passed} passed, ${s.failed} failed, ${s.pending} pending${s.pending ? ` (blocked by ${s.blockedBy.join(', ')})` : ''}`);
  if (s.failed) return 1;
  if (s.pending && values['require-complete']) { console.log('--require-complete: a release needs every gate passed'); return 2; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`npm-acceptance: ${e.message}`); process.exit(1); });
}
