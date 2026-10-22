# Bounded engine comparison

PR 01 E3 experiment, 2026-10-21. This extends the initial three-symbol syntax comparison with
original inert source. It is not a production adapter, a security benchmark, or owner acceptance.
The existing corpus and scanner runner remain unchanged.

## Frozen inputs and proposed criteria

The new [index](../../../packages/sentinel/test/fixtures/engine-feasibility/index.json) records every
source byte hash, manually authored inclusive symbol span, purpose and paired label before trials.
No engine or Farsight parser supplies the labels. Independent static review is recorded separately.
There are nine valid files, nine positive symbols and nine safe siblings: TS, JS and Java each have
one direct, one local-variable and one cross-file pair. Three input controls are outside those
capability denominators: a malformed TS tail after a valid prefix, Rust outside the selected rule languages and oversized TS.
The positive changes SQL structure with request text; the safe sibling uses constant SQL and passes
the request value separately. Safe means only that SQL structure is constant, assuming binding
semantics for the inert `query` facade; it does not certify the application.

Two original rulesets share the exact input bytes across candidates. The pattern rules locate a
concatenating first query argument. The taint rules name `request.value()` as source and focus the
first SQL argument as sink. These facades model flow without installing or executing applications.
Cross-file cases put the request source in the caller and query sink in a different file. A located
sink does not establish that the engine followed the call.

Proposed before measuring: pattern eligibility requires all 3 direct positives, no hits on any of
9 safe siblings, no unattributed findings, no engine errors on valid files, and reconciliation of
all 9 eligible paths. Local taint qualification requires all 6 direct/local positives and no hits
on 9 safe siblings. Cross-file qualification separately requires all 3 cross-file positives, no
safe hits, and source-to-sink path evidence crossing the named file boundary. These are exact
micro-corpus criteria, not general accuracy targets. Every candidate also needs matching pins,
completed bounded commands, unchanged inputs and verified owned-container removal. Out-of-rule-language,
partial, malformed and skipped inputs remain visible gaps even on exit zero. Partial diagnostics
and engine-reported scanned paths are retained; a scanned-path list alone does not prove complete
analysis. No safe/no-finding result proves coverage.

## Execution boundary

Preview is the default. An explicit run uses only the original fixtures, fresh output and the
existing pinned native ARM64 containers/binary. Source, rules and root filesystem remain read-only;
network is `none`; UID 65534, dropped capabilities, no new privileges and fixed resource ceilings
are inherited from the authoritative scanner helper. Semgrep retains non-executable tmpfs;
Opengrep retains the previously disclosed executable-tmpfs packaging exception. There is no host
scanner, pull, provider/model call, source execution, fixture installation, automatic retry or build.
Raw bounded scrubbed streams, argument arrays, inspections, identities and hashes remain in the
fresh output. Measurement control failures are separate from an unsupported capability.

## Scope left open

Framework inference, realistic application accuracy, general interprocedural/deep coverage,
portable host support and production adapter behavior require separate evidence. Full external
benchmarks remain unacquired for this bounded run: no acquisition or fixture dependency execution
is needed for the original micro-corpus. Tool/rule installation and redistribution terms remain a
lead decision; this experiment makes no legal approval claim. Candidate choice must remain scoped
to measured pattern-location behavior, with unsupported flow and input gaps reported alongside it.

## Observed result and scoped recommendation

The final explicit run used clean probe revision `5ae10228761a46379a82a59c0751014db7f5f0f3`.
The corpus index SHA-256 was
`90b38d88da136cc9d3f9fbab11fba1da4d84ffa2c958359a984c2f5b10e738bf`.
The retained `results.json` is 551,588 bytes, SHA-256
`4374398798f306fabe03d4478bcffac6424c5867eafa498a1d74c8f3360061e6`.
It retains bounded scrubbed stdout/stderr, their hashes, exact argument arrays, pinned images,
container inspections, rule/input identities, labels, thresholds and timestamps. All 14 trial
controls passed; all 14 materialized source/rule hashes and the copied binary stayed unchanged;
all 14 exact owned containers were removed. Candidate version commands matched Semgrep 1.181.0
and Opengrep 1.31.0. This was native ARM64 Docker; it establishes no other host/runtime matrix.

