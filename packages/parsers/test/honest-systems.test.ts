// Honest systems, chunk A1.3: where a site sits decides how its edges read.
// A function expression handed over as an object-literal property is a callback
// someone will run later — it gets a node of its own, a `deferred` edge from
// whoever built it, and its own edges; a function expression passed as a call
// argument is the caller's own work and keeps its attribution, with `tx: true`
// when the call is a transaction runner. A `this.<field>.<path>.<fn>()` chain in
// a class method reaches the callback bound at `new Class({ … })`.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import { buildIndex, journey, journeySummary, screensFor } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-honest-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const ingest = (files: Record<string, string>, repoName: string) =>
  ingestRepo(tempRepo({ 'package.json': `{"name":"${repoName}"}`, ...files }), { repoName, openapi: false, design: false, tests: false });

test('a withTx callback is the caller’s own work: the writes stay on the function and carry tx', async () => {
  const g = await ingest({
    'src/approvals.ts': [
      'export async function withTx(fn: () => Promise<void>) { return fn(); }',
      'export async function approveInvoice(id: string) {',
      '  await withTx(async () => {',
      '    await db.approvals.insert({ id });',
      '    await db.invoices.update({ id });',
      '  });',
      '}',
    ].join('\n'),
  }, 'txrepo');
  const from = 'txrepo::src/approvals.ts::approveInvoice';
  const writes = g.edges.filter((e) => e.kind === 'writes' && e.from === from);
  assert.deepEqual(writes.map((e) => e.to).sort(), ['txrepo::table::approvals', 'txrepo::table::invoices']);
  for (const e of writes) {
    assert.equal(e.meta?.tx, true, 'a write inside withTx is inside the transaction');
    assert.equal(e.meta?.deferred, undefined, 'a call argument is never deferred — never write deferred:false');
  }
  // the argument callback is not a node: the transaction belongs to the function that opened it
  assert.equal(g.nodes.find((n) => n.id.startsWith(from + '.')), undefined);
  assert.ok(g.edges.some((e) => e.kind === 'calls' && e.from === from && e.to === 'txrepo::src/approvals.ts::withTx'),
    'approveInvoice still calls withTx');
});

test('a property-value callback becomes its own node: the host gets one deferred edge, the work is the callback’s', async () => {
  const g = await ingest({
    'src/container.ts': [
      "import { OutboxWorker } from './worker';",
      'export function buildContainer() {',
      '  return new OutboxWorker({',
      '    hooks: {',
      '      /** Marks the invoice synced once the ERP accepted it. */',
      '      invoiceApproved: async () => { await db.invoices.update({ synced: true }); },',
      '    },',
      '    log: (m: string) => console.log(m),',
      '  });',
      '}',
    ].join('\n'),
    'src/worker.ts': [
      'export class OutboxWorker {',
      '  constructor(private readonly deps: { hooks?: { invoiceApproved?: () => Promise<void> }; log?: (m: string) => void }) {}',
      '  async drain() { await this.deps.hooks?.invoiceApproved?.(); }',
      '}',
    ].join('\n'),
  }, 'hookrepo');
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const host = 'hookrepo::src/container.ts::buildContainer';
  const hook = 'hookrepo::src/container.ts::buildContainer.hooks.invoiceApproved';
  const logCb = 'hookrepo::src/container.ts::buildContainer.log';

  // 1. the callback is a node, named for its key, tagged `callback`, located at the function
  const cb = byId.get(hook);
  assert.ok(cb, 'the property-value callback is a node of its own');
  assert.equal(cb!.name, 'invoiceApproved');
  assert.equal(cb!.kind, 'function');
  assert.ok(cb!.tags?.includes('callback'));
  assert.equal(cb!.loc?.path, 'src/container.ts');
  assert.equal(cb!.docs, 'Marks the invoice synced once the ERP accepted it.');
  // a sibling property function is a node too — the key path is what names it, so it is
  // `buildContainer.log` (log sits beside `hooks`, not inside it)
  assert.ok(byId.get(logCb), 'every property-value function is a node, not only the hooks');

  // 2. the host built it and did not run it
  const handover = g.edges.find((e) => e.kind === 'calls' && e.from === host && e.to === hook);
  assert.ok(handover, 'the host has a calls edge to the callback');
  assert.equal(handover!.meta?.deferred, true);

  // 3. the work is the callback's, and it is not deferred by virtue of the property
  const write = g.edges.find((e) => e.kind === 'writes' && e.from === hook && e.to === 'hookrepo::table::invoices');
  assert.ok(write, 'the callback writes invoices');
  assert.equal(write!.meta?.deferred, undefined);
  assert.equal(g.edges.some((e) => e.from === host && e.to === 'hookrepo::table::invoices'), false,
    'the container does not touch invoices — its callback does');

  // 4. the class method that runs it reaches it through the constructor binding
  const run = g.edges.find((e) => e.kind === 'calls' && e.from === 'hookrepo::src/worker.ts::OutboxWorker.drain' && e.to === hook);
  assert.ok(run, 'this.deps.hooks?.invoiceApproved?.() reaches the bound callback');
  assert.equal(run!.resolution?.technique, 'hook-binding');
  assert.equal(run!.resolution?.status, 'heuristic');
  assert.equal(run!.resolution?.confidence, 'MEDIUM');
  assert.match(String(run!.resolution?.note), /^bound at src\/container\.ts:\d+ of new OutboxWorker/);
  assert.equal(run!.meta?.deferred, true);
  assert.equal(run!.meta?.via, 'hook');
});

