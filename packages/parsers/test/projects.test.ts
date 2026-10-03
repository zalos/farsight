// Projects and tags (docs/proposals/dependencies-and-nx.md §2.2): NX / workspaces / none discovery,
// longest-root stamping, tag dimensions with config overrides, project → project imports, and the
// NX example workspace ingested end to end. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo, discoverProjects, projectOfPath, importSpecifiers } from '../dist/index.js';
import { buildIndex, projectGraph, appClosure, projectFacets, sanitizeProjects, mergeTagDimensions, countedProblems, GraphStore } from '@farsight/core';
import type { Counted, GraphFragment } from '@farsight/core';

const NX_EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'nx-workspace');

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-projects-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const json = (v: unknown) => JSON.stringify(v);
const ingest = (dir: string, repoName = 'r') => ingestRepo(dir, { repoName, openapi: false, design: false, tests: false, stories: false });

/** Every Counted anywhere inside a value must be sound (keys in the catalog, scope in COUNT_SCOPES, partitions). */
function assertSound(v: unknown, path = '$'): number {
  if (!v || typeof v !== 'object') return 0;
  const o = v as Record<string, unknown>;
  if (typeof o.n === 'number' && typeof o.unit === 'string' && typeof o.scope === 'string') {
    assert.deepEqual(countedProblems(o as unknown as Counted, path), []);
    return 1;
  }
  let n = 0;
  for (const [k, x] of Object.entries(o)) n += assertSound(x, `${path}.${k}`);
  return n;
}

test('nx: project.json names, types, tags, implicitDependencies and sourceRoot; package.json with an nx key; nested roots', () => {
  const dir = tempRepo({
    'nx.json': '{}',
    'package.json': json({ name: 'ws', private: true }),
    'apps/shop/project.json': json({ name: 'shop', projectType: 'application', sourceRoot: 'apps/shop/src', tags: ['scope:shop', 'type:app'], implicitDependencies: ['shared-util', '!nope'] }),
    'apps/shop-e2e/project.json': json({ projectType: 'application', tags: [] }),
    'libs/shared/util/project.json': json({ name: 'shared-util', tags: ['scope:shared', 'type:util'] }),
    'libs/shared/util/package.json': json({ name: '@ws/util', nx: { tags: ['platform:web'] } }),
    'libs/ui/package.json': json({ name: '@ws/ui', nx: { tags: ['type:ui'] } }),
    'libs/plain/package.json': json({ name: '@ws/plain' }), // no nx key, no workspaces glob: not a project
    'node_modules/x/project.json': json({ name: 'vendored' }),
    'dist/out/project.json': json({ name: 'built' }),
  });
  const { tool, projects, notes } = discoverProjects(dir, 'r');
  assert.equal(tool, 'nx');
  assert.deepEqual(notes, []);
  const by = Object.fromEntries(projects.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['@ws/ui', 'shared-util', 'shop', 'shop-e2e']);
  assert.deepEqual(by.shop, { name: 'shop', root: 'apps/shop', type: 'application', tags: ['scope:shop', 'type:app'], implicitDependencies: ['shared-util'], sourceRoot: 'apps/shop/src', via: 'project.json' });
  // no name in project.json → the directory name; an application named -e2e is an e2e project
  assert.equal(by['shop-e2e']!.type, 'e2e');
  // project.json and package.json in one directory are one project: the project.json's name, the tags merged; libs/ → library
  assert.deepEqual(by['shared-util']!.tags, ['scope:shared', 'type:util', 'platform:web']);
  assert.equal(by['shared-util']!.type, 'library');
  assert.equal(by['@ws/ui']!.via, 'package.json');
});

test('nx: a package.json in a workspaces glob is an inferred project; the root package.json is not', () => {
  const dir = tempRepo({
    'nx.json': '{}',
    'package.json': json({ name: 'ws', workspaces: ['packages/*'] }),
    'packages/api/package.json': json({ name: '@ws/api' }),
    'packages/api/deep/package.json': json({ name: '@ws/deep' }),
  });
  const { projects } = discoverProjects(dir, 'r');
  assert.deepEqual(projects.map((p) => [p.name, p.root, p.via]), [['@ws/api', 'packages/api', 'package.json']]);
});

test('workspaces without nx: projects from the globs, no tags even when an nx key is written', () => {
  const dir = tempRepo({
    'package.json': json({ name: 'ws', workspaces: { packages: ['packages/*'] } }),
    'packages/a/package.json': json({ name: '@ws/a', nx: { tags: ['scope:a'] } }),
    'packages/b/package.json': json({ name: '@ws/b' }),
    'tools/c/package.json': json({ name: 'c' }),
  });
  const { tool, projects } = discoverProjects(dir, 'r');
  assert.equal(tool, 'workspaces');
  assert.deepEqual(projects.map((p) => [p.name, p.tags]), [['@ws/a', []], ['@ws/b', []]]);
});

