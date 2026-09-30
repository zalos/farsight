import { useEffect, useState } from 'react';
import { listInvoices } from '../api/client';
import { CreateInvoiceForm } from './CreateInvoiceForm';
import { EditInvoiceDrawer } from './EditInvoiceDrawer';

/** Lists invoices with status filters; entry point of the invoice UX. */
export function InvoiceListPage() {
  const [invoices, setInvoices] = useState<unknown[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listInvoices().then(setInvoices);
  }, []);

  return (
    <div>
      <button onClick={() => setCreating(true)}>New invoice</button>
      <ul>
        {invoices.map((inv: any) => (
          <li key={inv.id} onClick={() => setEditing(inv.id)}>
            {inv.number ?? 'draft'} — {inv.total}
          </li>
        ))}
      </ul>
      {creating && <CreateInvoiceForm onDone={() => setCreating(false)} />}
      {editing && <EditInvoiceDrawer invoiceId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
