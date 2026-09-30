// GraphStore freshness meta: the per-repo record (files · sourceHash · sourceDigest)
// survives a save → load round trip, `repoMeta()` answers from it, and a graph
// written before the content digest still loads.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../dist/index.js';
import type { GraphNode } from '../dist/index.js';

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-store-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

const node = (id: string): GraphNode =>
  ({ id, kind: 'function', name: id.split('::').pop()!, tags: [] }) as GraphNode;

test('repoMeta answers per repo, and the fold is the single repo\'s own digest', () => {
  const store = new GraphStore();
  store.addFragment({
    repo: 'shop', nodes: [node('shop::a.ts::alpha')], edges: [],
    meta: { files: 12, sourceHash: 'aaaaaaaaaaaa', sourceDigest: 'dddddddddddd' },
  });
  assert.deepEqual(store.repoMeta('shop'), { files: 12, sourceHash: 'aaaaaaaaaaaa', sourceDigest: 'dddddddddddd' });
  assert.equal(store.meta.sourceDigest, 'dddddddddddd');
  assert.equal(store.repoMeta('nothing-here'), undefined);
});

test('two repos: files sum, hash and digest fold, and each repo keeps its own', () => {
  const store = new GraphStore();
  store.addFragment({ repo: 'a', nodes: [node('a::x.ts::x')], edges: [], meta: { files: 2, sourceHash: 'a1a1a1a1a1a1', sourceDigest: 'a2a2a2a2a2a2' } });
  store.addFragment({ repo: 'b', nodes: [node('b::y.ts::y')], edges: [], meta: { files: 3, sourceHash: 'b1b1b1b1b1b1' } });
  assert.equal(store.meta.files, 5);
  assert.equal(store.repoMeta('a')!.sourceDigest, 'a2a2a2a2a2a2');
  // b carried no digest, so it has none — the fold is not b's hash borrowed
  assert.equal(store.repoMeta('b')!.sourceDigest, undefined);
  assert.equal(store.meta.sourceDigest!.length, 12);
  assert.notEqual(store.meta.sourceDigest, 'a2a2a2a2a2a2');
});

test('save → load keeps meta.sourceDigest and every repoMeta row', () => {
  const store = new GraphStore();
  store.addFragment({ repo: 'a', nodes: [node('a::x.ts::x')], edges: [], meta: { files: 2, sourceHash: 'a1a1a1a1a1a1', sourceDigest: 'a2a2a2a2a2a2' } });
  store.addFragment({ repo: 'b', nodes: [node('b::y.ts::y')], edges: [], meta: { files: 3, sourceHash: 'b1b1b1b1b1b1', sourceDigest: 'b2b2b2b2b2b2' } });
  const folded = store.meta.sourceDigest;
  const path = tempFile('graph.json');
  store.save(path);

  const back = GraphStore.load(path);
  assert.equal(back.meta.sourceDigest, folded);
  assert.equal(back.meta.sourceHash, store.meta.sourceHash);
  assert.deepEqual(back.repoMeta('a'), { files: 2, sourceHash: 'a1a1a1a1a1a1', sourceDigest: 'a2a2a2a2a2a2' });
  assert.deepEqual(back.repoMeta('b'), { files: 3, sourceHash: 'b1b1b1b1b1b1', sourceDigest: 'b2b2b2b2b2b2' });
  assert.equal(back.stats().nodes, 2);
});

test('re-adding a repo as a meta-less fragment keeps every row and the digest (the `tests import` path)', () => {
  const store = new GraphStore();
  store.addFragment({ repo: 'a', nodes: [node('a::x.ts::x')], edges: [], meta: { files: 2, sourceHash: 'a1a1a1a1a1a1', sourceDigest: 'a2a2a2a2a2a2' } });
  const path = tempFile('graph.json');
  store.save(path);

  // what `farsight tests import` does: load, re-add the whole graph as one fragment, save
  const back = GraphStore.load(path);
  back.addFragment({ repo: 'a', nodes: [node('a::x.ts::x'), node('a::z.ts::z')], edges: [] });
  assert.equal(back.meta.sourceDigest, 'a2a2a2a2a2a2');
  assert.deepEqual(back.repoMeta('a'), { files: 2, sourceHash: 'a1a1a1a1a1a1', sourceDigest: 'a2a2a2a2a2a2' });
  assert.equal(back.stats().nodes, 2);

  // but a fragment whose sourceHash has actually moved drops the digest instead of keeping a stale one
  back.addFragment({ repo: 'a', nodes: [node('a::x.ts::x')], edges: [], meta: { files: 2, sourceHash: 'moved0000000' } });
  assert.equal(back.repoMeta('a')!.sourceDigest, undefined);
  assert.equal(back.meta.sourceDigest, undefined);
});

test('a graph written before the content digest still loads; repoMeta simply has no answer', () => {
  const path = tempFile('legacy.json');
  writeFileSync(path, JSON.stringify({
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', files: 4, sourceHash: 'legacy000000' },
    roots: {}, nodes: [node('a::x.ts::x')], edges: [],
  }));
  const back = GraphStore.load(path);
  assert.equal(back.meta.sourceHash, 'legacy000000');
  assert.equal(back.meta.sourceDigest, undefined);
  assert.equal(back.repoMeta('a'), undefined);
  // and saving it again does not invent one
  const out = tempFile('legacy-again.json');
  back.save(out);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).meta.sourceDigest, undefined);
});
