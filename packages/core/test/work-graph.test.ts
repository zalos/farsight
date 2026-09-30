// Work items in the graph (docs/proposals/work-items-sync.md §9): the `work`
// node, the `tracks` edge, key detection, hunks → nodes, and the folds the
// /api/work routes print. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIndex, workNodeOf, workNodeId, parseWorkNodeId, tracksEdgeOf, applyWorkToFragment, workToFragment, strongestLinks,
  detectWorkKeysFallback, commitKeysOf, mergeSubjectBranch, hunksOfPatch, nodesTouched,
  itemsByState, itemsByType, itemSummaryOf, touchedCount, workFindings, filterWorkItems, countedProblems, impactOf,
  WORK_LINK_VIAS, COMMIT_KEY_VIAS, WORK_FINDING_KINDS, COUNT_SCOPES, STRINGS,
} from '../dist/index.js';
import type { GraphFragment, GraphNode, WorkItemFacts, WorkLinkFact } from '../dist/index.js';
import { validate } from './validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = (n: string) => JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', n), 'utf8'));

const item = (key: string, state: string, extra: Partial<WorkItemFacts> = {}): WorkItemFacts => ({
  id: workNodeId('jira-test', key), source: 'jira-test', provider: 'jira', key,
  url: `https://example.atlassian.net/browse/${key}`,
  type: { name: 'Story', category: 'story' }, title: `Title of ${key}`,
  state: { name: state === 'todo' ? 'To Do' : state === 'done' ? 'Done' : 'In Progress', category: state },
  labels: [], updated: '2026-09-30T00:00:00Z', ...extra,
});

const fn = (name: string, path: string, line: number): GraphNode =>
  ({ id: `app::${path}::${name}`, kind: 'function', name, tags: [], loc: { repo: 'app', path, line } } as GraphNode);

test('a work node: id work::<source>::<key>, name = key, business label = title, tags, a tracker link, no loc', () => {
  const n = workNodeOf(item('KAN-3', 'in-progress', { assignee: { id: 'u1', name: 'Jared' } }));
  assert.equal(n.id, 'work::jira-test::KAN-3');
  assert.equal(n.kind, 'work');
  assert.equal(n.name, 'KAN-3');
  assert.equal(n.facets?.business?.label, 'Title of KAN-3');
  for (const tag of ['work', 'provider:jira', 'state:in-progress', 'type:story']) assert.ok(n.tags.includes(tag), tag);
  assert.deepEqual(n.links, [{ kind: 'see', url: 'https://example.atlassian.net/browse/KAN-3' }]);
  assert.equal(n.loc, undefined);
  assert.deepEqual(parseWorkNodeId(n.id), { source: 'jira-test', key: 'KAN-3' });
  assert.equal(parseWorkNodeId('app::src/a.ts::f'), null);
});

