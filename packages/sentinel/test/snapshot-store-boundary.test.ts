// The capture's store boundary: only the exact folder of the store this process holds, with the identity it was
// opened with, is left out of a working copy. Every look-alike, neighbour, decoy or committed blob is ordinary
// source; a store reached under another name, replaced, renamed or released refuses the capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot, SnapshotError } from '../dist/snapshot/index.js';
import { StoreError } from '../dist/store/index.js';
import { Inventory } from '../dist/snapshot/inventory.js';
import { resolvePolicy } from '../dist/snapshot/policy.js';
import { enumerateWorktree } from '../dist/snapshot/worktree.js';
import { identityOf } from '../dist/store/paths.js';
import { commitRepo, needsStore, openCaptureStore, scratch, writeTree } from './snapshot-helpers.ts';

const entryOf = (snap: any, path: string, sourceId = 'app') =>
  snap.entries.find((e: any) => e.sourceId === sourceId && e.relativePath === path);
const coded = (code: string) => (e: unknown) =>
  (e instanceof SnapshotError || e instanceof StoreError) && (e as { code: string }).code === code;
const stored = (snap: any) =>
  snap.entries
    .filter((e: any) => e.reasonCode === 'sentinel.capture.excludedStore')
    .map((e: any) => `${e.sourceId}:${e.relativePath}`);

test(
  'only the exact held store folder is left out; neighbours, copies and arbitrary .farsight source are captured',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const root = join(dir, 'work');
    commitRepo(root, { 'src/a.ts': 'a\n' });
    writeTree(root, {
      '.farsight/custom/routes.js': 'export const route = 1;\n',
      '.farsight/sentinel/settings.json': '{"schema":"sentinel-settings/draft-1"}\n',
      '.farsight/sentinel/store-old/ledger.sqlite': 'not a store\n',
      '.farsight/sentinel/storex/a.js': 'x\n',
      '.farsight/sentinel/xstore/a.js': 'x\n',
      '.farsight/sentinel/scratch/w-old/kept.js': 'export const kept = 1;\n',
      'foreign-store/owner.json': '{}\n',
    });
    const fx = await openCaptureStore(t, dir, join(root, '.farsight', 'sentinel', 'store'));
    const snap = (
      await captureSnapshot(fx.store, {
        mode: 'working-copy',
        sources: [{ sourceId: 'app', repositoryId: 'example/app', root }],
      })
    ).snapshot;
    assert.deepEqual(stored(snap), ['app:.farsight/sentinel/store']);
    assert.equal(
      snap.entries.some((e: any) => e.relativePath.startsWith('.farsight/sentinel/store/')),
      false,
      'no store contents',
    );
    for (const p of [
      '.farsight/custom/routes.js',
      '.farsight/sentinel/settings.json',
      '.farsight/sentinel/store-old/ledger.sqlite',
      '.farsight/sentinel/storex/a.js',
      '.farsight/sentinel/xstore/a.js',
      '.farsight/sentinel/scratch/w-old/kept.js',
      'foreign-store/owner.json',
    ]) {
      assert.equal(entryOf(snap, p)?.disposition, 'included', p);
    }
  },
);

test(
  'a store outside the source exempts nothing; a look-alike store object exempts nothing it names',
  needsStore,
  async (t) => {
    const dir = scratch(t);
    const root = join(dir, 'work');
    commitRepo(root, { 'a.ts': 'a\n' });
    writeTree(root, { '.farsight/sentinel/store/a.js': 'x\n', 'decoy/a.js': 'x\n' });
    const fx = await openCaptureStore(t, dir, join(dir, 'outside-store'));
    const outside = (
      await captureSnapshot(fx.store, {
        mode: 'working-copy',
        sources: [{ sourceId: 'app', repositoryId: 'example/app', root }],
      })
    ).snapshot;
    assert.deepEqual(stored(outside), []);
    assert.equal(entryOf(outside, '.farsight/sentinel/store/a.js').disposition, 'included');
    // An object built on the real store that claims another folder: not a held store, so no folder is its boundary.
    const lookalike = Object.create(fx.store, { storePath: { value: join(root, 'decoy') } });
    const viaLookalike = (
      await captureSnapshot(lookalike, {
        mode: 'working-copy',
        sources: [{ sourceId: 'app', repositoryId: 'example/app', root }],
      })
    ).snapshot;
    assert.deepEqual(stored(viaLookalike), []);
    assert.equal(entryOf(viaLookalike, 'decoy/a.js').disposition, 'included');
  },
);

