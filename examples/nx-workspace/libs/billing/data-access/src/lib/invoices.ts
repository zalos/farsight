import { db } from './db';

export interface Invoice {
  id: string;
  number: string;
  dueAt: Date;
  totalCents: number;
}

/** Invoices the customer still has to pay. */
export function listOpenInvoices(): Invoice[] {
  return db.invoices.findMany({ where: { status: 'open' } });
}
