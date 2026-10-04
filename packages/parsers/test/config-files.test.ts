// Many farsight.config.json files per source (docs/proposals/journey-organisation-and-config-files.md §5):
// discovery and its order, the path rule (rebased to the folder, never out of the source), the scope of
// node matchers, the nearer file's glossary word, conflicts, root-only fields, unreadable files, test
// report lists, `config: false`, and a manifest declared and discovered read once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { GraphNode } from '@farsight/core';
import { ingestRepo, loadWorkspaceConfig, journeysConfigFor, rebasePath, applyTests } from '../dist/index.js';

function tempRepo(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-cfg-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const byPath = (nodes: GraphNode[], path: string, name: string) => nodes.find((n) => n.loc?.path === path && n.name.split(': ')[0] === name)!;

test('discovery: the root file first, then by folder depth, then by path — excludes and node_modules skipped', () => {
  const dir = tempRepo({
    'farsight.config.json': { tags: { root: ['src'] } },
    'apps/b/farsight.config.json': { tags: { b: ['x'] } },
    'apps/a/farsight.config.json': { tags: { a: ['x'] } },
    'apps/a/feature/farsight.config.json': { tags: { deep: ['x'] } },
    'libs/farsight.config.json': { tags: { libs: ['x'] } },
    'node_modules/pkg/farsight.config.json': { tags: { vendored: ['x'] } },
    'examples/demo/farsight.config.json': { tags: { excluded: ['x'] } },
  });
  try {
    const ws = loadWorkspaceConfig(dir, { exclude: ['examples/**'] });
    assert.deepEqual(ws.files.map((f) => f.path), [
      'farsight.config.json', 'libs/farsight.config.json', 'apps/a/farsight.config.json', 'apps/b/farsight.config.json', 'apps/a/feature/farsight.config.json',
    ]);
    assert.deepEqual(ws.files.map((f) => f.dir), ['.', 'libs', 'apps/a', 'apps/b', 'apps/a/feature']);
    assert.deepEqual(ws.meta.files.map((f) => f.root), [true, false, false, false, false]);
    assert.deepEqual(ws.meta.files[0]!.fields, ['tags']);
    // a source with no root file still reads its nested ones
    rmSync(join(dir, 'farsight.config.json'));
    const noRoot = loadWorkspaceConfig(dir, { exclude: ['examples/**'] });
    assert.equal(noRoot.root, null);
    assert.equal(noRoot.files[0]!.path, 'libs/farsight.config.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the path rule: a nested file\'s paths are rebased to its folder, URLs kept, an escape refused with a note', () => {
  const dir = tempRepo({
    'farsight.config.json': {
      plumbing: ['src/plumbing/**'],
      design: [{ manifest: 'docs/design/screens.json' }],
      tests: { unit: { runner: 'vitest', results: 'coverage/results.json' }, include: ['test/**'] },
      storybook: { configDir: '.storybook', url: 'http://localhost:6006' },
    },
    'apps/a/farsight.config.json': {
      plumbing: ['src/plumbing/**', './lib/http/**', '../../../outside/**', '/etc/**'],
      design: [{ manifest: 'docs/design/screens.json', name: 'App A' }, { url: 'https://design.example.com/screens.json' }],
      openapi: [{ path: 'openapi.yaml' }, { url: 'https://api.example.com/openapi.json' }],
      tests: {
        include: ['spec/**'],
        unit: { runner: 'jest', results: ['coverage/a.json', 'coverage/b.json'], coverage: 'coverage/coverage-final.json', report: 'coverage/index.html' },
        e2e: { runner: 'playwright', results: 'e2e/results.json' },
      },
      storybook: { url: 'http://localhost:6007' },
      externals: [{ import: 'src/erp.ts::ErpClient', name: 'ERP', kind: 'erp' }, { import: '@acme/sdk', name: 'Acme', kind: 'other' }],
    },
  });
  try {
    const ws = loadWorkspaceConfig(dir);
    const m = ws.merged;
    assert.deepEqual(m.plumbing, ['src/plumbing/**', 'apps/a/src/plumbing/**', 'apps/a/lib/http/**']);
    assert.deepEqual(m.design, [
      { manifest: 'docs/design/screens.json' },
      { manifest: 'apps/a/docs/design/screens.json', name: 'App A' },
      { url: 'https://design.example.com/screens.json' },
    ]);
    assert.deepEqual(m.openapi, [{ path: 'apps/a/openapi.yaml' }, { url: 'https://api.example.com/openapi.json' }]);
    assert.deepEqual(m.tests!.include, ['test/**', 'apps/a/spec/**']);
    // the root's block and the nested one stay two blocks, each with its own runner
    assert.deepEqual(m.tests!.unit, [
      { runner: 'vitest', results: 'coverage/results.json' },
      { runner: 'jest', results: ['apps/a/coverage/a.json', 'apps/a/coverage/b.json'], coverage: 'apps/a/coverage/coverage-final.json', report: 'apps/a/coverage/index.html' },
    ]);
    // a level only one file gives stays one block
    assert.deepEqual(m.tests!.e2e, { runner: 'playwright', results: 'apps/a/e2e/results.json' });
    assert.deepEqual(m.storybook, [
      { configDir: '.storybook', url: 'http://localhost:6006' },
      { url: 'http://localhost:6007', configDir: 'apps/a/.storybook' },
    ]);
    assert.deepEqual(m.externals!.map((e) => e.import), ['apps/a/src/erp.ts::ErpClient', '@acme/sdk']);
    assert.ok(ws.meta.notes.some((n) => /apps\/a\/farsight\.config\.json → plumbing "\.\.\/\.\.\/\.\.\/outside\/\*\*" climbs out of the source/.test(n)), ws.meta.notes.join('\n'));
    assert.ok(ws.meta.notes.some((n) => /"\/etc\/\*\*" is an absolute path/.test(n)), ws.meta.notes.join('\n'));
    // the root file's own config is unchanged: a source with one file reads as it did
    assert.deepEqual(ws.root!.plumbing, ['src/plumbing/**']);
    assert.equal(rebasePath('.', 'anything/**', 'x', []), 'anything/**');
    assert.equal(rebasePath('apps/a', '../b/x', 'x', []), 'apps/b/x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('node matchers: a nested file speaks only for the code under its folder; the nearer glossary word wins and the conflict is recorded', async () => {
  const dir = tempRepo({
    'farsight.config.json': {
      tags: { everywhere: ['helper'] },
      glossary: { helper: { label: 'Root word' } },
      entrypoints: { nightly: ['helper'] },
    },
    'apps/x/farsight.config.json': {
      tags: { 'app-x': ['helper'] },
      glossary: { helper: { label: 'App word' } },
    },
    'apps/y/farsight.config.json': { glossary: { other: { label: 'Unrelated' } } },
    'src/util.ts': 'export function helper() { return 1; }\n',
    'apps/x/src/util.ts': 'export function helper() { return 2; }\n',
    'apps/y/src/util.ts': 'export function helper() { return 3; }\n',
  });
  try {
    const g = await ingestRepo(dir, { repoName: 'cfg' });
    const root = byPath(g.nodes, 'src/util.ts', 'helper');
    const x = byPath(g.nodes, 'apps/x/src/util.ts', 'helper');
    const y = byPath(g.nodes, 'apps/y/src/util.ts', 'helper');
    assert.equal(root.facets?.business?.label, 'Root word');
    assert.equal(y.facets?.business?.label, 'Root word', 'a sibling folder\'s file does not reach apps/y');
    assert.equal(x.facets?.business?.label, 'App word', 'the nearer file\'s word wins under its folder');
    assert.ok(x.tags.includes('app-x') && x.tags.includes('everywhere') && x.tags.includes('nightly'), 'tags add');
    assert.ok(!root.tags.includes('app-x') && !y.tags.includes('app-x'), 'a nested tag rule stays in its folder');
    assert.equal(g.configApplied, true);
    const meta = g.meta!.config!;
    assert.deepEqual(meta.conflicts, [{ kind: 'glossary', key: 'helper', files: ['farsight.config.json', 'apps/x/farsight.config.json'], kept: 'apps/x/farsight.config.json' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a function the root already made a guard is not renamed again by a nested guard rule — a guard conflict', async () => {
  const dir = tempRepo({
    'farsight.config.json': { guards: { tenant: ['withTenant'] } },
    'apps/x/farsight.config.json': { guards: { session: ['withTenant', 'requireSession'] } },
    'apps/x/src/auth.ts': 'export function withTenant(fn: () => void) { fn(); }\nexport function requireSession(fn: () => void) { fn(); }\nexport function handler() { withTenant(() => 1); requireSession(() => 2); }\n',
    'src/other.ts': 'export function requireSession() { return 0; }\n',
  });
  try {
    const g = await ingestRepo(dir, { repoName: 'cfg' });
    const wt = byPath(g.nodes, 'apps/x/src/auth.ts', 'withTenant');
    assert.equal(wt.kind, 'guard');
    assert.equal(wt.name, 'withTenant: tenant', 'renamed once, by the root');
    assert.equal(byPath(g.nodes, 'apps/x/src/auth.ts', 'requireSession').name, 'requireSession: session');
    assert.equal(byPath(g.nodes, 'src/other.ts', 'requireSession').kind, 'function', 'the nested rule stays in its folder');
    assert.deepEqual(g.meta!.config!.conflicts, [{ kind: 'guard', key: 'withTenant', files: ['farsight.config.json', 'apps/x/farsight.config.json'], kept: 'farsight.config.json' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('externals and stores declared twice: the first file\'s is kept, the second is a conflict', () => {
  const dir = tempRepo({
    'farsight.config.json': { externals: [{ import: '@acme/erp', name: 'ERP', kind: 'erp' }], stores: [{ name: 'Main DB', kind: 'sql' }] },
    'apps/x/farsight.config.json': { externals: [{ import: '@acme/erp', name: 'Other ERP', kind: 'erp' }], stores: [{ name: 'Main DB', kind: 'document' }, { name: 'Cache', kind: 'other' }] },
  });
  try {
    const ws = loadWorkspaceConfig(dir);
    assert.deepEqual(ws.merged.externals!.map((e) => e.name), ['ERP']);
    assert.deepEqual(ws.merged.stores!.map((s) => `${s.name}:${s.kind}`), ['Main DB:sql', 'Cache:other']);
    assert.deepEqual(ws.meta.conflicts.map((c) => [c.kind, c.key, c.kept]), [['external', '@acme/erp', 'farsight.config.json'], ['store', 'Main DB', 'farsight.config.json']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('projects and tooling are root-only; an unknown field is ignored; each with a note', () => {
  const dir = tempRepo({
    'farsight.config.json': { tooling: ['tools/**'], projects: { graphFile: 'g.json' }, $schema: 'https://example.com/s.json' },
    'apps/x/farsight.config.json': { tooling: ['scripts/**'], projects: { graphFile: 'x.json' }, glosary: {} },
  });
  try {
    const ws = loadWorkspaceConfig(dir);
    assert.deepEqual(ws.merged.tooling, ['tools/**']);
    assert.equal(ws.merged.projects?.graphFile, 'g.json');
    assert.deepEqual(ws.meta.files[0]!.fields, ['tooling', 'projects'], '$schema is for editors, not a field');
    assert.deepEqual(ws.meta.files[1]!.fields, []);
    assert.deepEqual(ws.meta.files[1]!.ignored, ['tooling', 'projects', 'glosary']);
    assert.deepEqual(ws.meta.notes, [
      'tooling is root-only; apps/x/farsight.config.json\'s was ignored.',
      'projects is root-only; apps/x/farsight.config.json\'s was ignored.',
      '"glosary" is not a farsight.config.json field; apps/x/farsight.config.json\'s was ignored.',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file that is not valid JSON is a note with its path — the root\'s too — and the ingest goes on', async () => {
  const dir = tempRepo({
    'farsight.config.json': '{ "tags": ',
    'apps/x/farsight.config.json': '[1, 2]',
    'apps/y/farsight.config.json': { glossary: { helper: { label: 'Y word' } } },
    'apps/y/src/util.ts': 'export function helper() { return 3; }\n',
  });
  try {
    const g = await ingestRepo(dir, { repoName: 'cfg' });
    const meta = g.meta!.config!;
    assert.deepEqual(meta.files.map((f) => f.path), ['apps/y/farsight.config.json']);
    assert.match(meta.notes[0]!, /^farsight\.config\.json is not valid JSON — .*; it was not applied\.$/);
    assert.equal(meta.notes[1], 'apps/x/farsight.config.json is not a JSON object; it was not applied.');
    assert.equal(byPath(g.nodes, 'apps/y/src/util.ts', 'helper').facets?.business?.label, 'Y word');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tests: every report of a results list is read, from the root block and a nested one', () => {
  const vitest = (file: string, title: string) => JSON.stringify({
    startTime: 1757462400000,
    testResults: [{ name: file, assertionResults: [{ ancestorTitles: [], title, fullName: title, status: 'passed', duration: 1 }] }],
  });
  const dir = tempRepo({
    'farsight.config.json': { tests: { unit: { runner: 'vitest', results: ['coverage/one.json', 'coverage/two.json'] } } },
    'apps/x/farsight.config.json': { tests: { unit: { runner: 'jest', results: 'coverage/results.json' } } },
    'test/a.test.ts': "import { test } from 'vitest';\ntest('a works', () => {});\n",
    'test/b.test.ts': "import { test } from 'vitest';\ntest('b works', () => {});\n",
    'apps/x/test/c.test.ts': "import { test } from 'vitest';\ntest('c works', () => {});\n",
  });
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  writeFileSync(join(dir, 'coverage/one.json'), vitest(join(dir, 'test/a.test.ts'), 'a works'));
  writeFileSync(join(dir, 'coverage/two.json'), vitest(join(dir, 'test/b.test.ts'), 'b works'));
  mkdirSync(join(dir, 'apps/x/coverage'), { recursive: true });
  writeFileSync(join(dir, 'apps/x/coverage/results.json'), vitest(join(dir, 'apps/x/test/c.test.ts'), 'c works'));
  try {
    const fragment = { repo: 'cfg', nodes: [] as GraphNode[], edges: [], meta: { files: 0, sourceHash: 'x' } };
    const { meta } = applyTests(fragment, dir, {});
    assert.deepEqual(meta.reports.map((r) => `${r.path}:${r.runner}`).sort(), ['apps/x/coverage/results.json:jest', 'coverage/one.json:vitest', 'coverage/two.json:vitest']);
    const ran = fragment.nodes.filter((n) => n.kind === 'test' && n.test?.run?.status === 'passed').map((n) => n.name).sort();
    assert.deepEqual(ran, ['a works', 'b works', 'c works']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config: false reads no file at all — no glossary, no declarations, no meta.config', async () => {
  const dir = tempRepo({
    'farsight.config.json': { glossary: { helper: { label: 'Root word' } }, design: [{ manifest: 'screens/s.json' }] },
    'apps/x/farsight.config.json': { glossary: { helper: { label: 'App word' } } },
    'src/util.ts': 'export function helper() { return 1; }\n',
  });
  try {
    assert.equal(loadWorkspaceConfig(dir, { config: false }).files.length, 0);
    const g = await ingestRepo(dir, { repoName: 'cfg', config: false });
    assert.equal(byPath(g.nodes, 'src/util.ts', 'helper').facets?.business?.label, undefined);
    assert.equal(g.meta!.config, undefined);
    assert.equal(g.configApplied, undefined);
    assert.ok(!(g.specErrors ?? []).some((e) => e.includes('screens/s.json')), 'the design declaration was not read either');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a manifest a nested file declares and discovery also finds by name is read once', async () => {
  const manifest = { name: 'App y', screens: [{ id: 'Y-01', name: 'Home', route: '/home' }], flows: [{ id: 'y-home', name: 'Go home', screens: ['Y-01'] }] };
  const dir = tempRepo({
    'apps/y/farsight.config.json': { design: [{ manifest: 'docs/design/screens.json', name: 'App y screens' }] },
    'apps/y/docs/design/screens.json': manifest,
    'apps/z/farsight.config.json': { design: [{ manifest: 'docs/design/screens.json' }] },
    'apps/y/src/home.tsx': 'export function Home() { return null; }\n',
  });
  try {
    const g = await ingestRepo(dir, { repoName: 'cfg' });
    const designs = g.nodes.filter((n) => n.kind === 'design');
    assert.equal(designs.length, 1, designs.map((d) => d.id).join(', '));
    assert.equal(g.nodes.filter((n) => n.kind === 'flow').length, 1);
    assert.equal(designs[0]!.name, 'App y screens', 'the declaration\'s name is the one used');
    // the declaration in apps/z names a file that is not there: a sentence, without an absolute path
    assert.deepEqual(g.specErrors, ['design apps/z/docs/design/screens.json: declared in farsight.config.json, but there is no file at that path']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('journeys blocks: the root\'s applies to every manifest, a nested one to the manifests under its folder, nearest last', () => {
  const dir = tempRepo({
    'farsight.config.json': { journeys: { personas: [{ id: 'ops', name: 'Operations' }, { name: 'no id' }], flows: [{ id: 'f', order: 'x' }] } },
    'apps/a/farsight.config.json': { journeys: { groups: [{ id: 'access', name: 'Access', persona: 'ops' }], flows: [{ id: 'sign-in', persona: ['ops', 'contractor'], group: 'access', order: 1 }] } },
    'apps/b/farsight.config.json': { journeys: 'not a block' },
  });
  try {
    const ws = loadWorkspaceConfig(dir);
    // soft validation: an entry with no id is dropped, a field of the wrong type is left out, a block of the wrong shape goes
    assert.deepEqual(ws.root!.journeys, { personas: [{ id: 'ops', name: 'Operations' }], flows: [{ id: 'f' }] });
    assert.equal(ws.files.find((f) => f.dir === 'apps/b')!.config.journeys, undefined);
    assert.deepEqual(journeysConfigFor(ws, 'apps/a/docs/design/screens.json').map((b) => b.from), ['farsight.config.json', 'apps/a/farsight.config.json']);
    assert.deepEqual(journeysConfigFor(ws, 'docs/design/screens.json').map((b) => b.from), ['farsight.config.json']);
    assert.deepEqual(journeysConfigFor(ws, 'https://design.example.com/screens.json').map((b) => b.from), ['farsight.config.json']);
    assert.deepEqual(journeysConfigFor(ws, 'apps/a/docs/design/screens.json')[1]!.journeys.flows, [{ id: 'sign-in', persona: ['ops', 'contractor'], group: 'access', order: 1 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
