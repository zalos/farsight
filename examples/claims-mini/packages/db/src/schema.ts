declare function pgTable(name: string, cols: Record<string, unknown>): unknown;

/** @business All warranty claims filed by customers. */
export const claims = pgTable('claims', {
  id: 'uuid',
  clientId: 'uuid',
  status: 'text',
  amountCents: 'integer',
});

/** @business Payments issued against approved claims. */
export const payments = pgTable('payments', {
  id: 'uuid',
  claimId: 'uuid',
  executedAt: 'timestamp',
});
