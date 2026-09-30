// Regenerate the WORK surface's stub fixture from Lane A's recorded invoice-app
// tracker (packages/work-fixture/fixtures/invoice-app) plus a read-only Azure
// DevOps source and the joins a server would compute (commits, links, findings).
// Usage: node e2e/fixture/work/make.mjs   — writes the JSON files beside this one.
//
// The stub answers the /api/work contract (work-api.md) for the e2e specs and the
// screenshot server; D's real routes replace it wherever the fixture provider can
// produce the state. It is data, not a second implementation: counting and
// filtering live in e2e/tests/work-stub.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rec = join(here, '..', '..', '..', 'packages', 'work-fixture', 'fixtures', 'invoice-app');
const read = (p) => JSON.parse(readFileSync(join(rec, p), 'utf8'));
const byId = new Map();
for (const f of ['pages/full-1.json', 'pages/full-2.json', 'pages/inc-1.json']) {
  for (const it of read(f).items || []) byId.set(it.id, { ...it, provider: 'jira' });
}
const ADA = { id: '5b10a2844c20165700ede21g', name: 'Ada Okafor', email: 'ada@invoice-app.test' };
const BEN = { id: '5b10ac8d82e05b22cc7d4ef5', name: 'Ben Lindqvist' };
const CHIDI = { id: 'aad.Y2hpZGk', name: 'Chidi Mensah' };
const agentNote = byId.get('work::invoice-jira::INV-6');
agentNote.comments = [...(agentNote.comments || []), {
  id: '10044', author: ADA, created: '2026-09-29T11:20:00.000Z', requestedBy: { kind: 'agent', id: 'mcp-7f3a', tool: 'work_comment' },
  body: { format: 'markdown', raw: 'via Farsight (agent): the rounding fix is in `computeTax` — two commits name this bug.', text: 'via Farsight (agent): the rounding fix is in computeTax — two commits name this bug.' },
}];
const inv2 = byId.get('work::invoice-jira::INV-2');
inv2.body = {
  format: 'markdown',
  raw: 'As a billing user I pick the customer, add line items and save a draft.\n\n- the customer is chosen from a list\n- each line has a description and an amount\n- **Save draft** keeps it without sending\n\nScreen INV-02, route `/invoices/new`. See [the design](https://www.figma.com/file/invoice-app).',
  text: 'As a billing user I pick the customer, add line items and save a draft. The customer is chosen from a list. Each line has a description and an amount. Save draft keeps it without sending. Screen INV-02, route /invoices/new. See the design.',
};

const ado = (n, o) => ({
  id: 'work::invoice-azdo::' + n, source: 'invoice-azdo', provider: 'azure-devops', key: String(n),
  url: 'https://dev.azure.com/invoice-app/Invoicing/_workitems/edit/' + n, labels: [], links: [], comments: [], history: [], fields: {},
  created: '2026-09-03T08:00:00.000Z', revision: '7', raw: { id: n, rev: 7 }, ...o,
});
byId.set('work::invoice-azdo::4711', ado(4711, {
  type: { name: 'Feature', category: 'feature' }, title: 'Export approved invoices to the ERP',
  body: { format: 'html', raw: '<p>Post each approved invoice to the ERP ledger.</p>', text: 'Post each approved invoice to the ERP ledger.' },
  state: { name: 'Active', category: 'in-progress', since: '2026-09-21T09:00:00.000Z' }, assignee: CHIDI, labels: ['erp'],
  area: 'Invoicing\\Integrations', iteration: { name: 'Sprint 12' }, updated: '2026-09-27T14:10:00.000Z',
  history: [{ at: '2026-09-21T09:00:00.000Z', by: CHIDI, field: 'System.State', from: 'New', to: 'Active' }],
}));
byId.set('work::invoice-azdo::4712', ado(4712, {
  type: { name: 'User Story', category: 'story' }, title: 'Customer downloads an invoice as a PDF',
  body: { format: 'html', raw: '<p>A PDF link on the invoice page.</p>', text: 'A PDF link on the invoice page.' },
  state: { name: 'Resolved', category: 'in-progress' }, labels: ['pdf'], area: 'Invoicing\\Portal', updated: '2026-09-26T10:00:00.000Z',
  fields: { stateUndefinedByType: true },
}));
const items = [...byId.values()];

