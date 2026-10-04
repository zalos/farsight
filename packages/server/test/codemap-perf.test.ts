// The code map's index (public/app/lib/codemap-model.js `buildCodemapIndex`) — a regression guard
// and a proof. Guard: on a graph the size of the dogfood one (≈20k nodes, 30 projects, two sources),
// building the index, the GROUP choices, two filters and a grouped fold take well under two seconds
// (the per-node fold it replaced took minutes). Proof: on the NX example and the invoice app ingested
// together, the set algebra keeps exactly what the old per-node predicate kept — a projects filter, a
// tag filter, both, a depends-on filter and an application's closure — the choices and the groups
// match the folds they replace, and the closure matches core `appClosure`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GraphStore, appClosure, projectGraph, buildIndex, type GraphNode, type GraphEdge, type GraphMeta } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const M = await import(join(here, '..', 'public', 'app', 'lib', 'codemap-model.js'));
type AnyRec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── the guard: a synthetic graph the size of the dogfood one ──
function synthetic() {
  const metas: AnyRec = {};
  const nodes: AnyRec[] = [];
  const edges: AnyRec[] = [];
  const domains = ['billing', 'ops', 'shared', 'search', 'auth'];
  for (const repo of ['alpha', 'beta']) {
    const projects = [];
    for (let i = 0; i < 15; i++) {
      const type = i < 3 ? 'application' : 'library';
      projects.push({ name: `${repo}-p${i}`, root: `libs/p${i}`, type, tags: [`scope:${domains[i % domains.length]}`, `type:${i % 2 ? 'ui' : 'data-access'}`], via: 'nx' });
    }
    const imports = projects.slice(1).map((p, i) => ({ from: projects[i]!.name, to: p.name, imports: 2, files: 1, top: [] }));
    metas[repo] = { tool: 'nx', projects, imports };
    for (let i = 0; i < 10_000; i++) {
      const p = projects[i % projects.length]!;
      const file = `libs/p${i % projects.length}/src/f${Math.floor(i / 8)}.ts`;
      const path = i % 50 === 0 ? file.replace('.ts', '.spec.ts') : file;
      nodes.push({ id: `${repo}::${path}::fn${i}`, repo, kind: i % 9 === 0 ? 'component' : 'function', name: `fn${i}`, group: path,
        loc: { repo, path, line: i % 200 }, project: { name: p.name, type: p.type, tags: p.tags } });
    }
    for (let k = 0; k < 20; k++) nodes.push({ id: `${repo}::package::dep${k}`, repo, kind: 'package', name: `dep${k}`, package: { scope: 'third-party' } });
    const first = nodes.length - 10_020;
    for (let i = 0; i < 1500; i++) {
      edges.push({ from: nodes[first + i * 6]!.id, to: `${repo}::package::dep${i % 20}`, kind: 'imports' });
      edges.push({ from: `${repo}::rule${i}`, to: nodes[(i * 7) % nodes.length]!.id, kind: 'validates' });
    }
  }
  return { nodes, edges, metas };
}

test('index, choices, two filters and a grouped fold over ≈20k nodes take well under two seconds', () => {
  const { nodes, edges, metas } = synthetic();
  assert.ok(nodes.length >= 20_000);
  const t0 = performance.now();
  const index = M.buildCodemapIndex(nodes, edges, metas);
  const choices = M.groupChoicesFor(index, null);
  const one = M.passFor(index, { projects: new Set(['alpha::alpha-p1', 'beta::beta-p4']) });
  const two = M.passFor(index, { projects: new Set(['alpha::alpha-p1', 'alpha::alpha-p6']), values: { domain: new Set(['ops']) }, dep: 'alpha::package::dep1' });
  const groups = M.foldGroups(nodes, 'domain', index);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  assert.deepEqual(choices.map((c: AnyRec) => c.key), ['none', 'project', 'domain', 'type']);
  assert.equal(index.projects.size, 30);
  assert.ok(one.size > 0 && two.size > 0 && two.size < one.size);
  assert.equal(groups.reduce((s: number, g: AnyRec) => s + g.members.length, 0), nodes.length, 'every card in one box');
});

// ── the proof: the set algebra against the per-node predicate it replaced ──
let nodes: GraphNode[];
let edges: GraphEdge[];
let meta: GraphMeta;

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'farsight-codemap-perf-'));
  const store = new GraphStore();
  for (const [name, dir] of [['nx-workspace', 'examples/nx-workspace'], ['invoice-app', 'examples/invoice-app']] as const) {
    store.addFragment(await ingestRepo(join(repoRoot, dir), { repoName: name }));
  }
  store.save(join(work, 'graph.json'));
  ({ nodes, edges, meta } = JSON.parse(readFileSync(join(work, 'graph.json'), 'utf8')));
  rmSync(work, { recursive: true, force: true });
});

