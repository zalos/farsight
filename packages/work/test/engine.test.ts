// The engine driven by a hand-made provider (the recorded fixture's tests live in work-fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkCache, workDbPath, workItemId, syncSource } from '../dist/index.js';
import type { WorkItem, WorkProvider, SourceConfig, PullPage } from '../dist/index.js';

const mk = (key: string, o: Partial<WorkItem> = {}): WorkItem => ({
  id: workItemId('s', key), source: 's', provider: 'fixture', key, url: `https://x/browse/${key}`,
  type: { name: 'Story', category: 'story' }, title: key, state: { name: 'To Do', category: 'todo' },
  labels: [], links: [], created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z', revision: 'r1',
  comments: [], history: [], fields: {}, raw: {}, ...o,
});
const comment = { id: 'c1', author: { id: 'a1', name: 'Ada' }, created: '2026-09-01T00:00:00Z', body: 'hello' };

// a tracker whose pull sends a summary (no comments, no history) and whose hydrate sends the full record
function tracker(): WorkProvider {
  return {
    id: 'fake',
    capabilities: { comments: { read: true, write: false, format: 'markdown' } } as WorkProvider['capabilities'],
    connect: async (cfg) => ({ sourceId: cfg.id }) as never,
    discover: async () => ({ projects: [], types: [], states: [], fields: [], linkTypes: [] }),
    async *pull(): AsyncIterable<PullPage> {
      // every pull re-sends INV-1 at the same revision, the way an overlap window does
      yield { items: [mk('INV-1')], cursor: 'c', isLast: true };
    },
    hydrate: async (_s, ids) => ids.map((id) => mk(id.split('::').pop()!, { comments: [comment as never] })),
    can: async () => ({ allowed: false, reason: 'no' }),
    apply: async () => ({ ok: false, error: 'no' }),
  };
}

test('engine: an item re-sent at the revision the cache holds keeps its hydrated comments and its interval', async () => {
  const cache = new WorkCache(workDbPath(mkdtempSync(join(tmpdir(), 'work-engine-'))));
  const cfg: SourceConfig = { id: 's', type: 'work', provider: 'fake', path: '', scope: { projects: ['INV'] } } as SourceConfig;
  const p = tracker();
  const r1 = await syncSource(cfg, p, cache);
  assert.equal(r1.error, undefined);
  assert.equal(r1.changed, 1);
  const r2 = await syncSource(cfg, p, cache);
  assert.equal(r2.error, undefined);
  assert.equal(r2.pulled, 1);
  assert.equal(r2.changed, 0, 'the same revision is not a change');
  const id = workItemId('s', 'INV-1');
  assert.equal(cache.getItem(id)!.comments.length, 1, 'the summary did not replace the hydrated record');
  assert.equal(cache.revisions(id).length, 1, 'no spurious interval opened');
});
