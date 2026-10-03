import { format } from 'date-fns';
import { listOpenInvoices, type Invoice } from '@nxw/billing/data-access';
import { AmountCell } from '@nxw/billing/ui';

/** The open invoices, newest first, with their due date and amount. */
export function InvoiceList({ invoices = listOpenInvoices() }: { invoices?: Invoice[] }) {
  return (
    <ul>
      {invoices.map((inv) => (
        <li key={inv.id}>
          {inv.number} · due {format(inv.dueAt, 'd MMM yyyy')} · <AmountCell cents={inv.totalCents} />
        </li>
      ))}
    </ul>
  );
}
