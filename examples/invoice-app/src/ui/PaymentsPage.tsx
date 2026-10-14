import { recordPaymentIntent, markInvoicePaid } from '../api/client';

/**
 * Plan and confirm the payment of one approved invoice.
 * @business Operations records how an approved invoice will be paid, then marks it paid when the bank confirms.
 */
export function PaymentsPage({ invoiceId }: { invoiceId: string }) {
  async function onIntent(ref: string) {
    await recordPaymentIntent(invoiceId, ref);
  }

  async function onPaid() {
    await markInvoicePaid(invoiceId);
  }

  return (
    <section>
      <button onClick={() => onIntent('bank-transfer')}>Record payment intent</button>
      <button onClick={onPaid}>Mark paid</button>
    </section>
  );
}
