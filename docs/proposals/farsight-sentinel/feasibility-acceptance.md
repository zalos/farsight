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
scanner itself. The corrected immutable index and measurement records will identify the final inputs.

Pattern eligibility requires all three direct positive symbols, zero hits on the nine safe siblings, zero
unattributed findings, no engine errors on valid inputs, and reconciliation of all nine eligible paths. Local
taint qualification additionally requires all six direct/local positives. Cross-file qualification requires
all three cross-file positives and source-to-sink evidence across each named file boundary. Version pins,
unchanged inputs, bounded completed commands and verified cleanup are common prerequisites. These are
micro-corpus criteria; they are not general application precision/recall or the plan's provisional deep-engine
benchmark targets. Out-of-rule-language, malformed/partial and oversized controls are outside those denominators.

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