| Actual result on the same original inputs | Semgrep 1.181.0 | Opengrep 1.31.0 |
|---|---:|---:|
| Pattern: direct positive symbols hit | 3 / 3 | 3 / 3 |
| Pattern: local positive symbols hit | 0 / 3 | 0 / 3 |
| Pattern: cross-file positive symbols hit | 0 / 3 | 0 / 3 |
| Pattern: safe sibling symbols hit | 0 / 9 | 0 / 9 |
| Taint: direct positive symbols hit | 3 / 3 | 3 / 3 |
| Taint: local positive symbols hit | 3 / 3 | 3 / 3 |
| Taint: cross-file positive symbols hit | 0 / 3 | 0 / 3 |
| Taint: safe sibling symbols hit | 0 / 9 | 0 / 9 |
| Valid input paths reported scanned, each ruleset | 9 / 9 | 9 / 9 |
| Valid-input diagnostics / unattributed findings, each ruleset | 0 / 0 | 0 / 0 |

Both candidates meet the proposed direct-pattern and local-taint criteria on this micro-corpus.
Neither qualifies for cross-file/deep capability: neither found any of the three cross-file
positives or emitted a qualifying source-to-sink trace across those file boundaries. This is
bounded evidence about these rules and invocations, not proof that either engine can never
perform cross-file analysis. The experiment does not measure realistic vulnerability precision
or recall. Constant-only concatenations and other safe SQL constructions were not tested.

| Control outside the symbol denominator | Observed for both candidates |
|---|---|
| Partial TS with valid prefix and malformed tail | Exit 0; 1 / 1 path reported scanned; one prefix match; `PartialParsing` warning; the same file also reported skipped with `analysis_failed_parser_or_internal_error`. Partial analysis remains a gap. |
| Rust outside the selected rule languages | Exit 0; 0 / 1 paths scanned, 1 / 1 omitted; no findings, diagnostics or skip reasons. The harness retains the silent omission. This does not claim Rust is unsupported by either engine. |
| TS over the 4,096-byte target limit | Exit 0; 0 / 1 scanned, 1 / 1 omitted; explicit `exceeded_size_limit`; no finding. |
| Required rule absent | Exit 7; 0 / 9 requested valid paths scanned, 9 / 9 omitted; explicit missing-rule diagnostics. This is the expected offline failure control. |

The initial run is retained unchanged as a prior artifact, SHA-256
`898b121c5aa97de388f1a2bb6957752bf8058c0c78f09f8e03ad30834a51603e`.
It found the same capability results but its missing-rule stage incorrectly printed zero
requested files. Commit `5ae1022` corrected that report denominator; the final run was an
explicit fresh measurement with identical frozen corpus/rules/thresholds. There was no automatic
scanner retry or fallback. Ten focused engine-matrix tests and the 26 existing scanner-control
tests passed together; exact commit titles were linted. These checks require no product build.

Recommend Semgrep 1.181.0 as the scoped syntax-location default for the two original pattern rules:
both candidates produced the same bounded result, and Semgrep retained the stronger non-executable
tmpfs control while the pinned Opengrep package required the already disclosed executable-tmpfs
exception. This is an operational tie-breaker, not a general engine ranking. Local taint behavior
is qualified only for the six direct/local facade cases; deep/cross-file checks stay unsupported
for this evaluated profile. The lead/owner records acceptance and any production decision separately.

