import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../dist/index.js';
import { deserializeGraph, indexGraph, reachable, validateGraph } from '@farsight/graph';

test('saved multi-source application graphs export without local bookkeeping or losing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portable-export-'));
  try {
    const store = new GraphStore();
    for (const repo of ['beta', 'alpha']) {
      store.roots[repo] = join(dir, repo);
      store.addFragment({ repo, nodes: [{ id: `${repo}::save`, kind: 'function', name: 'save', tags: [],
        loc: { repo, path: 'src/save.ts', line: 1 } }], edges: [],
      meta: { files: 1, sourceHash: 'mtime', sourceDigest: `${repo}-digest`, stores: { drivers: [{ spec: 'pg', files: 1 }] },
        routes: { gaps: [{ kind: 'non-literal-path', path: 'src/controller.ts', line: 1, name: 'Controller', text: `${repo} has an unread route.` }] } } });
    }
    store.addFragment({ repo: 'alpha', nodes: [], edges: [{ id: 'cross', from: 'alpha::save', to: 'beta::save', kind: 'calls',
      resolution: { status: 'heuristic', technique: 'detected', confidence: 'MEDIUM', note: 'Retain the uncertainty.' } }] });
    store.meta.sync = 7; store.meta.digest = 'snapshot'; store.meta.commit = 'commit'; store.meta.tz = 'UTC';
    const path = join(dir, 'graph.json'); store.save(path);
    const loaded = GraphStore.load(path);
    const before = JSON.stringify(loaded.toJSON());
    const document = loaded.toDocument('merged-service');
    assert.equal(validateGraph(document).valid, true);
    assert.deepEqual(document.sources?.map(source => source.repo), ['alpha', 'beta']);
    assert.deepEqual(document.sources?.map(source => source.meta?.sourceDigest), ['alpha-digest', 'beta-digest']);
    assert.deepEqual(document.sources?.[0]?.meta?.stores, { drivers: [{ spec: 'pg', files: 1 }] });
    assert.equal(document.graph.meta?.sourceDigest, loaded.meta.sourceDigest);
    for (const source of document.sources ?? []) assert.deepEqual(source.meta?.routes, loaded.meta.routes?.[source.repo]);
    assert.deepEqual(document.graph.edges, loaded.allEdges());
    const json = JSON.stringify(document);
    for (const field of ['sourceHash', 'generatedAt', 'graphPath', 'workspace', 'roots', 'farsight', 'sync']) assert.ok(!json.includes(`"${field}":`), field);
    assert.ok(!json.includes(dir));
    assert.deepEqual(reachable(indexGraph(deserializeGraph(json).graph), ['alpha::save']), ['alpha::save', 'beta::save']);
    assert.equal(JSON.stringify(loaded.toJSON()), before);
    assert.equal(new GraphStore().toDocument().graph.meta, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