const nodeIds = {
  form: 'invoice-app::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm',
  submit: 'invoice-app::src/ui/CreateInvoiceForm.tsx::submit',
  clientCreate: 'invoice-app::src/api/client.ts::createInvoice',
  svcCreate: 'invoice-app::src/server/invoiceService.ts::createInvoice',
  list: 'invoice-app::src/ui/InvoiceListPage.tsx::InvoiceListPage',
  svcList: 'invoice-app::src/server/invoiceService.ts::listInvoices',
  tax: 'invoice-app::src/server/taxEngine.ts::computeTax',
  taxRate: 'invoice-app::src/server/taxEngine.ts::taxRateFor',
  approve: 'invoice-app::route::POST /invoices/:id/approve',
  ocr: 'invoice-app::src/server/ocr.ts::readInvoice',
  newPage: 'invoice-app::page::/invoices/new',
};
const commit = (sha, subject, via, at, author, files, branch) => ({ repo: 'invoice-app', sha, at, author, subject, via, ...(branch ? { branch } : {}), files: files.map(([path, status]) => ({ path, status })), nodes: [] });
const joins = {
  'work::invoice-jira::INV-2': {
    links: [
      { nodeId: nodeIds.newPage, via: 'declared', tier: 'HIGH', provenance: 'screens.json names INV-2 on the new-invoice screen' },
      { nodeId: nodeIds.form, via: 'commit', tier: 'MEDIUM', sha: 'a1c9e02', provenance: 'commit a1c9e02 names INV-2 in its subject' },
      { nodeId: nodeIds.svcCreate, via: 'commit', tier: 'MEDIUM', sha: 'a1c9e02', provenance: 'commit a1c9e02 names INV-2 in its subject' },
    ],
    commits: [
      commit('a1c9e02', 'INV-2 draft form saves line items', 'subject', '2026-09-08T16:40:00.000Z', 'Ben Lindqvist', [['src/ui/CreateInvoiceForm.tsx', 'modified'], ['src/server/invoiceService.ts', 'modified']]),
      commit('5d0b7f1', 'Merge pull request #14 from INV-2-new-invoice', 'merge-subject', '2026-09-10T14:55:00.000Z', 'Ben Lindqvist', [['src/api/client.ts', 'modified']]),
    ],
    findings: [],
  },
  'work::invoice-jira::INV-3': {
    links: [{ nodeId: nodeIds.list, via: 'branch', tier: 'MEDIUM', sha: '9e41aa3', provenance: 'branch INV-3-newest-first' }],
    commits: [commit('9e41aa3', 'Sort the invoice list newest first', 'branch', '2026-09-24T10:12:00.000Z', 'Ben Lindqvist', [['src/server/invoiceService.ts', 'modified']], 'INV-3-newest-first')],
    findings: [],
  },
  'work::invoice-jira::INV-4': {
    links: [],
    commits: [],
    findings: [{ kind: 'done-not-built', text: 'Discard a draft invoice is done; no code in the graph is linked to it', provenances: [{ source: 'tracker', what: 'INV-4 is Done since 12 Sep' }, { source: 'code', what: 'no commit, branch or declaration names INV-4' }] }],
  },
  'work::invoice-jira::INV-5': {
    links: [{ nodeId: nodeIds.approve, via: 'commit', tier: 'MEDIUM', sha: 'c07d2b9', provenance: 'commit c07d2b9 names INV-5 in its subject' }],
    commits: [commit('c07d2b9', 'INV-5 approval route behind requireScope', 'subject', '2026-09-28T09:30:00.000Z', 'Ada Okafor', [['src/server/approvals.ts', 'modified']])],
    findings: [{ kind: 'todo-but-committed', text: 'Approve an invoice before it is sent is to do; 1 commit names it', provenances: [{ source: 'tracker', what: 'INV-5 is To Do' }, { source: 'code', what: 'commit c07d2b9 names INV-5' }] }],
  },
  'work::invoice-jira::INV-6': {
    links: [
      { nodeId: nodeIds.tax, via: 'commit', tier: 'MEDIUM', sha: 'e5f21c8', provenance: 'commit e5f21c8 names INV-6 in its subject' },
      { nodeId: nodeIds.taxRate, via: 'commit', tier: 'MEDIUM', sha: 'e5f21c8', provenance: 'commit e5f21c8 names INV-6 in its subject' },
    ],
    commits: [
      commit('e5f21c8', 'INV-6 round tax per line, not per invoice', 'subject', '2026-09-17T13:02:00.000Z', 'Ada Okafor', [['src/server/taxEngine.ts', 'modified'], ['test/taxEngine.test.ts', 'added']]),
      commit('b88e1d4', 'INV-6 keep two decimals in taxRateFor', 'subject', '2026-09-18T09:45:00.000Z', 'Ada Okafor', [['src/server/taxEngine.ts', 'modified']]),
    ],
    findings: [],
  },
  'work::invoice-jira::INV-7': {
    links: [{ nodeId: nodeIds.ocr, via: 'url', tier: 'LOW', provenance: 'the item body names the OCR reader' }],
    commits: [],
    findings: [],
  },
};
// what each commit touched, by file → nodes (the server reads these from the graph)
const touch = {
  'src/ui/CreateInvoiceForm.tsx': [nodeIds.form, nodeIds.submit],
  'src/server/invoiceService.ts': [nodeIds.svcCreate, nodeIds.svcList],
  'src/api/client.ts': [nodeIds.clientCreate],
  'src/server/taxEngine.ts': [nodeIds.tax, nodeIds.taxRate],
  'src/server/approvals.ts': [nodeIds.approve],
};
for (const j of Object.values(joins)) for (const c of j.commits) c.nodes = [...new Set(c.files.flatMap((f) => touch[f.path] || []))];
if (joins['work::invoice-jira::INV-3']) joins['work::invoice-jira::INV-3'].commits[0].nodes = [nodeIds.svcList];