test('a class that copies the options object matches on the full path; an unbound hook call stays an absence', async () => {
  const g = await ingest({
    'src/dispatch.ts': [
      'export class Dispatcher {',
      '  private hooks: { ping?: () => void; pong?: () => void };',
      '  constructor(opts: { hooks: { ping?: () => void; pong?: () => void } }) { this.hooks = opts.hooks; }',
      '  run() { this.hooks.ping?.(); }',
      '  other() { this.hooks.pong?.(); }',
      '}',
    ].join('\n'),
    'src/wire.ts': [
      "import { Dispatcher } from './dispatch';",
      'export function wire() {',
      '  return new Dispatcher({ hooks: { ping: () => { db.pings.insert({}); } } });',
      '}',
    ].join('\n'),
  }, 'fullpath');
  const ping = 'fullpath::src/wire.ts::wire.hooks.ping';
  assert.ok(g.nodes.some((n) => n.id === ping));
  const run = g.edges.find((e) => e.kind === 'calls' && e.from === 'fullpath::src/dispatch.ts::Dispatcher.run' && e.to === ping);
  assert.ok(run, 'this.hooks.ping() matches the binding path `hooks.ping` in full');
  assert.equal(run!.resolution?.technique, 'hook-binding');
  // `pong` was never bound: no edge is invented for it
  assert.equal(g.edges.some((e) => e.from === 'fullpath::src/dispatch.ts::Dispatcher.other' && e.kind === 'calls'), false);
});

test('a transaction inside a callback belongs to the callback: tx on its edges, deferred only on the handover', async () => {
  const g = await ingest({
    'src/repos.ts': ['export class PgContractorRepository {', '  async setContractorBcVendor(id: string) { return id; }', '}'].join('\n'),
    'src/build.ts': [
      "import { Sync } from './sync';",
      'export function build() {',
      '  return new Sync({',
      '    hooks: {',
      '      vendorCreated: async () => {',
      '        await db.withOps(async (repos: any) => { await repos.contractors.setContractorBcVendor("x"); });',
      '      },',
      '    },',
      '  });',
      '}',
    ].join('\n'),
    'src/sync.ts': [
      'export class Sync {',
      '  constructor(private readonly deps: { hooks?: { vendorCreated?: () => Promise<void> } }) {}',
      '  async go() { await this.deps.hooks?.vendorCreated?.(); }',
      '}',
    ].join('\n'),
  }, 'nested');
  const host = 'nested::src/build.ts::build';
  const cb = 'nested::src/build.ts::build.hooks.vendorCreated';
  const target = 'nested::src/repos.ts::PgContractorRepository.setContractorBcVendor';
  // the inner arrow is a call argument, not a property: no node of its own
  assert.equal(g.nodes.some((n) => n.id.startsWith(cb + '.')), false);
  const inner = g.edges.find((e) => e.kind === 'calls' && e.from === cb && e.to === target);
  assert.ok(inner, 'the work inside withOps is the callback’s');
  assert.equal(inner!.meta?.tx, true);
  assert.equal(inner!.meta?.deferred, undefined);
  assert.equal(g.edges.some((e) => e.from === host && e.to === target), false);
  // exactly one deferred edge in the whole walk: the handover
  const deferred = g.edges.filter((e) => e.meta?.deferred === true);
  assert.deepEqual(deferred.map((e) => `${e.from} -> ${e.to}`).sort(), [
    `${host} -> ${cb}`,
    `nested::src/sync.ts::Sync.go -> ${cb}`,
  ].sort());
});

// ── A1.4: the start-up builder and the env schema ───────────────────────────
// `x ??= build()` in a file that parks a process-wide singleton names the container
// builder; an env/config schema is a rule of the code, never a gate a person passes.

test('a `??=` singleton in a Symbol.for file tags its builder `setup`, and the edge into it carries origin: setup', async () => {
  const g = await ingest({
    'src/container.ts': [
      "const KEY = Symbol.for('x.container');",
      'function holder(): { p?: Promise<unknown> } { return ((globalThis as any)[KEY] ??= {}); }',
      'function build() { return createPgDb(); }',
      'function createPgDb() { return db.clients.findMany(); }',
      'export function getContainer() {',
      '  return (holder().p ??= build().catch(() => null));',
      '}',
    ].join('\n'),
  }, 'setuprepo');
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const F = (n: string) => `setuprepo::src/container.ts::${n}`;
  assert.ok(byId.get(F('build'))?.tags.includes('setup'), 'the right-hand side of the `??=` is the builder');
  assert.equal(byId.get(F('build'))!.tags.filter((t) => t === 'setup').length, 1, 'the tag is added once');
  assert.equal(byId.get(F('getContainer'))?.tags.includes('setup'), false, 'the accessor is not the builder');
  assert.equal(byId.get(F('holder'))?.tags.includes('setup'), false, 'the left-hand side is not the builder');

  // ingestRepo runs applySetupOrigin, so the closure and its stamps are end-to-end facts
  const intoBuild = g.edges.find((e) => e.kind === 'calls' && e.from === F('getContainer') && e.to === F('build'));
  assert.ok(intoBuild, 'getContainer still calls build');
  assert.equal(intoBuild!.meta?.origin, 'setup', 'the call into a setup root is start-up');
  const inner = g.edges.find((e) => e.kind === 'calls' && e.from === F('build') && e.to === F('createPgDb'));
  assert.equal(inner!.meta?.origin, 'setup', 'the closure grows to a function only the builder calls');
  const read = g.edges.find((e) => e.kind === 'reads' && e.from === F('createPgDb'));
  assert.equal(read!.meta?.origin, 'setup', 'what the closure reads is read at boot, not per request');
});

test('the same `??=` shape without Symbol.for / globalThis tags nothing: the heuristic does not widen', async () => {
  const g = await ingest({
    'src/cache.ts': [
      'const slot: { p?: unknown } = {};',
      'function build() { return 1; }',
      'export function value() { return (slot.p ??= build()); }',
    ].join('\n'),
  }, 'nosingleton');
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('nosingleton::src/cache.ts::build')?.tags.includes('setup'), false);
  const call = g.edges.find((e) => e.kind === 'calls' && e.to === 'nosingleton::src/cache.ts::build');
  assert.ok(call, 'the call edge is unchanged');
  assert.equal(call!.meta?.origin, undefined, 'no setup root, no origin stamp');
});

test('a right-hand side that is not a call to a same-file function tags nothing', async () => {
  const g = await ingest({
    'src/slots.ts': [
      "const KEY = Symbol.for('x.slots');",
      "import { remote } from './remote';",
      'function local() { return 1; }',
      'const store: any = (globalThis as any)[KEY] ??= {};',
      'export function a() { return (store.x ??= remote()); }',       // imported, not same-file
      'export function b() { return (store.y ??= { made: local }); }', // an object literal, not a call
      'export function c() { return (store.z ??= new Map()); }',       // a constructor, not a declared function
    ].join('\n'),
    'src/remote.ts': 'export function remote() { return 2; }',
  }, 'narrow');
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('narrow::src/remote.ts::remote')?.tags.includes('setup'), false, 'an imported callee is not a same-file declaration');
  assert.equal(byId.get('narrow::src/slots.ts::local')?.tags.includes('setup'), false, 'a function merely named in an object literal is not a builder');
  assert.equal(g.nodes.some((n) => n.tags.includes('setup')), false, 'nothing in the repo is start-up');
});

