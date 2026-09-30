import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedProblems } from '@farsight/core';
import { workItemsCounted, syncCounted, itemCounted, freshnessText, agoText, stateWord, workItemId } from '../dist/index.js';
import type { WorkItem, StateCategory } from '../dist/index.js';

const mk = (key: string, c: StateCategory): WorkItem => ({
  id: workItemId('s', key), source: 's', provider: 'fixture', key, url: '', type: { name: 'Story', category: 'story' }, title: key,
  state: { name: c, category: c }, labels: [], links: [], created: '', updated: '', revision: '', comments: [], history: [], fields: {}, raw: {},
});

test('words: every work count is a sound Counted whose breakdown is a partition', () => {
  const items = [mk('A-1', 'todo'), mk('A-2', 'done'), mk('A-3', 'done'), mk('A-4', 'in-progress')];
  const c = workItemsCounted(items, 'count.scope.workSource');
  assert.deepEqual(countedProblems(c), []);
  assert.deepEqual(c.breakdown!.map((p) => p.n), [1, 1, 2]);
  const s = syncCounted({ sourceId: 's', syncNo: 1, pulled: 3, changed: 1, deleted: 1, cursor: null, durationMs: 1 });
  for (const x of Object.values(s)) assert.deepEqual(countedProblems(x), []);
  for (const x of Object.values(itemCounted(items[0]!, 2))) assert.deepEqual(countedProblems(x), []);
  assert.deepEqual(countedProblems(workItemsCounted([], 'count.scope.workSources')), []);
});

test('words: freshness sentences and state words come from the catalog', () => {
  assert.equal(freshnessText({ state: 'synced', since: 'x', ago: 3 * 60_000 + 5, lastOkAt: 'x' }), 'synced 3 minutes ago');
  assert.equal(freshnessText({ state: 'never', since: null, ago: null, lastOkAt: null }), 'never synced');
  assert.equal(freshnessText({ state: 'unreachable', since: '2026-09-30T09:14:00.000Z', ago: 1, lastOkAt: null }), 'source unreachable since 2026-09-30 09:14 UTC — showing the cache');
  assert.equal(freshnessText({ state: 'credential-expired', since: null, ago: null, lastOkAt: null }), 'credential expired — showing the cache');
  assert.equal(agoText(3600_000), '1 hour ago');
  assert.equal(agoText(5_000), 'just now');
  assert.equal(stateWord('in-progress'), 'in progress');
});

test('words: a state its type does not define is said beside the category', async () => {
  const { stateWord: sw, itemStateText, itemCounted: ic, previewText } = await import('../dist/index.js');
  const item = { ...mk('E-349', 'todo'), state: { name: 'To Do', category: 'todo' as const }, fields: { stateUndefinedByType: true } };
  assert.equal(itemStateText(item), 'To Do · to do · not a state its type defines');
  assert.equal(sw('todo', 'professional', { undefinedByType: true }), 'to do · not a state its type defines');
  assert.equal(ic(item, 0).stateNote, 'not a state its type defines');
  assert.equal(ic(mk('A-1', 'done'), 0).stateNote, undefined);
  assert.equal(previewText({ ok: true, reason: 'ok' }), 'dry run: ok');
  assert.equal(previewText({ ok: false, reason: 'no such field' }), 'dry run: no such field');
});
