import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkCache, workDbPath, workItemId } from '../dist/index.js';
import type { WorkItem } from '../dist/index.js';

const open = () => new WorkCache(workDbPath(mkdtempSync(join(tmpdir(), 'work-cache-'))));
const ada = { id: 'a1', name: 'Ada' };
const mk = (key: string, o: Partial<WorkItem> = {}): WorkItem => ({
  id: workItemId('s', key), source: 's', provider: 'fixture', key, url: `https://x/browse/${key}`,
  type: { name: 'Story', category: 'story' }, title: key, state: { name: 'To Do', category: 'todo' },
  labels: [], links: [], created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z', revision: 'r1',
  comments: [], history: [], fields: {}, raw: {}, ...o,
});

test('cache: sources, syncs and the cursor', () => {
  const c = open();
  c.upsertSource({ id: 's', provider: 'fixture', scope: { projects: ['INV'] }, mode: 'read-only' });
  const n = c.beginSync('s', '2026-09-30T00:00:00Z');
  c.finishSync('s', n, { at: '2026-09-30T00:00:01Z', pulled: 2, changed: 2, deleted: 0, cursor: 'c1', durationMs: 5 });
  const row = c.getSource('s')!;
  assert.equal(row.cursor, 'c1');
  assert.equal(row.lastSync, n);
  assert.equal(row.lastError, null);
  const n2 = c.beginSync('s', '2026-09-30T01:00:00Z');
  c.finishSync('s', n2, { at: '2026-09-30T01:00:00Z', pulled: 0, changed: 0, deleted: 0, cursor: null, durationMs: 1, error: 'site unreachable', errorKind: 'unreachable' });
  const after = c.getSource('s')!;
  assert.equal(after.cursor, 'c1', 'a failed sync keeps the last good cursor');
  assert.equal(after.lastErrorKind, 'unreachable');
  assert.equal(after.lastOkAt, '2026-09-30T00:00:01Z');
});

test('cache: replace (never merge), SCD2 intervals, itemAt, delete', () => {
  const c = open();
  c.upsertSource({ id: 's', provider: 'fixture', scope: { projects: [] }, mode: 'read-only' });
  assert.equal(c.replaceItem('s', mk('INV-1', { labels: ['a'], assignee: ada }), 1), true);
  assert.equal(c.replaceItem('s', mk('INV-1', { labels: ['a'], assignee: ada }), 2), false, 'same record, no new interval');
  // the tracker dropped the label and the assignee: replace, not merge
  assert.equal(c.replaceItem('s', mk('INV-1', { state: { name: 'Done', category: 'done' }, revision: 'r2' }), 3), true);
  const now = c.getItem(workItemId('s', 'INV-1'))!;
  assert.deepEqual(now.labels, []);
  assert.equal(now.assignee, undefined);
  assert.equal(c.itemAt(now.id, 2)!.state.category, 'todo');
  assert.equal(c.itemAt(now.id, 3)!.state.category, 'done');
  assert.equal(c.itemAt(now.id, 0), null);
  assert.deepEqual(c.revisions(now.id).map((r) => [r.firstSync, r.lastSync]), [[1, 2], [3, null]]);
  assert.equal(c.getPerson('a1')!.name, 'Ada');
  assert.equal(c.markDeleted(now.id, 5), true);
  assert.equal(c.getItem(now.id), null);
  assert.ok(c.getItem(now.id, { includeDeleted: true }));
  assert.equal(c.itemAt(now.id, 4)!.state.category, 'done');
  assert.equal(c.itemAt(now.id, 5), null);
});

test('cache: listItems filters and natural key order; findByKey', () => {
  const c = open();
  c.replaceItem('s', mk('INV-10', { assignee: ada }), 1);
  c.replaceItem('s', mk('INV-2', { state: { name: 'Done', category: 'done' } }), 1);
  c.replaceItem('s', mk('INV-3', { type: { name: 'Bug', category: 'bug' }, parent: workItemId('s', 'INV-2') }), 1);
  assert.deepEqual(c.listItems().map((i) => i.key), ['INV-2', 'INV-3', 'INV-10']);
  assert.deepEqual(c.listItems({ state: 'done' }).map((i) => i.key), ['INV-2']);
  assert.deepEqual(c.listItems({ assignee: 'ada' }).map((i) => i.key), ['INV-10']);
  assert.deepEqual(c.listItems({ type: 'bug' }).map((i) => i.key), ['INV-3']);
  assert.deepEqual(c.listItems({ parent: workItemId('s', 'INV-2') }).map((i) => i.key), ['INV-3']);
  assert.equal(c.findByKey('INV-3').length, 1);
});

test('cache: links, outbox and audit', () => {
  const c = open();
  const w = workItemId('s', 'INV-1');
  c.putLink({ work: w, node: 'app::src/a.ts::f', kind: 'tracks', provenance: 'commit', tier: 'MEDIUM', detail: 'abc1234', at: 't' });
  assert.equal(c.linksFor(w).length, 1);
  assert.equal(c.linksFor('app::src/a.ts::f')[0]!.tier, 'MEDIUM');
  c.enqueueIntent('s', { id: 'i1', item: w, action: 'comment', payload: { body: 'x' }, requestedBy: { kind: 'agent', id: 'mcp-1', tool: 'work_comment' } }, 't0');
  assert.equal(c.listOutbox({ state: 'queued' }).length, 1);
  const v = { policy: { allowed: true, reason: 'granted' }, tracker: { allowed: true, reason: 'yes' }, credential: { allowed: true, reason: 'write' } };
  c.updateIntent('i1', { state: 'confirmed', verdicts: v, result: { ok: true, revision: 'r2' }, at: 't1' });
  const row = c.getIntent('i1')!;
  assert.equal(row.state, 'confirmed');
  assert.equal(row.intent.requestedBy.tool, 'work_comment');
  assert.equal(row.result!.revision, 'r2');
  c.audit({ at: 't1', source: 's', intent: 'i1', item: w, action: 'comment', verdicts: v, outcome: 'confirmed' });
  assert.equal(c.listAudit({ item: w })[0]!.verdicts!.policy.reason, 'granted');
});
