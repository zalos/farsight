# Farsight — shared Codex / Claude memory

## Phase 0 hygiene landed — 2026-10-27

#199 tooling `b1bca9f9`, #202 gitleaks allowlist `136600b9` and #201 Sentinel formatting `b1439457` landed;
#204 scripts formatting `9d108e34`, #205 string lint `35c12add` and #206 packages formatting `b32b70e5` complete hygiene.
The style PRs proved unchanged JS/TS ASTs and comments: Sentinel 563 files, scripts 70, remaining packages 447.
Sentinel's five worker digests stayed identical; scripts retained all 240 evidence sha256 pins and the feasibility harness.
Sentinel source grew 51,875 → 87,305 lines; scripts 10,170 → 18,166; remaining eligible areas 122,057 → 175,473.
Build, types, unit tests, schemas, package checks, catalog lint and final CI passed; 319 ESLint suppressions remain frozen.
`lint` is the seventh required check. Linked worktrees share one hooks directory; keep the installed hook path lasting.
After pulling into an existing worktree, run `pnpm install --config.confirm-modules-purge=false` once.
A branch without `lefthook.yml` relies on CI's `commits` check until rebased; never commit on main from such a worktree.
`packages/code-parser` and `packages/mcp` stay unformatted until PR #121; its new test file needs `prettier --write` before `format:check`.
Open follow-ups: #200 fixes Sentinel's ESLint/uri-js closure refusal; #203 makes test-file import detection independent of layout.
The three style squash commits are in `.git-blame-ignore-revs`; hook installation sets `blame.ignoreRevsFile` when it exists.

## Sentinel v2 P0-1 tooling — 2026-10-26

