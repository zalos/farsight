# Sentinel v1 — proposal to closeout

Archived from `docs/AI-HANDOFF.md` on 2026-10-28 (2026-10-17 → 10-23). Dated records, verbatim apart from
re-pointed relative links; read on demand, never loaded at session start. Index: [README.md](README.md).

## Sentinel session closeout — 2026-10-23

The current recap, owner decisions, open issues and ordered release plan are at the repository root:
[SENTINEL-STATUS-2026-10-23.md](../../SENTINEL-STATUS-2026-10-23.md). This checkpoint supersedes historical
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
[scoped release ledger](../proposals/farsight-sentinel/execution-progress.md). Historical native memory attribution
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
their plan gates. The [execution ledger](../proposals/farsight-sentinel/execution-progress.md) records these boundaries.
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

## Sentinel PR01 measured decisions — 2026-10-22

[PR #133](https://github.com/zalos/farsight/pull/133), branch `codex/sentinel-decisions`, continues merged #132 (`2bd38f6`) with original engine, framework and
runtime/resource experiments. Claude CLI implemented framework apps/drivers; SOL lanes implemented and
cross-reviewed engine/runtime/acquisition/lifecycle controls; the lead integrated, reviewed and ran final
measurements. [The acceptance record](../proposals/farsight-sentinel/feasibility-acceptance.md) links the proposed
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

## Canonical scanner drivers (2026-10-22)

The internal Pattern, OSV, Trivy and zizmor drivers now use the coordinator's existing trusted driver registry.
They require exact shipped rule definitions, engine pins, captured input scopes and explicitly held database/checks
provenance. No driver acquires assets or starts an engine directly. Missing assets refuse preparation and cannot
produce clean coverage; the public CLI and capability manager remain integration work. Normalized findings/reports
are source-derived and publish with per-check coverage in the accepted worker attempt. The small seam delta exposes
the exact supervisor outcome frozen in place, permits validated actual-read refinement within sealed captured scopes,
and preserves per-record privacy. Original rule assets are packaged with a digest manifest. Focused checks include
real canonical plan/bootstrap/container/publication for all four engines, negative read-boundary tests, package import
checks, typecheck, catalog and schema checks; detailed final evidence is kept privately with the implementation review.

## Explicit public scanner command integration (2026-10-22)

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

## Sentinel execution continues — 2026-10-21

PR #133 merged at `ef5c525`. The owner continued execution and accepted PR 01's bounded matrix and resource
defaults **for implementation** only; nothing measured as a prototype becomes general engine, framework,
platform or deep-analysis support. PR 00/01 are done, PR 02 is in progress, PRs 03–30 (with 23a/23b/25b) are
pending. Remaining deferred items are implementation/release acceptance gates, not new permission gates for
authorized reversible work. The durable status table, owner-directed roles (Opus implements, SOL reviews,
a final Claude Fable 5.1 touch-up review fixed by Opus and verified by SOL), the captured stage
configuration/I-O/rerun/model-choice/visual requirements and the end gates (Java + Spring sample app,
npm-only consumer install → help → init → scan → report, release) are in the
[execution progress ledger](../proposals/farsight-sentinel/execution-progress.md). Settled by the lead: npm-only
installs use the GitHub Release tarball URL (registry only if configured at release); initialization means
instructions over Farsight's existing install/config/ingest/serve path plus a Sentinel flow designed in PR 09;
the Java + Spring sample is original. Resolved since: retention
windows are explicit-prune eligibility, never automatic deletion in v1; the final reviewer is the installed
`fable` alias. Pending live-evaluation configuration (not an implementation or deterministic-release blocker):
a second model — only `qwen3:4b` is local — or a hosted endpoint with a spend cap for PR 22's evaluation
(two models × 30 cases × 5 trials × 2 variants: 300 clean plus 300 paired canary evaluations, 600 total). PR 29/30 runtime testing stays on the synthetic/sample local app only. This change is
Markdown/JSON documentation only; no builds or tests ran locally for it, and CI selection is unchanged
(`feasibility-decisions.json` is an unknown path, so CI selects every check); the two original Claude reviews are unchanged.

## Sentinel PR 01 first implementation slice — 2026-10-21

PR #132 review follow-up on `codex/sentinel-feasibility` tightens platform refusal, network-denial evidence
and symbol attribution, makes silent parser omissions explicit unknown coverage gaps, and retains scrubbed
probe exceptions. Two SOL lanes implemented the fixes; the lead reviewed and reran actual measurements.
The [follow-up evidence](../proposals/farsight-sentinel/evidence/2026-10-21-review/index.json) preserves the
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
The [results and decision record](../proposals/farsight-sentinel/feasibility-results.md) links retained synthetic
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

The [execution readiness packet](../proposals/farsight-sentinel/execution-readiness.md) assigns three SOL lanes:
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
[Sentinel implementation kickoff](../proposals/farsight-sentinel/execution-kickoff.md), linked from the plan and
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

## Farsight Sentinel proposal — 2026-10-17

Branch `codex/farsight-sentinel-proposal` adds a [security-scanning proposal](../proposals/farsight-sentinel.md)
with execution/data contracts, scanner research, workflow research and repository-fit notes under
`docs/proposals/farsight-sentinel/`. Scope is documentation only; Sentinel is not
implemented. The first-release requirements are TS/JS and Java/Spring Boot, local parsing/storage and opt-in
model providers. Recommended architecture: optional extension, durable SQLite execution ledger, immutable
compressed source/evidence bundles, versioned rules, specialist scanner adapters and bounded agent review.

PR #115 merged at `4fce1c8` on 2026-10-17; the proposal and branch are re-pinned to that revision and consume
its `parseRepository()` artifact. The [independent review](../proposals/farsight-sentinel/claude-review.md) is
preserved byte-for-byte; the [response](../proposals/farsight-sentinel/codex-response.md) addresses findings
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
