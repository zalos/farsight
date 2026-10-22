# Model providers and review: definition of done through release

**Status (2026-10-22).** PR 21 (`review/providers`, ADR 35) and PR 22 (`review`, ADR 39) are library-complete over
trusted settings and registered contracts, and tested with local mock endpoints and mock callers. They are **not
delivered**: neither runs inside the coordinator, the CLI or the report yet, and no live model has been evaluated.
An item closes only with a merged change and its test, never by this file.

Revisions: provider `f7c8fc9a` (independently approved); review `e60b733c` (frozen for review), then settings and
registry integration on the same branch.

## Done in the library (with tests)

- [x] Ollama and capability-probed OpenAI-compatible transport. Fixed origin; no redirects; TLS always verified;
      request, response, time, context and cancellation bounds; credentials read in process and never printed;
      identity at its actual strength.
- [x] Owner-receipt binding of origin, credential reference, disclosure, model, limits, price, terms and
      capability. Admission inputs are frozen before any await; any policy change stops an envelope.
- [x] Durable shared budget ledger: worst case reserved before dispatch; uncertain spend stays charged across
      recovery; a per-call overrun freezes the envelope; collision-free ids; cross-process reservations (6 processes).
- [x] Model configuration in adopted settings (`providers[].models[]`), validated. `bindProvider` and
      `probeConfigured` read only adopted values; the settings example carries scrubbed models.
- [x] Deterministic partitions independent of findings; constrained evidence broker; closed reply grammar;
      citation membership and re-verification; inspection ledger apart from coverage; observations as proposals.
- [x] Checkpointed sessions that never re-send a settled operation. Checkpoints are size-capped and validated;
      replayed, forged and other-prompt checkpoints are refused.
- [x] Registered envelopes `sentinel-review-partitions`, `-checkpoint` and `-record` (draft-1), with schemas,
      invariants, valid fixtures and 33 adversarial invalid cases, plus settings model cases.
- [x] Withheld secret-location citations consumed by discriminator: files out of review whole, entry-indexed
      gaps, fail closed.
- [x] E5 harness: 600-evaluation plan; per-model and per-case metrics with failed cases, variability, canary
      changes and leaks; agreement kept out of the gate; the gate never qualifies on mocks. E8 estimates are labeled.
- [x] The packed tarball ships every new schema and type; a clean npm consumer compiles them.

## Integration blockers (each names its owner and the seam it waits on)

1. **Coordinator model operation (A, PR 08).** The coordinator starts owned workers (child or container) and
   records attempts with `usage: not-applicable`. Model review needs an in-process broker operation kind whose
   attempt carries `usage: confirmed | unknown` from the ledger. Its result publication must be fenced like any
   other, and a provider wait must not hold a worker slot. *Waiting on:* the canonical coordinator's operation and
   attempt seam (A's `claude/sentinel-execution-integration`) to be final.
2. **Epoch fencing and ledger recovery (A, PR 08).** `BudgetLedger.recover(staleEpochs)` must run under the
   coordinator's exclusive ownership with exactly the fenced epochs. The ledger lives beside, or inside, the store
   it fences. *Waiting on:* the coordinator's recovery hook and epoch list.
3. **Run budget envelopes (A/C, PR 08–09).** The run admission opens one envelope per run and provider from
   `RunBudgets`. Exceeding it needs a new owner receipt. *Waiting on:* run admission in the canonical CLI and service
   (C's `codex/sentinel-cli-canonical`).
4. **Owner commands (C, PR 09).** Three commands are needed: `models probe <provider> <model>`, which writes the
   capability for re-adoption; reconciliation of an uncertain reservation with a spent receipt; and envelope
   inspection. *Waiting on:* the canonical owner CLI surface.
5. **Planner and coverage (PR 06 owner).** Guided review is planned from planned checks, general review from
   `sentinel-review-partitions`. Required coverage must keep `deterministicCoverage: false` records out. *Waiting on:*
   a planner stage kind for agentic work (`STAGE_KINDS` has `agentic`; no planner rule emits it).
6. **Withheld contract (D, PR 11).** Replace `WithheldLocationView` with the imported `WithheldLocationEvidence`
   once `2b33c911` and its bound fix integrate. Feed the scan's withheld citations into review scope.
7. **Path evidence (B, PR 18).** Feed `sentinel-paths/draft-1` envelopes through `pathFactsFrom` in the planned
   review stage.
8. **Report (B, PR 19).** Render review records and model observations apart from scanner findings, with all model
   text escaped, and show inspection gaps and frontiers.
9. **Decisions (PR 20).** Model observations enter dispositions only as proposals (`DecisionChannel: 'model'`).
10. **Security note.** Add the in-process keychain reads for Sentinel providers to `docs/SECURITY.md` (shared doc;
    root edit).

## Owner gates (not implementation)

- [ ] Configure two provider-backed models; the second model's configuration is pending.
- [ ] Independent review of the 30 E5 labels (`test/fixtures/model-review/e5-corpus.json`, author drafts today).
- [ ] Thresholds: precision and recall Wilson lower bounds, maximum canary-induced changes and unfinished runs.
- [ ] The live E5 run: 2 × 30 × 5 × clean/canary = 600 evaluations, reported per model and case.
- [ ] The opt-in PR 21 demo: one synthetic, no-private-source call to a locally installed model.
- [ ] Any hosted use: the owner's receipt, recorded terms and a trusted rate schedule.

## Release (deterministic release stays independent of all of this)

- [ ] The model release (PRs 21, 22, 23b, 25b) ships only after blockers 1–9 close, the owner gates pass and
      E8 observed usage is recorded beside `estimatePlan` bounds.
- [ ] Draft-1 contracts are renamed `/v1` only after independent contract review.