const hunk = (lines) => lines.join('\n') + '\n';
const diffs = {
  a1c9e02: { files: [
    { path: 'src/ui/CreateInvoiceForm.tsx', status: 'modified', nodes: [nodeIds.form, nodeIds.submit], patch: hunk([
      '@@ -13,9 +13,12 @@ export function CreateInvoiceForm({ onDone }: { onDone: () => void }) {',
      '   async function submit(form: FormData) {',
      '     const draft = {',
      '       customerId: String(form.get(\'customer\')),',
      '-      lines: [{ description: String(form.get(\'desc\')), amount: Number(form.get(\'amount\')) }],',
      '+      lines: form.getAll(\'desc\').map((d, i) => ({',
      '+        description: String(d),',
      '+        amount: Number(form.getAll(\'amount\')[i]),',
      '+      })),',
      '     };',
      '     const parsed = draftInvoiceSchema.safeParse(draft);',
      '     if (!parsed.success) {',
    ]) },
    { path: 'src/server/invoiceService.ts', status: 'modified', nodes: [nodeIds.svcCreate], patch: hunk([
      '@@ -24,6 +24,7 @@ export async function createInvoice(draft: DraftInvoice) {',
      '   const number = await nextInvoiceNumber();',
      '-  return db.invoices.insert({ ...draft, number, status: \'draft\' });',
      '+  const total = draft.lines.reduce((s, l) => s + l.amount, 0);',
      '+  return db.invoices.insert({ ...draft, number, total, status: \'draft\' });',
      ' }',
    ]) },
  ] },
  '5d0b7f1': { files: [{ path: 'src/api/client.ts', status: 'modified', nodes: [nodeIds.clientCreate], patch: hunk([
    '@@ -18,4 +18,5 @@ export async function createInvoice(draft: DraftInvoice) {',
    '-  return post(\'/invoices\', draft);',
    '+  const res = await post(\'/invoices\', draft);',
    '+  return res.invoice;',
    ' }',
  ]) }] },
  '9e41aa3': { files: [{ path: 'src/server/invoiceService.ts', status: 'modified', nodes: [nodeIds.svcList], patch: hunk([
    '@@ -6,3 +6,3 @@',
    ' export async function listInvoices() {',
    '-  return db.invoices.findMany({ orderBy: \'created_at\' });',
    '+  return db.invoices.findMany({ orderBy: \'created_at\', direction: \'desc\' });',
    ' }',
  ]) }] },
  c07d2b9: { files: [{ path: 'src/server/approvals.ts', status: 'modified', nodes: [nodeIds.approve], patch: hunk([
    '@@ -40,6 +40,8 @@ export async function approveInvoice(req: Request) {',
    '+  // INV-5: only an approver may approve',
    '+  requireScope(req, \'invoices:approve\');',
    '   const invoice = await db.invoices.findOne({ id: req.params.id });',
  ]) }] },
  e5f21c8: { files: [
    { path: 'src/server/taxEngine.ts', status: 'modified', nodes: [nodeIds.tax], patch: hunk([
      '@@ -9,5 +9,6 @@ export async function computeTax(customerId: string, subtotal: number) {',
      '   const customer = await db.customers.findOne({ id: customerId });',
      '   const rate = RATES[customer?.country ?? \'US\'] ?? 0;',
      '-  return Math.round(subtotal * rate * 100) / 100;',
      '+  // round each line, then add: the invoice total matches the lines',
      '+  return Math.round(subtotal * rate * 100 + Number.EPSILON) / 100;',
      ' }',
    ]) },
    { path: 'test/taxEngine.test.ts', status: 'added', nodes: [], patch: hunk([
      '@@ -0,0 +1,4 @@',
      '+import { computeTax } from \'../src/server/taxEngine\';',
      '+test(\'rounds half up per line\', async () => {',
      '+  expect(await computeTax(\'c-1\', 10.005)).toBe(2.0);',
      '+});',
    ]) },
  ] },
  b88e1d4: { files: [{ path: 'src/server/taxEngine.ts', status: 'modified', nodes: [nodeIds.taxRate], patch: hunk([
    '@@ -40,3 +40,3 @@ export function taxRateFor(country: string) {',
    '-  return RATES[country] ?? 0;',
    '+  return Number((RATES[country] ?? 0).toFixed(2));',
    ' }',
  ]) }] },
};
for (const [sha, d] of Object.entries(diffs)) {
  const c = Object.values(joins).flatMap((j) => j.commits).find((x) => x.sha === sha);
  Object.assign(d, { sha, subject: c.subject, at: c.at, author: c.author });
}

