// A fetch whose init a helper builds: `fetch(url, helper(ctx, { method: 'POST', … }))`. The method
// literal sits in an object-literal argument of the helper call, not in fetch's own init; it is the
// method the code wrote and the call reaches that route — not the GET route of the same path (the
// regression the reference app reported on 2026-10-04: twelve false unreached-POST / undeclared-GET
// pairs). A verb-named helper (`post`, `put`, `patch`, `del`) says its method by name; a helper that
// says nothing stays *method assumed*, never a quiet GET.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo } from '../dist/index.js';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-helper-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const ingest = (files: Record<string, string>) =>
  ingestRepo(tempRepo({ 'package.json': '{"name":"h"}', ...files }), { repoName: 'h', openapi: false, design: false, tests: false });

/** GET and POST on one path, PUT / PATCH / DELETE on an item path. */
const SERVER = [
  "import express from 'express';",
  'const app = express();',
  "app.get('/api/v1/submissions', (req, res) => res.json([]));",
  "app.post('/api/v1/submissions', (req, res) => res.json({}));",
  "app.get('/api/v1/submissions/:id', (req, res) => res.json({}));",
  "app.put('/api/v1/submissions/:id', (req, res) => res.json({}));",
  "app.patch('/api/v1/submissions/:id', (req, res) => res.json({}));",
  "app.delete('/api/v1/submissions/:id', (req, res) => res.json({}));",
].join('\n');

const CLIENT = {
  'src/api/init.ts': [
    'export function apiInit(ctx: { token: string }, init: RequestInit): RequestInit {',
    '  return { ...init, headers: { authorization: ctx.token } };',
    '}',
    'export const base: RequestInit = { credentials: "include" };',
    'export const post = (ctx: { token: string }, body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });',
    'export const del = (ctx: { token: string }): RequestInit => ({ method: "DELETE" });',
    'export const withAuth = (ctx: { token: string }, init?: RequestInit): RequestInit => ({ ...init });',
    'export const json = (init: RequestInit): RequestInit => ({ ...init });',
  ].join('\n'),
  'src/api/submissions.ts': [
    "import { apiInit, base, post, del, withAuth, json } from './init';",
    'const ctx = { token: "t" };',
    // the exact shape the reference app reported
    "export function createSubmission(body: string) { return fetch('/api/v1/submissions', apiInit(ctx, { method: 'POST', body })); }",
    "export function listSubmissions() { return fetch('/api/v1/submissions', apiInit(ctx, { method: 'GET' })); }",
    // the literal beside a spread
    "export function createSpread(body: string) { return fetch('/api/v1/submissions', apiInit(ctx, { ...base, method: 'POST', body })); }",
    // one helper call inside another
    "export function putNested(id: string) { return fetch(`/api/v1/submissions/${id}`, withAuth(ctx, json({ method: 'PUT' }))); }",
    // verb-named helpers, no literal at the call
    "export function createByVerb(body: unknown) { return fetch('/api/v1/submissions', post(ctx, body)); }",
    "export function removeByVerb(id: string) { return fetch(`/api/v1/submissions/${id}`, del(ctx)); }",
    // negative: a helper with no literal and a name that is not a verb
    "export function unknownMethod(init: RequestInit) { return fetch('/api/v1/submissions', withAuth(ctx, init)); }",
  ].join('\n'),
};

const httpFrom = (g: Awaited<ReturnType<typeof ingest>>, fn: string) =>
  g.edges.filter((e) => e.kind === 'http' && e.from === `h::src/api/submissions.ts::${fn}`);

test('fetch(url, helper(ctx, { method: "POST" })) reaches the POST route, not the GET one at the same path', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [create] = httpFrom(g, 'createSubmission');
  assert.equal(create?.to, 'h::route::POST /api/v1/submissions');
  assert.equal(create?.meta?.method, 'POST');
  assert.equal(create?.meta?.methodAssumed, undefined, 'a method the code wrote is not assumed');
  assert.equal(create?.resolution?.confidence, 'HIGH');
  const [list] = httpFrom(g, 'listSubmissions');
  assert.equal(list?.to, 'h::route::GET /api/v1/submissions');
  assert.equal(list?.meta?.method, 'GET');
  assert.equal(list?.meta?.methodAssumed, undefined, 'a GET literal in the helper is a GET the code wrote');
});