test('env and config schemas are tagged `env-schema`; an ordinary schema is not', async () => {
  const g = await ingest({
    'src/env.ts': "import { z } from 'zod';\nexport const webEnvSchema = z.object({ PORT: z.string() });\nexport const other = z.object({ a: z.string() });",
    'src/server-env.ts': "import { z } from 'zod';\nexport const runtime = z.object({ HOST: z.string() });",
    'src/config.ts': "import { z } from 'zod';\nexport const settings = z.object({ tz: z.string() });",
    'src/schemas.ts': "import { z } from 'zod';\nexport const fooConfigSchema = z.object({ a: z.string() });\nexport const invoiceSchema = z.object({ id: z.string() });",
  }, 'schemas');
  const tagged = (id: string) => g.nodes.find((n) => n.id === id)?.tags.includes('env-schema');
  assert.equal(tagged('schemas::src/env.ts::webEnvSchema'), true, 'by name and by basename');
  assert.equal(tagged('schemas::src/env.ts::other'), true, 'every schema in env.ts describes the process');
  assert.equal(tagged('schemas::src/server-env.ts::runtime'), true, '*-env.ts counts');
  assert.equal(tagged('schemas::src/config.ts::settings'), true, 'config.ts counts');
  assert.equal(tagged('schemas::src/schemas.ts::fooConfigSchema'), true, 'the name rule works anywhere');
  assert.equal(tagged('schemas::src/schemas.ts::invoiceSchema'), false, 'a business schema stays a gate');
});

// ── A1.5: externals — three sources, one node ───────────────────────────────
// A package specifier names a third-party system; a class whose base URL starts
// with a constant names a host; `farsight.config.json → externals` names what the
// parser could not. A node is only ever created because an edge reaches it.

test('an SDK binding used inside a class reaches that system; `pg` never makes a node', async () => {
  const g = await ingest({
    'src/ocr.ts': [
      "import DocumentIntelligence from '@azure-rest/ai-document-intelligence';",
      'export class AzureOcr {',
      '  extract(f: unknown) { return DocumentIntelligence(f); }',
      '}',
    ].join('\n'),
    'src/db.ts': [
      "import { Pool } from 'pg';",
      'export function connect() { return new Pool(); }',
    ].join('\n'),
  }, 'sdkrepo');
  const extId = 'sdkrepo::external::Azure Document Intelligence';
  const ext = g.nodes.find((n) => n.id === extId);
  assert.ok(ext, 'the SDK the class uses is a system of its own');
  assert.equal(ext!.kind, 'external');
  assert.deepEqual(ext!.tags, ['external', 'ocr']);
  assert.deepEqual(ext!.external, {
    kind: 'ocr', source: 'sdk', via: 'AzureOcr', ref: '@azure-rest/ai-document-intelligence',
  });

  const e = g.edges.find((x) => x.kind === 'http' && x.to === extId);
  assert.ok(e, 'the function that used the binding reaches the system');
  assert.equal(e!.from, 'sdkrepo::src/ocr.ts::AzureOcr.extract');
  assert.equal(e!.resolution?.technique, 'sdk-import');
  assert.equal(e!.resolution?.status, 'heuristic');
  assert.equal(e!.resolution?.confidence, 'MEDIUM');
  assert.equal(e!.resolution?.note, 'uses @azure-rest/ai-document-intelligence in src/ocr.ts');
  assert.equal(e!.meta?.via, 'sdk');

  // Postgres is the records row, never a third party — the table says node: false
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'external').map((n) => n.name), ['Azure Document Intelligence']);
});

test('an SDK import nothing uses makes nothing', async () => {
  const g = await ingest({
    'src/unused.ts': [
      "import DocumentIntelligence from '@azure-rest/ai-document-intelligence';",
      "import { BlobServiceClient } from '@azure/storage-blob';",
      'export function nothingHere() { return 1; }',
    ].join('\n'),
  }, 'bareimport');
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'external'), [], 'an import is not a use');
  assert.equal(g.edges.some((e) => e.resolution?.technique === 'sdk-import'), false);
});

const ERP_FILES = {
  'src/hosts.ts': "export const ERP_HOST = 'https://erp.example.com';",
  'src/erpClient.ts': [
    "import { ERP_HOST } from './hosts';",
    'export class ErpClient {',
    '  readonly baseUrl: string;',
    '  constructor() { this.baseUrl = `${ERP_HOST}/v2`; }',
    '  async request(a: { url: string }) { return fetch(a.url, { method: "POST" }); }',
    '}',
  ].join('\n'),
};

test('a non-literal fetch in a class whose base URL is a constant reaches that host', async () => {
  const g = await ingest(ERP_FILES, 'hostrepo');
  const extId = 'hostrepo::external::erp.example.com';
  const ext = g.nodes.find((n) => n.id === extId);
  assert.ok(ext, 'the constant is followed through the import to its host');
  assert.equal(ext!.name, 'erp.example.com');
  assert.deepEqual(ext!.external, { kind: 'http', source: 'host', via: 'ErpClient', ref: 'ERP_HOST' });
  assert.deepEqual(ext!.tags, ['external', 'http']);

  const e = g.edges.find((x) => x.kind === 'http' && x.to === extId);
  assert.ok(e, 'the method that fetches reaches the host');
  assert.equal(e!.from, 'hostrepo::src/erpClient.ts::ErpClient.request');
  assert.equal(e!.resolution?.technique, 'constant-host');
  assert.equal(e!.resolution?.confidence, 'MEDIUM');
  assert.equal(e!.meta?.method, 'POST');
  // the URL is not a literal, so no `unknown` stub is invented for it either
  assert.equal(g.nodes.some((n) => n.kind === 'unknown'), false);
});