/** The code map's filter as it was, one predicate per node (surfaces/codemap-projects.js before the index). */
function naive(f: { projects?: Set<string>; values?: Record<string, Set<string>>; closure?: { repo: string; names: Set<string> }; dep?: string }) {
  const m = meta.projects;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const projects = f.projects ?? new Set<string>();
  const values = f.values ?? {};
  const ok = (p: AnyRec | null) => {
    if (!p) return false;
    if (f.closure && (p.repo !== f.closure.repo || !f.closure.names.has(p.name))) return false;
    if (projects.size && !projects.has(p.repo + '::' + p.name)) return false;
    for (const [dim, set] of Object.entries(values)) {
      if (!set.size) continue;
      const vals = (M.projectFacets(p, m).byDimension[dim] || []).map((v: AnyRec) => v.value);
      if (!vals.some((v: string) => set.has(v))) return false;
    }
    return true;
  };
  const projectish = !!(f.closure || projects.size || Object.values(values).some((v) => v.size));
  let keep = new Set<string>();
  for (const n of nodes) if (n.kind !== 'package' && (!projectish || ok(M.projectOfItem(n, m)))) keep.add(n.id);
  for (const n of nodes) if (n.kind === 'package' && (!projectish || ok(M.projectOfItem(n, m)))) keep.add(n.id);
  for (const e of edges) if (e.kind === 'imports' && keep.has(e.from) && byId.get(e.to)?.kind === 'package') keep.add(e.to);
  if (f.dep) { const d = M.dependsOnIds(edges, f.dep); keep = new Set([...keep].filter((id) => d.has(id))); }
  return keep;
}
const sorted = (s: Set<string> | null) => [...(s ?? [])].sort();

test('the set algebra keeps what the per-node predicate kept', () => {
  const index = M.buildCodemapIndex(nodes, edges, meta.projects);
  // a package some billing part imports, read from the graph rather than named here
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const billingDep = edges.find((e) => e.kind === 'imports' && byId.get(e.to)?.kind === 'package'
    && (M.projectFacets(M.projectOfItem(byId.get(e.from), meta.projects), meta.projects).byDimension.domain || []).some((v: AnyRec) => v.value === 'billing'))!.to;
  const cases: { name: string; f: AnyRec }[] = [
    { name: 'projects', f: { projects: new Set(['nx-workspace::ops-admin', 'nx-workspace::shared-util']) } },
    { name: 'a tag', f: { values: { domain: new Set(['billing']) } } },
    { name: 'projects ∩ tag', f: { projects: new Set(['nx-workspace::billing-web', 'nx-workspace::ops-admin']), values: { domain: new Set(['billing']) } } },
    { name: 'two dimensions', f: { values: { domain: new Set(['billing', 'shared']), type: new Set(['ui']) } } },
    { name: 'depends on', f: { dep: 'invoice-app::package::zod' } },
    { name: 'tag and depends on', f: { values: { domain: new Set(['billing']) }, dep: billingDep } },
    { name: 'app closure', f: { closure: { repo: 'nx-workspace', names: new Set(appClosure(projectGraph(buildIndex(nodes, edges), meta.projects), 'billing-web')!.projects) } } },
  ];
  for (const { name, f } of cases) {
    const want = naive(f);
    assert.ok(want.size > 0, `${name}: the case keeps something`);
    assert.deepEqual(sorted(M.passFor(index, f)), sorted(want), name);
  }
  assert.equal(M.passFor(index, {}), null, 'nothing narrows: null');
});

test('the choices and the groups from the index are the folds they replace', () => {
  const index = M.buildCodemapIndex(nodes, edges, meta.projects);
  assert.deepEqual(M.groupChoicesFor(index, null), M.groupChoices(nodes, meta.projects));
  for (const repo of ['nx-workspace', 'invoice-app']) {
    assert.deepEqual(M.groupChoicesFor(index, new Set([repo])), M.groupChoices(nodes.filter((n) => n.id.startsWith(repo + '::')), meta.projects), repo);
  }
  for (const by of ['project', 'domain', 'type']) {
    for (const n of nodes) assert.deepEqual(M.groupKeyOf(n, by, index), M.groupOf(n, by, meta.projects), `${n.id} by ${by}`);
    const viaIndex = M.foldGroups(nodes, by, index).map((g: AnyRec) => [g.key, g.members.length, g.parts]);
    const viaFold = M.foldGroups(nodes, by, meta.projects).map((g: AnyRec) => [g.key, g.members.length, g.parts]);
    assert.deepEqual(viaIndex, viaFold, by);
  }
  // a test file's cards, by the file they live in
  assert.ok([...index.testFiles].every((id: string) => M.TEST_FILE.test(String(nodes.find((n) => n.id === id)!.loc?.path))));
});

test('an application’s closure on the page is core appClosure’s', () => {
  const pg = projectGraph(buildIndex(nodes, edges), meta.projects);
  for (const p of meta.projects!['nx-workspace']!.projects) {
    const core = appClosure(pg, p.name, 'nx-workspace')!;
    const page = M.projectClosure(meta.projects, 'nx-workspace', p.name);
    assert.deepEqual(page.projects, core.projects, p.name);
    assert.deepEqual(page.dependencies.map((d: AnyRec) => [d.from, d.to, d.imports]), core.dependencies.map((d) => [d.from, d.to, d.imports]), p.name);
    // …and the tree every ProjectRow carries
    assert.deepEqual(page.projects, pg.projects.find((r) => r.repo === 'nx-workspace' && r.name === p.name)!.closure, p.name + ' row');
  }
  assert.deepEqual(M.projectClosure(meta.projects, 'nx-workspace', 'no-such-project').projects, []);
});