test('a tracks edge: declared resolves by annotation HIGH; detected is heuristic by work-key', () => {
  const d = tracksEdgeOf({ work: 'work::s::K-1', node: 'app::a.ts::f', via: 'declared', tier: 'HIGH' });
  assert.equal(d.kind, 'tracks');
  assert.deepEqual(d.resolution, { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' });
  const c = tracksEdgeOf({ work: 'work::s::K-1', node: 'app::a.ts::f', via: 'commit', tier: 'MEDIUM', sha: 'abc' });
  assert.deepEqual(c.resolution, { status: 'heuristic', technique: 'work-key', confidence: 'MEDIUM' });
  assert.equal(c.meta?.via, 'commit');
  assert.equal(c.meta?.sha, 'abc');
});

test('the enums are pinned: vias, commit vias, findings, and the schema enums grew additively', () => {
  assert.deepEqual([...WORK_LINK_VIAS], ['declared', 'commit', 'branch', 'url']);
  assert.deepEqual([...COMMIT_KEY_VIAS], ['subject', 'branch', 'merge-subject', 'url']);
  assert.deepEqual([...WORK_FINDING_KINDS], ['done-not-built', 'todo-but-committed']);
  assert.ok(schema('farsight-impact-tests-v1.schema.json').$defs.edgeKind.enum.includes('tracks'));
  assert.ok(schema('farsight-diff-v1.schema.json').$defs.technique.enum.includes('work-key'));
  assert.ok(schema('farsight-diff-v1.schema.json').$defs.nodeKind.enum.includes('work'));
  assert.ok(COUNT_SCOPES.includes('count.scope.workItem'));
});

test('applyWorkToFragment: one node per item, the strongest link per pair, a link to nowhere dropped and counted', () => {
  const f: GraphFragment = { repo: 'app', nodes: [fn('submit', 'src/a.ts', 3)], edges: [] };
  const w = 'work::jira-test::KAN-3';
  const links: WorkLinkFact[] = [
    { work: w, node: 'app::src/a.ts::submit', via: 'branch', tier: 'MEDIUM' },
    { work: w, node: 'app::src/a.ts::submit', via: 'declared', tier: 'HIGH' },
    { work: w, node: 'app::src/gone.ts::x', via: 'commit', tier: 'MEDIUM' },
  ];
  const r = applyWorkToFragment(f, [item('KAN-3', 'todo')], links);
  assert.deepEqual(r, { nodes: 1, edges: 1, dropped: 1 });
  const e = f.edges.find((x) => x.kind === 'tracks')!;
  assert.equal(e.meta?.via, 'declared');
  assert.equal(strongestLinks(links).length, 2);
  // the standalone variant against a store's node set
  const frag = workToFragment([item('KAN-3', 'todo')], links, { known: (id) => id === 'app::src/gone.ts::x' });
  assert.equal(frag.repo, 'work');
  assert.equal(frag.applied.edges, 1);
  assert.equal(frag.meta, undefined, 'a work fragment carries no files and claims no freshness');
});

test('impact never walks a tracks edge: a work item is not a dependent of the code it names', () => {
  const a = fn('a', 'src/a.ts', 1);
  const b = fn('b', 'src/b.ts', 1);
  const f: GraphFragment = { repo: 'app', nodes: [a, b], edges: [{ id: 'c', kind: 'calls', from: b.id, to: a.id }] };
  applyWorkToFragment(f, [item('KAN-1', 'todo')], [{ work: 'work::jira-test::KAN-1', node: a.id, via: 'declared', tier: 'HIGH' }]);
  const r = impactOf(buildIndex(f.nodes, f.edges), a.id, { hops: 3 });
  assert.deepEqual(r.hops.flatMap((h) => h.nodes.map((n) => n.kind)), ['function']);
});

test('key detection: known projects, merge subjects, URLs, branches — and SHA-256 / #12 are not keys', () => {
  const opts = { projects: ['KAN'] };
  assert.deepEqual(detectWorkKeysFallback('KAN-1: add login', 'subject', opts).map((d) => d.key), ['KAN-1']);
  assert.deepEqual(detectWorkKeysFallback('hash with SHA-256 and UTF-8', 'subject', { projects: ['SHA', 'KAN'] }), [], 'false friends refused even when configured');
  assert.deepEqual(detectWorkKeysFallback('fix #12', 'subject', {}), [], 'no ADO source: #12 is not a work item');
  assert.deepEqual(detectWorkKeysFallback('fix #12 and AB#40', 'subject', { ado: true }).map((d) => d.key), ['12', '40']);
  assert.deepEqual(detectWorkKeysFallback('feature/kan-2-thing', 'branch', opts).map((d) => d.key), ['KAN-2']);
  assert.deepEqual(detectWorkKeysFallback('feature/kan-2-thing', 'branch', {}), [], 'a branch key needs a configured project');
  assert.deepEqual(detectWorkKeysFallback('KAN-1 with no configured project', 'subject', {}), [], 'no configured project: no Jira key');
  assert.deepEqual(detectWorkKeysFallback('screens INV-01 and INV-02 built', 'subject', { projects: ['INV'] }), [], 'a design screen name is not a work key');
  assert.deepEqual(detectWorkKeysFallback('INV-3 list', 'subject', { projects: ['INV'] }).map((d) => d.key), ['INV-3']);
  assert.deepEqual(detectWorkKeysFallback('users/jared/4711-fix', 'branch', { ado: true }).map((d) => d.key), ['4711']);
  const url = detectWorkKeysFallback('see https://x.atlassian.net/browse/KAN-9 please', 'body', opts);
  assert.deepEqual(url, [{ key: 'KAN-9', provider: 'jira', form: 'url' }]);
  const ado = detectWorkKeysFallback('https://dev.azure.com/org/Proj/_workitems/edit/77', 'body', { ado: true });
  assert.deepEqual(ado, [{ key: '77', provider: 'azure-devops', form: 'url' }]);

  assert.equal(mergeSubjectBranch("Merge branch 'feature/KAN-1-x'"), 'feature/KAN-1-x');
  assert.equal(mergeSubjectBranch('Merge pull request #12 from org/KAN-4-y'), 'org/KAN-4-y');
  const merge = commitKeysOf({ subject: 'Merge pull request #12 from org/KAN-4-y', merge: true }, [], { projects: ['KAN'], ado: true });
  assert.deepEqual(merge, [{ key: 'KAN-4', provider: 'jira', via: 'merge-subject', ref: 'org/KAN-4-y' }], 'the PR number is never a work item');
  const both = commitKeysOf({ subject: 'KAN-1 tidy', body: 'Refs https://x.atlassian.net/browse/KAN-5' }, ['feature/KAN-2-x'], opts);
  assert.deepEqual(both.map((k) => `${k.key}:${k.via}`), ['KAN-1:subject', 'KAN-5:url', 'KAN-2:branch']);
});

test('hunks → nodes: the definition a changed line sits in, not every function in the file', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -12,2 +12,3 @@ function two', '+x', '@@ -40 +41,0 @@', '-y',
    'diff --git a/img.png b/img.png', 'Binary files differ',
  ].join('\n');
  const hunks = hunksOfPatch(patch);
  assert.deepEqual(hunks, [{ path: 'src/a.ts', ranges: [[12, 14], [41, 41]] }]);
  const nodes = [fn('one', 'src/a.ts', 1), fn('two', 'src/a.ts', 10), fn('three', 'src/a.ts', 20), fn('four', 'src/a.ts', 38), fn('other', 'src/b.ts', 1)];
  const r = nodesTouched(nodes, hunks[0]!);
  assert.deepEqual(r.nodes.map((n) => n.name).sort(), ['four', 'two']);
  assert.equal(r.fileOnly, false);
  const whole = nodesTouched(nodes, { path: 'src/a.ts', ranges: [] });
  assert.equal(whole.fileOnly, true);
  assert.equal(whole.nodes.length, 4);
});

