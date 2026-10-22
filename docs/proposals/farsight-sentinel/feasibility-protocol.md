# Sentinel feasibility protocol

PR 01 evidence preparation, 2026-10-21. This protocol defines a synthetic corpus and the controls required
to interpret later measurements. It does not accept a framework version, select an engine, approve an
acquisition, or complete PR 01. See [execution readiness](execution-readiness.md) for authorization gates
and [the implementation backlog](implementation-prs.md#pr-01--feasibility-harness-and-capability-decisions)
for the full decision gate. No production Sentinel package or public contract is introduced here.

## Corpus identity and independent labels

The corpus index is
[`cases.json`](../../../packages/sentinel/test/fixtures/feasibility/cases.json). Its draft schema is
`sentinel-feasibility-corpus-v1`, separate from graph contracts and their closed vocabularies. The corpus
lane authors input expectations and security lessons independently of the harness implementation. Labels
start as `needs-independent-review` with a null reviewer. The integration reviewer examined all source and
expected facts on 2026-10-21 and set `reviewed-static-scope`; passing tests do not fill that field. The review
changed Next matcher exclusion and Spring permit-all overlap to `unknown-enforcement`: neither declares a
required-access policy that would establish a vulnerability. This static review does not accept runtime
framework support or engine thresholds. The lead records acceptance separately before ranking engines. The corpus is original synthetic material under the repository license; no private application
code, external benchmark code, real credential, or provider transcript is included.

Each case declares its purpose, E1–E8 gates, source-to-temporary-path mapping, exact SHA-256 of each source,
expected inventory and parser selection, expected semantic facts and scoped labels. Source blobs all end
in `.fixture`. Real ecosystem names, including `package.json`, `package-lock.json`, `pom.xml`, `.gitignore`
and `.github/workflows/check.yml`, occur only as data in the index. They are copied into disposable trees
for an explicit probe. The workflow text is never installed as a repository workflow. The dependency files
are intentionally incomplete candidate declarations, not installable or resolver-verified dependency graphs.
Do not install vulnerable dependencies or run any source-supplied script, plugin, build or fixture application.

`expected.enumerated` is the independently authored set of requested input entries. It includes generated
missing/refused descriptors; a filesystem walk cannot find a missing file, so reconciliation must retain
its explicit missing status rather than silently dropping it. Generated regular files are the UTF-8 bytes
of `repeat` concatenated `count` times, hashed after materialization. A symbolic descriptor records the
link itself and must not be followed. A missing descriptor creates no file. Paths must be relative, remain
inside the temporary root, and never overwrite another case or escape through a symbolic parent.

The ignored-source case also declares `gitIndex`. Its disposable repository stages only those named files
with fixed harness commands and disabled hooks; retaining actual index evidence establishes tracked status.
The generated-intent file is materialized without staging. Ignore bytes and fingerprints are inputs in their
own right, including the nested negation. Do not infer tracked or ignored status just from a filename.
Git administration state is excluded from the source denominator explicitly, not silently treated as source.

Store SHA-256 for the exact `cases.json` bytes, rule blobs, copied input bytes, selected-input list and
retained outputs in the experiment result. The run also names the harness revision, parser/runtime versions,
all parser options, ignore-input fingerprints and source revision. Hashes establish identity, not correctness,
rights or provenance by themselves. A future edit changes the input hash and requires a new measurement;
never rewrite an earlier artifact to make it agree with new expectations.

## Cases and what the labels mean

| Case | Intended lesson and negative control |
|---|---|
| `ts-injection-pair` | TS and JS request text concatenated into SQL versus a constant query with a separate bound value. Safety is limited to SQL structure and assumes placeholder semantics. |
| `js-cross-file-pair` | Request-to-shell flow across files versus fixed executable/format and positional arguments with `shell: false`. A narrow syntax engine has no cross-file capability merely because it finds the sink. |
| `java-injection-pair` | JDBC concatenation versus `PreparedStatement.setString`; neither label certifies authorization or connection configuration. |
| `express-order` | Check before route, check after responding route, unknown custom middleware, conditional bypass and caught async rejection. Session existence does not prove identity strength. |
| `nest-validation` | A decorated DTO without a registered pipe and a parse-only multipart reader must not become enforced-validation claims. An explicit route pipe is a registered candidate whose runtime semantics remain unmeasured. |
| `next-matcher` | Included `/private` and excluded `/public` paths; no global protection is inferred from the middleware body. Cookie existence is the only source-declared check. |
| `spring-chains` | Explicit authenticated chain, earlier overlapping `permitAll` chain and unmatched route; no implicit fallback chain is invented. |
| `hidden-security-config` | Hidden workflow, npm policy, security YAML and an inert credential placeholder stay in security inventory even outside parser languages. |
| `ignored-security-inputs` | Ignored tracked and generated source, nested ignore rule and negation; actual tracked state must be observed separately. |
| `malformed-unsupported` | Malformed TypeScript and unsupported Rust remain separate from successfully parsed source and from parser completeness. |
| `oversized-input` | An 8192-byte generated source exceeds the explicitly pinned 4096-byte parser limit; size omission is a gap. |
| `refused-inputs` | Symbolic boundary and missing ignore file. A real unreadable-ignore trial remains deferred until the host can demonstrate an actual read failure. |
| `model-packets` | Paired clean/hostile source and valid, missing, invented and semantically wrong citation replies; no model call or resistance claim. |
| `differential-edits` | Before/after route and same-named guard inputs plus future global edit classes; no incremental equivalence measurement. |

Candidate versions in fixture manifests identify intended experiment inputs only. They have not been
installed or executed. They are not an exact supported-version matrix, advisory verdict or dependency audit.
DTO declaration, multipart parsing and OpenAPI `guardsOf()`/`matchesGuard()` reconciliation heuristics never
establish runtime enforcement. A static `bounded-safe-pattern` label always names a narrowly enforced property
and its assumptions; it is not a whole-application security verdict. `unknown-enforcement` must stay unknown.

## Original rules and denominators

The two original Semgrep-format rule blobs under `rules/` detect only a concatenating `query` call in TS/JS
and a concatenating `createStatement().executeQuery` call in Java. They contain no imported rule content.
The index records expected vulnerable symbols and safe siblings independently of scanner output. These
are intentionally narrow syntax locators: matching an expression does not establish taint, feasibility of
an exploit, general SQL coverage, or deep analysis. Keep exact rules and input bytes identical across engines.

For this two-rule comparison the positive denominator is three symbols (TS, JS and Java `interpolated`)
and the negative denominator is their three `parameterized` siblings. Count each labeled symbol once;
report duplicate scanner locations separately. Cross-file command flow and framework cases are separate
capability lessons, outside that rule denominator. Report raw hit locations, safe-sibling hits, skips,
unsupported files and parse failures alongside precision/recall; an exit-zero run that skipped a file is
not a clean check. Do not rank engines until reviewers accept labels, rules, denominators and thresholds.

Each expected symbol has independently authored inclusive `startLine`/`endLine` bounds in the index,
tied to the exact source hash. Attribution checks these spans rather than guessing the next declaration
from its syntax. Invalid or overlapping spans and findings outside the declared spans fail the comparison;
a new declaration style requires reviewed bounds before it can join the denominator.

The pinned scanner experiment is limited to an ARM64 host, Linux ARM64 Docker server and ARM64 images.
Other or unknown architectures are refused before materialization or container creation. This prevents
unrecorded emulation; it does not add AMD64 binaries or establish a portable runtime matrix. A network
control passes only for an inspected `none` network and Linux `OSError`/`ENETUNREACH` (101), not a timeout
or a refused connection. Temporary filesystem execution policy is recorded per measured run.

E1's expected parser omissions are observations of parser selection. A `not-analyzed` control records
whether the path was unreported or reported without analysis, and whether a diagnostic exists. A silent
omission remains an explicit security-coverage gap even when it matches the fixture expectation. Requiring
a parser diagnostic would conceal the current ignored-input behavior this experiment is intended to expose.
Unexpected probe exceptions retain a bounded, scrubbed diagnostic without a stack or private home path.

## E1–E8 controls and retained measurements

| Gate | Local PR 01 evidence | Required control and later boundary |
|---|---|---|
| E1 inventory | Public parser selected-file output reconciled with raw input inventory; ignored files, hidden config, TS/Java, nested ignore hashes, malformed/unsupported and size controls. | Retain actual diagnostics and options. `analysis.complete` describes parser selection, not all captured security inputs. Missing, refused and real unreadable boundaries stay explicit. Product capture/inventory guarantees remain PR 04/05. |
| E2 framework | Source-grounded order, matcher, chain and validation labels. | Review every positive against bypass/late/unknown negative siblings. Exact framework behavior needs separately pinned runtime probes before support claims; full packs are PRs 14–17. |
| E3 engines | Same two original rules, input bytes and limits for eligible candidates. | Retain exit-zero skip and unavailable engine/file coverage facts. Compare the labeled SQL pair, then separately test cross-file flow; absence of a finding never certifies a file. |
| E4 ownership | Lane C's isolated SQLite ownership/revision/publication prototype and contention/corruption evidence, when actually run. | Duplicate, revision mismatch, interrupted publication and owner contention must remain visible. Container cleanup/identity needs separate eligible probes. The full coordinator does not exist: twenty kills per publication boundary remain PR 08/26, claim expiry/takeover PR 23b. |
| E5 models | Synthetic paired packets and invalid reply controls prepared without disclosure. | Citation membership, missing citation and wrong answer are separate validator checks. Live two-model/five-trial labeled evaluation, threshold approval and model-specific variability remain gated at PR 22. |
| E6 equivalence | Controlled edit classes and the full-run oracle defined. | Add/remove route, framework-only bump, narrowed rule, advisory-only update and renamed same-named guard must broaden invalidation correctly. No incremental engine exists; equivalence remains unrun until PR 27/28. |
| E7 offline | Local parser probes can record no acquisition effects; eligible scanner trials separately enforce network denial. | Missing executable/database and a required unavailable online check must yield an explicit gap. Process intention or a flag is not proof of denied networking; retain container isolation facts. No host fallback. |
| E8 resources | Fixed inputs, artifact sizes, wall time and runtime memory measurements where available. | Oversize/budget exhaustion and unavailable measurement are controls. Name hardware, OS, runtime, VM limits and units; JVM heap is not RSS. Model estimates are not observed token usage. Unchanged product `/graph` remains a later gate. |

The storage/codec prototype may establish behavior only at its tested local boundary. It cannot claim
durable production recovery, orphan container cleanup, source restoration after checkout removal, or future
incremental correctness. The input corpus supplies lessons; measured results must say which code was actually
executed, failed, deferred or not run. Mock observations and estimates must never be recorded as measurements.

## Bounded experiment and demonstration procedure

1. Review the accepted architecture and existing authorization. Record exact effects, source rights,
   immutable tool/image/rule/database pins, resource limits and output directory in the lead's draft manifest.
   Missing prerequisites mean that experiment is not run; independent source-only work can continue.
2. Validate index hashes and reviewed labels, materialize only selected cases in a new temporary root, retain
   inventory/statuses and ignore fingerprints, then run the public parser with pinned options. Preserve raw
   `analysis.files`, diagnostics and completeness; reconcile rather than silently correcting source selection.
3. External scanners run only in authorized Linux containers with no host fallback, network disabled,
   read-only source/rule mounts, an isolated writable output directory, dropped privileges and explicit limits.
   Record actual image/tool identity, mounts and cleanup owner. No silent image pull or registry/provider call.
4. Demonstrate the same SQL vulnerable/safe siblings across eligible engines. Show raw output and labeled
   symbols together. Show a skipped/oversized/unsupported file and a missing-tool/database offline failure.
   Explain explicit gaps, including any engine that could not run. Never substitute mock output for a trial.
5. Retain input/output SHA-256, commands as argument arrays, timestamps, exit states, artifact sizes, time and
   memory provenance. Keep unavailable metrics null with a reason; record measurements separately from decisions.
   Stop on escaped mounts/paths, unexpected execution/network effects, corrupt evidence, or exceeded limits.
6. Review unexpected differences and labels; the owner accepts or rejects measured matrix/thresholds. Update
   the result record with remaining gates. Fixture preparation, green harness tests or a narrow scanner result
   alone cannot complete PR 01 or authorize PR 02.

Public retained records contain only synthetic/redacted evidence. No actual secrets need to be materialized.
`NOT_A_SECRET_DO_NOT_USE` and `FIXTURE_CANARY_ONLY` are inert test text; any new scanner exception requires
review of the exact inert line rather than a directory allowlist. Run repository secret checks before sharing.
