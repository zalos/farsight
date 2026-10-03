/** The billing database; each property is one table. */
export const db = {
  invoices: table('invoices'),
};

function table(name: string) {
  return {
    name,
    findMany: (_q?: unknown): any[] => [],
  };
}
