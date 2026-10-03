// Dependencies folded (docs/proposals/dependencies-and-nx.md §2.1, §2.3): packagesOf, importersOf,
// journeys reached through the impact walk, a package as an impact seed, trace stopping at a package,
// search leaving module nodes out, every number a sound Counted, and the diff schema's node-kind enum
// grown by exactly one member. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  buildIndex, packagesOf, importersOf, journeysReaching, resolvePackage, impactOf, trace, search, countedProblems, countedText, COUNT_SCOPES,
} from '../dist/index.js';
import type { GraphNode, GraphEdge, Counted } from '../dist/index.js';
import { validate } from './validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const schema = (name: string) => JSON.parse(readFileSync(join(repoRoot, 'schemas', name), 'utf8'));

const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string, meta?: GraphEdge['meta']): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(meta ? { meta } : {}) });
const loc = (path: string, line = 1) => ({ loc: { repo: 'app', path, line } });

// a flow whose screen renders a form that calls a formatter; the formatter uses date-fns,
// the form uses react; an admin script imports react too; one lib imported by alias
const nodes: GraphNode[] = [
  node('app::flow::checkout', 'flow', 'Checkout'),
  node('app::src/Page.tsx::Page', 'page', 'Page', loc('src/Page.tsx', 3)),
  node('app::src/Form.tsx::Form', 'component', 'Form', loc('src/Form.tsx', 4)),
  node('app::src/fmt.ts::fmt', 'function', 'fmt', loc('src/fmt.ts', 2)),
  node('app::scripts/seed.ts::seed', 'function', 'seed', loc('scripts/seed.ts', 2)),
  node('app::module::src/Form.tsx', 'module', 'src/Form.tsx', loc('src/Form.tsx')),
  node('app::module::src/fmt.ts', 'module', 'src/fmt.ts', loc('src/fmt.ts')),
  node('app::module::scripts/seed.ts', 'module', 'scripts/seed.ts', loc('scripts/seed.ts')),
  node('app::package::react', 'package', 'react', { package: { scope: 'third-party', version: '^18.3.1', declaredIn: ['package.json', 'scripts/package.json'],
    declarations: [{ path: 'package.json', range: '^18.3.1', field: 'dependencies' }, { path: 'scripts/package.json', range: '^17.0.2', field: 'devDependencies' }],
    note: 'declared at 2 different ranges' } }),
  node('app::package::date-fns', 'package', 'date-fns', { package: { scope: 'third-party', version: '^4.1.0', declaredIn: ['package.json'],
    declarations: [{ path: 'package.json', range: '^4.1.0', field: 'dependencies' }] } }),
  node('app::package::@app/money', 'package', '@app/money', { package: { scope: 'workspace', project: 'money', root: 'libs/money' } }),
  node('other::package::react', 'package', 'react', { package: { scope: 'third-party' } }),
];
const edges: GraphEdge[] = [
  edge('renders', 'app::flow::checkout', 'app::src/Page.tsx::Page', { line: 1 }),
  edge('renders', 'app::src/Page.tsx::Page', 'app::src/Form.tsx::Form', { line: 5 }),
  edge('calls', 'app::src/Form.tsx::Form', 'app::src/fmt.ts::fmt', { line: 7 }),
  edge('imports', 'app::module::src/Form.tsx', 'app::package::react', { specifier: 'react', line: 1, form: 'import', names: 'useState' }),
  edge('imports', 'app::src/Form.tsx::Form', 'app::package::react', { specifier: 'react', line: 6, use: true }),
  edge('imports', 'app::module::scripts/seed.ts', 'app::package::react', { specifier: 'react/jsx-runtime', line: 2, form: 'import', subpath: 'jsx-runtime' }),
  edge('imports', 'app::module::src/fmt.ts', 'app::package::date-fns', { specifier: 'date-fns', line: 1, form: 'import' }),
  edge('imports', 'app::src/fmt.ts::fmt', 'app::package::date-fns', { specifier: 'date-fns', line: 3, use: true }),
  edge('imports', 'app::module::src/fmt.ts', 'app::package::@app/money', { specifier: '@app/money', line: 2, form: 'import', typeOnly: true }),
  edge('calls', 'app::scripts/seed.ts::seed', 'app::src/fmt.ts::fmt', { line: 4 }),
];
const index = buildIndex(nodes, edges);

function sound(c: Counted, where: string) {
  assert.deepEqual(countedProblems(c, where), [], where);
}

test('packagesOf: one row per package node, with ranges, importers and journeys, every number a sound Counted', () => {
  const list = packagesOf(index);
  assert.deepEqual(list.rows.map((r) => `${r.repo}:${r.name}`), ['app:@app/money', 'app:date-fns', 'app:react', 'other:react']);
  sound(list.packages, 'packages');
  assert.equal(list.packages.n, 4);
  assert.deepEqual(list.packages.breakdown?.map((p) => `${p.key}:${p.n}`), ['count.part.packagesThirdParty:3', 'count.part.packagesWorkspace:1']);
  const react = list.rows.find((r) => r.id === 'app::package::react')!;
  assert.equal(react.importers.n, 2, 'two files import it');
  assert.equal(countedText(react.importers), '2 files import it for this package');
  assert.deepEqual(react.versions, [
    { where: 'app', range: '^18.3.1', declaredIn: 'package.json', field: 'dependencies' },
    { where: 'app/scripts', range: '^17.0.2', declaredIn: 'scripts/package.json', field: 'devDependencies' },
  ]);
  assert.deepEqual(react.journeyRefs, [{ id: 'app::flow::checkout', name: 'Checkout' }]);
  assert.equal(react.journeys.n, 1);
  for (const r of list.rows) { sound(r.importers, `${r.id} importers`); sound(r.journeys, `${r.id} journeys`); }
  assert.ok(COUNT_SCOPES.includes('count.scope.package'));
});

