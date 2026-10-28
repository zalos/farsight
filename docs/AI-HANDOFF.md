# Farsight — current state (shared Codex / Claude handoff)

Imported by `CLAUDE.md` and read by Codex at session start, so it holds **only the work in flight**: where `main`
is, what is open, what is next and what bites this week. Keep it under about 80 lines. When work lands, replace its
entry with one line (or drop it) and move the dated detail — checks run, measurements, review findings — to the
matching file in [history/](history/README.md). Durable rules go in `AGENTS.md`; runtime, provider access and live
tracker setup are in [AI-SETUP.md](AI-SETUP.md).

## Where things stand — 2026-10-28

- **`main` is `1d910ac6`.** Published Farsight is **0.3.0**; Sentinel is `0.0.0-draft.1` and unreleased. The
  targets 0.4.0 and Sentinel 0.1.0-beta.1 still need the release workflow ([RELEASING.md](RELEASING.md)).
- **Deployed build `459190b9`:** the global `farsight` and `farsight-sentinel` under all three Node prefixes and the
  dogfood server on 4478 (sync 77). `main` has #253 (docs) and #247 since — pack, reinstall, restart and re-sync at
  the next deploy. 4477 serves the reference app read-only; its session owns that app's re-stamp and restart.
- **Sentinel v2's thin slice is merged** (#227 → #253): SCANS · PIPELINE · STAGE in the viewer, one `scan` command
  over the `SentinelService` facade, the stage editor, store/snapshot/rules/policy on the kernel, the walk-free
  no-Docker `review` profile (#249), [DEMO.md](DEMO.md), npm build and pack beside pnpm (#251), native review
  observations and provenance in the report (#248), and retained native failures with the subscription cost basis
  (#247; #252 closed in its favour). Plan and lanes: [sentinel-v2/tasks.md](proposals/sentinel-v2/tasks.md).
- **The demo** is the CLI and the no-Docker review path on another Mac, following DEMO.md §4b (verified from a fresh
  clone in #250: `scan` exits 4, `scan --confirm` exits 2 in about 35 s). Observed live reviews end unfinished at the
  3-turn cap with zero observations, and the report says so. The Docker agentic route (V-3) is paused by the owner.
- **Phase 0 is complete:** every eligible JS/TS area is formatted and linted; seven suppressions remain in five
  sha256-pinned feasibility files, deliberately unchanged.

## Open work, in order

1. **ADR and package-map entry for `sentinel-attempt-retained/draft-1`**, the public draft contract #247 added in
   `packages/sentinel/src/contracts/review.ts`. #247 merged without them; AGENTS.md asks for both with the contract.
2. **PA's second PR** — local and unopened: `feat/sentinel-p4b-rerun` in `../farsight-wt/pipeline-a2`. It carries
   `run.rerun`, the option-A flip, explicit `init` grant effects (re-records three golden digests), the local
   `ollama` runner and `adoptPipeline` refusing non-CLI receipts.
3. **Still open in the v2 plan:** `capabilities --models` for Copilot CLI 1.0.105 and Claude native; the declared
   host-script stage through `scan` with `<output>.schema.json` in its pack; P-3b reuse of retained checks on rerun;
   a durable pre-attempt refusal reason from a closed structured set at the store boundary.
4. **Owner calls:** #121 (App Router delegates) must be reapplied onto the formatted `main` with `prettier --write`
   on its files, not merged as is; dependabot #236/#195 (zod 3 → 4).
5. **Farsight beyond Sentinel:** after the reference app's evidence is re-stamped, re-run the outsider demo (bar:
   confidence ≥ 8, no wrong answer on who approves or what makes an invoice Paid). The open viewer list is at the end
   of [history/viewer-passes.md](history/viewer-passes.md).

## Traps this week

- **Check `gh pr view <n> --json baseRefName` is `main` before every merge.** #239 squashed into #237's branch by
  mistake and had to be reverted there and re-landed as #245.
- **Known intermittent tests** — the preparation-clock race (load-dependent, fixed at the boundary in #243), the
  e2e Map pinch zoom (`map-zoom.pw.spec.ts:149`), the owner-UI `/confirm` gate timeout, the `sentinel-isolation` OOM
  witness (#184) and the `preparation-publication-crash` readiness retry limit. `preparation-admission` and
  `preparation-publication-crash` may stay in `serial-suite.txt`. Full list: [history/sentinel-v2.md](history/sentinel-v2.md).
- **Sentinel's npm source tests still hit #200** (the ESLint/uri-js closure refusal); #203 (test-file detection
  misses an import sharing a line with other code) is open beside it.

## Before you switch providers

Rewrite the entries above rather than appending: branch, what changed, the checks you ran and their results, what
is unresolved. A dated record of the work goes to the top of its `history/` file.
