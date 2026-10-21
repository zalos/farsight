# Farsight Sentinel implementation kickoff

Prepared 2026-10-19 and refreshed 2026-10-21 for the agent that will execute the plan. Review agents have
checked readiness; implementation has not started. Preparing this prompt does not approve unmeasured support
choices or authorize a merge. Give the prompt below to the implementation agent
when ready; it begins by checking the actual review and dependency state.

## Prompt

Act as the implementation lead for Farsight Sentinel. Work through the implementation backlog as small,
reviewable PRs, completing each eligible work package through implementation, validation and an open PR.
Use the existing plan as the working contract. Keep progressing within the authorized scope; resolve routine
engineering choices yourself and ask only for a missing decision that materially affects the next action.
Do not replace this task with another general plan or combine the backlog into one large change.

### Establish the current state

Read `AGENTS.md`, `docs/AI-HANDOFF.md` and the project's applicable memory/skills before editing. Inspect
the branch, working tree, active worktrees and live PR state; preserve other people's edits.

Proposal [PR #117](https://github.com/zalos/farsight/pull/117) merged at `04c3c63`. Planning PR 00,
[PR #118](https://github.com/zalos/farsight/pull/118), merged on 2026-10-19 at `0c8c747`.
The execution-preparation baseline is main `46018cb`, verified on 2026-10-21, with no Sentinel implementation
started. Recheck the current main and owner instructions; these are historical checkpoints, not pins to ignore
later updates. Read the [execution readiness packet](execution-readiness.md) for the prepared lanes and gates.

Read these documents in order:

1. [Proposal](../farsight-sentinel.md).
2. [Implementation architecture](implementation-plan.md).
3. [PR backlog](implementation-prs.md), including dependencies, waves and execution-readiness table.
4. [Implementation examples](implementation-examples.md).
5. [Claude implementation review](claude-review-implementation.md) and [review response](implementation-review-response.md).
6. [Draft contracts](contracts.md) and the earlier [review response](codex-response.md); consult linked research
   and package/security/CI maps as the selected work package requires.

PR 00 is accepted and merged; do not reopen that agreement. Before dependent implementation, recheck actual
successor prerequisites and the explicitly named outstanding decisions. An open successor PR, passing checks
or this saved prompt is not evidence that its acceptance gate cleared. Direct owner instructions may authorize
implementation or a stacked PR; honor them without asking again. If a specific gate remains unresolved,
identify it and continue independent authorized work without treating unmeasured defaults as accepted.

### Preserve the confirmed decisions

- Local first, preserving the option for a hosted service later; optional package/service boundary.
- TS/JS and Java/Spring Boot in scope. Source-only first: do not execute the analyzed project's Maven,
  Gradle, npm scripts or plugins. Isolated builds and managed runtime scanning are later tracks.
- Optional local Ollama plus a configurable hosted endpoint. Deterministic scans must work without models.
- A report is an independently deliverable assessment as well as a Farsight view. Self-contained HTML and
  readable Markdown/JSON carry captured labels, explanations, findings, coverage gaps, decisions and permitted
  evidence. Recipients need no Farsight/Sentinel installation, source checkout or service. Farsight adds Map,
  gate and code navigation plus authorized actions to the same pinned report document.
- Use one canonical application graph. Security execution/evidence stays in Sentinel artifacts and its ledger;
  do not add bulk security state to `/graph`. Known screens, journeys and personas use verified pinned context
  and both language registers; unknown placement remains explicit.
- Deliver deterministic interfaces through 23a/24/25/26 without waiting for 21/22/23b/25b model gates.
  Standalone reporting lands at 19, with integrated parity at 25 and clean-recipient delivery checks at 26.

The owner **confirmed on 2026-10-21 that external scanners require Linux containers with no host fallback**.
Do not ask that policy question again. Exact runtime/engine/framework versions, rule inventory, E3/E5 thresholds and resource defaults are
PR 01 decisions based on measurements, not facts to invent. E5/model trials and thresholds may be explicitly
deferred to the model track; they do not block deterministic foundation work or release. Keep these separate
from the confirmed choices.

### First bounded deliverable

After the PR 00 gate clears, start with **PR 01: feasibility harness and capability decisions**. If it is already
complete, inspect its evidence and select the next eligible unfinished package instead of repeating it.

Own `scripts/sentinel-feasibility.mjs`, the relevant `scripts/test/` tests, synthetic assets under
`packages/sentinel/test/fixtures/`, the capability/corpus decision manifest and its results record. There is
no production Sentinel runtime or package scaffolding in this PR; that begins at PR 02.

1. Define versioned experiment inputs/results: candidate/version, rights, fixture and expected facts, host/runtime,
   command/limits, artifact hashes, measured outcome, limitations and accepted/rejected/deferred decision.
2. Add positive/negative TS/Java, hidden-configuration and middleware-order fixtures. Use inert secret values
   with narrowly justified line exceptions; store vulnerable manifests/locks under fixture-only names and
   materialize real names only in temporary trees. Never install intentionally vulnerable fixture dependencies.
   Include ignored tracked/generated source and nested/unreadable ignore rules; pin parser selection options
   and fingerprints. `analysis.complete` is not independent inventory completeness, and application-enriched
   policy/guard/test facts are not automatically present in public parser artifacts or proof of enforcement.
3. Build the E1–E8 harness and metrics schemas. Run the eligible local parser/inventory, SQLite ownership,
   codec and resource probes against actual APIs. Define future E4/E6 cases without claiming the full coordinator
   recovery or differential-equivalence gates have run before those implementations exist.
4. Record candidate acquisition sources and hashes. External acquisition/tool installation, container-backed
   scanner trials, paid/provider calls and source disclosure must satisfy their stated policy/rights/budget
   prerequisites. Missing permission or runtime produces a recorded pending/unsupported result, never a pass
   or a host fallback. Continue independent fixture/harness work while a decision is pending.
5. Produce a decision record with exact measured support, failures and remaining choices. PR 01 is complete
   only when its acceptance evidence and owner decisions meet the backlog; a harness alone is not completion.
   Use separate evidence-preparation and measured-decision milestones. Do not dispatch PR 02 from the first.

### Working rules and validation

Work in a separate worktree from the correct accepted base. Keep the primary checkout on main with its
existing edits and dogfood build untouched. Use repository branch conventions, Conventional Commits and the
assistant co-author trailer. Lint the exact PR title; use the PR template. `sentinel` scope is registered in
PR 02, so PR 01 uses the unscoped title from the backlog. Never use `git stash` or kill processes by a broad
command pattern; stop only your recorded PIDs/containers or assigned ports.

Use Node 24+ and pnpm 9.0.0; build before tests that import `dist/`. Select checks from `docs/CI.md`.
The new feasibility script currently selects all existing CI checks as an unknown path; this preparation is
Markdown-only, but PR 01 will not be. PR 02 must also preserve Farsight packaging with Sentinel absent/unbuilt
when adjusting the current all-workspace compiled-entry preflight.
Parser/core/store changes require the prescribed main-versus-feature real-ingest measurements and viewer
page-error checks. Keep temporary ingests, ownership state, test results and ports isolated. Document new
public boundaries with their ADR/package-map entries; preserve frozen contracts and count/catalog conventions.

Carry the reviewed constraints into their owning PRs: `(work id, revision)` keys and references; explicit
parser-manifest reconciliation; shared grant-policy semantics with three distinct verdicts; trusted settings
and their scrubbed example; early CI selection; opt-in expensive tests that cannot silently skip in a selected
job; short private socket paths; standalone report disclosure and offline behavior. Do not reimplement these
from a vague recollection of the original proposal.

Use the wave table only after predecessor contracts are agreed and merged. Parallel agent work needs actual
authorization and explicit file ownership; the lead owns shared core/catalog/CI contracts. Do not overwrite
another agent's work or message other chats without permission. Splitting an oversized PR is allowed when
the acceptance gate and traceability remain intact.

### Finish each work package and continue deliberately

Implement and validate the current bounded package, fix relevant failures, inspect the final diff, commit,
push and open its PR for review. Attach the PR to the task when the tool is available. Do not merge, publish
packages, change global installations, refresh dogfood services or run later build/runtime tracks without
the corresponding owner authorization. This prompt does not grant blanket paid-call or disclosure permission.

Update the backlog and `docs/AI-HANDOFF.md` with the actual PR/commit, behavior, checks and outcomes, skipped
checks with reasons, measured limitations, pending decisions and next eligible work. Distinguish documentation
checks, syntax examples, mocks, real probes and production acceptance evidence. Do not mark a planned gate done
because a stub exists or call a scan complete because a process exited zero.

Continue independent authorized work while awaiting review. Start a dependent successor only when its review,
merge and decision gates are satisfied. Finish each handoff with the PR link, a concise demonstration, evidence,
remaining risks/decisions and the concrete next package; avoid asking again about choices already settled.
