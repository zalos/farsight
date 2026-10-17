import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../dist/index.js';
import { occurrenceId, type GraphEdge } from '@farsight/graph';

test('relationship storage unions sites, retains them across save/load and re-identifies retargeted evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-sites-'));
  try {
    const store = new GraphStore();
    const edge: GraphEdge = { id: 'one', kind: 'calls', from: 'r::a', to: 'r::b' };
    const site = (col: number) => {
      const value = { loc: { repo: 'r', path: 'src/a.ts', line: 1, col }, span: { start: col - 1, end: col + 2 } };
      return { id: occurrenceId(edge, value), ...value };
    };
    store.addFragment({ repo: 'r', nodes: ['a', 'b', 'c'].map(name => ({ id: `r::${name}`, name, kind: 'function', tags: [] })),
      edges: [{ ...edge, occurrences: [site(1)] }, { ...edge, id: 'two', occurrences: [site(6)] }] });
    assert.equal(store.allEdges().length, 1);
    assert.equal(store.allEdges()[0]!.occurrences?.length, 2);
    const file = join(dir, 'saved.json'); store.save(file);
    const loaded = GraphStore.load(file);
    assert.deepEqual(loaded.allEdges(), store.allEdges());
    const previous = loaded.allEdges()[0]!;
    loaded.replaceEdge(previous.id, { ...previous, to: 'r::c' });
    const changed = loaded.allEdges()[0]!;
    assert.equal(changed.occurrences?.length, 2);
    for (const occurrence of changed.occurrences!) assert.equal(occurrence.id, occurrenceId(changed, occurrence));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
