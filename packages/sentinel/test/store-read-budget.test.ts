// Genuine facade/owner reads. No fake store, admission capability, scanner or model is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { withStoreReadBudget, READ_BUDGET_LIMITS } from '../dist/store/read-budget.js';
import { ObjectStore } from '../dist/store/objects.js';
import { boundOwner } from '../dist/store/owner-binding.js';
import { toLedgerReceipt } from '../dist/store/objects-ledger.js';
import { scratch, storeIn, removeScratch } from './execution-helpers.ts';
const code = (c: string) => (e: any) => e?.code === c;
async function fixture(t: any) {
  const s = scratch('read-budget'),
    store = await storeIn(s.root);
  t.after(() => {
    store.close();
    removeScratch(s.root);
  });
  const ref = await store.objects.putCanonicalJson({ note: 'original inert fixture' });
  return { s, store, ref };
}

test('facade read/readCanonicalJson/check each charge once; repeats and encoded sizes are not deduplicated', async (t) => {
  const { store, ref } = await fixture(t);
  const result = await withStoreReadBudget(store, {}, async () => {
    await store.objects.read(ref);
    await store.objects.readCanonicalJson(ref);
    assert.equal((await store.objects.check(ref)).status, 'ok');
  });
  assert.deepEqual(
    { ...result.usage, elapsedMs: 0 },
    { reads: 3, decodedBytes: 3 * ref.rawSize, encodedBytes: 3 * ref.storedSize, elapsedMs: 0 },
  );
});
for (const [key, size] of [
  ['reads', 0],
  ['decodedBytes', 0],
  ['encodedBytes', 0],
] as const) {
  test(`a ${key} limit refuses before opening even an unavailable object`, async (t) => {
    const { store, ref } = await fixture(t);
    await assert.rejects(
      withStoreReadBudget(store, { [key]: size }, () => store.objects.read({ ...ref, id: `sha256:${'0'.repeat(64)}` })),
      code('sentinel.object.tooLarge'),
    );
    await assert.rejects(
      store.objects.read({ ...ref, id: `sha256:${'0'.repeat(64)}` }),
      code('sentinel.object.missing'),
    );
  });
}

test('nested same-store scopes only tighten and the first swallowed failure poisons the outer result', async (t) => {
  const { store, ref } = await fixture(t);
  let first: any;
  await assert.rejects(
    withStoreReadBudget(store, { reads: 3 }, async () => {
      try {
        await withStoreReadBudget(store, { reads: 1 }, async () => {
          await store.objects.read(ref);
          await store.objects.read(ref);
        });
      } catch (e) {
        first = e;
      }
      try {
        await store.objects.read(ref);
        assert.fail('the outer scope must remain failed');
      } catch (e) {
        assert.equal(e, first);
      }
      return 'must not escape as success';
    }),
    (e) => e === first && code('sentinel.object.tooLarge')(e),
  );
});

test('an unrelated store and an independently started concurrent context are not charged', async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // Its continuation was created outside the scope, even though the scoped callback waits for it.
  const outside = (async () => {
    await gate;
    return a.store.objects.read(a.ref);
  })();
  const r = await withStoreReadBudget(a.store, { reads: 0 }, async () => {
    release();
    await outside;
    const nested = await withStoreReadBudget(b.store, { reads: 1 }, () => b.store.objects.read(b.ref));
    assert.equal(nested.usage.reads, 1);
  });
  assert.equal(r.usage.reads, 0);
});

test('post-await cancellation and cooperative synchronous deadline cannot be swallowed', async (t) => {
  const { store, ref } = await fixture(t),
    controller = new AbortController();
  let first: any;
  await assert.rejects(
    withStoreReadBudget(store, { signal: controller.signal }, async () => {
      const read = store.objects.read(ref);
      controller.abort();
      try {
        await read;
      } catch (e) {
        first = e;
      }
    }),
    (e) => e === first && code('sentinel.execution.canceled')(e),
  );
  await assert.rejects(
    withStoreReadBudget(store, { durationMs: 10 }, async () => {
      const start = performance.now();
      while (performance.now() < start + 20) {
        /* bounded synchronous work */
      }
      return 'too late';
    }),
    code('sentinel.execution.deadlineExceeded'),
  );
});

test('a nested scope cannot reset its parent deadline and escaped async reads cannot outlive the scope', async (t) => {
  const { store, ref } = await fixture(t);
  await assert.rejects(
    withStoreReadBudget(store, { durationMs: 25 }, async () => {
      await delay(15);
      return withStoreReadBudget(store, { durationMs: 100 }, async () => {
        await delay(20);
        return store.objects.read(ref);
      });
    }),
    code('sentinel.execution.deadlineExceeded'),
  );
  let release!: () => void, escaped!: Promise<unknown>;
  await withStoreReadBudget(store, {}, async () => {
    const gate = new Promise<void>((r) => {
      release = r;
    });
    escaped = gate.then(() => store.objects.read(ref));
  });
  release();
  await assert.rejects(escaped, code('sentinel.object.invalidInput'));
});