test('the literal beside a spread, and one helper call inside another, keep their method', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [spread] = httpFrom(g, 'createSpread');
  assert.equal(spread?.to, 'h::route::POST /api/v1/submissions');
  const [nested] = httpFrom(g, 'putNested');
  assert.equal(nested?.to, 'h::route::PUT /api/v1/submissions/:id');
  assert.equal(nested?.meta?.method, 'PUT');
});

test('a verb-named helper with no literal says its method by name', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [byVerb] = httpFrom(g, 'createByVerb');
  assert.equal(byVerb?.to, 'h::route::POST /api/v1/submissions');
  assert.equal(byVerb?.meta?.method, 'POST');
  const [remove] = httpFrom(g, 'removeByVerb');
  assert.equal(remove?.to, 'h::route::DELETE /api/v1/submissions/:id');
});

test('a helper with no literal and a non-verb name stays method assumed — never a quiet GET', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [unknown] = httpFrom(g, 'unknownMethod');
  assert.equal(unknown?.meta?.method, undefined, 'the code does not say the method');
  assert.equal(unknown?.meta?.methodAssumed, 'GET');
  assert.equal(unknown?.to, 'h::route::GET /api/v1/submissions');
  assert.equal(unknown?.resolution?.confidence, 'MEDIUM');
  assert.deepEqual(unknown?.resolution?.candidates, ['h::route::POST /api/v1/submissions']);
});

test('a fetch wrapper whose init a helper builds: the helper\'s literal, else the caller\'s', async () => {
  const g = await ingest({
    'src/server.ts': SERVER,
    'src/api/init.ts': CLIENT['src/api/init.ts'],
    'src/api/http.ts': [
      "import { apiInit } from './init';",
      'const ctx = { token: "t" };',
      'export function apiFetch(path: string, init: RequestInit = {}) {',
      '  return fetch(`/api/v1${path}`, apiInit(ctx, { method: init.method, body: init.body }));',
      '}',
      'export function apiPost(path: string, body: string) {',
      "  return fetch(`/api/v1${path}`, apiInit(ctx, { method: 'POST', body }));",
      '}',
    ].join('\n'),
    'src/api/submissions.ts': [
      "import { apiFetch, apiPost } from './http';",
      "import { apiInit, post } from './init';",
      'const ctx = { token: "t" };',
      "export function viaParam() { return apiFetch('/submissions', { method: 'POST' }); }",
      "export function viaHelperLiteral() { return apiPost('/submissions', 'x'); }",
      "export function viaCallerHelper() { return apiFetch('/submissions', apiInit(ctx, { method: 'POST' })); }",
      "export function viaCallerVerb() { return apiFetch('/submissions', post(ctx, 1)); }",
    ].join('\n'),
  });
  for (const fn of ['viaParam', 'viaHelperLiteral', 'viaCallerHelper', 'viaCallerVerb']) {
    const [e] = httpFrom(g, fn);
    assert.equal(e?.to, 'h::route::POST /api/v1/submissions', fn);
    assert.equal(e?.meta?.method, 'POST', fn);
  }
});

// The invoice-app example's http edges, pinned as they were before this change: a helper-built
// init is new evidence, so an example that has none must come out the same.
test('the invoice-app example keeps its http edges', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const g = await ingestRepo(resolve(here, '../../../examples/invoice-app'), { repoName: 'invoice-app' });
  const http = g.edges.filter((e) => e.kind === 'http')
    .map((e) => `${e.meta?.method ?? '?'}${e.meta?.methodAssumed ? '~' : ''} ${e.from} -> ${e.to}`).sort();
  assert.deepEqual(http, INVOICE_HTTP);
});

const INVOICE_HTTP: string[] = [
  '? invoice-app::src/server/ocr.ts::AzureOcr.extract -> invoice-app::external::Azure Document Intelligence',
  'GET invoice-app::src/api/client.ts::getInvoice -> invoice-app::route::GET /invoices/:id',
  'GET invoice-app::src/api/client.ts::listInvoices -> invoice-app::route::GET /invoices',
  'PATCH invoice-app::src/api/client.ts::updateInvoice -> invoice-app::route::PATCH /invoices/:id',
  'POST invoice-app::src/api/client.ts::createInvoice -> invoice-app::route::POST /invoices',
  'POST invoice-app::src/api/client.ts::finalizeInvoice -> invoice-app::route::POST /invoices/:id/finalize',
  'POST invoice-app::src/server/erpClient.ts::ErpClient.request -> invoice-app::external::Example ERP',
];
