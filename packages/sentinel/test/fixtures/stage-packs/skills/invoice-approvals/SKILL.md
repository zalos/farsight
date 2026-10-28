---
name: invoice-approvals
description: Check that every change to an invoice's status is gated by who may make it and by the status it leaves.
---

# Invoice approvals

When you review code that changes an invoice's status:

1. Find the route or handler that makes the change and the role or scope it requires.
2. Check that the change is refused unless the invoice is in the status it may leave (an approved invoice cannot
   be approved again; a paid one cannot go back).
3. Check that the writes that must land together (the approval record and the status) run in one transaction.

Report each gap as one observation on the line that makes the change.
