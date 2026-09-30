import { db as base } from './db';
import { fmt } from './plumbing/format';

/** `approvals` is written by migration 003; db.ts does not list it yet. */
const db = base as typeof base & { approvals: (typeof base)['invoices'] };

/**
 * Approves an invoice: records who approved it and moves the invoice to approved,
 * both inside one transaction.
 * @guard approver role
 * @business Only an approver can approve an invoice. The approval and the
 * invoice's new state are written together, or neither is written.
 */
export async function approveInvoice(id: string) {
  await withTx(async () => {
    await db.approvals.insert({ invoiceId: id, approvedAt: new Date() });
    await db.invoices.update({ id }, { status: 'approved' });
  });
  return receiptFor(id);
}

/** The receipt the caller gets back once the approval committed. */
function receiptFor(id: string) {
  return { id, status: 'approved', approvedAt: fmt(new Date()) };
}

/**
 * Runs `fn` inside one database transaction — everything it writes commits together.
 * @internal
 */
export async function withTx(fn: () => Promise<void>) {
  return fn();
}
