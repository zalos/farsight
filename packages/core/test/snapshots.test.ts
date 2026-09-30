// SnapshotDb tests: write→read→digest round trip, SCD2 interval correctness
// (inspected directly in the db file), changedBetween, prune-keeps-pinned,
// and the honest degraded mode. Skipped wholesale on a runtime without
// node:sqlite — which is itself the degraded mode working as designed.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore, SnapshotDb, digestOf, sqliteAvailable } from '../dist/index.js';
import type { GraphNode, GraphEdge } from '../dist/index.js';

const available = sqliteAvailable();
const opts = { skip: available ? false : 'node:sqlite unavailable on this runtime — degraded mode has no history to test' };

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-snap-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'farsight.db');
}

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind: 'function', name: id.split('::').pop()!, tags: [], ...extra }) as GraphNode;
const edge = (kind: GraphEdge['kind'], from: string, to: string): GraphEdge =>
  ({ id: '', kind, from, to });
const mkStore = (nodes: GraphNode[], edges: GraphEdge[] = []): GraphStore => {
  const s = new GraphStore();
  s.addFragment({ repo: 'r', nodes, edges });
  return s;
};

test('round trip: write → read → digest equality, meta stamped both ways', opts, () => {
  const db = new SnapshotDb(tempDb());
  const store = mkStore(
    [node('r::a.ts::alpha'), node('r::b.ts::beta'), node('r::route::GET /x', { kind: 'route', name: 'GET /x' })],
    [edge('calls', 'r::a.ts::alpha', 'r::b.ts::beta')],
  );
  const ref = db.write(store, { commit: 'cafe0123456789', sources: [{ name: 'r', files: 2, status: 'ok' }] });

  assert.equal(ref.sync, 1);
  assert.equal(ref.digest, digestOf(store));
  assert.ok(ref.tz.length > 0); // tz always present (G12)
  // write() stamps the in-memory store so graph.json carries the same identity
  assert.equal(store.meta.sync, 1);
  assert.equal(store.meta.digest, ref.digest);
  assert.equal(store.meta.commit, 'cafe0123456789');
  assert.equal(store.meta.tz, ref.tz);

  const back = db.read(1);
  assert.equal(digestOf(back.store), ref.digest);
  assert.deepEqual(back.ref, ref);
  assert.equal(back.store.meta.sync, 1);
  const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sortById(back.store.toJSON().nodes), sortById(store.toJSON().nodes));
  assert.deepEqual(sortById(back.store.toJSON().edges), sortById(store.toJSON().edges));

  assert.deepEqual(db.read('latest').ref, ref);
});

test('SCD2 intervals: unchanged rows stay open, changes close at N-1', opts, async () => {
  const path = tempDb();
  const db = new SnapshotDb(path);
  db.write(mkStore([node('r::keep'), node('r::mutate'), node('r::vanish')]));
  db.write(mkStore([node('r::keep'), node('r::mutate', { docs: 'now documented' }), node('r::appear')]));

  // inspect the raw intervals — the mechanism itself, not just its reads
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  // spread: node:sqlite hands back null-prototype rows, which deepEqual rejects
  const rows = raw.prepare('SELECT id, first_sync, last_sync FROM node ORDER BY id, first_sync').all().map((r) => ({ ...r })) as {
    id: string; first_sync: number; last_sync: number | null;
  }[];
  raw.close();
  assert.deepEqual(rows, [
    { id: 'r::appear', first_sync: 2, last_sync: null },
    { id: 'r::keep', first_sync: 1, last_sync: null },       // written once, still open
    { id: 'r::mutate', first_sync: 1, last_sync: 1 },        // closed when it changed
    { id: 'r::mutate', first_sync: 2, last_sync: null },     // new version open
    { id: 'r::vanish', first_sync: 1, last_sync: 1 },        // closed when it disappeared
  ]);

  // and the interval reads agree
  assert.deepEqual(db.read(1).store.toJSON().nodes.map((n) => n.id).sort(), ['r::keep', 'r::mutate', 'r::vanish']);
  assert.deepEqual(db.read(2).store.toJSON().nodes.map((n) => n.id).sort(), ['r::appear', 'r::keep', 'r::mutate']);
  assert.equal(db.read(2).store.toJSON().nodes.find((n) => n.id === 'r::mutate')!.docs, 'now documented');
});

