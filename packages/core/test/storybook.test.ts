// Stories (ADR 9): Storybook's id rules reproduced exactly, the index → node
// mapping in its three techniques and its named failures, and the live answer
// over a fake fetch — reachable, refused, and a body that is not an index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeStoryPart, storyNameFromExport, storyIdOf, autoTitleOf, storyFrameUrl, joinRepoPath,
  mapStoryIndex, storybookLive, storybooksOf, probeStorybook,
} from '../dist/storybook.js';
import type { GraphNode, StoriesMeta } from '../dist/graph.js';

test('story ids: the ones Storybook gives, for the names people write', () => {
  assert.equal(storyNameFromExport('AsLink'), 'As Link');
  assert.equal(storyNameFromExport('FullWidth'), 'Full Width');
  assert.equal(storyNameFromExport('with_icon'), 'With Icon');
  assert.equal(storyNameFromExport('Size2XL'), 'Size 2 XL');
  assert.equal(storyIdOf('Primitives/Button', 'AsLink'), 'primitives-button--as-link');
  assert.equal(storyIdOf('Patterns/Invoice/MoneyAmount', 'Negative'), 'patterns-invoice-moneyamount--negative');
  assert.equal(storyIdOf('Primitives/Inputs/TextInput', 'Default'), 'primitives-inputs-textinput--default');
  assert.equal(sanitizeStoryPart('  Hello, World!  '), 'hello-world');
});

test('auto-title: the path under the glob base, extension and a repeated last segment dropped', () => {
  assert.equal(autoTitleOf('components/Button/Button.stories.tsx'), 'components/Button');
  assert.equal(autoTitleOf('ui/index.stories.ts'), 'ui');
  assert.equal(autoTitleOf('Card.stories.tsx', 'Design'), 'Design/Card');
});

test('frame url and repo paths', () => {
  assert.equal(storyFrameUrl('http://localhost:6006/', 'a--b'), 'http://localhost:6006/iframe.html?id=a--b&viewMode=story');
  assert.equal(joinRepoPath('libs/ux/primitives', '../../../apps/web/src/x.tsx'), 'apps/web/src/x.tsx');
  assert.equal(joinRepoPath('.', './src/lib/button.tsx'), 'src/lib/button.tsx');
});

const node = (id: string, kind: GraphNode['kind'], path: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id: `r::${path}::${id}`, kind, name: id, loc: { repo: 'r', path, line: 1 }, tags: [], ...extra });

const nodes: GraphNode[] = [
  node('Button', 'component', 'lib/button.tsx', { stories: [{ id: 'primitives-button--primary', name: 'Primary', exportName: 'Primary', file: 'lib/button.stories.tsx', line: 3 }] }),
  node('Spinner', 'component', 'lib/feedback.tsx'),
  node('Skeleton', 'component', 'lib/feedback.tsx'),
  node('Card', 'component', 'lib/card.tsx'),
  node('CardHeader', 'component', 'lib/card.tsx'),
  node('Lonely', 'component', 'lib/lonely.tsx'),
  node('Twin', 'component', 'a/twin.tsx'),
  node('Twin', 'component', 'b/twin.tsx'),
];

