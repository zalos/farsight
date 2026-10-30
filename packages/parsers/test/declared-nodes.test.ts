import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import { configFilesText, configSchemaProblem } from '@farsight/core';
import type { FarsightConfig } from '@farsight/core';

function fixture(files: Record<string, string | object>) {
  const dir = mkdtempSync(join(tmpdir(), 'declared-nodes-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
const opts = { repoName: 'app', tests: false, design: false, stories: false };

test('ingest applies nested declarations with relative locations and handlers before reconciling specs', async () => {
  const dir = fixture({
    'nested/src/bridge.ts': 'export function relayInvoice() { return true; }',
    'src/bridge.ts': 'export function relayInvoice() { return false; }',
    'nested/farsight.config.json': {
      nodes: [
        {
          kind: 'route',
          name: 'POST /legacy',
          loc: 'src/bridge.ts:1',
          handler: 'src/bridge.ts::relayInvoice',
          guards: ['session'],
        },
        { kind: 'route', name: 'GET /without-location', guards: ['session'] },
        { kind: 'guard', name: 'session', tier: 'policy' },
      ],
    },
    'openapi.json': {
      openapi: '3.0.0',
      info: { title: 'Legacy', version: '1' },
      paths: {
        '/legacy': { post: { responses: { '200': { description: 'OK' } } } },
        '/without-location': { get: { responses: { '200': { description: 'OK' } } } },
      },
    },
  });
  try {
    const f = await ingestRepo(dir, opts);
    const route = f.nodes.find((n) => n.name === 'POST /legacy')!;
    assert.deepEqual(route.loc, { repo: 'app', path: 'nested/src/bridge.ts', line: 1 });
    assert.equal(route.contract?.status, 'both');
    assert.ok(route.contract?.drift?.some((d) => d.kind === 'security-declared-only'));
    const noLoc = f.nodes.find((n) => n.name === 'GET /without-location')!;
    assert.equal(noLoc.loc, undefined);
    assert.equal(noLoc.contract?.status, 'both');
    assert.equal(f.nodes.filter((n) => n.kind === 'route').length, 2);
    assert.ok(
      f.edges.some(
        (e) => e.kind === 'calls' && e.from === route.id && e.to === 'app::nested/src/bridge.ts::relayInvoice',
      ),
    );
    assert.ok(!f.edges.some((e) => e.kind === 'calls' && e.to === 'app::src/bridge.ts::relayInvoice'));
    assert.equal(f.edges.filter((e) => e.kind === 'guards').length, 2);
    assert.ok(f.meta?.config?.files[0]!.fields.includes('nodes'));
    assert.ok(!f.meta?.config?.notes.length, f.meta?.config?.notes.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an overlay-only source creates nodes even when the adapters found nothing, retaining workspace provenance', async () => {
  const dir = fixture({});
  const from = '.farsight/settings.json → sources[app].config';
  const config: FarsightConfig = {
    nodes: [
      { kind: 'guard', name: 'session', tier: 'policy' },
      { kind: 'route', name: 'POST /legacy', guards: ['session'], business: 'A supplier posts an invoice.' },
      { kind: 'external', name: 'Ledger' },
      { kind: 'queue', name: 'InvoicePosted' },
    ],
  };
  assert.equal(configSchemaProblem(config, 'source.config'), null);
  try {
    const f = await ingestRepo(dir, { ...opts, configOverlay: { from, config } });
    assert.equal(f.nodes.length, 4);
    assert.ok(f.nodes.every((n) => n.tags.includes('declared')));
    assert.ok(f.edges[0]!.resolution!.note!.includes(from));
    assert.equal(f.edges[0]!.resolution!.technique, 'annotation-scan');
    assert.equal(f.meta!.config!.files[0]!.from, 'workspace');
    assert.equal(f.meta!.config!.files[0]!.path, from);
    assert.match(configFilesText({ app: f.meta!.config! }, 'app', 'hud').join('\n'), /A supplier posts an invoice\./);
    assert.ok(!f.meta!.config!.notes.length);
    const disabled = await ingestRepo(dir, { ...opts, config: false, configOverlay: { from, config } });
    assert.equal(disabled.nodes.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each invalid reference is audited with file and line, or the overlay label without a line', async () => {
  const config: FarsightConfig = {
    nodes: [
      {
        kind: 'route',
        name: 'POST /legacy',
        loc: 'legacy/handlers.pl:40',
        handler: 'src/bridge.ts::missing',
        guards: ['unknown'],
      },
    ],
  };
  for (const overlay of [false, true]) {
    const dir = fixture({
      'src/bridge.ts': 'export function relayInvoice() {}',
      'legacy/handlers.pl': 'sub handler {}',
      ...(overlay ? {} : { 'farsight.config.json': config }),
    });
    const from = '.farsight/settings.json → sources[app].config';
    try {
      const f = await ingestRepo(dir, { ...opts, ...(overlay ? { configOverlay: { from, config } } : {}) });
      const notes = f.meta!.config!.notes;
      for (const field of ['loc', 'handler', 'guards']) {
        const note = notes.find((n) => n.includes(`→ nodes.${field}`));
        assert.ok(note, notes.join('\n'));
        if (overlay) assert.ok(note.startsWith(`${from} → nodes.${field}`), note);
        else assert.match(note, /^farsight\.config\.json:\d+ → nodes\./);
      }
      assert.equal(f.edges.length, 0);
      assert.equal(f.nodes.filter((n) => n.kind === 'guard').length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('declaring a reader route attaches by normalized method/path and keeps its original handler', async () => {
  const dir = fixture({
    'src/server.ts':
      "import express from 'express'; const app = express(); export function readInvoice(req, res) { res.json({}); } app.get('/invoices/:id', readInvoice);",
    'farsight.config.json': { nodes: [{ kind: 'route', name: 'GET /invoices/{id}', business: 'Read an invoice.' }] },
  });
  try {
    const f = await ingestRepo(dir, opts);
    const routes = f.nodes.filter((n) => n.kind === 'route');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.loc?.path, 'src/server.ts');
    assert.ok(routes[0]!.tags.includes('declared'));
    assert.ok(f.edges.some((e) => e.kind === 'calls' && e.from === routes[0]!.id && e.to.endsWith('::readInvoice')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('root declarations win overlay conflicts, with no second handler or lost workspace provenance', async () => {
  const root: FarsightConfig = {
    nodes: [{ kind: 'route', name: 'POST /invoice/{id}', handler: 'src/bridge.ts::first', business: 'Root words.' }],
  };
  const dir = fixture({
    'farsight.config.json': root,
    'src/bridge.ts': 'export function first() {}\nexport function second() {}',
  });
  const from = '.farsight/settings.json → sources[app].config';
  try {
    const f = await ingestRepo(dir, {
      ...opts,
      configOverlay: {
        from,
        config: {
          nodes: [
            { kind: 'route', name: 'POST /invoice/:id', handler: 'src/bridge.ts::second', business: 'Overlay words.' },
            { kind: 'queue', name: 'InvoicePosted' },
          ],
        },
      },
    });
    const routes = f.nodes.filter((n) => n.kind === 'route');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.facets!.business!.description, 'Root words.');
    assert.equal(f.edges.filter((e) => e.kind === 'calls' && e.from === routes[0]!.id).length, 1);
    assert.ok(f.edges.some((e) => e.kind === 'calls' && e.to.endsWith('::first')));
    assert.ok(f.meta!.config!.conflicts.some((c) => c.from === 'workspace' && c.kept === 'farsight.config.json'));
    assert.ok(f.nodes.some((n) => n.id === 'app::queue::InvoicePosted'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
