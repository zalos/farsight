import { useState } from 'react';
import { createInvoice } from '../api/client';
import { draftInvoiceSchema } from '../server/schemas';
import { LineItemRow } from './fields';

/**
 * Form to draft a new invoice; validates client-side with the shared zod schema.
 * @beta
 */
export function CreateInvoiceForm({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData) {
    const draft = {
      customerId: String(form.get('customer')),
      lines: [{ description: String(form.get('desc')), amount: Number(form.get('amount')) }],
    };
    const parsed = draftInvoiceSchema.safeParse(draft);
    if (!parsed.success) { // @business Invalid input — show the validation errors instead of submitting
      setError(parsed.error.message);
      return;
    }
    await createInvoice(parsed.data);
    onDone();
  }

  return (
    <form action={submit}>
      <input name="customer" placeholder="Customer" />
      <LineItemRow onChange={() => {}} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Create draft</button>
    </form>
  );
}