For version-specific source-term references, the tagged root licenses for
[Semgrep v1.181.0](https://github.com/semgrep/semgrep/blob/v1.181.0/LICENSE) and
[Opengrep v1.31.0](https://github.com/opengrep/opengrep/blob/v1.31.0/LICENSE) contain LGPL 2.1 text.
Those references alone do not establish terms for every bundled component, image, hosted service
or future redistribution. This experiment makes no legal approval or redistribution decision.


## Control review follow-up

The subsequent independent control review tightened the engine-matrix validator. Missing-rule
success now requires completed exit 7 and an error diagnostic that names the exact absent
`/rules/not-present.yaml`; unrelated errors or result prose cannot satisfy it. Valid-file trials
must have a usable skip inventory and cannot pass if an eligible input is both scanned and
skipped. The inspected tmpfs tokens, mounts and no-new-privileges policy must match the fixed
candidate policy exactly. Both candidates now require an explicitly inspected 2 GiB combined
memory/swap ceiling, in addition to the 2 GiB memory limit.

The historical runs above remain unchanged. They do not contain the newly required memory-swap
observation and cannot satisfy the tightened validator. The integration lead owns a fresh run
with the shared helper's explicit swap limit and retained swap inspection; its resulting evidence
must accompany final acceptance. Frozen input, rule and index hashes and threshold proposals
are unchanged. The focused follow-up passes 13 engine-matrix tests; all 26 existing scanner tests
also pass. No additional scanner trial was started by this lane after the control review.


## Caller-span and input-control corrections

A later independent source review found that all three safe cross-file labels incorrectly cited
the positive caller's line 3. The safe TS, JS and Java caller spans now name line 6; the three
positive caller spans remain line 3. A regression examines all six literal caller locations and
requires trace attribution to use each label's own caller. Source and rule bytes, sink spans,
semantic labels, denominators and threshold proposals remain unchanged. The corrected index
SHA-256 is `6548f0d047e8f80c0aca3b2f0a178003169141f30a66f8d117cb5d585fa39715`; the earlier index hash above identifies the historical measurements only.
The correction affects safe trace attribution, not their recorded finding counts: the retained
runs reported no safe cross-file hits. Earlier raw results remain immutable. The integration lead
must independently review the six caller spans and rerun the corrected committed profile.

The partial, oversized and out-of-rule-language controls now require completed exit zero and usable,
reconciled requested/scanned/omitted/skipped inventories with no unexpected paths. Oversized input
must have the intended path's `exceeded_size_limit`, zero scanned paths, one omission and no findings
or engine errors. Out-of-rule-language input must have zero scanned paths, one omission and no
findings or errors; a silent omission remains an explicit gap. Partial input must retain the intended
malformed line's `PartialParsing` diagnostic and its `analysis_failed_parser_or_internal_error` skip;
an unrelated configuration error or absent intended diagnostic fails the control. A partially scanned
file remains a gap whether or not the valid prefix produced a finding. These are experiment controls
outside the capability denominator, not successful security analyses.

Eighteen engine-matrix tests and all 26 existing scanner tests pass, including negative controls for
unrelated exit-seven/configuration failures, missing/malformed inventories, unexpected paths, spurious
findings and absent or unrelated partial/size diagnostics. No new scanner measurement was run in this
lane after these corrections; the final integrated evidence must identify the corrected index and code.


## Integrated corrected-label measurement

The lead reran all 14 trials at clean probe revision `210e47a036a28b47e0055f274e726d967b2a51dd`
after independently reviewing all six caller locations and integrating both rounds of control corrections.
The [final engine evidence](evidence/2026-10-22-decisions/engine-final.json), SHA-256
`5d4744aa479edf1d206ae9fa47a0c1e2138708ce9fab273dd2ed527bd5bdbe50`, names corrected index
`6548f0d047e8f80c0aca3b2f0a178003169141f30a66f8d117cb5d585fa39715`.
All 14 controls passed with inspected 2 GiB memory-and-swap ceilings, exact temporary-filesystem policy,
intended input diagnostics and exact missing-rule failures. All input identities stayed unchanged and all
14 owned containers were removed. The detection counts in the table above are unchanged: direct pattern
3/3, local taint 6/6, safe hits 0/9 and cross-file 0/3 for each candidate. The three input controls remain
explicit gaps. The [acceptance record](feasibility-acceptance.md) records the independent label review;
owner acceptance of the proposed matrix remains separate.

The [control-corrected intermediate run](evidence/2026-10-22-decisions/engine-controls-corrected.json)
is also retained unchanged. It tested the strict limits/missing-rule checks before the safe-caller label
and input-scenario corrections. Earlier run records retain their exact hashes; none is presented as
checking a later revision.

The missing-rule control expects exit 7 for these exact engine versions. Any engine pin change requires a fresh missing-rule experiment and review of its diagnostics and exit semantics before updating that expectation.