test('with several sources only the one containing the held store gets the boundary', needsStore, async (t) => {
  const dir = scratch(t);
  const a = join(dir, 'a'),
    b = join(dir, 'b');
  commitRepo(a, { 'a.ts': 'a\n' });
  commitRepo(b, { 'b.ts': 'b\n' });
  writeTree(a, { 'state/store/a.js': 'x\n' });
  const fx = await openCaptureStore(t, dir, join(b, 'state', 'store'));
  const snap = (
    await captureSnapshot(fx.store, {
      mode: 'working-copy',
      sources: [
        { sourceId: 'a', repositoryId: 'example/a', root: a },
        { sourceId: 'b', repositoryId: 'example/b', root: b },
      ],
    })
  ).snapshot;
  assert.deepEqual(stored(snap), ['b:state/store']);
  assert.equal(entryOf(snap, 'state/store/a.js', 'a').disposition, 'included');
});

test('a source that is the store or lies inside it is refused before anything is stored', needsStore, async (t) => {
  const dir = scratch(t);
  const fx = await openCaptureStore(t, dir);
  await assert.rejects(
    captureSnapshot(fx.store, {
      mode: 'working-copy',
      sources: [{ sourceId: 'app', repositoryId: 'x', root: fx.storePath }],
    }),
    coded('sentinel.capture.invalidRequest'),
  );
  mkdirSync(join(fx.storePath, 'inside'), { mode: 0o700 });
  await assert.rejects(
    captureSnapshot(fx.store, {
      mode: 'working-copy',
      sources: [{ sourceId: 'app', repositoryId: 'x', root: join(fx.storePath, 'inside') }],
    }),
    coded('sentinel.capture.invalidRequest'),
  );
});

test('committed blobs at the store path are committed source, never the live store', needsStore, async (t) => {
  const dir = scratch(t);
  const root = join(dir, 'work');
  commitRepo(root, { 'a.ts': 'a\n', 'state/store/committed.ts': 'export const c = 1;\n' });
  rmSync(join(root, 'state'), { recursive: true, force: true });
  const fx = await openCaptureStore(t, dir, join(root, 'state', 'store'));
  const snap = (
    await captureSnapshot(fx.store, {
      mode: 'committed-tree',
      sources: [{ sourceId: 'app', repositoryId: 'example/app', root }],
    })
  ).snapshot;
  assert.deepEqual(stored(snap), []);
  assert.equal(entryOf(snap, 'state/store/committed.ts').disposition, 'included');
});

test(
  'a held store renamed, replaced by a folder or by a link, or released refuses the capture and admits nothing',
  needsStore,
  async (t) => {
    for (const change of ['rename', 'replace', 'link'] as const) {
      const dir = scratch(t);
      const root = join(dir, 'work');
      commitRepo(root, { 'a.ts': 'a\n' });
      const fx = await openCaptureStore(t, dir, join(root, 'store'));
      const away = join(dir, `moved-${change}`);
      renameSync(fx.storePath, away);
      if (change === 'replace') mkdirSync(fx.storePath);
      if (change === 'link') symlinkSync(away, fx.storePath);
      await assert.rejects(
        captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'x', root }] }),
        (e: any) =>
          e instanceof StoreError && ['sentinel.store.identityChanged', 'sentinel.store.ownerLost'].includes(e.code),
        change,
      );
      assert.equal(fx.store.held, false, `${change}: the hold is gone`);
    }
    const dir = scratch(t);
    const root = join(dir, 'work');
    commitRepo(root, { 'a.ts': 'a\n' });
    const fx = await openCaptureStore(t, dir, join(root, 'store'));
    fx.store.close();
    await assert.rejects(
      captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'x', root }] }),
      coded('sentinel.store.ownerClosed'),
    );
  },
);

