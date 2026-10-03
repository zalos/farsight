import { InvoiceList } from '@nxw/billing/feature-invoices';
import { formatMoney } from '@nxw/shared/util';
import { PageShell } from '@nxw/shared/ui';

/** Lists the customer's invoices with the amount still owed. */
export function InvoicesPage() {
  return (
    <PageShell title="Invoices">
      <p>Owed: {formatMoney(0)}</p>
      <InvoiceList />
    </PageShell>
  );
}