test('an unresolvable host constant makes nothing: no node, no edge', async () => {
  const g = await ingest({
    'src/client.ts': [
      'export class Blind {',
      '  base: string;',
      '  constructor() { this.base = `${MISSING_HOST}/v1`; }', // MISSING_HOST is declared in no file this ingest saw
      '  go(u: string) { return fetch(u); }',
      '}',
    ].join('\n'),
  }, 'noconst');
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'external'), [], 'a constant that cannot be followed is an absence');
});

test('a `<path>::<Class>` declaration renames and re-kinds the external the parser found', async () => {
  const g = await ingest({
    ...ERP_FILES,
    'farsight.config.json': JSON.stringify({
      externals: [{ import: 'src/erpClient.ts::ErpClient', name: 'Example ERP', kind: 'erp' }],
    }),
  }, 'cfgrepo');
  const externals = g.nodes.filter((n) => n.kind === 'external');
  assert.deepEqual(externals.map((n) => n.name), ['Example ERP'], 'still one node — renamed, not doubled');
  assert.deepEqual(externals[0]!.external, {
    kind: 'erp', source: 'config', via: 'ErpClient', ref: 'ERP_HOST',
  }, 'the declaration says what it is; the constant is still how it was found');
  assert.deepEqual(externals[0]!.tags, ['external', 'erp']);
  const e = g.edges.find((x) => x.kind === 'http' && x.to === externals[0]!.id);
  assert.ok(e, 'the edge the parser detected is still there');
  assert.equal(e!.from, 'cfgrepo::src/erpClient.ts::ErpClient.request');
  assert.equal(e!.resolution?.technique, 'constant-host', 'renaming a node does not restate how it was found');
});

test('a declaration for a class nothing was detected for: one external, one edge per fetching method', async () => {
  const g = await ingest({
    'src/clients.ts': [
      'export class MailClient {',
      '  async post(url: string) { return fetch(url, { method: "POST" }); }',
      '  async peek(url: string) { return fetch(url); }',
      '  format(x: string) { return x.trim(); }',
      '}',
      'export class QuietClient {',
      '  ping() { return 1; }',
      '}',
    ].join('\n'),
    'farsight.config.json': JSON.stringify({
      externals: [
        { import: 'src/clients.ts::MailClient', name: 'Mail Service', kind: 'email' },
        { import: 'src/clients.ts::QuietClient', name: 'Never Reached', kind: 'http' },
      ],
    }),
  }, 'declrepo');
  const externals = g.nodes.filter((n) => n.kind === 'external');
  assert.deepEqual(externals.map((n) => n.name), ['Mail Service'],
    'a declared class with no fetch at all has no call site to hang an edge on');
  assert.deepEqual(externals[0]!.external, {
    kind: 'email', source: 'config', via: 'MailClient', ref: 'src/clients.ts::MailClient',
  });
  const froms = g.edges.filter((e) => e.kind === 'http' && e.to === externals[0]!.id).map((e) => e.from).sort();
  assert.deepEqual(froms, ['declrepo::src/clients.ts::MailClient.peek', 'declrepo::src/clients.ts::MailClient.post'],
    'every method that fetches reaches the declared system; the one that does not is left alone');
  const e = g.edges.find((x) => x.kind === 'http' && x.to === externals[0]!.id);
  assert.equal(e!.resolution?.technique, 'annotation-scan');
  assert.equal(e!.resolution?.status, 'resolved');
});

test('an absolute-literal fetch and the constant-host rule agree on one node for the host', async () => {
  const g = await ingest({
    'src/hosts.ts': "export const API_HOST = 'https://api.example.com';",
    'src/api.ts': [
      "import { API_HOST } from './hosts';",
      'export class ApiClient {',
      '  constructor() { this.base = `${API_HOST}/v1`; }',
      '  send(a: { url: string }) { return fetch(a.url); }',
      '}',
      "export function ping() { return fetch('https://api.example.com/x'); }",
    ].join('\n'),
  }, 'onehost');
  const externals = g.nodes.filter((n) => n.kind === 'external');
  assert.deepEqual(externals.map((n) => n.name), ['api.example.com'], 'one host is one node');
  assert.deepEqual(externals[0]!.external, { kind: 'http', source: 'host', via: 'ApiClient', ref: 'API_HOST' },
    'the provenance merges onto the node the literal fetch made');
  assert.ok(externals[0]!.tags.includes('external') && externals[0]!.tags.includes('http'));
  const froms = g.edges.filter((e) => e.kind === 'http' && e.to === externals[0]!.id).map((e) => e.from).sort();
  assert.deepEqual(froms, ['onehost::src/api.ts::ApiClient.send', 'onehost::src/api.ts::ping'],
    'both call sites reach it, each with its own resolution');
});

// ── A1.6: interface-typed dispatch ─────────────────────────────────────────
// A member call whose receiver carries a declared type is followed through that
// type to the classes that promise to be it — whatever the method is called, and
// whatever the receiver's word is. Production implementers are drawn, test doubles
// are set aside but printed as `alternatives`, and a type nothing implements is an
// absence with a name on it rather than a guess by method name.

