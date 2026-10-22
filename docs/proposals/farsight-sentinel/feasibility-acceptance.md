# Sentinel PR 01 measured decisions

This continuation starts from merged [PR #132](https://github.com/zalos/farsight/pull/132), `2bd38f6`.
It evaluates the remaining early feasibility choices before the optional production package in PR 02.
The original records in [feasibility results](feasibility-results.md) remain historical evidence.
No production Sentinel contract, framework pack, scanner adapter or UI is introduced here.

## Definition of done

- Original engine labels and inclusive spans are independently reviewed before trials; candidates use the
  same frozen source, rules and limits. A source-to-sink trace crossing the file boundary is required for
  cross-file qualification. A pattern hit alone cannot establish it.
- Framework experiments identify exact packages, probe code, runtime and scope. Each claimed ordering,
  matching or validation behavior has a negative sibling. Calling a framework API is distinguished from
  exercising a full application. Neither establishes a production source-analysis pack.
- Missing tools/resources, required unavailable work, timeouts, cancellation and exhausted budgets retain
  explicit outcomes. A green experiment control can observe an expected failure; it cannot turn omitted
  required security work into completed coverage.
- Resource measurements identify input sizes, repetitions, hardware, process boundaries, elapsed time and
  byte counts. Process lifetime high-water memory is not attributed to one operation. Proposed quotas and
  retention policies are separated from measured capacity guarantees.
- Every actual trial has immutable inputs, revision identity, retained scrubbed outputs, effect limits and
  exact-owner cleanup. Trials execute in Linux containers where external tooling or framework harnesses run.
  Analyzed project sources, package scripts and intentionally vulnerable dependencies are never executed.
- SOL and Claude implementation lanes receive cross-review; the lead reviews integration, reruns the final
  experiments and completes the checks selected by `docs/CI.md`. Original reviews and earlier evidence are
  unchanged. Acceptance names supported, unsupported and deferred capabilities with their reasons.

## Engine criteria established before measurement

The lead reviewed the original engine corpus at `fde63bc`: hashes and literal spans agree with the original
sources. Its paired labels describe SQL structure under the documented query-binding facade assumptions.
The Rust control must be described as outside the selected rules' language scope, not unsupported by the
scanner itself. The Rust correction is retained in the earlier measurements. A second review then found that the three safe cross-file caller spans named the positive call on line 3. Commit `55ccab3` corrects those safe spans to line 6. The lead independently reread all six TS/JS/Java caller locations against their hashed source bytes before the corrected final trial: positives concatenate request text into SQL at line 3; safe siblings pass constant SQL and a separate value at line 6. Sink spans, rules, source bytes, labels and denominators are unchanged. The accepted static-label index SHA-256 is `6548f0d047e8f80c0aca3b2f0a178003169141f30a66f8d117cb5d585fa39715`. The original index review-status field remains unchanged for immutable provenance; this record supplies the independent review. Prior results retain their original index hash and the source-span limitation.

Pattern eligibility requires all three direct positive symbols, zero hits on the nine safe siblings, zero
unattributed findings, no engine errors on valid inputs, and reconciliation of all nine eligible paths. Local
taint qualification additionally requires all six direct/local positives. Cross-file qualification requires
all three cross-file positives and source-to-sink evidence across each named file boundary. Version pins,
unchanged inputs, bounded completed commands and verified cleanup are common prerequisites. These are
micro-corpus criteria; they are not general application precision/recall or the plan's provisional deep-engine
benchmark targets. Out-of-rule-language, malformed/partial and oversized controls are outside those denominators.

## Framework criteria and independent label review

An independent SOL reviewer checked the corrected corpus at `ec7cf5f` before the lead's final measurement.
All 19 source-file hashes match, with no missing or unlisted fixture sources. The four cases contain 11
scenarios and 14 frozen HTTP-status expectations, each aligned with its generated request driver. The
reviewed index SHA-256 is `3fd763363d2f1168b9fe61e1c651ed522a286cc8fae6ca086bcf5bccf86aac36`.
This companion review preserves the original index's author-review field rather than rewriting provenance.

The scope is the original configured applications: Express middleware registration order and a fixed
startup environment branch; a Nest route pipe versus the same declared DTO without a pipe; Next matcher
inclusion, body exemption and exclusion; and two ordered Spring chains plus an unmatched route. Spring
Security is checked against exact version 6.4.3, managed by Boot 3.4.3. The unmatched GET's expectation is
now fixed at 200 before the confirming run; earlier exploratory results remain historical. Each scenario
must provide every declared HTTP field as an integer status and agree with its fixed expectation. Missing,
malformed or partial observations fail. An unknown static label remains unknown regardless of response.

Framework qualification here requires all four exact acquired images and dependency records, reviewed
inputs, complete observations, native Linux ARM64 execution, inspected isolation and verified owned cleanup.
It establishes neither framework-version support in a production adapter nor a vulnerability verdict.
An HTTP status alone is not evidence that every security filter did or did not execute.

## Installation and terms boundary

Tools are installed separately and verified before a run. A scan never downloads a missing scanner or uses a
host fallback. Original rules and synthetic inputs are the only scanned corpus in this continuation; public
benchmark applications remain unacquired. The version-pinned [Semgrep license](https://github.com/semgrep/semgrep/blob/v1.181.0/LICENSE)
and [Opengrep license](https://github.com/opengrep/opengrep/blob/v1.31.0/LICENSE) identify LGPL 2.1. This record
does not approve redistributing their binaries or external rule packs, and none are committed to this repository.

Docker Desktop is an independently installed runtime with its own [subscription terms](https://docs.docker.com/subscription-billing/desktop-license/).
Its [Mac installation requirements](https://docs.docker.com/desktop/setup/install/mac-install/) are separate
from the measured Sentinel experiment limits. Runtime availability or a successful local experiment does not
establish an organization's subscription eligibility. Only measured host/runtime combinations may be proposed
for the initial supported matrix; untested Linux hosts, Colima, AMD64 and Windows cannot inherit that result.

## Later gates remain separate

Production capture/inventory reconciliation remains PR 04/05; the full coordinator recovery matrix remains
PR 08/26; model evaluation remains PR 22; incremental equivalence remains PR 27/28. The scan configuration,
stage inputs/outputs, visual progress and linked reruns remain PR 25, with provider/model selection in PR 25b.
The early prototypes supply design evidence for those gates. They do not claim the later implementations exist.
