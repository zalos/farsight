# Sentinel execution preparation

Prepared 2026-10-21 against `main` at `46018cb`. This packet prepares bounded PR 01 work after
the [architecture](implementation-plan.md), [backlog](implementation-prs.md) and
[kickoff](execution-kickoff.md); it does not authorize execution of the whole backlog.

## Verified state and scope

- Planning PR [#118](https://github.com/zalos/farsight/pull/118) merged on
  2026-10-19 at `0c8c747`. Its earlier open-PR status is historical.
- No Sentinel implementation paths or implementation PRs existed at this preparation checkpoint.
  Existing SQL/example validation is evidence about those examples, not a Sentinel runtime result.
- Owner confirmation on 2026-10-21: external scanners require containers; no host fallback.
  This settles the prerequisite policy, not runtime support, installation, acquisition or trial permission.
- Current work is review, plan updates and preparation. Actual probes need their applicable gates below.
  Local-first, source-only, optional models and independently deliverable reports remain confirmed.

## PR 01 has two distinct milestones

**Evidence preparation:** reviewed fixture labels, a draft versioned manifest/results format, an E1–E8
case inventory and bounded harness design. Future results say `not-run` or `deferred` with a reason.
No production package, service, adapter or public contract scaffolding belongs here.

**Complete measured decision gate:** actual eligible probes and retained artifacts, reviewed failures,
exact supported-version matrix, accepted deterministic corpus/thresholds and owner decisions satisfy
PR 01's backlog acceptance. An evidence-preparation milestone or passing harness tests alone does not
complete PR 01 and cannot dispatch PR 02. E5/model evaluation may remain explicitly deferred to its track.

## Bounded SOL lanes under one parent PR 01

Dispatch only the authorized milestone. Each implementation lane gets its own worktree from the agreed
base, explicit owned files and an acceptance case; none edits another lane's files or reverts others' work.
These are assignments for later dispatch, not claims that agents or implementation have started.

| Lane | Exclusive ownership | Concrete deliverable |
|---|---|---|
| A — corpus | `packages/sentinel/test/fixtures/feasibility/` and this proposal's `feasibility-protocol.md` | TS/JS, Java, hidden-config and middleware-order vulnerable/safe pairs; independent expected inventory, labels/provenance/hashes, inert secrets and fixture-only manifests; E1–E8 control matrix and measurement/demo protocol |
| B — harness and parser | `scripts/sentinel-feasibility.mjs`, `scripts/sentinel-feasibility/parser.mjs`, `scripts/test/sentinel-feasibility.test.mjs`, `scripts/test/sentinel-feasibility-parser.test.mjs` | Bounded selection, draft manifest validation, effect preview and honest unavailable/skip results; actual authorized public-parser/inventory probes and retained input/output reconciliation evidence; no acquisition or execution by default |
| C — storage and resources | `scripts/sentinel-feasibility/storage.mjs`, `scripts/sentinel-feasibility/codec.mjs`, `scripts/test/sentinel-feasibility-storage.test.mjs`, `scripts/test/sentinel-feasibility-codec.test.mjs` | Actual authorized SQLite ownership/revision/publication prototype and codec/resource probes; contention, integrity and corruption controls; isolated temporary state and measured artifacts, explicitly distinct from production coordinator guarantees |

The lead owns `feasibility-manifest.json`, `feasibility-results.md` under this proposal, shared draft
formats, decisions, indexes, security notes, CI/configuration, contracts/catalogs and final integration.
Format changes return to the lead before another lane consumes them. No lane independently approves rights,
accepts thresholds or records fabricated measurements. After local evidence is reviewed, reuse a free lane
for gated engine/isolation probes with a new explicit file assignment; never add a fourth concurrent lane.
The SOL owners implement/probe; the lead reviews diffs, reconciles labels/results, selects checks and signs off.

## Draft experiment manifest and retained evidence

Use a draft format version until contract review. Feasibility states below are local draft-schema fields,
not additions to core's closed graph absence/evidence vocabulary. Every experiment records:

- Stable experiment/case ID, E1–E8 gate, purpose, expected positive and negative facts, label author/reviewer,
  label rationale and provenance; synthetic/public/private scope and explicit denominator.
- Exact candidate/tool/rule/database/framework versions, source URL and immutable revision, rights/license
  assessment and acceptance owner; acquisition status, archive/image digest and rule/corpus/input hashes.
- Host OS/architecture, Node/SQLite/runtime versions, container image digest, VM configuration, CPU/RAM/disk,
  limits and execution command as arguments; no mutable `latest` support pin.
- Declared effects: local reads/writes, source materialization, network destinations/purpose, acquisition,
  executed programs, container mounts/privileges, provider disclosure, estimated cost and approval reference.
- Input manifest hash, harness revision, start/end time, exit and coverage/skip facts separately; wall time,
  process RSS/JVM heap where applicable, bytes and uncertainty; redacted output artifact hashes/locations.
- `not-run`, `measured`, `failed` or `deferred` execution state; accepted/rejected/deferred decision,
  limitations, missing prerequisites, reviewer and date. A skipped or exit-zero trial never implies coverage.

Commit synthetic/redacted records only. Private source, raw provider packets and review transcripts stay
outside this public repository. Hashes establish identity; they do not establish permission or accuracy.

## Required controls before accepting results

| Gate | Positive case and required negative control |
|---|---|
| E1 inventory | TS/Java plus hidden security files; malformed, unsupported, excluded, unreadable/refused and oversized cases. Independently enumerate ignored tracked/generated security files; retain `.gitignore` fingerprints. Parser 0.3.1 may omit ignored entries from `analysis.files` while reporting complete: reconcile selection against inventory rather than treating completeness as total capture |
| E2 framework | Supported order/chain fixture and late auth, exclusion, missing/overlapping chain, unknown custom middleware, Nest declaration without a registered pipe, and a parse-only multipart reader. A safe label must name the enforced property and environment; declaration/parsing alone cannot prove enforcement |
| E3 engines | Identical original rules, corpus and limits across candidates; safe sibling, cross-file case, unsupported/partially scanned file and exit-zero skip. Labels/denominators precede ranking |
| E4 ownership | Eligible SQLite/publication prototype: duplicate/revision mismatch, owner contention and interruption; container identity/cleanup only after its gates. Full coordinator recovery remains PR 08/26, twenty kills per boundary |
| E5 models | Prepare clean/adversarial paired packets and validators without calls; missing citation, hostile source and wrong answer controls. Live two-model/five-trial labeled evaluation remains gated at PR 22 |
| E6 equivalence | Define controlled edits including new/removed route, framework/rule/advisory change and renamed same-named guard; incremental/full equivalence remains unrun until PR 27/28 |
| E7 offline | Enforced network denial plus missing database/tool; required work completes or reports an explicit gap, never an online audit silently skipped to green |
| E8 resources | Fixed hardware/input sizes, limits and artifact bytes; oversize/budget exhaustion and unavailable measurement controls. Mock token estimates are not observed usage; unchanged `/graph` is a later product measurement |

Never execute vulnerable fixture dependency installation or source-supplied scripts/plugins. Materialize
ecosystem filenames only in temporary trees; verify discovery behavior rather than assuming renamed files
are invisible to all scanners. Any gitleaks exception is an exact inert-value line with a reviewed reason.

## Decisions and go/no-go

| Decision | Accountable owner | State / action before dependent work |
|---|---|---|
| Container prerequisite | Owner | Confirmed 2026-10-21; no host fallback |
| Architecture refinements in plan §2 | Owner + lead reviewer | PR 00 accepted and merged; recheck successor prerequisites and only the explicitly named measured choices, without reopening agreement |
| Exact host/runtime/framework/engine pins and original rule inventory | Feasibility lead + owner | Unmeasured; choose candidates before probes, accept support only from recorded results |
| Deterministic corpus/required coverage and E3 thresholds | Feasibility lead + owner | Proposed; approve labels, denominator and thresholds before ranking/acceptance |
| Retention/resource defaults | Lead + owner | Proposed; measure in PR 01 and settle before dependent admission/storage behavior |
| Acquisition, scanner execution and provider disclosure/budget | Owner + lead | Record existing direct authorization and reviewed effect limits in the manifest; preparation/container policy are not blanket grants. PR 01 neither implements nor requires future PR 06 receipt machinery |
| E5/model thresholds and live trials | Lead + owner | May remain deferred; settle before model-track evaluation/required review |

Before any actual scan/probe, the lead checks the current authorized scope, accepted relevant architecture,
source rights, immutable inputs, approved effects, exact tool/image/database availability, container readiness
where required, isolation/limits, output location, cleanup identity and abort conditions. Any unresolved
required prerequisite means **no-go for that experiment**, with the reason recorded; independent preparation
can continue. No silent download, network expansion, provider fallback or host scanner fallback.
Existing authorization carries forward within its limits; do not request the same approval again.

## Review, acceptance and demonstration checklist

- [ ] Lane artifacts use agreed draft formats; positive/negative labels have independent review.
- [ ] Every claimed measurement has command, inputs, provenance, artifact hashes and limits; failures/skips
  remain visible. Unrun future E4/E5/E6/product gates are explicitly identified.
- [ ] Demonstrate the same vulnerable/safe pair, a skipped file and offline failure across eligible candidates;
  inspect the raw evidence and show that skip/unsupported never becomes a clean check.
- [ ] Owner accepts measured deterministic matrix and decisions, or identifies the remaining blocking gate.
  No PR 02 dispatch from harness completion alone; no full-backlog execution authorization inferred.
- [ ] Lead inspects final diff, public-content hygiene, links and whitespace; records actual checks and omissions.
- [ ] Preserve both original Claude reviews byte-for-byte; append disposition/evidence in separate records.
  SHA-256: `claude-review.md` = `b38b4ea5aa7c9f79def3b1cc62270b70b4c0c3046a0d2f32d8198e641944dac5`;
  `claude-review-implementation.md` = `1010ea2e67e0efeb845f839909da2a83ca6ea5e0b615b859a604cba252af0e58`.

## Checks selected by the actual change

This preparation packet is ordinary Markdown: local links/whitespace/diff review; no runtime suites.
Secrets and commit/title conventions still apply. [CI selection](../../CI.md) governs implementation:
`scripts/test/` and package test fixtures select validate; new `scripts/sentinel-feasibility.mjs` is currently
an unknown path and selects **all runtime jobs** (validate, e2e, echo-package), so PR 01 is not docs-only.
Do not silently change the selector to avoid those checks. Build first for tests importing `dist/`.

PR 02 additionally proves ordinary Farsight packaging works when Sentinel is absent or unbuilt: current
pack preflight checks each package manifest's `main`. Optionality needs an actual package smoke result,
alongside its ADR, package-map entry and CI selection; it cannot be established by a placeholder package.
