# Sentinel PR 01 feasibility evidence

This first implementation slice establishes reviewed synthetic inputs, explicit experiment effects and
bounded, repeatable local probes. It introduces no production Sentinel package or public contract.
The complete PR 01 decision gate remains open; this slice does not dispatch PR 02.

## Inputs and scope

The [protocol](feasibility-protocol.md), [local manifest](feasibility-manifest.json) and
[acquisition record](feasibility-acquisition.json) define the experiment. The corpus contains 14 cases,
42 source blobs and two original rule blobs, with exact hashes. The integration reviewer examined source
and expected facts independently of the implementing lanes. Static labels do not certify runtime behavior.
Next matcher exclusions and Spring permit-all overlap stay unknown without a declared required-access policy.
Framework versions are candidate declarations only; none was installed or executed.

The owner authorized PR 01 implementation and confirmed Linux containers with no host scanner fallback.
The local harness previews by default; actual probes require `--run`, selected experiments and a fresh
output directory. The scanner command is separate and opt-in, cannot acquire tools, uses immutable images
and a checksum-verified Opengrep binary, and has no host-execution path. Acquisitions are recorded separately.
All source and rules used in execution are original synthetic material. No private source, fixture build,
source-supplied program, provider request or paid model operation is part of these trials.

## Reproduce

Use Node 24 and pnpm 9. Build before parser probes. Both output paths below must not already exist.
The first two commands preview effects without running a probe:

```sh
node scripts/sentinel-feasibility.mjs --experiment E1,E4,E8
node scripts/sentinel-feasibility-scanners.mjs
pnpm build
node scripts/sentinel-feasibility.mjs --run --experiment E1,E4,E8 --out /tmp/sentinel-local-new
node scripts/sentinel-feasibility-scanners.mjs --run --out /tmp/sentinel-scanners-new --opengrep-binary /tmp/pinned-opengrep-linux-arm64
```

The scanner trial requires the two locally available images and Linux arm64 binary recorded in the
acquisition manifest. It never downloads them. Docker executes only the explicitly mounted synthetic
inputs and fixed tool; fixture applications are not executed. Missing images, binaries, rules and runtime
capabilities produce failed/blocked checks. The expected missing-rule scenario is recorded separately from
an infrastructure failure. A successful process that skips the oversized file remains a coverage gap.

## Measured evidence

Results are pending integration validation in this initial record. Final evidence will include actual
local probe results and container trials, with hashed retained artifacts and exact command provenance.
A measurement status does not accept a product capability or choose an engine.

## Decisions and remaining gates

| Gate | Decision for this slice | Still required before dependent capability |
|---|---|---|
| E1 inventory | Public parser is a syntax input; independent security inventory is mandatory. | Production captured-input reconciliation, inaccessible-directory behavior and capture restoration. `analysis.complete` cannot substitute for inventory completeness. |
| E2 framework | Keep all framework versions as candidates; retain source-grounded labels. | Runtime/prototype order, matcher and chain evidence, exact supported versions, and no false protected verdicts. `core/openapi.ts` `guardsOf()`/`matchesGuard()` remain reconciliation heuristics, never an enforcement oracle. |
| E3 engines | No engine ranking or production default selected. | Accepted corpus/thresholds, cross-file/deep capability trials, partial/unsupported-input behavior and terms review. The three SQL-positive and three safe symbols are a syntax-locator denominator only. |
| E4 ownership | Prototype evidence can inform the coordinator design only. | Production publication/fsync, orphan-container recovery, cross-host/alias/filesystem policy, and twenty kills per boundary at PR 08/26. |
| E5 models | Explicitly deferred; paired hostile/clean packets prepared. | Citation/semantic validator, budgets and approved thresholds, then two-model repeated evaluation on the model track. |
| E6 equivalence | Edit classes are specified, not executed. | Full/incremental oracle after PR 27/28 implementation. |
| E7 offline | Require container-only external scanners with no host fallback. | Missing databases/tools/required-online work, cancellation and orphan cleanup on accepted supported hosts; denied networking is not a proof of hostile-code isolation. |
| E8 resources | Record prototype observations without choosing defaults. | Representative source/codec/engine measurements, retention/admission choices and unchanged `/graph`; model estimates and usage stay with their separate track. |

External WebGoat, Juice Shop and OWASP Benchmark revisions are pinned for future acquisition; no external
corpus was downloaded, run or scored. Exact runtime support, installation/redistribution terms, framework
support, deterministic thresholds and resource defaults still require acceptance. The provisional deep
engine targets in the plan are not established by a two-rule smoke comparison.

## Definition of done for this review slice

- Reviewed static fixture labels and immutable inputs; no source dependency installation or execution.
- Explicit preview/run boundary and failed controls produce nonzero status; unselected stages stay deferred.
- Real local and container measurements retain inputs, outputs, hashes, versions, limits and gaps.
- Independent SOL review findings fixed and regression-tested; lead reviews the integrated diff and evidence.
- Checks selected by `docs/CI.md` pass; original Claude review files remain byte-for-byte unchanged.
- The PR names remaining measured-decision gates and does not present this slice as complete PR 01 acceptance.

The plan now explicitly requires configure → preview → run → inspect stage inputs/outputs → rerun → compare
in PR 25, including a visual stage graph and preserved earlier outputs. PR 25b adds configured provider/model
selection and requested/actual model identity. These are future product acceptance criteria, not UI shipped
by this feasibility slice. Linked reruns are required before PR 27's optional incremental reuse optimization.
