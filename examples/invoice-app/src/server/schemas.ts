import { z } from 'zod';

/** Shared draft-invoice validation — used client-side and by POST /invoices. */
export const draftInvoiceSchema = z.object({
  customerId: z.string().min(1),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        amount: z.number().nonnegative(),
      })
    )
    .min(1),
});

/** PATCH /invoices/:id body — only lines and terms are editable. */
export const updateInvoiceSchema = z.object({
  lines: z.array(z.object({ description: z.string(), amount: z.number().nonnegative() })).min(1),
  terms: z.string().optional(),
});