test('journeys reached: through the code that uses the package, met by the journey’s walk', () => {
  assert.deepEqual(journeysReaching(index, 'app::package::date-fns').map((j) => j.name), ['Checkout'], 'fmt is on the checkout walk');
  assert.deepEqual(journeysReaching(index, 'app::package::@app/money'), [], 'a type-only import by a file reaches nothing');
  assert.deepEqual(journeysReaching(index, 'nope'), []);
});

test('packagesOf filters: repo, scope, project', () => {
  assert.deepEqual(packagesOf(index, { repo: 'other' }).rows.map((r) => r.id), ['other::package::react']);
  assert.deepEqual(packagesOf(index, { scope: 'workspace' }).rows.map((r) => r.name), ['@app/money']);
  assert.deepEqual(packagesOf(index, { project: 'money' }).rows.map((r) => r.name), ['@app/money']);
});

test('importersOf: every importing file with line, specifier and the code in it that uses the package; groups partition the files', () => {
  const w = importersOf(index, 'app::package::react')!;
  assert.equal(w.groups.length, 1);
  assert.equal(w.groups[0]!.by, 'repo');
  assert.deepEqual(w.groups[0]!.importers.map((i) => `${i.path}:${i.line} ${i.specifier}${i.subpath ? ` (${i.subpath})` : ''} ← ${i.users.map((u) => u.name).join(',')}`),
    ['scripts/seed.ts:2 react/jsx-runtime (jsx-runtime) ← ', 'src/Form.tsx:1 react ← Form']);
  sound(w.importers, 'importers');
  assert.equal(w.importers.breakdown?.reduce((a, p) => a + p.n, 0), w.importers.n);
  assert.equal(importersOf(index, 'app::src/fmt.ts::fmt'), undefined, 'only a package node has importers');
  // grouped by project when the graph carries projects
  const withProjects = buildIndex(nodes.map((n) => n.id === 'app::module::scripts/seed.ts' ? { ...n, project: { name: 'tools', root: 'scripts' } }
    : n.id === 'app::module::src/Form.tsx' ? { ...n, project: { name: 'web', root: 'src' } } : n), edges);
  assert.deepEqual(importersOf(withProjects, 'app::package::react')!.groups.map((g) => `${g.by}:${g.key}:${g.count.n}`), ['project:tools:1', 'project:web:1']);
  assert.deepEqual(packagesOf(withProjects, { project: 'tools' }).rows.map((r) => r.id), ['app::package::react']);
});

test('resolvePackage: an id, or a name only one source imports', () => {
  assert.equal(resolvePackage(index, 'date-fns').hit?.id, 'app::package::date-fns');
  assert.equal(resolvePackage(index, 'react').hit, undefined);
  assert.deepEqual(resolvePackage(index, 'react').candidates, ['app::package::react', 'other::package::react']);
  assert.equal(resolvePackage(index, 'react', 'other').hit?.id, 'other::package::react');
  assert.equal(resolvePackage(index, 'app::src/fmt.ts::fmt').hit, undefined, 'a function id is no package');
});

test('a package is an impact seed: imports edges are walked upstream like any other', () => {
  const r = impactOf(index, 'app::package::date-fns', { hops: 3 });
  assert.deepEqual(r.hops[0]!.nodes.map((n) => n.nodeId).sort(), ['app::module::src/fmt.ts', 'app::src/fmt.ts::fmt']);
  assert.deepEqual(r.hops[1]!.nodes.map((n) => n.nodeId).sort(), ['app::scripts/seed.ts::seed', 'app::src/Form.tsx::Form']);
  assert.equal(r.hops[0]!.nodes.find((n) => n.nodeId === 'app::src/fmt.ts::fmt')!.via.kind, 'imports');
});

test('trace stops at a package instead of crossing it as a hub; search leaves module nodes out unless asked', () => {
  const slice = trace(index, ['app::src/fmt.ts::fmt'], 'both', 3).nodes.map((n) => n.id);
  assert.ok(slice.includes('app::package::date-fns'), 'the package is in the slice');
  // from Form: react is met, and seed (which only reaches react through the package) is not pulled in by it
  const fromForm = trace(index, ['app::src/Form.tsx::Form'], 'both', 2).nodes.map((n) => n.id);
  assert.ok(fromForm.includes('app::package::react'));
  assert.ok(!fromForm.includes('app::module::scripts/seed.ts'), 'react is not a hub the slice crosses');
  assert.ok(trace(index, ['app::package::react'], 'both', 1).nodes.some((n) => n.id === 'app::module::scripts/seed.ts'), 'a seed package still expands');
  assert.ok(!search(index, 'Form').some((n) => n.kind === 'module'));
  assert.ok(search(index, 'Form', { kind: 'module' }).some((n) => n.id === 'app::module::src/Form.tsx'));
  assert.equal(search(index, 'date-fns')[0]!.id, 'app::package::date-fns', 'search matches package names');
});

test('farsight-diff v1: the nodeKind enum grew by package, additively', () => {
  const s = schema('farsight-diff-v1.schema.json');
  assert.deepEqual(s.$defs.nodeKind.enum, [
    'repo', 'module', 'file', 'class', 'function', 'component', 'page',
    'route', 'table', 'queue', 'rule', 'guard', 'flag', 'external',
    'api', 'design', 'flow', 'test', 'unknown', 'work', 'package',
  ]);
  assert.deepEqual(validate('package', s.$defs.nodeKind), []);
  assert.ok(validate('dependency', s.$defs.nodeKind).length > 0, 'the enumeration is still closed');
});
