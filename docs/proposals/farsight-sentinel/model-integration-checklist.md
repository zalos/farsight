# Model providers and review: definition of done through release

**Status (2026-10-22).** PR 21 (`review/providers`, ADR 35) and PR 22 (`review`, ADR 39) are complete over trusted
settings, registered contracts, an agentic stage, a fenced in-process operation and owner helpers, and tested with
local mock endpoints, a real SIGKILL and an opt-in local probe. They are **not delivered**: the coordinator and the CLI
do not dispatch them yet, and no live model has been evaluated.
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

## Done since (with tests)

- [x] Agentic review stage: `planReviewWork` units (`stage.kind: 'agentic'`, no checks); `assertAgenticOnly`
      refuses coverage attributed to them.
- [x] Trusted in-process operation `createModelReviewOperation`: records, ledger usage and no coverage; refuses
      non-review work or another implementation digest.
- [x] Model ledger: epoch fencing on recovery, one live checkpoint writer per session (`LedgerCheckpointStore`),
      each operation sent at most once across envelopes; sessions per work unit, so a new attempt resumes.
- [x] Real SIGKILL mid-call, then recovery under a new epoch: the call stays uncertain and charged and is never
      re-sent; the fenced epoch can no longer write. Proved in the repository and from the installed tarball.
- [x] Owner helpers in C's conventions (typed errors, bounded facts). Probe is an owner action; reconciliation always
      takes a spent owner receipt; inspection is a bounded read.
- [x] The integrated `WithheldLocationEvidence` type; `docs/SECURITY.md` covers provider keychain reads and bounded
      disclosure.
- [x] Opt-in real local Ollama probe (listing only, `FARSIGHT_LIVE_OLLAMA=1`), passed on 2026-10-22 against an
      installed model. No generation, no download.

## Integration blockers (each names its owner and the seam it waits on)

1. **Coordinator dispatch (A, PR 08).** The coordinator must route `isReviewWork` units to
   `createModelReviewOperation(...).run`, publish its records through its fence, and never pass them to coverage.
   *Seam proposed to A; awaiting A's dispatch point.*
2. **Attempt worker kind (A or root, shared contract).** `AttemptWorker` has no in-process kind. Proposed:
   `{ kind: 'in-process', adapterId, fencingGeneration }`. Attempt usage comes from `ModelOperationOutcome.usage`.
3. **Recovery hook (A).** Call `recoverModelWork(ledger, staleEpochs)` after fencing, with the same epochs.
4. **Run budget envelopes (A/C).** The run admission opens the envelope from `RunBudgets` before review units start.
5. **CLI dispatch (C, PR 09).** `models probe | reconcile | envelopes` over the owner helpers; C has the conventions
   and will wire them with a stub provider.
6. **Planner wiring (PR 06 owner).** Call `planReviewWork` from the run plan; deterministic required coverage is
   unchanged by construction.
7. **Path evidence (B, PR 18).** Feed `sentinel-paths/draft-1` through `pathFactsFrom` in the review stage.
8. **Report (B, PR 19)** and **decisions (H, PR 20).** Consume `sentinel-review-record/draft-1` and model-review
   `sentinel-observation/draft-1`; proposals only.
9. **Store GC (A).** The model ledger is a separate file beside the store; when prune becomes real it must keep
   it, or the ledger moves into the store.

## Owner gates (not implementation)

- [ ] Configure two provider-backed models; the second model's configuration is pending.
- [ ] Independent review of the 30 E5 labels (`test/fixtures/model-review/e5-corpus.json`, author drafts today).
- [ ] Thresholds: precision and recall Wilson lower bounds, maximum canary-induced changes and unfinished runs.
- [ ] The live E5 run: 2 × 30 × 5 × clean/canary = 600 evaluations, reported per model and case.
- [ ] The opt-in PR 21 demo: one synthetic, no-private-source *generation* by a locally installed model (the probe is done).
- [ ] Any hosted use: the owner's receipt, recorded terms and a trusted rate schedule.

## Release (deterministic release stays independent of all of this)

- [ ] The model release (PRs 21, 22, 23b, 25b) ships only after blockers 1–9 close, the owner gates pass and
      E8 observed usage is recorded beside `estimatePlan` bounds.
- [ ] Draft-1 contracts are renamed `/v1` only after independent contract review.