test('pnpm-workspace.yaml globs count as workspaces', () => {
  const dir = tempRepo({ 'package.json': json({ name: 'ws' }), 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'packages/a/package.json': json({ name: 'a' }) });
  const { tool, projects } = discoverProjects(dir, 'r');
  assert.equal(tool, 'workspaces');
  assert.deepEqual(projects.map((p) => p.name), ['a']);
});

test('none: one project per source, named after the source, root "."', async () => {
  const dir = tempRepo({ 'package.json': json({ name: 'solo' }), 'src/a.ts': 'export function a() { return 1; }' });
  assert.deepEqual(discoverProjects(dir, 'solo-src'), { tool: 'none', projects: [{ name: 'solo-src', root: '.', tags: [], via: 'source' }], notes: [] });
  const g = await ingest(dir, 'solo-src');
  assert.equal(g.meta?.projects?.tool, 'none');
  assert.deepEqual(g.nodes.find((n) => n.name === 'a')?.project, { name: 'solo-src', root: '.' });
  assert.equal(g.meta?.projects?.imports, undefined, 'one project imports from no other');
});

test('a project.json that is not JSON is set aside with a note; two projects with one name keep the first', () => {
  const dir = tempRepo({
    'nx.json': '{}',
    'package.json': json({ name: 'ws' }),
    'libs/a/project.json': '{ nope',
    'libs/b/project.json': json({ name: 'dup' }),
    'libs/c/project.json': json({ name: 'dup' }),
  });
  const { projects, notes } = discoverProjects(dir, 'r');
  assert.deepEqual(projects.map((p) => p.root), ['libs/b']);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /libs\/a\/project\.json could not be read as JSON/);
  assert.match(notes[1]!, /Two projects are named dup \(libs\/b and libs\/c\)/);
});

test('projectOfPath: the longest root wins, "." only when nothing else holds the file', () => {
  const ps = [
    { name: 'root', root: '.', tags: [], via: 'source' as const },
    { name: 'app', root: 'apps/app', tags: [], via: 'project.json' as const },
    { name: 'app-sub', root: 'apps/app/sub', tags: [], via: 'project.json' as const },
  ];
  assert.equal(projectOfPath('apps/app/sub/x.ts', ps)?.name, 'app-sub');
  assert.equal(projectOfPath('apps/app/x.ts', ps)?.name, 'app');
  assert.equal(projectOfPath('apps/application/x.ts', ps)?.name, 'root', 'a sibling with a shared prefix is not under the root');
  assert.equal(projectOfPath('tools/x.ts', ps)?.name, 'root');
  assert.equal(projectOfPath('tools/x.ts', ps.slice(1)), undefined);
});

test('importSpecifiers reads import, export-from, side-effect, dynamic import and require', () => {
  const src = [
    "import a from './a';", "import { b } from \"@ws/b\";", "import type { C } from '../c';", "export * from './d';",
    "export { e } from '@ws/e';", "import './f.css';", "const g = await import('./g');", "const h = require('h');",
  ].join('\n');
  assert.deepEqual(importSpecifiers(src), ['./a', '@ws/b', '../c', './d', '@ws/e', './f.css', './g', 'h']);
});

test('tag dimensions: defaults, a rename by prefix, an added dimension, value words; the config is soft-validated', () => {
  assert.deepEqual(mergeTagDimensions().map((d) => `${d.key}=${d.prefix}`), ['domain=scope:', 'type=type:', 'platform=platform:']);
  const merged = mergeTagDimensions([{ key: 'area', prefix: 'scope:', label: 'Area' }, { key: 'team', prefix: 'team:', label: 'Team' }]);
  assert.deepEqual(merged.map((d) => `${d.key}=${d.prefix}:${d.label}`), ['area=scope::Area', 'type=type::Type', 'platform=platform::Platform', 'team=team::Team']);
  const cfg = sanitizeProjects({ projects: { tagDimensions: [{ key: 'team', prefix: 'team:' }, { key: 3 }, 'x', { prefix: 'p:' }], tagValues: { type: { ui: 'UI', bad: 4, empty: ' ' }, domain: 'nope' } } as never });
  assert.deepEqual(cfg.projects, { tagDimensions: [{ key: 'team', prefix: 'team:', label: 'team' }], tagValues: { type: { ui: 'UI' } } });
  assert.equal(sanitizeProjects({ projects: [] as never }).projects, undefined, 'a block of the wrong shape is dropped, never thrown');
  const f = projectFacets(
    { project: { name: 'p', root: 'libs/p', type: 'library', tags: ['scope:billing', 'type:data-access', 'type:ui', 'team:core', 'legacy'] } },
    { tagDimensions: mergeTagDimensions([{ key: 'team', prefix: 'team:', label: 'Team' }]), tagValues: { type: { ui: 'UI' } } },
  );
  assert.deepEqual(f, {
    project: 'p', projectType: 'library', domain: 'billing', type: 'data-access',
    byDimension: {
      domain: [{ value: 'billing', word: 'Billing' }],
      type: [{ value: 'data-access', word: 'Data access' }, { value: 'ui', word: 'UI' }],
      team: [{ value: 'core', word: 'Core' }],
    },
    other: ['legacy'],
  });
  assert.equal(projectFacets({}), undefined);
});

