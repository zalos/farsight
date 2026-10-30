import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('config export prints a merged root without writing, and writes only with --into-source', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'farsight-config-export-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.farsight'));
  mkdirSync(join(cwd, 'source', 'nested'), { recursive: true });
  const file = join(cwd, '.farsight/settings.json');
  const configFile = join(cwd, 'source/farsight.config.json');
  const repository = {
    $schema: 'https://example.com/config.schema.json',
    glossary: { submit: { label: 'Repository word' } },
    tags: { billing: ['invoice'] },
    openapi: [{ path: 'api.yaml', name: 'Repository API' }],
    tests: { include: ['test/*.ts'] },
    frameworks: { spring: { security: { RootPolicy: { label: 'Root' } } } },
  };
  writeFileSync(configFile, JSON.stringify(repository));
  writeFileSync(
    join(cwd, 'source/nested/farsight.config.json'),
    JSON.stringify({ glossary: { nested: { label: 'Nested only' } } }),
  );
  const overlay = {
    glossary: { submit: { label: 'Workspace word' }, approve: { label: 'Approve invoice' } },
    tags: { billing: ['invoice', 'approval'] },
    frameworks: { spring: { security: { WorkspacePolicy: { label: 'Workspace' } } } },
    patterns: [
      {
        id: 'route',
        files: ['*.ts'],
        match: { call: 'portal.get' },
        emit: { kind: 'route', method: 'GET', path: '/invoices' },
      },
    ],
  };
  const settings = {
    sources: [
      {
        id: 'source-id',
        name: 'App',
        type: 'local',
        path: 'source',
        config: overlay,
        openapi: [
          { path: 'api.yaml', name: 'Duplicate' },
          { path: 'docs/new.yaml', phase: 'draft' },
        ],
        openapiIgnore: ['docs/old.yaml'],
      },
      {
        id: 'other',
        name: 'Other',
        type: 'local',
        path: 'other',
        config: { glossary: { other: { label: 'Other source' } } },
      },
    ],
  };
  writeFileSync(file, JSON.stringify(settings));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'config', 'export', ...args], { cwd, encoding: 'utf8' });
  const before = readFileSync(file, 'utf8');
  const json = run('source-id');
  assert.equal(json.status, 0, json.stderr);
  const exported = JSON.parse(json.stdout);
  assert.equal(exported.glossary.submit.label, 'Repository word');
  assert.equal(exported.glossary.approve.label, 'Approve invoice');
  assert.equal(exported.glossary.nested, undefined);
  assert.equal(exported.glossary.other, undefined);
  assert.deepEqual(exported.tags.billing, ['invoice', 'approval']);
  assert.deepEqual(exported.openapi, [
    { path: 'api.yaml', name: 'Repository API' },
    { path: 'docs/new.yaml', phase: 'draft' },
  ]);
  assert.deepEqual(exported.tests, repository.tests);
  assert.deepEqual(Object.keys(exported.frameworks.spring.security), ['RootPolicy', 'WorkspacePolicy']);
  assert.equal(exported.openapiIgnore, undefined);
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), repository);
  assert.equal(readFileSync(file, 'utf8'), before);
  const written = run('App', '--into-source');
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(configFile, 'utf8'), written.stdout);
  assert.deepEqual(JSON.parse(written.stdout), exported);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(run('missing').status, 1);
  assert.equal(run().status, 1);
  assert.equal(run('source-id', 'extra').status, 1);
  writeFileSync(configFile, '{invalid');
  assert.equal(run('source-id', '--into-source').status, 1);
  assert.equal(readFileSync(configFile, 'utf8'), '{invalid');
  rmSync(configFile);
  const outside = join(cwd, 'outside.json');
  writeFileSync(outside, '{}');
  symlinkSync(outside, configFile);
  assert.equal(run('source-id', '--into-source').status, 1);
  assert.equal(readFileSync(outside, 'utf8'), '{}');
});