Branch `build/prettier-eslint-lefthook` adds pinned Prettier/ESLint/lefthook, frozen lint suppressions, the CI lint
job, the proposal's unchanged AST checker and planted tests, hook migration and contributor guidance. No product
code or CI selector changed. `.npmrc` excludes only `uri-js` from shared pnpm hoisting: ESLint's Ajv retains its own
dependency, while fast-uri's unrelated benchmark import stays outside Sentinel's pinned runtime closure.
Node 24/pnpm 9 build and package typechecks (14 each), formatting/lint/catalog/actionlint, 244 script tests and 38
unchanged Sentinel closure/preparation cases passed. Workspace tests passed 3,380 cases with 161 gated skips and zero failures.
Shared LFS hook hashes are unchanged; branch commits pass and a bad subject was rejected after formatting/re-staging.
The lead owns making `lint` required after its first green CI run. Code formatting and frozen lint debt remain later work.
Review follow-up documents silent hook skips on older branches, the lasting-path install after merge and the one-time
pnpm purge flag for existing worktrees. Root formatting ignores are anchored; Claude scripts now have Node globals,
leaving 319 suppressions across 179 files. Formatting/lint and all 244 script tests passed again. The collector fix is
tracked in [#200](https://github.com/zalos/farsight/issues/200); npm with ESLint 8/9 remains an unverified case.

## Sentinel session closeout — 2026-10-23

The current recap, owner decisions, open issues and ordered release plan are at the repository root:
[SENTINEL-STATUS-2026-10-23.md](../SENTINEL-STATUS-2026-10-23.md). This checkpoint supersedes historical
candidate/merge-pending language below. The owner requested worktree cleanup, an updated main checkout and a
handoff; no new release workflow was started during closeout.

Copilot PR [#190](https://github.com/zalos/farsight/pull/190) merged as `7bb4ba23` after all final checks passed.
The focused owner-interface fix [#196](https://github.com/zalos/farsight/pull/196) merged as `1ff7a25e` after
independent SOL and Claude reviews and all selected checks passed on `9ebefebc`. Consumed/expired pairing now
shows readable recovery guidance; preparation and analysis attempts are distinguished; status and separate
owner controls precede the graph; failed reads visibly disable writes until recovery. One-use pairing, deadlines,
confirmation and model admission remain intact. Nonblocking follow-ups are recorded under #182.

Local UI validation passed 22 controls and one genuine browser flow without skips, with build/types/catalog checks.
Fixed-source main/candidate comparison retained identical 11,399 nodes, 24,466 edges, source digest
`2c154ed1702d` and 45,359,104-byte databases. Graph bytes changed by six through metadata only. Inspected
front-door, Map and code-map screenshots had zero page exceptions or failed requests, with five known missing
fixture-image 404s and corresponding console messages. The verification server was stopped.

The primary checkout stays on main with a refreshed main build and its existing editor-settings edit preserved.
The temporary preview moves to the main build; its expired run and original evidence remain unchanged. The 108
session worktrees have a verified private recovery bundle, file manifests and retained review evidence before
removal; obsolete local and diagnostic remote branches are retired. The final integration checkout is removed
after the closeout documentation merges. Unrelated worktrees and PRs #121/#195 remain untouched.

Latest published Farsight remains **0.3.0**. Targets **0.4.0** and **Sentinel 0.1.0-beta.1** still need the release
workflow, reviewed release PR, publication and published-URL npm acceptance. The original full plan is not done:
ordinary-report model projection, configurable stages, walkthroughs, Spring qualification and Fable review remain
tracked. Hosted API work is paused/default-off; native Claude remains unqualified. Do not repeat paid Copilot
qualification unless the execution path changes or a concrete concern warrants it.

## Sentinel CLI and owner UI release candidate — 2026-10-23

[#183](https://github.com/zalos/farsight/pull/183) merged as `657e8c4b`: durable preparation, separate browser
owner confirmation, the process graph, retained reports and independently installable Farsight/Sentinel npm
tarballs. Genuine source and installed-browser flows covered parent/child selection, expanded stage evidence,
separately confirmed execution, reports and reconnect; six clean npm-only consumers passed 87 checks at the
integrated `517e81ea` checkpoint. The baseline-change delivery race has a reproduced failure and passing correction.

[#190](https://github.com/zalos/farsight/pull/190) adds foreground Copilot CLI review. Its clean `551090cc`
package passed an actual installed public CLI scan using pinned Copilot 1.0.103 on macOS arm64 and explicit
`gpt-6-luna`: three confirmed calls, captured source delivered to the model, a cited model-review observation in
the private instruction report, exact retained prompt/messages/model and empty additional-skills selection,
report regeneration after source removal, and terminal replay with no new dispatch. All ten observed
container-boundary loads recorded zero connection attempts. No local model or hosted API was used. The ordinary
report still truthfully records partial coverage and no deterministic scanner findings; the private review result
is not a completed security verdict. The earlier two-turn run correctly stopped unfinished after listing and
requesting source; new plans allow three turns within the same 120-second deadline, without increasing an
existing owner's token budget. Original failures remain separate from the final pass.

SOL implemented the changes; independent Claude source reviews found no remaining blockers in the final
credential boundary, proxy, output decoding and three-turn correction. The native adapter passed build/types and
79 focused controls with zero skips before the separately tested planning correction. The exact installed native
command also passed a bounded source-free check. Publication still requires final PR CI, squash merge, the
release PR and published-URL npm acceptance; do not infer a published release from this local qualification.

Pure agentic review can run on the host without Docker under explicitly adopted `hostedReviewSecretScan:
when-selected` when no external scanners are selected. Selected external scanners remain container-only with no
host fallback. Native Claude and hosted APIs remain disabled by default. Browser/service starts refuse model
execution requiring the foreground native adapter; this qualification is for the owner CLI. The approved native
credential policy is not confined to one Keychain item, and OS certificate services can fetch outside the child
proxy; README and ADR48 record the limits. Other CLI versions, models and platforms remain unqualified.

Custom stage creation is deferred to [#181](https://github.com/zalos/farsight/issues/181); granular browser reruns,
configuration editing and richer entry details remain [#182](https://github.com/zalos/farsight/issues/182).
The broader plan, Spring sample, Fable polish, code walkthroughs and API qualification remain in the
[scoped release ledger](proposals/farsight-sentinel/execution-progress.md). Historical native memory attribution
remains a nonblocking limitation under passing isolation/recovery gates ([#184](https://github.com/zalos/farsight/issues/184));
missing evidence still yields a failed unidentified exit. This release does not complete the original full plan.

## Sentinel owner decisions integration — 2026-10-23

The isolated owner-decisions candidate extends retained report imports and bounded path reports. An owner can
propose and separately approve a decision against an actual accepted finding, inspect its history, and read the
same conservative evaluation in JSON, Markdown, offline HTML and SARIF. Approval is not proof of remediation:
expiry, changed evidence and invalidated assertions reopen the finding. Metadata pages do not claim evaluated
validity. Secret-bearing ancestry withholds private rationale and source details through the canonical report fold.

Independent Claude source review approved the owner workflow, retained-publication boundary and final integration
corrections. The final runtime `6c19aa45` passed 13 owner-report controls and eight path-owner neighbors without
skips. Its actual fresh npm-only consumer passed 95 commands, native privacy, source removal and retained reports;
container cleanup checked the exact ledger store identity and waited for the owned service to exit naturally.
The earlier offline install failed because the required SDK version was not cached; normal fresh npm installation
passed. These are separate observations, not a retried runtime failure. A later prerequisite merge preserved the
runtime, and the two path catalog-definition corrections changed only help definitions.

Main `9fb78333` and candidate `6c19aa45` ingested the same source: identical 10,585 nodes, 22,494 edges, source
digest `ecc51755fd03` and 41,627,648-byte databases. Graph bytes were 30,227,370 and 30,227,376, differing only in
build/run metadata. Fresh front-door, Map and code-map screenshots were inspected: zero page errors and five known
missing design-image fixture responses. The isolated server was stopped by its recorded PID; the primary checkout,
dogfood graph and global installations were unchanged.

PR CI and merge remain the gate for this candidate. Service-owned imports, the bounded cookie validation story,
entry-point source walkthroughs and the complete owner GUI remain open. Hosted API execution is paused behind an
explicit default-off flag in the separate model-selection integration; the existing implementation is retained.
CLI model adapters, per-stage provider/model selection and exact prompt/skill records are the current priority.

## Sentinel permission-checked MCP controls candidate — 2026-10-23

The next isolated ADR48 slice adds start/resume, pause and cancel to the installed SDK adapter through separate
control capability negotiation. The original read capability schema, socket handshake, owner service responses,
store, worker and canonical report folds remain intact. Ordinary adopted agent grants decide admission; human-only
defaults deny. Actual owner CLI confirmation issues the existing exact one-use receipt. MCP accepts no receipt,
confirm or caller identity, and a future HTTP bridge remains an agent. This CLI-only confirmation is an interim
limitation, not completion of the graphical workflow.

The control response preserves canonical outcomes, exit codes and three cataloged permission verdicts without raw
facts or diagnostics. Resume continues the same run, duplicate starts join, and terminal replay starts no work.
Requested/submitted is intent or acceptance: existing status/wait establishes lifecycle state. A lost response is
uncertain; reconnect reads state without automatic write replay. Older services keep the eight read tools and omit
only the three controls. The installed consumer also withholds one actual accepted start response and verifies
reconnect and unchanged completed attempts, without modifying installed package bytes.

Affected service/read/delivery/budget/contract/package validation passed 99 controls with zero skips; two genuine
local-container retained-secret privacy controls passed with zero skips. Package/selector/workflow controls,
types, schemas and catalog checks passed. The npm-only package exercised 16 typed exports, 28 contract types and
schemas and 63 fixtures. Exact immutable artifacts and final installed evidence belong in the private review
handoff. Independent Claude review approved both the original control slice and final `0e0ee9e5` correction;
root retained byte-identical production source while preserving main's observation and capability-test fixes.
No C preparation implementation is included. Selected CI and merge remain the final candidate gate.
The supplemental correction preserves the original run creation time and budget while honoring a pause during
planned-run setup through legal states, without starting a worker; pending cancellation wins. An unreadable or lost
response after control dispatch is nonretryable controlOutcomeUnknown, with status/readback guidance, rather than
proof the action was unavailable. Genuine unchanged baseline probes reproduced both failures; the corrected
coordinator/selected-rerun/service union passed 99 controls with zero skips and the installed SDK consumer passed
an actual accepted-response corruption case without replay. Same-store epoch changes require fresh per-call
admission; old read handles still expire.

Combined acceptance: the complete workspace build, Sentinel typecheck, generated schemas, catalog lint (4,477
entries), eight preserved workflow controls and 100 affected lifecycle/read/control/contract/package controls
passed with zero test skips. The actual npm-only SDK control consumer passed on the integrated artifact, whose
SHA-256 remains `fd41f994c15295af8d36679d2a4dc7d336d219da552301c4e4a932f6faae47af`.
Main `cce989d4` and integrated runtime `dee88c22` ingested the same 1,735 frozen files at `6d56021f`: identical
9,941 nodes, 20,514 edges, source digest `3937d97a5875` and 38,191,104-byte databases. Graph bytes were
27,874,530 and 27,874,536; only build/run metadata changed. Fresh front-door, Map and code-map screenshots were
inspected with no page errors or failed requests; the same five missing-fixture-image 404 responses remain.
The isolated server was stopped by its recorded PID and its port verified clear. Primary checkout, dogfood graph
and global installations remain untouched.

Configuration saving, durable preparation/reconnect, linked rerun tools, in-browser owner confirmation, service-owned
imports and the full GUI remain separate work. The original native release hold and bounded pending-wait shutdown
note are unchanged.

**This repo is public.** Client material, session handoffs and review evidence live outside it (a private folder the
owner keeps); never add a client name, a site/org URL, an email, a keychain account name or an absolute home path
here. Examples use `example.atlassian.net`, `dev.azure.com/example-org`, `dev@example.com`,
`keychain:farsight/jira-example` / `keychain:farsight/ado-example`, and *the reference app* for the real application
Farsight was dogfooded on.

## Sentinel read-only MCP final integration — 2026-10-23

Independent Claude review approved the read-only service/MCP correction `d35e2d04`; root integrated it as
`8a04048b` with progress documentation only. Immutable work/attempt/input/output views and report deliveries use
the real held owner and canonical report/privacy fold. No mutation, actor override, automatic service startup or
raw artifact reader is exposed. An unexpired view or delivery retains the detached service only until its original
absolute TTL; a connection alone does not. Contention is retryable, MCP status accepts only its run id, and the
SDK peer is pinned. Preparation, execution controls, the bridge and scan GUI remain open.

The original 3012 candidate failed all three unchanged lifetime/contention regression probes; the correction
passed 22 initial focused controls and 46 final lifecycle/socket/detached-run/contracts controls, two native
privacy controls and 14 workflow controls, all without skips. These groups overlap and are not a unique total.
Build, types, schema drift and catalog checks passed. The exact d35 npm tarball is 1,133,673 bytes, SHA-256
`372231b034cd84c5e69c5295f350f358580fceddaf2b89c0fc35f95e3446511f`; the installed official SDK flow passes
source-removed native privacy, clean retained reports, same-channel reconnect/restart expiry and a real 16-second
quiet interval across the detached owner's 15-second idle cutoff. Ordinary import/help also works with the SDK
removed. The draft package has no embedded commit field; the retained source/artifact manifest binds the commit.

Main `2587763a` and integrated `8a04048b` ingested the same 1,724 frozen files: identical 9,886 nodes, 20,445 edges,
source digest `22d37a423759` and 38,006,784-byte databases. Graph bytes changed 27,727,777 → 27,727,783 only through
build/run metadata. Fresh front-door, Map and code-map screenshots were inspected: no page errors or failed
requests, with five known missing-fixture-image responses. The exact temporary server was stopped. The primary
checkout, dogfood graph and global installations remain unchanged. PR #166's first validation found two stale
capability tests that still treated MCP as unavailable. The precise expectation correction preserves every future
unavailable capability and the store-facade checks; both complete files pass 36 tests with one intentional
unqualified-host negative skipped on the qualified host. The original failure is retained. Independent review
approved the exact correction; all fifteen final checks passed on `864242d7`, including full recovery, native
isolation and installed scanners. PR [#166](https://github.com/zalos/farsight/pull/166) merged as `cce989d4`
with the same reviewed tree. Its normal post-merge CI also passed. This does not clear the historical native hold.

The separate observation PR [#165](https://github.com/zalos/farsight/pull/165), head `62f50c2c`, merged as
`6ae1a194` after independent approval and all thirteen selected checks passed. Its first required native job passed 106 original tests and ten diagnostic controls, with zero failures,
skips or cancellations. The CI merge reference has the exact PR tree. Both real journal preflight queries passed;
all three memory cases have exact-container kernel OOM records and own-cgroup counter increases, while plain
SIGKILL remains an unidentified exit. All four traces have zero dropped records. The full twenty-repetition recovery matrix and installed scanner
workflow also passed. This qualifies this observer run, not the three historical failures. No failed job was retried;
release remains held and the temporary diagnostic workflow will not merge.

## Sentinel read-only service integration and native investigation — 2026-10-23

PR #164 merged as `2587763a` with the exact independently reviewed `36f44104` tree. All sixteen final checks
passed, including native isolation, installed scanners and the twenty-repetition recovery matrix. The first
validation failure was a stale strict package-import audit; its exact correction passed before those final checks.

Post-merge native CI did fail: [run 39888758431](https://github.com/zalos/farsight/actions/runs/39888758431)
passed 104 of 106 tests, with two memory canaries exiting 137 without a daemon OOM witness. Other main checks and
installed scanners passed. Production retained an unidentified worker exit, as required; exit 137 is not OOM proof.
This was the third recurrence, and that failed job was not retried.

One separately reviewed test-only diagnostic preserved the original command, concurrency, limits and assertions.
[Run 39893066846](https://github.com/zalos/farsight/actions/runs/39893066846), candidate `9350ccfa`, passed all
106 native tests and eight diagnostic controls with zero skips. Each of its three memory cases had an exact
container-cgroup kill counter and a daemon OOM event; its ordinary forced exit had neither. These observations
do not diagnose the earlier failures. The bounded kernel-journal query used an invalid option and was explicitly
unavailable. The temporary recovery-workflow replacement must never merge. No unchanged retry or release
clearance follows from this passing diagnostic; the investigation and next validation gate remain open.

The first read-only service/MCP candidate `3012c306` reuses the actual owner service and canonical report fold.
Independent Claude source review found no blocking safety issue. SOL is correcting detached-service lifetime,
retryable inspection contention, the status tool's advertised inputs and the exact SDK peer dependency before
the PR. Public controls, plan preparation through MCP, the bridge and scan GUI are separate remaining work.
The frozen candidate passed 72 affected checks, 28 transport/legacy checks and two native privacy checks, each
with zero skips. Actual offline npm-only consumers exercised SDK delivery, source-removed framework and selected
secret ancestry, reconnect, restart expiry and strict installed-worker recovery. Installed SARIF regeneration
parity is semantic; its delivered-byte digest is exact. Same-evaluation held-service parity covers all four exact
legacy renderings. No official SARIF-schema result is claimed for these particular package runs.

Main `2587763a` and candidate `3012c306` ingested the same 1,722 frozen files: identical 9,880 nodes, 20,434 edges,
source digest `49a29835dc0f` and 37,974,016-byte databases. Graph bytes changed 27,712,742 → 27,712,748 through
build/run metadata only. Three fresh screenshots were inspected: no page errors or failed requests; five known
missing-fixture-image responses. The isolated viewer was stopped by its verified process identity. These numbers
describe this checkpoint, not unmeasured subsequent changes; primary checkout and dogfood graph were untouched.

In parallel, the private report-import acceptance checkpoint `d666f0cd` passed independent source review. Its
last delta passed 29 acceptance/process-crash controls and one genuine two-engine privacy case without skips.
Migration 6 is unshipped; main has migrations 1–5. This is storage/authority groundwork, not a public import or
mitigation command. Actual retained owner paths, usable decisions/imports, deterministic service/bridge/full GUI,
configured model work, final Fable review, Java/Spring container qualification, npm initialization and release
remain required. SOL implements, Claude independently reviews, and root owns integration and the definition of done.

## Sentinel retained source and fixed worker integration — 2026-10-22

The isolated shared-proof candidate extends ADR 44 over merged main `d79a9b3a`. Independent Claude reviews
approved the bounded read-only source proof, strict own-package resolver and immutable asset pins, explicit sealed
job identity and legacy report compatibility, and terminal startup verification classification. SOL implements;
Claude reviews; the lead owns integration and final acceptance. This historical candidate subsequently merged as #164; see the newer checkpoint above.

The read proof is bound to the original held owner, executed revision, source closure, deadline and signal.
Aggregate byte/read/depth/time bounds are cooperative and can only tighten; the proof grants no execution authority.
Closed built-in descriptors name shipped files only. Existing reports remain readable without worker assets,
while new execution requires the exact installed manifest, launch gate and worker pins. New framework invocations
bind one explicit sealed job through preparation, execution, normalization and readback; an absent job preserves
legacy accepted records. An exact silent built-in startup refusal is final without refreshing its registered identity.

Integration validation: the build passed, along with types, schema drift, catalog and twelve packer controls.
The first affected run passed 229 controls but one test module failed to import a scratch helper removed by #163.
Adapting that test to the current genuine lease helper preserved its assertions and passed all 27 cases: 256 unique
affected controls now pass with zero skips. The original failed run remains recorded. The installed npm-only
consumer passed source-removed replay, genuine service kill/recovery with the old lease retained, strict assets,
missing-worker legacy reports, pure imports and actual installed worker/gate/manifest startup refusal.

Main `d79a9b3a` and integrated runtime `517b1d57` ingested the same 1,700 frozen files: identical 9,787 nodes,
20,257 edges, source digest `66af17cd4991` and 37,629,952-byte databases. Graph bytes changed
27,466,592 → 27,466,598 only through build/run metadata. All three fresh front-door, Map and code-map screenshots
were inspected: zero page errors or failed requests and five known missing-fixture-image responses. No primary
checkout build, dogfood graph replacement or global installation occurred.

The startup tamper tests now use separate copied packages; 32 controls passed under normal test-file concurrency,
with every shared compiled file unchanged. Independent final delta review approved the isolated harness and
integration; its startup filesystem-status wording correction is applied. Exact-head CI remains before merge. Next is the actual retained
`paths → run → report` workflow. Durable report-import storage and read-only service/MCP are separate reviewed
checkpoints, not completed public features. The Astra plan audit keeps the critical sequence focused on owner
paths/decisions, service/MCP, optional bridge and full scan GUI. Configured model work, the final Fable review,
original Java/Spring container qualification, npm installation documentation and the release remain required.

## Sentinel capture boundary and owned scratch — 2026-10-22

PR #160 (bounded framework inspection) merged as `0b1f74a7`. Capture correction #163 merged as
`d79a9b3a` after all sixteen exact-head checks passed on their first run, including the native isolation gate,
full twenty-repetition recovery matrix and installed five-scanner workflow. It implements ADR 46 and includes
merged deadline correction #161 (`4cbe1d4d`) and planner correction #162 (`aef9e705`). SOL owns implementation and corrections, Claude performs independent review, and the lead owns integration
and the definition of done.

- Working-copy capture excludes only the held store at its exact canonical path and acquired identity. Store
  replacement, aliases, a source inside the store, or lost ownership refuse capture. A look-alike store exempts
  nothing; committed-tree capture has no live-store exemption.
- `.farsight` is ordinary bounded captured data, including ignored settings and local caches. Those private bytes
  never become trusted policy. Earlier snapshots keep their recorded boundaries.
- Scratch lives at `<store>/scratch/<epoch>/w-…`. Creation and every destructive cleanup action re-check the hold
  and recorded folder chain. Cleanup removes only the exact client configuration associated by its creator, after
  its clients exit. Unknown, preparation, attempt and restore data remains; a live client keeps even an empty lease.
- Enumeration is bounded from its first read. Retained old leases survive restart and are not swept; only current
  service retention is reported. Path-based same-account race checks detect replacement, not filesystem confinement.
- Prospective trust and selected runtime paths are checked before effects and must remain outside the workspace.

On supported indexed Express routes, an open route establishes does-not-apply and a guarded route remains a cited
refusalUnproven unknown, without the former artificial sourceIncomplete gap. Hidden routes the parser does not
index remain routeNotInGraph, and a captured settings file seen by no check can make the full report partial.
These are accepted limits of the inspection; none establishes protection or requires expanding the parser here.

Validation (Node 24, pnpm 9, isolated worktrees):

- Affected build/typecheck, schema drift and catalog checks passed; the author's core suite passed 404 tests.
- Final capture, layout, owner identity, scratch and preparation-crash controls: 28 passed, zero skipped.
  After merging #161, the combined build and 46 capture/deadline-boundary controls passed with zero skips.
  After merging #162 (`aef9e705`), the combined build and 53 capture/planner/selected-rerun controls passed with zero skips.
- The actual npm-only installed consumer passed with the existing pinned Gitleaks image: canonical inspection,
  official SARIF, withholding, source-removed selected rerun and actual service/worker kill-and-resume. Old lease
  identity survives recovery. Offline clean and withheld reports had no requests or page/console errors.
- Main and candidate ingested the same 1,689 frozen files: identical 9,670 nodes, 19,978 edges, digest
  `78b9d1d62bdc`, and 37,093,376-byte databases. Graph bytes changed 27,127,953 → 27,127,959 through build/run
  metadata only. The front door, Map and code map rendered with no page errors or failed requests; five known
  fixture-image 404s were recorded. All screenshots were inspected.
- Independent Claude source review approved the scoped capture behavior. Its documentation/comment findings are
  corrected, including the private local-state capture and retained-lease limitations.

Historical failures remain distinct from those passes. The author's later full Sentinel run had 1,143 tests:
1,000 passed, two failed, 141 skipped. The failures were a durable normalized-write test that did not reach its
injected boundary and a framework cancellation test that expected forced termination. A controlled two-file rerun
passed those two cases but exposed a separate driver-signal/deadline mismatch (22 passed, one failed). PR #161
merged with all selected checks passing, including full recovery and installed scanner acceptance. It corrects
unit/run deadline notification and makes durable-write boundary tests deterministic; the framework test's
cancellation timing assumption is being reviewed with the fixed-worker seam. Passing an isolated retry does not
close the original failed run.

Capture qualification limits include an actual Linux bind-mount alias. The complete fixed-worker seam,
path/decision owner commands and full GUI remain later work. Nothing was installed globally, and the primary checkout and its live server were untouched.

## Framework canonical wiring checkpoint — 2026-10-22

The framework integration branch combines the retained analysis seam and bounded worker closure with the selected
rerun foundation. It adds exact owner-promoted framework availability, separately packaged worker lookup, full shipped
build/dependency pinning, and one authenticated inspection section across report formats. The installed npm-only
consumer ran capture/parse/inspection, source-removed selected rerun and read-only replay; changing a shipped chunk or
installed dependency refused before worker import. Facts remain observations/findings-free and unsupported sources
remain partial. Focused coordinator/report fault probes, package import audit, schema and types pass.

Main `64d86ae9` is normal-merged. Production bytes remain the reviewed `43ec307d` checkpoint. Acceptance-only
follow-up controls pass: four genuine Gitleaks/framework cases cover current, baseline, selected and canceled-parent
privacy with clean useful-detail controls; a genuine two-source capture keeps original analysis ids and separate
extents after both sources are removed. The fresh npm-only consumer delivers clean and secret-withheld reports,
recovers an actual service SIGKILL during an unpublished inspection and records exactly one accepted publication.
It uses existing official npm cache bytes offline and existing pinned container assets, with no acquisition.
The installed package retains all 16 exports, 21 contract types, 21 schemas, 56 fixtures, all four framework library
hooks, provider budget reopen controls and five scanner asset manifests. Two delivered reports open offline with
JavaScript disabled, no external request or browser error, and print. Private delivery/screenshots remain outside Git.

Observed limitation: the canonical capture's owner-policy omission of `.farsight` leaves an honest source-incomplete
frontier in Express/Spring, so simple canonical routes may still have unknown answers. The libraries' absence proof
is unchanged; no omitted folder is treated as empty. Original framework support remains bounded to its modeled
versions/shapes; public GUI work, policy assessment and general analysis reuse remain open. Independent final delta
review, one Opus PR review and remote CI/merge are still required. Shared readonly source-proof and worker-descriptor
refactoring belongs to a separate subsequent path integration, with no changes on this framework branch.

## Structural-path data checkpoint (historical scope) — 2026-10-22

Selected reruns merged as [#159](https://github.com/zalos/farsight/pull/159), `64d86ae9`, with the file tree exactly
the reviewed `147eb71c` candidate (runtime `bfb60d65`). All sixteen required and selected CI checks passed.
Independent SOL replay of the final recovery delta passed eleven actual controls with zero skips, including the
unchanged original crash-window public-CLI probe, paused/source-removed owner reopening, future-revision guards and
inherited privacy. Opus's one final source-only review approved the earlier `62de9d6c`; the subsequent corrections
were implemented by SOL and independently reviewed by SOL. No whole PR 09/19/27 or final release gate is implied.

The next isolated branch, `codex/sentinel-path-requests`, starts ADR 45's bounded source-derived request schema,
optional plan pin, source-filtered planner fingerprint and request/generation identity. Its byte/count/schema bounds
run before expensive processing, reject duplicate/unsorted node pairs or broader edge kinds and preserve old no-pin
canonical plan output. A query never grants execution or supplies the missing deep-flow capability. Fifty focused
contract, planner and package controls pass with zero skips; the affected closure build and typecheck, generated
schemas and catalog check pass. A following pure job/output checkpoint binds the canonical request, exact ancestor,
snapshot/source and parser artifact/result/index references to the bytes sealed for an attempt. It reads no workspace
paths, launches or publishes nothing, and returns only the existing call-reachability evidence and frontiers. Five
new original capture/parse controls plus the request/package controls pass 21 tests with zero skips, including source
removal, valid-digest foreign references, missing/substituted bytes and unknown-node frontiers; build/typecheck pass.
These data checks do not authenticate the producer chain or replace request admission. This is a private integration
checkpoint, not a completed path-command feature.

The reviewed shared read-only proof and fixed worker seam now exist. The next lane integrates them with request
admission/retention, then the actual owner command, supervised worker and privacy-safe report. SOL implements and
Claude independently reviews; the lead owns publishing. The data checkpoint above grants no execution authority.
Durable deep-import acceptance remains a separate design and implementation gate.

## Selected-rerun crash-window recovery — 2026-10-22

Runtime checkpoint `bfb60d65` corrects independent review's genuine legacy admit-before-advance crash window on
`a9469623`. Only an active recorded bootstrap revision 1 can continue to its exact immediate analysis revision 2:
the reader authenticates the accepted retained operation, snapshot and previous digest, requires the current immutable
profile, and rebuilds the canonical analysis under the exact lock and policy before comparing its digest. A different
valid analysis or missing invocation refuses before any new records; a merely admitted future revision never replaces
an already current analysis. The same analysis constructor serves normal planning and reconciliation. Source removal
and store reopening do not prevent the proven continuation, and the actual public CLI executes the recovered analysis
with the existing honest foundation-preview coverage result.

The final Node 24 closure build and typecheck pass, with 64 named service controls, 25 selected authority/privacy/
upgrade controls and ten package controls passing with zero skips. A fresh npm-only five-engine/two-capture consumer
again passes retained full reporting/comparison and selected-child joins, generations and parent immutability after
source removal and service shutdown, including official SARIF validation; only existing pinned assets were used.
The four new crash-window controls include an exact continuation,
a different schema-valid successor, a missing accepted invocation and current revision 2 with admitted revision 3.
The preceding baseline failed the positive continuation and both refusal checks. These corrections change only
canonical planning and its tests; the reviewed report projection, key reader, scanner adapters, library implementations,
core, parser, store and package boundaries remain intact. Independent SOL delta review and final CI/merge remain
required. The real-ingest/browser measurements below remain attributed to `35302206`.

## Selected-rerun final review corrections — 2026-10-22

Runtime checkpoint `a9469623` follows independently reviewed `35302206` and the final source-only Opus approval
of `62de9d6c`. The CI correction `28477db0` requires retained bootstrap proof only for a strict transitive subset:
selecting a root whose downstream closure includes every unit keeps the fresh-bootstrap path. The synthetic diamond
has no real coordinator bootstrap and now correctly refuses subset reuse without writing events; a genuinely
captured, parsed and inventoried parent still previews its exact retained subset. `1d89496b` rejoins an active
whole-analysis rerun admitted with the legacy identity algorithm across upgrade, then chooses a fresh generation
once the old request is completed or canceled. It also removes the unused selection lookup and fixes its doc comment.

A recovered child's full report now uses the same pinned-ancestor privacy collector as its minimal report.
Cancellation of a parent does not erase a secret unit that genuinely succeeded and published. The reader verifies
its exact plan revision/digest and capture, canonical work envelope, assigned captured inputs and checks, owned
container attempt and accepted invocation, then the redacted findings and exact summary count. Secret matches keep
both profiles coarsely withheld; a clean canceled-parent scan preserves useful excerpts and ordinary names. Missing
or malformed accepted artifacts or invocation refuse both surfaces. Parent findings and coverage are never copied.

On this final runtime the dependency-closure build and typecheck pass, the complete named CI service suite passes
64 checks, and 21 selected authority/privacy/upgrade controls pass, all with zero skips. Both new availability cases
and the legacy-identity case failed their preceding baseline. A fresh packed npm-only consumer runs all five existing
pinned engines on two captures, removes the source, stops its service, regenerates full reports and comparison,
validates official SARIF and exercises selected-child joins, terminal generations and parent immutability. The
additional import-audit entry in test-only `631f0fa1` records the shared reader's existing graph dependency; all ten
package controls pass, including import-time no-work checks. No new dependency, package export, asset acquisition,
parser, core or store implementation changed. The earlier `35302206` graph/browser numbers below remain scoped to
that runtime, rather than presented as a fresh measurement of these canonical/report-only corrections. Independent
SOL review of this delta, final candidate CI and merge remain pending; no whole PR 09/19/27 or release gate is closed.

## Selected reruns with retained reports — 2026-10-22

Branch `codex/sentinel-rerun-integration` normally merges reviewed selected reruns `45d0aed1` with report integration
and actual merged main `63ecf4f0` (#155). Runtime checkpoint `35302206` preserves the selection and generation
implementation, all five scanner packs, framework/path/provider libraries, package exports, coarse report projection
and owner-private key reader. The exact verified ancestor revision and digest travel into both privacy readers: an admitted but unexecuted future plan cannot erase the executed revision's accepted secret evidence. This corrects independent review's blocker on `48f8bb20`; that checkpoint was not approved. Subsequent handoff changes are documentation only. Strict-subset preview, admission and
reporting now share one retained-bootstrap proof: exact selected parent revision/digest/snapshot, accepted inventory
operation and retained invocation. Invalid ancestry refuses before any new child records are admitted. A selected
child and grandchild can reconstruct full reports after the source is gone; held checks remain incomplete and no
parent finding, coverage record or event becomes the child's.

A Pattern-only selected child also retains proven same-capture privacy knowledge when its parent accepted secret
matches. Full reports use the existing coarse projection even without an explicit comparison baseline; a selected
baseline carries the same restriction into comparison. Minimal JSON reports inherit matched-name withholding through
the existing secret-record validator. Clean accepted ancestry preserves excerpts, context labels and ordinary file
names. Missing or corrupt accepted privacy evidence refuses. At this historical checkpoint a canceled ancestor with an
accepted secret publication conservatively refused full reporting; the authenticated-reader correction above supersedes
that availability limitation without widening which runs can themselves be reported.

On `35302206`, Sentinel build and typecheck, schemas, catalog (4,405 entries), thirteen workflow controls and
workflow lint pass. Eighteen selected execution/report/privacy controls pass with zero skips, including genuine
future-revision admission, exact current/baseline privacy, clean ancestry and corrupt/missing evidence. A fresh
npm-only consumer runs five existing pinned engines on two captures, removes the source, stops its service and
reconstructs parent/child full reports and comparison with official SARIF validation. Another compiles sixteen
exports and 21 contract types, checks 21 schemas and 56 fixtures, reopens the store and runs all installed library
hooks; its SARIF also fits the official schema. Independent SOL review of `35302206` passes fifteen actual affected
controls, including the unchanged original latest-revision repro and canceled-parent boundary, with zero skips.

Broader unchanged paths were verified on the superseded `48f8bb20`: 44 publication/package/preview-CLI/store controls
and two capability controls pass with zero skips. Its genuine service SIGKILL replay preserves the pending/running
child, retains its interrupted attempt, leaves held units idle and creates new completed/canceled generations. Those
identity, execution and packaging paths are unchanged by the three-file privacy revision correction. No scanner
image, checks bundle or model was acquired. This scoped reuse does not declare the failed privacy checkpoint approved.

Against a clean main `63ecf4f0` build, the corrected `35302206` runtime passes a fresh comparison: both builds ingest the same frozen 1,655-file repository into 9,492 nodes,
19,539 edges and source digest prefix `729b63db7af7`; all node/edge values match. Both databases are 36,253,696 bytes. Graph
JSON is 26,544,614 bytes on main and 26,544,620 on the candidate: six build/run-metadata bytes. Fresh front-door, Map
and code-map screens were inspected with no page errors or failed requests; five known fixture image 404s and their
console messages are unchanged. The comparison ran in isolated trees; the primary checkout and its server were not
built or changed. Independent SOL review passed; final PR review, candidate CI and merge remain pending. PR 09/19, analysis-prerequisite reuse
(PR 27), canonical framework/path/provider commands, model and release gates are not declared complete. SOL implements
and independently reviews; Opus has one final completed-PR review. The separate end-of-plan product cleanup review
remains required before release.

## Full owner report integration — 2026-10-22

Branch `codex/sentinel-final-report-integration` combines reviewed report projection `ce9130b0` with the merged
scanner/library tree `34ca02b5` (exactly the reviewed `7ee256a2` tree), retaining the separately reviewed
`7f8dd217` nonblocking owner-record read and its private-key-loss identity boundary. The report/CLI/scanner
implementation remains the reviewed report source; incoming framework, bounded-path and provider implementations
remain the reviewed library bytes. Catalog, contracts, owner-only actions, schemas and exports are additive unions;
all five scanner asset sets use one packaging hook loop. The eleven recent foundation merge IDs and their scoped
acceptance are listed in `docs/proposals/farsight-sentinel/execution-progress.md`.

An accepted secret match in the run or its baseline makes every source/context-controlled detail opaque in the full
report, including ordinary excerpts, locations and context names, in both private and shareable profiles. Trusted
catalog words, generated identities and counts remain. This deliberately reduces report detail because the current
worker publishes whole-line citations and cannot prove every value's exact range. No-match reports retain their
ordinary placement and excerpts. The graph is owner-attested and bound to current captured bytes; this does not
independently verify the graph producer or semantics. A missing private key creates new withheld-location identities;
old delivered files remain unchanged and a store/bundle copy cannot restore that key.

The source integration and independent correction reviews are complete. On source checkpoint `1a588f34`, the
Sentinel dependency build, typecheck, schemas and catalog (4,402 entries) pass. Package/contract/policy controls
(62), capability controls (2), workflow controls (3), publication/record controls (57, including ten actual Pattern
opt-ins) and report-library controls (19, including official SARIF and offline printing) pass. A fresh npm-only
consumer compiles 16 exports and 21 contract types, checks 21 schemas and 56 fixtures, runs the installed library
hooks and verifies all five asset sets. The installed CLI runs all five existing pinned engines on two genuine
captures, stops its own service, removes the source and reconstructs full reports and comparison from retained
accepted evidence. Its actual SARIF validates against the official schema; private/shareable HTML open offline
with JavaScript disabled, no external request or browser error, and print. The shareable screen was inspected.
The initial pure pass deliberately excluded ten native controls; all ten then ran and passed separately.

All required and selected CI passed and this report slice merged as #155, `63ecf4f0`. No full-plan completion is
claimed: canonical framework/path/provider commands, model evaluation, dispositions, selected-stage integration,
MCP/host/GUI/bundle and release gates remain open. No source application, host scanner or hosted model is executed
by this report integration. This is local macOS arm64 / Docker Desktop Linux arm64 acceptance, not a new host claim.

## Owner-private record FIFO refusal — 2026-10-22

Branch `codex/sentinel-published-record-fifo`, based on the private report-key correction, opens published records
with `O_NONBLOCK` before inspecting their descriptor. A FIFO substituted for a report key, rule-lock record or
adopted-asset record is refused as a nonregular file without waiting for a writer. Existing regular-file, ownership,
mode, link-count and byte-limit checks are unchanged. Report-key continuity still depends on retaining the same
owner-private key; a missing key starts a new identity domain, as the architecture now explicitly records.

Both actual-FIFO regressions timed out on the frozen base while the regular-file positive passed. The correction
passes all four new controls and the existing receipt/rule-lock/adopted-asset caller controls: 30 focused checks,
zero skips. The genuine pinned local Gitleaks publication-to-full-report private-key check passes separately
(1 check, zero skips). Sentinel dependency-closure build, typecheck and commit-title lint pass. No other report
privacy implementation was changed; final report integration and independent review remain separately owned.

## Nest with provider and paths libraries — 2026-10-22

Branch `codex/sentinel-nest-integration` merges reviewed provider/path integration `2ab52485` into Nest
`b3ddfb2c`. Nest implementation, tests, fixtures and catalog (14 files) remain byte-identical to `b3ddfb2c`;
all 217 incoming implementation, schema, rule, asset, packaging and selected test/control files remain
byte-identical to `2ab52485`. Additive resolutions retain every framework, provider and analysis export,
catalog registration, precise import audit and package consumer fixture. No new runtime behavior is introduced.

Validation: Sentinel dependency-closure build and typecheck, generated-schema check and catalog lint (4,203
entries), ten package-boundary cases and two capability-union controls pass with zero skips. A clean npm-only
consumer compiles 14 exports and 21 contract types, validates 21 schemas and 55 fixtures, verifies retained
Pattern/OSV assets, reopens the store, runs the captured call path/import refusal and analyzes installed Nest,
Spring and Express fixtures. No advisory database ships and no scanner or target code runs. The unchanged Nest
behavioral suites are not repeated. The provider-only installed type/budget probe remains bound to the unchanged
`2ab52485` provider implementation; no hosted/model call or real keychain read is performed. Canonical framework
commands, public provider dispatch and deep-engine qualification remain separate completion gates.

## Nest integration retains the reviewed Next and Spring aggregate — 2026-10-22

Branch `codex/sentinel-nest-integration` merges reviewed aggregate `467a13b1` into `f78f3ce8`.
Nest source, tests, fixtures and catalog remain byte-identical to `f78f3ce8`; Next, Spring and Express source,
tests and catalogs, plus the adapter and execution runtime, remain byte-identical to `467a13b1`. All four public
framework library exports and existing installed-package checks are retained. Next's command capability remains
unavailable; Spring and Express keep their incoming draft library capabilities. No operation is registered here.

Validation on Node 24.19.0: dependency-closure build, Sentinel typecheck, schemas and catalog passed. Ten package
checks and two capability checks passed with zero skips. A fresh npm consumer imports twelve typed exports,
compiles 19 contract types, validates 19 schemas and 53 fixtures, reopens storage across processes, analyses Nest,
Spring (open/protected/unknown) and Express (before/after/conditional), and verifies Pattern/OSV assets. The
unchanged Nest suite was not repeated after its 104-test combined framework/package run at `f78f3ce8`.
No target code or scanner was run. Final native CI and canonical framework command integration remain open.

## Nest library merged with main foundations — 2026-10-22

Branch `codex/sentinel-nest-integration` merges main `6bf00a7d` into reviewed Nest head `17ac292e`.
The Nest implementation, its test and fixture tree, and its catalog are byte-identical to that reviewed head.
Express, Pattern and OSV adapter source, execution runtime and OOM controls are byte-identical to incoming main.
The export map, catalog registration, package import audit, documentation and standalone consumer retain both
framework libraries and both scanner asset sets. Capability expectations retain main's Express draft library;
no framework operation is added to the planner or preview command.

Validation on Node 24.19.0: Sentinel dependency-closure build, typecheck, schema check and catalog lint passed.
The focused Nest, Express and package suites passed 104 tests, and two capability controls passed, all without
skips. A clean npm-only consumer exercised both installed framework APIs, compiled ten public exports and 19
contract types, validated 19 schemas and 53 fixtures, and reopened storage across processes. It verified all 17
Pattern pack files and the Pattern/OSV worker digests, with no advisory database bundled. No scanner or target
code was executed. Broader historical suite and graph measurements remain qualified to their recorded heads;
canonical framework command integration and new native qualification are separate gates.

## Provider foundation with paths and framework libraries — 2026-10-22

Branch `codex/sentinel-providers-integration` merges frozen paths/framework integration `58cd029c` into provider
integration `04da438d`. All 12 provider implementation/test/helper/catalog files remain byte-identical to reviewed
`d7a55530`; all 206 incoming Sentinel implementation, contract/schema, rule, asset, packaging and selected OOM/path
control files remain byte-identical to `58cd029c`. Additive resolutions retain both public exports, both catalog
registrations and package-map descriptions. The precise capability assertions still list drafts only where the
library is available; public provider dispatch and deep-engine qualification remain open.

Validation: Sentinel dependency-closure build and typecheck, generated-schema check and catalog lint (4,162
entries); ten package-boundary cases plus two capability-union controls pass with zero skips. A clean npm-only
consumer compiles 13 exports and 21 contract types, validates 21 schemas and 55 fixtures, verifies Pattern/OSV
assets, reopens the store, runs the installed path query/import refusal and analyzes Spring and Express fixtures.
A separate npm-only consumer compiles all 27 named provider types and verifies durable budget reopening,
uncertain-charge retention and excess-reservation refusal without invoking an endpoint. The unchanged
35-case provider/package behavioral run remains bound to its earlier named head; no broad repeat is claimed.
No hosted/model call or real keychain read is used for this integration.

## Bounded paths with Next and Spring integration — 2026-10-22

Branch `codex/sentinel-paths-integration` combines the reviewed paths/import foundation `41de557d` with frozen
Next/Spring integration `467a13b1`. The paths implementation, contracts, schemas and schema generator (45 files)
remain byte-identical to `41de557d`; Next, Spring, Express, OSV, execution, capture and asset implementations
(71 files), plus the delayed-OOM controls, retain the incoming bytes. Both catalogs and export maps are preserved.
The package consumer retains the actual path query/import refusal and both Spring and Express source fixtures.
Capabilities list the exact available drafts while deep flow and unintegrated commands remain unavailable.

Validation: Sentinel dependency-closure build and typecheck, generated-schema check and catalog lint (4,130
entries); 48 paths/contracts/package cases and two capability-union controls pass with zero skips. A clean
npm-only consumer compiles 12 typed exports and 21 contract types, validates 21 schemas and 55 fixtures, verifies
17 Pattern assets and the OSV worker, reopens the store across processes, runs the installed path query/import
refusal, and analyzes the installed Spring (open, protected, unknown) and Express (before, after, conditional)
fixtures. No advisory database ships. The prior
full-suite, ingest and browser measurements below remain bound to their named historical candidates. No scanner,
deep engine or target application code is run for this integration. Full PR 18 public command/deep qualification
remains open.

## Bounded paths integration on merged foundations — 2026-10-22

Branch `codex/sentinel-paths-integration` rebases the five reviewed path/import commits ending at `09bd0b64`
onto merged Pattern main `5196dc70`, then includes merged Express main `95387a4e` with a feature-branch merge.
The path implementation and its two contracts are byte-identical to `09bd0b64`; merged Pattern rules/adapter and
Express implementation bytes are retained unchanged. Catalogs, ADRs, exports, precise import-audit entries,
capability assertions and the clean npm consumer retain all three boundaries. `evidence.import` remains an
owner-only verb, imported observations remain imported, and no qualified deep engine or public command wiring is
claimed. The consumer runs both the installed path query/import refusal and Express source-only fixture analysis.

Validation on the combined candidate: Sentinel dependency-closure build and typecheck, generated schemas and
catalog lint; 110 affected path/contract/policy/package/Pattern/Express tests plus two capability-union controls
passed, zero skips. A fresh npm-only consumer compiled ten typed exports and 21 contract types, checked 21 schemas,
55 fixtures and all 17 Pattern assets, reopened the store across processes, ran a captured cross-file call query,
refused import without an owner receipt, and analyzed the Express before/after/conditional fixture. No target code,
scanner or deep engine ran. Earlier full-suite, fixed-source ingest and browser results belong to `09bd0b64` against
`e25424fb`, not this merged candidate. Full PR 18 command/deep qualification remains open.

## Next patch identity correction — 2026-10-22

Branch `codex/sentinel-next-patched-identity` refuses recorded pnpm patches for Next, React and React DOM,
including lock patch maps, importer/package patch hashes and project/workspace-root package declarations.
Nested projects read only captured root declaration bytes; absent recorded bytes or malformed declarations leave
versions unknown. Ancestor declaration identities contribute to registration and surface influence digests. Pack
revision 3 invalidates facts produced with the earlier package identity semantics. Ordinary peer suffixes and
unrelated patches still qualify. This is source-only installation evidence, not a runtime package attestation.

Validation: Sentinel dependency-closure build; Next matcher/pack suites (23 tests, no skips), including actual
capture → delete checkout → parse → analyze patched fixtures and a nested workspace control. The original
independent patched-package probe was replayed unchanged. Public CLI integration remains separately pending.

## Delayed OOM canary correction — 2026-10-22

Branch `codex/sentinel-oom-settling-investigation` corrects the test-only Docker visibility adapter: it hides the
first two terminal exit-137 observations, including naturally false flags, instead of hiding the first two true
OOM flags. The old adapter compounds natural daemon delay and can exhaust the actual backend's four-read bound;
a deterministic backend regression fails with the old adapter and passes with the correction. Production
classification, the 500 ms bound, cancellation and exact ownership/cleanup are unchanged. Exit 137 with no
affirmative OOM evidence remains `workerExited`. Required native positives still require genuine daemon evidence.

Validation: Sentinel dependency-closure build; four pure state controls plus all 20 native isolation checks pass
with zero skips on Docker Desktop Engine 29.2.1 / Linux arm64. Ten additional focused native OOM/plain-SIGKILL
trials pass. Native inspect diagnostics retain at most 16 bounded state/timing rows, without paths or source.
The original Linux CI failure lacked raw inspect observations, so its exact daemon sequence remains unproven;
required native CI on the corrected head must pass before integration.

## Combined scanner foundations — 2026-10-22

Branch `codex/sentinel-scanner-integration` combines reviewed scanner integration `44ff7fae` with foundation
head `7d392239` in one feature merge. Scanner, driver, scheduler, policy and report implementation bytes remain
identical to `44ff7fae`; the incoming Express implementation and corrected bounded OOM visibility controls are
retained. The pre-start confirmed-cleanup regression and scoped invocation inputs also remain intact. Catalogs,
ADRs, README, import audits, exports and package consumers retain all four scanner asset sets and the source-only
Express library. Express is available as a draft library; no framework scanner driver or public framework command
acceptance is claimed. The IaC package selector and no-selector four-engine behavior are unchanged.

Validation: Sentinel dependency-closure build, typecheck, generated schemas and catalog lint passed. Four pure
OOM-state controls and ten package controls, plus two capability-union controls, passed with zero skips. The fresh
npm-only package consumer compiled nine exports and 19 contract types, validated 19 schemas and 53 fixtures,
reopened the store across processes, analyzed the installed Express before/after/conditional fixture and verified
all four scanner asset sets. A separate installed public CLI consumer passed owner adoption, missing-asset refusal,
exact tool/database promotion, plan and detached/joined execution through all four existing pinned containers;
its report survived service restart and source removal, and incomplete required coverage remained exit 2. No target
code or host scanner ran; no scanner assets were downloaded and no hosted model was called. This is local arm64 evidence; combined native CI remains an
integration gate. The earlier 576-test broad suite belongs to `44ff7fae` and was not repeated for this source-preserving merge.

## Full reports require the accepted preview findings document — 2026-10-22

Branch `codex/sentinel-report-preview-shape`, based on `a9cea6fa`, closes a remaining report-consumer gap:
a genuine accepted preview unit whose raw output is valid JSON with an unrecognized schema cannot become a
complete zero-finding report. The consumer requires exactly one preview findings document, bound to the detector,
rule, assigned checks and scopes. Malformed or duplicate documents refuse. Other auxiliary JSON stays allowed,
and a genuine empty findings document remains complete. Scanner record handling is unchanged.

Three new genuine-publication negatives (wrong schema, incomplete identity and duplicate document) fail on the
base while the positive report and auxiliary-JSON controls pass. With the fix, the full authority suite plus the
real four-engine public full-report/context/compare lifecycle pass 26 tests with no skips on Node 24.19.0 using
existing pinned Linux containers and offline synthetic data. Dependency build, typecheck and catalog lint pass.
The independent review also exercised duplicated vulnerable dependency locks and Dockerfiles, retaining both
identical-byte paths distinctly. No target code, hosted model or real credential was used. Gitleaks full-report
support and combined integration/native CI remain separately owned gates; no push or main merge occurred.

## Start here

Read `AGENTS.md` for project rules and architecture. Codex loads it as project instructions; `CLAUDE.md` imports it and this handoff. Keep durable facts in those repository files so both providers receive updates. This is project memory, not ChatGPT account memory or a synchronization of private conversation histories.

Inspect `git status --short --branch` before edits. Preserve existing work; use separate worktrees for simultaneous implementation. At handoff, record the branch, changed files, validation commands/results, and remaining work here. Recheck dated facts against code. Do not assume another provider's authentication, permissions, or MCP session carries over.

## Runtime and commands

The project requires Node 24+ and pnpm 9.0.0. `.nvmrc` selects Node 24; with nvm installed, use `nvm install` once and `nvm use` in each development shell. These commands install/select a runtime only when explicitly run; adding `.nvmrc` does not change an existing shell. Any Node 24 on PATH works.

```sh
nvm use
node --version
pnpm --version
pnpm install --frozen-lockfile     # fresh checkout
pnpm build
pnpm -r typecheck
pnpm -r test
pnpm lint:strings
```

Tests import compiled `dist/`, so build first. A fresh checkout also needs `cp .farsight/settings.example.json .farsight/settings.json` (or nothing — the server falls back to a one-source workspace) and an ingest or `/api/sync` before `serve`/`mcp` have a graph.

## Sentinel Nest framework escapes — 2026-10-22

Branch `codex/sentinel-nest-escape-fixes`, based on `910acbb6`, adds `frameworkEscapes` where a framework value
leaves supported local aliases: sequences, aggregates, class fields, parameter/default passing, returns and
unsupported constructor methods. These frontiers prevent validation credit and absence claims. Existing alias
mutation checks retain lexical shadowing, and the registration-origin dependency-copy resolution is unchanged.
Type and noncomputed property names do not count as runtime value passing. ADR 32 and the package README record
the boundary; fixtures are captured and parsed, never executed.

Validation: the graph/core/code-parser/Sentinel build and typecheck closure passed; catalog lint and exact commit
subject lint passed. The focused owner suite (37 tests) plus the independent captured-source probes (23) passed:
60 passed, 0 failed, 0 skipped. Running the 15 new durable cases against unchanged baseline output produced
13 failures for the escape cases and 2 passes for the harmless-name/shadow controls. No full suite, scanner,
network engine, target application execution or primary checkout build was needed. Independent review is pending.

### General framework reference uses (follow-up)

The follow-up after `1b2494ae` replaces the syntax-specific escape list with a whitelist of supported runtime
reference uses. Unmodeled consumers default to `frameworkEscapes`; tagged templates, instance/helper flows,
subclasses, exports and assignment results cannot hide a framework value. Types, declaration/property names,
discarded reads, supported local aliases and unused shadowed parameters remain harmless. Unfollowed global
registrations keep their more specific reason.

Validation: 75 focused captured-source cases passed, 0 failed, 0 skipped (45 durable owner cases plus 30
independent probes). The eight new durable cases against a fresh immutable build of `1b2494ae` produced seven
failures and one positive-control pass. Affected builds/types, catalog and exact commit subject lint passed.
All fixtures remain inert capture/parse/analysis inputs; no target code is executed. Independent review is pending.

### Export, namespace and runtime-import boundaries (follow-up)

The follow-up after `d2bfd655` proves a supported alias stays in a local, nonexported declaration outside an
unmodeled namespace. Later assignments to exported live bindings are escapes too. Qualified runtime
import-equals references are no longer erased as types. Framework CommonJS/dynamic loads and retained host or
Node loader capabilities are unknown; actual lexical/module declarations shadow those host loader names.
Valid type-only imports, unrelated namespace member names and a shadowed local `require` remain positive controls.

Validation: 91 focused captured-source cases passed, 0 failed, 0 skipped (58 durable owner cases plus 33
independent probes, including all three new review failures). Thirteen new durable cases against a fresh
immutable `d2bfd655` build produced 10 negative failures and 3 positive-control passes. Sentinel build/typecheck,
catalog and exact subject lint passed. No target application code was executed. Independent review is pending.

## Provider access

- Codex: `.codex/config.toml` configures the workspace CLI over MCP stdio.
- Claude Code: `.mcp.json` configures the same workspace CLI and graph. `.claude/launch.json` defines the viewer on port 4477.
- Both launch `node packages/cli/dist/cli.js mcp --graph graph.json` from this repository root. Select the supported Node runtime in the environment launching the client. Existing desktop clients may retain their older PATH until restarted.
- Both provider configurations have eight corresponding review personas and three outsider personas (a comprehension round on the application Farsight displays) under their respective `agents/` directories (how to run them: `docs/review-swarm.md`).
- After rebuilding, restart running viewer/MCP processes before trusting new behavior. Reload the browser after refreshing the graph.
- Use `node packages/cli/dist/cli.js status` to inspect build/graph/server currency. Do not assume a successful build updated an existing server.
- Preserve the multi-source dogfood graph: use the workspace server's `POST /api/sync` after restart. Bare CLI ingest replaces it and ignores workspace source excludes. Smoke-test ingest from a temporary cwd with an explicit output path instead; SQLite history is cwd-relative too.

Codex project instruction and MCP conventions were checked against [official AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Gitleaks and library aggregate — 2026-10-22

The `codex/sol-gitleaks-integration` follow-on normally merges the independently reviewed scanner/library aggregate
`a7b18df9` into `a512693d`. All 98 recorded scanner, execution, driver, CLI, planner and service implementations keep
the exact reviewed Gitleaks/privacy bytes; all 42 framework/path/provider implementations keep the incoming library
bytes. Observation/withheld-location contracts, capture and location resolution remain unchanged from `a512693d`.
Catalogs, schemas, contract fixtures, capability assertions and consumer hooks form an additive union. The packer
retains exactly the reviewed single complete hook pass and ships all five scanner asset sets.

Validation covers the affected build/types/generated schemas/catalog, 32 package/contract/genuine-Gitleaks-command
checks, two capability-union controls and three scanner-workflow controls, all with zero skips. The fresh npm-only
consumer compiles 14 exports and 21 contract types, checks 21 schemas and 56 fixtures, reopens the store and exercises
all library behavior hooks and asset manifests. Actual installed secrets and four-scanner command consumers check
privacy/omissions and adoption/detach/replay behavior against existing pinned local containers. No engine acquisition,
provider call or target application execution occurs. The broad 657-test suite and crash matrix are not repeated for
unchanged raw implementations. Previous CI and fixed-source ingest/browser measurements remain attributed to their
exact `a512693d`/`c3e5414b` context; the final union still requires independent review and its own CI before merge.
Full report/secret integration, finding-policy/model/framework commands and remaining release gates stay separate.
No primary build or push.

## Sentinel scanner/library integration — 2026-10-22

The final `codex/sentinel-scanner-integration` aggregate normally merges the reviewed Nest/provider/path/Next/Spring
foundations into `a26ca4a4`. All 85 recorded scanner/execution/driver/service/planner implementation files remain
exactly that candidate's bytes, and all 42 incoming framework/path/provider implementation files match the supplied
aggregate. The package retains every asset hook, now invoked once; public exports, catalogs, schema registrations,
dependencies, import audits and capability assertions combine both sides. Capability words remain scoped to proved
library or explicit four-scanner command behavior; full framework/model/policy/report integration is still open.

The package consumer now permanently checks Next peer identity, patched/unsupported identity and dynamic matchers
from retained capture after source removal, plus offline provider budget reservation, overspend refusal and reopen.
These child probes import only installed public exports, use original inert fixtures and contact no provider.
Fresh npm validation compiles 14 exports and 21 contract types, checks 21 schemas and 55 fixtures, exercises installed
Nest/Spring/Express/paths/Next/provider behavior, and verifies all four scanner asset sets. A separate true installed
four-scanner CLI consumer passes owner adoption, missing-asset refusal, plan/detach/join/wait and report replay after
service restart/source removal; incomplete coverage stays exit 2. Build/types/schema/catalog and focused
package/contract/capability/workflow checks pass. Prior native CI and 20-repetition recovery results belong to exact
`a26ca4a4`; the new integration still needs its own selected CI. No primary build, push or merge into main.

## Full report accepted-evidence correction — 2026-10-22

The isolated `codex/sentinel-full-report-authority-fixes` follow-on to the full-report command refuses missing,
malformed or non-UTF-8 accepted report inputs. Scanner findings require nonempty unique assignments joined to the
actual admitted check's family/revision, work revision, source, adapter and exact file scope. Each resulting
observation cites only that check's captured locations. Context files use nonblocking no-follow regular descriptors,
size ceilings and exact stable reads; current workspace inputs cannot exceed their captured size or traverse a
replaced parent link. Matching context remains an owner attestation of a supplied graph against captured bytes,
not independent verification of graph semantics or producer. The native scanner workflow includes these regressions.

Validation: the expanded genuine-publication regressions produced ten failures and ten passing controls on the
unchanged base; the corrected public four-engine CLI/context/compare, authority and finding-comparison checks pass
31/31 with zero skips. Existing context, disclosure, official SARIF schema and offline browser/printing controls
pass 19/19 with zero skips. Sentinel closure and parser builds, Sentinel types, catalog and exact commit-title lint
pass. This local measurement used existing pinned Linux containers on the development host; native amd64 CI is a
separate gate. No scanner acquisition, primary build, push or merge. Canonical Gitleaks full-report integration and
retaining report/context artifacts for recipient replay remain separate follow-ons; full plan completion is not claimed.

## Sentinel Trivy/zizmor native qualification — 2026-10-22

A separate follow-on records Linux amd64 as measured for the existing pinned Trivy and zizmor workers only.
[Native CI job 119958735627](https://github.com/zalos/farsight/actions/runs/39817213827/job/119958735627) checked out merge
`0d6daa8cd369835fe6ec8ec5a89b4d25cb23edc5` (PR head `454667ed8f254ac11b6e030b1ad9e44dcd333b8b` onto
`e25424fb637e5491e307a2be8d9124af2463450d`): all 33 adapter/conformance tests passed with zero skips, then both
installed workers produced the expected findings. The sanitized evidence record binds image manifests, worker
bytes, source digests and the exact job. No broader engine, runtime, architecture, CLI or coverage qualification is
implied; zizmor's offline limits still apply. The workflow now expects the measured platform word.
Local follow-on validation: build and typecheck passed, all 35 unit/container conformance cases passed with zero
skips on the existing arm64 runtime, and the installed package ran both unchanged workers successfully.

## Next fix-stack integration with merged foundations — 2026-10-22

Branch `codex/sentinel-next-integration` incorporates the reviewed patch-identity correction and follow-ups through
`89323726`, then merges main `95387a4e`. The merge preserves the complete Pattern and Express implementations,
reserved ADRs, catalogs, package exports, audit entries and installed-consumer hooks alongside Next. The Next runtime
is unchanged from the frozen root-shape correction; other framework/scanner/runtime implementations come unchanged
from merged main. The root-shape slice passed 46 focused Next/package tests with zero skips before integration.

Production coordinator and CLI dispatch for framework packs remain open. The merge is a library foundation and
makes no framework effect or full-plan acceptance claim. Integration build, focused checks and fresh installed npm
consumer evidence are verified separately before handoff; no target application code is executed or installed.
No primary build, dogfood replacement, server restart or push is part of this integration.

## Next pnpm root-shape preflight — 2026-10-22

The follow-up on `codex/sentinel-next-patch-indent` preserves `c8c3f160` and validates every meaningful lockfile root
key before reading individual sections. Supported keys are plain, single-quoted or double-quoted simple identifiers;
unknown ordinary identifiers may remain inert configuration. Tagged, anchored, complex, escaped or duplicate root
keys and document directives are refused conservatively. Patch-head detection consumes those normalized roots,
rather than a separate spelling-specific search. No YAML dependency is added; the pack revision advances to 7.

A captured tagged `patchedDependencies` key reproduced the identity bypass on frozen `c8c3f160`; the existing YAML
parser confirms it names the same map as an ordinary key. An original ordinary-config/unrelated-patch fixture keeps
its measured peer identity. Focused checks also cover quoted known sections and unsupported root/document forms.
No target code is executed. Independent review remains required before integration or publication.

## Next pnpm modification-metadata key follow-up — 2026-10-22

The follow-up on `codex/sentinel-next-patch-indent` preserves `464c6734` and reads package metadata field names as
plain or quoted identifiers. A `patched` field in either form refuses the measured registry identity; escaped or
unsupported key forms are unknown instead of silently ignored. Ordinary quoted `engines` and `hasBin` metadata
still qualify. No YAML dependency is added. The pack revision advances to 6 to invalidate the earlier decision.

Actual capture/parse probes reproduced all three quoted/escaped modification-key failures on frozen `464c6734`;
the existing YAML parser confirms each spelling means the same `patched: true` field. The ordinary metadata positive
passed that baseline. Final validation passed all 43 focused Next/package tests with zero skips, Sentinel build and
typecheck, catalog lint and diff checks. Target code was never installed, compiled or executed. Independent review
and integration remain with the coordinating owner; author, primary and integrating-owner trees are untouched.

## Next pnpm comment-boundary follow-up — 2026-10-22

The follow-up on `codex/sentinel-next-patch-indent` preserves `696d96fb` and makes the shared YAML block reader
ignore comment-only lines at every indentation. Two actual capture/parse probes reproduced the remaining defect on
that frozen head: a column-zero comment before the first patch entry, or between an unrelated entry and Next's entry,
truncated the map and incorrectly retained the registry identity. The existing YAML parser confirms both placements
preserve the same patch-map meaning. The pack revision advances to 5 so the old identity answer cannot be reused.

Comment-only declarations parse as YAML null and are conservatively unknown, while explicit empty maps remain
supported. New retained-source regressions cover both hidden-entry cases and that null-versus-empty distinction;
ordinary peer suffixes and unrelated patch positives remain in the focused suite. No target code is executed and
no author, primary or integrating-owner tree is changed. Independent review remains required before integration.

## Next pnpm patch-map indentation correction — 2026-10-22

Branch `codex/sentinel-next-patch-indent` follows reviewed patch-identity correction `c9972d84`. The lockfile reader
infers the direct-entry indentation of `patchedDependencies` instead of assuming two spaces, and skips each entry's
complete metadata block before reading its sibling. Relevant patches remain unknown; unsupported selector/map shapes
are refused rather than ignored. Ordinary peer suffixes and patches for unrelated packages still qualify. The pack
revision advances to 4 so prior analysis cannot reuse this changed identity decision.

Three original capture/parse regressions (one-, four- and eight-space patch maps) fail on frozen `c9972d84`.
Each corrected case checks both relevant-patch refusal and an unrelated-patch positive through retained bytes after
source removal. The original four-space probe is valid YAML: the existing YAML parser produces the same object as
for the ordinary two-space form. Target code is never installed, compiled or executed. Build, typecheck and catalog
checks passed; all 36 focused Next/package tests and both exact review probes passed with zero skips. Independent review and integration
remain with the coordinating owner; no primary build, graph replacement or push occurred.

## Sentinel offline advisory foundation rebased — 2026-10-22

Branch `codex/sentinel-osv-integration` rebases the independently reviewed advisory adapter from `30b618f1`
onto merged PR 145 (`5196dc70`), preserving PR 158's execution repair. Adapter source, sealed input reader, original
fixtures, tests and asset hook are byte-identical to that reviewed version. Integration retains both Pattern and
OSV catalogs, security/ADR sections, asset hooks and installed-worker checks; OSV is ADR 29 on this main branch.

Checked on the rebased source: Sentinel dependency-closure build and typecheck; 54 affected OSV, package, Pattern,
preview and actual detached-CLI tests, zero skips; 181 script tests, zero skips; catalog and exact-title lint.
The clean npm consumer validated eight typed exports, 19 schemas, 53 fixtures and cross-process storage. Actual
installed worker checks passed for Pattern (six original findings), OSV (one original finding), and both together.
The individual native qualification jobs select their own provisioned worker; both asset sets are always validated,
and the default local smoke still runs both workers. No image was acquired for these checks.

This is a mergeable adapter foundation, not full PR 12 completion: production scanner command/registry admission,
owner acquisition CLI and installed public-command acceptance remain integration work. Earlier fixed-source ingest
and browser evidence below belongs to its named head; this rebase does not alter parser/core graph behavior.
No primary checkout build, graph replacement or server restart occurred.

## Sentinel sampled-memory test — 2026-10-22

Branch `codex/sol-memory-test` changes only the bootstrap resource regression: the real parse and store now receive
controlled resident-memory samples just above and below the recorded grant. This avoids assuming a small parse
must grow process memory after allocation reuse or garbage collection. The refusal still checks the exact memory
error and absence of a publication; the neighbor checks successful publication. Runtime grants are unchanged.
Validation: dependency-closure build and all 10 bootstrap tests passed with no skips. Native platform metadata is
reviewed separately against the native CI evidence.

## Provider PR156 integration rebase — 2026-10-22

Branch `codex/sentinel-providers-integration` was rebased onto fetched main `5196dc70`, then includes the newer
merged Express foundation `95387a4e` through feature-branch merge `5dad0a61`. All reviewed provider implementation,
test/helper and provider catalog bytes remain identical to `979d7146`; policy-revision, per-call and budget-fence
corrections are unchanged. Conflict resolutions retain Pattern, Express and provider ADR/package map, catalogs
and exports. Incoming Express/Pattern implementations, rules, asset hook, packer and consumer are byte-identical
to main `95387a4e`.

The provider/package suites passed 35 tests with no skips on the byte-identical provider foundation before the
Express merge, using only original local mock endpoints. After the merge, affected dependency build/typecheck,
catalog lint and ten affected package checks passed, with no broad suite repeat. A fresh npm-only consumer
verified ten exports, 19 contract types and schemas, 53 fixtures, cross-process store reopen, 17 Pattern pack files
and actual installed Express capture/parse/analysis. Another installed-only consumer compiled all 27 named
provider types and verified durable uncertain-budget accounting and excess-reservation refusal without invoking
an endpoint. Exact existing PR and authored commit subjects passed lint.

No hosted/model request, model download, real keychain read, primary build, graph refresh, push or merge to main
occurred. This is the reviewed provider foundation. Trusted capability production, provider settings/selection
and public owner-CLI dispatch remain open. Ledger reconciliation is a host primitive; its owner command,
spent-receipt validation and coordinator fencing path are not supplied here. Live model/E5 qualification and
model-review orchestration remain separate gates. The integrating lead owns review and push.

## Sentinel provider transport integration — 2026-10-22

The independently reviewed model transport on `codex/sentinel-providers-integration` adds the opt-in Ollama and
OpenAI-compatible broker, exact provider/profile binding, bounded response parsing and a durable shared budget.
Input mutation across an asynchronous boundary, changed policies, operation identity collisions and uncertain
charges are covered by the final corrections. Integrated full build, workspace typecheck and catalog lint pass;
Sentinel has 446 passing tests and 32 explicit platform/opt-in skips. A clean npm consumer loads nine typed exports,
19 contract types/schemas and 53 fixtures and reopens the store across processes. Fresh fixed-source ingests against
main `2587eb16` match on every node/edge value and digest: 8,196 nodes, 17,054 edges, digest `b47eaf940580`,
22,785,052 graph bytes and 31,117,312 database bytes. Three inspected browser views have zero page errors, with only
existing missing design-image fixture requests. Test endpoints are local mocks; no paid provider request or live
model qualification occurred. Public model settings/dispatch and the model-review stage remain separate work.
No primary build, dogfood refresh or global install occurred; the validation server was stopped.

## Spring PR149 integration rebase — 2026-10-22

Branch `codex/sentinel-spring-integration` is rebased onto fetched main `5196dc70`, including the independently
approved balanced generic correction `a951674b` (rebased runtime head `1eb1f22e`). Every Spring implementation,
fixture and framework catalog byte is identical to that reviewed head. Conflict resolution retained main's Pattern
ADR, adapter, rule assets, packaging hook and installed asset verification alongside the Spring export and fixture.
Main's Pattern implementation and asset-hook bytes were checked unchanged; no OSV changes were present at this base.

Affected dependency build and typecheck, catalog lint and the exact existing PR title lint passed. Nine focused
Spring generic/inherited cases and ten package-boundary cases passed with no skips. A fresh npm-only consumer
validated nine typed exports, 19 contract types and schemas, 53 contract fixtures, cross-process store reopen,
17 Pattern pack files, and actual installed Spring capture/parse/analysis returning open, protected and unknown.
The existing broad suites were not repeated for this byte-preserving rebase. No primary build, graph refresh,
application execution, container invocation, push or merge occurred. Public Spring command integration and the
end-of-plan Java sample runtime gates remain open. The integrating lead owns review, push and merge.

## Spring generic superclass shadow correction — 2026-10-22

Branch `codex/sentinel-spring-generic-fix` follows reviewed Spring head `ff13168c`. Its type index now erases each
balanced generic argument group separately, preserving qualified member types between groups. Comments and quoted
annotation values cannot alter bracket depth. Both direct type resolution and inherited-shadow discovery share the
same erasure; unsupported spelling remains conservative. A captured nested helper named `AbstractHttpConfigurer`
therefore makes the configurer method reference unknown, instead of proving authentication from a helper that could
remove that configurer.

The original capture/parse regression and three neighbors failed on the frozen baseline; its harmless generic
inheritance neighbor passed. The corrected suite includes nested and package-qualified type paths, comment and
annotation delimiters, and retains the harmless positive. Sentinel closure build, typecheck, catalog lint and the
package-boundary audit passed. All tests capture and parse original Java fixtures; no target code is compiled or run.
Independent review and integration belong to the coordinating owner. No primary build or graph refresh occurred.

## Sentinel reporting integration — 2026-10-22

The reporting slice on `codex/sentinel-reports-integration` combines independently reviewed finding identity,
comparison, standalone HTML/Markdown/JSON/SARIF, redaction and owner-bound context placement. The final authority
correction passed separate SOL review: structural or copied pins, cross-capture placement and mutations of returned
artifact bytes cannot substitute evidence. The integrated build, workspace typecheck, schema check and catalog lint
pass; Sentinel has 449 passing tests with 33 explicit platform/opt-in skips. All 29 focused report checks pass without
skips, including the official SARIF schema and an offline browser with JavaScript disabled. A clean npm installation
loads 10 typed exports, 19 contracts/schemas and 54 fixtures; installed private/shareable report generation and
SARIF validation pass. Fresh fixed-source ingests against main `2587eb16` agree on every node/edge value and digest:
8,198 nodes, 16,956 edges, source digest `1a488ec22d7c`, 22,709,909 graph bytes and 30,998,528 database bytes.
Three fresh browser surfaces have zero page errors; only existing missing design-image fixture requests remain.
Private/shareable report screenshots were inspected. CLI/report dispatch, dispositions, application placement UI and
full scanner integration remain follow-on gates; this package does not complete the entire reporting plan.
No primary-checkout build or dogfood refresh occurred. The validation server was stopped.

## Sentinel scheduler merged; CLI integration — 2026-10-22

The canonical planner merged as [#144](https://github.com/zalos/farsight/pull/144), `a690cc99`, and scheduler as
[#147](https://github.com/zalos/farsight/pull/147), `2587eb16`. Scheduler acceptance includes independent SOL
review, 421 local tests with 32 explicit platform/opt-in skips, clean npm packaging, identical fixed-source graph
ingests against main, and the full native Linux process/container crash matrix at 20 repetitions with no
failures, cancellations or skips ([run](https://github.com/zalos/farsight/actions/runs/39803836156)).

Branch `codex/sentinel-cli-integration` combines the owner CLI, detached service, canonical planning and report
preview on that merged scheduler. The initial combined suite passed 481 tests with 32 explicit skips; subsequent
bootstrap retry and durable diagnostic corrections passed independent SOL review with 18 focused tests. Final
integrated checks and installed npm consumer validation remain in progress. The scanner and framework draft PRs
remain separate until their canonical command paths are validated; a library or worker test alone does not close
their plan gates. The [execution ledger](proposals/farsight-sentinel/execution-progress.md) records these boundaries.
No primary-checkout build, dogfood refresh or global installation was performed.

## Sentinel service reliability — 2026-10-22

Branch `codex/sentinel-cli-reliability`, based on `e0e7c547`: public retry/rerun accepts an ended admitted bootstrap, prepares a fresh child over its retained snapshot and credits no parent work as completed. Fatal errors after coordinator acceptance are retained in a private durable service journal, bound to store/run/current admitted plan and containing known catalog codes only. Wait, status and unfinished report read this diagnostic after restart; raw exception text is withheld.

Checks: Sentinel dependency closure build; `service-reliability.test.ts` (three regressions: partially published bootstrap through public retry/rerun after source changes; actual SQLite finalization failure across service/store restart; bounded diagnostics and copied cross-store refusal); existing `preview-slice.test.ts` (six tests), and `cli-preview-e2e.test.ts` (two actual CLI lifecycle/detached-service tests): 11 passed, zero skipped. No primary build, ingest, server or graph changes. Independent SOL review and integration remain open.

## Sentinel planner merged; pattern qualification in progress — 2026-10-22

The canonical planner merged as [#144](https://github.com/zalos/farsight/pull/144), `a690cc9`, after independent
SOL review and all eight final CI checks. PR 06 is complete; scheduler and CLI integration use its canonical
plans and coverage evaluator.

The pattern adapter is integrated on `codex/sentinel-pattern-integration` for draft PR/native Linux qualification.
It runs Semgrep 1.181.0 only in the pinned container, reads sealed capture copies, normalizes bounded results and
reports per-rule/file omissions explicitly. Local integration passed full build and typecheck, 350 Sentinel tests
(25 explicit opt-in/platform skips), 22 focused real-container tests with zero skips, core 404, scripts 181 and
catalog lint (3,825 entries). The clean npm consumer verified eight typed exports, 19 contracts/schemas, 53 fixtures,
cross-process storage and 17 shipped pattern assets. SOL independently reviewed input binding, diagnostics,
real-engine behavior and qualification workflow failure handling.

Fresh fixed-source ingests of runtime head `b7edd5d` against main `a690cc9` were identical in all node and edge
values: 7,906 nodes, 16,354 edges, source digest `6474c835ecc8`, 21,867,834 graph bytes and 29,835,264 database bytes
in both. Fresh front-door, Map and code-map screenshots were inspected with zero page errors; known fixture
design-image 404s remain on the first two surfaces. No primary build or dogfood refresh occurred.

The adapter remains unregistered. PR 10 is not complete until native amd64 qualification, scheduler/CLI wiring,
batching and actual installed-command acceptance pass. The scheduler, detached CLI, secrets scanner, offline
advisories and framework packs remain in implementation/review. SOL found secrets allowlist omissions and a
filename redaction channel; those findings must be closed before acceptance. npm release packaging prework is
underway; no release has been cut.

## Sentinel advisory integration; native qualification pending — 2026-10-22

The canonical planner merged as [#144](https://github.com/zalos/farsight/pull/144), `a690cc9`, after all eight
checks. The pattern adapter has a draft qualification PR [#145](https://github.com/zalos/farsight/pull/145);
its native amd64 diagnostic qualification test needs the explicit candidate-platform input before rerunning.

Offline advisories are integrated on `codex/sentinel-osv-integration`. The OSV-Scanner 2.7.0 adapter uses the pinned
official container and separately acquired, digest-bound advisory snapshots. Scans cannot fetch databases.
Missing, stale, refused and skipped inputs remain explicit. SOL verified the final refusal and comparison fixes:
a failed or partially listed counterpart cannot make an earlier finding appear resolved.

The integration passed full build/typecheck, 351 Sentinel tests (23 explicit opt-in/platform skips), 21 focused
real-container tests with zero skips, core 404, scripts 181, catalog lint (3,814 entries), and a clean npm consumer
with eight typed exports, 19 contracts/schemas and 53 fixtures. The installed OSV worker ran through the workspace
execution service and found the original synthetic advisory; that is not yet acceptance through the installed CLI.
Fresh fixed-source ingests at runtime head `c537e51` against main `a690cc9` agree on every node and edge value:
7,917 nodes, 16,387 edges, source digest `16f951b42b53`, 21,904,177 graph bytes and 29,835,264 database bytes in both.
Fresh front-door, Map and code-map screenshots were inspected with zero page errors; known fixture design-image
404s remain on the first two surfaces. No primary build or dogfood refresh occurred.

PR 12 remains incomplete until native amd64 qualification and production scheduler/installed CLI wiring.
Scheduler/CLI admission, receipt scope and crash durability findings remain under correction. Framework packs
are being checked for false protection claims. Release packaging remains prework; mandatory acceptance gates
must pass before publication, and no release has been cut.

## Sentinel policy merged; planner integration verified — 2026-10-22

Rules and adopted policy merged as [#142](https://github.com/zalos/farsight/pull/142), `074ee43`, after
independent SOL review and all eight final checks. The committed-tree Git header correction merged as
[#143](https://github.com/zalos/farsight/pull/143), `9a0fd21`, after SOL review and all eight checks.

The pure canonical planner passed SOL review through its final scope, input-binding, immutable-restoration
and coverage corrections. The combined integration on `codex/sentinel-planner-integration` passed full build,
workspace typecheck, 336 Sentinel tests (17 explicit opt-in/platform skips), catalog lint (3,776 entries),
and a clean npm consumer: eight typed exports, 19 contracts/schemas, 53 fixtures and cross-process store reopen.
Fresh fixed-source ingests against main `9a0fd21` agree on all node and edge values: 7,859 nodes, 16,318 edges,
source digest `0f4108351653`, 21,774,989 graph bytes and 29,679,616 database bytes in both.
Fresh front-door, Map and code-map screenshots were inspected with zero page errors; the fixture's existing
design-image 404s remain on the first two pages.
The planner establishes supported capabilities and exact tool version/image matching; execution-platform
qualification remains an admission gate. Required coverage comes from canonical coverage evidence, never
from a worker exiting successfully.

Scheduler integration must use that canonical plan and coverage evaluator, retain its plan and input artifacts,
and publish real bootstrap evidence. Detached CLI operation exists in an isolated implementation but still needs
the canonical planner, durable plan storage, promoted locks and policy-controlled service actions. Pattern
failure diagnostics passed independent real-container review; secrets and offline advisories are under
implementation/review. Spring registration, callback and inheritance edge cases remain under correction.
These later packages are not complete. The computer restart removed temporary validation artifacts; the
planner's comparison and checks above were recreated afterward. No primary build or dogfood refresh occurred.
## Sentinel driver boundaries — 2026-10-22

Branch `codex/sentinel-driver-fixes` starts from the scheduler's acknowledged-unknown scratch fix. The execution
coordinator now checks a selected driver's implementation digest against the executing registry and admitted unit
at open. One absolute unit deadline covers prepare, worker launch/run, normalize and durable publication; drivers
receive the combined cancellation/deadline signal and workers get only the remaining grant. Deadline refusal during
attempt-start storage releases a confirmed-stopped worker's scratch while a fenced epoch leaves recovery in charge.
The implementation is in `execution/check-drivers.ts`, `coordinator.ts`, `publication.ts` and `supervisor.ts`;
`execution-driver-boundaries.test.ts` and a focused container case cover the new boundaries.

Validated with Node 24 and pnpm 9: the four-package Sentinel closure build, 55 focused driver/coordinator/scratch
checks, 66 protocol/journal/native recovery smoke checks, and the focused pinned-container cleanup case pass with
zero skips. The 15 new native behavioral cases fail nine checks on the unchanged baseline and all pass with the fix.
The broader recovery matrix was not repeated. Independent review is still required; no selected-stage planning,
publication, push or merge is part of this change.

## Sentinel report-context authority — 2026-10-22

Branch `codex/sentinel-report-context-fixes` starts from the PR 19 report fix. A genuine pin now has private runtime
provenance anchored to its consumed owner grant. Direct placement and report/gap consumers require the exact
snapshot and source; copied fields, serialized receipts, prototypes, proxies and pins from another capture cannot
place findings. Report placement checks observation/citation identities too, and invalid contexts do not enter
its artifact closure. Artifact byte access returns copies so caller mutation cannot alter retained provenance.

The changed code is in `reports/context.ts`, `place.ts`, `document.ts` and the report export, with one catalog reason
for a different capture/source. Six new actual-consumer tests accompany the existing report tests. The five-package
build and all 40 focused report/comparison and original independent checks pass with zero skips, including official
SARIF validation and the offline JavaScript-disabled browser/print case. Independent review is still required.
No model, CLI, driver or application graph behavior changed.

## Sentinel parser merged; rules and policy integration — 2026-10-22

PR [#141](https://github.com/zalos/farsight/pull/141) merged at `500351c` after all ten final CI checks and
independent SOL review. Integration passed 266 Sentinel tests (17 explicit opt-in skips), core 404, all 181
script tests, full build/typecheck and catalog lint. Clean npm consumers compiled the parser API and reopened
the store across processes. A fixed-source ingest against main `464da4e` was identical: 7,637 nodes, 15,950
edges, source digest `372c3fc9fce5`, 21,209,802 graph bytes and 28,880,896 database bytes. Three inspected
browser pages had zero page errors; the fixture's missing design-image responses remain.

Rules and policy passed independent SOL review, including bounded pack reads, immutable promotion intent,
receipt consumption, adopted policy and exact lock resolution. The combined integration passes 297 Sentinel
tests with 17 explicit skips and a clean npm consumer with seven typed exports, 18 contracts/schemas and 51
fixtures. The deterministic planner remains in review: undiscovered surfaces and mutable trusted views must
not erase required coverage. Scheduler recovery, detached CLI operation, pattern input binding and Spring
registration/matcher semantics remain under active correction. A committed-tree capture header compatibility
fix is separately under review. These partial implementations do not complete their later plan gates.

No primary-checkout build, dogfood refresh or global installation was performed.

## Sentinel capture and isolation merged; parser integration — 2026-10-22

PR [#139](https://github.com/zalos/farsight/pull/139) merged at `625a920`, and capture
[#140](https://github.com/zalos/farsight/pull/140) at `464da4e`, each after all eight final CI checks and SOL review.
Capture integrated with isolation passed 252 Sentinel tests (17 explicit opt-in/platform skips); dedicated Linux
isolation passed without skips. Fresh fixed-source ingests against main `625a920` were identical: 7,426 nodes,
15,542 edges, source digest `77c0b7cf871d`, 20,644,581 graph bytes and 28,110,848 database bytes. Fresh front-door,
Map and code-map screenshots were inspected with zero page errors; fixture design-image 404s remain.

Parser reconciliation and its complete portable artifact types passed SOL review, including independent UTF-8
span probes and a strict external TypeScript consumer of the actual tarball. The permanent npm smoke installs the
package and compiles its parser types. Integration on capture plus isolation passed 266 Sentinel tests with the
same 17 explicit skips. Rule/policy mutation and resource-bound findings are fixed and independently verified;
its integration passed 297 tests with the same skips. Their PR acceptance remains in progress.

Scheduler and CLI review found additional recovery, durable-state, resource-limit and transport-boundary gaps.
Opus is addressing them before acceptance; the existing kill matrix alone does not close those findings.
Planner integration, the original Spring source pack and the pinned pattern adapter proceed in separate worktrees.
No primary-checkout build, dogfood refresh, or global installation was performed.

## Sentinel isolation qualified; capture integration — 2026-10-22

PR [#139](https://github.com/zalos/farsight/pull/139), branch `codex/sentinel-isolation-integration`, passed SOL
review and real-container qualification: 92 local Docker Desktop tests and 82 Linux CI tests, zero skips in
those dedicated runs. Linux used Node 24.21.0, Docker Engine 28.0.4, Ubuntu 24.04.5 LTS and cgroup v2;
[the run](https://github.com/zalos/farsight/actions/runs/39728679640/job/119658477459) measured CPU throttling and
file-size enforcement as well as cancellation, networking, ownership and cleanup faults. The final qualification
commit still needs its CI and merge. Full local build/typecheck, core 404 and Sentinel 203 passed (17 explicit
opt-in skips in the ordinary suite); catalog and CI-selector checks passed. A fixed-source ingest against main
`65d925e` was identical: 7,397 nodes, 15,495 edges, source digest `c5aaf4d32a8f`, 20,502,192 graph bytes and
27,947,008 database bytes. Three fresh browser views had zero page errors and inspected screenshots.

Capture's final shared memory budget passed independent SOL review and 37 focused tests, including zero retained
reservations after capture failure and retry. Integration validation continues. Parser span and declaration fixes,
rules/policy review, deterministic planning and scheduler implementation proceed in separate Opus worktrees.
No primary-checkout build, dogfood refresh, or global installation was performed. Production adapters remain
unregistered; uncertain container cleanup remains explicit for scheduler recovery.

## Sentinel shared matcher merged; npm consumer requirements — 2026-10-22

PR [#137](https://github.com/zalos/farsight/pull/137) merged at `2df3dc2` after Opus implementation, SOL review
and all seven selected CI checks. The pure matcher moved into core with Work retaining the same export and
function identity. A fixed-source ingest against main `9877a22` was identical: 7,235 nodes, 15,161 edges,
20,062,632 graph bytes and 27,320,320 database bytes; source digest `f9bf44740a93`. Fresh front-door, Map and
code-map screenshots were inspected with zero page errors (fixture image 404s on the first two surfaces).
Full build/typecheck and affected core/Work suites passed. Primary checkout and dogfood server were untouched.

Capture and isolation remain under review; parser integration and rules/policy work have started in separate
Opus worktrees. Their full gates remain open. The consumer documentation now requires Node 24 and leads with
npm installation of a pinned GitHub Release tarball, without pnpm or a checkout. PR 09 explicitly owns Sentinel
initialization and repeated setup preserving configuration. Clean global-prefix consumer verification, both
release artifacts, final Fable review and the Java/Spring sample remain release gates.

## Sentinel PR 03 merged; capture and isolation continue — 2026-10-22

PR [#134](https://github.com/zalos/farsight/pull/134) merged at `269c3bc` with all nine CI checks passing.
The integration branch `codex/sentinel-store` adds the optional store facade, separate lifetime owner lock,
fenced SQLite ledger, checksummed migrations, immutable objects and conservative reachability inspection.
Four isolated Opus lanes implemented ownership/runtime, ledger/migrations, objects/reachability and the public
facade/packaging. SOL independently reviewed all four and verified each reproduced finding's fix.

Final local validation: full build and type checks; 135 Sentinel tests passed with three explicit platform or
permission skips; 1,615 other package tests passed with two opt-in tracker skips; 179 script tests passed after
updating the packer's stand-in to the final API (the ten packer tests were rerun). All 345 browser/MCP tests and
11 small performance checks passed. Catalog lint checked 3,612 entries; draft schemas stayed unchanged. Clean npm
consumers verified all three typed exports, nine contract types/schemas, 36 fixtures, shared root/store API and
error identities, and publication followed by reopening in another process. Farsight also installed, ingested
and served with Sentinel entirely absent. Exact macOS ARM64/SQLite pairs 3.53.3 and 3.53.4 were measured on APFS;
Linux x64/SQLite 3.53.4 was measured on Node 24.21.0/ext4 in
[CI](https://github.com/zalos/farsight/actions/runs/39723522049/job/119642215934): 134 passed, four explicit skips. Linux exposed two test-fixture portability
issues (argument length and immediate inode reuse); Opus reproduced and fixed both, and SOL verified the fixes.
The final qualification commit passed all nine CI checks; [#135](https://github.com/zalos/farsight/pull/135)
merged at `97ff419`. PR 04 and PR 07 implementation and independent reviews continue; PR 06's pure matcher
extraction is being prepared. The later Java-build and owned-sample runtime designs are reviewed, but their
implementation and empirical gates remain pending.

The same frozen source against main and feature builds produced identical 7,175 nodes, 15,066 edges and source
digest, with unchanged database size; the PR body records byte counts. Fresh front-door, Map and grouped code-map
pages had zero page errors. No primary-checkout build, graph refresh or global install was performed.
Reachability remains inspection/dry-run only; no scanner or automatic deletion is enabled. PR 04 capture and
PR 07 isolation run in independent Opus worktrees against the reviewed store API. See the execution
ledger for remaining acceptance and release gates.

The PR 03 squash message accidentally omitted the assistant co-author trailers although its branch commits
retain them. Its PR description has been corrected; protected history was preserved. The trailer-only agent
count does not recognize that squash commit. Future PR bodies and explicit squash messages carry the trailers.

## Sentinel PR 02 foundation validated — 2026-10-22

Branch `codex/sentinel-foundation` adds the optional Sentinel package with nine draft contract envelopes,
generated schemas, bounded validation, catalog-backed help and explicit unavailable analysis capabilities.
Sentinel remains a separate tarball; Farsight imports no Sentinel code. Packaging now follows actual workspace
dependency closures and stages artifacts before replacement, including refusal when npm exits successfully
without writing a tarball. The new `sentinel-package` CI job checks clean npm consumers with Sentinel absent,
present but unbuilt, and independently installed with its public types and schemas. ADR 18 records the boundary.

Opus implemented the package, packaging and execution ledger; two SOL review lanes independently verified the
fixes. Their final reviews cleared all reported blockers, including newline path traversal, bounded validation
errors, core Counted compatibility, canonical graph IDs, calendar/nanosecond timestamps, policy consistency,
decision expiry, dependency selection and prior-artifact preservation. Contracts remain `draft-1`; scanner,
ledger, model and UI support are not claimed by this foundation.

Integrated validation: Node 24 build and type checks; 1,643 package tests passed with two opt-in skips before
the final Sentinel-only timestamp fix, then all 30 final Sentinel tests passed; 178 script tests; generated
schemas and catalog lint (3,547 entries); actual clean npm package checks (nine contract types, nine schemas,
36 fixtures), both Farsight isolation cases, and Echo's installed-package smoke. All 345 browser/MCP tests
and 11 small performance checks passed. Main/feature real-ingest comparison and viewer checks are recorded in
the PR description. The primary checkout, dogfood graph and global installation were not changed. The original
Claude reviews remain byte-identical. PR 03 storage is next; the complete remaining plan and end gates stay in
the execution progress ledger.

## Sentinel execution continues — 2026-10-21

PR #133 merged at `ef5c525`. The owner continued execution and accepted PR 01's bounded matrix and resource
defaults **for implementation** only; nothing measured as a prototype becomes general engine, framework,
platform or deep-analysis support. PR 00/01 are done, PR 02 is in progress, PRs 03–30 (with 23a/23b/25b) are
pending. Remaining deferred items are implementation/release acceptance gates, not new permission gates for
authorized reversible work. The durable status table, owner-directed roles (Opus implements, SOL reviews,
a final Claude Fable 5.1 touch-up review fixed by Opus and verified by SOL), the captured stage
configuration/I-O/rerun/model-choice/visual requirements and the end gates (Java + Spring sample app,
npm-only consumer install → help → init → scan → report, release) are in the
[execution progress ledger](proposals/farsight-sentinel/execution-progress.md). Settled by the lead: npm-only
installs use the GitHub Release tarball URL (registry only if configured at release); initialization means
instructions over Farsight's existing install/config/ingest/serve path plus a Sentinel flow designed in PR 09;
the Java + Spring sample is original. Resolved since: retention
windows are explicit-prune eligibility, never automatic deletion in v1; the final reviewer is the installed
`fable` alias. Pending live-evaluation configuration (not an implementation or deterministic-release blocker):
a second model — only `qwen3:4b` is local — or a hosted endpoint with a spend cap for PR 22's evaluation
(two models × 30 cases × 5 trials × 2 variants: 300 clean plus 300 paired canary evaluations, 600 total). PR 29/30 runtime testing stays on the synthetic/sample local app only. This change is
Markdown/JSON documentation only; no builds or tests ran locally for it, and CI selection is unchanged
(`feasibility-decisions.json` is an unknown path, so CI selects every check); the two original Claude reviews are unchanged.

## Sentinel PR01 measured decisions — 2026-10-22

[PR #133](https://github.com/zalos/farsight/pull/133), branch `codex/sentinel-decisions`, continues merged #132 (`2bd38f6`) with original engine, framework and
runtime/resource experiments. Claude CLI implemented framework apps/drivers; SOL lanes implemented and
cross-reviewed engine/runtime/acquisition/lifecycle controls; the lead integrated, reviewed and ran final
measurements. [The acceptance record](proposals/farsight-sentinel/feasibility-acceptance.md) links the proposed
matrix/resource defaults, immutable evidence and remaining gates. Owner acceptance followed on 2026-10-21 (above).

Both evaluated engine profiles pass the bounded direct/local criteria but fail cross-file qualification.
Semgrep is the proposed scoped pattern default. Four original framework apps pass 11 scenarios/14 expected
responses at `74eec66`; all 14 owned dependency/app containers were removed. The final four acquisition tags
were removed non-forcibly and their image IDs confirmed absent; earlier Claude acquisition images remain
separate historical resources. Runtime evidence passes 14 controls, seven container cleanup checks and 54
codec trials; only the actual Mac ARM64/Docker Desktop combination is proposed. Advisory database semantics,
full crash recovery, general engine accuracy, production framework packs and other platforms remain open.
Scan/stage configuration, inspectable I/O, linked reruns and visuals remain PR25; model selection is PR25b.

Validation: 154 integrated script tests pass. Product build/type/schema, 1,615 package tests with two live
skips, catalog lint, Echo smoke, 345 browser/MCP tests and 11 small perf checks passed before the final
experiment-only changes; required PR CI checks validate the final submitted revision. Claude's independent
source review and cleanup re-review report no remaining actionable findings. Original reviews/history are
unchanged; retained failures include a rejected false-success result. All builds/tests used isolated worktrees.
The first CI run passed product/browser/package checks but exposed seven Linux AMD64 script-test failures
from mixed real/simulated host metadata; the follow-up corrects only synthetic fixture identity and keeps the
measured harness unchanged. No primary build/test, dogfood refresh, global install, model/provider trial or
production Sentinel package. The primary checkout's existing editor-settings edit is preserved.

## Sentinel PR 01 first implementation slice — 2026-10-21

PR #132 review follow-up on `codex/sentinel-feasibility` tightens platform refusal, network-denial evidence
and symbol attribution, makes silent parser omissions explicit unknown coverage gaps, and retains scrubbed
probe exceptions. Two SOL lanes implemented the fixes; the lead reviewed and reran actual measurements.
The [follow-up evidence](proposals/farsight-sentinel/evidence/2026-10-21-review/index.json) preserves the
earlier records. Local E1/E4/E8 again passed 78/12/30 controls. The final scanner rerun passed 66 scenario
and four run controls with all nine containers removed. A retained failed trial shows the pinned Opengrep
binary cannot launch its version command with `noexec`; only that candidate has a fixed `exec` exception,
disclosed in preview/results. Semgrep retains `noexec`, and neither has a host fallback. This is a measured
experiment limitation, not accepted production isolation. Complete PR 01 acceptance remains open.
Follow-up validation passed build/type checks, 1,615 package tests (two expected live skips), 79 script
tests, string lint, Echo package smoke, 345 browser/MCP tests and 11 small perf checks. Claude CLI's final
source review reported no remaining actionable findings; the lead verified literal fixture spans and
executed measurements. Original review files and earlier evidence are unchanged. Isolated dependency
installation refreshed shared Git hook metadata but did not build or test the primary checkout.

PR #131 merged at `0cb2d34`. Branch `codex/sentinel-feasibility` adds inert reviewed fixtures, draft
manifest/effect preview, bounded parser/SQLite/codec probes and explicit container-only scanner trials.
The [results and decision record](proposals/farsight-sentinel/feasibility-results.md) links retained synthetic
evidence, the failed initial scanner attempt, corrected measurements and remaining acceptance gates.
No production Sentinel package or public contract exists. This is a validated first PR 01 slice; the complete
measured-decision gate remains open and PR 02 is not dispatched. Framework support, corpus/threshold
acceptance, engine selection, terms and resource defaults remain unresolved; model work stays independent.

Three SOL lanes implemented and cross-reviewed the work. The lead fixed shared labels/formats, integrated
commits and ran actual trials. Local E1/E4/E8 passed 78/12/30 controls. Semgrep 1.181.0 and Opengrep 1.31.0
both found three SQL-concatenation symbols and no safe siblings under two original rules; oversized files were
explicitly skipped on exit zero and missing-rule files failed with diagnostic/exit 7. The denied-network control
and exact-owner cleanup passed. These narrow trials do not establish deep security or framework capability.
The acquisition record pins Linux arm64 containers and the binary; no scanner ran on the host or used network.

Validation: Node 24 build, type checks, 1,615 package tests (two expected live skips), 70 script tests,
string lint, Echo package smoke, final 345-test e2e and 11-check small perf suite passed. An initial e2e run's
build-currency and navigation failures passed the stable rebuild, focused rerun and full rerun; see the results
record. Original Claude review files are unchanged. All builds/tests used the isolated implementation worktree;
no primary-checkout build, dogfood refresh, global installation or provider trial. The primary checkout remains
on main with the pre-existing editor-settings edit preserved. PR 25/25b now explicitly require scan/stage
configuration, pinned inputs/outputs, visual progress, linked reruns/comparison and model selection.

## Sentinel review and execution preparation — 2026-10-21

Branch `codex/sentinel-readiness`, [PR #131](https://github.com/zalos/farsight/pull/131), prepares the next bounded implementation after reviewing recent main
`46018cb` with Claude CLI and SOL reviewers. Planning PR #118 is verified merged at `0c8c747`; no Sentinel
implementation has started. The owner confirmed Linux containers for external scanners with no host fallback.
This settles that policy question; exact runtime/engine/framework support and deterministic thresholds still
require measured PR 01 evidence. Models remain an independent track.

The [execution readiness packet](proposals/farsight-sentinel/execution-readiness.md) assigns three SOL lanes:
corpus/protocol, harness/parser, and storage/resources. The lead owns shared formats, integration, review and
the definition of done. Evidence preparation alone cannot complete PR 01 or release PR 02. Next implementation,
when dispatched, starts with the bounded feasibility work and proceeds only through its applicable gates.

Plan adjustments cover parser ignore selection versus independent security inventory, declared validators and
API reconciliation versus runtime enforcement, optional-package preflight, actual PR 01 CI selection, and
rechecking placement helpers at PR 19. Both original Claude reviews are preserved. Current changes are ordinary
Markdown; validation covers links, fences, whitespace, title conventions and affected-check selection, not
Sentinel runtime behavior. No build, scanner/provider trial, package publication, merge or dogfood refresh is
part of this preparation. The primary checkout and its existing editor-settings change remain untouched.
Validation passed 38 local links/one anchor across the five current Sentinel documents, balanced fences,
whitespace and the exact PR-title lint. The selector chooses no runtime suites for these six Markdown files;
it selects all runtime suites for the future feasibility script. The original review files match the baseline
byte-for-byte. Claude's source review and SOL re-review support preparation; PR 02's concrete preflight fix
is an explicit acceptance requirement, not a claim that optional Sentinel packaging already works.

## Sentinel owner report imports — 2026-10-23

Existing-run MCP controls merged as #167 (`919e26c6`) after independent review and all eighteen selected checks,
including installed scanners and full twenty-repetition recovery. The historical unidentified native exits remain
an unresolved release gate; passing observations do not establish their cause.

Branch `codex/sentinel-import-integration` integrates approved owner import runtime `10c1e902` and final test-only
follow-up `87d21397` with current MCP contracts. Independent final integration review approved `41897d55`.
Owner `evidence import/read/list/abandon` uses real local ownership, executed retained source, exact candidate
confirmation and atomic accepted-root publication. ADR 47 describes fixed owner-local disclosure, whole-document
privacy, limits and the honest spent-receipt interruption window. A running service returns busy; live-service
imports and browser confirmation remain required follow-up work.

Complete build, Sentinel typecheck, generated schemas, 4,504 catalog entries and seven workflow controls passed.
Affected tests: 200 passed, zero failures and one intentional inverse unqualified-host test skipped on the qualified
local host. The exact 1,202,824-byte installed tarball (SHA-256
`15fb1d570ec62c992a6560525a2b895072885d800e85c8f3d1de8ad3f6e24d6b`) passed the npm-only import journey,
source-removed readback, busy/natural-release, exact predecessor transfer and explicit abandonment. Deterministic
interruption uses a separate matching built-private after-stage hold and real SIGKILL; this is not npm-only crash
qualification. Native current/baseline/selected secret-privacy passed on the independently reviewed author candidate;
fresh selected CI on the final integrated candidate remains required. The first #168 CI run found one stale
MCP test expectation in service and full validation: it compared the closed twelve-value control vocabulary with
all sixteen CLI outcomes after imports were added. SOL reproduced the failure, pinned the explicit control set and
added valid-base refusal cases for the four import-only outcomes. The complete eight-test control file and adjacent
CLI outcome test pass; the final valid-base assertion passes its named test. Independent Claude review approved the
test correction; runtime/schema and prior installed-artifact evidence are unchanged. Original failures are retained.

Main `919e26c6` and import runtime built at `f0ab28cd` (documentation/package-selection edits were uncommitted at
build time) ingested the same 1,779 files frozen at `41897d55`: identical 10,228 nodes, 21,320 edges, source digest
`892e0d69248a` and 39,657,472-byte databases. Graph bytes were 28,877,495 → 28,877,500, solely build/run metadata.
Three fresh front-door/Map/code-map screenshots were inspected: zero page errors or failed requests, with five
existing missing-fixture-image 404s and their console messages. The isolated server was stopped and its port cleared.
The primary checkout, global installation and dogfood graph were untouched.

SOL continues durable preparation, genuine finding-bound owner decisions and the bounded original cookie proof.
Saved configuration, real browser confirmation, full stage I/O, model selection/evaluation, Fable review, original
Java/Spring container acceptance, npm initialization and release remain explicit plan gates.

## Parser and CLI gap delivery — 2026-10-21

Seven independently reviewed changes close the parser and CLI gaps: API delivery policy, raw test-server
exclusion, explicit guard and multipart vocabulary, wildcard design fallbacks, stale configuration
declarations, retained project test evidence, and packaging prerequisites. The raw route/contract evidence
remains inspectable. Paired parser libraries are prepared at 0.3.1. Public class methods were already
supported; optional interface graph nodes remain deferred. MCP build reporting, graph refresh and tagged
release artifacts were already delivered.

Validation on the final combined runtime in isolated worktrees under Node 24/pnpm 9: build and all
typechecks passed; 1,617 unit tests completed with 1,615 passed and two opt-in live tests skipped;
345 browser/MCP tests, 22 script tests and all 11 small-preset performance checks passed. Catalog lint
checked 3,490 entries. Echo package smoke and actual parser tarballs installed outside the workspace
passed. Independent re-review covered the reporter path, dynamic-suite identity and source-level fixes.
A separate Echo follow-up uses joined request arguments so valid handles beginning with a dash reach
polling and cancellation commands intact; a deterministic regression covers both commands.

Fresh main/gap ingests of the same Farsight source retained 6,136 nodes, 13,216 edges and source digest
`5ec2c23dfc70`, with unchanged node/edge content. Graph bytes were 17,458,002 before and 17,457,996 after;
the six-byte difference is workspace/build metadata, not semantic growth. SQLite was 23,601,152 bytes
in both builds.

The reference validation retained sequential projects and joined all supported default-project cases.
Three report rows with unsupported dynamic case names remain unjoined; identity is never guessed.

Owners still declare source phases, internal routes, guard vocabulary and multipart readers. Unknown
phases stay missing; declared-only and inactive paths prove no enforcement. Aggregate run coverage never
becomes per-case observed coverage because another report says a case passed. Fresh ingest reads reports
on disk; separate result files preserve sequential projects across a fresh ingest. Registry publication
remains separate. Installing the CLI under all three runtime prefixes and restarting servers/reconnecting
MCP follows the final merge.

## Stale glossary, gate tiers and flow documents — 2026-10-21

Branch `codex/gap-stale-declarations` (dependent on the wildcard-route branch) extends existing ingest
warnings to unbound glossary names, unmatched gate tier keys and unreadable local flow document paths.
Glossary auditing uses the same class/member fallback and folder scope as label application; it does
not invent node-id matching. Remote document URLs are skipped. Local document paths retain their
source-root semantics; duplicate references within one flow produce one warning. Diagnostics name the
file and line (the first matching literal in the declaration file).

The parser build, parser typecheck and all 256 parser tests passed on Node 24. The mixed example
compatibility check explicitly expects its newly visible stale glossary and copied document references;
its baseline graph is preserved. Integration owns real-app measurement, the paired parser version
update and clean final browser checks. No installation or publication occurred.

## Raw test servers and wildcard UI pages — 2026-10-21

Branches `codex/gap-test-servers` and dependent `codex/gap-router-fallbacks` exclude raw HTTP route inference
in exact `testing` directories and `*.test-server.*` files, and list undeclared wildcard UI pages separately
from undesigned-page drift. Production inspection endpoints remain indexed. Both React Router `element`
and `Component` declarations remain supported. Wildcard page ids are unchanged; a manifest may claim them.

Node 24: builds, all typechecks, string lint and 18 targeted parser/design tests passed. The full unit run
hit an unrelated randomized Echo hook CLI request id beginning with a dash; Node rejected its separate
argument. The browser run passed 340 and failed five (build freshness, layout and gesture timing); concurrent
builds changed its build stamps, so a clean combined validation remains required. Real-ingest comparison,
public parser version update and final browser verification remain with the integration lead. No install
or publication occurred.

## Declared paths and parser release preparation — 2026-10-19

Branch `codex/declared-paths-ingest` adds ingest warnings for unresolved external class imports,
setup/plumbing declarations and decision affects. The shared collector honors source-root and nested
`.gitignore` files by default; explicit excludes still win and `--no-gitignore` / `gitignore: false` opts out.
Nest named body schemas now produce declared `validates` edges to methods and routes, with an explicit
note that runtime validation-pipe registration is unverified. Declared external classes also recognize
injected fields typed as the global `fetch`; a similar property name alone earns no binding.

The paired parser libraries are prepared at 0.3.0 with graph schema version 1 unchanged. External tarball
installation (native Oxc, Java WASM, public types, serialization and traversal) and publication dry runs
passed. **npm publication remains pending by owner direction**: scope access, initial publication and
trusted-publisher setup are still required. See [Parser libraries](PARSER-LIBRARIES.md).

Validation used Node 24 in isolated worktrees: build, all typechecks, full unit suites (1,592 passed,
two live tests skipped), targeted suites again after the final refinements, 20 script tests, string lint,
345 browser/MCP tests, 11 small performance tests, and the packaged Echo smoke. Against main `0c8c747`,
fresh ingests of the same source produced identical 6,126 nodes and 13,200 edge sets, with source digest
`96158ffec1b4`; graph bytes were 17,429,937 before / 17,429,932 after, and both SQLite files were
23,564,288 bytes. Fresh front-door, Map and code-map pages had no page or console errors; screenshots
were inspected. Existing primary-checkout editor settings were preserved. No npm publication occurred.

## Farsight Sentinel merge review — 2026-10-19

The owner requested review, fixes and merge of the remaining PRs, including planning PR 00
[#118](https://github.com/zalos/farsight/pull/118). The final review removes model acceptance from the
deterministic first-release/PR 01 gate and corrects parser reconciliation: the `missing` fingerprint can
represent a refused read, not only absence; missing candidates need captured directory/refusal evidence.
Both original Claude reviews remain unchanged. Outstanding container, version and threshold decisions stay
at their stated gates. This task merges the plan; it does not launch Sentinel implementation or scanner/model
trials. Validation: 61 local links/three anchors, one JSON and 13 TypeScript syntax blocks, nine SQLite
behavior checks and a real parser-reader probe passed; review files are byte-for-byte unchanged. No application
build or e2e is selected for this Markdown-only change. The earlier entries retain their dated pre-review state.

## Farsight Sentinel execution handoff — 2026-10-19

The owner requested updated memories and a kickoff prompt, not an agent launch. The shared entry point is
[Sentinel implementation kickoff](proposals/farsight-sentinel/execution-kickoff.md), linked from the plan and
backlog. This handoff is the canonical project memory for both providers; no cross-project preference or
provider-private memory change is needed for these Sentinel-specific facts.

Verified on 2026-10-19: proposal PR #117 is merged at `04c3c63`; PR 00
[#118](https://github.com/zalos/farsight/pull/118) remains open on `docs/sentinel-implementation-plan`.
The latest implementation-plan change before this handoff is `6a1d6d4`, including standalone delivery.
Its affected-check, commit and secrets gates passed; runtime jobs were skipped as appropriate for Markdown.
These checks do not establish implementation approval. No Sentinel implementation PR or execution agent has
started, and no merge, scanner/provider trial, application build, ingest or live-service change was performed.

Confirmed decisions: local first with a future hosted option; source-only TS/JS and Java/Spring first release;
optional Ollama plus a configurable hosted endpoint; standalone reports and Farsight integration over the same
pinned report document. Standalone reports carry readable application context, explanations and permitted
evidence and work without either product or the source checkout. Deterministic delivery stays independent
of model gates. Both Claude reviews remain unchanged.

Next eligible implementation is PR 01 after PR 00 agreement/dependency gates: the feasibility harness,
synthetic fixtures, capability/corpus decision manifest and measured results. The container requirement for
external scanners is still unanswered; ask before those probes, with no automatic host fallback. Exact
engine/framework/runtime pins, E3/E5 thresholds and resource defaults require PR 01 evidence. Continue
independent authorized work when one decision is pending; do not infer agreement from elapsed time or green CI.
The kickoff preserves these boundaries, the PR sequence, worktree isolation and affected-only validation.
The primary checkout and its existing editor-settings change remain untouched.

## Farsight Sentinel implementation planning — 2026-10-17

Branch `docs/sentinel-implementation-plan` has PR 00 open as [#118](https://github.com/zalos/farsight/pull/118),
against proposal PR #117 (`04c3c63`, authored as `354a184`; application baseline `4fce1c8`). The review draft is
`docs/proposals/farsight-sentinel/implementation-plan.md`, with PR backlog, code examples and implementation
review/response beside it. Both Claude reviews are preserved unchanged. The response traces every review
finding to a change and acceptance gate. PRs 01–20/23a/24–26 reach a deterministic CLI/MCP/GUI release;
21/22/23b/25b add model review independently; 27–30 cover differential selection/audit, isolated Java builds
and managed runtime analysis. The wave table assigns shared contracts/catalogs/CI to one integration owner.

Owner decisions for this draft: local first while preserving a hosted option; source-only first release with
isolated builds later; Ollama plus a configurable hosted endpoint. Exact framework releases, quality thresholds,
isolation/platform defaults and required-coverage policy remain review items. The proposed container prerequisite
for external scanners is awaiting the owner's answer; parsing/planning need none. The updated plan adds pinned
screen/journey/persona placement, deterministic MCP/UI ahead of model gates, shared grant-policy semantics,
trusted settings/example/ignore conventions, safe fixture names and opt-in expensive suites with early CI wiring.

The owner also confirmed that the report must be independently deliverable while fitting into Farsight.
The plan now requires self-contained offline HTML and readable Markdown/JSON from the same pinned report
document, including captured application labels, explanations, permitted evidence and explicit omissions.
PR 19 delivers this before the GUI; PR 25 checks integrated-view parity; PR 26 tests a recipient with no
product installation, source checkout or network. Standalone delivery is a confirmed requirement, not an
optional later export or a replay-bundle prerequisite. Renderer behavior remains planned, not implemented.

The original SQL probe tested duplicate publication and integrity only; it missed the second-revision defect.
The corrected composite-key example was executed under Node 24.19.0 / SQLite 3.53.3: nine behavior checks,
two work revisions/two publications, duplicate and cross-revision references rejected, foreign keys valid and
integrity `ok`. Documentation checks passed for 50 local links, one JSON block and 13 TypeScript blocks' syntax,
plus whitespace and unchanged review hashes. The initial plan commit `81d265a` passed CI's affected-check,
commit and secret gates; validate/e2e/echo-package were correctly skipped for ordinary Markdown.
These checks are not full TypeScript typechecking or Sentinel runtime validation.
No Sentinel runtime, scanner, model trial, application build/test, ingest,
installation or live-server change is part of this planning work. Implementation awaits review of PR 00;
the primary checkout and its existing editor-settings change are untouched.

## PR #119 review — 2026-10-19

Merged as `320ca5d` on 2026-10-19 after all required GitHub checks and both parser-package checks passed.

Review fixes on `codex/pr-119-review`, pushed to `feat/nest-routes`: Nest guard nodes are scoped to their
decorator declaration and argument, so equal names in different modules and factory calls cannot combine
unrelated checks. Guard resolution follows renamed barrel exports. Computed controller options are gaps;
controller version options and aliased/namespaced RouterModule mounts are reported. A method parameter that
shadows an imported handler no longer borrows its gates or coverage. Portable analysis and application exports
retain `meta.routes.gaps`. ADR 12 records the additive contract and its consumers.

Verified in isolated worktrees under Node 24: build and all typechecks; 1,587 unit tests passed, two opt-in live
tracker tests skipped; 20 script tests; catalog lint; schema drift check; actual parser tarballs installed and
exercised outside the workspace; 345 browser/MCP tests. The Nest suite now has 15 cases, including reproduced
review regressions; the portable-export test also retains each source's route gaps.

A separate `main` build at `04c3c63` and the reviewed build ingested the same repository from scratch directories,
excluding examples and prototypes: both produced 6,126 nodes and 13,200 edges, with identical node/edge fields
and source digest `96158ffec1b4`. Saved graph bytes: 17,691,608 / 17,691,603 (main / PR); SQLite bytes:
23,834,624 / 23,834,624. Fresh browser pages on the front door, Map and code map had zero page, console or HTTP
errors; screenshots were inspected. This source has no design manifest, so the Map correctly shows its empty
state; the e2e suite exercises populated journeys. The primary checkout, deployed servers, global installs and
dogfood graphs were untouched. Registry publication and acceptance
in the reference application's new host remain separate follow-ups.

## NestJS controllers as HTTP routes — 2026-10-19

Branch `feat/nest-routes` (worktree `.claude/worktrees/nest-routes-7f776a`; a detached `main` baseline worktree at
`../farsight-wt/nest-main-baseline` for the measurement, to be removed after the merge), PR title
`feat(parsers): read NestJS controllers as HTTP routes`. The reference app is moving its HTTP API from App Router
`route.ts` files into a NestJS host; Farsight read no TypeScript decorator, so every one of its handlers would have
left the route map, the drift gate, the journeys and the design status. The brief stays outside the repo.

`packages/code-parser/src/nest.ts` holds the framework semantics (the Spring `spring.ts` ↔ `index.ts` split);
`tsjs.ts` assembles: a class decorated with `@nestjs/common`'s `@Controller` gives one route per prefix × verb path
with **the id App Router gives the same endpoint** (a port is a moved location in `farsight diff`); `calls` route →
`Class.method` HIGH by the decorator; a body that is one `return handler(…)` makes the handler a route handler too
(guards and rules mirror, one hop) and stamps the method → handler call `via: 'delegate'`, which core `cellTwins()`
reads as one coverage cell, `graphToSpec` as one summary and `journeySummary` as one set of words; `@UseGuards` →
guard nodes, walked into `canActivate` when the class is in the repo; class docs read from the earliest of
decorators, `export` and `class`. Not read, each a named `meta.routes.gaps` entry (a new optional graph-contract field,
schema version 1 unchanged) and an `unsupported` library diagnostic: a non-literal path, `@All`, `@Version`,
`setGlobalPrefix`, `enableVersioning`, `RouterModule.register`; an `@entrypoint` that disagrees with the decorators is
recorded too (the decorators win). `reconcile().notes` says when a controller method is not named after its
`operationId` — never drift. React Router data mode's `Component:` key is read (second commit). The paired libraries
are 0.2.0.

Verified under Node 24: build, `pnpm -r typecheck`, **1,584 unit tests — 1,582 passed, 2 live-tracker skips** (ten new
in `parsers/test/nest.test.ts`), 20 script tests, string lint (3,480 entries), schema regenerated. Real ingest of this
repository with the `main` build (`04c3c63`) and this branch from scratch directories: 6,121 nodes · 13,199 edges on
both, 0 node ids or edge keys on one side only, 0 nodes changed, `sourceDigest` `1dd89463f21a` on both, `graph.json`
17,423,143 vs 17,423,144 bytes (the build stamp), `farsight.db` 23,556,096 on both; the branch graph served read-only
gave 0 page and 0 console errors on the front door, the Map and the code map. Nothing was installed globally and no
dogfood or reference-app graph was re-ingested: the reference-app session does that from its brief after the merge
(pack → install under both prefixes → restart → MCP reconnect), then checks that the dark-launch pair of ingests
agree on route ids, `contract.status`, guard and rule counts.

Left open, the owner's calls: `@Body({ schema })` → `validates` (not read); a non-literal path stays a gap rather than
a heuristic route by `operationId`; publishing `@farsight/code-parser` (`docs/PARSER-LIBRARIES.md`). Smaller: no
`examples/` fixture for a Nest host; mirrored handler guards carry no `resolution` (pre-existing); `@Controller({ host })`
is the empty prefix; optional and wildcard segments stay literal.

## Parser library review follow-up — 2026-10-17

PR #115 remains on `codex/parser-package-extraction`, now including main at `2ca7f2b` (PR #116).
The follow-up adds `GraphStore.toDocument()` and `farsight export` for saved, merged graphs: a validated
portable envelope preserves the named sources and their enrichment without application bookkeeping.
Both library READMEs distinguish this from the application's `graph.json`; ADR 11 records the boundary.
Portable parsing retains call-site occurrences, while application ingestion now requires
`ingestRepo(root, { occurrences: true })` to store them. Diagnostics identify truncated declarations by
path, line and node; exactly-at-limit is complete, omitted branches are not. Symlinks report one boundary
diagnostic, and cancellation does not masquerade as an adapter or read failure. The ESM-only contract and
the published declaration dependency on `@types/node` are explicit. Real export also exposed and fixed a
generated-schema error for nested test-project status literals, pinned by a regression test.

Verified under Node 24: build and package/e2e typechecks; 1,572 unit tests passed, with two opt-in live
tracker tests skipped; 20 script tests; string lint (3,480 entries); schema drift check; isolated parser
tarball installation on macOS/arm64; 345 browser/MCP tests; 11 small-preset performance checks. The full
unit/e2e run precedes only commit-trailer and documentation changes. After incorporating PR #116, the
rebuilt PR at `64397a3` and a separate main build ingested the same repository from scratch directories:
all 6,343 nodes and 13,536 edges were equal without removing fields, and both source digests were
`7895bca53311`. Saved graph / actual `/graph` response bytes: main 18,007,211, PR 18,007,207; compact JSON:
14,594,980 / 14,594,976; SQLite: 24,317,952 / 24,317,952. No occurrence fields were stored by default.
The real exported document validated with all nodes and edges. The front door, Map and code map rendered
with zero page, console or unexpected HTTP errors; known missing example design-image 404s remain.

Process correction: the original extraction built and tested in the primary checkout. Review work now
lives in its own managed worktree, with another worktree for the main baseline. The primary checkout is
back on main at `2ca7f2b` and rebuilt from main. This task's old feature-stamped e2e report was archived
outside the checkout and removed from the primary report location. The existing editor-settings change
is untouched. Follow-up commits carry the Codex co-author trailer. Running dogfood services, global
installations and the multi-source graph were not changed; their normal refresh follows merge. Final
GitHub checks and re-review belong to PR #115; registry publication remains separate.

## Parser library extraction — 2026-10-17

Branch `codex/parser-package-extraction`, including main at `056b9a6`, implements
`docs/proposals/parser-package-extraction.md`. The paired MIT libraries `@farsight/graph` and
`@farsight/code-parser` start at 0.1.0, independently of application releases. Graph types remain canonical;
core re-exports them. Farsight's parser composes the same Oxc 0.138.0 and Tree-sitter WASM 0.3.1 adapters and
retains configuration/enrichment ordering. Four pre-extraction fixtures pin TS/JS, Java, mixed and workspace
structure, resolution evidence and enrichment. New occurrence evidence survives relationship deduplication
and portable storage; application storage is opt-in after the review follow-up above. See
`docs/PARSER-LIBRARIES.md` for API, boundaries, tarballs and release instructions.

The portable instance API adds explicit selection, per-file outcomes, diagnostics, bounded local reads,
cooperative cancellation, immutable artifacts, and fingerprints of the bytes actually analyzed and resolution
inputs. Graph v1 has generated runtime validation, canonical serialization and independent traversal.
The low-level composition API preserves Farsight's legacy IO; its output is not the portable analysis cache key.

Local validation under Node 24: workspace build and typechecks, 1,564 unit tests passed (two opt-in live tracker
tests skipped), 20 script tests, string lint (3,477 entries), schema drift check, actionlint, 345 browser/MCP
checks and 11 small-preset performance checks. Final portable-only file-selection and public-type corrections
were followed by parser and compatibility reruns. Actual tarballs installed outside the workspace on
macOS/arm64, parsed TS/JS and Java, resolved every public TypeScript entry point without skipLibCheck, and
saved/reloaded/queried the graph in a separate process. CLI and Echo tarballs also built successfully.
Linux/macOS tarball CI and the repository's six required checks run on the PR.

Registry publication is separate: the owner must confirm npm scope/package access, bootstrap the two names
and configure their trusted publisher and `parser-libraries` environment before the manual provenance
workflow can publish. No npm publication, global install, deployed service or dogfood graph was changed.
Complete execution/taint analysis and an agent-stage scheduler remain later work.

## Farsight Sentinel proposal — 2026-10-17

Branch `codex/farsight-sentinel-proposal` adds a [security-scanning proposal](proposals/farsight-sentinel.md)
with execution/data contracts, scanner research, workflow research and repository-fit notes under
`docs/proposals/farsight-sentinel/`. Scope is documentation only; Sentinel is not
implemented. The first-release requirements are TS/JS and Java/Spring Boot, local parsing/storage and opt-in
model providers. Recommended architecture: optional extension, durable SQLite execution ledger, immutable
compressed source/evidence bundles, versioned rules, specialist scanner adapters and bounded agent review.

PR #115 merged at `4fce1c8` on 2026-10-17; the proposal and branch are re-pinned to that revision and consume
its `parseRepository()` artifact. The [independent review](proposals/farsight-sentinel/claude-review.md) is
preserved byte-for-byte; the [response](proposals/farsight-sentinel/codex-response.md) addresses findings
2.1–2.11 and records verified corrections. Revision covers parser/enrichment provenance, honest coverage,
licenses/offline effects, framework invalidation, deployment assertions, worker recovery and report identity.
Owner questions remain verbatim in proposal §9; experiments E1–E8 and the codec comparison belong to increment A
and were not run. Engine choice, resource budgets and retention defaults still need evidence.

Validation: relative document links and JSON examples checked; `git diff --check` clean; the six authored
proposal/response files and this added section contain no private names, prohibited site strings or absolute
home paths; review SHA-256 unchanged. Primary sources and code at `4fce1c8` were inspected, with a read-only
Node/SQLite version probe. No runtime checks are needed for these ordinary Markdown changes: no build, unit
tests, e2e, ingest, server restart or global installation ran. Work was isolated in the proposal worktree;
the primary checkout and dogfood runtime were untouched.


## PR #104 review and main refresh — 2026-10-17

PR #104 remains open on `codex/echo-live-model`. The review branch `codex/pr-104-review` merged main
at `4bb662a` in `8eea360`; the only conflict was this handoff, resolved by retaining both sets of notes.
Review covered the model setup routes, saved/running selection, hook session and workspace isolation,
cancellation, retention limits, and model ownership through cancellation. No blocking code findings remained.

Local validation on the merged runtime: `pnpm build`, `pnpm typecheck`, `FARSIGHT_LIVE=0 pnpm test`
(1,539 unit tests and 19 script tests passed; two opt-in tracker tests skipped), `pnpm lint:strings`, and
`pnpm e2e --workers=2` (345 passed). Desktop and narrow Settings screenshots were inspected. The subsequent
changes only document required checks and this review; `actionlint`, title lint and `git diff --check` passed.
The final pushed tip must pass GitHub checks before merge. Live model acceptance below is earlier evidence,
not a rerun during this review. No deployed services, global installations or dogfood graphs were changed.

Main already required validate, e2e, secrets and commits, an up-to-date branch, and admin enforcement.
The review added affected checks and echo-package to branch protection and pinned all six checks to GitHub
Actions. `docs/CI.md` describes the resulting requirements; unaffected runtime jobs still skip explicitly.

## Affected CI checks — 2026-10-17

Follow-up on the same branch: Codex and Claude must use Conventional Commits, Conventional Comments for PR/review
feedback, and a validated PR title preserved as the squash-commit subject. `AGENTS.md` is the canonical project
rule, imported by `CLAUDE.md`; the PR template reinforces it. Both providers' global instructions and shared memory
also record the user's preference. Scope remains optional, matching the spec; guidance is deliberately concise. PR #114's title is
`ci: run only checks affected by changed paths`.

Branch `codex/ci-affected-checks` adds a small path selector for validation, e2e and Echo packaging. Ordinary
Markdown changes skip runtime checks; packaged Echo docs still check packaging, and fixture Markdown remains
test input. Unit-test-only and e2e-only edits select their respective suites; shared and unknown inputs run all
checks. Secret scanning and commit conventions remain independent. PR title edits rerun the separate commit
workflow without cancelling tests. Publish detection no longer fetches LFS assets.

Local checks: `pnpm test:scripts` (19 passed), `actionlint` on the changed workflows, and `git diff --check`.
Replaying the docs-only `09bbb8f` push selects no runtime checks. Regression coverage includes PR merge-bases,
multi-commit pushes, deletions, renames into docs, unusual filenames and unavailable ranges. The workflow changes
themselves select the full checks on GitHub; individual test selection is deliberately out of scope. No runtime
build, deployment or live-server refresh is needed for this CI-only change. See `docs/CI.md` for the selection table
and local validation guidance.

The initial implementation at `f77fe86` passed all GitHub checks, including e2e and Echo packaging. A live PR-title
edit reran only commit conventions and left the original CI run uninterrupted. The subsequent instruction-only
follow-up is checked with the commit/title linter and `git diff --check`; the PR's cumulative workflow changes
still select the full CI checks on GitHub.

## PR #115 review (parser library extraction) — 2026-10-17

Claude reviewed `b074600` on a detached worktree under Node 24 beside a `main` build: build, typecheck, schema drift
check, 1,566 unit tests (two live-tracker skips), 20 script tests, 345 e2e, string lint and the tarball consumer
test all passed. Ingesting this repository with both builds from scratch directories gave byte-identical nodes
(6,332) and edges (13,510) apart from the new `occurrences`, the same `sourceDigest`, and zero page errors on five
viewer surfaces. Nothing blocks the merge; the review on the PR lists seven non-blocking findings, the two that
deserve follow-up issues first: Farsight's own `graph.json` does not validate as a `farsight-graph v1` document
(no `repo`, application-only `meta` keys), and occurrence evidence is stored and served with no consumer yet
(`graph.json` 18.0 → 26.9 MB, `/graph` +43 %, `farsight.db` +33 % on this repo). Process: the work was done in the
primary checkout, which rebuilt the dogfood workspace's `dist/` on the branch (4478 now reports RESTART into
`1044d4d`) and left it checked out on the branch; `AGENTS.md` now requires a worktree, a real-ingest comparison
against `main` for parser/core/store changes, an assistant trailer on every commit and an ADR per new boundary.
After the merge: check `main` out in the primary checkout, rebuild, pack, reinstall under both prefixes, restart
4477 and 4478 and re-sync, as for any pass.

## Echo model setup and configurable prompt research — 2026-10-13

- Work remains on `codex/echo-live-model`, PR #104, building on merged PRs #102 and #103.
- Model discovery/testing, running-versus-saved status, native Ollama context/retention controls and remote model configuration are wired into the real settings view. Setup checks and research share one process-level generation owner.
- `submind.hookResearch` defaults to `manual`; `background` explicitly enables prompt research and `wait` includes a compact sourced brief when ready within `hookWaitMs` (default 20000, bounded 100–60000). Settings and `configure --hook-research ... --hook-wait-ms ...` expose the choice. Timeout or insufficient context allowance returns a bounded session/workspace-bound handle instead of raw records. Refresh older workspace hooks once with `connect` for the longer timeout capacity; legacy definitions retain a short deadline. `brief` polls without inference; `cancel-brief` cancels; checked `memory.expand` actions read exact evidence. Jobs expire after five minutes and have bounded retention, no unbounded queue, retry deduplication and cancellation that retains model ownership until settlement.
- Repeated or exhausted searches now leave a permitted model decision for final synthesis, with an answer-only schema, checked citations and the original input/time limits. A hook whose handle cannot fit skips research before spending model work.
- Verified: workspace build/typecheck, `pnpm test` (including 234 Echo cases, plus the added legacy-hook deadline regression; live tracker cases remain opt-in), catalog lint, standalone package check, and 340 browser/MCP cases. Review covered stale settings cancellation, cross-session isolation, cached A/active B/repeated A supersession and tiny hook allowances.
- Live native Ollama acceptance: a prompt hook returned a 635-character handle in 64 ms; the configured model produced a cited brief in two model calls, one search and about sixteen seconds. Polling did not regenerate; the follow-up opened the exact saved evidence. The installed waiting hook also returned a sourced finding in about sixteen seconds within its 1200-character allowance; follow-up reads did not regenerate. Existing stored records remained unchanged.
- Memory capture, model-assisted writes/edits/deletes and shared-team authentication remain separate work. This iteration adds the intelligent search intermediary; it does not grant the research model write authority. Local private import receipts and live evidence stay outside tracked files.

## Echo sub-mind development round — 2026-10-13

Branch `codex/echo-submind`, based on `d6ff0c6`, implements the first bounded, read-only research path. This is
worktree validation, not a deployed runtime update. Existing live services and global installations were left alone.

- `packages/echo/src/submind.ts` researches the selected profile with off/mock/model modes, bounded searches,
  evidence, cumulative serialized model input, response size, age window and deadline. The optional configuration
  defaults to off. `ask` returns `echo-memory/v1` problem/fix/why findings with validated citations and typed
  `memory.expand` actions; `expand` rechecks scope and content revision without inference.
- `research-store.ts` reads the pinned agentmemory API and reports non-exhaustive coverage. `models.ts` supports
  native Ollama and a hosted/custom OpenAI-compatible gateway. HTTPS or an SSH loopback tunnel is preferred;
  literal RFC1918 HTTP requires explicit opt-in and refuses remote plaintext credentials. Configuration, CLI,
  private bridge, settings view, catalog strings, package map, security notes and setup docs were updated together.
- `submind-demo` uses a synthetic in-memory store without configuration, service, network or model. Mock research
  against a real store still requires that store. No real model, inference endpoint or memory engine was started
  during this round; model protocol checks used synthetic HTTP fixtures.
- Checks: `pnpm build`, `pnpm -r typecheck`, `FARSIGHT_LIVE=0 pnpm -r test` (1,395 passed; two live tracker tests
  skipped; Echo 145 passed), `pnpm test:scripts` (14 passed), `pnpm lint:strings` (3,137 entries), and `pnpm e2e
  --workers=1` (324 passed, isolated fixture ports). The Echo settings view was also checked at desktop and narrow
  widths against a synthetic fixture with no page or console errors. `pnpm pack:echo` and the bundled
  `submind-demo` passed with zero model calls and a successful evidence expansion.
- Left open: acceptance against a real configured model when compute is available; proactive curated hooks,
  capture and edits, the memory exploration portal, skills, caching, session/day quotas, team authentication and
  shared-service hosting. Installed hooks retain raw recall. Remote model support does not expose Echo itself as
  a remote service. Revisions detect content changes; they are not a durable history ledger. Full package runtime
  smoke was deliberately not run locally because it starts the memory engine.

## Current state — 2026-10-10

`main` is green. **The lanes round, its cleanup pass and swarm round 3's fixes are live** (items 15–18 below, PRs
#74–#97: the journey overlay is retired and the Map is the one place a journey is read, with a chrome that holds
still; the storyline draws as lanes; gates carry tiers and preconditions; every test number its scope and build
state wins the journey verdict; a tour and an ask answered from the graph; a PR gets its affected set; two syncs
compare; agents get tiers and budgets). Nothing is in flight. Echo (PR #84, item 17) merged on 2026-10-11 after its re-review; lane S (#99, in item 18)
closed the cleanup pass.

| | |
|---|---|
| build | **`0.3.0`** (GitHub Release v0.3.0, 2026-10-04, release PR #43 — close/reopen still needed without a `RELEASE_TOKEN`), workspace main at **`fb503d7`** after the outsider round and its fix round (PRs #101, #105–#111, #98, item 19–20), before that **`c5a5c7a`** after the lanes round, the cleanup pass, swarm 3's fixes, Echo and the space pass (PRs #74–#99, items 15–18 below) on the swarm-fixes round (#62–#73), the 2026-10-05 round (#53–#61), the Map clarity pass (#50–#52) and the journey-organisation pass (#45–#49) on top of the map-view, data-stores, map-pass-2 and code-map-performance passes (PRs #8–#42) |
| tests | **1474** on `fb503d7` — core 392 · work 65 · echo 170 · parsers 230 · work-fixture 18 · work-azdo 38 · work-jira 40 · mcp 75 · server 382 · cli 64 · e2e **337/337** (`map-keys` ⌘K flaked once under load) · strings 3434 entries · 74 modules; before the round: **1353** — core 366 · work 65 · echo 103 · parsers 216 · work-fixture 18 · work-azdo 38 · work-jira 40 · mcp 73 · server 370 · cli 64 (+ `pnpm test:scripts` 14), 0 failed, 2 skipped (the live tracker tests, opt-in with `FARSIGHT_LIVE=1`) · **e2e 324/324** (`journeys-organised`'s Map-head spec failed once under the full suite and passed alone — timing) (every spec that opened the journey page now opens a Map address) (the `codemap-projects`, `codemap-toolbar` and `settings-config` specs start their own two-source server; `journeys-organised`, `map-journey-links` and the small perf preset run in CI; `pnpm e2e:perf` is the full thousand-project table, on demand; the suite is timing-sensitive on a loaded machine — `settings-config`, `codemap-projects` where-is, `map-street` fold, `thousand-perf` ⌘K and `chrome` Settings each failed once under seven parallel lanes and passed alone) |
| string/symbol lint | **3105 entries · 35 sprite symbols · 70 modules** (60 retired view words left with the overlay); the define test bans backticks, markdown, unfilled placeholders and catalog keys; a catalog module per area (`strings-gate.ts`, `strings-evidence.ts`, `strings-stops.ts`, `strings-state.ts`, `strings-lifecycle.ts`, `strings-export.ts`, …) registered like `strings-doors.ts` |
| servers | the dogfood server on **4478** (workspace CLI) and the reference app's own `farsight` on **4477** (the global install under the Node 22 prefix, started from that workspace). **On 2026-10-14 both restarted on `fb503d7` and re-synced (4478 sync 73, 4477 sync 115 then restarted `--read-only`); both prefixes' global `farsight` print `commit fb503d7`.** Earlier: The `flags.map` and `journeyDrill` flags are retired (the Map always has its tab). Both restarted on `c5a5c7a` on 2026-10-11 and re-synced through `POST /api/sync` (4478 sync 72, 4477 sync 114, then 4477 restarted `--read-only`); both prefixes' global `farsight` print `commit c5a5c7a`; `farsight status` reads *up to date* on both; zero page errors on the front door, the lanes board in business, the compare panel, Settings, Changes, the readiness brief and the old-link redirect (`#/journeys/new-invoice?view=sheet&step=2` lands on `#/map/new-invoice?screen=2&layout=table`) of 4478. 4477 was started **without** `--read-only` so it could sync — restart it read-only before a swarm (a read-only server refuses `POST /api/sync`). macOS has no `setsid`: restart a server with `(nohup … &)` from its cwd and confirm `lsof` + `/api/version` before syncing. The reference app's own manifest declares two personas, six groups, placements on all 18 flows, two storylines and the correction journey as a **branch** of review; its design drift is **7**; it has no `gateTiers` or `lifecycle` block yet (see item 15's left-open). |
| runtime | Node 24 is under nvm (`nvm use 24`); the shell default is still 22 for the 4477 server, so every build/test shell runs `nvm use` first |
| trackers | a Jira test site and an Azure DevOps org, both reachable live on 2026-09-30 from a probe that reads the keychain in-process and prints only the outcome. Their names, accounts and credentials are kept outside the repo. |

**Live tracker tests** run only with `FARSIGHT_LIVE=1` and read their target from the environment:
`FARSIGHT_JIRA_SITE` / `FARSIGHT_JIRA_USER` / `FARSIGHT_JIRA_KEYCHAIN` and `FARSIGHT_ADO_ORG` /
`FARSIGHT_ADO_PROJECT` / `FARSIGHT_ADO_KEYCHAIN`. The defaults are the example values above, so without the env they
skip with a reason. The Jira test writes one comment and one label on the test site; the ADO test only runs
`validateOnly` dry runs. The recorded fixtures under `packages/work-jira/test/fixtures/` and
`packages/work-azdo/test/fixtures/example-org/` were recorded live and then re-synthesized with placeholder names,
ids, titles and bodies; the shapes are as recorded. A re-recording must be scrubbed the same way before it is committed.

## What shipped most recently

1. **The clarity phase** (2026-09-21 → 09-24): one count vocabulary and one denominator, evidence classes, deferred /
   setup edges, externals, interface-typed dispatch, Journeys as the front door — 56 chunks, measured on the
   reference app.
2. **The viewer usability pass + the visual swarm and its four fix lanes** (2026-09-24).
3. **MCP currency, e2e, fast travel, component stories** (2026-09-25). The header stays live while a journey is
   open; MCP reaches gates-vs-rules, per-node unit/e2e coverage, impact-tests, change history (`graph_changes`) and
   stories; Farsight has a Playwright e2e suite on the real server (**no MSW — ADR 8**) whose results appear in its
   own graph; ⌘K arrives somewhere visible; `farsight status` stops crying wolf on same-code builds; components
   embed their **live Storybook stories** (ADR 9). The pass swarm scored **6.3, 6× TRIAL**: nobody hit the header
   bug, stories were the best-received feature, and **one number, one scope** became the top complaint.
4. **Tooltips, one number one scope, and the business register's last code words** (2026-09-25, second pass).
   A tooltip primitive (`lib/tooltip.js`: click, 2 s hover, `?`; simple tips from the catalog's define, rich tips
   with tables and links; `numberTip()` = counts · over · from · breakdown · Grammar Book); a counts ledger
   (`docs/COUNTS.md`) reconciling every reviewer contradiction on the reference app's graph into typed `Counted`s
   from core; identifier tokens in the business register went to **0** on every view, held there by e2e specs; ⌘K
   matches identifiers in every register and shows business names. The **story swarm** (all eight personas) then
   asked *do I understand the reference app?* — mean **6.9, 8× TRIAL**; the weak answer is *where to go next* (1.9).
5. **The next-step story, first pass — evidence that agrees with itself** (2026-09-27): a passed declared e2e case
   is observed by its own declaration; one absence word per fact; defines in words; scripts are tooling; the glossary
   meets class members; five small fixes (drift tip, impact counts each test once, ⌘K arrives on the thing picked,
   RESTART compares builds).
6. **Work items as a source — Jira and Azure DevOps, live** (2026-09-30, six lanes, build `d6dace1`).
   Proposal `docs/proposals/work-items-sync.md` P0–P4 in one pass, centred on *what work changed what code*:
   - **`packages/work`** — `farsight-work v1` (frozen, `schemas/farsight-work-v1.schema.json`, enum-pin test), secrets
     resolved **in-process from the keychain** (`keychain:farsight/<provider>-<instance>`, never printed), the `work.db`
     cache (replace-never-merge items, SCD2 revisions, links, outbox, audit), the sync engine (cursor, hydrate, periodic
     reconcile, cached schema, freshness facts), the **three-verdict gate** (policy · tracker · credential, plus a dry run
     beside them when the provider has one; default deny; agents confirm through a person), the key detector (Jira
     `KEY-1` / `#KEY-1` / `[KEY-1]` / `…/browse/KEY-1`, ADO `AB#4711` / `#4711` / `_workitems/edit/4711`, branch names;
     only keys of a configured source's projects count — `INV-01` screen names never do), `farsight work
     sync|status|list|show|links|comment|assign|move|edit|link`. **`packages/work-fixture`** is the CI provider.
   - **`packages/work-jira`** (api-token, discover by `schema.custom`, `search/jql` + changelog bulkfetch + comments,
     ADF ↔ markdown, compare-before-write) and **`packages/work-azdo`** (PAT / az-cli, discover with state categories per
     type — *Resolved* stays in-progress, a state the type does not define is said so — WIQL + batch, the reporting
     revisions feed, comments on 7.2-preview, HTML ↔ markdown, `test /rev`, `validateOnly` dry runs). Both verified
     **live**: Jira 14 items, incremental after an edit, a comment through the gate, a conflict caught; ADO 4 items
     with history and comments, second sync via the feed, nothing changed on the org.
   - **In the graph** — `work` nodes, `tracks` edges, the `work-key` technique (enum pins and schemas grown by one member
     each); every sync indexes the **commit spine** (500 commits, incremental) with message bodies, branches whose names
     carry a key, and the keys themselves (`commit_key`, `commit_branch`, `commit_node`); a commit is credited to the
     function its changed lines start in; a `@work` doc tag joins `@covers`; settings `type: 'work'` sources are pulled by
     `/api/sync`; the `/api/work*` routes (list, item with links/commits/touched/findings/allowed/preview, `diff?sha=`,
     links-by-node, by-flow, sync, intent with dryRun/confirm/drop/rebase, outbox with `theirs`, audit, people, states;
     503 without sqlite).
   - **The HUD** — a WORK tab (*Bounty Board* / *Work*): source cards with mode, freshness sentence and capabilities in
     words; list/board/sources views; the item pane with assign, move to, comment, title and description under the gate
     (applied · waiting for your confirmation · conflict with both sides · denied with three verdicts); *what this work
     changed* — commits with how the key was found, files, the unified diff per file with the touched parts as chips, a
     *touched* count and *see what uses these*; findings (*done but its screen is not built*, *to do but N commits name
     it*); chips on Portfolio and journey headers; ⌘K travels to work nodes. **MCP** — `work_items` (json = the frozen
     list), `work_item`, `work_links`, `work_changes`, `work_sync`, and `work_comment|assign|transition|edit|label|link`
     **registered only when a source grants agents the action**; `graph_overview` gains a work-items section.
7. **The Map view — Neighbourhood · Street · Property** (2026-10-03, proposal `docs/proposals/map-view.md`, prototype
   `prototypes/map-view/`, two lanes plus two follow-ups each, PRs #8–#13). A flag-gated surface (`flags.map`,
   Settings → Experiments; a *Map* door on the Portfolio and a nav tab when on) that draws the journeys as one
   whiteboard with three altitudes: **neighbourhood** — every journey as a district in bands by source, row-packed,
   covers counter-scaled so names read at the fit, *leads to* / *requires* dimmed and *part of* on hover;
   **street** — one journey's screens in step order with a lean chip row, and with plumbing on (`p`) a **pathway per
   screen**: its calls stacked with a service colour bar (the spec title), beside each call the records, messages and
   third parties it reads (cool) or writes (warm), folds past four calls or four data nodes, declared-not-called and
   not-built drawn dashed; **property** — the screenshot whole as the hero (letterboxed, lightbox on click), a rail
   of eight tabs with the summary's own counts (Overview · Gates & rules · APIs · UX · Tests · Route · Work · Changes),
   clamped text, capped lists, a step bar with before / after / also-in, and a deterministic placeholder for a screen
   without a picture. Pan, pinch, ⌘-scroll and keys; snap into a screen past ×1.6 near the centre; one explore card
   for calls and data nodes. Everything reads `/api/design` and `/api/journey` (no server change; `lib/map-model.js`
   and `lib/map-property-model.js` are pure and unit-tested); every number is a `Counted` with a tip (`docs/COUNTS.md`
   § Map); ADR 10 (DOM in a transformed world, not a canvas). Verified on the fixture and, read-only, on the dogfood
   graph (21 journeys, a screen with 10 calls and 273 cases): zero page errors. What the real graph still shows:
   *leads to* curves cross between bands; names fall under 12 px past ~30 journeys at the cap; per-screen work chips
   are not fetched; the explore card has no Impact yet.
8. **Data stores — which store a record lives in, and externals the app uses as stores** (2026-10-03, later the same
   day; proposal `docs/proposals/data-stores.md`, PRs #15–#18). `GraphNode.store: StoreRef { name, kind: sql · document
   · files · erp · other, engine?, via: factory · sdk · datasource · jpa · config, ref? }` on table nodes and on
   store-like externals (`erp`, `db`, `files` by default; `ExternalDecl.store` overrides); rules in that order, never a
   guess (two SQL drivers → no store, with a note in `meta.stores`); `farsight.config.json` `stores[]` fills what code
   left unnamed and never overrides it. A declared client class gets **one `http` edge per public method** with
   `meta.method` from the literal on the path to `fetch`; `fetchMethod` no longer defaults to GET for a non-literal.
   **Fetch wrappers** (`apiFetch(path, init)`, two levels deep) resolve to their callers' paths and literal methods;
   an unknown method on a path served by several routes takes the GET route with `meta.methodAssumed` (MEDIUM, the
   seam card says *method assumed*, candidates recorded) instead of a stub. Journey markers carry `op` for externals
   (GET/HEAD reads, POST/PUT/PATCH/DELETE writes, else none) and `store`; `system.stores[]` and `counted.stores` are
   new. The map's street prints `<store> · record` / `<store> · ERP`, bars by store kind, `reached` (new mode, plain
   dim line) when no direction was recorded, stores in the legend, the store on the explore card, and the property's
   *Data this screen reaches* grouped by store; `describe_node` prints the store line. Measured on the reference app
   (read-only, in a scratchpad): all 21 tables named Postgres from the `pg` driver, the ERP an `erp` store with 14
   edges split GET · POST · PATCH · DELETE, Blob Storage a `files` store; http edges to routes 61 → 69, unknown
   stubs 3 → 3 (a mid-pass regression to 49 / 9 was caught by that measurement and fixed in #18). Row keys and table
   ids are unchanged; the fixture graph is byte-identical apart from its `stores` config.

9. **Map pass 2 — the swarm's findings, blast radius, dependencies and NX** (2026-10-03 → 10-04; proposals
   `docs/proposals/map-pass-2026-10-03.md` and `docs/proposals/dependencies-and-nx.md`; eight lanes, PRs #20–#30).
   From the eight-persona swarm on the Map (8 × TRIAL, fit 6.25, six of eight would open the Map first; reports
   outside the repo): **Z** — the canvas engine normalises every input (a mouse notch, a trackpad step, a pinch and
   the keys all take the same 1.25× step), zoom has soft **stops** (board · journey fitted · calls readable, the last
   computed from an 11 px label), zoom-to-enter is *earned* (armed only past the calls stop, fired only when one
   screen is centred and ≥ 60 % of the stage, after a visible hint), Fit fits the level you are on, a journey opens
   centred under the toolbar with `▸ n more` edge cues, the toolbar is opaque, tips open on hover
   (`lib/map-canvas.js` exposes `attachCanvas()` for the code map to adopt); **N** — one number with its scope:
   `14 screens · 10 reached` with `screensReached` typed in core, the footer `screen 4 of 10 reached`, the evidence
   word beside every tests count, owner and ERP reach on the cover, the Tests page vs code-map chip difference named
   (`1429 cases · 10 coverage reports`), the Changes tab reading the commit spine for the screen's parts
   (`GET /api/history/touching`); **L** — a legend (`?`), links routed square through the gaps with one label each,
   wider columns so nothing truncates, chips that wrap then fold to `+n`, the business lens finished on data nodes
   (*Postgres · database record*) and gates (*check* / *rule*), Portfolio's switch reads TABLE · BOARD; **K** — Tab
   reaches every journey, screen, call and data node, Enter/Esc/`j k h l`/arrows, `⌘K` arrives on the Map, the link
   carries the view (`?z&x&y` as the view's centre in world units) and the open card, `y` / *Copy link*, an *as of*
   stamp; **I** — the **Affected mode**: `?affected=<node|package:|work:KEY|commit:sha>&ahops=N` from the explore
   card, the property head and the Work/Changes rows; districts, screens, calls and data dim or carry hop badges at
   every altitude; an *Affected* tab with four typed `Counted`s from core `affectedReach` (journeys · screens · calls ·
   tests, partitioned by distance, scope `count.scope.affected`), the floor line and the cut points;
   `GET /api/impact?reach=1`, `GET /api/history/commit?sha=`; **D** — **dependencies**: `package` nodes (third-party
   and workspace, versions from the nearest manifest, `imports` edges with specifier and line, `module` nodes kept out
   of search), `GET /api/deps` and `/deps/where`, `farsight deps list|where`, a package is an impact seed, the
   tsconfig-paths comment bug fixed (star aliases now resolve); **X** — **NX projects and tags**: `GraphNode.project`
   on every node under a project root, `meta.projects` (tool nx · workspaces · none, tag dimensions `scope:` → domain,
   `type:` → type, configurable in `farsight.config.json projects`), a project graph with project → project import
   counts, `GET /api/projects[/<name>]`, `examples/nx-workspace/` (2 apps, 5 libs, an e2e, two journeys); **C** —
   the **code map by project and package**: GROUP by project / domain / type, scope filters incl. *depends on*,
   package cards in copper, *App and its related* and *Where is <package> included* views (`?view=app&project=` ·
   `?view=package&package=`), inspector sections for project and package, the Map's *Band by: source · domain*.
   Measured read-only on the reference app: 21 NX projects (3 apps · 17 libs · 1 e2e) all tagged, 32 packages (17
   workspace, each tied to its project), ERP store seed reaches 12 of 18 journeys, the busiest table 17 of 18 and 45
   screens, zero page errors. Dependabot's three alerts (example manifests) cleared in #30.
   **Swarm round 2** (2026-10-04, same eight personas on the merged pass, reports outside the repo): 8 × TRIAL, fit
   6.25 → 6.5; Map 6.8 → 7.0 · Journeys 6.75 · Portfolio 6.4 · Code map 3.9 → 4.9; the journey-level numbers now
   agree across views for every persona, the blast radius is credited by every role, *Where is a package included*
   was called the best panel in the product. One **regression** found by all eight: the Map takes the journey
   nearest the viewport centre, not the one clicked (a wide journey opened at its fitted-width floor loses to its
   neighbour) — fixed in PR #32 together with the Affected mode's readability at board altitude (fit-to-
   affected, a list with CSV/JSON), scope words on per-journey counts, the legend covering the toolbar, the zoom
   anchor and first-notch tooltip, the stepper's feedback, Enter/`?`/`y`, pan bounds, and the code map's spec-file
   boxes. **The project picker** (PR #34): `lib/multi-pick.js` (+ a pure, tested `multi-pick-model.js`) — a searchable
   multi-select grouped Applications → Libraries → End-to-end → Other with type and tag words, keyboard and ARIA, chips
   that fold past six; used by the scope menu's Projects / Tags / Depends-on, the Views menu's two pickers (single),
   and ⌘K (projects match, applications first, arriving `?group=project&box=<name>`); project and tag filters now
   ride in the link (`?project=`, `?tag=`) and in localStorage.
10. **The code map's performance pass — one precomputed index, set algebra, the project graph folded once**
    (2026-10-04, PRs #39–#40). The defect: the code map grouped by project or by a tag dimension hung the page for
    minutes on the dogfood graph (21,175 nodes) — `cmapHide(n)` ran once per node and, grouped, called the GROUP-choices
    fold over every node each time (≈7 ms × 21k × 2 passes ≈ 280 s per draw); card heights, rule badges and the
    inspector also scanned every edge per card. **Measured on the live dogfood server, before → after:** ungrouped
    2.2 s → 1.1 s; grouped by project *did not draw in 90 s* → **0.8 s**; a two-project filter and the app view ≈ 0.3 s
    (the lane's measurement); zero page errors. **Viewer:** `lib/codemap-model.js` `buildCodemapIndex` (one pass over
    nodes, one over edges: node → project key, project → nodes, dimension → value → projects, package → importers,
    `validates` counts, test files, repo → projects), `groupChoicesFor` (O(projects)), `passFor` (a filter is set
    algebra — projects ∪, tag values ∪ per dimension then ∩ across dimensions and with the project filter and the app
    closure, packages kept via their importers, `dep` ∩), `groupKeyOf` (O(1)), `projectClosure` (the app's tree from
    `meta.projects` so *App and its related* draws at once); one index per graph object and the choices cached per
    graph + scope; `store.js indexGuards()` also builds `S.validatesByTarget` and `S.EDGES_OF`, so `select()`,
    `itemHeight()` and `nodeCardHtml()` look up instead of scanning. A **Projects** chip in the code map toolbar
    (`Projects · n` when picked) opens kind chips (Applications · Libraries · End-to-end · Other), the same searchable
    multi-select as the scope menu (one filter, one `?project=`), and *Focus on an application* — the app view, drawn
    from the page's graph first and labelled when the server answers. A regression guard: `codemap-perf.test.ts`
    (a synthetic 20k-node graph, the index + choices + two filters + the fold under 2 s; `passFor` proven equal to the
    old per-node predicate on the NX example + invoice app). **Core/server:** `projectGraph()` is folded once per
    `GraphIndex` (a `WeakMap`, refolded when the index or `meta.projects` changes; `?repo=` narrows the kept rows),
    closures walk an adjacency built once and are remembered, every `ProjectRow` carries `closure: string[]`,
    `/api/projects/<name>` is a lookup (`projectNodeIds`). `/api/projects` on the dogfood graph: 15 ms first, under 1 ms
    after. **NX's own project graph is read, never produced** (`parsers/src/shared/nx-graph.ts`): for an NX source the
    first of `.nx/workspace-data/project-graph.json`, `.nx/cache/project-graph.json`, `node_modules/.cache/nx/project-graph.json`
    or the file `farsight.config.json → projects.graphFile` names (source-relative; absolute, `..`, NUL, a symlink out of
    the source, a non-file or > 20 MB each refused with a note; both the `nx graph --file` and the bare cache shapes;
    `npm:` targets skipped; only names discovery found count, the rest a count in `notes`; nothing is ever spawned —
    `docs/SECURITY.md` says so). Recorded as `meta.projects.dependencies` (`via: 'nx-graph'`) and `graphFile`; a project
    no manifest typed takes NX's type; in the project graph a pair NX records gets `nx: true` + `nxType`, a pair only NX
    knows is a dependency with `imports: 0` under the new part `count.part.depsNxGraph`; `graph_overview` prints
    `nx graph: N dependencies read`. Imports read from the files stay the primary evidence (principle 2).

11. **Journeys organised by persona and group, and many config files per source** (2026-10-04 evening; proposal
    `docs/proposals/journey-organisation-and-config-files.md`, PRs #45–#48, three lanes). Four decisions taken with the
    owner: the manifest declares and a config block overrides; a nested config scopes its own folder; two fixed levels
    (persona → group → journeys); MCP reads and guides, never writes into a source.
    - **Config files** (#46): every `farsight.config.json` in a source is read (`parsers/src/shared/config-files.ts`
      `loadWorkspaceConfig`, root first, then by folder depth; the workspace excludes apply). A nested file's node
      matchers (`tags`, `glossary`, `guards`, `entrypoints`, `setup`) apply only to nodes under its folder and
      the nearer file's word wins; its paths (`plumbing`, `design`, `openapi`, `tests` reports, `storybook`, a
      `path::Class` external import) are rebased to the source root and unioned; `tests.unit|integration|e2e` take
      one block or a list and `results|coverage|report` take one glob or a list; `externals`/`stores` union with a
      duplicate recorded as a conflict; `projects` and `tooling` are root-only (a nested value is a note). The six
      readers consume one `WorkspaceConfig` and all honour `config: false`. `fragment.meta.config: ConfigMeta`
      (files · conflicts · notes) → `meta.config[repo]`; MCP `config_files` and a `graph_overview` line, `farsight
      config list`, `GET /api/config`. `examples/nx-workspace` has two nested configs and one deliberate glossary
      conflict.
    - **The model** (#47): `screens.json` gains `personas[]` and `groups[]` (ordered; a group with `persona` lives
      under that persona only), a flow gains `persona: string | string[]`, `group`, `order`; order is `order`, then
      the config's index, then **manifest order** (the alphabetical sort is gone on purpose; the pinned *start here*
      stays marked, not moved). A `farsight.config.json → journeys` block (`personas`, `groups`, `flows` by id)
      overrides field by field, root block first and the nearest nested block last; an id no manifest declares is a
      note. Folded at ingest into `meta.journeys[repo]` (`core/journeys.ts journeysMetaOf`); `journeyTree(index,
      metas, scope)` is the one pure fold behind `GET /api/journeys`, MCP `journeys { repo, persona, group, json }`,
      `farsight journeys`, and the `graph_overview` journeys line; the `journey` tool prints *shown under*. An
      undeclared persona string (the reference app's *"X and Y"*) is its own persona, flagged *not declared*, never
      split. Every count is a `Counted` (`docs/COUNTS.md` § Journeys). `design_guide` documents all of it, nested
      config files included. A multi-manifest fix: an earlier manifest no longer marks a later manifest's page *built,
      not designed*.
    - **The viewer** (#48): the Journeys front door shows *Journeys by who uses them* — persona heading with its
      description and counts, collapsible groups in declared order (remembered per group), the journey cards, an *also
      for …* chip, `?persona=` / `?group=` filters; the journey header reads *For <persona> · <group>*; the Portfolio
      is one table per persona → group with a pin per persona; the Map bands by **persona** (a journey under two
      personas draws its street once and a dashed *echo* card in the other band). `lib/journeys-tree.js` reads
      `/api/journeys` first and `lib/journeys-model.js treeFrom()` folds the same tree from `/api/design` against an
      older server (proven equal to `journeyTree()` by test). Verified on the dogfood server: 21 journeys · 5 personas
      · 6 groups, zero page errors on the front door, the Portfolio and the Map.

12. **The Map clarity pass — the board draws by altitude** (2026-10-04, late; PR #50, one lane, from the owner's
    verdict *"the map looks a bit crowded"* and the lead's screenshot review of the live board). At **board** altitude
    a journey is a **card**: its name, one status chip (*built* · *partly built · n of m* · *designed, not built*), an
    *at risk* mark (stale and/or not every screen built — the AT RISK bar's own facts) and `→ n` (how many journeys it
    leads to); the description and the full chip row live in the street head, from the journey altitude up. Cards are
    2–4 screens wide and one height (`lib/map-model.js boardWidth()`), so **a cover no longer shares a width with its
    street** — the board has its own layout and `ensureAlt()` swaps layouts at the level change keeping the journey
    under the pointer fixed. Links at the board draw only for the hovered or focused journey (both ends lit, the rest
    dimmed, no labels); from the journey altitude up they draw as before. Each band is a faint **panel** as wide as the
    widest row with a counter-scaled header (the band word · *n journeys* · a persona's description). The toolbar folds:
    *Band by* is one segmented control (a menu under 1500 px), the as-of stamp hides and the level buttons shorten under
    1360 px. Also fixed: `+` / ⌘-scroll from the fit did nothing while the AT RISK headline showed (`boardScale()`
    ignored its row). **Measured on a copy of the dogfood graph (21 journeys):** the board fits at ×0.21 at 1440×1000
    (was ×0.12) and ×0.14 at 1280×720 (was ×0.08), every chip readable, zero page errors on 44 shots. Then PR #51: a
    closed journey blurs the focus it still held at once (a hidden control kept it for a frame) and the focus spec polls.

13. **The 2026-10-05 round — storylines, the Map and the journey as one, details that link out, a thousand projects**
    (proposal `docs/proposals/round-2026-10-05.md`, PR #53; five lanes, PRs #54–#58). From the owner's asks: unify the
    Map and the journey, make every detail click to expand or link, track "verticals" across features, another browser
    performance round for hundreds to 1000+ NX projects, and the handoff's ranked list.
    - **The fetch-helper regression** (#54): `fetch(url, helper(ctx, { method: 'POST' }))` keeps the literal from the
      helper call's object-literal arguments (spreads, one nested call deep), a verb-named helper (`post`·`put`·`patch`·
      `del`) is the fallback, a non-verb helper with no literal stays `methodAssumed`; wrappers pass it through.
      Measured read-only on the reference app: drift **19 → 7**, http edges to routes 69 (literal methods 9 → 69,
      assumed 11 → 0), unknown stubs 3; the invoice-app example's edges byte-identical.
    - **Config follow-ups** (#55): nested `stores[]` scope to their folder (a listing beats a catch-all, then the nearer
      file; conflicts recorded as kind `store`); a read-only **Config files** list on the Settings page
      (`surfaces/settings-config.js` over `/api/config`, which now carries `counts`); `schemas/farsight-config.schema.json`
      and `schemas/farsight-design.schema.json` (2020-12, hand-written, pinned by a test that validates every example and
      checks the config schema's keys equal `CONFIG_FIELDS`); the nx example has four config files.
    - **Storylines** (#56): the word for the owner's *verticals* — a named chain of journeys across features, declared in a
      manifest's `storylines[]` or `farsight.config.json → journeys.storylines[]` (`{ id, name, description?, journeys[] }`,
      the same override rule as personas and groups; an undeclared journey id is a note; a journey may be in several);
      `JourneysMeta.storylines`, `JourneyTree.storylines[]` with `Counted`s (`count.unit.storylines`, `count.scope.storyline`),
      `JourneyRow.storylines`; MCP `journeys { storyline }`, `graph_overview` counts them, the `journey` tool prints *in
      storyline · step n of m*; `farsight journeys --storyline`. On the **Map** a *Storyline* picker (`?storyline=<id>`):
      the board draws only that chain **as one band in order**, step numbers on the cards, a *then* link between steps at
      every altitude; *All* restores the bands. Persona bands now start each **group on its own row with the group word
      in a gutter**. The front door has a *Storylines* section (numbered status chips, *open on the Map*, *open the first
      journey*); the journey header reads ‹ storyline · step n of m ›. The business register says *questline* and
      *journey n of m*.
    - **The Map and the journey as one, and every detail a door** (#57): `#/journeys/<flow>?view=timeline&step=n[&node=id]`
      opens the blueprint timeline at step n with that marker selected; `#/map/<flow>?screen=n[&plumb=1&card=<kind>:<id>]`
      frames the screen and opens the explore card — two pure, tested functions in `lib/route-url.js`; *see it on the Map*
      in the journey header, *open the journey here* on street screens, the property head and the explore card; the
      journey writes `step`/`node` into the address as the selection moves. `lib/detail-links.js detailLinks(kind, node,
      ctx)` (lookups only, 0.7 µs each) is the one door builder: gates and rules → *open in the editor* (VS Code at the
      line, code read from the new read-only `GET /api/source?node=`) · *see it on the code map*; route calls → *read the
      contract* (`#/apis/<id>?op=`) · *read the spec file* · *open the handler in the editor*; records/stores/externals →
      code map · schema file; tests → *see the cases* (`#/tests?flow=`) · the test file; work → the work board · the
      tracker; screens → the page · the manifest · Figma; packages → *where is it included*. A door the graph cannot name is
      not drawn; the business register drops every door into code. Journey gate rows expand in place to their code lines
      and doors; Enter opens a focused detail's first door, `o` the editor. Board cards now show *stale* (muted) and *not
      built* (amber) as two marks, and an 8-px reading floor (*n journeys · zoom in to read*).
    - **A thousand projects** (#58): `scripts/synth-graph.mjs` (seeded; full = 1,000 projects over 20 sources, 244,880
      nodes, 417,836 edges, 300 journeys in 40 manifests; `--preset small` for CI), `e2e/perf/` + `pnpm e2e:perf` printing
      one table, `packages/server/test/thousand-perf.test.ts` holding the folds under budget. **Before → after on the full
      preset (ms):** front door 428 → 217, persona filter 373 → 60; Map board 465 → 236, open a street 195 → 125 with heap
      1252 → 753 MB, pan/zoom 52 fps; code map grouped by project *did not draw in 120 s* → 421, a filter → 371; Portfolio
      368 → 154; APIs 348 → 140; Tests 9113 → 252; Changes 338 → 131; Work 351 → 133; ⌘K keystroke 587 → 45. How: the code
      map builds only the cards near the viewport past 1,500 drawables and reads every height before writing; the status
      bar's 245k-node scan, each node's group and the tag-chip counts are computed once per graph/scope; ⌘K matches over
      text prepared once in idle time (`lib/search-model.js`, ranking proven equal to the old scan) and re-ranks a growing
      query; `routeLinks` blocks only each district's own crossings; server `folds.ts` keeps answers per index (the
      Portfolio rebuilt the 7 s tests catalogue 300×), `/api/tests?lean=1` (the full answer is 243 MB at this size),
      `/api/journey?steps=0`; core coverage looks up a journey's nodes instead of scanning all (`testsSurface` 7.9 → 2.1 s).
      **The ceiling that remains is the payload:** `/graph` is **411 MB** at this size (2.4–2.8 s to load, ~500 MB heap,
      ~2 s server parse) — the server-side query API round.

14. **The swarm-fixes round — the 2026-10-05 swarm's nine findings, in its order** (2026-10-06; proposal
    `docs/proposals/swarm-fixes-2026-10-05.md`, PR #62; eight lanes, PRs #63–#71, every lane measured on a read-only copy
    of the reference app's graph served by its own build, zero page errors on every shot).
    - **One test verdict per cell** (#64): the contradictions were two extra folds, not the word — the *their own last
      run* line printed the weakest status over every covering case (one skipped case among 145 said *skipped*) and
      the tip's verdict folded over coverage reports, which record `unknown`. Core `testVerdict()` now puts `verdict`
      on every coverage fold: the word is `evidenceWord` as before, `status` is read only over the refs that earned the
      word (a declaration word only ever stands beside *passed*; a coverage report alone gives no status), `runs` is
      every case by its own last run (passed · failed · skipped · flaky · no run recorded, summing to the cases).
      A route and its handler at the same `file:line` are twins (`sameLocTwins`), so `route.ts:24` carries one verdict on
      both surfaces. Every scoped foot has *open the list* and the Tests page reads `?flow=&seg=&action=` /
      `?node=` (`GET /api/tests?flow=&seg=[&action=]`, `cases` opt-in); `farsight tests matrix` gains the runs column.
    - **Stale said once and only when true** (#65): on the reference app *stale* is **true** — the Playwright run was
      stamped on 2026-10-04 and the code moved after it — so the counts barely moved; what changed is that every
      *stale* carries both sides (`core/freshness.ts` → `freshness` on every coverage fact: *the tests ran on commit X
      (date); the code is at commit Y now*, or *the working tree changed after the run*), a current scope says
      *current as of sync N*, and a run with no digest says *no source digest* with the stamp recipe, never *stale*.
      The code side is `meta.tests[repo].head` (`setFreshnessMeta` per index in server/MCP/CLI). The Tests page is one
      card per source × level × runner (the reference app's e2e level is a Playwright card and a Vitest card, each
      with one answer). **Settings vs Changes:** `writeSpine()` printed only this sync's incremental read (`history 0
      commits read`); it now prints `history N commits indexed · k new this sync` from `db.commitCount`, the rows
      Changes counts.
    - **One word per position, and the business register's last words** (#70): *step* is the storyline position
      only (business *journey n of m*); the Sheet's columns are **stops** (`counted.actionStops` = actions + run again
      + declared only + nothing to call — pinned by a core test, which is why *5 actions* and *6 columns* were both
      right), the drawer head says *stop n of m · call*, the drill's *stop* and *beat* stay, the code register's
      *983 steps* is *visits*, inspector words say *part*, plurals come from the catalog. Business register: gate
      shapes are sentences (`journey.biz.gateShape.*`), `chore(memory):` prefixes drop from commit subjects, a store
      read off a driver prints *database record*, plan ids drop, descriptions go through `plainWords`; ADR numbers
      stay in every register as citations. Identifier tokens in view on the walked business screens 375 → ~199
      whole-page, 0 on the storyboard, the storyline board and the Map street.
    - **A gate answers its click** (#67): one gate card everywhere (journey lists, Sheet, ladder, drill, Map property,
      code map inspector; `lib/gate-card.js` + a pure `gate-card-model.js`, `GET /api/gate?node=`, MCP `gate`, a
      `## gate` section in `describe_node`): kind · name · `path:line` · doors on its head · *what it allows* (the
      `@business` sentence, else the `@guard` words, else *nobody has written down what this allows* with who should and
      where) · *where it stands* (n of m calls · n pages) · its code wrapped · the calls it guards with doors · the
      tests that reach it with the one verdict; business keeps sentence, scope and tests. The doors are on every gate
      row; the ▸ fold is gone. **Config checks** (core `config-check.ts`: a guard whose text reads the environment and
      takes no request-like parameter; six of the reference app's 73) are listed and counted apart and never as a
      screen's gates — the ops sign-in checks were reached from the page's `serverContext` → `loadWebEnv`, not from a
      call; the submit journey went 28 → 25 gates & rules + 3 config checks. Two CI-only races fixed on the way: the
      card survives the inspector redrawing under it (a `data-tip-anchor` the tooltip re-finds), and the specs click
      the gate's name, not the row's centre (Linux font metrics put the centre on the ⧉ editor link).
    - **Chrome** (#66, plus the focus fix #71): a cog with the word SETTINGS and a Settings row in ⋯; **READ-ONLY was a
      constant chip with nothing behind it** — now `farsight serve --read-only` (and every `--as-of` serve) refuses
      `PUT /api/settings`, `POST /api/sync`, `POST /api/work/*` (`guard.ts` `isWriteRoute`/`refuseWrite`),
      `/api/version` reports `session: { readOnly, why }`, the chip shows only then and every `[data-write]` control is
      greyed with a tip; the legend is closed by default, scrolls inside itself, has its own glyph and the `g` key; `?`
      opens the keymap everywhere; the Map toolbar folds by measurement (the 1440 overflow was its fixed breakpoints);
      the Sheet's *verified by* chip wraps inside its cell and gate names break between words; Experiments is one flag
      per line; the chosen journey view is remembered per register so business lands on the Storyboard; Esc on an
      empty journey asks first; the board takes focus when the Map opens and Tab from it goes to the first cover (the
      band header's count was redrawn by the first walk — the flaky spec's cause); the light theme dims less.
    - **Storylines, second pass** (#68): a **branch** is a storyline fact — a `journeys[]` entry
      `{ id, branchOf, when, rejoins? }` in the manifest or the config override (`branchOf` a step of the same storyline,
      `when` required, `rejoins` absent when the case leaves the storyline); the Map draws it on its own row under its
      parent, dashed with a fork glyph, the condition on an amber link and a dashed return; the front door lists it
      indented with *back to …*; the journey header reads *branch of … · when …*; MCP/CLI print it; counts break
      down *n on the main path · n branches*; both JSON schemas and `design_guide` cover it. `?storyline=<unknown>`
      says so with the declared ids as doors (`#/journeys?storyline=` and MCP/CLI too); ⌘K finds storylines (first
      row, lands on `#/map?storyline=`); storyline cards on the Map and the front door carry the first journey's first
      screen or the placeholder; each board card carries the one evidence chip and the band header *n of m journeys
      with a run's evidence*. The reference app's manifest now declares the correction journey as a branch of review.
    - **The two empty screens, and the record's status lifecycle from code** (#69): the mark-paid state screen is bound
      to a form that only runs `onConfirm`, a function its parent handed it — the call was credited to the page
      component alone, so the street (same edges) listed it under the page and the state screen had nothing to walk
      into; the approval state is bound to a display-only component. New parser pass `callback-props.ts`: a component
      that runs a function its parent handed it gets `calls` edges for what that function calls, following
      pass-through parents, only along components rendered from one place (technique `callback-prop`, MEDIUM, added
      to the frozen diff schema additively); a parent-computed value is credited only where the child branches on it.
      On the reference app five state screens went from 0 calls · 0 gates to their call, 8–12 gates and 40–65 cases;
      http edges to routes 69 → 69, unknown stubs 3 → 3, drift 7 → 7. **Lifecycle:** `GraphNode.lifecycle` on a record
      when the code declares its statuses (a SQL CHECK, `z.enum`, a literal union, a `const … as const`) — statuses,
      transitions with the writer that performs each (`from` only when the writer compared the prior status),
      statuses no code writes — as `Counted`s (core `lifecycle.ts`), printed by `describe_node`, as a strip in the
      journey header and the Map property's Overview with a door per move. The reference app's invoice: 11 statuses,
      6 moves with a writer (draft → submitted → verified → approved → compiled → scheduled → paid), 5 nothing writes;
      the storyline's order matches the moves.
    - **Export** (#63): *Save* in the Map toolbar, the journey header and the Portfolio heading — PNG (the DOM copied
      into an SVG `foreignObject` with the page's stylesheet, same-origin images and sprite glyphs inlined, drawn to a
      canvas at ≥2×, empty rows cropped) and PDF (a minimal writer embedding the canvas; long side capped at A3), CSV
      for the Portfolio; a three-line provenance footer (what it shows · source · sync · source commit · as of · lens ·
      drawn by Farsight build · saved date); file name `farsight-<surface>-<source>[-<storyline|journey>]-sync<N>-<date>`.
      Client-side only, no dependency, no route. The Map export fits the band first and saves the whole band; the
      journey export switches to the Storyboard. Measured: the storyline board 3203×1657 in 0.24 s, the storyboard
      2880×3400 in 1.1 s. **Pinned link:** Share → *Copy pinned link* uses the existing `@sync:N` hash grammar plus
      `asof=<date>`; when the address pins a sync the server does not draw, a note beside the sync chip says *pinned to
      sync N · this server shows sync M* (the server cannot draw an older sync on demand; only `--as-of` at start).

15. **The lanes round, wave 1 — one surface, swimlanes, lifecycle views, scope on every number, gates for a business
    reader** (2026-10-10; proposal `docs/proposals/round-2026-10-10.md`, PR #74; seven lanes, PRs #75–#82, every lane
    measured on a read-only copy of the reference app's graph with zero page errors; the pitch with its before/after
    mocks and the competitor study stay outside the repo). The inputs: the 2026-10-06 swarm's *a number whose scope
    changes between surfaces*, a developer overview whose *journey at a glance* page (lanes per actor, arrows where an
    action moves the record, a state table underneath) read better than the Map, and a study of two open-source
    products (a knowledge-graph dashboard with a derived tour but model-written prose; an agent-memory server with tool
    tiers and budgeted answers but no parsed code). The owner's decision: **the zoomable Map is the surface that stays;
    the separate journey page retires (wave 2) and its views become stops and layouts of the Map.**
    - **One surface, steps 1–2** (#78): the journey's pure folds moved to `lib/journey-model.js` (old names re-exported);
      `surfaces/map-stops.js` — the level control reads **ALL · JOURNEY · SCREEN · ACTION · CODE**, the *action* stop
      draws the drill's lanes of beats on the stage with a slim screen strip and a crumb strip (storyline › journey ·
      step n of m › screen n of m › action n of m), *code* is the dock opening (in place · bottom · right), one
      **LAYOUT** control whose choices change per stop (`registerMapLayout` — `chain · lanes` at ALL, `screens ·
      table` at JOURNEY, `beats · ladder` at ACTION), the street head carries the journey's facts; `route-url.js`
      `mapStopHash`/`mapStopOf` (`#/map/<flow>?screen=&action=&beat=&layout=&dock=`). Measured: the action stop draws
      in 112–193 ms wall (32–34 ms to draw) for a screen with 11 actions; the table layout draws the widest journey
      (23 stops) and reads at 1280 because the head scrolls with it.
    - **The storyline as swimlanes** (#81): a `lanes` layout at the ALL stop — one lane per persona that owns a journey
      (the tree's order) plus one per store the walk's write markers name; stages = the storyline's screens in step
      order (step badge or fork glyph, first sentence, status chip, the test chip with its scope, a decision the code
      holds); record pills per status the code moves into, in lifecycle order, naming the writer in hybrid/code;
      solid *moves* arrows, *then* links, the branch arrow with its condition, dashed *seen* arrows only from a
      declared hand-off; each move pill carries *needs n* (the preconditions, each with its evidence word) and an amber
      *not checked* when the code never compares the status it leaves; the lifecycle strip, a legend and a footer
      beneath; `storylines[].lanes[]` / `handoffs[]` in the manifest and config (an entry the graph cannot find is a
      note); zoom into a stage enters that journey's street; export with the provenance footer. On the reference app
      the main storyline (5 steps + 1 branch) draws as **2 persona lanes + 2 store lanes** (the code writes the
      database and the ERP), fit ×0.26 at 1440×900, names at the 8 px floor.
    - **One state machine, two views** (#75): a `lifecycle` config block (`views.<persona>` word → statuses,
      `overlays[]`), applied once at ingest by `parsers/src/shared/lifecycle-config.ts`, nested-scoped; core
      `lifecycleViews()`; the strip prints the persona's word (business), word + constant (hybrid), the constant
      (code), `→` only where code moves straight from the previous status, muted *no code moves it yet*; a toggled
      *what each one means* table (what <persona> sees · in the code · what moves it, the mover a door placed by a
      read-only `GET /api/lifecycle?node=&flow=`); identifier tokens on the reference app's lifecycle strips 94 → 0.
    - **Every test number carries its scope** (#79): `TestVerdict.scopeWord` and the failed · skipped · flaky counts;
      one chip `lib/test-chip.js` on every surface (*n cases · over this journey / screen / action / part / gate ·
      verdict · n skipped*); a designed, not-built screen has no verdict (*no test can reach a screen with no code*, the
      cases reaching the routes it will call under `count.scope.route`); *distinct* on a journey total with the
      per-screen table in its tip; the absence word is *no test is known to reach*; one declaration phrasing; the
      matrix's level filter filters rows; `evidence_word` and `verdict` columns appended to the frozen matrix CSV;
      `strings-evidence.ts`. Test numbers in view without a scope word on the reference app's submit screen: 31 → 0.
    - **Gates a business reader cares about** (#82): `parsers/src/preconditions.ts` (a status/kind/flag comparison on
      the written record or a record loaded with it whose arm refuses — a throw, a 4xx helper, a blocker list refused
      one hop away, a transition table read inverted — becomes a `rule` tagged `precondition`, technique
      `precondition` in the diff schema, `validates` the action; a role guard's constant argument lands in
      `meta.requires`; a `@guard` that writes a status is an `action-gate`, never a gate on itself; `configCheckOf`
      narrowed; a response schema is not a rule); core `gate-class.ts` (`gateClass` · `gateTierOf`: business · policy ·
      technical), `query.ts` tier and class on every journey gate, `counted.gatesBusiness` + `gatesTechnical`
      partition `gates`; `gateTiers` config block and `@guard[tier]`; the business register groups *who may · the
      record must be · + n technical checks*; the gate card prints its tier and why; `moments[k].preconditions` on
      `/api/journey` (the hand-off data). On the reference app: verify & approve 24 → 26 = **18 that matter · 8
      technical**; approve's needs include *the vendor account is active (reached by tests)* — the owner's own example,
      which was in the code and in no gate before.
    - **A pull request gets its affected set, and a brief that prints** (#77): core `affectedRange()` (a commit range
      or a PR → journeys touched with storyline position, the changed path's gates · record writes · calls, the
      deduplicated tests with each case's own last run, a verdict line), the frozen **`farsight-affected v1`**;
      `farsight affected --pr N | --from --to [--json] [--png] [--post --confirm] [--via gh]` posting one comment
      (found again by a marker, edited in place) and one `farsight/affected` commit status through the three-verdict
      gate (`packages/work` `decideGrants` shared with tracker writes; a `code-host` source; `keychain:farsight/github-
      <org>`); MCP `affected` when a code-host source grants read; core `readiness()` + `GET /api/readiness` + the
      `#/readiness/<id>` page (light, A4 print stylesheet, Save → PDF/CSV) + `farsight readiness`; a door on the Map's
      storyline head and the front door's storyline card. Posted for real on a throwaway PR of this repo (closed).
    - **Read-only greys every write, Settings is an address, the state of play** (#80): `lib/read-only.js` greys every
      `[data-write]` control (Work's sync, the item pane's writes, Settings' inputs; 11 → 0 enabled under read-only);
      `#/settings` under the top bar, an unknown address says so; core `state-of-play.ts` → `GET /api/state`,
      `farsight state`, the top of MCP `graph_overview`, and the front door's two cards (*read this if · state of play*:
      built and walkable · validated by a run · still open, every number a `Counted` with `recheck { cli, mcp }`); one
      history sentence from one core function on the front door, Settings and Changes (*n commits read into history · k
      ingested by a sync · m not yet*); the glossary strip from `ConfigMeta.glossary`.
    - **Left open by the wave** (per lane, outside the repo in full): the reference app has no `lifecycle` or
      `gateTiers` block (its words are humanized constants; a `@guard` label matching no class word defaults to
      *authorisation*, which is why approve shows 18 and not ~9 — a handoff item for its session); the table layout
      has no `j`/`k` walk and the ladder prints paths in business (U2); moves made by background workers carry no
      needs (preconditions are read within two calls of an action); storylines across sources are not drawn as lanes;
      the Affected mode does not paint the lanes; `journeyTree` keeps the first of two storylines with one id across
      sources (the brief and the affected set build the tree per source; the front door shows one door); the PR
      comment carries no image (no API for it); Azure DevOps posting is not built; precondition messages with a hole
      print an ellipsis and keep their capitals; identity folds to one row per wording, not per persona.

16. **The lanes round, waves 2–3 — one address, compare two syncs, what an agent gets** (2026-10-11; PRs #85–#87 on
    the same proposal; every lane measured on a read-only copy of the reference app's graph with zero page errors).
    - **One address — the journey overlay retires** (#87): every door that opened `#/journeys/<flow>` lands on the Map
      at its stop (the front door's journey and storyline cards, entry points, ⌘K, Portfolio rows, the Tests page's
      matrix rows and scoped cells, the readiness brief, the code map's project panel, the APIs page, the lifecycle
      writer doors, the gate card and impact rows); `route-url.js overlayToMap` converts an old link in one
      `replaceState` (no history entry), `step=` is read as `screen=` and rewritten, a new `part=<node>` names one part
      of the walk; each register lands on its own stop (`fs-map-view.<lens>`: business the street with each screen's
      own sentence, hybrid the table, code the first action's beats with the code open); the table took the Sheet's
      and the header's jobs (`j`/`k` walk the parts into the table's dock, `d` moves it, the forks drawer, the cut
      list and the count line on its head, `t`/`b` for the open part); the street head reads *For <persona> ·
      <group>* with ‹ › to the storyline's neighbours; `surfaces/journeys.js` 4,992 → 432 lines (the front door), the
      drawing the stops reuse in `lib/journey-draw.js`, ~90 dead functions deleted, the `#journey` markup gone from
      `viewer.html`, one keymap, 60 retired view words out of the catalog, the storyboard export is the street export;
      `flags.map` and `journeyDrill` retired (a workspace with the flag off could no longer read journeys); an entry
      point that is not a designed flow draws as a journey of its own; an `action` is now its place within its screen
      segment (the Tests page's unit). Measured: 28 doors each landing on its stop in the registers where it applies,
      84 screenshots over every stop in three registers on three reference-app journeys, 0 page errors, 0 identifier
      tokens on the business street and screen stops.
    - **Compare two syncs on the storyline** (#86): `GET /graph?asof=` and `asof=` on `/api/journey`, `/api/journeys`,
      `/api/design` answer from history for any sync it holds (closes the pinned-link item; a sync not held is 404 ·
      *not indexed*); a `snapshot_meta` table so each sync keeps its storylines and test reports; core
      `storyline-diff.ts` with a **closed set of five kinds** — built · gate (with tier) · writer · contract · verdict —
      each a sentence in both registers (`strings-compare.ts`) with a door; every count a `Counted` over
      `count.scope.compare`; the frozen `farsight-diff v1` grows additively (`storyline_*` kinds, `delta`, a
      `storyline` block); `farsight diff --storyline <id> --from sync|previous|day|tag:|last-green --to … [--json]
      [--business] [--fail-on …]` exits 1 on a matched kind (the CI check); MCP `storyline_diff` (`all` tier); a
      Compare control beside the storyline picker (`?compare=a..b`), change chips on covers and lane stage cards, a
      right-hand panel of sentences with doors, Save → a dated A → B PNG/PDF naming both syncs, the Changes page gains
      one row per storyline; notes say when both syncs are at the same code commit (*these changes are what Farsight
      reads*) or when the older sync predates lifecycles. Measured: fixture sync 1 → 2 = 7 changes; the reference app
      sync 108 → 109 = 14 changes, all gates added or removed by the preconditions and tiers, 0 page errors.
    - **What an agent gets** (#85): tool tiers (`FARSIGHT_TOOLS=core|all`, `mcp.tools` in settings wins; **core** =
      `graph_overview · journeys · journey · describe_node · search_graph · trace_flow · impact_of · gate ·
      test_coverage · tools · expand` + `affected` when a code-host source grants read; tools outside the tier are
      registered then disabled so the menu still lists them; `graph_overview` ends with the tier line); **budgeted
      answers** (`budget`, rough tokens = characters ÷ 4, default `mcp.budget` else 8000; cut at a section or a whole
      journey segment, ending in `## left out` with the ids, `expand {"ids":[…]}`, the same call with a budget that
      fits, and `excluded_by_budget` in JSON; JSON answers are never cut — frozen contracts); the **session-start
      context** (`farsight://context` and `graph_overview {brief, since}`: one `<farsight-context …>` block — the state
      of play, history with the agent count, what moved since the last session, the pinned lessons, the tier line; a
      test proves no keychain reference reaches it); **copy as MCP call · curl · CLI** on the gate card, the Map
      explore card, the property head, the code map inspector and the front door's numbers (`lib/copy-doors.js`);
      **agent-made commits** (a `Co-Authored-By` from an assistant → `commit.agent`, in `farsight history --agents`,
      `/api/history/commit`, Changes, the Map's Changes tab, `graph_changes`, a state-of-play line; session links are
      never read); a **lessons editor** on Settings (`[data-write]`; a credential-shaped lesson is refused without
      echo); empty states name the command on Work, Tests, Changes, APIs, the Map, the storyline picker and lessons.
      Measured on the dogfood graph: 11 of 28 tools on in core; the reference app's widest journey (~44k tokens)
      answered under 8k with `expand` returning the cut segments; this repo's spine: 246 of 269 commits made with an
      agent.
    - **Walk me through it, and ask** (#91): core `tour.ts` — `tourOf(index, storyline | flow, { persona, repo })`
      gives one stop per screen in storyline order (branches after the main path) and one per hand-off (a move the
      code makes to a record); every clause is a template from `strings-tour.ts` (business twins `tour.biz.*`) and
      carries the node ids it cites, a `Counted` behind any number, the `testVerdict()` behind any evidence word and
      the earlier stop it refers to; a move whose code checks nothing says so. Core `ask.ts` — a **grammar of four
      shapes**, never a model (*where is <record> set to <status>, and what must be true first · what guards X · how
      does A reach B · what proves Y*), `pathBetween()` over the edge indexes (`count.scope.path`), any other question
      answered with the four shapes; one named extension point `phrase?` whose output would sit beside the cited lines
      labelled *phrased by a model* (nothing passes one). `GET /api/tour`, `GET /api/ask`, MCP `ask` (core tier) and
      `tour` (`all`, long answers), `farsight tour <id>`, `farsight ask "<question>"`; the viewer's WALK panel in the
      dock (`lib/tour.js`, key `a`, the Map moves with each stop, *walk me through it* doors on the front door's
      storyline and journey cards) and the ASK box (`lib/ask.js`, also under the state of play); `copy-doors.js`
      gains `tour` and `ask`. Measured on the reference app's main storyline: 26 stops (19 screens · 7 hand-offs), 227
      clauses, 0 uncited, 45 numbers each a sound `Counted`, 0 identifier tokens in business; *where is an invoice set
      to approved, and what must be true first* names the writer with file:line, the move's own status check, the
      identity-link and vendor-account preconditions each *reached by tests · 3 cases over this gate*, the proving
      cases, and an 8-hop screen → table path.
    - **Two fixes the lead's live check found** (#89, #90): a cold load of a Map journey address by its short name
      (`#/map/new-invoice?…`, the old-link redirect) stayed at ALL JOURNEYS on the multi-source graph — the Map's
      `entryTarget` knew only full node ids while the retired page resolved a name server-side; it now resolves
      through `resolveEntryName` and rewrites the address to the full id. Then three address-write races dropped the
      other parameters: the table wrote `screen=` only beside a selected part, a lens redraw wrote the table's address
      while the name was still resolving, and a late table draw overwrote a stop below; the table now writes its
      address once, keeps `screen=n` (scrolling that screen's columns into view, the crumb *screen n of m*), a lens
      redraw writes nothing, and a late draw after an action opened is skipped; the two-source e2e cold-loads by id,
      by name, through the redirect and with `action`, `dock` and `lens`. The 28-door measurement in #87 had used
      full ids and in-app clicks, which is why neither showed.
    - **Left open by waves 2–3:** the overlay's CSS is still in `viewer.html` (dead, not deleted); a journey head with
      two lifecycle strips draws over its first screen card on the reference app (pre-existing); Esc in the instant a
      door lands can keep `layout=table`; the compare panel sits over the board (fits under, not beside); a removed
      gate's door opens on the served graph where it no longer exists; the journey tree is always the served graph's
      even when the board draws an older sync; older syncs cannot name their Farsight build; `last-green` walks up to
      30 syncs one by one; `refresh_graph` is outside core but some answers still name it; no `farsight context` CLI;
      the dogfood workspace counts the invoice example's commits twice (it reads the repo root's log); the weekly
      cycle's move to Paid has no tour stop (the precondition fold does not find it); the open tour stop is not in the
      address and the panel has no persona picker; the lanes hand-off marks the pill but does not pan to it; a
      journey name two sources share resolves to whichever the server picks first, and a name matching nothing lands
      on the board with no sentence; on the street the board replaces `screen=` with `z/x/y` after a gesture; a WALK
      button in the toolbar row moved the *link is the picture* landing by 1.3 px (cause not found; the button sits on
      the crumbs row).

17. **Echo optional memory foundation and review hardening** (2026-10-11; PR #84, `codex/echo-setup`,
    based on main `227fb80`; not merged): separate package, workspace/global settings, one connected profile per
    workspace, explicit managed saves and scoped prompt recall, standalone settings view, and Ollama verification.
    Repository files require exact-byte approval in private user state before use; Echo-only keychain references
    are pinned to an origin with transactional saves. The native engine is checksum-pinned in a private user cache
    and hash-checked before execution. Generated hooks are locally ignored; `disconnect` restores unchanged files
    byte for byte and preserves later unrelated edits. Only session-start and prompt events are registered. Memories
    refuse credential-shaped input and report historical workspace/revision/date; truncation is visible. Shared
    keychain transport retains separate Work/Echo policy. Source installs allow only esbuild dependency scripts;
    network-dependent package verification is a separate optional CI job.
    - **Verified:** full build/typecheck and package unit suites: **1,355 tests, 1,353 passed, 2 live-tracker skips**,
      including **103 Echo tests**; script tests **14/14**, catalog lint, browser/MCP regressions **316/316**. The
      standalone package passed clean install, synthetic save/recall, restart persistence, isolated stores, shared
      recall through all three host runners, provenance, local switch-back, disconnect and owned-process shutdown.
      An offline pnpm 9 fixture verified that the allowlist suppresses both direct and transitive dependency scripts.
    - **Still open:** automatic capture, model-curated briefs, skills, team authorization, Farsight's combined brief,
      long-term retention validation and release publication. Prompt recall does not call Ollama. Similar saves can
      supersede earlier facts despite disabled scheduled forgetting/decay. The canonical Echo catalogs remain in
      the shared catalog; Farsight's published runtime dependencies remain unchanged. See [ECHO.md](ECHO.md) and
      [the package README](../packages/echo/README.md) for setup, explicit preview-upgrade trust and host trust steps.
18. **The cleanup pass and swarm round 3** (2026-10-11; from the owner's verdict after using the merged round — *"a lot
    of overflow issues; the guided-journey buttons should be fixed at the top; I liked the older drill view and the
    lanes but can't find them"* — then the eight-persona swarm on the result and its two fixes lanes; PRs #93–#96).
    - **The Map's chrome holds still** (#93): the journey head left the zoomable world for a chrome bar under the
      toolbar (`map.js drawHead/headBarHtml`; the world's `HEAD` allowance 150 → 56; the table's duplicated head
      gone); two stable toolbar rows — the levels in short words with the LAYOUT slot fixed, the tools right-aligned;
      the crumb, the as-of stamp, the pickers (inline at ALL, a VIEW menu below) and **WALK at the right end of row 2
      in one pixel box at every stop and width**; one dock (`lib/map-dock.js`: walk · inspector · table part ·
      lifecycle table · compare · about; right by default, 360/320 px, the stage shrinks, never overlapped); the walk's
      stop line and ‹ PREV · NEXT › pinned, ASK at the foot; LAYOUT at JOURNEY = **screens · lanes · table · drill**
      (`drill` = the old action rail over the beats, `?layout=drill`; old `view=drill` links open it); `lanes` at ALL
      with *All journeys* draws every storyline as a stacked band.
    - **Nothing on the Map overflows** (#94): one fold (`lib/fold-row.js` + `fold-model.js`, `strings-fold.ts`) folds
      every chip row by measurement with the verdict chip never folded; the table's cells wrap and `+n` carries a tip;
      the beats grid fits then scrolls inside the stage (its real overflow was the code stop's `code` class matching
      the stylesheet's code-block rule); `pathHtml` keeps a path's two ends with the full path in a tip; a 9 px reading
      floor on the lanes and the street; 233 overlay-era `jrn-*` selectors deleted. Measured on the reference app's
      graph copy (32 shots): clipped verdict chips 80 → 0, elements past the stage 36 → 0, the lanes' smallest text
      6.6 → 9.2 px.
    - **Swarm round 3** (same eight personas, cold, 4477 at `4f82349` sync 112, read-only; reports and
      `_synthesis.md` outside the repo): **8 × TRIAL, fit 6.9** (round 2: 7.0), three leaning ADOPT. Credited by every
      role: one surface from storyline to code with the chrome holding still, the readiness brief with its sign-off
      line, the gate card and the *who may · the record must be* grouping, the lifecycle in words, the beats/table/
      copy-as-call, Compare saying honestly that nothing changed. The score held because the scope defect moved up a
      level: the journey verdict (*passed* on a partly built journey), the readiness header (*12 skipped* vs rows
      summing to 46; HOLD on every row), position words with two denominators.
    - **The fixes** (#96 chrome, #95 words): the READ-ONLY chip never folds; lane names wrap at spaces and pills print
      whole; the Affected bar is a chrome row of its own (its CSS had made the column wrap, which is what pushed WALK
      off-screen); the gate card scrolls and is re-placed when its code loads; LIST THESE lists the tests in the dock
      with spec:line and CSV/JSON; the level's last stop is **LINES** (only the register says CODE); a click closes a
      tip; the dock's lifecycle table stacks. The Changes empty state read a `rows` field `/api/history` never sends; a
      partly built journey prints *partly built · n of m* first and its verdict *over the n built screens* (front
      door *17 journeys passed* → *10 passed · 8 not fully built, so no journey verdict*); the runs line is one
      sentence — on the reference app **389 passed · 9 skipped · 3 no run** of 401 (the synthesis's *29 of them
      passed* were the declaring e2e cases); readiness holds only on a screen not built or the journey's own declared
      case skipped/failed and names the case (still 0 ship · 6 hold: one storyline-wide e2e case declares every
      journey and was skipped), the header says *distinct* with a per-row tip, the register sorts by tier then
      fewest tests; Ask answers *did you mean* with the three nearest shapes, names the entity it picked among
      several, and builds its placeholder from this graph's statuses; identity checks are tier **policy** (the *who
      may* group stays), integrity checks **business**, the tier chip on every gate row; the business register hides
      the copy doors and the model names; *conditions not in plain language* says its scope; *the sync before* skips
      syncs that re-read the same code and an absent green run prints the absence word; the lifecycle's unmoved word
      is *no code moves into* and the table prints *from*; AT RISK names its scope.
    - **The Map uses its space** (#99; from the owner's second look — *"the lanes view is not a good use of space,
      the steps text is too large and the keys use vertical space; the header takes a third of the screen"*): the head
      is two lines plus a clamped description (chrome + head 188 → 153 px at 1920, 1440 and 1280 in all registers; line
      1 name · *for* · storyline position · the status and verdict chips never fold, the rest `+n` whose click opens the
      full row in the dock's *about* tab; line 2 the main record's lifecycle on one line with a glyph for the table and
      `+n record ▸` for a second record); the lanes at the street's density (`LANE_K` 2 → 1 so ×1.0 is the stylesheet's
      sizes, cards 236×96 with a one-line name, the status chip beside it, the test count and scope on one row and the
      verdict on the next; lane heads at the HUD label size; pills one line record · move with the writer beneath; the
      legend flat on the footer row; the lifecycle under the lanes only at ALL); the street floor keeps the picture
      (44 → 95 px) with the name on one line and the verdict one chip; the action stop's screen strip is one line of
      names; compare chips on lane cards are in the fold's keep set and `map-compare:89` waits on `data-laid`/`data-cmp`.
      `e2e/tests/map-space.pw.spec.ts` asserts the head's budget at three widths, the lanes' fit, the legend's shape, the
      floor's one-line verdicts and the WALK box.
    - **Left open:** readiness waivers and a sign-off history; HTTP status pills in business; Compare not measured on
      the reference app (the lane's graph copy had no history store); the screen panel's *WHAT REACHES* line
      duplicates the Affected bar; the gate card can open over the top nav; the *row n* note in an empty lane is words,
      not a link; the sweep's `-screen` shots click a `ONE SCREEN` label that no longer exists.

19. **The outsider demo — can a stranger understand the reference app from Farsight alone?** (2026-10-13; three new
    personas in `.claude/agents/review-outsider-{consultant,customer,board}.md` and their Codex twins, a demo guide that
    lives in the reference app's own repository and knows only what Farsight shows; `docs/review-swarm.md` § *The
    outsiders*; reports, 283 PNGs, the gap log and `_synthesis.md` outside the repo). The guide walked eight stops on
    4477 (`c5a5c7a`, sync 114, read-only) and put eight seed questions to the screens and to ASK; three outsiders (a new
    implementation consultant, a prospective customer's head of operations, a non-executive director) said the app back,
    asked 39 questions, and the guide answered from 120 new PNGs. **Board: PARTLY · PARTLY · MOSTLY, understanding 7/10
    and confidence 6/10 for all three.** Seed questions from the screens 1 · partly 6 · not at all 1; the 39 follow-ups
    12 · 23 · 4; **ASK understood 0 of 8 as worded** (10 of 10 once reshaped). All three were correct on the roles, the
    invoice path, the vendor path, four-eyes and the POC status. All three were **wrong from the business register on
    the two first-order facts** and corrected only through hybrid, the code map inspector, ⌘K's test names and the
    Tests page: *who may approve* (the role guard covers the approve action and a passed test refuses a reviewer, but the
    approve column has no WHO MAY and the gate card reads *a check nobody has put in words*) and *what makes an invoice
    Paid* (ASK, the lifecycle table and the lanes pill credit the payment intent; the code and the passed e2e say mark
    paid). Operator screens draw in the Contractor lane; vendor approval is never credited with Pending → Active; the
    invoice journeys' head shows the outbox lifecycle. What none could learn because Farsight has no slot for it: the
    client persona (receives, approves, pays the consolidated invoice; two personas in the tree), what is configurable
    and by whom, the money's counterparties (the payment partner, who verifies bank details), separation of duties,
    the audit actions, the correction request's lifecycle, the domain glossary. The synthesis sorts the worklist into
    four bins — Farsight defects (A), Farsight features missing (B), reference-app knowledge to add in its manifest,
    config and tags (C), and reference-app product findings to pass to its session (D: a self-registered vendor is
    queued to the ERP before approval, no reject path, no separation of duties, no amount limits).
    **The eight personas then proposed how to address it** (`_proposals/` and `_worklist.md` outside the repo) and found
    the root causes, which the lead verified in the code: the Paid move is credited to the payment intent because the
    only PAID writer is called there under a constant the code sets to `false` (the parser reads the dead branch as live,
    and every surface takes the *first* place a writer appears); WHO MAY is missing on the approve column because
    `core/query.ts` merges a screen's gates by name onto the first occurrence and unions `requires` (the data is in
    `meta.requires` already, and the guard carries a `@business` sentence the gate card never falls back to); the
    readiness brief's *0 of 6 ship* is `foldRuns()` taking the weakest status across browser projects, so a desktop pass
    plus a viewport-conditioned mobile skip reads as skipped. **The worklist:** Farsight wave 1 = F1 credit a status move
    to the live path that writes it (constant-false branches inactive; never first-occurrence; positional-literal and
    ternary writers) · F2 a gate at every action it guards with that site's `requires`, card titled by the app's words,
    a register-parity test · F3 a skip with its own condition on one project is not a skip of the case, PASSED paired
    with the brief's reason · F6 business words from what the app wrote; wave 2 = F4 the role × action table with the
    pinning tests quoted · F5 `screens[].persona` / `personas[].routes` · F7 ASK shapes as worded with the rewording
    shown; wave 3 = F8 `decisions[]` + off-platform steps (`by`) + party externals · F11 cited ADRs quoted. Recall pack 1
    (slots exist) = lifecycle views from `displayStep` · `gateTiers` + `@guard`/`@business` on the role tables and the
    duplicate match · a glossary keyed by table written against the code · `@covers` on the specs that pin controls;
    pack 2 = the client persona on the existing `client-portal` surface + persona per OPS screen; pack 3 = qualified
    decisions. Rejected by consensus: a configuration or environment view now, silent noun-mapping in ASK, reading
    `displayStep` automatically, model-written summaries, counting role holders. Re-run bar: confidence ≥ 8, zero wrong
    answers on who approves and what makes Paid, the outsiders driving the business register themselves first.

20. **The outsider fix round — the worklist's Farsight side, in seven lanes** (2026-10-13 → 10-14; PRs #105–#111 plus
    Dependabot #98; every lane measured on a read-only copy of the reference app's graph with zero page errors; the
    briefs in the private round folder's `_lane-briefs/`). **Build `fb503d7`**, both servers restarted and re-synced
    (4478 sync 73, 4477 read-only sync 115).
    - **A status move is credited to the live path that writes it** (#111): a call under a constant-false flag is
      `inactive` (`meta.whenFlag/whenValue/whenAt`, technique `flag-gate`), every live path to a writer is credited with
      the direct one first (*also reached from n*), a status-named setter with a positional literal and a ternary of
      literals are writers, a route file's own handler counts as the route, a writer met a second time still moves; a
      *Switches* section (`count.unit.switches`); the one-fact harness (`server/test/one-fact.test.ts`) asks lifecycle · ASK
      · tour · lanes · gate card the same question. On the reference app Paid is now credited to *Mark a distribution
      paid* everywhere, with *Record the payment intent* printed as *switched off: PAYMENT_INTENT_MARKS_PAID = false*;
      the vendor account's *Pending verification → Active* and the identity link's *Pending* have writers.
    - **A gate at every action it guards, the card named in the app's words, the role × action table** (#107): the segment
      fold places a guard under each action with that call site's `requires` (it merged by name onto the first); a role
      list declared as a typed array is read; the gate card's name falls back to `@business` → `@guard` → *unnamed*; a
      register-parity e2e; core `roles.ts` → `GET /api/roles` (+csv), MCP `roles` (core tier), `farsight roles`,
      `#/roles`, a *who may do what* section on the gate card. Reference app: the approve column reads *WHO MAY · approver
      role*; 27 rows; vendor approve = approver or admin, invoice approve = approver alone.
    - **A case skipped on one browser project by its own condition passed where it ran** (#108): `foldRuns()` keeps the
      projects and the skip reason; readiness holds only when no project passed and quotes the reason; PASSED is paired
      with the brief's hold line. Reference app's invoice brief: 0 ship · 6 hold → **2 ship · 4 hold**, the holds now the
      live-only cases, named.
    - **A persona per screen** (#105): `screens[].persona`, `personas[].routes`, `personas[].signsInWith`, else the
      sign-in guard's `@group`, else the journey; `screenPersonas` on `JourneyRow`, `summary.user[]`, lanes, WALK, street
      head *For A · with B*; conflicts are notes. Reference app: operator screens in the Contractor lane 5 → 0 with no
      declaration (the guard rule).
    - **ASK reads a question as worded and shows its rewording** (#110): three new shapes (*who may*, *can … be
      configured*, *what happens to … once it is …*), `readAs()` over a closed rule list with *I read that as: …* first, a
      47-question corpus test; business words (a design id becomes the screen's name, holes read *(a value)*, refusals
      in words, the readiness register in words). Reference app: the eight seed questions 0 → 8 of 8.
    - **Declared decisions, off-platform steps, party externals, cited documents quoted** (#109): `decisions[]` joined to
      `DECISION(<id>)` comments (`/api/decisions`, MCP `decisions`, `farsight decisions`, chips on the gate card, property,
      WALK and lifecycle), `screens[].steps[].by: person|partner|external`, `externals[] kind: party`, `doc` nodes with the
      first paragraph verbatim and `cites` edges. Reference app: 16 DECISION comments → 7 ids D3–D9 *named in code, not
      declared*; 32 docs quoted (20 ADRs).
    - **Housekeeping** (#106, #98): six dead overlay rules (the rest of `jrn-*` is live — the Map reuses the drawing); a
      stale handoff line; the MCP SDK 1.31 bump; the two OpenTelemetry alerts come only through Echo's pinned engine and
      need an upstream release or a forced override (left to Echo's owner); `pnpm install --offline` in a fresh worktree
      takes 3 s.
    - **Left open:** the Recall-side declarations (the handoff prompt is in the private folder, `_recall-handoff.md`); a
      switch is read only from a bare-identifier test; the weekly-cycle head now leads with *distributions*; `roles` is
      not a frozen contract; the `configure` ASK shape matches on words; a party lane's cards are shorter than persona
      cards; the `?screen=2` cold-load race; e2e `map-keys` ⌘K and `map-street:410` each flaked once under load.

## Release and CI — 2026-10-01

- **Releases are on demand.** `gh workflow run release.yml -f bump=patch|minor|major` (or the Actions tab; `-f dry_run=true`
  rehearses) runs the gates, bumps the root version, writes `CHANGELOG.md` and the release notes from conventional
  commits (`scripts/changelog.mjs`), commits `chore(release): vX.Y.Z` as `github-actions[bot]`, tags, packs, smoke-tests
  the tarball (`--version` must print the release commit; an ingest must succeed), pushes, and publishes a GitHub Release
  with `farsight-cli-X.Y.Z.tgz`. npm publish runs only when an `NPM_TOKEN` secret exists. → `docs/RELEASING.md`.
  **v0.1.1** is the first release (2026-10-01); a consumer install from the release URL into a clean prefix printed
  `farsight 0.1.1 · commit 00b18dd` and ingested the invoice-app example (87 nodes). (Until 2026-10-04 PRs were
  merged with merge commits so the changelog could walk every commit; since then PRs are squash-merged, below.)
- **Since 2026-10-03 a release is a release PR** (`main` is protected, no bypass): `release.yml` opens
  `chore(release): vX.Y.Z` from `release/vX.Y.Z` (version commit + `CHANGELOG.md` + `.github/release-notes/vX.Y.Z.md`,
  gates and smoke test already run); merging it runs `publish.yml`, which tags the release commit, packs, smoke-tests
  and creates the GitHub Release. A PR opened with `GITHUB_TOKEN` does not start CI — close/reopen it, or add a
  `RELEASE_TOKEN` PAT (`docs/RELEASING.md`). **Rehearsed for real with v0.2.0 (2026-10-04):** the workflow's gates and smoke test passed, PR #36 opened, its CI did
  not start (no `RELEASE_TOKEN`), a close/reopen started it, a merge commit merged it, publish.yml tagged `v0.2.0` and
  published the Release with `farsight-cli-0.2.0.tgz`. Add a `RELEASE_TOKEN` PAT to drop the close/reopen step.
- **Since 2026-10-04 PRs are squash-merged and the convention is enforced** (PR #38). `main` accepts only squash
  merges — GitHub settings: merge commits and rebase merges off, squash title = PR title, squash message = PR body,
  linear history required, branches deleted on merge — so one PR is one commit on `main` and one changelog line. The
  PR title must be a Conventional Commit and the body follows `.github/PULL_REQUEST_TEMPLATE.md` (*what changed · why ·
  how it was checked · left open*). CI's fourth job, **`commits`** (required), lints the PR title against the type and
  scope lists and every branch commit for shape (`scripts/lint-commits.mjs`, `pnpm lint:commits`); `pnpm install`
  installs the same lint as a `commit-msg` hook and sets `.gitmessage` as the commit template (`scripts/install-hooks.mjs`
  copies into `.git/hooks`; the LFS hooks stay). `changelog.mjs` turns a squash subject's ` (#N)` into a PR link;
  publish.yml finds the release commit as `chore(release): vX.Y.Z (#N)` and tags the squash commit. The lead merges with
  `gh pr merge <n> --squash`, keeping the title — the project skill `.claude/skills/git-pr-flow` carries the flow.
- **CI on every push and PR** (`ci.yml`): validate (install, build, typecheck, tests, string lint, ~1 min) and e2e
  (Playwright chromium, 109 specs, ~1.5 min) in parallel on Ubuntu; artifacts on failure; the live tracker tests skip
  there. First run on `main` green. → `docs/CI.md`. Watch: `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19.

## Next work, ranked

**Nothing is in flight (2026-10-14; the outsider fix round, item 20, is merged, packed, installed under both prefixes and live on both servers). Next: the Recall session runs the handoff prompt (`_recall-handoff.md` in the private round folder — packs R1–R7), re-stamps and re-ingests, restarts 4477 read-only; then the outsider demo re-run (same three outsiders, driving the business register themselves first; bar: confidence ≥ 8, zero wrong answers on who approves and what makes Paid).** Echo's PR #84 merged after a second review found its four blocking
items fixed (the reviews stay outside the repo); lane S (#99) closed the cleanup pass. Next, in order: (1) a handoff prompt to
the reference-app session — install the build, add `gateTiers` and `lifecycle.<record>.views` blocks to its
`farsight.config.json` (today approve shows *18 that matter* because its `@guard` labels default to *authorisation*,
and its lifecycle words are humanized constants), re-run its suites with the reporters, restart its server
`--read-only`; (2) **swarm round 3** — the same eight personas, cold, on that build and sync, asked *do you trust what
it tells you* and *what do you want next* (target fit 7.5; *which scope* absent from every report; the five stops, the
lanes, the tour and the compare are what is new since round 2); (3) the left-open lists above, the swarm's wanted features first (Ask free-form, readiness waivers and a sign-off
history, Compare opening on a real change in business sentences, publish and subscribe, the Affected list from a
PR in the UI). **Beside the round:** PR #84, *Farsight Echo*, an optional
memory companion by another agent, was reviewed on 2026-10-11 (the review stays outside the repo); it merges after its
blocking items are fixed and main re-merged. The server-side query API round (`/graph` at 245k nodes) stays next after
the swarm.

**Swarm round 2 (2026-10-06, the same eight personas, cold, on the reference app's own server at `81a455e`, sync 108,
`--read-only`, after the application re-ran and stamped its own suites; reports and `_synthesis.md` outside the repo) —
8 × TRIAL, fit mean 7.0 (6.5–7.5; was 6.4), the champion and the onboarding dev leaning ADOPT.** Credited by every role
in their own words: one verdict for a journey across the Map, the journey, the Portfolio and Tests; *current as of sync
108 — the tests ran on the code as it is now*; the gate card (*the best panel in the product* again); *step* as the
storyline position; Settings named; the stamped exports; the branch. **What holds the scores is the same defect one
level down — a number whose scope changes between surfaces without saying so.** Ranked, convergent first:

1. **A scope word on every test number that can sit beside another** (7 roles) — the Map property's *323 cases ·
   passed* beside the drawer's *NO TEST REACHES THIS PART · 125 reach the action*, impact's *2 tests* and the gate
   card's *16* for one screen; *no test is known to reach*; one phrasing for the declaration verdict (four today);
   the matrix cell's *0 tests · 29 passed*; skips on the chip when non-zero; the matrix's level filter filters the
   rows; the CSV's `evidence_class`/`status` words equal the screen's.
2. **A not-built screen never carries *passed*** (BA blocker, QA, newdev) — *Tracking — paid* is *designed, not built*
   with *passed · 111 test cases*; the Paid journey's screen 3 has *0 actions · calls: none indexed* beside *22 cases*.
3. **Commits, one sentence with both facts** (7) — Settings *282 commits indexed* vs Changes *242 of 282 never
   ingested*: *read into history* and *ingested by a sync* are two facts; say both, the same on both surfaces.
4. **Read-only means every write** (6) — Work's *Sync now*, *Sync & re-ingest*, *Add source* and its inputs, the
   theme hint still look live under the banner.
5. **Sums and arrows name their scope** (5) — per-screen counts beside journey totals need *distinct*; `→ n` differs
   between the full board and the storyline board with one tip; *6 journeys* vs *journey 3 of 5* (the branch); the
   gate card's *34 of 75 calls* beside a list of 68; *×9* in the list vs *16* on the card.
6. **`step` is back on the Tests page** (6), *beats*, one screen's *3 stops*; **the lifecycle strip and the verdict
   hover in business words** (5) — raw status constants are the first thing a business reader sees.
7. **The gate card scrolls** (two roles could not reach its tests section); one gate word per panel (*gates & rules* ·
   *checks and rules* · *guard* · CHECK); the Map's Gates tab counting 5 and listing none; setup switches still
   listed as a screen's checks (the config-check rule misses a shape).
8. **Layout at 1280** — the sticky journey header covers the first card; narrow Map cards drop chips with no `+n`;
   `#/settings` and the property tab in the address; the keymap lists keys twice; a light print stylesheet for the
   PDF; the `{owner}` placeholder in the owner tip; Esc out of a journey re-lays the board.

**What they want next — 24 features, clustered, by how many roles asked:** **A** (6) the PR / diff → what it touches →
the deduplicated tests to run, posted to the PR with the Affected link and the stamped PNG (`farsight affected --pr`;
the champion's *release readiness brief* and the PO's *what happens if we change this* are the same engine with a
business page); **B** (5) compare two syncs on the storyline — delta chips, a semantic diff (a route that lost a guard,
a status that lost its writer, a step whose tests went green → skipped), a dated A → B PDF, a failing CI check, the
Monday report; **D** (5) the readiness / audit pack per storyline (requirement → code → gate → contract → verifying
case with verdict and date; a rules register to sign off; XLSX/PDF stamped); **C** (3) publish and subscribe —
Confluence / a Jira epic panel refreshed on every sync, a weekly Teams/Slack digest; **G** (3) write-back — exploratory
findings filed to the tracker, a *what-if* step drawn dashed, bypass paths drafted as negative tests; **F** (newdev) a
guided tour from the storyline and plain-language questions answered with evidence links; **E** (staff) a CodeLens
gate card with *run these tests*; **H** (exec) a cross-repository portfolio by owning team with a cost proxy. A and B
share one engine (Affected over a commit range + the snapshot store); D is the page on top of both.

**The order:** the eight trust items first (one lane each or paired — the next swarm catalogues them again
otherwise), then the feature round A → B → D → C → E · F · G · H, and the server-side query API round
(`/graph` 411 MB at 245k nodes) when the Map or the code map hits it.

**The 2026-10-05 swarm (eight personas, cold, on the reference app's own server at `4a44f4c`, judging only from
their own screenshots; reports outside the repo) — 8 × TRIAL, fit mean 6.4 (5.0–7.0): the storyline and the doors are
credited by every role (*the best "how our business runs in software" picture*; *beats grep for the call chase*), and
the same two things hold every score down. Ranked, convergent first (all nine worked in the swarm-fixes round, item
14; what each left open is listed under *The swarm-fixes round left open*):**

1. **One verdict per test cell** (6 roles) — *passed, by its own declaration · stale* beside *no test reaches this
   step*, *last run: skipped* and a tip saying *verdict unknown*; one file:line with two verdicts on two surfaces; the
   Tests matrix printing PASSED beside *skipped*. One evidence word computed once, printed the same everywhere.
2. **Stale, said once and only when true** (5) — all 18 journeys, every Portfolio row and all three test levels say
   *stale* / *no source digest* with no sentence saying against what; Settings *history 0 commits read* contradicts
   Changes *242 of 282 never ingested*.
3. **One word per position** (6) — *step* means the storyline position, the drawer's walk index (*STEP 232*), the
   drill's *stop*, the code register's *983 steps*; action counts disagree with the sheet's columns.
4. **A gate answers its click** (6) — today it turns amber or opens its service; the doors hide behind ▸; no gate →
   the call it guards → the tests that reach it; config checks listed as a contractor screen's gates.
5. **Chrome** (6–7) — Settings behind an unlabelled sun icon and absent from ⋯; a READ-ONLY session still offering
   *Sync*, *Save*, *Add source*; the Map legend opening over the board on every visit; the Sheet's *verified by* row
   overflowing; the Experiments row one word wide; the toolbar overflowing at 1440; `?` with four jobs; business
   opening on the Sheet.
6. **Storylines, second pass** — a branch kind for the correction journey (drawn as an ordinary step); an unknown
   `?storyline=` says so; ⌘K finds storylines; thumbnails on the cards; test evidence on the storyline board; the
   record's status lifecycle derived from the code. (The reference manifest's own step order — *Paid* before *Weekly
   consolidation* — was the lead's error and is fixed there.)
7. **Data holes the BA found** — the mark-paid and approval screens show *0 actions · 0 gates · calls: none indexed*
   while the street lists `POST …/mark-paid` under them; the e2e card badged VITEST over Playwright files and saying
   both *unknown* and *changed since the run*.
8. **Export** (3) — PNG/PDF of the storyline board, the storyboard and the Portfolio; a pinned, dated link.
9. **Business register, last ~30 words** — and ADR numbers kept as citation keys in every register.

**The swarm-fixes round left open (2026-10-06), by lane:**

- *Verdict:* a step no test reaches still prints *no test reaches this step* beside the action's own count (two
  scopes by design since 2026-09-25; four reviewers read it as a contradiction — a sentence that names both scopes is
  the fix); the Map property's per-case rows keep their own per-case labels; the scoped case list caps at 200 rows.
- *Freshness:* *stale* is repo-wide because the digest covers the whole source (per-journey needs the commit spine's
  touched files at fold time); the sentence names the two commits, not how many lie between; the AT RISK bar prints
  its shared sentence only when every stale journey compares with one code commit.
- *Words:* the front door's Designs/drift table and entry-point lists still print routes, design ids and file names
  in the business register (46 tokens); Portfolio descriptions keep `CON-01 to CON-08`; *the runtime container* and
  the API title are names the reference app wrote (rename or tag there); the `step=` URL parameter is a screen
  ordinal (renaming it touches many specs); `history.ts`'s *run `farsight ingest`* note still prints raw backticks on
  Changes; the business gate row has no tip with the team's original label.
- *Gate:* the drill lanes do not draw config checks; the card cannot say which test exercises the refusal path (no
  branch-level coverage); the card is not exportable and cannot seed Affected; a guard that reads its settings through
  a helper is not recognised as a config check.
- *Chrome:* a focused button that has a tip (`⋯ N`) opens it only on hover now (Enter presses the button); the work
  pane's write controls are not greyed on a read-only server (the server refuses them, the pane does not say so
  first); "nothing here" is still drawn three ways; the `mapLegendSeen` e2e fixture is dead; a reader who tabs directly
  onto a band header's count loses focus when a walk redraws it.
- *Storylines:* at board zoom the branch label can run past the band panel; the dashed return line is faint; the
  legend does not list *branch* / *back to*; cross-source storylines.
- *Data:* the approval (verified) state could say *its page makes N calls* instead of *calls: none*; handlers passed
  through render props or spreads, a `fetch` written inside the handed function, and member-call handlers
  (`mutation.mutate`) are not credited; lifecycles do not yet read Postgres `CREATE TYPE … AS ENUM`, Drizzle `pgEnum`
  or an INSERT's literal status; the prior status is blank when the writer compares two records; one lifecycle per
  record (the `status` column first); a property screen that reaches a record only through a repeated call shows no
  lifecycle.
- *Export:* the server cannot draw a pinned sync on demand (only `--as-of` at start); the Portfolio CSV is the cells'
  text, not typed `Counted` columns; cross-origin images (Figma URLs) stay empty in the picture; pictures past the
  canvas limits are scaled, not tiled; the Map export leaves the board fitted.
- *CI:* the e2e suite is timing-sensitive under load (four specs failed once each on a loaded machine and passed
  alone: `codemap-projects` where-is, `journey-ladder:60`, `map-journey-links:120`, `map-zoom` pinch); two races were
  fixed this round (#71, #67) — the pinch test's timing lives in `lib/map-canvas.js`.

**The 2026-10-05 round left open, first:** the `/graph` payload at scale (411 MB for 245k nodes) — a server-side query
API with the index semantics the viewer folds today is the next ceiling and a round of its own; the Map reads its
journeys one at a time (300 journeys > 30 s), `/api/tests` without `lean=1` is 243 MB, a code-map card click re-lays
out the whole map (~0.4 s), the first ⌘K keystroke within 0.5 s of boot waits for the index; the street's number chips
are not doors yet (a click opens the screen); a non-verb fetch helper that sets the method inside its own body is not
followed; cross-source storylines; a design row has no address of its own on the front door; the reviewer swarm on
this build (front door, Map with a storyline, the doors) is the next thing to run.

**The Map clarity pass left open (2026-10-04):** *at risk* shows on 18 of 21 cards on the dogfood graph (most
journeys there are stale — a second, quieter mark for *stale alone* may read better than one word for two facts);
with many more journeys on a small window the card text shrinks with the fit (nothing keeps it above 8 px); the layout
swap on a gesture is not animated (the neighbours snap); no e2e guard for the board-stop fix (the fixture shows no
risk headline); the Map's `h`/`l` keys walk model order, not persona-band order.

**The journey-organisation pass left open (2026-10-04), first because it is what the owner asked for:** declare
`personas` and `groups` in the reference app's own manifest (outside this repo) — today its three persona strings
are undeclared and every journey sits in *Other journeys*; the pass is only proven when *Access* leads each persona
there. Then, smaller: a nested config's `stores[]` catch-all still names every unnamed table in the source (declarations
are not scoped); a nested `storybook` without `configDir` is taken as `<dir>/.storybook`; the root file's own paths
are not checked for escapes; the Settings page has no *Config files* list (`/api/config` is ready); a flow placed in a
group that belongs to another persona drops to *Other journeys* with no note; two NX apps on the same route still
collide under route-only matching; the Map's `h`/`l` keys walk model order, not persona-band order; the echo card's
dashed border is faint at board zoom; a JSON schema for the config and the manifest (`schemas/`) would let editors
validate the many files this pass creates.


**Reported 2026-10-04 by the reference app's session, after 0.2.0 was installed there — a parser regression, first:**
a `fetch(url, helper(ctx, { method: 'POST', … }))` call, where the method literal sits in an object-literal argument of a
wrapper call rather than in fetch's own init, resolves to the **GET** route of the same path (the fallback is *no method
→ GET*; `apiInit(ctx, { method: 'GET' })` happens to be right). On the reference app design drift went 7 → 19: twelve
false *unreached POST / undeclared GET* pairs over five client functions (create submission, session from magic link,
ops invoice, two vendor-account creates). The 2026-10-01 build resolved these correctly on the same code, so it is a
regression of the data-stores pass (#15–#18). `packages/parsers/src/tsjs.ts`, the `fetch(` site: when the init argument
is a call expression, read a `method:` string literal from its object-literal arguments (spreads included), the way the
class-method path already does; a helper whose name is a verb (`post`, `put`, `patch`, `del`) is a fallback. A test with
that exact shape, then re-measure read-only on the reference app (drift back to 7, http edges to routes still 69).

**Left open by the code map performance pass (2026-10-04), small:** the app view narrows by the closure alone (a
kept project or tag filter no longer applies inside it — its chips are hidden there and would have emptied the tree
quietly); the toolbar gets crowded on a 1600 px window with tag chips on (they are cut off left of GROUP); a folded
file group's row in a box is taller than its card (gaps, no overlaps); a stale NX cache file is read as-is (its age is
not compared to the manifests); the viewer does not yet read `ProjectRow.closure` from `/api/projects` (it computes the
same tree from `meta.projects`, proven equal by test); `farsight deps list` does not print the NX-graph line (only MCP
`graph_overview` does). A broader thought the pass raised: `/graph` still ships the whole 48 MB graph to the browser and
every surface folds it client-side — the next ceiling is a server-side query API with the same index semantics.

**Left open by map pass 2 (2026-10-04), in order:**

1. PR #32 landed the round-2 blocker and its convergent findings (`_synthesis.md` in the private review folder has the
   ranked list); the lead re-checked the widest journey on 4477 by click, plumbing, link and `j` — all keep it. Still open:
   an export of the affected set for CI (a commit/PR seed with a deduplicated test list, `farsight-affected v1` once
   frozen), PNG/PDF of the board, screen tabs and *Where is it included* in the URL, a file:line on screen cards, the
   Tests page's *no source digest* warning on the cover, the word for `sql` stores in the business register; the
   three dependabot alerts were fixed on main in #30 but GitHub had not re-evaluated them at session end — dismiss
   as fixed if they are still open.
2. **Small things the lanes left:** the band label slips under the Affected bar on an already-framed street; the
   edge cue can overlap a card's evidence chip at ×0.52; the Code lens makes no visible change at journey zoom; the
   project and tag filters are not in the URL (group and view are); third-party packages in *App and its related* can
   land behind the inspector; imports from test and story files are not read; Java Maven/Gradle packages; X's
   project-dependency fold could read D's `imports` edges instead of re-scanning; `farsight-deps` is `v0`, not frozen.
3. **Journeys defects the comparison surfaced:** the rows / ladder switch is undiscoverable; a journey opens on the
   Sheet, where business readers give up; the *records* row per store once a journey touches two.

**Left open by the map-view and data-stores passes (2026-10-03), in order (still valid):**

1. **Run the pass swarm** on the dogfood server with the map on (one build, one sync): can a reader new to the
   reference app find a screen from the neighbourhood, say what it does and which stores it touches from the street,
   and act from the property?
2. **Image paste / upload** from the property placeholder, written into the source's design manifest (the bonus
   stream agreed on 2026-10-03).
3. **Map polish the real graph asked for:** route *leads to* curves between bands; raise the cover cap or base size
   past 30 journeys; per-screen work chips (one `/api/work/links?node=` per screen, cached); Impact in the explore
   card; the explore card for gates and tests; `⌘K` arriving on the map; export of the street as PNG.
4. **Data stores, next steps:** the journey band and ladder could split the *records* row per store once a journey
   touches two (today the row key stays `records` and only the map groups); `stitch.ts` cannot match a `? path` stub
   across sources (a call with no method on a shared path whose routes come from a spec in another source stays a
   stub); the three `unknown` stubs left on the reference app, and `/api/work/*` on Farsight itself, are routes the
   parser does not read as routes — a route-table reader for that shape.

**Left open by the work-items pass (2026-09-30), in order:**

1. **Run the work-items swarm** on the dogfood server against real tracker items: does a reader see
   what work changed what code, and can they act on a story from the pane? (Can share the build and sync with the
   map swarm above.)
2. **A real key in a real repo.** Put `KAN-…` keys in Farsight's own branch names and subjects from now on (the
   detector needs the project in a work source's scope), and give the reference app a `@work` / `screens.json work[]`
   declaration for one flow.
3. **Small gaps the lanes reported:** the `no-code` finding and links from tracker URLs in item bodies to pages/routes;
   the see-impact button seeds one touched part at a time because `/api/impact` takes one seed; ⌘K matches work nodes
   by key and title only; no create/label/link controls in the pane; the work e2e specs run on a stub, not the fixture
   provider; providers do not yet read `Session.schema` (ADO re-discovers every sync); `WorkCache` lacks
   `replaceLinks()`/`listPeople()` and a `dropped` intent state (drop and rebase record `failed`); the item answer's
   `user` is missing on the hybrid list card; source card titles print the provider twice; the Jira live test leaves
   `live-…` labels on KAN-3; a 503 path test for the work routes.

**From before this pass** (the story swarm's list after the 2026-09-27 pass):

1. **Re-run the story swarm** against one build and one sync of the reference app to re-score *where to go next*
   (1.9) now that evidence agrees with itself and owners are declared.
2. **The application's own change story.** Changes still shows re-syncs, not the application's commits: surface the
   commit spine per flow. Syncs recorded before the per-source digest column read *re-indexed*; only new syncs can say
   *tree-changed*. The journey header still says *1 test named by a run* for a pass by declaration — it should use
   `observation.declared` wording.
3. **Business register, last mile.** The glossary lands on `Class.method`; the identifiers that still print raw (gate
   names, record rows, *other ways in* paths, Tests-page terms) need words — the rule stands: words a person wrote or
   `humanize()`, never the identifier.
4. **An e2e report without a source digest** reads *no source digest was recorded* on the e2e card; a consumer
   stamps its report with `farsight tests import … --stamp` right after its run (never an old run with today's
   digest — that would be false evidence).
5. **Export**: PNG/PDF of the Storyboard and the Portfolio table, a pinned link; the matrix CSV exists, the rest
   does not.
6. **Narrative vs code as a finding.** When a flow description and the code disagree, the tool should show the
   disagreement with both provenances (the first instance of the documentation-as-source direction below).
7. Small: `journey-ladder.pw.spec.ts` can read column widths before the ladder draws when run beside
   journey-numbers (needs a wait on `.jrn-laddercell[data-seg="1"]`); MCP still lacks attribution/history
   spine/`gate`; `farsight-impact-tests v1` reports `evidence_class: observed` for a declared e2e case that passed
   (enum unchanged, data changed — review if a consumer pinned the old data).

## Direction noted 2026-09-27 — documentation and pre-code steps as a second source of truth

A gap in the product is that the graph's only source of truth is the code. A flow also has a life *before* code —
requirements, designs, decisions, work items — and documentation *beside* code. Farsight should be able to take
source of truth from both: the code as today, and documentation that is either **Farsight-enabled** (annotations the
way `@business`/`@group`/`@covers` already are), written in **Farsight's own format** (the way `screens.json`
declares planned flows and `openapi.yaml` declares contracts), or pulled from **other data sinks — Azure DevOps,
Jira, databases, memory stores**. Principle 1 holds: a documentation or work-item adapter emits the same schema, and
every lens is a view over one graph. Principle 2 bends, not breaks: where a document and the code disagree, the tool
shows the disagreement as a finding with both provenances rather than letting either silently win. Existing seams to
build on: planned journeys (`via: 'planned'`, declared operations), the design manifest, the OpenAPI post-pass,
`@covers` claims, and the `journey.absent.notIndexed` word that names exactly what such an adapter would bring in.
The first adapter, work items (`docs/proposals/work-items-sync.md`, with two research appendices under
`docs/proposals/work-items-sync/`), shipped on 2026-09-30.

## Direction noted 2026-09-30 — live tracker connections are the check, and the credential names

The work-items adapter is validated against **live** trackers, not only the fixture provider; the fixture provider
stays for CI.

**Credential naming.** One macOS keychain *service*, `farsight`; the *account* is `<provider>-<instance>`, where
provider ∈ {`jira`, `ado`} and instance is the site or org slug. Settings reference them as
`keychain:farsight/<account>`; the secret is only the token or PAT, never the user — the Jira user email lives in
settings as `auth.user`. Linux `secret-tool` and Windows DPAPI use the same two strings.

| tracker | keychain account | setting | what the secret is |
|---|---|---|---|
| Jira, example.atlassian.net | `jira-example` | `keychain:farsight/jira-example` | an Atlassian API token (≤ 1 year) |
| Azure DevOps, dev.azure.com/example-org | `ado-example` | `keychain:farsight/ado-example` | a PAT scoped to work items read (write later) |

Written by the person, once: `security add-generic-password -U -s farsight -a jira-example -w '<token>'`.
Read by the adapter: `security find-generic-password -s farsight -a jira-example -w`, in its own process.
**The keychain is the only home for a secret** — no env vars, dotfiles, settings values, docs or transcripts,
because those are what AI sessions and other tooling read easily. The `env:` form of the setting exists for CI, not
for a developer machine. A session checks a live tracker by running the tool (or a probe script) that reads the
keychain in-process and prints only the outcome, never the value.

**Decisions taken on the proposal's §13:** writes are exercised on the Jira test site only — on the Azure DevOps org
only `validateOnly` dry runs, never a real write. Per-user credentials; agent writes attributed *via Farsight
(agent)*. ADO *Resolved* → `in-progress`, name kept; the category set stays four. ADF converter: paragraphs,
headings, lists, code, links, mentions, simple tables; media as references. Retention: keep everything. Keychain via
the `security` CLI in-process (`secret-tool` on Linux, DPAPI not built). Key shapes: Jira `[A-Z][A-Z0-9_]+-\d+` bare
/ `#KEY-1` / `[KEY-1]` / `KEY-1:` / any `…/browse/KEY-1` URL; ADO `AB#4711`, `#4711` only when an ADO source exists,
and `_workitems/edit/4711` URLs; the same shapes in branch names.

## Where the detail lives

| file | what is in it |
|---|---|
| `docs/COUNTS.md` | **the counts ledger** — every number the product prints, its function, unit, scope and siblings |
| `docs/MAP-PACKAGES.md` | what lives in which package, file by file |
| `docs/MAP-VIEWER.md` | the viewer's modules, the journey's four views, the band mechanics |
| `docs/proposals/` | how each design was argued before it was built |
| `docs/contracts/` | the frozen machine contracts (`farsight-diff v1`, `farsight-tests-matrix v1`, `farsight-impact-tests v1`, `farsight-work v1`) |

When you finish a pass, add its summary to *What shipped most recently*, keep this file short, and keep the dated
detail (measurements on a client app, review evidence, session handoffs) outside the repo. It is read in full at the
start of every session.

## API delivery policy — 2026-10-21

Branch `codex/gap-api-policy` adds a separate reconciliation `policy` without changing raw operation
lists, counts or graph node contracts. API diff supports `--phase` and selective
`--strict=missing,undocumented,notes`; config supplies `openapi[].phase`, `phaseOrder` and root-only
`internalRoutes`. Unknown phases remain missing. ADR 14 and the walkthrough describe the public contract.

Checked in an isolated worktree with Node 24/pnpm 9: workspace build; affected CLI/parser typechecks;
32 focused core/count/CLI tests; 12 parser OpenAPI tests; catalog lint and commit-title lint passed.
Reference-app acceptance, main comparison and browser validation belong to the integration pass;
no global install, primary build, live-server restart or reference-source edit was performed here.

## API guard and multipart vocabulary — 2026-10-21

Branch `codex/gap-api-vocabulary`, based on the delivery-policy commits, reads operation `x-guards`
against enforced guard names/ids and existing config `guards` labels/matchers. Missing declarations and
missing enforcement remain distinct differences. Reconciliation reads direct handler guards and then
only proven delegate links; route-only declarations do not prove enforcement. Root `validators` lists
exact multipart-reader names/ids and requires an actual same-source calls path for a multipart body.
No new graph field or speculative validation edge is emitted. ADR 15 records the contract.

Focused core/parser/CLI API suites (31 tests), affected builds/typechecks and catalog/title lint passed.
The real application's contract/config declarations remain an owner follow-up; this branch contains
only generic fixtures. Parent integration owns real-ingest comparison and browser validation.

G3 review follow-up: inactive guard edges and inactive direct/delegated handler or reader calls no longer
earn enforcement/body-validation credit. Regressions cover every hop and preserve an alternate active path.

## Test evidence import follow-up (2026-10-21)

Branch `codex/gap-test-evidence`: sequential results imports preserve other projects when a reporter reuses one
results path. `--replace` clears all prior projects from those paths. Exact joins respect the report's file;
ambiguous parameter templates stay unjoined, and a reporter-recorded declaration line may identify one unique
template. Empty coverage keeps metadata without a warning. Coverage remains run-level evidence, even when a
separate results file says a route case passed. Generic regression fixtures cover the distinction.

Validated with Node 24 / pnpm 9: complete build, workspace typecheck, string catalog lint, and focused parser
test-evidence suite. The integrating lead owns combined CI checks and real-application ingest comparison.

## Packaging prerequisite follow-up (2026-10-21)

Packaging now prints `pnpm build && node scripts/pack.mjs` when compiled workspace entries or the core version module are missing,
before touching prior build artifacts. The regression test uses a disposable unbuilt checkout. Release docs
show a pinned GitHub tarball install for CI and distinguish a release commit from subsequent `main` changes.
MCP already reports its running build in `graph_overview`; `refresh_graph` already re-ingests and reloads,
so upgrading the process still requires reconnecting it.


### Canonical scanner drivers (2026-10-22)

The internal Pattern, OSV, Trivy and zizmor drivers now use the coordinator's existing trusted driver registry.
They require exact shipped rule definitions, engine pins, captured input scopes and explicitly held database/checks
provenance. No driver acquires assets or starts an engine directly. Missing assets refuse preparation and cannot
produce clean coverage; the public CLI and capability manager remain integration work. Normalized findings/reports
are source-derived and publish with per-check coverage in the accepted worker attempt. The small seam delta exposes
the exact supervisor outcome frozen in place, permits validated actual-read refinement within sealed captured scopes,
and preserves per-record privacy. Original rule assets are packaged with a digest manifest. Focused checks include
real canonical plan/bootstrap/container/publication for all four engines, negative read-boundary tests, package import
checks, typecheck, catalog and schema checks; detailed final evidence is kept privately with the implementation review.


### Explicit public scanner command integration (2026-10-22)

The separate scanner CLI branch composes the independently reviewed four-driver layer with the merged owner CLI.
`init --profile scanners` selects the original Pattern/OSV/Trivy/zizmor families; default static preview behavior is
preserved through an explicit trusted preview driver. Owner asset commands require exact installed image pins and
separately named bounded database/checks provenance, bound with rights and the prior lock in spent receipts.
Acquisition remains a separate explicit bounded owner action; plan/run never download or use host scanners.

Actual public CLI and clean npm-only installed tests completed all four existing pinned Linux containers through
canonical planning and accepted publications. Detached start/join/wait, report regeneration after service stop and
source removal, missing archive refusal before attempts, source-copy independence, metadata/receipt tampering,
bounds and preview compatibility were exercised. Required coverage remains honest and policy satisfaction is not
claimed. The scanner report is a draft CLI slice; full report/policy/framework/model work remains open. Detailed
final checks and immutable integration context are retained privately for independent SOL review. No primary build,
ingest, dogfood graph or shared owner source tree was changed; no push or merge was performed.

## Sentinel checks-bundle rights correction — 2026-10-22

The public scanner integration now takes the checks bundle's rights directly from the pinned bundle metadata
(MIT), independently of the Trivy engine's Apache-2.0 license. An explicit conflicting override is refused. Public
and installed CLI tests assert the disclosed candidate rights before the exact candidate is receipt-bound and
promoted. No scanner input, worker or coverage behavior changes.

## Sentinel scanner admission corrections — 2026-10-22

The public CLI derives `tool-execution` from the admitted executable check units, apart from the exact shipped
local preview detector. Disclosure, foreground admission, detached owner receipts, direct agent service admission
and rerun previews use the same effect derivation; pause/cancel remain local control actions. Default and repository
grants are unchanged. Asset adoption now asks shared admission policy before inspecting Docker or reading caller
archives, then still requires final exact candidate/provenance receipt admission before promotion. The stale ADR
checks-bundle rights sentence now names MIT. Focused coverage includes restricted grants refusing before scanner
attempts, a sufficient grant running the real pinned scanner, rerun refusal, direct service/receipt denial, no daemon
contact on asset-policy denial, and preview/lifecycle/receipt regressions.

## Gitleaks and scanner aggregate integration — 2026-10-22

Branch `codex/sol-gitleaks-integration` is a new managed integration of approved Gitleaks `16c2c42f` and frozen scanner
aggregate `992d40cc` (merge `51488a1e`). Ancestry-only merge `c282fbdf` includes aggregate `a26ca4a4` and merged advisory
main `6bf00a7d`; its source tree is identical to `51488a1e`. Gitleaks worker, driver, private evidence/contracts and
source-derived capture/job/invocation classifications retain reviewed bytes. Aggregate execution repairs, the
OOM/deadline tests, Express implementation, native four-engine workflow and qualification pins retain frozen bytes.

Catalog and package unions preserve secrets plus the Express library. Capability tests assert exact available and
unavailable lists. Packaging discovers every asset hook once; all six hooks and all five engine manifests remain.
Both the Gitleaks isolation/public installed-CLI job and the separate four-engine native installed workflow remain.

Affected build, dependency typechecks, generated-schema check, catalog lint and all retained workflow/actionlint
checks passed. Selected tests passed 70 with no skips: 46 contract/package/scope/bootstrap cases, two capability
cases, 19 real canonical/public engine cases and three native workflow selector cases. A clean npm package verified
nine exports, 19 contracts/schemas, 54 fixtures, the installed Express fixture and all scanner asset manifests.
The actual npm-only secrets consumer and four-engine detached/join/wait/restart/retained-report consumer passed.
Only existing pinned Linux arm64 images and a held checks bundle were used; no engine/database was downloaded.
Native amd64 qualification of this combined source remains the selected CI jobs' gate, not a local claim.
No broad suite repeat, primary build, graph refresh, public push or merge into main occurred. Root owns review,
existing PR integration and publish. The previous paused checkpoint below is historical and superseded.

## Historical Gitleaks checkpoint — 2026-10-22 (superseded by the reviewed completion)

Branch `codex/sol-gitleaks-cli` combines the reviewed secrets library context with the reviewed scanner CLI and
admission corrections. The separate repository-input binding seam has four passing focused cases. The in-progress
canonical Gitleaks driver, repository-scoped pack, secrets preset and private job classification compile, but the
first real public CLI regression currently ends with `sentinel.execution.workerExited` (exit 3), before normalized
findings. This checkpoint is not ready to integrate or an installed-command qualification. Resume with that exact
synthetic regression; installed npm lifecycle, redacted-export acceptance and final compatibility checks remain.
The reviewed worker and normalizer are unchanged. No source target was executed or engine downloaded.


## Native installed scanner CLI gate — 2026-10-22

Branch `codex/sol-scanner-native-ci` adds the separate `sentinel-scanner-cli` workflow over the reviewed four-engine
CLI and native IaC metadata context. It verifies source/image/amd64-manifest pins, explicitly provisions four images
and the bounded checks bundle, requires zero-skip actual canonical CLI/driver/admission tests, and runs the npm-only
installed detached lifecycle and retained-report consumer. Selection uses the existing package/isolation dependency
union and fails closed; test files run sequentially. No scanner, policy, grant or authority logic changes. Local
validation replays the selected commands on the existing arm64 container runtime; it is not native amd64 CI evidence.
The native job must pass after integration before its installed-command gate is claimed.

## Combined scanner test assertions — 2026-10-22

Branch `codex/sol-scanner-suite-tests` updates two older capability assertions to the exact reviewed four-engine
draft slice while retaining the explicit unavailable feature list. The bootstrap publication-window regression
now accepts an unstarted parse only when the coordinator records a run-deadline refusal on that work or its exact
ancestor chain; a dependency hold specifically needs an ancestor cause. A delayed-capture case exercises the
ancestor path directly. Runtime code, grants and resource limits are unchanged. Dependency-closure build passed;
the three affected suites passed 47 cases with one existing qualified-host-only negative-case skip and no failures.

## Nest built-in module loader follow-up (2026-10-22)

Branch `codex/sol-nest-builtin-loader`, based on the frozen Nest framework implementation:
validation stays unknown when captured source can extract Node's `process.getBuiltinModule` loader capability,
including real process imports, aliases, destructuring, computed access and the global process properties.
Fixed reads of unrelated process properties, type references and local shadows preserve the existing analysis.
Target source is captured and parsed only; the fixture code is never executed.

Before correction, all 12 original/neighbor loader regressions falsely reported validation applies, while seven
harmless controls passed. After correction, the complete focused Nest suite passed 77 tests with no skips.
The affected dependency build, Sentinel typecheck, diff check and exact Conventional Commit subject lint passed.
Independent review and parent integration remain with the integrating lead; no push or merge was performed.
