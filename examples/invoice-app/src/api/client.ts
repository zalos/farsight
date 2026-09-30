/** Typed API client — every function maps to one billing route. */

/** Fetches every invoice for the list view. */
export async function listInvoices() {
  const res = await fetch('/invoices');
  return res.json();
}

/**
 * Fetches one invoice by id.
 * @remarks Pass the {@code id} from the list row.
 */
export async function getInvoice(id: string) {
  const res = await fetch(`/invoices/${id}`);
  return res.json();
}

export async function createInvoice(draft: unknown) {
  const res = await fetch('/invoices', { method: 'POST', body: JSON.stringify(draft) });
  return res.json();
}

export async function updateInvoice(id: string, patch: unknown) {
  const res = await fetch(`/invoices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return res.json();
}

export async function finalizeInvoice(id: string) {
  const res = await fetch(`/invoices/${id}/finalize`, { method: 'POST' });
  return res.json();
}
