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
    config: { glossary: { App: 'Application' } },
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