test('a store replaced while it is being captured refuses before admission', needsStore, async (t) => {
  const dir = scratch(t);
  const root = join(dir, 'work');
  commitRepo(root, { 'a.ts': 'a\n' });
  const fx = await openCaptureStore(t, dir, join(root, 'store'));
  const away = join(dir, 'away');
  await assert.rejects(
    captureSnapshot(fx.store, {
      mode: 'working-copy',
      sources: [{ sourceId: 'app', repositoryId: 'x', root }],
      onStaged: () => {
        renameSync(fx.storePath, away);
        symlinkSync(away, fx.storePath);
      },
    }),
    coded('sentinel.store.identityChanged'),
  );
  assert.equal(fx.store.held, false);
});

test('the store identity reached under another name is refused, never exempted or listed', () => {
  const dir = scratch({ after: (fn: () => void) => process.on('exit', fn) });
  const root = join(dir, 'work');
  writeTree(root, { 'twin/a.js': 'x\n', 'exact/a.js': 'x\n' });
  const twin = identityOf(lstatSync(join(root, 'twin'), { bigint: true }));
  // Same identity at another path (what a bind mount or firmlink presents): refused.
  const aliased = { path: join(dir, 'elsewhere'), identity: twin, assertHeld() {} };
  assert.throws(
    () =>
      enumerateWorktree(new Inventory(resolvePolicy({})), {
        sourceId: 'app',
        root,
        store: aliased,
        lfsObjects: undefined,
      }),
    (e: any) => e instanceof SnapshotError && e.code === 'sentinel.capture.storeAliased',
  );
  // The exact path with another identity, even if the hold check passes: refused.
  const replaced = { path: join(root, 'exact'), identity: twin, assertHeld() {} };
  assert.throws(
    () =>
      enumerateWorktree(new Inventory(resolvePolicy({})), {
        sourceId: 'app',
        root,
        store: replaced,
        lfsObjects: undefined,
      }),
    (e: any) => e instanceof SnapshotError && e.code === 'sentinel.capture.storeAliased',
  );
  // The fence's own refusal wins at the exact folder.
  const lost = {
    path: join(root, 'exact'),
    identity: identityOf(lstatSync(join(root, 'exact'), { bigint: true })),
    assertHeld() {
      throw new Error('owner lost');
    },
  };
  assert.throws(
    () =>
      enumerateWorktree(new Inventory(resolvePolicy({})), {
        sourceId: 'app',
        root,
        store: lost,
        lfsObjects: undefined,
      }),
    /owner lost/,
  );
});

test(
  'a snapshot captured under the old .farsight exclusion keeps its recorded boundary after the store reopens',
  needsStore,
  async (t) => {
    const { openStore } = await import('../dist/store/index.js');
    const { openSnapshot } = await import('../dist/snapshot/index.js');
    const dir = scratch(t);
    const root = join(dir, 'work');
    commitRepo(root, { 'a.ts': 'a\n' });
    writeTree(root, { '.farsight/custom/app.ts': 'export {};\n' });
    const storePath = join(root, '.farsight', 'sentinel', 'store');
    let store = await openStore(storePath);
    const old = (
      await captureSnapshot(store, {
        mode: 'working-copy',
        sources: [{ sourceId: 'app', repositoryId: 'x', root }],
        policy: { exclude: { '*': ['.farsight'] } },
      })
    ).snapshot;
    store.close();
    rmSync(join(root, 'a.ts'));
    store = await openStore(storePath);
    t.after(() => store.close());
    const again = (await openSnapshot(store, old.id)).snapshot;
    assert.deepEqual(again.entries, old.entries, 'retained entries are not reinterpreted');
    assert.equal(entryOf(again, '.farsight').reasonCode, 'sentinel.capture.excludedByPolicy');
  },
);
