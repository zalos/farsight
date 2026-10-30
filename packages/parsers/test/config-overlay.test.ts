import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo, loadWorkspaceConfig } from '../dist/index.js';

const from = '.farsight/settings.json → sources[app].config';
function fixture(t: { after: (fn: () => void) => void }, files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('workspace overlay is root-scoped, listed, audited and subordinate to repository words', async (t) => {
  const dir = fixture(t, {
    'src/main.ts': 'export function submit() { return 1; }',
    'src/nested/other.ts': 'export function submit() { return 2; }',
    'farsight.config.json': { glossary: { submit: { label: 'Repository submission' } }, tags: { repo: ['submit'] } },
    'src/nested/farsight.config.json': { glossary: { submit: { label: 'Nested submission' } } },
  });
  const before = readFileSync(join(dir, 'farsight.config.json'), 'utf8');
  const configOverlay = {
    from,
    config: {
      glossary: { submit: { label: 'Workspace submission' }, missing: { label: 'Missing function' } },
      tags: { workspace: ['submit'] },
    },
  };
  const graph = await ingestRepo(dir, { repoName: 'app', configOverlay });
  assert.equal(
    graph.nodes.find((n) => n.name === 'submit' && n.loc?.path === 'src/main.ts')?.facets?.business?.label,
    'Repository submission',
  );
  assert.equal(
    graph.nodes.find((n) => n.name === 'submit' && n.loc?.path === 'src/nested/other.ts')?.facets?.business?.label,
    'Nested submission',
  );
  assert.ok(
    graph.nodes
      .filter((n) => n.name === 'submit')
      .every((n) => n.tags.includes('workspace') && n.tags.includes('repo')),
  );
  assert.deepEqual(
    graph.meta?.config?.files.map((f) => f.path),
    ['farsight.config.json', from, 'src/nested/farsight.config.json'],
  );
  assert.equal(graph.meta?.config?.files[1]?.from, 'workspace');
  assert.equal(graph.meta?.config?.files[1]?.dir, '.');
  assert.equal(graph.meta?.config?.files[1]?.root, false);
  assert.ok(
    graph.meta?.config?.conflicts.some(
      (c) => c.kind === 'glossary' && c.key === 'submit' && c.kept === 'farsight.config.json' && c.from === 'workspace',
    ),
  );
  assert.ok(graph.meta?.config?.notes.some((s) => s.includes(from) && s.includes('missing')));
  assert.equal(configOverlay.config.glossary.submit.label, 'Workspace submission', 'the caller is not mutated');
  assert.equal(readFileSync(join(dir, 'farsight.config.json'), 'utf8'), before, 'the source is never rewritten');
});

test('overlay lists union and duplicate externals/stores keep the root declaration', (t) => {
  const dir = fixture(t, {
    'farsight.config.json': {
      setup: ['boot'],
      validators: ['validate'],
      internalRoutes: ['GET /health'],
      externals: [{ import: 'vendor', name: 'Repo vendor', kind: 'other' }],
      stores: [{ name: 'DB', kind: 'sql', engine: 'postgres' }],
    },
  });
  const ws = loadWorkspaceConfig(dir, {
    configOverlay: {
      from,
      config: {
        setup: ['boot', 'start'],
        validators: ['validate', 'check'],
        internalRoutes: ['GET /health', 'GET /ready'],
        externals: [
          { import: 'vendor', name: 'Workspace vendor', kind: 'other' },
          { import: 'new-sdk', name: 'New', kind: 'other' },
        ],
        stores: [
          { name: 'DB', kind: 'document' },
          { name: 'Files', kind: 'files' },
        ],
      },
    },
  });
  assert.deepEqual(ws.merged.setup, ['boot', 'start']);
  assert.deepEqual(ws.merged.validators, ['validate', 'check']);
  assert.deepEqual(ws.merged.internalRoutes, ['GET /health', 'GET /ready']);
  assert.deepEqual(
    ws.merged.externals?.map((e) => e.name),
    ['Repo vendor', 'New'],
  );
  assert.deepEqual(
    ws.merged.stores?.map((s) => s.name),
    ['DB', 'Files'],
  );
  assert.deepEqual(
    ws.meta.conflicts.map((c) => [c.kind, c.from, c.kept]),
    [
      ['external', 'workspace', 'farsight.config.json'],
      ['store', 'workspace', 'farsight.config.json'],
    ],
  );
});

test('overlay works without a root file and config:false disables it', async (t) => {
  const dir = fixture(t, { 'src/main.ts': 'export function submit() { return 1; }' });
  const configOverlay = { from, config: { glossary: { submit: { label: 'Submit work' } } } };
  const graph = await ingestRepo(dir, { repoName: 'app', configOverlay });
  assert.equal(graph.nodes.find((n) => n.name === 'submit')?.facets?.business?.label, 'Submit work');
  assert.equal(graph.meta?.config?.files[0]?.path, from);
  assert.deepEqual(loadWorkspaceConfig(dir, { configOverlay, config: false }).files, []);
});
