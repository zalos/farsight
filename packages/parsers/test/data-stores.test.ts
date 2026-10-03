// Data stores (docs/proposals/data-stores.md): which store a table lives in, how each rule knows,
// externals used as stores, and per-public-method http edges whose method is read, never defaulted.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo, prismaProviders, springDatasourceJdbc } from '../dist/index.js';
import { sanitizeStores } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-stores-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const ingest = (files: Record<string, string>, repoName = 'r') =>
  ingestRepo(tempRepo({ 'package.json': `{"name":"${repoName}"}`, ...files }), { repoName, openapi: false, design: false, tests: false });

const table = (g: { nodes: { id: string; store?: unknown }[] }, name: string, repo = 'r') => g.nodes.find((n) => n.id === `${repo}::table::${name}`);

const RAW_SQL = "export async function listInvoices(db: any) { return db.query('SELECT id FROM invoices'); }";

test('factory: pgTable names Postgres outright — via factory, ref the factory', async () => {
  const g = await ingest({
    'src/schema.ts': "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const invoices = pgTable('invoices', { id: text('id') });",
  });
  assert.deepEqual(table(g, 'invoices')?.store, { name: 'Postgres', kind: 'sql', engine: 'postgres', via: 'factory', ref: 'pgTable' });
  assert.deepEqual(g.meta?.stores?.named, { factory: 1 });
});

