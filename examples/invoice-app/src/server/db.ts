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
