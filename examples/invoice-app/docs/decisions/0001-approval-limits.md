# ADR 0001 — Approval has no amount limit yet

Status: Proposed

An invoice is approved by one person holding the billing admin scope, whatever its amount. The team has not decided
whether an invoice above a limit needs a second approver; until it does, the code approves on one person's word and
records who that was.

## Context

Customers asked for a second approver on large invoices. Nobody has named the limit or who would be the second
person, so the approval route stays single-approver.
