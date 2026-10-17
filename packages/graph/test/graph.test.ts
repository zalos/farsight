import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphDocument, serializeGraph, deserializeGraph, validateGraph, indexGraph, reachable, occurrenceId, mergeOccurrences } from '../dist/index.js';
import type { GraphFragment } from '../dist/index.js';

const graph = (): GraphFragment => ({ repo: 'r', nodes: [
  { id: 'r::b', kind: 'function', name: 'b', tags: [] },
  { id: 'r::a', kind: 'function', name: 'a', tags: [], loc: { repo: 'r', path: 'a.ts', line: 1 } },
], edges: [{ id: 'e', kind: 'calls', from: 'r::a', to: 'r::b', resolution: { status: 'resolved', technique: 'same-file', confidence: 'HIGH' } }],
meta: { files: 1, sourceHash: 'volatile', sourceDigest: 'unchanged' } });

test('versioned round trip preserves every enrichment and resolution field, removing only sourceHash', () => {
  const value = graph(); value.nodes[0]!.facets = { business: { label: 'Save' } };
  const doc = deserializeGraph(serializeGraph(value));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.graph.meta?.sourceDigest, 'unchanged');
  assert.ok(!('sourceHash' in doc.graph.meta!));
  assert.deepEqual(doc.graph.nodes.find(n => n.id === 'r::b')?.facets, value.nodes[0]!.facets);
  assert.deepEqual(doc.graph.edges, value.edges);
  assert.equal(serializeGraph(doc.graph), serializeGraph(value));
});

test('runtime validation rejects wrong enums, invalid nested evidence, duplicate ids and dangling edges', () => {
  for (const mutate of [
    (v: any) => { v.schemaVersion = 2; },
    (v: any) => { v.graph.nodes[0].kind = 'made-up'; },
    (v: any) => { v.graph.edges[0].resolution.confidence = 'CERTAIN'; },
    (v: any) => { v.graph.nodes.push(v.graph.nodes[0]); },
    (v: any) => { v.graph.edges[0].to = 'missing'; },
    (v: any) => { v.graph.nodes[0].loc = { repo: 'r', path: 'a.ts', line: 0 }; },
  ]) {
    const value = graphDocument(graph()); mutate(value);
    assert.equal(validateGraph(value).valid, false);
    assert.throws(() => deserializeGraph(JSON.stringify(value)), /Invalid farsight-graph/);
  }
});

test('traversal is cycle-safe, directional, bounded and does not refold evidence', () => {
  const value = graph(); value.edges.push({ id: 'back', kind: 'calls', from: 'r::b', to: 'r::a' });
  const before = JSON.stringify(value); const index = indexGraph(value);
  assert.deepEqual(reachable(index, ['r::a'], { maxDepth: 0 }), ['r::a']);
  assert.deepEqual(reachable(index, ['r::b'], { direction: 'incoming' }), ['r::b', 'r::a']);
  assert.deepEqual(reachable(index, ['r::a'], { kinds: ['writes'] }), ['r::a']);
  assert.equal(JSON.stringify(value), before);
});

test('occurrence identities depend on source span and relationship and merges retain separate sites', () => {
  const edge = graph().edges[0]!;
  const a = { loc: { repo: 'r', path: 'a.ts', line: 1, col: 1 }, span: { start: 0, end: 3 } };
  const b = { ...a, span: { start: 5, end: 8 } };
  const first = { ...a, id: occurrenceId(edge, a) }; const second = { ...b, id: occurrenceId(edge, b) };
  assert.notEqual(first.id, second.id);
  assert.equal(mergeOccurrences([first], [first, second])?.length, 2);
});