test('mapStoryIndex: story id first, then the component file, then the title — and every miss named', () => {
  const entries = [
    { id: 'primitives-button--primary', title: 'Primitives/Button', name: 'Primary', type: 'story' as const, componentPath: './lib/button.tsx' },
    { id: 'primitives-button--hot', title: 'Primitives/Button', name: 'Hot', type: 'story' as const, componentPath: './lib/button.tsx' },
    { id: 'primitives-feedback-spinner--default', title: 'Primitives/Feedback/Spinner', name: 'Default', type: 'story' as const, componentPath: './lib/feedback.tsx' },
    { id: 'primitives-card--x', title: 'Primitives/Cardish', name: 'X', type: 'story' as const, componentPath: './lib/card.tsx' },
    { id: 'gone--x', title: 'Gone', name: 'X', type: 'story' as const, componentPath: './lib/gone.tsx' },
    { id: 'lonely--x', title: 'Misc/Lonely', name: 'X', type: 'story' as const },
    { id: 'twin--x', title: 'Twin', name: 'X', type: 'story' as const },
    { id: 'primitives-button--docs', title: 'Primitives/Button', name: 'Docs', type: 'docs' as const },
    { id: 'nobody--docs', title: 'Nobody', name: 'Docs', type: 'docs' as const },
  ];
  const r = Object.fromEntries(mapStoryIndex(entries, { root: '.' }, 'r', nodes).map((x) => [x.id, x]));
  assert.equal(r['primitives-button--primary']!.via, 'story-id');
  assert.equal(r['primitives-button--hot']!.via, 'component-path'); // a story added since the ingest: the file holds one component
  assert.equal(r['primitives-feedback-spinner--default']!.nodeId, 'r::lib/feedback.tsx::Spinner');
  assert.equal(r['primitives-feedback-spinner--default']!.via, 'component-path+title');
  assert.equal(r['primitives-card--x']!.reason, 'ambiguous');
  assert.deepEqual(r['primitives-card--x']!.candidates, ['r::lib/card.tsx::Card', 'r::lib/card.tsx::CardHeader']);
  assert.equal(r['gone--x']!.reason, 'no-node-at-path');
  assert.equal(r['gone--x']!.path, 'lib/gone.tsx');
  assert.equal(r['lonely--x']!.via, 'title');
  assert.equal(r['twin--x']!.reason, 'ambiguous');
  assert.equal(r['primitives-button--docs']!.via, 'docs-title');
  assert.equal(r['nobody--docs']!.reason, 'docs-no-story');
});

const meta: Record<string, StoriesMeta> = {
  r: { storybooks: [{ configDir: '.storybook', root: '.', url: 'http://sb.test:6006', urlFrom: 'config', command: 'npm run storybook', source: 'config' }], files: 1, stories: 1, components: 1, unresolved: [] },
};

test('storybookLive: a running index merges into the graph stories, with frames; notListed names what the index lacks', async () => {
  const fetcher = async (url: string) => {
    assert.equal(url, 'http://sb.test:6006/index.json');
    return { ok: true, status: 200, json: async () => ({ v: 5, entries: {
      'primitives-button--hot': { id: 'primitives-button--hot', title: 'Primitives/Button', name: 'Hot', type: 'story', componentPath: './lib/button.tsx' },
    } }) };
  };
  const a = await storybookLive(nodes, meta, { fetcher, fresh: true });
  const b = a.storybooks[0]!;
  assert.equal(b.reachable, true);
  assert.deepEqual(b.counts, { stories: 1, docs: 0, resolved: 1, unresolved: 0, via: { 'component-path': 1 } });
  // the matched count, typed: entries of this index, stories and docs pages told apart (docs/COUNTS.md)
  assert.deepEqual([b.counted!.matched.n, b.counted!.matched.of, b.counted!.matched.scope], [1, 1, 'count.scope.storybook']);
  assert.deepEqual(b.counted!.matched.breakdown!.map((p) => p.n), [1, 0]);
  assert.deepEqual(b.notListed, ['primitives-button--primary']);
  const list = a.byNode['r::lib/button.tsx::Button']!;
  assert.deepEqual(list.map((s) => [s.id, s.inGraph, s.live, !!s.frame]), [
    ['primitives-button--primary', true, false, false],
    ['primitives-button--hot', false, true, true],
  ]);
});

test('storybookLive: refused and not-an-index are "not reachable", never a throw — and the graph stories stay', async () => {
  const refused = async () => { const e = new TypeError('fetch failed') as TypeError & { cause?: unknown }; e.cause = { code: 'ECONNREFUSED' }; throw e; };
  const a = await storybookLive(nodes, meta, { fetcher: refused, fresh: true });
  assert.equal(a.storybooks[0]!.reachable, false);
  assert.equal(a.storybooks[0]!.error, 'refused');
  assert.equal(a.byNode['r::lib/button.tsx::Button']!.length, 1);
  const junk = await probeStorybook('http://sb.test:6006', { fresh: true, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }) });
  assert.deepEqual([junk.reachable, junk.error], [false, 'not a Storybook index']);
  const notHttp = await probeStorybook('file:///etc/passwd', { fresh: true });
  assert.equal(notHttp.reachable, false);
});

test('storybooksOf: a source setting overrides the recorded url', () => {
  const [one] = storybooksOf(meta, { r: { url: 'http://127.0.0.1:7007' } });
  assert.equal(one!.ref.url, 'http://127.0.0.1:7007');
  assert.equal(one!.ref.urlFrom, 'config');
});
