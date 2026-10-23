# Sentinel status and session handoff

**Snapshot: 2026-10-23 05:01 PM EDT.** This session is ending at the owner's request. No further implementation, merge or release work is being started. The local preview remains running.

## Current position

The Copilot CLI release candidate is merged, but the new release has **not** been published. The latest published Farsight version remains [v0.3.0](https://github.com/zalos/farsight/releases/tag/v0.3.0). The intended next versions are **Farsight 0.4.0** and the independently versioned **Sentinel 0.1.0-beta.1**; these are release targets, not available releases.

- [PR #183](https://github.com/zalos/farsight/pull/183) merged the owner preparation/interface, process graph, reporting and npm delivery integration.
- [PR #190](https://github.com/zalos/farsight/pull/190), `feat(cli): enable Copilot scans with retained review evidence`, merged on October 23 as **`7bb4ba230308275876603b147581c4aa54b839a1`**.
- All final checks on #190's exact head `e417610f` passed, including native isolation/recovery, service and browser checks, clean npm consumers, and the five-scanner installed-command workflow. Independent Claude source review cleared the final CLI changes.
- A focused owner-UI correction is committed separately and locally tested. It is **not independently reviewed, integrated, in a PR, or merged**.
- The release workflow, release PR, publication and verification of the published package URLs have **not** been completed.

This is a scoped first CLI/UX release effort. It does **not** complete the original Sentinel plan.

## What is implemented and what the evidence establishes

| Area | Current capability and limit |
|---|---|
| Durable scan foundations | Capture, parsing, inventory, planning, retained inputs/outputs, execution records, interruption/recovery and owner controls are implemented. Retained evidence and incomplete coverage remain distinguishable from a successful security verdict. |
| External scanners | Pinned pattern, dependency, infrastructure, workflow and secret scanners have installed-command acceptance, including Linux amd64 CI. Selected external scanners run in Linux containers; there is no automatic host fallback or download during a scan. |
| Host Copilot review | An actual npm-installed public CLI scan passed with Copilot **1.0.103**, macOS arm64 and explicit **`gpt-6-luna`**. Three confirmed model calls listed source, read captured code, and produced a cited review observation. No local model or container connection was used in this agentic-only qualification. |
| Prompt/model evidence | The successful CLI scan retained its exact prompt/messages, selected and reported model identity, and instruction records. The tested additional-skills selection was empty. This does not qualify arbitrary skill sets or a finished prompt/skill editor. |
| Model result delivery | The cited model observation is available in the **private instruction report**. Ordinary full reports do not yet project these model observations; they correctly remain partial with no deterministic scanner findings in this test. See #194. |
| Replay and retention | The qualified CLI result could be read after source removal. Replaying that terminal run made no new model dispatch. Broader portable bundles, pruning and incremental/differential equivalence remain open. |
| Browser process graph | The current UI shows recorded stages, dependencies, retained evidence and supported separately confirmed owner actions. It is not the complete requested configurable workflow editor. |
| Configuration and browser models | Adopted owner CLI settings provide the implemented configuration path. The current browser panel does not edit/adopt settings or run the native Copilot adapter; model-bearing execution still requires the foreground owner CLI. |
| npm installation | Farsight and Sentinel are independently packaged. Clean consumers using Node/npm without pnpm passed. Release instructions cover npm installation; installation from the actual next published URLs remains a release gate. |
| Frameworks and application proof | Express, Next, Nest and Spring inspection foundations exist. This is not completion of the requested original Java/Spring sample and managed runtime end-to-end qualification. |

The final successful Copilot proof used three calls totaling **10,442 input and 326 output tokens**. Earlier failed/unfinished trials were preserved; they were not relabeled as passes. The successful qualification applies to this pinned CLI/model/platform combination, not every Copilot version or development machine.

## The local preview and the reported UI problem

The preview is available at **http://127.0.0.1:4520/#/sentinel** and uses a copied invoice sample. It has only the foundation preview configuration, with no paid model provider enabled and no acquired external scanner assets. It is useful for exploring preparation, retained work and the graph, not demonstrating complete scanner coverage or browser Copilot execution.

At inspection, the saved run had **three successful preparation attempts**: capture, parse and inventory. Its current analysis revision had **zero attempts**. The run's original deadline was **October 23 at 4:52:25 p.m. Eastern**, which has now passed. No analysis start was dispatched by the manager while diagnosing the panel.

The screenshot showed a raw `sentinel.ownerUi.expired` response. The current paired browser tab subsequently worked through both Reconnect and navigation away and back. The exact screenshot failure was not reproduced in that paired tab. A genuine duplicate/consumed bootstrap request did reproduce the raw JSON document in a targeted test, and is addressed by the saved UI correction.

Two presentation defects were confirmed:

1. An unavailable or consumed browser pairing could display JSON instead of readable recovery guidance.
2. The interface displayed preparation and raw recorded run state without sufficient distinction, while the start controls appeared below the large process graph. A recorded `running` state did not prove analysis checks had started.

The saved correction adds a catalog-backed recovery page, puts status and start controls before the graph, distinguishes preparation from analysis execution, and makes failed refreshes visible while disabling writes until a successful read. It preserves one-use pairing, the absolute session lifetime, separate confirmation, deadlines and all model admission gates. It neither renews authority automatically nor replays an action.

**Local UI correction:** branch `codex/sol-owner-ui-reconnect`, commit **`673324df679e62bfbf65cfff016fd29498b04bf1`**, based on the pre-squash #190 head. The worker reports Sentinel build/typecheck and catalog checks, **22 focused/package tests and one genuine browser flow passing with zero skips**. Independent review and final integration validation remain pending. The running user preview still serves the earlier build; it has not been updated with this correction.

## Decisions and their basis

| Decision | Who made or approved it; consequence |
|---|---|
| Prioritize a bounded release now and iterate later | Owner direction. The current push focuses on CLI qualification, usable graph/owner controls, npm installation and a release, rather than claiming the whole original plan is complete. |
| Use SOL workers and Claude reviewers | Latest owner direction. The manager integrates, reviews evidence and enforces completion criteria. The new UI correction still needs its independent review. |
| Allow host CLI execution for pure agentic phases | Owner explicitly refined the earlier container-only decision. No Docker or local inference is required for the qualified host Copilot path when the adopted profile permits it and no external scanner is selected. Required scanners are not silently skipped. |
| Keep external scanners container-only | Owner-confirmed. Their dependencies and execution remain managed inside qualified Linux containers; no host fallback. |
| Prioritize Copilot; return to Claude later | Owner direction. Native Claude remains disabled/unqualified for this release. This is separate from using Claude as a development reviewer. |
| Pause hosted APIs behind a default-off flag | Owner direction. Retain the implementation and revisit live hosted-API qualification later. No successful hosted-API acceptance is claimed. |
| Ship a working graph before custom stage creation | Explicit owner choice. Custom stages, typed input/output editing and richer workflow configuration remain follow-ups. |
| Apply the reviewed Copilot sign-in fix | Explicit owner approval. The pinned native process can use the reviewed macOS Keychain/certificate services. The access is not restricted to one Keychain item, and OS trust-service requests can occur outside Sentinel's proxy. Those limits are documented. |
| Permit three bounded Copilot turns | Implementation/review decision after a two-turn trial exhausted its budget before the model received the requested source. The new default remains within the existing 120-second deadline and does not expand already-adopted budgets. |
| Treat model-to-ordinary-report projection and historical memory-attribution gaps as follow-ups | Manager's scoped beta disposition, not proof these gaps are fixed. Private model evidence remains readable; unidentified worker exits still fail rather than becoming successful work. Issues #194 and #184 retain the limitations. |
| Hold publication for the observed UI clarity problem | Manager's release-quality decision. The fix is saved, but its review/integration gates remain open as this session ends. |

## Immediate work needed to finish this release

1. Independently review UI commit `673324df` with SOL and Claude, address findings, and integrate it onto current main. The prepared integration branch is `codex/sentinel-owner-ui-feedback`, based on `7bb4ba23`.
2. Complete candidate/main ingest comparison and real-browser verification. A fixed-source main baseline is already saved: **11,399 nodes, 24,466 edges, source digest `2c154ed1702d`, graph 32,908,911 bytes, database 45,359,104 bytes**. Candidate comparison has not run.
3. Create a focused UI PR, use the repository's title/template conventions, pass affected CI and squash-merge. No UI PR has been opened yet.
4. Update the running local preview from the reviewed build and verify readable expiry, clear preparation/execution state, separate start confirmation, retained reports and reconnect. Preserve saved run evidence; do not silently extend the expired run's budget.
5. Update the handoff/progress ledger to reflect #190's completed merge and the eventual UI result. Older milestone text in those documents remains historical.
6. Dispatch the release workflow for Farsight **0.4.0** and Sentinel **0.1.0-beta.1**. Review and merge the generated release PR only after its required checks and release recovery gates pass.
7. Let publication build the release artifacts, then verify both published tarballs against the manifest and complete clean npm-only installation from the actual published URLs.
8. Report the release links, validated scope and remaining limitations. Do not declare the original full plan complete.

The existing Copilot live proof should not be repeated merely because presentation files changed. Re-run inference only if integration changes the qualified execution path or exposes an unresolved concern.

## Outstanding issue ledger and recommended follow-up order

The following issues were open when this report was prepared. Their existence does not imply the full capability is already delivered.

| Priority after the scoped release | Work and tracking |
|---|---|
| Make review results useful in the main report | [#194 — Model observations in ordinary reports](https://github.com/zalos/farsight/issues/194). |
| Finish the requested interactive workflow | [#182 — Granular reruns, editable settings and entry details](https://github.com/zalos/farsight/issues/182); [#187 — Prompt and skill selection per stage](https://github.com/zalos/farsight/issues/187); [#181 — Typed custom stages](https://github.com/zalos/farsight/issues/181). |
| Readable end-to-end source and final design review | [#173 — Entry-point Markdown walkthroughs](https://github.com/zalos/farsight/issues/173); [#177 — UX polish, configuration editing and final Fable review](https://github.com/zalos/farsight/issues/177). The requested final Fable pass is not complete. |
| Prove the original sample and broader provider setups | [#176 — Java/Spring sample and managed runtime evidence](https://github.com/zalos/farsight/issues/176); [#174 — Hosted API/CLI provider qualification](https://github.com/zalos/farsight/issues/174); [#178 — Broad model evaluation](https://github.com/zalos/farsight/issues/178). Resume hosted API work only under the owner's later direction. |
| Retention, budgets and release robustness | [#175 — Replay, pruning and differential scan gates](https://github.com/zalos/farsight/issues/175); [#179 — Budget migration/subscription diagnostics](https://github.com/zalos/farsight/issues/179); [#180 — Recovery/published artifact qualification](https://github.com/zalos/farsight/issues/180). |
| Targeted qualification and diagnostic debt | [#184 — Memory-stop attribution](https://github.com/zalos/farsight/issues/184); [#188 — Cancellation across build changes](https://github.com/zalos/farsight/issues/188); [#189 — Finished-run provider controls](https://github.com/zalos/farsight/issues/189); [#191 — Copilot registry/invocation identity](https://github.com/zalos/farsight/issues/191); [#192 — Agentic-only policy/reporting evidence](https://github.com/zalos/farsight/issues/192); [#193 — Portable Copilot sandbox policy CI](https://github.com/zalos/farsight/issues/193). |
| Existing viewer test intermittency | [#185 — Journey header](https://github.com/zalos/farsight/issues/185); [#186 — Map panel after fast travel](https://github.com/zalos/farsight/issues/186). |

Two other PRs are open: [#121 — delegated App Router guards](https://github.com/zalos/farsight/pull/121) and [#195 — Zod 4 dependency update](https://github.com/zalos/farsight/pull/195). Neither was merged or qualified by the current work. Treat the major dependency update as separate review work, not a release prerequisite by default.

## Definition of done and restart point

The scoped release is done only when the user-visible UI correction is reviewed and merged, the qualified CLI behavior remains intact, release checks pass, the versions are published, and fresh npm consumers validate the published bytes. A passing build, saved patch, merged feature PR or source-only review is insufficient on its own.

Resume from the saved UI correction and the ordered steps above. Keep the original failures, fixed-source baseline and private validation packets for comparison. Do not restart the whole implementation plan or spend on new live model trials without a specific need. Keep product changes in worktrees and preserve the primary dogfood checkout.

Reference documents: [implementation plan](docs/proposals/farsight-sentinel/implementation-plan.md), [execution ledger](docs/proposals/farsight-sentinel/execution-progress.md), [AI handoff](docs/AI-HANDOFF.md), and [release procedure](docs/RELEASING.md).
