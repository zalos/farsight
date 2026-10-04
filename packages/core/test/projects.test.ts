// The project graph computed once per graph (docs/proposals/dependencies-and-nx.md §2.2, addendum
// 2026-10-04): the fold is kept per index, a repo narrows the kept fold, every row carries its closure,
// node ids by project are a lookup, NX's own project graph merges as `nx: true`, and a timing guard
// over a synthetic 20,000-node workspace. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, projectGraph, projectNodeIds, appClosure, projectsSummaryLine, graphFilePath, sanitizeProjects, countedProblems } from '../dist/index.js';
import type { GraphNode, ProjectsMeta, Counted } from '../dist/index.js';

function node(id: string, kind: GraphNode['kind'], project: string, repo = 'ws'): GraphNode {
  return { id: `${repo}::${id}`, kind, name: id, loc: { repo, path: `libs/${project}/${id}.ts`, line: 1 }, project: { name: project, root: `libs/${project}` } } as GraphNode;
}

function meta(names: string[], imports: [string, string][], extra: Partial<ProjectsMeta> = {}): ProjectsMeta {
  return {
    tool: 'nx',
    projects: names.map((name) => ({ name, root: `libs/${name}`, tags: [], via: 'project.json' as const })),
    tagDimensions: [],
    imports: imports.map(([from, to]) => ({ from, to, imports: 1, files: 1, top: [{ path: `libs/${from}/a.ts`, imports: 1 }] })),
    ...extra,
  };
}

test('the fold is kept per index: the same index answers the same object, a different index refolds', () => {
  const nodes = [node('a', 'function', 'app'), node('b', 'function', 'lib'), node('m', 'module', 'lib')];
  const metas = { ws: meta(['app', 'lib'], [['app', 'lib']]) };
  const index = buildIndex(nodes, []);
  const first = projectGraph(index, metas);
  assert.equal(projectGraph(index, metas), first, 'asked twice, folded once');
  const narrowed = projectGraph(index, metas, { repo: 'ws' });
  assert.equal(projectGraph(index, metas, { repo: 'ws' }), narrowed, 'a narrowing is kept too');
  assert.equal(narrowed.projects[0], first.projects[0], 'a narrowing filters the kept rows, it does not refold');
  assert.deepEqual(projectGraph(index, metas, { repo: 'nope' }).projects, []);
  const other = buildIndex(nodes, []);
  assert.notEqual(projectGraph(other, metas), first, 'another index folds again');
  assert.notEqual(projectGraph(index, { ...metas }), first, 'another meta object folds again');
  // node ids by kind are a lookup over the same fold; a module node is no part
  assert.deepEqual(projectNodeIds(index, metas, 'ws', 'lib'), { function: ['ws::b'] });
  assert.deepEqual(projectNodeIds(index, metas, 'ws', 'nope'), {});
});

test('every row carries its closure, the same as appClosure, project first then nearest first', () => {
  const names = ['app', 'feat', 'ui', 'util', 'data', 'lonely'];
  const metas = { ws: meta(names, [['app', 'feat'], ['app', 'util'], ['feat', 'ui'], ['feat', 'data'], ['ui', 'util']]) };
  const pg = projectGraph(buildIndex([], []), metas);
  for (const row of pg.projects) assert.deepEqual(row.closure, appClosure(pg, row.name)!.projects, row.name);
  const app = appClosure(pg, 'app')!;
  assert.deepEqual(app.projects, ['app', 'feat', 'util', 'data', 'ui']);
  assert.equal(app.count.n, 4);
  assert.deepEqual(app.dependencies.map((d) => `${d.from}>${d.to}`), ['app>feat', 'app>util', 'feat>data', 'feat>ui', 'ui>util']);
  assert.deepEqual(pg.projects.find((p) => p.name === 'lonely')!.closure, ['lonely']);
  // asked again it is the same answer, never a shared array a caller could change
  app.projects.push('x');
  assert.deepEqual(appClosure(pg, 'app')!.projects, ['app', 'feat', 'util', 'data', 'ui']);
});