test('owner loss and a genuine ledger owner error retain the first typed failure across catch replacement', async (t) => {
  const { store, ref } = await fixture(t);
  let first: any;
  await assert.rejects(
    withStoreReadBudget(store, {}, async () => {
      store.close();
      try {
        store.ledger.currentSequence();
      } catch (e) {
        first = e;
      }
      throw new Error('legacy evidence mapper replaced the failure');
    }),
    (e) => e === first && code('sentinel.store.closed')(e),
  );
  await assert.rejects(
    withStoreReadBudget(store, {}, () => store.objects.read(ref)),
    code('sentinel.store.ownerClosed'),
  );
});

test('scope creation requires a genuine store and limits cannot raise the closed ceilings', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    withStoreReadBudget({ ...store } as any, {}, async () => true),
    TypeError,
  );
  await assert.rejects(
    withStoreReadBudget(store, { reads: READ_BUDGET_LIMITS.reads + 1 }, async () => true),
    code('sentinel.object.invalidInput'),
  );
});

test('readArtifact reserves every failed representation and never retries a latched budget failure', async (t) => {
  const { s, store } = await fixture(t);
  // A physical store admission fixture, not a fabricated executed/publication capability. Both encodings are
  // written under this actual owner and verified by the real ledger before the corrupt-representation fault.
  const bytes = Buffer.from('original retained representation fixture');
  const low = new ObjectStore(boundOwner(store));
  const raw = toLedgerReceipt(await low.put(bytes, { codec: 'raw' }));
  const gzip = toLedgerReceipt(await low.put(bytes, { codec: 'gzip' }));
  const manifest = await store.objects.putCanonicalJson({ fixture: 'manifest' });
  const sidecar = await store.objects.putCanonicalJson({ fixture: 'materialization' });
  store.ledger.registerStaging('budget-representations', [
    { id: raw.id, schema: 'application/octet-stream', privacy: 'source' },
    { id: manifest.id, schema: 'sentinel-snapshot/draft-1', privacy: 'source-derived', links: [raw.id] },
    { id: sidecar.id, schema: 'sentinel-capture-materialization/draft-1', privacy: 'source', links: [manifest.id] },
  ]);
  store.ledger.admitSnapshot({
    snapshotId: 'snapshot-budget-fixture',
    stageIds: ['budget-representations'],
    manifest: manifest.id,
    materialization: sidecar.id,
    inventoryDigest: manifest.id,
    receipts: [raw, gzip, manifest, sidecar],
  });
  assert.deepEqual(
    store.ledger.objectsOf(raw.id).map((r) => r.codec),
    ['gzip', 'identity'],
  );
  const hex = raw.id.slice(7),
    gzipPath = join(store.storePath, 'objects/sha256', hex.slice(0, 2), hex + '.gzip');
  writeFileSync(gzipPath, Buffer.alloc(gzip.storedSize));
  const r = await withStoreReadBudget(store, {}, () => store.readArtifact(raw.id));
  assert.ok(r.value.equals(bytes));
  assert.equal(r.usage.reads, 2);
  assert.equal(r.usage.decodedBytes, raw.rawSize + gzip.rawSize);
  assert.equal(r.usage.encodedBytes, raw.storedSize + gzip.storedSize);
  // If fallback is wrongly attempted this becomes missing; a typed budget failure must win instead.
  unlinkSync(join(store.storePath, 'objects/sha256', hex.slice(0, 2), hex + '.raw'));
  await assert.rejects(
    withStoreReadBudget(store, { reads: 0 }, () => store.readArtifact(raw.id)),
    code('sentinel.object.tooLarge'),
  );
});

test('budget accounting and the physical read use one captured representation even for accessor receipts', async (t) => {
  const { store, ref } = await fixture(t);
  let calls = 0;
  const unstable = {
    ...ref,
    get rawSize() {
      return ++calls <= 3 ? 0 : ref.rawSize;
    },
  };
  // A mutable second read after accounting could reserve zero then read the full object.
  await assert.rejects(
    withStoreReadBudget(store, { decodedBytes: 1 }, () => store.objects.read(unstable)),
    (e: any) => ['sentinel.object.corrupt', 'sentinel.object.tooLarge'].includes(e.code),
  );
});

test('readArtifact preserves its first typed owner failure before representation lookup', async (t) => {
  const { store, ref } = await fixture(t);
  let first: any;
  await assert.rejects(
    withStoreReadBudget(store, {}, async () => {
      store.close();
      try {
        await store.readArtifact(ref.id);
      } catch (e) {
        first = e;
      }
    }),
    (e) => e === first && code('sentinel.store.closed')(e),
  );
});

test('exact encoded/decoded/count ceilings admit one verified read; no implicit headroom is added', async (t) => {
  const { store, ref } = await fixture(t);
  const one = await withStoreReadBudget(
    store,
    { reads: 1, decodedBytes: ref.rawSize, encodedBytes: ref.storedSize },
    () => store.objects.read(ref),
  );
  assert.equal(one.usage.reads, 1);
  assert.equal(one.usage.decodedBytes, ref.rawSize);
  assert.equal(one.usage.encodedBytes, ref.storedSize);
  await assert.rejects(
    withStoreReadBudget(store, { decodedBytes: ref.rawSize - 1 }, () => store.objects.read(ref)),
    code('sentinel.object.tooLarge'),
  );
  await assert.rejects(
    withStoreReadBudget(store, { encodedBytes: ref.storedSize - 1 }, () => store.objects.read(ref)),
    code('sentinel.object.tooLarge'),
  );
});
