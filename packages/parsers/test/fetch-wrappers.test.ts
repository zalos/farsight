// Fetch wrappers: `apiFetch(path, init)` → `fetch(BASE + path, { method: init.method })`. The callers are
// the fetch sites — the path from their argument, the method from their literal — one or two levels
// deep; a call that names no method on a path several routes serve assumes GET and says so.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo } from '../dist/index.js';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-wrap-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const ingest = (files: Record<string, string>) =>
  ingestRepo(tempRepo({ 'package.json': '{"name":"w"}', ...files }), { repoName: 'w', openapi: false, design: false, tests: false });

/** The server: GET and POST on one path, a lone PATCH, nothing at /api/v1/missing. */
export const SERVER = [
  "import express from 'express';",
  'const app = express();',
  "app.get('/api/v1/ops/invoices', (req, res) => res.json([]));",
  "app.post('/api/v1/ops/invoices', (req, res) => res.json({}));",
  "app.patch('/api/v1/ops/invoices/:id', (req, res) => res.json({}));",
].join('\n');

/** The shared wrapper, the two-level helper, and the callers. */
export const CLIENT = {
  'src/api/http.ts': [
    "const BASE = '';",
    'export async function apiFetch(path: string, init: RequestInit = {}) {',
    '  const res = await fetch(`${BASE}${path}`, { method: init.method, headers: { a: "b" }, body: init.body });',
    '  return res.json();',
    '}',
    'export function request({ method, url }: { method: string; url: string }) {',
    '  return fetch(url, { method });',
    '}',
    'export const post = (path: string, body: unknown) => apiFetch(path, { method: "POST", body: JSON.stringify(body) });',
  ].join('\n'),
  'src/api/invoices.ts': [
    "import { apiFetch, request, post } from './http';",
    "export function listInvoices() { return apiFetch('/api/v1/ops/invoices', { method: 'GET' }); }",
    "export function createInvoice(body: string) { return apiFetch('/api/v1/ops/invoices', { method: 'POST', body }); }",
    "export function createViaPost(body: unknown) { return post('/api/v1/ops/invoices', body); }",
    "export function patchInvoice(id: string) { return request({ method: 'PATCH', url: `/api/v1/ops/invoices/${id}` }); }",
    "export function anyInvoices() { return apiFetch('/api/v1/ops/invoices'); }",
    "export function missing() { return apiFetch('/api/v1/missing', { method: 'GET' }); }",
  ].join('\n'),
};

const httpFrom = (g: Awaited<ReturnType<typeof ingest>>, fn: string) =>
  g.edges.filter((e) => e.kind === 'http' && e.from === `w::src/api/invoices.ts::${fn}`);

test('a wrapper with the literal method at the caller: GET and POST on one path reach their own routes', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [list] = httpFrom(g, 'listInvoices');
  const [create] = httpFrom(g, 'createInvoice');
  assert.equal(list?.to, 'w::route::GET /api/v1/ops/invoices');
  assert.equal(list?.meta?.method, 'GET');
  assert.equal(list?.meta?.wrapper, 'w::src/api/http.ts::apiFetch', 'the edge says which wrapper made the call');
  assert.equal(create?.to, 'w::route::POST /api/v1/ops/invoices');
  assert.equal(create?.resolution?.confidence, 'HIGH');
  const [patch] = httpFrom(g, 'patchInvoice');
  assert.equal(patch?.to, 'w::route::PATCH /api/v1/ops/invoices/:id', 'a destructured { method, url } wrapper');
  assert.equal(g.edges.some((e) => e.kind === 'http' && e.from.startsWith('w::src/api/http.ts::apiFetch')), false, 'the wrapper itself is no call site');
});

test('two levels: post(path) → apiFetch(path, { method: "POST" }) — the outer literal wins', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [viaPost] = httpFrom(g, 'createViaPost');
  assert.equal(viaPost?.to, 'w::route::POST /api/v1/ops/invoices');
  assert.equal(viaPost?.meta?.method, 'POST');
  assert.equal(viaPost?.meta?.wrapper, 'w::src/api/http.ts::post');
});

test('no literal at the caller on a path with GET and POST: GET assumed, flagged, the other route a candidate', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [any] = httpFrom(g, 'anyInvoices');
  assert.equal(any?.to, 'w::route::GET /api/v1/ops/invoices');
  assert.equal(any?.meta?.method, undefined, 'the method is still not claimed');
  assert.equal(any?.meta?.methodAssumed, 'GET');
  assert.equal(any?.meta?.candidates, 'w::route::POST /api/v1/ops/invoices');
  assert.deepEqual(any?.resolution?.candidates, ['w::route::POST /api/v1/ops/invoices']);
  assert.equal(any?.resolution?.confidence, 'MEDIUM');
  assert.equal(g.nodes.some((n) => n.kind === 'unknown' && n.name.startsWith('? ')), false, 'no `?` stub for a path a route serves');
});

test('a path no route serves is still a stub', async () => {
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const [miss] = httpFrom(g, 'missing');
  // the wrapper's `${BASE}` is a hole like the direct case's templated host: `:param/…`
  assert.equal(miss?.to, 'w::unknown::GET :param/api/v1/missing');
  assert.equal(miss?.resolution?.status, 'unresolved');
});

test('direct fetch is unchanged: a literal URL is its own site, a wrapper in a host-bound class keeps the externals path', async () => {
  const g = await ingest({
    'src/server.ts': SERVER,
    'src/a.ts': "export function a() { return fetch('/api/v1/ops/invoices', { method: 'POST' }); }",
    'src/hosts.ts': "export const ERP_HOST = 'https://erp.example.com';",
    'src/erp.ts': [
      "import { ERP_HOST } from './hosts';",
      'export class Erp {',
      '  readonly baseUrl: string;',
      '  constructor() { this.baseUrl = `${ERP_HOST}/v2`; }',
      "  list() { return this.request({ url: '/items', method: 'GET' }); }",
      '  private request(a: { url: string; method: string }) { return fetch(this.baseUrl + a.url, { method: a.method }); }',
      '}',
    ].join('\n'),
  });
  assert.equal(g.edges.find((e) => e.kind === 'http' && e.from === 'w::src/a.ts::a')?.to, 'w::route::POST /api/v1/ops/invoices');
  assert.equal(g.nodes.some((n) => n.kind === 'unknown'), false, 'the ERP client does not leak stubs for its own paths');
  assert.ok(g.edges.some((e) => e.kind === 'http' && e.to === 'w::external::erp.example.com'));
});

test('the journey says when a method was assumed: the call marker carries methodAssumed', async () => {
  const { buildIndex, journey, journeySummary, screensFor } = await import('@farsight/core');
  const g = await ingest({ 'src/server.ts': SERVER, ...CLIENT });
  const index = buildIndex(g.nodes, g.edges);
  const calls = (fn: string) => {
    const id = `w::src/api/invoices.ts::${fn}`;
    const sum = journeySummary(index, journey(index, id), screensFor(index, index.byId.get(id)!));
    return sum.segments.flatMap((sg) => sg.markers).filter((m) => m.kind === 'call');
  };
  assert.deepEqual(calls('anyInvoices').map((m) => [m.method, m.methodAssumed]), [['GET', 'GET']]);
  assert.deepEqual(calls('listInvoices').map((m) => [m.method, m.methodAssumed ?? null]), [['GET', null]], 'a GET the code names is not assumed');
});
