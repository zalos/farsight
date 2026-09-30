import { Router } from 'express';
import { requireScope } from './auth';
import { draftInvoiceSchema, updateInvoiceSchema } from './schemas';
import { createInvoice, updateInvoice, finalizeInvoice, listInvoices, getInvoice } from './invoiceService';

export const router = Router();

router.get('/invoices', requireScope('billing:read'), async (req, res) => {
  res.json(await listInvoices());
});

router.get('/invoices/:id', requireScope('billing:read'), async (req, res) => {
  res.json(await getInvoice(req.params.id));
});

router.post('/invoices', requireScope('billing:write'), async (req, res) => {
  const draft = draftInvoiceSchema.parse(req.body);
  res.status(201).json(await createInvoice(draft));
});

router.patch('/invoices/:id', requireScope('billing:write'), async (req, res) => {
  const patch = updateInvoiceSchema.parse(req.body);
  res.json(await updateInvoice(req.params.id, patch));
});

router.post('/invoices/:id/finalize', requireScope('billing:admin'), async (req, res) => {
  res.json(await finalizeInvoice(req.params.id));
});

// Approvals were added after the first five routes. ES module imports are hoisted,
// so declaring this one beside its route keeps the diff — and the file — readable.
import { approveInvoice } from './approvals';

router.post('/invoices/:id/approve', requireScope('billing:admin'), async (req, res) => {
  res.json(await approveInvoice(req.params.id));
});
