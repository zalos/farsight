# Farsight Sentinel execution and data contracts

Status: proposed contracts · 2026-10-17. These examples describe intended behavior, not available commands or
frozen schemas. Read the [proposal](../farsight-sentinel.md) for scope and the
[workflow research](research-workflows.md) for evaluated alternatives.
Repository baseline: `4fce1c8` (PR #115). Primary-source access date: 2026-10-17.

## 1. Records and ownership

Use a dedicated `.farsight/sentinel/sentinel.db` and immutable blobs under `.farsight/sentinel/objects/`.
The path is a proposed local default, excluded from Git. One coordinator owns ledger writes, enforced by an
exclusive owner-held OS process lock bound to the canonical ledger path; a second client connects to that owner
or reports it unavailable rather than starting a second scheduler. Concurrent workers return bounded results
over the worker protocol. Keep transactions short and gate `process.versions.sqlite` against verified fixed
releases (3.51.3+ within the 3.51 family or 3.53+; reject withdrawn 3.52.0), recording the actual runtime,
foreign keys, schema migrations and a consistent backup/export operation. Do not put the database on a network
filesystem or copy a live SQLite file without accounting for its WAL.

| Record | Essential fields | Owner |
|---|---|---|
| `Snapshot` | ID, SHA-256 inventory digest, repo identities/commits, dirty-tree state, environment profile digest, capture policy, `fileInventory` with a primary class per entry and stage coverage, `frameworkVersions` resolved from lockfiles with provenance/unknowns, graph/diagnostic artifacts | Snapshot service |
| `Artifact` | SHA-256 of canonical uncompressed content, media/schema type, codec/version, compressed digest/size, uncompressed size, relative object path, retention/privacy class | Artifact service |
| `RulePack` / `RuleRevision` | Immutable content hashes, upstream references, mappings, license, fixtures, capabilities, applicability, detector/locator/reviewer implementations | Rule registry |
| `Run` | ID, parent/baseline, snapshot, rule lock, engine/adapter versions, provider/prompt policy, requested scope, budgets, plan revision, status, creation time | Coordinator |
| `Surface` | Stable candidate identity, kind, repository/node references, discovery evidence, environment, supported/unknown boundaries | Inventory planner |
| `Check` | Surface or whole-scope ID, rule revision, mode, environment, applicability/reason, required capabilities, dependencies, execution and coverage facts | Deterministic planner |
| `WorkUnit` | Stage contract/version, input references, implementation, task fingerprint, dependencies, resource policy, coordinator epoch and active attempt; external-claim lease/fencing generation when applicable | Scheduler |
| `Attempt` | Work ID, ordinal, owned child or external worker identity, operation ID, timestamps, external-claim heartbeat when applicable, terminal state, tool/model invocation, output/error references, usage and its certainty | Worker supervisor |
| `Observation` | Immutable original scanner/model claim, producer rule ID, severity/confidence as supplied, source spans, path/control evidence, limitation references | Output validator |
| `Finding` | Correlated observation IDs, weakness identity, affected scope, normalized assessment, fingerprint version, first/last seen, lifecycle events | Finding service |
| `Disposition` | Finding/scope/rule, actor identity and trust, rationale, evidence dependencies, environment, expiry, supersedes, validity | Policy/adjudication service |
| `DeploymentAssertion` | Owner, environment/deployment identity, property, scope, evidence hashes/references, last verification, expiry, trust level (`asserted`, `imported-config`, `runtime-observed`) | Control evidence service |
| `RunEvent` | Monotonic sequence, event type, run/work/attempt IDs, actor, timestamp, payload reference | Coordinator |
| `Report` | Run and ledger revision, evaluation time, artifact closure, renderer version, privacy profile, optional comparison baseline, completeness | Report service |

Relationships such as `depends_on`, `consumes`, `produces`, `retries`, `supersedes` and `reuses` form the execution
graph. Its vertices are jobs and artifacts, not new kinds in the application graph. Project application references
use `{snapshotId, nodeId, sourceBlobDigest, span}`. Findings without a graph node still have a file/blob location;
CI files and unsupported source must not disappear just because they lack a parser-generated node.

The independent file inventory reconciles `parseRepository()` outcomes with non-parser inputs and exclusions;
unreadable/excluded directory descendants have an unknown count, not a fabricated complete denominator.
Primary classes and stage coverage are separate dimensions; `seen by no stage` is always printed. Parser
`complete` alone is not security coverage. Assertion provenance is likewise separate from graph evidence classes.
Disposition scope cannot exceed finding scope; partial path coverage leaves the remaining paths open.
An unverified deployment assertion never satisfies a mitigation gate. Framework/deployment changes, reduced
resolution confidence, new entry points and expiry invalidate dependent assertions/decisions.

Store sufficient configuration to reconstruct an invocation: executable/container digest, script path and digest,
argument array, redacted environment identity, working-directory policy, rule/query hashes, analyzer database
reference, exit code and bounded logs. Never store resolved credentials in the invocation record.

## 2. Stage and worker contract

```ts
// Illustrative shape; the implementation must publish a versioned JSON schema.
interface StageManifest {
  id: string;
  contractVersion: string;
  implementationDigest: string;
  kind: 'coded' | 'agentic' | 'external-tool';
  capabilities: string[];
  inputSchemas: string[];
  outputSchemas: string[];
  languages: string[];
  frameworkVersions: Record<string, string>;
  reuse: 'deterministic' | 'explicit-agent-reuse' | 'never';
  dependencyScope: 'files' | 'service' | 'repository' | 'workspace';
  coverageGranularity: 'per-file-per-rule' | 'per-file' | 'aggregate';
  effects: {
    build: boolean;
    dependencyResolution: 'none' | 'local-cache' | 'remote';
    databaseFetch: boolean;
    telemetry: 'off' | 'on';
    network: string[];
    runtimeTargets: boolean;
  };
}

interface StageResult {
  workId: string;
  attemptId: string;
  coordinatorEpoch: string;
  fencingGeneration?: number; // Required for an external claim, not an owned child.
  inputFingerprint: string;
  artifacts: ArtifactRef[];
  observations: ObservationRef[];
  coveredChecks: CheckEvidence[];
  scannedSet: ScopeRef[]; // Never claim finer coverage than the engine exposes.
  skipped: { scope: ScopeRef; reason: string }[];
  actualReadSet: SourceRef[];
  unresolvedFrontiers: FrontierRef[];
  diagnostics: DiagnosticRef[];
}
```

Required capabilities are properties such as source spans, call occurrences, resolved receiver types, framework
order, interprocedural flow and runtime observations. A stage is scheduled only when its implementation can meet
the selected check's contract, or a clearly weaker alternative is explicitly recorded. Never let an agentic
substitute for a deterministic parser claim the same provenance simply because its JSON validates.
Spring/Express/Nest protection stays unknown without the relevant `framework-order` pack; checks requiring
that capability are `unsupported`, even when a name-matched guard exists.

Worker messages include start, progress, checkpoint, result and cancel acknowledgement; client-hosted claims
add heartbeat. Owned child workers use process/exit supervision instead of wall-clock leases. Model-backed
workers checkpoint between completed tool/model operations; the protocol does not promise recovery of a remote
provider's partial generation. A restarted worker may need a new model call.

Only the coordinator publishes outcomes and extends the plan. Workers cannot edit the ledger, approve rules,
broaden targets or delete evidence. Use argument arrays rather than shell interpolation. Repository paths,
module names, scanner output and model-selected evidence IDs remain untrusted protocol data.

## 3. Run and attempt state

Run control uses `planned`, `running`, `pausing`, `paused`, `canceling`, `canceled` and `completed` states.
Completion has a separate outcome: complete coverage, partial coverage or execution failure. Findings are
independent of that outcome; a fully completed run can contain critical findings.

A work unit starts `pending`, becomes `ready` when dependencies permit, then starts an owned `running` attempt
or an externally `leased` attempt. Attempts end as `succeeded`, `failed`, `interrupted`, `canceled` or
`canceled-after-spend`; the last requires confirmed incurred usage, while unknown usage is a separate fact.
External lease expiry is a recorded interruption, not proof the old process stopped. A work unit can also be blocked by a dependency, disabled by policy or
satisfied by explicit reuse. Applicability such as “not applicable” is a check decision, not a fake successful attempt.

Coverage is separate again: `complete`, `partial`, `unsupported`, `not-run`, or `error`, always with scope and
reason. A detector that exits successfully but skipped files may produce useful findings with partial coverage.
“No finding” is an observation about a completed check, not a terminal scheduler state or a claim of safety.

Scanner adapters must report the granularity they can establish: selected rules, scanned file/scope set,
exclusions, parser skips, timeouts and execution status. Empty findings alone do not prove every rule ran.
If an engine cannot expose per-file/per-rule execution, record its supported aggregate scope and the missing
detail rather than inventing a matrix of successful checks. Preserve the planned check records for that gap.
Use `scannedSet`, `skipped[]` and declared granularity to reconcile each adapter with the inventory. Timeouts,
size limits, unavailable resolution, online-only audits and unsupported syntax stay visible even on exit 0.

These are internal Sentinel contract states. Existing Farsight test evidence remains `declared/static/observed`
internally and `declared/reached/observed` in its matrix contract. Model review is not observed execution. Existing
absence words stay unchanged; new UI terms must pass the two-register catalog design and lint rules.

### Crash-safe completion

1. In a short transaction, allocate ready work to an attempt and coordinator epoch. For external review, also
   issue an expiring scoped claim and increment its fencing generation.
2. Execute against pinned inputs in isolated scratch space. Track owned process identities and exits; external
   claim heartbeats extend the lease only for its owner.
3. Write output blobs to temporary files, validate schemas and limits, hash contents, flush and atomically rename
   them into the object store. A worker's reported digest is checked by the coordinator.
4. In one transaction, verify current attempt ownership and coordinator epoch, expected inputs and that the run
   still accepts publication; for external claims also validate the eligible lease and fencing generation.
   Then link artifacts, append observations/check evidence,
   mark the accepted attempt and release dependent work. Expiry/cancellation revokes publication eligibility
   even before a replacement worker is scheduled. Pausing can permit completion; canceling cannot.
5. Emit progress from committed state. Orphaned blobs from a crash before step 4 are safe to collect after a
   grace period; referenced blobs are pinned. A late superseded worker cannot publish.

Execution is at-least-once. Publication is unique per accepted work revision. Provider request IDs and idempotency
keys reduce duplicate cost only where supported. A timeout with unknown provider completion is recorded as such,
with bounded retry policy; it is not evidence that no tokens were spent. Cancellation stops admission, signals
owned workers, and waits or fences them; it never kills unrelated processes.

Coordinator restart marks unfinished owned attempts interrupted and reconciles recorded process identities.
Children may survive parent death; process groups facilitate targeted cleanup but do not guarantee lifetime
coupling. Use the isolation backend to terminate verified owned descendants before a replacement attempt;
if ownership cannot be safely established, block replacement and report it. Epoch/attempt checks reject late
publication in either case. Begin conservatively with one admitted heavy analyzer and one model request,
subject to configured memory/token reservations; E8 measures defaults before increasing concurrency.

Pausing stops new work and lets current work finish or checkpoint under the configured policy. A forcibly
interrupted attempt can retry. Resuming a canceled run requires an explicit operation; changing pinned inputs
always forks a child run rather than rewriting past records. A forced rerun also forks a child run; fresh
upstream artifact hashes drive downstream fingerprints and dependent checks before reuse is considered.
Partial reports remain available during interruption. Reports pin evaluation time so an expiring disposition
can be reproduced as it was assessed; a report regenerated for today's validity is a new report revision.

## 4. Input identity and reuse

Build artifact and work fingerprints from canonical serialization and SHA-256. Each stage declares its
**influence set**, conservatively covering everything that could change its answer. This differs from an
agent's actual read set, which is retained for audit but cannot alone justify caching negative results.

```text
workFingerprint = SHA256(
  stage contract + implementation/binary/container digest + input schema versions +
  ordered input artifact hashes + influence-set manifest +
  rule/query pack hashes + framework model hashes + effective settings/environment +
  advisory database snapshot + prompt template/tool policy + model identity/parameters +
  relevant budgets and analysis limits
)
```

Only include inputs relevant to that stage. A model change does not invalidate parsing; a renderer change need
not rerun checks. Effective parameters, canonical path handling, include/exclude policy and parser capabilities
must be part of the appropriate keys. Mutable model aliases are recorded as requested identities; exact returned
model/revision or local weight digest is recorded when available. Unknown identity prevents claims of exact rerun
equivalence. Temperature zero does not make a model deterministic.

| Change | Reuse permitted | Work required |
|---|---|---|
| Restart, identical pinned inputs | Completed validated units | Reconcile owned children/external claims and retry interrupted/failed units according to policy |
| New rule pack | Snapshot and compatible parse/layer artifacts | Recompute rule applicability, run added/changed checks across their scope, revalidate affected dispositions |
| Model, prompt or agent tool policy | Deterministic outputs | Rerun affected guided/general reviews and downstream assessments/reports |
| Source edit | Compatible unaffected artifacts | Reparse changed inputs; recompute semantic dependents, affected layers, paths and checks |
| Shared middleware, matcher, security config or DI edit | Artifacts outside its conservative scope | Invalidate all potentially governed entry points and decisions; broaden to service/workspace if uncertain |
| Framework lockfile/version change | Unrelated syntax artifacts | Resolve framework versions again; invalidate layer facts and dependent entry checks/dispositions even with unchanged source; report changed detection |
| Dependency lockfile or advisory database | Proven unrelated artifacts | Refresh dependency assessment and any semantics affected by changed packages; retain resolution/database retrieval time and digest |
| Rule applicability narrows or detection semantics weaken | Compatible upstream facts | Recompute affected coverage and report changed detection; never resolve an old finding because its detecting check disappeared |
| LOW-confidence resolution plus added/removed/renamed candidate declaration | Evidence outside a proven candidate scope | Re-resolve all affected candidates and callers, including unchanged callers; invalidate dependents or broaden to the service if candidate scope is unknown |
| New/deleted entry point or file | Existing evidence with proven compatibility | Re-enumerate inventory and applicability; retain tombstones and lost coverage |
| Parser, framework adapter, include/exclude or schema change | Only explicitly compatible artifacts | Recompute affected inventory/facts; default to full relevant service scope |
| Disposition expiry or control evidence change | Original observations | Reopen adjudication and rerun dependent control checks; report the invalidated decision |
| Missing blobs or incompatible baseline | Nothing dependent on missing evidence | Restore verified artifacts or perform broader fresh work and label historical limits |

A negative finding depends on possible undiscovered paths as well as known edges. Unknown/dynamic calls,
reflection, generated source, unmodeled service boundaries and wide configuration make narrow reuse unsafe.
Record the conservative scope and reason. Preserve removed edges and old inverse dependencies long enough to
invalidate callers when a control or callee disappears.
Call-site fingerprints include occurrence IDs, source/span hashes, resolution confidence and relevant resolved
framework versions. At `4fce1c8`, occurrence IDs hash coordinates and relationship identity; they are snapshot
evidence anchors, not a cross-revision stable finding ID. Reuse never relies on matching an occurrence ID alone.

An explicit “reuse agent result” policy can carry a validated prior observation forward with its original model
and run attribution. The default for a requested model re-review is a fresh observation. Neither reused results
nor imported reports count as newly executed checks.

## 5. Source bundle and retention

```text
scan-bundle/
  manifest.json            snapshot/run IDs, schema/codec versions, artifact closure and hashes
  report.json             full normalized report and completeness
  report.html             readable projection with private details redacted as configured
  ledger.sqlite           consistent export of this run and required lineage
  objects/sha256/...       compressed source, graph, diagnostics and analyzer outputs
  rules.lock.json         exact approved packs and implementations
  tools.lock.json         versions, digests, platform requirements and provenance
```

Use gzip initially. Node 24 has experimental zstd in `node:zlib`; benchmark size, CPU, memory and portability
against gzip during feasibility before selecting it, with no added native packaging dependency by default.
Hash canonical uncompressed contents and separately verify archive bytes. Validate
archive entry paths, symlinks, object count, expansion ratio and size limits before import. Import does not
execute bundled scripts. A manifest is data, not an executable instruction set.

The source snapshot captures bytes consistently: stage a private copy, verify the original did not change during
capture, and retry or reject a mixed snapshot. Resolve source symlinks by policy and never follow them outside
authorized roots. Record submodules, LFS availability, generated-code policy and external configuration references.
Do not archive unrelated home files or resolved secrets.

Rules requiring excluded material cannot be replayed completely. Private source retention is necessary for
future arbitrary rules; a graph-only bundle supports only checks satisfied by its retained facts. Private replay
bundles and shareable redacted reports are distinct exports. Redacting an artifact creates a new derivative with
its own hash and a declared loss of replay fidelity; it never changes the original evidence silently.

Retention is by artifact reachability from pinned reports/runs. Deletion or expiry that removes replay inputs
updates an availability record without rewriting the old result. A retained Sentinel bundle must survive ordinary
Farsight graph snapshot pruning by owning a copy of every referenced graph artifact. Initial garbage collection is
conservative, transaction-aware and separately invocable.

## 6. Finding identity and report comparison

Keep observation identity separate from issue identity. An observation belongs to one producer invocation;
an issue groups evidence for a particular weakness in an application context. Do not use line numbers alone as
stable IDs. Candidate fingerprints use repository/service identity, rule family, source/sink/control anchors,
normalized symbol identity and location/context hashes, with a versioned matching algorithm.

Renames and refactors may produce uncertain matches. Preserve that uncertainty for review rather than silently
closing one issue and opening another. A finding may have several entry paths and several engine observations;
its count is one finding, while affected entry-point counts have their own scope and denominator.
Within the same repository/service and issue context, the same rule family and exact source/sink/control anchor
set is an exact-match candidate. A moved span within the same declaration is a probable match requiring review
unless the versioned matcher has independent continuity evidence. Multiple same-named declarations or competing
matches remain ambiguous; never choose the first one or collapse distinct weaknesses sharing a sink.

Comparison labels include new, persistent, changed evidence, changed detection, reopened,
`reopened: disposition expired`, resolved by comparable check, removed
surface, unassessed in current scope and incomparable conditions. Rule/model/database/environment changes appear
beside them. Removing a vulnerable endpoint can be a remediation, but distinguish removal from a successful
recheck of a still-existing endpoint. A failed analyzer cannot resolve its prior findings.
Resolution requires comparable completed coverage with the same rule revision, engine implementation digest,
relevant capability set and assessment conditions, or an explicit reviewed compatibility mapping. A changed rule,
engine or capability without that mapping produces `changed detection` and preserves the unresolved historical
finding. Broader current coverage alone does not establish equivalent detection behavior.

SARIF exports preserve tool/rule identity, locations, related locations, fingerprints, code flows and applicable
suppression records; producer results remain attributable after aggregation. Sentinel's JSON and private bundle
remain authoritative for all checks, attempts, plans and model evidence. VEX is optional for component-vulnerability
status assertions; do not export every SAST false positive as a VEX “not affected” statement.
Use stable rule family as SARIF `ruleId` and put rule revision in properties. Store Sentinel's versioned issue
fingerprint under its own `partialFingerprints` key; GitHub's `primaryLocationLineHash`, if emitted, must use its
documented source-line hashing semantics, not an arbitrary issue ID. Export platform limits explicitly: GitHub
accepts up to 25,000 results per run but displays the top 5,000; the complete report remains locally available.
The [workflow research](research-workflows.md) retains the SARIF sources and other limits.

## 7. Agent provenance

Every generation records provider adapter and version; requested and returned model IDs; model revision/weight
digest when available; parameters; prompt template revision; tool policy; exact context artifact references;
response artifact; timestamps; finish/truncation reason; usage/cost with provenance; and concise rationale,
counter-evidence and uncertainty. Store auditable inputs, outputs and tool actions, not private chain-of-thought.

A hosted provider can change implementation behind an alias. Label such replay as a new assessment rather than
bit-for-bit reproduction. A client-hosted agent submission uses `identitySource: host-reported`, `self-reported`
or `unknown`; a later extension may record `host-reported-vscode-lm` with exposed ID/vendor/family/version, while
a trusted provider adapter can record `provider-response` identity. Host identity is not provider attestation.
Each adapter records retention/training terms, their source/access date and metering provenance. Provenance has trust levels,
not just a required model-name string that encourages fabrication.

Agent tools initially expose bounded source slices, graph neighborhoods, layer evidence, check definitions and
candidate output submission. No arbitrary shell or network tools. Large paths use indexed evidence and paginated
expansion; any context omitted because of budgets appears as a coverage limitation. Agent-written summaries
cannot become authoritative control facts without validated underlying evidence and the adjudication policy.

## 8. Illustrative interfaces

All examples below are proposed, not implemented commands. `farsight sentinel` is an optional host alias for
`farsight-sentinel`; absent installation returns setup instructions without downloading or starting anything.

```sh
farsight sentinel rules update --stage
farsight sentinel rules validate --pack ./security-rules
farsight sentinel rules promote --candidate candidate-id
farsight sentinel plan --profile static --out plan.json
farsight sentinel run --plan plan.json --detach
farsight sentinel status --run run-id --json
farsight sentinel status --run run-id --wait --json
farsight sentinel pause --run run-id
farsight sentinel resume --run run-id
farsight sentinel retry --run run-id --stage entry-review --failed
farsight sentinel rerun --from run-id --rules rules-lock.json
farsight sentinel rerun --from run-id --model review-provider --stage agent-review --force
farsight sentinel run --baseline run-id --changed --audit-selection
farsight sentinel compare --from run-id --to next-run-id
farsight sentinel report --run run-id --format sarif --out sentinel.sarif
farsight sentinel bundle --run run-id --profile private-replay --out scan-bundle.tar.gz
```

Planning lists capabilities, intended source disclosure, build/runtime effects, projected work and limits.
Starting work checks trusted local policy. Proposed exit codes: 0 policy satisfied, 1 finding policy failed,
2 required coverage incomplete, 3 configuration/infrastructure error. JSON carries all facts when several apply;
precedence is configuration error, coverage incomplete, findings, success. `--detach` exit 0 means submission
only and returns the run ID; CI uses `status --wait` for the recorded policy outcome. Unverified mitigation
assertions never satisfy that policy.

`tools.lock.json` keys entries by adapter ID and pins executable/container version and digest, platform,
default argument policy, provenance and rule/database references. Planning verifies the lock against installed
tools; a repository lock cannot authorize downloading or executing a binary by itself.

MCP tools should mirror service operations: `sentinel_plan`, `sentinel_start`, `sentinel_status`,
`sentinel_pause`, `sentinel_resume`, `sentinel_cancel`, `sentinel_retry`, `sentinel_findings`,
`sentinel_check`, `sentinel_evidence`, `sentinel_compare` and `sentinel_report`.
For client-hosted review, add `sentinel_claim_review`, `sentinel_review_heartbeat` and
`sentinel_submit_review`. Claim returns a scoped evidence packet and an expiring capability bound to workspace,
run, work, attempt, input digest and fencing generation. Heartbeat/submission require that binding and the
claimed provenance trust level; the coordinator revalidates citations and scope before publication. A client
cannot submit against a superseded snapshot or invent a provider-verified model identity.
Keep reads separate from mutations; scan-start or retry may incur cost, build code or send approved context.
Do not place these operations in an existing default read-only tool tier. Long operations return run IDs;
bounded polling/result tools work even without client support for MCP task extensions.

Farsight HTTP routes use an opt-in `/api/sentinel/…` bridge with the existing loopback/origin/body-size guards.
Every mutating path must join `isWriteRoute` and honor `--read-only`. The bridge has a protocol handshake and
reports unavailable/version mismatch explicitly. It cannot bypass Sentinel's own policy through claimed human
identity. Local OS-user trust remains the boundary; shared-team authorization is separate future work.

## 9. Illustrative configuration split

Version-controlled scan intent can live in `sentinel.config.json` with a reviewed example file:

```json
{
  "schemaVersion": "draft-1",
  "sources": ["api", "web"],
  "languages": ["typescript", "javascript", "java"],
  "ruleLock": "security/rules.lock.json",
  "toolLock": "security/tools.lock.json",
  "profiles": {
    "static": {
      "detectors": ["sentinel", "semgrep-ce", "osv", "gitleaks", "trivy", "zizmor"],
      "agentReview": {"guided": false, "general": false},
      "runtime": "disabled"
    },
    "review": {
      "extends": "static",
      "agentReview": {"guided": true, "general": true, "providerRef": "security-review"}
    }
  }
}
```

This file requests capabilities; it cannot grant them. Provider endpoints, credentials, trusted binaries/packs,
network/build/runtime permissions, source-export policy, cost/concurrency limits and trust receipts live in
owner-controlled local settings outside the checkout. Local files have scrubbed examples and remain untracked.
The `semgrep-ce` ID illustrates one adapter choice, not a winner selected before E3. Model profiles require
owner-configured `maxTokensPerRun` and `maxCostPerRun`; planning estimates work and reserves budgets before calls,
and unknown usage remains conservatively reserved until reconciled.
Trusted settings select the effective policy after examining repository intent; untrusted PR changes cannot
turn on hosted inference, weaken checks, approve a suppression or run a build.

Support offline deterministic, configured-agent and external-agent profiles through the same planner. Missing
providers/tools are visible prerequisites or coverage gaps, never reasons to drop checks silently. Exact enum
sets, defaults, migration behavior and public schema names are settled and tested in the implementation ADR.
