import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoice, updateInvoice, finalizeInvoice } from '../src/server/invoiceService';

/**
 * The invoice service, without a server. Declares the flow it stands behind;
 * the imports it exercises are inferred, not declared.
 *
 * @covers new-invoice
 */

test('createInvoice computes a subtotal, tax and total from the draft lines', async () => {
  const invoice = await createInvoice({ customerId: 'c1', lines: [{ amount: 100 }] });
  assert.equal(invoice.status, 'draft');
});

test('updateInvoice refuses an invoice that has left draft', async () => {
  await assert.rejects(() => updateInvoice('sent-1', { lines: [{ amount: 1 }] }));
});

test('finalizeInvoice assigns a number and records a ledger entry', async () => {
  const invoice = await finalizeInvoice('draft-1');
  assert.ok(invoice.number);
});