test('the NX example: every node carries its project and tags; the project graph lists projects, tags and dependencies', async () => {
  const g = await ingestRepo(NX_EXAMPLE, { repoName: 'nx-workspace' });
  const missing = g.nodes.filter((n) => !n.project).map((n) => n.id);
  assert.deepEqual(missing, [], 'every node of the NX example carries its project');
  const node = (name: string) => g.nodes.find((n) => n.name === name)!;
  assert.deepEqual(node('InvoiceList').project, { name: 'billing-feature-invoices', root: 'libs/billing/feature-invoices', type: 'library', tags: ['scope:billing', 'type:feature'] });
  assert.deepEqual(node('PageShell').project?.name, '@nxw/shared-ui', 'a package.json with an nx key names the project');
  assert.equal(g.nodes.find((n) => n.kind === 'table')?.project?.name, 'billing-data-access', 'a table placed without a file takes the project of what reads it');
  const m = g.meta!.projects!;
  assert.equal(m.tool, 'nx');
  assert.equal(m.projects.length, 8);
  assert.deepEqual(m.tagValues?.type?.['data-access'], 'Data access', 'farsight.config.json gives values their words');

  const store = new GraphStore();
  store.addFragment(g as GraphFragment);
  const graph = store.toJSON();
  assert.ok(graph.meta.projects?.['nx-workspace'], 'the store keeps meta.projects per repo');
  const index = buildIndex(graph.nodes, graph.edges);
  const pg = projectGraph(index, graph.meta.projects);
  assert.deepEqual(pg.projects.map((p) => `${p.name}:${p.type}`), [
    '@nxw/shared-ui:library', 'billing-data-access:library', 'billing-feature-invoices:library', 'billing-ui:library',
    'billing-web:application', 'billing-web-e2e:e2e', 'ops-admin:application', 'shared-util:library',
  ]);
  const deps = pg.dependencies.map((d) => `${d.from}>${d.to}${d.implicit ? ' (implicit)' : ''} ${d.imports}`);
  assert.deepEqual(deps, [
    'billing-feature-invoices>billing-data-access 1',
    'billing-feature-invoices>billing-ui 1',
    'billing-ui>shared-util 1',
    'billing-web>@nxw/shared-ui 1',
    'billing-web>billing-feature-invoices 1',
    'billing-web>shared-util 1',
    'billing-web-e2e>billing-web (implicit) 0',
    'ops-admin>@nxw/shared-ui 1',
    'ops-admin>billing-data-access (implicit) 0',
    'ops-admin>shared-util 1',
  ]);
  const web = pg.projects.find((p) => p.name === 'billing-web')!;
  assert.deepEqual(web.dependsOn, ['@nxw/shared-ui', 'billing-feature-invoices', 'shared-util']);
  assert.deepEqual(web.dependents, ['billing-web-e2e']);
  assert.deepEqual(web.facets.byDimension.type, [{ value: 'app', word: 'Application' }]);
  assert.equal(web.nodes.n, 2);
  assert.deepEqual(web.nodes.breakdown?.map((p) => `${p.label}:${p.n}`), ['component:1', 'page:1']);
  assert.deepEqual(pg.counts.projects.breakdown?.map((p) => `${p.key}:${p.n}`), ['count.part.projectsApp:2', 'count.part.projectsLib:5', 'count.part.projectsE2e:1']);
  assert.deepEqual(pg.counts.dependencies.breakdown?.map((p) => `${p.key}:${p.n}`), ['count.part.depsImported:8', 'count.part.depsDeclared:2']);
  assert.deepEqual(pg.counts.byDimension.domain?.breakdown?.map((p) => `${p.label ?? p.key}:${p.n}`), ['Billing:5', 'Shared:2', 'Operations:1']);
  assert.ok(assertSound(pg) > 10, 'every number is a sound Counted');

  // the closure of an application: itself, then what it depends on, nearest first
  const closure = appClosure(pg, 'billing-web')!;
  assert.deepEqual(closure.projects, ['billing-web', '@nxw/shared-ui', 'billing-feature-invoices', 'shared-util', 'billing-data-access', 'billing-ui']);
  assert.equal(closure.count.n, 5);
  assert.deepEqual(appClosure(pg, 'ops-admin')!.projects, ['ops-admin', '@nxw/shared-ui', 'billing-data-access', 'shared-util']);
  assert.equal(appClosure(pg, 'nope'), undefined);
  assertSound(closure);
});
