/** The statuses an invoice moves through: drafted, sent to the customer, approved, paid — or voided. */
export type InvoiceStatus = 'draft' | 'open' | 'approved' | 'paid' | 'void';

/** One row of the invoices table, as the services read it. */
export interface InvoiceRow {
  id: string;
  customerId: string;
  status: InvoiceStatus;
  total: number;
}

/** Thin data-access layer; each property is one table. */
export const db = {
  invoices: table('invoices'),
  ledger_entries: table('ledger_entries'),
  customers: table('customers'),
};

function table(name: string) {
  return {
    findMany: async (_q?: unknown): Promise<any[]> => [],
    findOne: async (_q?: unknown): Promise<any> => null,
    insert: async (row: any): Promise<any> => row,
    update: async (_q: unknown, patch: any): Promise<any> => patch,
  };
}
