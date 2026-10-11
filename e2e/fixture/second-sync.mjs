// The second sync of the compare fixture (round 2026-10-10, compare two syncs): a copy of
// examples/invoice-app edited the way a week of work edits it, so two real ingests of the
// copy give the storyline diff one change of every kind it knows.
//
// - built     — Discard draft gets its page (`/invoices/:id/discard`), so the designed screen is served
// - contract  — the page calls `DELETE /invoices/:id`, the operation the spec declared and nothing served
// - gate      — that route is guarded (`requireScope('billing:admin')`), and creating an invoice gains a
//               second scope check (`requireScope('billing:create')`)
// - writer    — the route voids the invoice: `void` gains its first writer
// - verdict   — the e2e case that saves a draft was skipped on its last run, on both projects
//
// Applied to a copy only — the checked-in example stays what every other suite reads.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Edit the invoice-app copy at `dir` in place. */
export function applySecondSync(dir) {
  const edit = (rel, fn) => { const p = join(dir, rel); writeFileSync(p, fn(readFileSync(p, 'utf8'))); };

  // the page that serves Discard draft, and its call
  writeFileSync(join(dir, 'src/ui/DiscardDraftPage.tsx'), [
    "import { voidInvoice } from '../api/client';",
    '',
    '/** Confirms and discards a draft invoice that will never be sent. */',
    'export function DiscardDraftPage({ invoiceId }: { invoiceId: string }) {',
    '  return <button onClick={() => voidInvoice(invoiceId)}>Discard draft</button>;',
    '}',
    '',
  ].join('\n'));
  edit('src/ui/router.tsx', (s) => s
    .replace("import { EditInvoiceDrawer } from './EditInvoiceDrawer';", "import { EditInvoiceDrawer } from './EditInvoiceDrawer';\nimport { DiscardDraftPage } from './DiscardDraftPage';")
    .replace("  { path: '/invoices/:id/edit',", "  { path: '/invoices/:id/discard', element: <DiscardDraftPage invoiceId={''} /> },\n  { path: '/invoices/:id/edit',"));
  edit('src/api/client.ts', (s) => s + [
    '',
    '/** Discards a draft: the invoice is voided, never deleted. */',
    'export async function voidInvoice(id: string) {',
    "  const res = await fetch(`/invoices/${id}`, { method: 'DELETE' });",
    '  return res.json();',
    '}',
    '',
  ].join('\n'));

  // the route, its gate, and the writer it reaches; creating an invoice gains a second scope check
  edit('src/server/routes.ts', (s) => s
    .replace("import { createInvoice, updateInvoice, finalizeInvoice, listInvoices, getInvoice } from './invoiceService';",
      "import { createInvoice, updateInvoice, finalizeInvoice, listInvoices, getInvoice, voidInvoice } from './invoiceService';")
    .replace("router.post('/invoices', requireScope('billing:write'), async", "router.post('/invoices', requireScope('billing:write'), requireScope('billing:create'), async")
    + [
      '',
      "router.delete('/invoices/:id', requireScope('billing:admin'), async (req, res) => {",
      '  res.json(await voidInvoice(req.params.id));',
      '});',
      '',
    ].join('\n'));
  edit('src/server/invoiceService.ts', (s) => s + [
    '',
    '/** Voids a draft that will never be sent. */',
    'export async function voidInvoice(id: string) {',
    "  return db.invoices.update({ id }, { status: 'void' });",
    '}',
    '',
  ].join('\n'));

  // the last run: the case that saves a draft was skipped, on both projects
  edit('e2e/results.json', (s) => {
    const r = JSON.parse(s);
    const walk = (suite) => {
      for (const sp of suite.specs ?? []) {
        if (sp.title !== 'a draft is saved for the picked customer') continue;
        for (const t of sp.tests) { t.status = 'skipped'; t.expectedStatus = 'skipped'; for (const x of t.results) x.status = 'skipped'; }
      }
      for (const c of suite.suites ?? []) walk(c);
    };
    for (const s0 of r.suites) walk(s0);
    return JSON.stringify(r, null, 2);
  });
}