const sources = [
  { id: 'invoice-jira', provider: 'jira', mode: 'edit', site: 'https://invoice-app.atlassian.net', scope: { projects: ['INV'] },
    capabilities: { comments: { read: true, write: true, format: 'adf' }, transitions: 'per-item', concurrency: 'compare-updated', permissionsProbe: 'per-item', deletesVisible: false, push: 'none', dryRun: false, actions: ['comment', 'edit', 'assign', 'transition', 'link', 'label'] },
    freshness: { state: 'synced', since: '2026-09-30T09:57:00.000Z', ago: 180, syncNo: 14 }, user: { id: ADA.id, name: ADA.name } },
  { id: 'invoice-azdo', provider: 'azure-devops', mode: 'read-only', org: 'https://dev.azure.com/invoice-app', scope: { projects: ['Invoicing'], areas: ['Invoicing\\Integrations', 'Invoicing\\Portal'] },
    capabilities: { comments: { read: true, write: false, format: 'markdown' }, transitions: 'graph', concurrency: 'revision', permissionsProbe: 'per-area', deletesVisible: true, push: 'none', dryRun: true },
    freshness: { state: 'unreachable', since: '2026-09-30T09:14:00.000Z', ago: 2760, error: 'ECONNREFUSED dev.azure.com' },
    // the same person, as Azure DevOps knows her (its own id)
    user: { id: 'aad.QWRh', name: ADA.name } },
];
const people = { 'invoice-jira': [ADA, BEN], 'invoice-azdo': [CHIDI] };
const states = {
  'invoice-jira': [{ name: 'To Do', category: 'todo' }, { name: 'In Progress', category: 'in-progress' }, { name: 'In Review', category: 'in-progress' }, { name: 'Done', category: 'done' }],
  'invoice-azdo': [{ name: 'New', category: 'todo' }, { name: 'Active', category: 'in-progress' }, { name: 'Resolved', category: 'in-progress' }, { name: 'Closed', category: 'done' }, { name: 'Removed', category: 'removed' }],
};
// flows → the items that track them (a server derives this from `tracks` edges)
const flows = {
  'invoice-app::flow::new-invoice': ['work::invoice-jira::INV-2', 'work::invoice-jira::INV-3', 'work::invoice-jira::INV-4'],
  'invoice-app::flow::draft-and-send': ['work::invoice-jira::INV-2', 'work::invoice-jira::INV-5', 'work::invoice-jira::INV-9'],
  'invoice-app::flow::billing-cycle': [],
};
const outbox = [
  { id: 'int-0007', item: 'work::invoice-jira::INV-6', key: 'INV-6', action: 'comment', payload: { body: 'the rounding fix is in computeTax' }, requestedBy: { kind: 'agent', id: 'mcp-7f3a', tool: 'work_comment' }, status: 'pending',
    verdicts: { policy: { allowed: true, reason: 'comments are granted to agents, with a person confirming' }, tracker: { allowed: true, reason: 'the item is open to this user' }, credential: { allowed: true, reason: 'the API token can write work items' } } },
  { id: 'int-0006', item: 'work::invoice-jira::INV-3', key: 'INV-3', action: 'edit', payload: { title: 'List invoices, newest first' }, requestedBy: { kind: 'human', id: ADA.id }, status: 'conflict',
    verdicts: { policy: { allowed: true, reason: 'title edits are granted to people' }, tracker: { allowed: true, reason: 'the item is open to this user' }, credential: { allowed: true, reason: 'the API token can write work items' } } },
];

const out = (name, v) => writeFileSync(join(here, name), JSON.stringify(v, null, 1) + '\n');
out('sources.json', sources);
out('items.json', items);
out('joins.json', joins);
out('diffs.json', diffs);
out('people.json', people);
out('states.json', states);
out('flows.json', flows);
out('outbox.json', outbox);
console.log('wrote', items.length, 'items,', Object.keys(diffs).length, 'diffs');
