import { useEffect, useState } from 'react';
import { getInvoice, updateInvoice, finalizeInvoice } from '../api/client';

/**
 * Edit line items on a draft invoice; posted invoices are read-only here.
 * @business Lets a user change a draft invoice before it is sent. Sent
 * invoices are shown but can no longer be edited.
 */
export function EditInvoiceDrawer({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const [invoice, setInvoice] = useState<any>(null);

  useEffect(() => {
    getInvoice(invoiceId).then(setInvoice);
  }, [invoiceId]);

  async function onSave(lines: unknown[]) {
    if (invoice.status !== 'draft') {
      return; // posted invoices are read-only
    } else { // @business Draft is still editable — persist the line-item changes
      await updateInvoice(invoiceId, { lines });
    }
  }

  async function onSend() {
    // @business Only a draft can be sent; sending finalizes it for good
    if (invoice.status !== 'draft') return;
    await finalizeInvoice(invoiceId);
    onClose();
  }

  if (!invoice) return null;
  return (
    <aside>
      <h2>Invoice {invoice.number ?? '(draft)'}</h2>
      <button onClick={() => onSave(invoice.lines)} disabled={invoice.status !== 'draft'}>
        Save
      </button>
      <button onClick={onSend} disabled={invoice.status !== 'draft'}>
        Send invoice
      </button>
    </aside>
  );
}