test('a class-typed parameter and a class-typed field dispatch through the type — even for a method the built-in filter hides', async () => {
  const g = await ingest({
    'src/transport.ts': [
      'export interface EmailTransport { send(to: string): Promise<void> }',
      'export class AcsEmailTransport implements EmailTransport { async send(to: string) { await db.sends.insert({ to }); } }',
      'export class FileEmailTransport implements EmailTransport { async send(to: string) { return; } }',
    ].join('\n'),
    'src/notifier.ts': [
      "import type { EmailTransport } from './transport';",
      'export class Notifier {',
      '  constructor(private readonly transport: EmailTransport) {}',
      '  async send(to: string) { await this.transport.send(to); }',
      '}',
    ].join('\n'),
    'src/auth.ts': [
      "import { Notifier } from './notifier';",
      "export function notify(n: Notifier) { return n.send('x'); }",
    ].join('\n'),
  }, 'notif');
  const N = 'notif::src/notifier.ts::Notifier.send';
  const acs = 'notif::src/transport.ts::AcsEmailTransport.send';
  const file = 'notif::src/transport.ts::FileEmailTransport.send';

  // `send` sits in BUILTIN_METHODS — a typed receiver is never a runtime object, so the
  // filter does not apply to it (01 §0.1: this is why Notifier.send had no callers)
  const into = g.edges.find((e) => e.kind === 'calls' && e.from === 'notif::src/auth.ts::notify' && e.to === N);
  assert.ok(into, 'n.send(…) with n: Notifier reaches the class’s own method');
  assert.equal(into!.resolution?.technique, 'interface');
  assert.equal(into!.resolution?.status, 'heuristic');
  assert.equal(into!.resolution?.confidence, 'MEDIUM', 'one implementer is still a syntax-level guess');
  assert.equal(into!.meta?.via, 'interface');
  assert.equal(into!.meta?.iface, 'Notifier');
  assert.equal(into!.resolution?.alternatives, undefined, 'nothing was set aside — the key is absent, never an empty list');
  assert.equal(into!.resolution?.note, 'the receiver is declared as the class Notifier');

  // the constructor parameter property is a typed field: `this.transport.send` is the interface
  const out = g.edges.filter((e) => e.kind === 'calls' && e.from === N);
  assert.deepEqual(out.map((e) => e.to).sort(), [acs, file].sort(), 'both production transports are drawn, neither is picked');
  for (const e of out) {
    assert.equal(e.resolution?.technique, 'interface');
    assert.equal(e.meta?.iface, 'EmailTransport');
    assert.deepEqual(e.resolution?.alternatives, [e.to === acs ? file : acs], 'the other implementer is printed, never walked');
  }
  // the work below the seam is still the implementer's own
  assert.ok(g.edges.some((e) => e.kind === 'writes' && e.from === acs && e.to === 'notif::table::sends'));
});

const OCR_FILES = {
  'src/ocr.ts': [
    'export interface Ocr { extract(f: unknown): unknown }',
    'export class AzureOcr implements Ocr { extract(f: unknown) { return 1; } }',
    "export class LlmOcr implements Ocr { extract(f: unknown) { throw new Error('not built'); } }",
    'export class MockOcr implements Ocr { extract(f: unknown) { return null; } }',
  ].join('\n'),
  'src/pipeline.ts': [
    "import type { Ocr } from './ocr';",
    'export function processDocument(provider: Ocr) { return provider.extract(1); }',
    'export function readInvoice({ provider }: { provider: Ocr }) { return provider.extract(1); }',
  ].join('\n'),
};

test('several production implementers mean several edges; the double is set aside and still printed', async () => {
  const g = await ingest(OCR_FILES, 'ocrrepo');
  const azure = 'ocrrepo::src/ocr.ts::AzureOcr.extract';
  const llm = 'ocrrepo::src/ocr.ts::LlmOcr.extract';
  const mock = 'ocrrepo::src/ocr.ts::MockOcr.extract';
  const from = 'ocrrepo::src/pipeline.ts::processDocument';

  const out = g.edges.filter((e) => e.kind === 'calls' && e.from === from);
  assert.deepEqual(out.map((e) => e.to).sort(), [azure, llm].sort(), 'two production implementers, two edges — no pick');
  for (const e of out) {
    assert.equal(e.resolution?.technique, 'interface');
    assert.equal(e.resolution?.confidence, 'MEDIUM');
    assert.deepEqual(e.resolution?.alternatives?.slice().sort(), [mock, e.to === azure ? llm : azure].sort(),
      'every implementer this build saw is named, the sibling included');
    assert.match(String(e.resolution?.note), /^3 classes implement Ocr; in-memory \/ mock twins set aside$/);
  }
  assert.equal(g.edges.some((e) => e.to === mock), false, 'no edge to the double');

  // a destructured parameter binds a name the annotation never names: the type is not
  // read, so nothing is claimed about it either way (01 §2.3.5, the ObjectPattern rule)
  const pattern = 'ocrrepo::src/pipeline.ts::readInvoice';
  assert.equal(g.edges.some((e) => e.from === pattern), false, 'no edge, and no crash');
  assert.equal(g.nodes.find((n) => n.id === pattern)?.tags.includes('unresolved:interface'), false,
    'the type was never read, so the absence is not an unfollowed interface');
});

test('a type reached through a barrel, and a path walked through an inline literal, resolve the same way', async () => {
  const g = await ingest({
    'src/ocr/provider.ts': OCR_FILES['src/ocr.ts'],
    'src/ocr/index.ts': "export type { Ocr } from './provider';\nexport * from './provider';",
    'src/read.ts': [
      "import type { Ocr } from './ocr';",
      'export function readInvoice(args: { provider: Ocr }) { return args.provider.extract(1); }',
    ].join('\n'),
  }, 'barrel');
  const out = g.edges.filter((e) => e.kind === 'calls' && e.from === 'barrel::src/read.ts::readInvoice');
  assert.deepEqual(out.map((e) => e.to).sort(),
    ['barrel::src/ocr/provider.ts::AzureOcr.extract', 'barrel::src/ocr/provider.ts::LlmOcr.extract'].sort(),
    '`export type { Ocr }` is followed like any re-export, and `args.provider` is one hop of the path');
  assert.equal(out[0]!.meta?.iface, 'Ocr');
});

test('a type nothing implements is an absence with a name on it — never a fall back to the method-name guess', async () => {
  const g = await ingest({
    'src/ports.ts': 'export interface Clock { tick(): number }',
    'src/ticker.ts': 'export class Ticker { tick() { return 1; } }', // declares tick, implements nothing, named for nothing
    'src/use.ts': [
      "import type { Clock } from './ports';",
      'export function stamp(c: Clock) { return c.tick(); }',
    ].join('\n'),
  }, 'noimpl');
  const stamp = 'noimpl::src/use.ts::stamp';
  assert.equal(g.edges.some((e) => e.from === stamp && e.kind === 'calls'), false,
    'the one class that declares tick is not a Clock: the type removed that guess');
  assert.ok(g.nodes.find((n) => n.id === stamp)?.tags.includes('unresolved:interface'),
    'the caller carries the absence so a journey can say it');
});