test('NX project-graph dependencies merge: one both know is nx, one only NX knows is nx with no imports', () => {
  const metas = {
    ws: meta(['app', 'lib', 'e2e'], [['app', 'lib']], {
      dependencies: [
        { from: 'app', to: 'lib', type: 'static', via: 'nx-graph' },
        { from: 'e2e', to: 'app', type: 'dynamic', via: 'nx-graph' },
        { from: 'e2e', to: 'ghost', type: 'static', via: 'nx-graph' },
      ],
      graphFile: { path: '.nx/workspace-data/project-graph.json', projects: 3, dependencies: 3 },
    }),
  };
  const pg = projectGraph(buildIndex([], []), metas);
  const dep = (from: string, to: string) => pg.dependencies.find((d) => d.from === from && d.to === to)!;
  assert.equal(dep('app', 'lib').nx, true);
  assert.equal(dep('app', 'lib').imports, 1, 'the imports read from the files stay the evidence');
  assert.equal(dep('e2e', 'app').nx, true);
  assert.equal(dep('e2e', 'app').nxType, 'dynamic');
  assert.equal(dep('e2e', 'app').imports, 0);
  assert.equal(dep('e2e', 'ghost'), undefined, 'a name no source declares never becomes a dependency');
  assert.deepEqual(pg.projects.find((p) => p.name === 'e2e')!.closure, ['e2e', 'app', 'lib']);
  assert.deepEqual(pg.counts.dependencies.breakdown?.map((p) => `${p.key}:${p.n}`), ['count.part.depsImported:1', 'count.part.depsNxGraph:1']);
  assert.deepEqual(countedProblems(pg.counts.dependencies as Counted, 'deps'), []);
  assert.match(projectsSummaryLine(pg), /· 2 project dependencies · nx graph: 3 dependencies read$/);
  assert.equal(pg.repos[0]!.graphFile?.path, '.nx/workspace-data/project-graph.json');
});

test('projects.graphFile: kept as written by the config, refused when absolute or climbing out', () => {
  assert.deepEqual(graphFilePath('graph/nx.json'), { path: 'graph/nx.json' });
  assert.deepEqual(graphFilePath('./a/./b.json'), { path: 'a/b.json' });
  for (const bad of ['../x.json', 'a/../../x.json', '/etc/passwd', 'C:\\x.json', '..\\x.json', '', ' ', '.', 'a\0b']) {
    const r = graphFilePath(bad);
    assert.ok('note' in r, `${JSON.stringify(bad)} is refused`);
  }
  const cfg = sanitizeProjects({ projects: { graphFile: ' nx.json ' } } as never);
  assert.equal(cfg.projects?.graphFile, 'nx.json');
  assert.equal(sanitizeProjects({ projects: { graphFile: 4 } } as never).projects?.graphFile, undefined);
});

test('timing: 20,000 nodes over 30 projects fold once and answer 30 closures well under a second', () => {
  const names = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}`);
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 20_000; i++) nodes.push(node(`n${i}`, i % 3 ? 'function' : 'component', names[i % 30]!));
  // a layered DAG: each project imports the next three
  const imports: [string, string][] = [];
  for (let i = 0; i < 30; i++) for (let j = i + 1; j <= i + 3 && j < 30; j++) imports.push([names[i]!, names[j]!]);
  const metas = { ws: meta(names, imports) };
  const index = buildIndex(nodes, []);
  const t0 = performance.now();
  const pg = projectGraph(index, metas);
  for (const n of names) appClosure(pg, n);
  for (let k = 0; k < 100; k++) { projectGraph(index, metas); projectGraph(index, metas, { repo: 'ws' }); }
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `fold + 30 closures + 200 cached answers took ${ms.toFixed(0)} ms`);
  assert.equal(pg.projects.reduce((a, p) => a + p.nodes.n, 0), 20_000);
  assert.equal(pg.projects[0]!.closure.length, 30);
});
