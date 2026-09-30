// Generates fixtures/invoice-app/ — the recorded work-item source every
// consumer's CI uses. Run: node fixtures/make-invoice-app.mjs (output is
// committed; edit here, regenerate, commit both).
//
// Timeline: two full pages (8 items) → incremental page 1 (INV-6 done,
// INV-5 commented, INV-9 new) → incremental page 2 (INV-7 deleted).
// Stories worth finding: INV-4 is done but its screen (design INV-03,
// "Discard draft") is not built; INV-5 is to do and commits name it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'invoice-app');
const SRC = 'invoice-jira';
const SITE = 'https://invoice-app.atlassian.net';
const id = (k) => `work::${SRC}::${k}`;
const ada = { id: '5b10a2844c20165700ede21g', name: 'Ada Okafor', email: 'ada@invoice-app.test' };
const ben = { id: '5b10ac8d82e05b22cc7d4ef5', name: 'Ben Lindqvist' };
const TYPES = { Epic: 'epic', Story: 'story', Task: 'task', Bug: 'bug' };
const STATES = { 'To Do': 'todo', 'In Progress': 'in-progress', Done: 'done' };
const md = (text) => ({ format: 'markdown', raw: text, text });

function item(k, type, title, state, o = {}) {
  const updated = o.updated ?? '2026-09-18T10:00:00.000Z';
  return {
    id: id(k), source: SRC, provider: 'fixture', key: k, url: `${SITE}/browse/${k}`,
    type: { name: type, category: TYPES[type] }, title,
    ...(o.body ? { body: md(o.body) } : {}),
    state: { name: state, category: STATES[state], ...(o.since ? { since: o.since } : {}) },
    ...(o.priority ? { priority: { name: o.priority } } : {}),
    ...(o.assignee ? { assignee: o.assignee } : {}),
    reporter: o.reporter ?? ada,
    labels: o.labels ?? [],
    ...(o.area ? { area: o.area } : {}),
    ...(o.iteration ? { iteration: o.iteration } : {}),
    ...(o.parent ? { parent: id(o.parent) } : {}),
    links: o.links ?? [],
    ...(o.estimate !== undefined ? { estimate: { value: o.estimate, unit: 'points' } } : {}),
    created: o.created ?? '2026-09-01T09:00:00.000Z', updated,
    ...(STATES[state] === 'done' ? { resolved: o.resolved ?? updated } : {}),
    revision: updated,
    comments: o.comments ?? [], history: o.history ?? [],
    fields: o.estimate !== undefined ? { estimate: o.estimate } : {},
    raw: { key: k, fields: { summary: title, status: { name: state } } },
  };
}
const sprint = { name: 'Invoicing Sprint 3', start: '2026-09-14T00:00:00.000Z', end: '2026-09-28T00:00:00.000Z' };
const moved = (at, by, from, to) => ({ at, by, field: 'status', from, to });

