import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('api candidates and list use recorded metadata, filter by source and expose typed counts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'api-candidates-'));
  try {
    writeFileSync(
      join(cwd, 'graph.json'),
      JSON.stringify({
        version: 1,
        nodes: [],
        edges: [],
        meta: {
          openapi: {
            app: {
              applied: [],
              candidates: [
                { path: 'docs/vendor-api.json', title: 'Vendor API', version: '1.4', operations: 2, origin: 'file' },
              ],
            },
            other: { applied: [], candidates: [] },
          },
        },
      }),
    );
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'api', ...args], { cwd, encoding: 'utf8' });
    const json = run('candidates', '--repo', 'app', '--json');
    assert.equal(json.status, 0, json.stderr);
    const result = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(result), ['app']);
    assert.equal(result.app.candidates[0].operations, 2);
    assert.equal(result.app.counts.candidates.n, 1);
    assert.equal(result.app.counts.candidates.scope, 'count.scope.source');
    assert.equal(result.app.counts.operations['docs/vendor-api.json'].scope, 'count.scope.document');
    assert.match(run('candidates').stdout, /farsight api register 'app' 'docs\/vendor-api.json'/);
    assert.match(run('list').stdout, /Vendor API 1.4/);
    for (const command of ['candidates', 'list']) {
      const empty = run(command, '--repo', 'other');
      assert.equal(empty.status, 0, empty.stderr);
      assert.match(empty.stdout, /0 candidate documents/);
      assert.doesNotMatch(empty.stdout, /Sync the sources/);
      const missing = run(command, '--repo', 'missing');
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /No such source: missing/);
    }
    assert.notEqual(run('candidates', '--repo', 'missing', '--json').status, 0);
    writeFileSync(join(cwd, 'graph.json'), JSON.stringify({ version: 1, nodes: [], edges: [] }));
    assert.match(run('candidates').stdout, /Sync the sources to discover them/);
    assert.deepEqual(JSON.parse(run('candidates', '--json').stdout), {
      message: run('candidates').stdout.trim(),
      next: 'POST /api/sync',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('api register/dismiss round-trip workspace settings without requiring a graph; source writes are explicit', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'api-registration-'));
  try {
    mkdirSync(join(cwd, '.farsight'));
    mkdirSync(join(cwd, 'source'));
    const file = join(cwd, '.farsight/settings.json');
    const configFile = join(cwd, 'source/farsight.config.json');
    writeFileSync(configFile, JSON.stringify({ glossary: { hello: 'Hello' } }));
    writeFileSync(
      file,
      JSON.stringify({
        defaultLens: 'hybrid',
        collections: [],
        sources: [
          { id: 'app-id', name: 'app', type: 'local', path: 'source', enabled: true, exclude: ['generated/**'] },
          { id: 'other', name: 'other', type: 'local', path: 'other', enabled: false },
        ],
      }),
    );
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'api', ...args], { cwd, encoding: 'utf8' });
    const settings = () => JSON.parse(readFileSync(file, 'utf8'));
    const initialConfig = readFileSync(configFile, 'utf8');
    let r = run('register', 'app', 'docs/vendor-api.json', '--name', 'Vendor API', '--phase', 'preview');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(settings().sources[0].openapi, [
      { path: 'docs/vendor-api.json', name: 'Vendor API', phase: 'preview' },
    ]);
    assert.equal(readFileSync(configFile, 'utf8'), initialConfig);
    assert.deepEqual(settings().sources[0].exclude, ['generated/**']);
    r = run('dismiss', 'app-id', 'docs/vendor-api.json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(Object.hasOwn(settings().sources[0], 'openapi'), false);
    assert.deepEqual(settings().sources[0].openapiIgnore, ['docs/vendor-api.json']);
    assert.equal(run('dismiss', 'app', 'docs/vendor-api.json').status, 0);
    assert.deepEqual(settings().sources[0].openapiIgnore, ['docs/vendor-api.json']);
    assert.equal(run('register', 'app', 'docs/vendor-api.json').status, 0);
    assert.deepEqual(settings().sources[0].openapiIgnore, []);
    assert.equal(run('register', 'app', 'https://example.com/openapi.json', '--name', 'Remote').status, 0);
    assert.equal(settings().sources[0].openapi[1].url, 'https://example.com/openapi.json');
    const before = readFileSync(file, 'utf8');
    for (const args of [
      ['register', 'missing', 'docs/vendor.json'],
      ['register', 'app', '../outside.json'],
      ['dismiss', 'app', '/outside.json'],
      ['register', 'app', 'ftp://example.com/spec.json'],
    ]) {
      assert.notEqual(run(...args).status, 0, args.join(' '));
      assert.equal(readFileSync(file, 'utf8'), before);
    }
    assert.equal(run('dismiss', 'app', 'docs/shared.json').status, 0);
    const dismissedSettings = readFileSync(file, 'utf8');
    r = run('register', '--into-source', 'app', 'docs/shared.json', '--phase', 'release');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), {
      glossary: { hello: 'Hello' },
      openapi: [{ path: 'docs/shared.json', phase: 'release' }],
    });
    assert.equal(readFileSync(file, 'utf8'), dismissedSettings);
    writeFileSync(configFile, '{broken');
    assert.notEqual(run('register', 'app', 'docs/shared.json', '--into-source').status, 0);
    assert.equal(readFileSync(configFile, 'utf8'), '{broken');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('api candidates distinguishes a known source without inventory from an unknown source', async () => {
  const { ingestRepo } = await import('@farsight/parsers');
  const { GraphStore } = await import('@farsight/core');
  const cwd = mkdtempSync(join(tmpdir(), 'api-no-inventory-'));
  try {
    const root = join(cwd, 'source');
    mkdirSync(root);
    writeFileSync(join(root, 'app.ts'), 'export function hello() { return true; }');
    const store = new GraphStore();
    store.addFragment(await ingestRepo(root, { repoName: 'without-specs', openapi: false }));
    store.addFragment({
      repo: 'with-specs',
      nodes: [],
      edges: [],
      meta: {
        files: 0,
        sourceHash: '',
        openapi: { applied: [], candidates: [] },
      },
    });
    store.save(join(cwd, 'graph.json'));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'api', ...args], { cwd, encoding: 'utf8' });
    for (const command of ['candidates', 'list']) {
      const result = run(command, '--repo', 'without-specs');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No OpenAPI inventory recorded for without-specs/);
      assert.doesNotMatch(result.stdout, /No such source|0 candidate documents/);
    }
    assert.deepEqual(JSON.parse(run('candidates', '--repo', 'without-specs', '--json').stdout), {
      source: 'without-specs',
      message: run('candidates', '--repo', 'without-specs').stdout.trim(),
      next: 'POST /api/sync',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('api dismiss refuses a document applied at the last sync without changing settings', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'api-applied-'));
  try {
    mkdirSync(join(cwd, '.farsight'));
    const file = join(cwd, '.farsight/settings.json');
    writeFileSync(
      file,
      JSON.stringify({
        defaultLens: 'hybrid',
        collections: [],
        sources: [{ id: 'app-id', name: 'app', type: 'local', path: 'source', enabled: true }],
      }),
    );
    const before = readFileSync(file, 'utf8');
    writeFileSync(
      join(cwd, 'graph.json'),
      JSON.stringify({
        version: 1,
        nodes: [],
        edges: [],
        meta: {
          openapi: {
            app: {
              candidates: [],
              applied: [
                { path: 'openapi.yaml', title: 'App', version: '1', operations: 1, origin: 'file' },
                { path: 'docs/declared.json', title: 'Declared', version: '1', operations: 1, origin: 'config' },
              ],
            },
          },
        },
      }),
    );
    for (const path of ['openapi.yaml', 'docs/declared.json']) {
      const result = spawnSync(process.execPath, [cli, 'api', 'dismiss', 'app-id', path], { cwd, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /The repository applies .*; it cannot be dismissed as a candidate/);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
