import { db, type InvoiceStatus } from './db';

// DECISION: recording a payment intent is not "paid" — only the confirmation from the bank marks an invoice paid.
// Flip this constant if the business decides the intent is enough; the call below then runs.
export const INTENT_MARKS_PAID = false;

/**
 * Records how and when an approved invoice will be paid.
 * @business The payment is planned, not made: the invoice stays approved until the bank confirms it.
 */
export async function recordPaymentIntent(id: string, ref: string) {
  const invoice = await db.invoices.findOne({ id });
  if (invoice.status !== 'approved') {
    throw Object.assign(new Error('only an approved invoice can be paid'), { status: 409 });
  }
  await db.invoices.update({ id }, { paymentRef: ref });
  if (INTENT_MARKS_PAID) {
    await settleInvoice(id);
  }
  return { id, ref };
}

/**
 * Marks an approved invoice paid once the bank confirms the payment.
 * @business The invoice is paid when the money has arrived, never before.
 */
export async function markInvoicePaid(id: string) {
  const invoice = await db.invoices.findOne({ id });
  if (invoice.status !== 'approved') {
    throw Object.assign(new Error('only an approved invoice can be marked paid'), { status: 409 });
  }
  await settleInvoice(id);
  return { id, status: 'paid' };
}

/** The one place an invoice becomes paid. */
async function settleInvoice(id: string) {
  await db.invoices.update({ id }, { status: 'paid', paidAt: new Date() });
}

/**
 * Takes a sent invoice back to draft so its lines can change.
 * @business A sent invoice can be pulled back for changes; it is sent again from the draft.
 */
export async function reopenInvoice(id: string) {
  await setInvoiceStatus(id, 'draft');
  return { id, status: 'draft' };
}

/**
 * Sends an invoice back from approval: to draft when it was raised in error, else back to sent for another look.
 * @business A rejected approval either reopens the draft or returns the invoice to the sender.
 */
export async function rejectApproval(id: string, raisedInError: boolean) {
  await setInvoiceStatus(id, raisedInError ? 'draft' : 'open');
  return { id };
}

/** Writes an invoice's status. */
async function setInvoiceStatus(id: string, status: InvoiceStatus) {
  return db.invoices.update({ id }, { status });
}
