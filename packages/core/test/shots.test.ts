// Design shots (change-history-2026-09.md §5, chunk H8): the `sync_shot` table
// beside the snapshot spine, and the three rules that make it honest.
//
//  1. **Absence is absence.** `shotAt` matches the sync *exactly*. A reader
//     asking what a screen looked like at sync 41 is never handed sync 38's
//     picture wearing sync 41's label, and a sync where no capture ran has no
//     row rather than an inherited one.
//  2. **Deduplication is by content address.** Twenty syncs of an unchanged
//     image are twenty rows naming one digest; a changed image is a second
//     digest, and both stay retrievable.
//  3. **The table is additive and the graph's identity does not move.** A
//     database written before H8 gains the table on open and keeps every row;
//     `digestOf()` is byte-identical before and after a shot pass, because a
//     retained picture is not graph content.
//
// The store holds only the *address* of the bytes — copying files is the
// server's job — so nothing here reads or writes an image.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore, SnapshotDb, digestOf, sqliteAvailable } from '../dist/index.js';
import type { GraphNode, ShotInput } from '../dist/index.js';

const available = sqliteAvailable();
const opts = { skip: available ? false : 'node:sqlite unavailable on this runtime — degraded mode has no history to test' };

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-shots-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'farsight.db');
}

const mkStore = (ids: string[]): GraphStore => {
  const s = new GraphStore();
  s.addFragment({
    repo: 'r',
    nodes: ids.map((id) => ({ id, kind: 'page', name: id.split('::').pop()!, tags: [] }) as GraphNode),
    edges: [],
  });
  return s;
};

const shot = (node: string, digest: string, over: Partial<ShotInput> = {}): ShotInput => ({
  node, repo: 'r', digest, ext: 'png', kind: 'file', source: 'docs/design/screens/s.png', bytes: 1024, ...over,
});

test('two syncs with a changed image keep two digests, and both stay addressable', opts, () => {
  const db = new SnapshotDb(tempDb());
  const store = mkStore(['r::SCR-07']);
  const one = db.write(store, {});
  db.writeShots(one.sync, [shot('r::SCR-07', 'aaaa1111aaaa1111')]);
  const two = db.write(store, {});
  db.writeShots(two.sync, [shot('r::SCR-07', 'bbbb2222bbbb2222', { bytes: 2048 })]);

  assert.equal(db.shotAt('r::SCR-07', 1)!.digest, 'aaaa1111aaaa1111');
  assert.equal(db.shotAt('r::SCR-07', 2)!.digest, 'bbbb2222bbbb2222');
  // the strip reads newest first, and the two syncs are two different pictures
  assert.deepEqual(db.shotsOf('r::SCR-07').map((r) => [r.sync, r.digest]), [
    [2, 'bbbb2222bbbb2222'], [1, 'aaaa1111aaaa1111'],
  ]);
  assert.equal(db.shotsOf('r::SCR-07')[0]!.bytes, 2048);
  db.close();
});

test('an unchanged image across twenty syncs is twenty rows and one file', opts, () => {
  const db = new SnapshotDb(tempDb());
  const store = mkStore(['r::SCR-07']);
  for (let i = 1; i <= 20; i++) {
    const ref = db.write(store, {});
    db.writeShots(ref.sync, [shot('r::SCR-07', 'cccc3333cccc3333')]);
  }
  const rows = db.shotsOf('r::SCR-07');
  assert.equal(rows.length, 20, 'every sync that captured has its own row');
  assert.equal(new Set(rows.map((r) => r.digest)).size, 1, 'and they all name one file on disk');
  assert.equal(db.shotsAt(7).files, 1);
  db.close();
});

test('a sync where no capture ran has no shot — and is never lent the neighbouring one', opts, () => {
  const db = new SnapshotDb(tempDb());
  const store = mkStore(['r::SCR-07', 'r::SCR-08']);
  const one = db.write(store, {});
  db.writeShots(one.sync, [shot('r::SCR-07', 'dddd4444dddd4444')]);
  db.write(store, {}); // sync 2: the flag was off, so nothing was captured
  const three = db.write(store, {});
  db.writeShots(three.sync, [shot('r::SCR-07', 'dddd4444dddd4444')]);

  assert.equal(db.shotAt('r::SCR-07', 2), undefined, 'sync 2 looked at nothing, so it knows nothing');
  assert.equal(db.shotsAt(2).rows.length, 0);
  // a screen that never had an image has no shot at a sync that did capture, either
  assert.equal(db.shotAt('r::SCR-08', 1), undefined);
  // and the sync either side is unaffected
  assert.equal(db.shotAt('r::SCR-07', 1)!.digest, 'dddd4444dddd4444');
  assert.equal(db.shotAt('r::SCR-07', 3)!.digest, 'dddd4444dddd4444');
  db.close();
});

test('re-capturing a sync replaces its rows rather than doubling them', opts, () => {
  const db = new SnapshotDb(tempDb());
  const ref = db.write(mkStore(['r::SCR-07']), {});
  db.writeShots(ref.sync, [shot('r::SCR-07', 'eeee5555eeee5555')]);
  db.writeShots(ref.sync, [shot('r::SCR-07', 'ffff6666ffff6666')]);
  assert.equal(db.shotsAt(ref.sync).rows.length, 1);
  assert.equal(db.shotAt('r::SCR-07', ref.sync)!.digest, 'ffff6666ffff6666');
  db.close();
});

test('digestOf does not move when a shot is retained, and no node gains a field', opts, () => {
  const db = new SnapshotDb(tempDb());
  const store = mkStore(['r::SCR-07', 'r::SCR-08']);
  const ref = db.write(store, {});
  const before = digestOf(store);
  const nodesBefore = JSON.stringify(db.read(1).store.toJSON().nodes);

  db.writeShots(ref.sync, [shot('r::SCR-07', 'aaaa1111aaaa1111')]);

  assert.equal(digestOf(store), before);
  assert.equal(digestOf(db.read(1).store), before);
  assert.equal(db.list()[0]!.digest, ref.digest);
  const nodesAfter = JSON.stringify(db.read(1).store.toJSON().nodes);
  assert.equal(nodesAfter, nodesBefore, 'a picture is provenance, not graph content');
  assert.ok(!/digest|shot/.test(nodesAfter));
  assert.deepEqual(db.list().map((s) => [s.sync, s.nodes, s.edges]), [[1, 2, 0]]);
  db.close();
});

test('a database written before H8 gains sync_shot and keeps every row it had', opts, async () => {
  const path = tempDb();
  const first = new SnapshotDb(path);
  first.write(mkStore(['r::kept', 'r::also']), {});
  const digest = first.list()[0]!.digest;
  first.close();

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE sync_shot');
  const tables = () =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
  assert.ok(!tables().includes('sync_shot'));
  raw.close();

  const db = new SnapshotDb(path);
  const back = db.read(1);
  assert.deepEqual(back.store.toJSON().nodes.map((n) => n.id).sort(), ['r::also', 'r::kept']);
  assert.equal(back.ref.digest, digest);
  assert.equal(db.shotsAt(1).rows.length, 0, 'a migrated database has no shots, not an error');
  db.writeShots(1, [shot('r::kept', 'aaaa1111aaaa1111')]);
  assert.equal(db.shotAt('r::kept', 1)!.digest, 'aaaa1111aaaa1111');
  db.close();
});
