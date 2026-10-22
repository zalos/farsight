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

The [evidence index](evidence/2026-10-21/index.json) hashes every retained record. The
[local result](evidence/2026-10-21/local-results.json) records revision `e67c3df`, a clean worktree,
Node 24.19.0, SQLite 3.53.3 and the manifest/corpus/probe hashes. The
[synthetic artifact archive](evidence/2026-10-21/local-artifacts.tgz) retains its stage JSON, parser
artifacts, prototype SQLite databases and codec bytes; temporary materialized source trees are excluded.
[Compiled parser identities](evidence/2026-10-21/compiled-parser-files.json) supplement the fresh build
and pinned package versions; they are not a capture of the entire native/WASM dependency closure.

| Experiment | Observed result | Interpretation |
|---|---|---|
| E1 | 12 cases, 78 controls passed; 13 hashed parser artifacts. | TS/Java syntax inputs reconcile to independent inventory. The ignored-file control deliberately reports parser completeness while omitting an independently captured file. Malformed, unsupported, symlink, missing and oversize controls remain explicit. |
| E4 | 12 controls passed, with real child processes and SQLite locks. | One of two contenders owns the database; a killed owner rolls back and a successor acquires it; cross-revision/duplicate publication is rejected; reopened integrity is `ok`. This is a local prototype, not the full recovery matrix. |
| E8 | 30 controls passed over two fixed byte objects and raw/gzip/zstd. | Round trips, corruption, truncation, encoded identity and decoded limits are checked. One trial per codec supplies observations, not performance ranking or default selection. |

E4 uses a 250 ms SQLite busy timeout: zero-wait lock upgrades can reject both contenders. The owner database
uses DELETE journal mode; the separate ledger uses WAL and FULL synchronization. This prototype does not
validate a full artifact/fsync publication protocol. The final combined run has one killed owner; the lane's
30 preliminary contention repeats informed implementation but are not the twenty-kill product release gate.

The codec objects are 65,536 binary bytes and 64,512 UTF-8 bytes. Gzip/zstd encoded the binary object to
65,576/65,546 bytes and the repetitive UTF-8 object to 300/83 bytes. These synthetic extremes cannot select
a production codec. RSS before/after is a process snapshot; maxRSS is a process lifetime high-water mark,
not per-codec allocation or peak attribution. Measurements ran on macOS arm64 / Apple M4, ten logical CPUs,
16 GiB host memory. The acquisition record gives the Docker VM and per-container limits.

The [final scanner result](evidence/2026-10-21/scanner-results.json) records script revision `2303da2`,
a clean script/input scope, exact images, commands, inspected limits and scrubbed raw streams. All 64
scenario controls and four run-level controls passed; seven materialized input identities stayed unchanged.
Both scanners ran in Linux arm64 containers with no network, a read-only root filesystem and mounts,
UID 65534, no capabilities, no privilege escalation, two CPUs, 2 GiB memory and 128 process limit.
Each subprocess has a 120-second/4-MiB output ceiling; the engine has one job, 20-second rule timeout and
4,096-byte target limit. These ceilings are test settings, not accepted product resource defaults.

| Scanner | Positive symbols found | Safe siblings matched | Oversize control | Missing rules |
|---|---|---|---|---|
| Semgrep 1.181.0 | 3 of 3 | 0 of 3 | Exit 0, no scanned files, explicit `exceeded_size_limit` | Exit 7, absent rule-path diagnostic |
| Opengrep 1.31.0 | 3 of 3 | 0 of 3 | Exit 0, no scanned files, explicit `exceeded_size_limit` | Exit 7, absent rule-path diagnostic |

The separate socket attempt returned `ENETUNREACH` (101), with Docker `NetworkMode=none` inspected. All
nine uniquely owned containers were removed and absence verified by exact ID. No host scanner was executed.
This tests normal cleanup and denied networking, not orphan recovery or isolation against hostile code.
Three positive and three negative symbols under two narrow original rules cannot establish deep capability,
precision/recall on applications, framework support or an engine winner.

The [initial failed scanner trial](evidence/2026-10-21/scanners-initial-failed.json) is retained: Opengrep
rejected Semgrep's `--metrics` option. Its unrelated error also exposed a weak missing-rule control. The fix
uses candidate-supported flags and requires a diagnostic identifying the exact absent rule path; an arbitrary
nonzero exit no longer passes. Final controls also require inspected container exit agreement and honest
unknown cleanup on inspection failure. This initial failure is not omitted from the evidence.

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

