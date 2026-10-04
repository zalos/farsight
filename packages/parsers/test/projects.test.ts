// Projects and tags (docs/proposals/dependencies-and-nx.md §2.2): NX / workspaces / none discovery,
// longest-root stamping, tag dimensions with config overrides, project → project imports, and the
// NX example workspace ingested end to end. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo, discoverProjects, projectOfPath, importSpecifiers, readNxProjectGraph, NX_GRAPH_MAX_BYTES } from '../dist/index.js';
import { buildIndex, projectGraph, appClosure, projectFacets, sanitizeProjects, mergeTagDimensions, countedProblems, GraphStore } from '@farsight/core';
import type { Counted, GraphFragment } from '@farsight/core';

const NX_EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'nx-workspace');

const temps: string[] = [];
process.on('exit', () => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-projects-'));
  temps.push(dir);
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
  // a package node belongs to no one project: a third-party package is imported from several,
  // and a workspace package names the project it resolves to on `package.project` instead.
  // The design manifest (docs/design/screens.json at the workspace root) and the journeys it
  // declares sit under no project folder either — the code map groups them under no project
  const missing = g.nodes.filter((n) => !n.project && n.kind !== 'package' && n.kind !== 'design' && n.kind !== 'flow').map((n) => n.id);
  assert.deepEqual(missing, [], 'every node of the NX example carries its project');
  assert.equal(g.nodes.find((n) => n.id === 'nx-workspace::package::@nxw/shared/util')?.package?.project, 'shared-util', 'a workspace package names the project it resolves to');
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
  // the example carries the project graph NX would write (`nx graph --file`), named by farsight.config.json:
  // it agrees with every import and implicit dependency, and adds one the files do not show (a lazy import
  // from the e2e project), which merges as `nx` with no imports
  assert.deepEqual(m.graphFile, { path: 'nx-project-graph.json', projects: 8, dependencies: 11 });
  assert.equal(m.notes, undefined, 'npm: targets are skipped without a note');
  const deps = pg.dependencies.map((d) => `${d.from}>${d.to}${d.implicit ? ' (implicit)' : ''}${d.nx ? ` (nx ${d.nxType})` : ''} ${d.imports}`);
  assert.deepEqual(deps, [
    'billing-feature-invoices>billing-data-access (nx static) 1',
    'billing-feature-invoices>billing-ui (nx static) 1',
    'billing-ui>shared-util (nx static) 1',
    'billing-web>@nxw/shared-ui (nx static) 1',
    'billing-web>billing-feature-invoices (nx static) 1',
    'billing-web>shared-util (nx static) 1',
    'billing-web-e2e>billing-web (implicit) (nx implicit) 0',
    'billing-web-e2e>shared-util (nx dynamic) 0',
    'ops-admin>@nxw/shared-ui (nx static) 1',
    'ops-admin>billing-data-access (implicit) (nx implicit) 0',
    'ops-admin>shared-util (nx static) 1',
  ]);
  const web = pg.projects.find((p) => p.name === 'billing-web')!;
  assert.deepEqual(web.dependsOn, ['@nxw/shared-ui', 'billing-feature-invoices', 'shared-util']);
  assert.deepEqual(web.dependents, ['billing-web-e2e']);
  assert.deepEqual(web.facets.byDimension.type, [{ value: 'app', word: 'Application' }]);
  // two screens (the invoices page and the sign-in page) and the app's own screens manifest
  assert.equal(web.nodes.n, 5);
  assert.deepEqual(web.nodes.breakdown?.map((p) => `${p.label}:${p.n}`), ['component:2', 'page:2', 'design:1']);
  assert.deepEqual(pg.counts.projects.breakdown?.map((p) => `${p.key}:${p.n}`), ['count.part.projectsApp:2', 'count.part.projectsLib:5', 'count.part.projectsE2e:1']);
  assert.deepEqual(pg.counts.dependencies.breakdown?.map((p) => `${p.key}:${p.n}`), ['count.part.depsImported:8', 'count.part.depsDeclared:2', 'count.part.depsNxGraph:1']);
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

// ── NX's own project graph, read from the file NX wrote (never by running NX) ──

const NX_PROJECTS = {
  'nx.json': '{}',
  'package.json': json({ name: 'ws', private: true }),
  'apps/shop/project.json': json({ name: 'shop', tags: [] }), // no projectType, outside the layout folders
  'tools/gen/project.json': json({ name: 'gen' }),
  'shop-e2e/project.json': json({ name: 'shop-tests' }),
};
const cacheGraph = {
  nodes: {
    shop: { name: 'shop', type: 'app', data: { root: 'apps/shop' } },
    gen: { name: 'gen', type: 'lib', data: { root: 'tools/gen' } },
    'shop-tests': { name: 'shop-tests', type: 'e2e', data: { root: 'shop-e2e' } },
    stranger: { name: 'stranger', type: 'lib', data: { root: 'x' } },
  },
  externalNodes: { 'npm:react': { type: 'npm', name: 'npm:react', data: { version: '18' } } },
  dependencies: {
    shop: [{ source: 'shop', target: 'gen', type: 'static' }, { source: 'shop', target: 'gen', type: 'implicit' }, { source: 'shop', target: 'npm:react', type: 'static' }],
    'shop-tests': [{ source: 'shop-tests', target: 'shop', type: 'implicit' }, { source: 'shop-tests', target: 'stranger', type: 'static' }],
    gen: [{ source: 'gen', target: 'gen', type: 'static' }, { target: 7, type: 'static' }, { source: 'gen', target: 'shop', type: 'weird' }],
    stranger: [{ source: 'stranger', target: 'gen', type: 'static' }],
  },
};

test('nx graph: the cache file NX writes is found, read in its bare shape, and types the projects no manifest typed', async () => {
  const dir = tempRepo({ ...NX_PROJECTS, '.nx/workspace-data/project-graph.json': json(cacheGraph) });
  const read = readNxProjectGraph(dir, discoverProjects(dir, 'r').projects);
  assert.deepEqual(read.dependencies, [
    { from: 'shop', to: 'gen', type: 'static', via: 'nx-graph' },
    { from: 'shop-tests', to: 'shop', type: 'implicit', via: 'nx-graph' },
  ], 'one per pair (static beats implicit), npm: targets and self-edges skipped');
  assert.deepEqual(read.graphFile, { path: '.nx/workspace-data/project-graph.json', projects: 3, dependencies: 2 });
  assert.deepEqual(read.notes.length, 2);
  assert.match(read.notes[0]!, /names 1 project this source does not declare/);
  assert.match(read.notes[1]!, /has 2 dependencies of a shape Farsight does not read/);
  const g = await ingest(dir);
  const m = g.meta!.projects!;
  assert.deepEqual(m.projects.map((p) => `${p.name}:${p.type}`), ['shop:application', 'shop-tests:e2e', 'gen:library']);
  assert.deepEqual(m.dependencies?.map((d) => `${d.from}>${d.to}`), ['shop>gen', 'shop-tests>shop']);
  assert.equal(m.graphFile?.dependencies, 2);
});

test('nx graph: the `nx graph --file` export shape, named by projects.graphFile, wins over the cache', () => {
  const dir = tempRepo({
    ...NX_PROJECTS,
    'farsight.config.json': json({ projects: { graphFile: 'docs/graph.json' } }),
    'docs/graph.json': json({ graph: { nodes: cacheGraph.nodes, dependencies: { gen: [{ source: 'gen', target: 'shop', type: 'dynamic' }] } } }),
    '.nx/workspace-data/project-graph.json': json(cacheGraph),
  });
  const read = readNxProjectGraph(dir, discoverProjects(dir, 'r').projects, 'docs/graph.json');
  assert.deepEqual(read.dependencies.map((d) => `${d.from}>${d.to}:${d.type}`), ['gen>shop:dynamic']);
});

test('nx graph: a path out of the source, a symlink out of it, an oversize file and a malformed one each leave a note and no dependency', async () => {
  const outside = tempRepo({ 'g.json': json(cacheGraph) });
  const dir = tempRepo({ ...NX_PROJECTS, 'bad.json': '{ nope', 'shape.json': json({ graph: { nodes: [] } }) });
  symlinkSync(join(outside, 'g.json'), join(dir, 'link.json'));
  const projects = discoverProjects(dir, 'r').projects;
  const cases: [string, RegExp][] = [
    ['../x.json', /climbs out of the source/],
    ['/etc/hosts', /absolute path/],
    ['link.json', /resolves outside the source/],
    ['missing.json', /was not found/],
    ['bad.json', /could not be read as JSON/],
    ['shape.json', /has no nodes and dependencies objects/],
    ['apps', /is not a file/],
  ];
  for (const [path, note] of cases) {
    const read = readNxProjectGraph(dir, projects, path);
    assert.deepEqual(read.dependencies, [], path);
    assert.equal(read.graphFile, undefined, path);
    assert.equal(read.notes.length, 1, path);
    assert.match(read.notes[0]!, note, path);
  }
  // past the cap the file is not even parsed
  const big = tempRepo({ ...NX_PROJECTS });
  writeFileSync(join(big, 'big.json'), Buffer.alloc(NX_GRAPH_MAX_BYTES + 1, 0x20));
  const read = readNxProjectGraph(big, projects, 'big.json');
  assert.match(read.notes[0]!, /over the 20 MB Farsight reads/);
  // through ingest: the note lands on meta.projects.notes and nothing throws
  writeFileSync(join(dir, 'farsight.config.json'), json({ projects: { graphFile: '../escape.json' } }));
  const g = await ingest(dir);
  assert.ok(g.meta!.projects!.notes?.some((n) => /climbs out of the source/.test(n)));
  assert.equal(g.meta!.projects!.dependencies, undefined);
});

test('nx graph: never read for a source that is not an NX workspace', async () => {
  const dir = tempRepo({
    'package.json': json({ name: 'ws', workspaces: ['packages/*'] }),
    'packages/a/package.json': json({ name: 'a' }),
    '.nx/workspace-data/project-graph.json': json(cacheGraph),
  });
  const g = await ingest(dir);
  assert.equal(g.meta!.projects!.tool, 'workspaces');
  assert.equal(g.meta!.projects!.graphFile, undefined);
});
