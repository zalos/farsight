import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FIELDS, CONFIG_OVERLAY_FIELDS, configSchema, type FarsightConfig } from '@farsight/core';
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
  assert.ok(
    !graph.meta?.config?.conflicts.some((c) => c.kind === 'field' && (c.key === 'tags' || c.key === 'glossary')),
    'matcher blocks keep their per-file rules instead of becoming whole-block conflicts',
  );
  assert.ok(graph.meta?.config?.notes.some((s) => s.includes(from) && s.includes('missing')));
  assert.equal(configOverlay.config.glossary.submit.label, 'Workspace submission', 'the caller is not mutated');
  assert.equal(readFileSync(join(dir, 'farsight.config.json'), 'utf8'), before, 'the source is never rewritten');
});

test('workspace declaration audits match the whole source and give no invented line numbers', async (t) => {
  const dir = fixture(t, {
    'src/main.ts':
      'export function submit() { return 1; }\n/** @guard */\nexport function requireSession() { return true; }',
    'src/nested/start.ts': 'export function boot() { return 2; }',
  });
  const configOverlay = {
    from,
    config: {
      glossary: { submit: { label: 'Submit work' }, missingGlossary: { label: 'Missing' } },
      gateTiers: { requireSession: 'policy', missingGate: 'policy' },
      setup: ['boot', 'missingSetup'],
    } satisfies FarsightConfig,
  };
  const graph = await ingestRepo(dir, { repoName: 'app', configOverlay });
  assert.equal(graph.nodes.find((n) => n.name === 'submit')?.facets?.business?.label, 'Submit work');
  assert.deepEqual(graph.nodes.find((n) => n.name === 'requireSession')?.gateTier, { tier: 'policy', from: 'config' });
  assert.ok(graph.nodes.find((n) => n.name === 'boot')?.tags.includes('setup'));
  const warnings = [
    `${from} → glossary: "missingGlossary" matches no indexed symbol name.`,
    `${from} → gateTiers: "missingGate" matches no indexed gate.`,
    `${from} → setup: "missingSetup" matches no indexed symbol.`,
  ];
  assert.deepEqual(graph.meta?.config?.notes, warnings);
  assert.deepEqual(graph.specErrors, warnings);
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

test('overlay blocks without a field-specific merger reach merged; repository blocks keep precedence', (t) => {
  const dir = fixture(t, {});
  const config: FarsightConfig = {
    lifecycle: { orders: { views: { operator: { Draft: ['draft'] } } } },
    decisions: [{ id: 'review-policy', title: 'Review policy' }],
    validators: ['readMultipart'],
    internalRoutes: ['GET /health'],
  };
  const overlayOnly = loadWorkspaceConfig(dir, { configOverlay: { from, config } });
  assert.deepEqual(overlayOnly.merged, config);
  assert.deepEqual(overlayOnly.meta.conflicts, []);

  const root: FarsightConfig = { lifecycle: { orders: { views: { operator: { Sent: ['sent'] } } } } };
  writeFileSync(join(dir, 'farsight.config.json'), JSON.stringify(root));
  const withRoot = loadWorkspaceConfig(dir, { configOverlay: { from, config } });
  assert.deepEqual(withRoot.merged, { ...config, ...root });
  assert.deepEqual(withRoot.meta.conflicts, [
    {
      kind: 'lifecycle',
      key: 'orders',
      files: ['farsight.config.json', from],
      kept: 'farsight.config.json',
      from: 'workspace',
    },
  ]);
  assert.deepEqual(
    config.lifecycle,
    { orders: { views: { operator: { Draft: ['draft'] } } } },
    'the supplied overlay stays intact',
  );
});

test('future overlay maps, lists and scalars merge without a field-specific case', (t) => {
  const dir = fixture(t, {});
  // Lane A adds frameworks to the config contract. Extend only discovery's field catalog here
  // so the current build can read the future root declaration; the merger receives no new case.
  const fields = CONFIG_FIELDS as readonly string[] as string[];
  const length = fields.length;
  t.after(() => {
    fields.length = length;
  });
  const futureFields = ['futureScalar', 'futureMap', 'futureList'];
  fields.push(...['frameworks', ...futureFields].filter((key) => !fields.includes(key)));
  const overlayFields = CONFIG_OVERLAY_FIELDS as readonly string[] as string[];
  const overlayLength = overlayFields.length;
  t.after(() => {
    overlayFields.length = overlayLength;
  });
  overlayFields.push(...futureFields);
  const config = {
    frameworks: { nest: { verbs: { JsonGet: 'GET' } } },
    futureScalar: 'workspace',
    futureMap: { shared: 'workspace', workspaceOnly: true, identical: 'same' },
    futureList: ['workspace', { name: 'shared' }, 'workspace', { name: 'shared' }],
  } as FarsightConfig;
  const overlayOnly = loadWorkspaceConfig(dir, { configOverlay: { from, config } });
  assert.deepEqual(overlayOnly.merged, { ...config, futureList: ['workspace', { name: 'shared' }] });
  assert.deepEqual(overlayOnly.meta.conflicts, []);

  const root = {
    frameworks: { nest: { verbs: { JsonGet: 'POST' } } },
    futureScalar: 'repository',
    futureMap: { shared: 'repository', repositoryOnly: true, identical: 'same' },
    futureList: ['repository', { name: 'shared' }],
  } as FarsightConfig;
  writeFileSync(join(dir, 'farsight.config.json'), JSON.stringify(root));
  const withRoot = loadWorkspaceConfig(dir, { configOverlay: { from, config } });
  assert.deepEqual(withRoot.merged, {
    ...root,
    futureMap: { shared: 'repository', repositoryOnly: true, workspaceOnly: true, identical: 'same' },
    futureList: ['repository', { name: 'shared' }, 'workspace'],
  });
  assert.deepEqual(
    withRoot.meta.conflicts,
    ['frameworks.nest', 'futureScalar', 'futureMap.shared'].map((key) => ({
      kind: 'field',
      key,
      files: ['farsight.config.json', from],
      kept: 'farsight.config.json',
      from: 'workspace',
    })),
  );
});

test('root-scoped overlay validators apply while a nested file reports them as ignored', async (t) => {
  const nested = 'app/farsight.config.json';
  const dir = fixture(t, {
    [nested]: { validators: ['readMultipart'] },
    'lib/readers.ts': 'export function readMultipart(req: Request) { return req.formData(); }',
    'app/api/upload/route.ts':
      'import { readMultipart } from "../../../lib/readers";\nexport async function POST(req: Request) { return readMultipart(req); }',
    'openapi.json': {
      openapi: '3.1.0',
      paths: {
        '/api/upload': {
          post: { requestBody: { required: true, content: { 'multipart/form-data': {} } } },
        },
      },
    },
  });
  const withoutOverlay = await ingestRepo(dir, { repoName: 'app' });
  const routeBefore = withoutOverlay.nodes.find((n) => n.id === 'app::route::POST /api/upload');
  assert.ok(routeBefore?.contract?.drift?.some((d) => d.kind === 'body-unvalidated'));

  const graph = await ingestRepo(dir, {
    repoName: 'app',
    configOverlay: { from, config: { validators: ['readMultipart'] } },
  });
  const route = graph.nodes.find((n) => n.id === 'app::route::POST /api/upload');
  assert.equal(route?.contract?.status, 'both');
  assert.deepEqual(route?.contract?.drift ?? [], []);
  assert.ok(graph.edges.some((e) => e.kind === 'calls' && e.to.endsWith('::readMultipart')));
  const meta = graph.meta!.config!;
  assert.deepEqual(
    meta.files.find((f) => f.path === from),
    {
      path: from,
      dir: '.',
      root: false,
      from: 'workspace',
      fields: ['validators'],
      ignored: [],
    },
  );
  assert.deepEqual(meta.files.find((f) => f.path === nested)?.ignored, ['validators']);
  assert.ok(meta.notes.includes(`validators is root-only; ${nested}'s was ignored.`));
  assert.ok(!meta.notes.some((note) => note.includes(from) && note.includes('root-only')));
});

test('overlay works without a root file and config:false disables it', async (t) => {
  const dir = fixture(t, { 'src/main.ts': 'export function submit() { return 1; }' });
  const configOverlay = { from, config: { glossary: { submit: { label: 'Submit work' } } } };
  const graph = await ingestRepo(dir, { repoName: 'app', configOverlay });
  assert.equal(graph.nodes.find((n) => n.name === 'submit')?.facets?.business?.label, 'Submit work');
  assert.equal(graph.meta?.config?.files[0]?.path, from);
  assert.deepEqual(loadWorkspaceConfig(dir, { configOverlay, config: false }).files, []);
});

test('every supported overlay field reaches merged config', (t) => {
  const dir = fixture(t, {});
  for (const field of CONFIG_OVERLAY_FIELDS.filter((f) => (CONFIG_FIELDS as readonly string[]).includes(f))) {
    const schema = configSchema.properties as Record<string, { type?: string }>;
    const value = schema[field]?.type === 'array' ? [] : {};
    const ws = loadWorkspaceConfig(dir, { configOverlay: { from, config: { [field]: value } as FarsightConfig } });
    assert.ok(Object.hasOwn(ws.merged, field), field);
    assert.deepEqual((ws.merged as Record<string, unknown>)[field], value, field);
  }
});

test('hand-edited overlays ignore path blocks, unknown fields and editor metadata', (t) => {
  const dir = fixture(t, {});
  const ws = loadWorkspaceConfig(dir, {
    configOverlay: {
      from,
      config: {
        design: [{ manifest: '/etc/hosts' }],
        validators: ['reader'],
        unknown: {},
        $schema: 'editor',
        '//note': 'note',
      } as FarsightConfig,
    },
  });
  assert.deepEqual(ws.merged, { validators: ['reader'] });
  assert.deepEqual(ws.meta.files[0]?.ignored, ['design', 'unknown']);
  assert.deepEqual(ws.meta.files[0]?.fields, ['validators']);
  assert.ok(ws.meta.notes.every((n) => n.includes(from)));
  assert.equal(ws.meta.notes.length, 2);
});

test('gate tiers, lifecycle and decisions retain root declarations with domain conflicts', (t) => {
  const root: FarsightConfig = {
    gateTiers: { check: 'business' },
    lifecycle: { orders: { views: { staff: { Draft: ['draft'] } } } },
    decisions: [{ id: 'policy', title: 'Repository policy', state: 'decided' }],
  };
  const dir = fixture(t, { 'farsight.config.json': root });
  const ws = loadWorkspaceConfig(dir, {
    configOverlay: {
      from,
      config: {
        gateTiers: { check: 'technical' },
        lifecycle: { orders: { views: { staff: { New: ['draft'] } } } },
        decisions: [{ id: 'policy', title: 'Workspace policy', state: 'open' }],
      },
    },
  });
  assert.deepEqual(ws.merged, root);
  assert.deepEqual(
    ws.meta.conflicts.map((c) => [c.kind, c.key, c.from, c.kept]),
    [
      ['gateTier', 'check', 'workspace', 'farsight.config.json'],
      ['lifecycle', 'orders', 'workspace', 'farsight.config.json'],
      ['decision', 'policy', 'workspace', 'farsight.config.json'],
    ],
  );
});

test('a nested glossary word marks the losing workspace declaration', (t) => {
  const nested = 'src/farsight.config.json';
  const dir = fixture(t, { [nested]: { glossary: { submit: { label: 'Nested word' } } } });
  const ws = loadWorkspaceConfig(dir, {
    configOverlay: { from, config: { glossary: { submit: { label: 'Workspace word' } } } },
  });
  assert.deepEqual(ws.meta.conflicts, [
    { kind: 'glossary', key: 'submit', files: [from, nested], kept: nested, from: 'workspace' },
  ]);
});