test('sdk: exactly one SQL driver in the repo names the store of every table', async () => {
  const g = await ingest({ 'src/db.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();", 'src/invoices.ts': RAW_SQL });
  assert.deepEqual(table(g, 'invoices')?.store, { name: 'Postgres', kind: 'sql', engine: 'postgres', via: 'sdk', ref: 'pg' });
  assert.deepEqual(g.meta?.stores?.drivers, [{ spec: 'pg', files: 1 }]);
});

test('sdk: two drivers of one store still name it; the refs say both', async () => {
  const g = await ingest({
    'src/a.ts': "import { Pool } from 'pg';\nexport const a = Pool;",
    'src/b.ts': "import pgp from 'pg-promise';\nexport const b = pgp;",
    'src/invoices.ts': RAW_SQL,
  });
  assert.deepEqual(table(g, 'invoices')?.store, { name: 'Postgres', kind: 'sql', engine: 'postgres', via: 'sdk', ref: 'pg, pg-promise' });
});

test('sdk: drivers of two stores name nothing, and the meta says why', async () => {
  const g = await ingest({
    'src/a.ts': "import { Pool } from 'pg';\nexport const a = Pool;",
    'src/b.ts': "import mysql from 'mysql2';\nexport const b = mysql;",
    'src/invoices.ts': RAW_SQL,
  });
  assert.equal(table(g, 'invoices')?.store, undefined, 'never a pick between two stores');
  assert.equal(g.meta?.stores?.unnamed, 1);
  assert.match(g.meta?.stores?.notes?.[0] ?? '', /more than one store \(MySQL, Postgres\)/);
});

test('factory beats sdk: a pgTable stays Postgres in a repo whose one driver is mysql2', async () => {
  const g = await ingest({
    'src/schema.ts': "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const invoices = pgTable('invoices', { id: text('id') });",
    'src/db.ts': "import mysql from 'mysql2';\nexport const m = mysql;",
    'src/other.ts': "export async function x(db: any) { return db.query('SELECT 1 FROM audit_log'); }",
  });
  assert.equal((table(g, 'invoices')?.store as { via: string }).via, 'factory');
  assert.deepEqual(table(g, 'audit_log')?.store, { name: 'MySQL', kind: 'sql', engine: 'mysql', via: 'sdk', ref: 'mysql2' });
});

test('datasource: schema.prisma names the provider for tables no code rule named', async () => {
  const g = await ingest({
    'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    'src/invoices.ts': RAW_SQL,
  });
  assert.deepEqual(table(g, 'invoices')?.store, { name: 'Postgres', kind: 'sql', engine: 'postgres', via: 'datasource', ref: 'prisma/schema.prisma' });
  assert.deepEqual(prismaProviders('datasource db { provider = env("P") }'), [{ raw: 'env("P")' }], 'a provider that is not a literal is no provider');
});

test('jpa: spring.datasource.url names the store of the Java entities', async () => {
  const g = await ingest({
    'src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://localhost:5432/app\n',
    'src/main/java/app/Invoice.java': 'package app;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Invoice { private String id; }\n',
  }, 'j');
  assert.deepEqual(table(g, 'invoice', 'j')?.store, {
    name: 'Postgres', kind: 'sql', engine: 'postgres', via: 'jpa', ref: 'src/main/resources/application.properties spring.datasource.url',
  });
  assert.equal(springDatasourceJdbc('spring:\n  datasource:\n    url: jdbc:mysql://h/db\n', true), 'mysql');
  assert.equal(springDatasourceJdbc('spring.datasource.url: "jdbc:sqlserver://h"\n', true), 'sqlserver');
});

test('config: names the tables the code left unnamed; with tables, only those; never overrides code', async () => {
  const g = await ingest({
    'src/schema.ts': "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const invoices = pgTable('invoices', { id: text('id') });",
    'src/other.ts': "export async function x(db: any) { await db.query('SELECT 1 FROM audit_log'); return db.query('SELECT 1 FROM files'); }",
    'farsight.config.json': JSON.stringify({
      stores: [
        { name: 'Ledger DB', kind: 'sql', engine: 'mysql' },
        { name: 'Archive', kind: 'files', tables: ['files', 'invoices'] },
      ],
    }),
  });
  assert.equal((table(g, 'invoices')?.store as { via: string }).via, 'factory', 'config never overrides what code found');
  assert.deepEqual(table(g, 'files')?.store, { name: 'Archive', kind: 'files', via: 'config', ref: 'farsight.config.json stores: Archive' });
  assert.deepEqual(table(g, 'audit_log')?.store, { name: 'Ledger DB', kind: 'sql', engine: 'mysql', via: 'config', ref: 'farsight.config.json stores: Ledger DB' });
  assert.deepEqual(g.meta?.stores?.named, { factory: 1, config: 2 });
  assert.equal(g.meta?.stores?.unnamed, 0);
});

test('config is validated softly: malformed entries are dropped, never thrown', () => {
  const c = sanitizeStores({
    stores: [{ name: 'ok', kind: 'sql', engine: 'nope', tables: ['a', 3] }, { name: '', kind: 'sql' }, { name: 'x', kind: 'cloud' }, 'junk'] as never,
    externals: [{ import: 'x', name: 'X', kind: 'erp', store: 'yes' as never }],
  });
  assert.deepEqual(c.stores, [{ name: 'ok', kind: 'sql', tables: ['a'] }]);
  assert.equal('store' in c.externals![0]!, false);
});

test('no rule, no store: a hand-rolled db object with no driver leaves tables unnamed', async () => {
  const g = await ingest({ 'src/invoices.ts': RAW_SQL });
  assert.equal(table(g, 'invoices')?.store, undefined);
  assert.equal(g.meta?.stores?.unnamed, 1);
});

// ── externals as stores, and the methods of a declared client ──

const CLIENT = [
  "import { ERP_HOST } from './hosts';",
  'export class ErpClient {',
  '  readonly baseUrl: string;',
  '  constructor() { this.baseUrl = `${ERP_HOST}/v2`; }',
  "  async getList() { return this.request({ url: 'a', method: 'GET' }); }",
  "  async create() { return this.request({ url: 'b', method: 'post' }); }",
  '  async change(verb: string) { return this.request({ url: "c", method: verb }); }',
  '  async ping() { return 1; }',
  '  private async request(a: { url: string; method: string }) { return fetch(a.url, { method: a.method }); }',
  '}',
].join('\n');

test('a declared client: one http edge per public method, the method read off the literal on the path', async () => {
  const g = await ingest({
    'src/hosts.ts': "export const ERP_HOST = 'https://erp.example.com';",
    'src/erpClient.ts': CLIENT,
    'farsight.config.json': JSON.stringify({ externals: [{ import: 'src/erpClient.ts::ErpClient', name: 'Example ERP', kind: 'erp' }] }),
  });
  const ext = g.nodes.find((n) => n.id === 'r::external::Example ERP')!;
  assert.equal(ext.external?.store, true, 'an ERP is a store by its kind');
  assert.deepEqual(ext.store, { name: 'Example ERP', kind: 'erp', via: 'config', ref: 'src/erpClient.ts::ErpClient' });
  const edges = g.edges.filter((e) => e.kind === 'http' && e.to === ext.id);
  const byFrom = Object.fromEntries(edges.map((e) => [e.from.split('::').pop()!, e.meta?.method ?? null]));
  assert.deepEqual(byFrom, { 'ErpClient.getList': 'GET', 'ErpClient.create': 'POST', 'ErpClient.change': null },
    'each public method that reaches the fetch; the private helper and a method that never fetches get none');
  assert.equal(edges.find((e) => e.from.endsWith('ErpClient.change'))!.meta!.method, undefined, 'a non-literal method is omitted, never GET');
});

test('the same client without a host constant: the declared-class path hangs edges on the public methods too', async () => {
  const g = await ingest({
    'src/erpClient.ts': CLIENT.replace("import { ERP_HOST } from './hosts';", '').replace('`${ERP_HOST}/v2`', "'/v2'"),
    'farsight.config.json': JSON.stringify({ externals: [{ import: 'src/erpClient.ts::ErpClient', name: 'Example ERP', kind: 'erp', store: false }] }),
  });
  const ext = g.nodes.find((n) => n.id === 'r::external::Example ERP')!;
  assert.equal(ext.external?.store, undefined, 'store: false overrides the kind');
  assert.equal(ext.store, undefined);
  const methods = g.edges.filter((e) => e.kind === 'http' && e.to === ext.id).map((e) => `${e.from.split('.').pop()} ${e.meta?.method ?? '-'}`).sort();
  assert.deepEqual(methods, ['change -', 'create POST', 'getList GET']);
});

test('externals default by kind: OCR is not a store, a file store is, an http API can be declared one', async () => {
  const g = await ingest({
    'src/ocr.ts': "import DocumentIntelligence from '@azure-rest/ai-document-intelligence';\nexport class AzureOcr { extract() { return DocumentIntelligence('x'); } }",
    'src/files.ts': "import { BlobServiceClient } from '@azure/storage-blob';\nexport function save() { return BlobServiceClient.fromConnectionString('x'); }",
    'src/crm.ts': "import { Crm } from 'crm-sdk';\nexport function sync() { return new Crm(); }",
    'farsight.config.json': JSON.stringify({ externals: [{ import: 'crm-sdk', name: 'CRM', kind: 'http', store: true }] }),
  });
  const ext = (name: string) => g.nodes.find((n) => n.id === `r::external::${name}`)!;
  assert.equal(ext('Azure Document Intelligence').store, undefined);
  assert.deepEqual(ext('Azure Blob Storage').store, { name: 'Azure Blob Storage', kind: 'files', via: 'sdk', ref: '@azure/storage-blob' });
  assert.deepEqual(ext('CRM').store, { name: 'CRM', kind: 'other', via: 'config', ref: 'crm-sdk' });
});

test('fetch: no init is a GET the code wrote; an init variable is unknown and matches a route only by a unique path', async () => {
  const g = await ingest({
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/items', (req, res) => res.json([]));\napp.post('/orders', (req, res) => res.json({}));\napp.get('/orders', (req, res) => res.json([]));",
    'src/client.ts': [
      "export function a() { return fetch('/items'); }",
      'export function b(init: RequestInit) { return fetch(\'/items\', init); }',
      'export function c(init: RequestInit) { return fetch(\'/orders\', init); }',
    ].join('\n'),
  });
  const http = (fn: string) => g.edges.find((e) => e.kind === 'http' && e.from === `r::src/client.ts::${fn}`)!;
  assert.equal(http('a').meta?.method, 'GET');
  assert.equal(http('b').meta?.method, undefined);
  assert.equal(http('b').to, 'r::route::GET /items', 'the only route at the path');
  assert.equal(http('b').resolution?.confidence, 'MEDIUM');
  assert.equal(http('c').to, 'r::unknown::? /orders', 'two routes at the path: no pick, and the stub says the method is unknown');
});
