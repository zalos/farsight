import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const M = await import(fileURLToPath(new URL('../public/app/lib/settings-model.js', import.meta.url)));

const loaded = () => ({
  theme: 'dark',
  sources: [{ id: 'a', name: 'App', type: 'local', path: '.', enabled: true }],
  collections: [],
});
test('a theme save preserves concurrent registration, dismissal, overlay and lessons', () => {
  const base = loaded();
  const draft = { ...M.clone(base), theme: 'light' };
  const current = M.clone(base);
  Object.assign(current.sources[0], {
    openapi: [{ path: 'api.yml' }],
    openapiIgnore: ['old.yml'],
    config: { glossary: { App: { label: 'Application' } } },
  });
  current.lessons = [{ text: 'Read the gates', pinned: true }];
  assert.deepEqual(M.mergeSettings(base, draft, current), { ...current, theme: 'light' });
  assert.equal(M.dirty(base, draft), true);
  assert.equal(M.needsSync(base, draft), false);
});
test('source identity, nested field edits, deletions, additions and reorder survive concurrent writes', () => {
  const base = loaded();
  base.sources.push({ ...base.sources[0], id: 'b' });
  base.sources[0].storybook = { url: 'http://localhost:6006', command: 'old' };
  const draft = M.clone(base);
  draft.sources.reverse();
  draft.sources[1].storybook.command = 'new';
  delete draft.sources[1].path;
  const current = M.clone(base);
  current.sources[0].storybook.url = 'http://localhost:6007';
  current.sources[0].openapi = [{ path: 'api.yml' }];
  current.sources.push({ ...base.sources[1], id: 'c' });
  const merged = M.mergeSettings(base, draft, current);
  assert.deepEqual(
    merged.sources.map((s: { id: string }) => s.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(merged.sources[1].storybook, { url: 'http://localhost:6007', command: 'new' });
  assert.deepEqual(merged.sources[1].openapi, [{ path: 'api.yml' }]);
  assert.equal('path' in merged.sources[1], false);
  assert.equal(M.needsSync(base, merged), true);
});
test('untouched deleted sources stay deleted; explicit source removals win', () => {
  const base = loaded();
  const draft = M.clone(base);
  draft.sources.push({ ...draft.sources[0], id: 'new' });
  assert.deepEqual(
    M.mergeSettings(base, draft, { ...base, sources: [] }).sources.map((s: { id: string }) => s.id),
    ['new'],
  );
  draft.sources = [];
  assert.deepEqual(M.mergeSettings(base, draft, base).sources, []);
});
test('dirty is semantic and moving rows is bounded', () => {
  assert.equal(M.dirty({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  const rows = ['a', 'b'];
  M.editRows(rows, 'up', 0);
  M.editRows(rows, 'down', 0);
  assert.deepEqual(rows, ['b', 'a']);
  M.editRows(rows, 'remove', 1);
  M.editRows(rows, 'add', 0, 'c');
  assert.deepEqual(rows, ['b', 'c']);
});
test('all sections and type-specific fields are explicit; secrets are references only', () => {
  assert.deepEqual(
    M.sections.map((s: { id: string }) => s.id),
    ['workspace', 'sources', 'collections', 'configuration', 'agents'],
  );
  assert.ok(M.sourceFields.work.includes('auth.secret'));
  assert.ok(!M.sourceFields.design.includes('exclude'));
  assert.equal(M.secretReference('pasted-value'), '');
  assert.equal(M.secretReference('env:EXAMPLE_TOKEN'), 'env:EXAMPLE_TOKEN');
  assert.equal(M.secretReference('keychain:farsight/example'), 'keychain:farsight/example');
});

test('unsupported overlay fields use both running-build capability lists', () => {
  const settings = {
    sources: [{ name: 'App', config: { glossary: {}, patterns: [], tests: {}, $schema: 'example' } }],
  };
  assert.deepEqual(
    M.unavailableFields(settings, { configFields: ['glossary', 'tests'], overlayFields: ['glossary', 'patterns'] }),
    [
      { source: 'App', field: 'patterns', path: 'sources[0].config.patterns' },
      { source: 'App', field: 'tests', path: 'sources[0].config.tests' },
    ],
  );
});

test('restoring absent defaults or clearing optional lists restores the saved meaning', () => {
  const base = { sources: [{ id: 'app', name: 'App', type: 'local', path: '.' }] };
  const draft = {
    ...M.clone(base),
    theme: 'system',
    flags: { designShots: false },
    mcp: { tools: 'core' },
    collections: [],
    lessons: [],
  };
  (draft.sources[0] as any).exclude = [];
  assert.equal(M.dirty(base, draft), false);
  const current = { ...M.clone(base), theme: 'light' };
  assert.deepEqual(M.mergeSettings(base, draft, current), current);
  draft.flags.designShots = true;
  assert.equal(M.dirty(base, draft), true);
});
test('missing build capabilities are unknown, not unsupported', () => {
  const settings = { sources: [{ name: 'App', config: { glossary: {} } }] };
  assert.deepEqual(M.unavailableFields(settings), []);
  assert.deepEqual(M.unavailableFields(settings, {}), []);
});
test('new source ids are name slugs and changing type drops hidden connection fields', () => {
  assert.equal(M.sourceId('Billing API', []), 'billing-api');
  assert.equal(M.sourceId('Billing API', [{ id: 'billing-api' }]), 'billing-api-2');
  const source = {
    id: 'app',
    name: 'App',
    type: 'work',
    auth: { secret: 'env:TOKEN' },
    permissions: { grants: [] },
    site: 'example',
    mode: 'edit',
  };
  M.changeSourceType(source, 'local');
  assert.deepEqual(source, { id: 'app', name: 'App', type: 'local' });
});
test('Settings counts name their saved inputs and partition lessons', () => {
  const lessons = M.lessonsCounted([{ pinned: true }, { pinned: false }]);
  assert.equal(lessons.all.n, 2);
  assert.equal(lessons.pinned.n, 1);
  assert.equal(
    lessons.all.breakdown.reduce((n: number, p: { n: number }) => n + p.n, 0),
    2,
  );
  const status = M.sourceStatus({
    enabled: true,
    status: 'ok: 12 nodes, 9 edges · 4 commits read into history · 1 ingested by a sync · 3 not yet · 2 new this sync',
  });
  assert.equal(status.key, 'settings.status.ok');
  assert.deepEqual(
    status.counts.map((c: { n: number }) => c.n),
    [12, 9, 4, 1, 3, 2],
  );
});

test('work sync status retains typed totals and cache failures keep their reason', () => {
  const synced = M.sourceStatus({
    enabled: true,
    status: 'ok: 10 items (sync 4: 8 sent, 2 changed, 1 gone) · 6 links to the graph',
  });
  assert.deepEqual(
    synced.counts.map((c: { n: number }) => c.n),
    [10, 8, 2, 1, 6],
  );
  const failed = M.sourceStatus({ enabled: true, status: 'error: offline — showing the cache (10 items)' });
  assert.equal(failed.reason, 'offline');
  assert.equal(failed.counts[0].n, 10);
  assert.deepEqual(failed.notices, ['settings.status.cached']);
});