test('an untyped receiver is still resolved by method name, exactly as before', async () => {
  const g = await ingest({
    'src/outbox.ts': [
      'export class PgBcOutboxRepository { async enqueue(job: unknown) { await db.bc_outbox.insert(job); } }',
      'export class InMemoryBcOutboxRepository { async enqueue(job: unknown) { return; } }',
    ].join('\n'),
    'src/submit.ts': 'export async function submit(c) { await c.outbox.enqueue(1); }',
  }, 'untyped');
  const e = g.edges.find((x) => x.kind === 'calls' && x.from === 'untyped::src/submit.ts::submit');
  assert.ok(e, 'c.outbox.enqueue still resolves — the typed rule must not lose it (01 §0.2)');
  assert.equal(e!.to, 'untyped::src/outbox.ts::PgBcOutboxRepository.enqueue');
  assert.equal(e!.resolution?.technique, 'method-name');
  assert.equal(e!.meta?.via, 'method-name');
});

test('the name-suffix fallback fires only when nobody declared themselves', async () => {
  const g = await ingest({
    'src/foo.ts': [
      'export interface FooRepository { insert(x: unknown): void }',
      'export class PgFooRepository { insert(x: unknown) { return x; } }', // no implements clause
    ].join('\n'),
    'src/bar.ts': [
      'export interface BarRepository { insert(x: unknown): void }',
      'export class PgBarRepository implements BarRepository { insert(x: unknown) { return x; } }',
      'export class SpecialBarRepository { insert(x: unknown) { return x; } }', // named for it, declares nothing
    ].join('\n'),
    'src/use.ts': [
      "import type { FooRepository } from './foo';",
      "import type { BarRepository } from './bar';",
      'export function addFoo(r: FooRepository) { r.insert(1); }',
      'export function addBar(r: BarRepository) { r.insert(2); }',
    ].join('\n'),
  }, 'suffix');
  const foo = g.edges.filter((e) => e.kind === 'calls' && e.from === 'suffix::src/use.ts::addFoo');
  assert.deepEqual(foo.map((e) => e.to), ['suffix::src/foo.ts::PgFooRepository.insert'],
    'a class named for the interface that declares the method is the structural fallback');
  assert.equal(foo[0]!.resolution?.technique, 'interface');
  assert.equal(foo[0]!.resolution?.alternatives, undefined);

  const bar = g.edges.filter((e) => e.kind === 'calls' && e.from === 'suffix::src/use.ts::addBar');
  assert.deepEqual(bar.map((e) => e.to), ['suffix::src/bar.ts::PgBarRepository.insert'],
    'an `implements` match stops the name guess: the similarly named class is not drawn');
});

// ── A1.9: the goldens on examples/invoice-app ───────────────────────────────
// Every rule above also has to hold on the fixture repo the other suites ingest,
// where the files sit beside ordinary source, `farsight.config.json` declares the
// external / the plumbing / the setup root, and core's fold reads the result
// (01 §2.6). One ingest, shared by the blocks below.

let invoiceGraph: Awaited<ReturnType<typeof ingestRepo>> | undefined;
const invoiceApp = async () => (invoiceGraph ??= await ingestRepo(resolve(import.meta.dirname, '../../../examples/invoice-app'), { repoName: 'invoice-app' }));

const S = (p: string) => `invoice-app::src/server/${p}`;
const APPROVE_ROUTE = 'invoice-app::route::POST /invoices/:id/approve';

test('invoice-app · R1: the @guard that also works — a gate on the route, a transaction inside it', async () => {
  const g = await invoiceApp();
  const approve = g.nodes.find((n) => n.id === S('approvals.ts::approveInvoice'))!;
  assert.equal(approve.kind, 'guard', 'a @guard tag re-kinds the function');
  assert.equal(approve.name, 'approveInvoice: approver role');

  // the badge on the route, and the call that descends into it — both, not one or the other
  assert.ok(g.edges.some((e) => e.kind === 'guards' && e.from === approve.id && e.to === APPROVE_ROUTE));
  const call = g.edges.find((e) => e.kind === 'calls' && e.from === APPROVE_ROUTE && e.to === approve.id)!;
  assert.ok(call, 'the route runs the guard as well as being gated by it');
  assert.equal(call.meta?.via, 'guard');

  // the writes of the withTx callback are the guard's own, inside the transaction
  const writes = g.edges.filter((e) => e.kind === 'writes' && e.from === approve.id);
  assert.deepEqual(writes.map((e) => e.to).sort(), ['invoice-app::table::approvals', 'invoice-app::table::invoices']);
  for (const e of writes) {
    assert.equal(e.meta?.tx, true, 'a write inside withTx carries the transaction flag');
    assert.equal(e.meta?.deferred, undefined, 'a call argument is never deferred');
  }
  assert.equal(g.nodes.some((n) => n.id.startsWith(approve.id + '.')), false, 'the withTx callback is not a node of its own');
});

test('invoice-app · R2/R3: the container hands work over once, and the boot is named', async () => {
  const g = await invoiceApp();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const build = S('container.ts::buildContainer');
  const hook = S('container.ts::buildContainer.hooks.invoiceApproved');

  // R2 — the property-value callback is its own node, and the host only handed it over
  const cb = byId.get(hook)!;
  assert.ok(cb, 'the hook is a node of its own');
  assert.equal(cb.name, 'invoiceApproved');
  assert.ok(cb.tags.includes('callback'));
  assert.equal(cb.docs, 'Marks the invoice synced once the approval reached the ledger.');
  const handover = g.edges.find((e) => e.kind === 'calls' && e.from === build && e.to === hook)!;
  assert.equal(handover.meta?.deferred, true);
  const hookWrite = g.edges.find((e) => e.kind === 'writes' && e.from === hook && e.to === 'invoice-app::table::invoices')!;
  assert.ok(hookWrite, 'the callback is what touches invoices');
  assert.equal(hookWrite.meta?.deferred, undefined);
  assert.equal(g.edges.some((e) => e.from === build && e.to === 'invoice-app::table::invoices'), false,
    'the container builder itself writes nothing');
  const run = g.edges.find((e) => e.kind === 'calls' && e.from === S('container.ts::OutboxWorker.drain') && e.to === hook)!;
  assert.ok(run, 'this.deps.hooks?.invoiceApproved?.() reaches what the constructor was handed');
  assert.equal(run.resolution?.technique, 'hook-binding');
  assert.equal(run.meta?.deferred, true);
  assert.equal(run.meta?.via, 'hook');

  // R3 — the `??=` singleton names the builder, and the config declaration agrees
  assert.ok(byId.get(build)!.tags.includes('setup'));
  assert.equal(byId.get(build)!.tags.filter((t) => t === 'setup').length, 1, 'the heuristic and the declaration agree; the tag lands once');
  assert.equal(byId.get(S('container.ts::getContainer'))!.tags.includes('setup'), false, 'the accessor is not the builder');
  const intoBuild = g.edges.find((e) => e.kind === 'calls' && e.from === S('container.ts::getContainer') && e.to === build)!;
  assert.equal(intoBuild.meta?.origin, 'setup');
  const intoEnv = g.edges.find((e) => e.kind === 'calls' && e.from === build && e.to === S('config/env.ts::loadEnv'))!;
  assert.equal(intoEnv.meta?.origin, 'setup', 'the closure grows to the function only the builder calls');
});

