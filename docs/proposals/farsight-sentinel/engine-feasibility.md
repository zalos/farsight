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
