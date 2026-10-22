# Farsight Sentinel execution progress

The durable status ledger for the [PR backlog](implementation-prs.md). The backlog stays the contract for each
package's scope, files and full acceptance gate; this page records only where each package stands and what
evidence moved it. A row moves to **done** only when its PR has merged and the evidence named in its gate exists.
An open PR, green CI, a stub or a process that exited zero is not that evidence. Numbers are local planning
identifiers, not GitHub PR numbers.

## Checkpoint — 2026-10-22

- PR 03 merged as [#135](https://github.com/zalos/farsight/pull/135), `97ff419`, after independent SOL
  review, clean npm consumers, measured macOS/Linux storage recovery, and all nine final CI checks.
  PR 04 capture and PR 07 isolation subsequently merged as [#140](https://github.com/zalos/farsight/pull/140)
  and [#139](https://github.com/zalos/farsight/pull/139), with all final CI checks and independent review. PR 06's pure shared-grant
  prerequisite merged as [#137](https://github.com/zalos/farsight/pull/137), `2df3dc2`, after SOL review, identical
  real-ingest output and all seven CI checks. Parser integration and the rules/policy foundation have started
  against the reviewed draft interfaces; they will integrate in dependency order. None of those full gates is complete.
- PR 02 merged as [#134](https://github.com/zalos/farsight/pull/134), `269c3bc`, after contract/packaging
  review and all nine CI checks.
- PR 01's measured-decisions slice merged as [#133](https://github.com/zalos/farsight/pull/133), `ef5c525`,
  after the first slice [#132](https://github.com/zalos/farsight/pull/132), `2bd38f6`.
- The owner continued execution and **accepted PR 01's bounded matrix and proposed resource defaults for
  implementation** ([decision manifest](feasibility-decisions.json), `ownerAcceptance`). That acceptance covers
  only what was measured: Semgrep 1.181.0 as the pattern default for the original rules, local taint for the six
  direct/local cases, the reviewed synthetic framework scenarios, and the macOS ARM64 / Docker Desktop host. It
  does not turn prototype results into general engine accuracy, cross-file or deep analysis, production
  framework packs, other framework versions, other hosts/backends/architectures, or capacity guarantees.
- Gates still listed as pending (advisory database, crash recovery, models, incremental equivalence, framework
  packs, scan configuration and visuals, provider selection) remain **implementation and release acceptance
  gates**. They are not new permission gates for implementation work the owner has already authorized.
- Container-only external scanning with no host fallback (confirmed 2026-10-21) stays binding.

## How execution runs (owner direction, 2026-10-21)

| Role | Who | Responsibility |
|---|---|---|
| Integration lead | Root (Codex lead session) | Owns shared contracts and dependencies, reviews integration, enforces each gate's definition of done, merges and runs the release |
| Implementation | Claude Opus | Each package in its own worktree and PR, through validation and an open PR |
| Review | SOL reviewers | Review each PR against its backlog gate; findings in Conventional Comments |
| Final cleanup review | Claude Fable (CLI alias `fable`, confirmed installed; the reviewer of the existing [implementation review](claude-review-implementation.md)) | One touch-up review across the delivered product before release |
| Final fixes / verification | Claude Opus fixes Fable's findings; SOL verifies them | No release row moves until verification is recorded |

All planned packages progress to the end of the backlog, then the end gates below, then release.

## Resolutions and scope notes (2026-10-21)

- **Retention:** the [implementation plan](implementation-plan.md) governs — no automatic deletion in v1;
  inspect, pin and prune are explicit. PR 01's age/count windows (`resourceDefaults.retention` in the
  [decision manifest](feasibility-decisions.json)) mark objects **eligible** for an explicit prune only.
  Automatic deletion needs a later owner opt-in. Applies to PR 03 and PR 26.
- **Live model evaluation (PR 22):** needs two models × 30 cases × 5 trials × 2 variants: 300 clean evaluations
  plus 300 paired canary evaluations, 600 in total. Only one local model
  (`qwen3:4b`) is installed; the owner has been asked to choose a second local model or a hosted endpoint with a
  spend cap. This is **pending live-evaluation configuration**, not a blocker for implementation of PR 21/22
  or for the deterministic release.
- **PR 29/30:** separate optional expansion designs, now in the to-the-end plan. Each still needs the design
  review its backlog row names. Real build/runtime testing stays scoped to the original synthetic fixtures and
  the local sample application, never an arbitrary or production target. Their bounded
  [Java-build](isolated-java-build-design.md) and [runtime](managed-runtime-design.md) designs passed SOL review
  on 2026-10-22. Implementation, dependency gates and empirical qualification remain pending; design approval
  is not execution evidence or permission for a broader target.

## Product requirements to carry (owner, captured 2026-10-21)

These already have owning packages; listed here so they are checked at those gates, not rediscovered.

| Requirement | Owning package and gate |
|---|---|
| Configure the scan: profile, scope and which stages run | PR 25 (`implementation-prs.md` §PR 25) |
| Each stage's retained inputs and outputs inspectable (versions, attempts, failures, gaps) | PR 25; inputs/outputs persisted from PR 03/08 |
| Rerun a selected stage or retry, linked to the original run, then compare | PR 25 (UI), PR 08 (resume/rerun execution), PR 19 (comparison) |
| Choose the model per model-review stage; a changed model is a linked rerun over retained inputs | PR 25b, with transport in PR 21 |
| Scan visuals: live progress, stage detail, findings placed on screens/journeys/personas | PR 25 (progress with plan revisions, placement), PR 09 (CLI progress) |
| A report readable without Farsight, Sentinel or the source | PR 19 (standalone), PR 25 (parity), PR 26 (clean recipient) |

## Package status

Status words: **done** (merged with its gate evidence) · **in progress** (work started, gate not met) ·
**pending** (not started). Evidence names what exists, never what is planned.

| PR | Package | Depends on | Status | Definition of done (summary; full gate in the backlog) | Evidence |
|---|---|---|---|---|---|
| 00 | Agree the implementation plan | proposal #117 | done | Owner resolved/deferred choices affecting PR 01; docs valid | [#118](https://github.com/zalos/farsight/pull/118) `0c8c747` |
| 01 | Feasibility harness and capability decisions | 00 | done (bounded) | Every support claim has a fixture/version; rejections have reasons; owner accepts the matrix | [#132](https://github.com/zalos/farsight/pull/132) `2bd38f6`, [#133](https://github.com/zalos/farsight/pull/133) `ef5c525`, [acceptance](feasibility-acceptance.md), owner acceptance 2026-10-21 |
| 02 | Optional package, contracts, ADR | 01 | done | Schema bounds and unknown versions tested; Farsight packs/runs with Sentinel absent or unbuilt; `sentinel` scope and CI selection registered | [#134](https://github.com/zalos/farsight/pull/134) `269c3bc`; 30 contract tests, nine schemas, 36 installed fixtures; SOL review and all CI checks passed |
| 03 | Ledger, object store, coordinator ownership | 02, 01 ownership probe | done | One owner on simultaneous starts; safe takeover; upgrade failure safe | [#135](https://github.com/zalos/farsight/pull/135) `97ff419`; macOS 135 passed/3 explicit skips, Linux 134/4; clean npm reopen; independent SOL review and all nine CI checks |
| 04 | Immutable capture and security inventory | 03 | done | E1 reconciles all entries; unreadable scope stays unknown | [#140](https://github.com/zalos/farsight/pull/140), `464da4e`; SOL reviews, 252 integrated tests/17 explicit skips, identical real ingests, browser checks and all eight final CI checks |
| 05 | Parser integration and inventory reconciliation | 04 | in progress | TS/Java malformed, unsupported and limit cases reconciled; real-ingest comparison vs `main` | — |
| 06 | Rules, policy merge, deterministic planning | 05 | in progress | Repository config cannot weaken mandatory rules | Shared matcher prerequisite [#137](https://github.com/zalos/farsight/pull/137), `2df3dc2`; rules/policy under implementation; planner remains pending |
| 07 | Worker protocol and scanner isolation | 03, 01 isolation decision, 02 | done | Network, host-file, resource and malformed-output canaries fail safely; no host fallback | [#139](https://github.com/zalos/farsight/pull/139), `625a920`; SOL approved, macOS real-container checks 92 passed, Linux qualification 82 passed/zero skipped, all eight final CI checks |
| 08 | Scheduler, resume, pause, cancellation | 03, 06, 07 | in progress | E4 kills at every boundary, 20 repetitions, zero lost/duplicate outputs | — |
| 09 | Standalone CLI and minimal report slice | 08 | in progress | Duplicate starts return one run; disconnect does not stop work; bounded status | — |
| 10 | Pattern scanner and original rules | 09, 01 engine decision | in progress | Pinned engine matches known positives/negatives incl. exit-zero omissions | — |
| 11 | Current-tree secrets | 09 | pending | Synthetic secrets never appear in output, export or logs | — |
| 12 | Offline dependency advisories | 09 | pending | Lockfile/Maven complete vs partial matching distinguished; advisory DB gate measured | — |
| 13 | Infrastructure and CI checks | 09, 12 | pending | Workflow/Dockerfile/IaC positives and negatives against installed tools | — |
| 14 | Next matcher semantics | 05, 06, 09 | pending | Matching, excluded, dynamic and version-mismatch cases correct | — |
| 15 | Express order and mounts | 05, 06, 09 | pending | Auth before/after route, nested mounts and bypass fixtures | — |
| 16 | Nest guards, pipes, interceptors | 05, 06, 09 | pending | Direct providers pass; dynamic/unresolved stay unknown | — |
| 17 | Spring servlet security | 05, 06, 09 | in progress | E2 six review cases plus bypass negatives; no false protected verdict | — |
| 18 | Bounded paths, optional deep engine | 10, 14–17, E3 | pending | Cross-file distinguished from a call path; no invented deep backend | — |
| 19 | Finding identity, comparison, standalone report | 10–18 | pending | Identity stable under movement; standalone HTML/Markdown/JSON readable offline | — |
| 20 | Dispositions, assertions, runtime-evidence import | 19 | pending | Decisions bound to scoped evidence and expiry | — |
| 21 | Ollama and hosted transport | 08, 09 | pending | Redirects, truncation, cancellation, unpriced endpoints handled | — |
| 22 | Guided and general model review | 18–21 | pending | E5/E8 under configured budgets and accepted thresholds; live evaluation awaits the second-model configuration | — |
| 23a | Deterministic MCP and placed evidence | 20, schema with 24 | pending | Read access cannot mutate or admit paid work | — |
| 23b | Fenced external review claims | 22, 23a | pending | Cross-workspace, expired and duplicate submissions fail | — |
| 24 | Optional Farsight host bridge | 09, 20 | pending | Origin/body/path guards, version mismatch, absent service handled | — |
| 25 | Deterministic GUI and placement | 23a, 24 | pending | CLI/MCP/GUI agree; configure → preview → run → stage I/O → rerun → compare demonstrated | — |
| 25b | Model review and disclosure in the GUI | 22, 25 | pending | Model picker; review never changes deterministic totals | — |
| 26 | Replay, retention, packaging, deterministic release gate | 01–20, 23a, 24, 25 | pending | Restored bundle works without the checkout; accepted E1–E4/E7/E8 | — |
| 27 | Conservative differential selection | 26 | pending | Every reuse justified by explicit dependencies | — |
| 28 | Differential/full audit and enablement | 27 | pending | Zero unexplained differences vs full scans | — |
| 29 | Optional isolated Java builds | 26, new owner review | pending | Per backlog §PR 29 after its review; builds only synthetic/sample sources | — |
| 30 | Managed runtime scanning | 26, approved runtime design | pending | Per backlog §PR 30 after its design approval; targets only the local synthetic/sample app | — |

## End gates before release

Each runs after the packages above and is recorded here with its actual outcome. A skipped step is recorded as
skipped with its reason, never as passed.

| Gate | Status | Acceptance test |
|---|---|---|
| Final Fable review | pending | Claude Fable (`fable`) reviews the delivered CLI, MCP, GUI, reports and docs for cleanup/touch-up; findings fixed by Opus; SOL verifies each fix |
| Java + Spring sample application | pending | An **original** Java/Spring Boot sample written for this gate (no external benchmark acquisition) builds and runs in a Linux container (never on the host; source-only scanning does not execute its build). Sentinel scans it and the report shows: a known-vulnerable case found, its safe sibling not flagged, and an unknown/unsupported case reported as unknown, not as protected or clean |
| npm-only consumer install | pending | On a clean machine or prefix with only Node 24 and npm (no pnpm, no checkout): `npm install -g <GitHub Release tarball URL>`, then `--help`; the existing Farsight path (install → `farsight.config.json`/settings → ingest → serve) works as [GETTING-STARTED.md](../../GETTING-STARTED.md) documents; Sentinel's initialization flow, a scan and a report succeed; the report opens offline. Written as initialization instructions for npm-only users |
| Release | pending | The release PR flow in [RELEASING.md](../../RELEASING.md): gates, smoke both independently versioned Farsight/Sentinel tarballs, squash-merge, publish both with their exact install lines, then install each and both from the published URLs in clean Node/npm-only prefixes without pnpm or a checkout; verify the release commit |

## Settled execution choices (lead decisions, 2026-10-21)

- **npm-only distribution:** the GitHub Release tarball URL, which npm installs directly
  ([RELEASING.md](../../RELEASING.md) § *Install a release (consumers)*). Registry publication is added only if
  it is configured at final release; its configuration is checked then, not inferred from the docs.
- **Initialization:** the owner asked for initialization *instructions*, not necessarily a new Farsight `init`
  command. Verify Farsight's existing install → config → ingest → serve path under npm alone, and design
  Sentinel's own `farsight-sentinel init` flow in PR 09 with its CLI. The PR 09 gate now explicitly includes repeat initialization
  preserving configuration and a clean npm-only consumer. PR 26 must publish and smoke both separate tarballs,
  using each package's own version; registry publication remains separate.
- **Java + Spring sample:** written originally for the gate (the owner asked for one to be created); no external
  benchmark acquisition.

Still pending, configuration only: the second model or hosted endpoint with a spend cap for PR 22's live
evaluation (see *Resolutions and scope notes*).