test('invoice-app · R4/R5: the SDK, the constant host renamed by config, and the typed dispatch', async () => {
  const g = await invoiceApp();
  const externals = g.nodes.filter((n) => n.kind === 'external');
  assert.deepEqual(externals.map((n) => n.name).sort(), ['Azure Document Intelligence', 'Example ERP']);

  // R4a — the SDK specifier names the system; the class that used the binding reaches it
  const azure = externals.find((n) => n.name === 'Azure Document Intelligence')!;
  assert.equal(azure.id, 'invoice-app::external::Azure Document Intelligence');
  assert.deepEqual(azure.external, { kind: 'ocr', source: 'sdk', via: 'AzureOcr', ref: '@azure-rest/ai-document-intelligence' });
  assert.deepEqual(azure.tags, ['external', 'ocr']);
  const toAzure = g.edges.find((e) => e.kind === 'http' && e.to === azure.id)!;
  assert.equal(toAzure.from, S('ocr.ts::AzureOcr.extract'));
  assert.equal(toAzure.resolution?.technique, 'sdk-import');
  assert.equal(toAzure.meta?.via, 'sdk');

  // R4b — a non-literal fetch behind a constant host, named and re-kinded by the declaration
  const erp = externals.find((n) => n.name === 'Example ERP')!;
  assert.deepEqual(erp.external, { kind: 'erp', source: 'config', via: 'ErpClient', ref: 'ERP_HOST' },
    'farsight.config.json says what it is; the constant is still how it was found');
  assert.deepEqual(erp.tags, ['external', 'erp']);
  const toErp = g.edges.find((e) => e.kind === 'http' && e.to === erp.id)!;
  assert.equal(toErp.from, S('erpClient.ts::ErpClient.request'));
  assert.equal(toErp.resolution?.technique, 'constant-host');
  assert.equal(toErp.meta?.method, 'POST');
  assert.equal(g.nodes.some((n) => n.kind === 'unknown'), false, 'an assembled URL invents no stub');

  // R5 — an interface-typed receiver reaches the production implementer, the double is printed
  const ocr = g.edges.filter((e) => e.kind === 'calls' && e.from === S('ocr.ts::readInvoice'));
  assert.deepEqual(ocr.map((e) => e.to), [S('ocr.ts::AzureOcr.extract')]);
  assert.equal(ocr[0]!.resolution?.technique, 'interface');
  assert.equal(ocr[0]!.meta?.iface, 'Ocr');
  assert.deepEqual(ocr[0]!.resolution?.alternatives, [S('ocr.ts::MockOcr.extract')]);
  assert.equal(g.edges.some((e) => e.to === S('ocr.ts::MockOcr.extract')), false, 'no edge to the stand-in');

  // R5 again, for a method the built-in filter hides: `send`
  const notify = g.edges.filter((e) => e.kind === 'calls' && e.from === S('notify.ts::notifyApproved'));
  assert.deepEqual(notify.map((e) => e.to), [S('notify.ts::EmailNotifier.send')]);
  assert.equal(notify[0]!.meta?.iface, 'Notifier');
  assert.deepEqual(notify[0]!.resolution?.alternatives, [S('notify.ts::FakeNotifier.send')]);
});

test('invoice-app · R7: declared plumbing folds whatever it says about itself; an env schema is no checkpoint', async () => {
  const g = await invoiceApp();
  const index = buildIndex(g.nodes, g.edges);

  // R7a — the schema that gates the boot is a rule of the code, never a gate on a journey
  const env = g.nodes.find((n) => n.id === S('config/env.ts::appEnvSchema'))!;
  assert.equal(env.kind, 'rule');
  assert.ok(env.tags.includes('env-schema'));
  const boot = journey(index, S('container.ts::buildContainer'));
  const loadEnv = boot.steps.find((s) => s.nodeId === S('config/env.ts::loadEnv'))!;
  assert.ok(loadEnv, 'the builder still walks into loadEnv');
  assert.deepEqual(loadEnv.gates, [], 'appEnvSchema validates it, and is not a checkpoint anyone passes');

  // R7b — `fmt` carries an @business sentence and is still plumbing, because config said so
  const fmt = g.nodes.find((n) => n.id === S('plumbing/format.ts::fmt'))!;
  assert.ok(fmt.tags.includes('plumbing'));
  assert.ok(fmt.facets?.business?.description, 'the fixture authors prose on it deliberately');
  const j = journey(index, APPROVE_ROUTE);
  const sum = journeySummary(index, j, screensFor(index, APPROVE_ROUTE));
  const marker = sum.segments[0]!.markers.find((m) => m.nodeId === fmt.id)!;
  assert.ok(marker, 'fmt is on the approve journey');
  assert.equal(marker.helper, true, 'declared plumbing is a helper whatever it says about itself');

  // and the transaction the guard opened is what the records row shows
  const records = sum.segments[0]!.markers.filter((m) => m.kind === 'record').map((m) => m.name).sort();
  assert.deepEqual(records, ['approvals', 'invoices']);
});