## Validation of the integrated slice

The required local build, package/e2e type checks, 1,615 package tests (two opt-in live-service skips),
70 script tests, string lint, Echo tarball smoke, 345 browser/MCP tests and all 11 small performance checks
passed. The final e2e run used isolated ports and no overlapping builds. Its initial run had two build-currency
failures while another required package check rebuilt shared output, plus one journey-navigation failure.
A stable rebuild and focused 19-test rerun passed, followed by the full 345-test pass. No viewer code was
changed to obtain that result. The synthetic evidence, including extracted archive contents, passed secret
scanning. Original Claude review hashes match the preparation record.

The SOL lanes implemented corpus, harness/parser and storage/codec work; the corpus lane then implemented
the container probe. Independent cross-lane review found and corrected input redirection/size/identity gaps,
measurement false-success conditions and inaccurate cleanup/error classification. The lead reviewed integration,
performed actual container trials and retained the initial failed trial. No parser/core/production-store code
changed, so no application real-ingest before/after claim is made. The primary checkout was neither built nor
tested, and its existing editor-settings change was preserved.

## Review follow-up measurements — 2026-10-21

The [follow-up index](evidence/2026-10-21-review/index.json) retains new measurements without replacing
the earlier evidence. Platform preflight now refuses unsupported or unknown host, Docker server and image
architectures before output/container creation. Network denial requires inspected `none` plus Linux
`OSError`/`ENETUNREACH` (101); a timeout or refused connection cannot pass. Independently authored inclusive
source spans replace declaration-pattern guesses for the six expected symbols, and unattributed findings
fail the paired comparison. The source hashes and original labels remain unchanged.

Parser omission checks now retain whether a path was unreported or reported without analysis, diagnostic
presence, and an explicit unknown security-coverage gap. Matching an expected omission is not evidence of
coverage. Unexpected probe failures retain bounded, scrubbed name/code/message fields without stacks.

The [local rerun](evidence/2026-10-21-review/local-results.json) at clean revision `f61e745` again passed
78 E1, 12 E4 and 30 E8 controls. Its [synthetic archive](evidence/2026-10-21-review/local-artifacts.tgz)
contains the stage records and 21 hash-verified artifacts, excluding materialized source/work directories.
[Compiled parser identities](evidence/2026-10-21-review/compiled-parser-files.json) match the earlier
fresh build; these changes do not modify production parser code or establish a full dependency closure.

The [failed noexec trial](evidence/2026-10-21-review/scanners-noexec-failed.json) at `85aeda1` is retained.
Semgrep passed its four scenarios with non-executable temporary storage; Opengrep's version command exited
2 with `Error, couldn't launch child (exec): Permission denied`. All five created containers were removed.
The internal failing path/mechanism is unverified. The pinned Opengrep candidate therefore has an explicit,
fixed executable-tmpfs exception; Semgrep retains `noexec`. The preview and result disclose this weaker
control. There is no automatic retry or host fallback, and this is not a production isolation decision.

The [final scanner rerun](evidence/2026-10-21-review/scanner-results.json) at clean revision `b94c7e4`
passed 66 scenario controls and four run controls across nine trials. Host/server/image platforms are recorded
as ARM64, and inspected tmpfs flags confirm the candidate-specific policies. Both scanners again found all
three positive symbols and no safe siblings; oversized and missing-rule behavior is unchanged. The socket
returned `OSError` 101, all seven input identities stayed unchanged, and all nine owned containers were removed.
These results retain all earlier capability limitations and leave the full PR 01 gate open.

Follow-up validation passed the build, package/e2e type checks, 1,615 package tests (two expected live
skips), 79 script tests, string lint, Echo package smoke, 345 browser/MCP tests and 11 small performance
checks. All used isolated worktrees. The final independent Claude CLI source review reported no remaining
actionable findings; it did not execute tests or recheck the six literal fixture spans. The lead checked
those spans against the source and ran the measurements above. Evidence hashes, local links, secret scans
including extracted artifacts, commit/title lint and whitespace checks passed. Original review files and
earlier evidence remain unchanged. The dependency install refreshed shared Git hook metadata only; the
primary checkout's source/build/test outputs and existing editor-settings edit were preserved.