test('changedBetween reports added/removed/changed with row JSON on both sides', opts, () => {
  const db = new SnapshotDb(tempDb());
  db.write(mkStore([node('r::keep'), node('r::mutate'), node('r::vanish')], [edge('calls', 'r::keep', 'r::vanish')]));
  db.write(mkStore([node('r::keep'), node('r::mutate', { docs: 'changed' }), node('r::appear')], [edge('calls', 'r::keep', 'r::appear')]));

  const delta = db.changedBetween(1, 2);
  assert.deepEqual(
    delta.nodes.map((c) => `${c.change}:${c.key}`),
    ['added:r::appear', 'changed:r::mutate', 'removed:r::vanish'],
  );
  const mutated = delta.nodes.find((c) => c.key === 'r::mutate')!;
  assert.equal((mutated.before as GraphNode).docs, undefined);
  assert.equal((mutated.after as GraphNode).docs, 'changed');
  assert.deepEqual(
    delta.edges.map((c) => `${c.change}:${c.key}`),
    ['added:calls|r::keep|r::appear', 'removed:calls|r::keep|r::vanish'],
  );
  // a no-op window
  assert.deepEqual(db.changedBetween(2, 2), { nodes: [], edges: [] });
});

test('list is newest-first with counts; pin survives prune; pruned reads explain themselves', opts, () => {
  const db = new SnapshotDb(tempDb());
  db.write(mkStore([node('r::v1')]));
  db.write(mkStore([node('r::v2')]));
  db.write(mkStore([node('r::v3')]));
  db.pin(1);

  assert.deepEqual(db.list().map((s) => s.sync), [3, 2, 1]);
  assert.equal(db.list()[0]!.nodes, 1);
  assert.equal(db.list()[2]!.pinned, true);

  const pruned = db.prune({ keep: 1, keepPinned: true });
  assert.equal(pruned, 1); // only sync:2 goes — 3 is newest, 1 is pinned
  assert.deepEqual(db.list().map((s) => s.sync), [3, 1]);

  // pinned history still fully readable
  assert.deepEqual(db.read(1).store.toJSON().nodes.map((n) => n.id), ['r::v1']);
  assert.deepEqual(db.read(3).store.toJSON().nodes.map((n) => n.id), ['r::v3']);
  // a pruned sync answers with an explanation, never a silent miss
  assert.throws(() => db.read(2), /pruned by the retention policy/);
  assert.throws(() => db.changedBetween(2, 3), /pruned by the retention policy/);
  // and a sync that never existed says that instead
  assert.throws(() => db.read(99), /does not exist — latest is sync:3/);
});

test('prune keeps interval rows any surviving snapshot still needs', opts, () => {
  const db = new SnapshotDb(tempDb());
  db.write(mkStore([node('r::stable'), node('r::v1only')]));
  db.write(mkStore([node('r::stable')]));
  db.write(mkStore([node('r::stable')]));
  db.pin(1);
  db.prune({ keep: 1, keepPinned: true });
  // r::v1only's closed row [1,1] must survive because pinned sync:1 reads it
  assert.deepEqual(db.read(1).store.toJSON().nodes.map((n) => n.id).sort(), ['r::stable', 'r::v1only']);
});

test('digestOf: order-independent, content-sensitive, resolution-tier-sensitive', opts, () => {
  const a = mkStore([node('r::x'), node('r::y')], [edge('calls', 'r::x', 'r::y')]);
  const b = mkStore([node('r::y'), node('r::x')], [edge('calls', 'r::x', 'r::y')]);
  assert.equal(digestOf(a), digestOf(b)); // node order does not matter
  const c = mkStore([node('r::x'), node('r::y')], [
    { ...edge('calls', 'r::x', 'r::y'), resolution: { status: 'resolved', technique: 'static-import', confidence: 'HIGH' } },
  ]);
  assert.notEqual(digestOf(a), digestOf(c)); // a confidence tier alone changes the digest
});

test('degraded mode is reported, not crashed', () => {
  // can't unload node:sqlite here; assert the state surface both ways instead
  if (available) {
    assert.doesNotThrow(() => new SnapshotDb(tempDb()));
  } else {
    assert.throws(() => new SnapshotDb(tempDb()), (err: Error) => {
      assert.equal(err.name, 'SnapshotUnavailable');
      assert.match(err.message, /graph\.json still works/);
      return true;
    });
  }
});