test('a hook slot typed by a named interface still resolves to its binding — the type has no implementer, the object literal does', async () => {
  const f = await ingest({
    'src/worker.ts': `
export interface Hooks { invoiceCreated?: (e: { id: string }) => Promise<void> }
export class Worker {
  constructor(private readonly deps: { hooks?: Hooks; log: (m: string) => void }) {}
  async execute() { await this.deps.hooks?.invoiceCreated?.({ id: 'x' }); this.deps.log('done'); }
}
`,
    'src/container.ts': `
import { Worker } from './worker';
export function build() {
  return new Worker({ hooks: { invoiceCreated: async (e) => { console.log(e.id); } }, log: (m) => console.log(m) });
}
`,
  }, 'namedhooks');
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const exec = 'namedhooks::src/worker.ts::Worker.execute';
  const hook = 'namedhooks::src/container.ts::build.hooks.invoiceCreated';
  assert.ok(byId.get(hook), 'the callback is a node');
  const e = f.edges.find((x) => x.from === exec && x.to === hook);
  assert.ok(e, 'Worker.execute → build.hooks.invoiceCreated through the binding, although Hooks has no implementer');
  assert.equal(e!.resolution?.technique, 'hook-binding');
  assert.equal(e!.meta?.deferred, true);
  assert.ok(!byId.get(exec)!.tags.includes('unresolved:interface'), 'a bound hook is not an unresolved interface');
  // the slot nobody bound is still an honest absence
  const f2 = await ingest({
    'src/worker.ts': `
export interface Hooks { ping?: () => void }
export class Worker { constructor(private readonly deps: { hooks?: Hooks }) {} run() { this.deps.hooks?.ping?.(); } }
`,
    'src/container.ts': `import { Worker } from './worker'; export function build() { return new Worker({}); }`,
  }, 'unboundhooks');
  const run = f2.nodes.find((n) => n.id === 'unboundhooks::src/worker.ts::Worker.run')!;
  assert.ok(run.tags.includes('unresolved:interface'));
  assert.equal(f2.edges.some((x) => x.from === run.id && x.kind === 'calls'), false);
});

// A script and the running app bind the same hook name. The reference app (2026-09-25): the
// invoice submit drill's AFTERWARDS row drew `scripts/pilot-sandbox-e2e.ts`'s `log`
// beside the runtime `log`, both at MEDIUM — a name collision drawn as a fact.
// Tooling (config `tooling`, default `scripts/**`) is tagged at ingest; the app's
// edges into it drop to LOW and the journey does not walk into it.
const collision = (config?: object): Record<string, string> => ({
  ...(config ? { 'farsight.config.json': JSON.stringify(config) } : {}),
  'src/container.ts': [
    "import { OutboxWorker } from './worker';",
    'export function buildContainer() {',
    '  return new OutboxWorker({ log: (m: string) => console.log(m) });',
    '}',
  ].join('\n'),
  'src/worker.ts': [
    'export class OutboxWorker {',
    '  constructor(private readonly deps: { log?: (m: string) => void }) {}',
    "  async drain() { this.deps.log?.('drained'); }",
    '}',
  ].join('\n'),
  'scripts/pilot.ts': [
    "import { OutboxWorker } from '../src/worker';",
    'export async function main() {',
    '  const w = new OutboxWorker({ log: (m: string) => console.log(`[pilot] ${m}`) });',
    '  await w.drain();',
    '}',
  ].join('\n'),
});

test('a script that shares a hook name with the app is tooling: LOW, and off the production path', async () => {
  const g = await ingest(collision(), 'toolrepo');
  const drain = 'toolrepo::src/worker.ts::OutboxWorker.drain';
  const appLog = 'toolrepo::src/container.ts::buildContainer.log';
  const scriptLog = 'toolrepo::scripts/pilot.ts::main.log';
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.ok(byId.get(scriptLog)?.tags.includes('tooling'), 'the script’s callback is tagged tooling by default');
  assert.ok(byId.get('toolrepo::scripts/pilot.ts::main')?.tags.includes('tooling'));
  assert.equal(byId.get(appLog)?.tags.includes('tooling'), false, 'the app is not tooling');

  const intoScript = g.edges.find((e) => e.kind === 'calls' && e.from === drain && e.to === scriptLog);
  assert.ok(intoScript, 'the binding is still recorded — the graph hides nothing');
  assert.equal(intoScript!.resolution?.confidence, 'LOW');
  assert.equal(intoScript!.resolution?.technique, 'hook-binding', 'how it was found is kept');
  assert.match(String(intoScript!.resolution?.note), /tooling \(scripts\/\*\*\)/);
  const intoApp = g.edges.find((e) => e.kind === 'calls' && e.from === drain && e.to === appLog);
  assert.equal(intoApp!.resolution?.confidence, 'MEDIUM', 'the app’s own binding keeps its confidence');
  const scriptCallsApp = g.edges.find((e) => e.kind === 'calls' && e.from === 'toolrepo::scripts/pilot.ts::main' && e.to === drain);
  if (scriptCallsApp) assert.notEqual(scriptCallsApp.resolution?.confidence, 'LOW', 'a script calling the app is a real call');

  const index = buildIndex(g.nodes, g.edges);
  const walked = journey(index, drain).steps.map((s) => s.nodeId);
  assert.ok(walked.includes(appLog), 'the runtime log is on the path');
  assert.equal(walked.includes(scriptLog), false, 'the script’s log is not');
  const sum = journeySummary(index, journey(index, drain), screensFor(index, byId.get(drain)!));
  assert.equal(JSON.stringify(sum).includes('scripts/'), false, 'nothing from scripts/ reaches the summary (afterwards included)');
});

test('tooling is configurable: `tooling: []` turns it off, and other globs can be named', async () => {
  const off = await ingest(collision({ tooling: [] }), 'tooloff');
  const edge = off.edges.find((e) => e.to === 'tooloff::scripts/pilot.ts::main.log' && e.from === 'tooloff::src/worker.ts::OutboxWorker.drain');
  assert.equal(edge!.resolution?.confidence, 'MEDIUM');
  assert.equal(off.nodes.some((n) => n.tags.includes('tooling')), false);
  const other = await ingest(collision({ tooling: ['tools/**'] }), 'toolother');
  assert.equal(other.nodes.some((n) => n.tags.includes('tooling')), false, 'only the named globs are tooling once the config names some');
});
