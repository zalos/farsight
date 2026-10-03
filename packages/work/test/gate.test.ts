import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, workItemId } from '../dist/index.js';
import type { WorkItem, Intent, Grant } from '../dist/index.js';

const item: WorkItem = {
  id: workItemId('s', 'INV-1'), source: 's', provider: 'fixture', key: 'INV-1', url: 'https://x/browse/INV-1',
  type: { name: 'Story', category: 'story' }, title: 'x', state: { name: 'To Do', category: 'todo' },
  labels: [], links: [], created: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z', revision: 'r1',
  comments: [], history: [], fields: {}, raw: {},
};
const ask = (o: Partial<Intent> = {}): Intent => ({ id: 'i', item: item.id, action: 'comment', payload: { body: 'x' }, requestedBy: { kind: 'human', id: 'u' }, ...o });

test('policy: grants are additive — a grant without confirmation wins whatever the order', () => {
  const strict: Grant = { actions: ['comment'], principals: ['human', 'agent'], confirm: 'always' };
  const open: Grant = { actions: ['comment'], principals: ['human'] };
  for (const grants of [[strict, open], [open, strict]]) {
    const d = evaluatePolicy({ grants }, ask(), item, { mode: 'edit' });
    assert.equal(d.verdict.allowed, true);
    assert.equal(d.requiresConfirmation, false, 'a person may comment through the open grant');
    // an agent is only covered by the strict grant, and still waits for a person
    const a = evaluatePolicy({ grants }, ask({ requestedBy: { kind: 'agent', id: 'm' } }), item, { mode: 'edit' });
    assert.equal(a.verdict.allowed, true);
    assert.equal(a.requiresConfirmation, true);
  }
});
