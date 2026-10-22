# Model providers and review: integration checklist

**Status (2026-10-22).** PR 21 (`review/providers`, ADR 35) and PR 22 (`review`, ADR 39) exist as standalone,
mock-tested libraries. Provider revision `f7c8fc9a` is independently approved; PR 22 builds on it. Neither is wired
into the coordinator, the settings contract, the CLI or the report. This list is what integration must still do
before either may be called delivered. An item is closed only by a merged change with its test, not by this file.

## PR 21 — providers

- [ ] **Settings binding.** Add the model profile (model, limits, pricing or local no-fee, hosted terms) and the
      capability record to the adopted settings contract, or to an owner-trusted file the policy module adopts, with
      a `.example` twin. Today `bindProvider` takes the profile from its caller, and only the owner receipt over the
      binding digest binds it.
- [ ] **Capability records.** A trusted probe command (owner CLI) that runs `probeCapability` and stores the record.
      Re-probe when the origin or the model changes, never silently.
- [ ] **Schemas.** Register `sentinel-model-capability/draft-1` and the budget-ledger record shapes as generated
      contract schemas, with valid and invalid cases.
- [ ] **Run budget.** The coordinator opens one envelope per run and provider from the run's `RunBudgets`, behind
      the run's own admission. It never exceeds the run budget, and exceeding the run envelope needs a new owner
      receipt.
- [ ] **Epochs and recovery.** The ledger moves into, or is fenced by, the coordinator's durable store. On restart,
      `recover(staleEpochs)` runs under exclusive ownership for exactly the fenced epochs. Uncertain reservations
      stay charged until an owner reconciliation command spends a receipt (`reconcile`).
- [ ] **Policy recheck.** Each call re-binds under the policy in force; a changed policy stops the envelope.
      Integration must pass the current binding, never a cached one.
- [ ] **Example credential.** Settings example and docs use `keychain:farsight/sentinel-review`; today the example
      says `sentinel-example`. Add a short `docs/SECURITY.md` note on in-process keychain reads for Sentinel providers.
- [ ] **Live opt-in check.** One synthetic, no-private-source call against a locally installed model, run only on
      explicit owner request (the PR 21 demo). No hosted call without the owner's receipt and recorded terms.

## PR 22 — review

- [ ] **Coordinator stage.** Plan guided review from planned checks and general review from `partitionInventory`
      as work units. Admit each through policy, run it through `providerCaller`, and fence results by attempt and
      epoch. Replace `FileCheckpointStore` with the coordinator's durable store behind `CheckpointStore`.
- [ ] **Schemas.** Register `sentinel-review-partitions/draft-1`, `sentinel-review-record/draft-1` and
      `sentinel-review-checkpoint/draft-1` as contract schemas. Observations already validate as
      `sentinel-observation/draft-1`.
- [ ] **Coverage separation.** Review records never produce `sentinel-coverage/draft-1` for formal checks. The
      planner and coverage evaluation must keep `deterministicCoverage: false` records out of required coverage.
- [ ] **Seams.** Feed PR 18 `sentinel-paths/draft-1` envelopes through `pathFactsFrom`, and secret-location refs
      through `DisclosureFilter`. Disclosure policy for hosted providers also limits which source classes a
      partition may serve.
- [ ] **Report.** PR 19 renders review records (inspected, not inspected, frontiers) and model observations
      apart from scanner findings, escaping all model text.
- [ ] **Decisions.** Model observations enter dispositions as proposals (`DecisionChannel: 'model'`); only an
      owner action approves.

## E5 / E8 gates (owner)

- [ ] Configure two provider-backed models (the second model's configuration is pending).
- [ ] Independent review of the 30 corpus labels (`test/fixtures/model-review/e5-corpus.json`, today author drafts).
- [ ] Owner thresholds: minimum precision and recall (Wilson lower bounds), maximum canary-induced changes and
      unfinished runs.
- [ ] The live run: two models × 30 cases × 5 trials × clean/canary = 600 evaluations. Report per model and
      case, with failed cases, variability and canary changes. The agreement matrix is not accuracy.
- [ ] E8: record observed tokens and spend from the ledger beside `estimatePlan` bounds, and choose
      model-specific resource defaults from the observations.