const full1 = [
  item('INV-1', 'Epic', 'Invoicing for billing users', 'In Progress', {
    body: 'Billing users draft, send and track invoices from one list.', assignee: ada, priority: 'High',
    links: [{ kind: 'child', target: id('INV-2'), native: 'Parent' }],
    history: [moved('2026-09-02T09:00:00.000Z', ada, 'To Do', 'In Progress')],
  }),
  item('INV-2', 'Story', 'Start a new invoice', 'Done', {
    body: 'As a billing user I pick the customer, add line items and save a draft. Screen INV-02, route /invoices/new.',
    parent: 'INV-1', assignee: ben, iteration: sprint, estimate: 5, labels: ['billing', 'ui'], area: 'Invoices',
    links: [{ kind: 'parent', target: id('INV-1'), native: 'Parent' }],
    comments: [{ id: '10001', author: ada, created: '2026-09-10T15:00:00.000Z', body: md('Looks good on staging — closing.') }],
    history: [moved('2026-09-05T09:00:00.000Z', ben, 'To Do', 'In Progress'), moved('2026-09-10T15:05:00.000Z', ben, 'In Progress', 'Done')],
    updated: '2026-09-10T15:05:00.000Z',
  }),
  item('INV-3', 'Task', 'List invoices newest first', 'In Progress', {
    body: 'GET /invoices sorted by created, newest first.', assignee: ben, iteration: sprint, estimate: 2, area: 'Invoices',
    history: [moved('2026-09-15T11:00:00.000Z', ben, 'To Do', 'In Progress')], updated: '2026-09-15T11:00:00.000Z',
  }),
  item('INV-4', 'Story', 'Discard a draft invoice', 'Done', {
    body: 'Confirm and discard a draft that will never be sent. Screen INV-03 (Discard draft).',
    assignee: ada, estimate: 3, labels: ['billing'], area: 'Invoices',
    comments: [{ id: '10002', author: ben, created: '2026-09-12T10:00:00.000Z', body: md('Marking done — the API side is in; the screen is phase 2.') }],
    history: [moved('2026-09-12T10:01:00.000Z', ben, 'To Do', 'Done')], updated: '2026-09-12T10:01:00.000Z',
  }),
];
const full2 = [
  item('INV-5', 'Story', 'Approve an invoice before it is sent', 'To Do', {
    body: 'An approver signs off invoices over the threshold before they go to the customer.',
    labels: ['approvals'], estimate: 8, area: 'Approvals', priority: 'Medium',
  }),
  item('INV-6', 'Bug', 'Tax rounds the wrong way on multi-line invoices', 'In Progress', {
    body: 'Rounding per line instead of per invoice; totals are off by a cent.', assignee: ada, priority: 'High',
    labels: ['tax'], history: [moved('2026-09-17T08:00:00.000Z', ada, 'To Do', 'In Progress')], updated: '2026-09-17T08:00:00.000Z',
    links: [{ kind: 'relates', target: id('INV-3'), native: 'Relates' }],
  }),
  item('INV-7', 'Task', 'Spike: OCR for scanned invoices', 'To Do', { body: 'Try the OCR client on ten scanned invoices.' }),
  item('INV-8', 'Bug', 'Invoice list shows drafts to customers', 'Done', {
    body: 'Customers could see drafts at /invoices.', assignee: ben, labels: ['auth'], priority: 'Highest',
    history: [moved('2026-09-08T09:00:00.000Z', ben, 'To Do', 'In Progress'), moved('2026-09-09T09:00:00.000Z', ben, 'In Progress', 'Done')],
    updated: '2026-09-09T09:00:00.000Z',
  }),
];
const inv6 = full2[1];
const inc1 = [
  { ...inv6, state: { name: 'Done', category: 'done', since: '2026-09-24T16:00:00.000Z' }, updated: '2026-09-24T16:00:00.000Z',
    revision: '2026-09-24T16:00:00.000Z', resolved: '2026-09-24T16:00:00.000Z',
    history: [...inv6.history, moved('2026-09-24T16:00:00.000Z', ada, 'In Progress', 'Done')],
    raw: { ...inv6.raw, fields: { ...inv6.raw.fields, status: { name: 'Done' } } } },
  { ...full2[0], updated: '2026-09-23T13:00:00.000Z', revision: '2026-09-23T13:00:00.000Z',
    comments: [{ id: '10003', author: ben, created: '2026-09-23T13:00:00.000Z', body: md('Starting on this next sprint; see the approvals branch.') }] },
  item('INV-9', 'Task', 'Email the customer when an invoice is sent', 'To Do', {
    body: 'Send the notification on invoice.sent.', created: '2026-09-22T09:00:00.000Z', updated: '2026-09-22T09:00:00.000Z', area: 'Notifications',
  }),
];

const C0 = '2026-09-18T10:00:00.000Z', C1 = '2026-09-24T16:00:00.000Z', C2 = '2026-09-28T09:00:00.000Z';
const pages = {
  full: [{ file: 'full-1.json' }, { file: 'full-2.json' }],
  incremental: { [C0]: ['inc-1.json'], [C1]: ['inc-2.json'] },
};
mkdirSync(join(dir, 'pages'), { recursive: true });
const w = (f, v) => writeFileSync(join(dir, f), JSON.stringify(v, null, 2) + '\n');
w('pages.json', pages);
w('pages/full-1.json', { items: full1, cursor: null });
w('pages/full-2.json', { items: full2, cursor: C0 });
w('pages/inc-1.json', { items: inc1, cursor: C1 });
w('pages/inc-2.json', { items: [], cursor: C2, deleted: [id('INV-7')] });
w('schema.json', {
  projects: [{ key: 'INV', name: 'Invoice app', id: '10000' }],
  types: Object.entries(TYPES).map(([name, category]) => ({ name, category })),
  states: Object.entries(STATES).map(([name, category]) => ({ name, category })),
  fields: [
    { id: 'customfield_10016', name: 'Story point estimate', canonical: 'estimate', origin: 'found' },
    { id: 'customfield_10020', name: 'Sprint', canonical: 'iteration', origin: 'found' },
  ],
  linkTypes: [
    { native: 'Parent', kind: 'parent' }, { native: 'Relates', kind: 'relates' },
    { native: 'Blocks', kind: 'blocks' }, { native: 'Duplicate', kind: 'duplicates' },
  ],
  bodyFormat: 'markdown',
});
w('permissions.json', {
  credential: { read: true, write: true, detail: 'api token with write:jira-work' },
  default: 'allow',
  deny: { 'INV-8': { transition: 'the workflow has no transition out of Done for this user' } },
});
w('people.json', [ada, ben]);