test('the folds: counts are Counteds that sum, and the two findings carry both provenances', () => {
  const items = [item('KAN-1', 'todo'), item('KAN-2', 'done'), item('KAN-3', 'in-progress', { type: { name: 'Bug', category: 'bug' } })];
  const byState = itemsByState(items, 'count.scope.workspace', 'test');
  assert.deepEqual(countedProblems(byState), []);
  assert.deepEqual(byState.breakdown!.map((p) => [p.key, p.n]), [['count.part.workTodo', 1], ['count.part.workInProgress', 1], ['count.part.workDone', 1]]);
  assert.deepEqual(countedProblems(itemsByType(items, 'journey.scopeAll', 'test')), []);

  const screen = { id: 'app::page::/signup', kind: 'page', name: '/signup', tags: [], design: { status: 'design-only', origin: 'manifest', id: 'ON-01' }, facets: { business: { label: 'Sign up' } } } as GraphNode;
  const index = buildIndex([screen, fn('a', 'src/a.ts', 1)], []);
  const links: WorkLinkFact[] = [
    { work: items[1]!.id, node: screen.id, via: 'declared', tier: 'HIGH' },
    { work: items[0]!.id, node: 'app::src/a.ts::a', via: 'commit', tier: 'MEDIUM', sha: 's1' },
  ];
  const s = itemSummaryOf(items[0]!, { links, commits: 4 });
  assert.deepEqual(countedProblems(s.links), []);
  assert.deepEqual(countedProblems(s.commits), []);
  assert.equal(s.commits.n, 4);
  assert.deepEqual(s.links.breakdown, [{ key: 'work.count.via.commit', n: 1 }]);
  const touched = touchedCount(index, ['app::src/a.ts::a', 'app::src/a.ts::a', screen.id]);
  assert.equal(touched.n, 2);
  assert.deepEqual(countedProblems(touched), []);

  const done = workFindings(items[1]!, index, { links, commits: 0 });
  assert.equal(done.length, 1);
  assert.equal(done[0]!.kind, 'done-not-built');
  assert.equal(done[0]!.text, 'KAN-2 is done; its screen Sign up is not built');
  assert.deepEqual(done[0]!.provenances.map((p) => p.source), ['tracker', 'code']);
  const todo = workFindings(items[0]!, index, { links, commits: 4 });
  assert.equal(todo[0]!.text, 'KAN-1 is to do; 4 commits name it');
  const one = workFindings(items[0]!, index, { links, commits: 1 })[0]!;
  assert.equal(one.text, 'KAN-1 is to do; 1 commit names it');
  assert.equal(one.provenances[1]!.what, '1 commit on the history spine names KAN-1');
  assert.equal(todo[0]!.provenances[1]!.what, '4 commits on the history spine name KAN-1');
  assert.deepEqual(workFindings(items[2]!, index, { links, commits: 9 }), []);

  assert.deepEqual(filterWorkItems(items, links, { node: screen.id }, index).map((i) => i.key), ['KAN-2']);
  assert.deepEqual(filterWorkItems(items, links, { q: 'kan-3' }, index).map((i) => i.key), ['KAN-3']);
  assert.deepEqual(filterWorkItems(items, links, { state: 'todo' }, index).map((i) => i.key), ['KAN-1']);
});

test('every work.* string has both registers, and every counted unit a define and a {n}', () => {
  const keys = Object.keys(STRINGS).filter((k) => k.startsWith('work.'));
  assert.ok(keys.length > 20);
  for (const k of keys) {
    const e = STRINGS[k]!;
    assert.ok(e.hud && e.professional, k);
    if (k.startsWith('work.count.') && !k.endsWith('One')) assert.match(e.professional, /\{n\}/, k);
  }
});

test('a diff document carrying a work node and a work-key technique validates', () => {
  const s = schema('farsight-diff-v1.schema.json');
  assert.deepEqual(validate('work', s.$defs.nodeKind), []);
  assert.deepEqual(validate('work-key', s.$defs.technique), []);
});
