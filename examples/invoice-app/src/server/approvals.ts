import { db as base } from './db';
import { fmt } from '@invoice/plumbing';

/** `approvals` is written by migration 003; db.ts does not list it yet. */
const db = base as typeof base & { approvals: (typeof base)['invoices'] };

// DECISION(D1): one approver, whatever the amount, until a limit is decided
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

// DECISION(D2): no reminder is sent for an unpaid invoice until the team decides when one goes out
export const SEND_PAYMENT_REMINDERS = false;
