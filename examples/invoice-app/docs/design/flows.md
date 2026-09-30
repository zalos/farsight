# Invoice app — flows

## Billing cycle

The whole cycle, as three flows that link up: **Start a new invoice** (INV-02 New invoice) leads to
**Draft and send an invoice** (INV-01 Invoice list, then INV-03 Discard draft — designed, not built);
**Billing cycle** is the longer flow that contains both, so Farsight derives that *Draft and send*
requires *Start a new invoice* and is part of *Billing cycle*. *Start a new invoice* declares
`leadsTo: ["draft-and-send"]` explicitly. Finalizing is a separate route today
(`POST /invoices/:id/finalize`), which the spec does not declare yet.
