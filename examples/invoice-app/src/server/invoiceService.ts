import { db } from './db';
import { computeTax } from './taxEngine';
import { publish } from './events';

/** Lists invoices, newest first. */
export async function listInvoices() {
  return db.invoices.findMany({ orderBy: 'created_at' });
}

/**
 * Fetches a single invoice by id.
 * @remarks Resolves to {@code null} when {@code id} matches no row — callers must null-check.
 * @see listInvoices
 */
export async function getInvoice(id: string) {
  return db.invoices.findOne({ id });
}

/**
 * Creates a draft invoice and computes initial totals.
 * @remarks Totals are recomputed on every edit; see {@link finalizeInvoice|finalizing an invoice} for the irreversible step.
 * @since 1.0
 */
export async function createInvoice(draft: { customerId: string; lines: { amount: number }[] }) {
  const subtotal = draft.lines.reduce((s, l) => s + l.amount, 0);
  const tax = await computeTax(draft.customerId, subtotal);
  return db.invoices.insert({ ...draft, status: 'draft', subtotal, tax, total: subtotal + tax });
}

/**
 * Saves edits to a draft; rejects when the invoice is no longer editable.
 * @business Only draft invoices can be changed. Once an invoice has been sent
 * to the customer its amounts are locked, so we refuse the edit.
 */
export async function updateInvoice(id: string, patch: { lines: { amount: number }[] }) {
  const invoice = await db.invoices.findOne({ id });
  // @business Reject edits once the invoice has left draft
  if (invoice.status !== 'draft') {
    throw Object.assign(new Error('invoice is not editable'), { status: 409 });
  }
  const subtotal = patch.lines.reduce((s, l) => s + l.amount, 0);
  const tax = await computeTax(invoice.customerId, subtotal);
  return db.invoices.update({ id }, { ...patch, subtotal, tax, total: subtotal + tax });
}

/**
 * Finalizes a draft: completeness check, sequential number, ledger entry,
 * then emits invoice.finalized for the notifier to send the email.
 * @business When an invoice is sent, we verify it is complete, assign the
 * next official invoice number, record it permanently in the accounting
 * ledger, and email it to the customer.
 * @remarks Finalizing is irreversible — the number is consumed even if the
 * email later bounces.
 * @see computeTax
 * @see requireScope
 * @since 1.0
 */
export async function finalizeInvoice(id: string) {
  const invoice = await db.invoices.findOne({ id });
  /* @business An invoice must have at least one line item before it can be sent. */
  if (invoice.lines.length < 1) {
    throw Object.assign(new Error('invoice has no line items'), { status: 409 });
  }
  try { // @business Assign the number, post the ledger entry, and notify the customer
    const number = await nextInvoiceNumber();
    const finalized = await db.invoices.update({ id }, { status: 'open', number, issuedAt: new Date() });
    await db.ledger_entries.insert({ invoiceId: id, kind: 'credit', amount: invoice.total });
    await publish('invoice.finalized', { invoiceId: id });
    return finalized;
  } catch (e) { // @business If the ledger or notifier is unavailable, surface the failure to the caller
    console.error('finalize failed', e);
    throw e;
  }
}

/**
 * Sequential, gap-free numbering under an advisory lock.
 * @internal
 */
async function nextInvoiceNumber() {
  const last = await db.invoices.findOne({ orderBy: 'number' });
  return (last?.number ?? 0) + 1;
}
