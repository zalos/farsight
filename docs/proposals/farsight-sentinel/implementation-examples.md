# Farsight Sentinel implementation examples

**Status:** design examples for review, 2026-10-17. Except for the existing parser imports, the APIs and CLI
commands below are proposed. They are not available commands or production implementations. The SQL is a
small executable relational skeleton; TypeScript orchestration examples omit helper implementations deliberately.
Full runtime schemas, bounds, migrations and error catalogs belong to their implementation PRs.

Read the [architecture](implementation-plan.md) for invariants and the [PR build plan](implementation-prs.md)
for when each part is built. Examples show the boundaries a reviewer should be able to test.

## 1. Consume the existing parser without copying its internals

**PR 05.** These import paths and adapter names exist at application baseline `4fce1c8`.

```ts
import { createParser } from '@farsight/code-parser';
import { tsJsAdapter } from '@farsight/code-parser/adapters/tsjs';
import { javaAdapter } from '@farsight/code-parser/adapters/java';

const parser = createParser({ adapters: [tsJsAdapter, javaAdapter] });

export async function parseCapturedSource(
  materializedRoot: string,
  sourceId: string,
  signal: AbortSignal,
) {
  return parser.parseRepository({
    root: materializedRoot,
    sourceId,
    testFiles: 'include',
    limits: {
      maxFiles: 20_000,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
      maxEntries: 100_000,
      maxDurationMs: 120_000,
    },
    signal,
  });
}
```

The numeric limits are illustrative profile inputs to measure in E1/E8, not approved defaults. Run this in
a supervised worker because the parser's native synchronous work is cooperatively interruptible between
operations. A wall-clock supervisor can terminate the worker while recording its incomplete scope.

Persist the entire returned artifact. Reconcile `analysis.files` and `analysis.inputs` with the independent
capture manifest; content input hashes must equal the captured bytes. Directory, missing and metadata
fingerprints represent different input kinds and must not be compared as file hashes. Preserve diagnostics
without inventing line numbers. `analysis.complete` remains parser completeness only.

There is no injected reader in this API. PR 05 privately materializes and enumerates only captured inputs,
checks its entry set/bytes before and after parsing, and validates each recorded input against that tree:
content = raw-byte SHA-256; directory = SHA-256 of canonical JSON of sorted entry names; metadata = SHA-256
of the parser's `file`/`directory`/`special` kind; missing = SHA-256 of `unavailable`, after checking the path
is in scope and absent. Pin this codec to the parser version with conformance fixtures. Missing-input checks
must respect refused boundaries rather than probing the original checkout. The built-in repository reader
also refuses traversal/symlink escapes. This verifies the materialization and recorded reads; it is not a
claim that every OS read by arbitrary native or third-party code has been intercepted.

## 2. Capture facts and analysis outcomes are different records

**PRs 02, 04, 05.** Use one immutable capture record and append analysis evidence separately.

```ts
type Digest = `sha256:${string}`;
type ArtifactId = Digest;

type CaptureEntry = {
  sourceId: string;
  relativePath: string;
  kind: 'file' | 'directory-boundary' | 'symlink';
  disposition: 'included' | 'excluded' | 'refused' | 'unreadable' | 'too-large';
  reasonCode?: string;
  content?: ArtifactId;
  bytes?: number;
  generated: boolean;
  // null means descendants were not individually enumerated.
  knownDescendants: number | null;
};

type SourceEvidence = {
  snapshotId: string;
  sourceId: string;
  relativePath: string;
  content: ArtifactId;
  // Sentinel spans are zero-based, half-open UTF-8 byte offsets.
  span: { startByte: number; endByte: number };
  quoteDigest?: Digest;
  nodeId?: string;
  occurrenceId?: string;
};

type CoverageEvidence = {
  checkId: string;
  workId: string;
  workRevision: number;
  status: 'complete' | 'partial' | 'unsupported' | 'not-run' | 'error';
  granularity: 'per-file-per-rule' | 'per-file' | 'aggregate';
  assessedScopeArtifact: ArtifactId;
  limitationsArtifact: ArtifactId;
  basis:
    | { kind: 'executed'; attemptId: string }
    | { kind: 'reused'; publicationId: string; derivationArtifact: ArtifactId }
    | { kind: 'imported'; provenanceArtifact: ArtifactId }
    | { kind: 'unavailable'; reasonCode: string };
};
```

The JSON schema refines these shapes: an included file requires content/size; a refused symlink has no
captured referent; bounds and digest patterns are checked at runtime. Byte spans require adapter conversions
from UTF-16 indexes or one-based line/column coordinates. Reject an unconvertible citation instead of silently
shifting it. Evidence identity includes source ID, so identical paths in two repositories remain distinct.

Imported/reused evidence does not count as executed now. A coverage record does not say a check found no
issue: findings and coverage are independently queried. A completed aggregate scan cannot establish a
per-file/per-rule denominator it never reported.

**PR 19 adds report-side application placement.** This projection never changes `SourceEvidence` or the
application graph schema. A parser-only artifact has no journey metadata; first retain enriched application
context with a source-binding receipt, or derive bounded context from captured local design/config inputs.
The helper must verify source/parse/enrichment identities, not just a matching commit or node name.

```ts
import type { Counted } from '@farsight/core';

type FindingPlace = {
  context?: {
    artifact: ArtifactId;
    sourceBindingReceipt: ArtifactId;
    projectionVersion: string;
  };
  binding: 'matched' | 'mismatched' | 'unavailable';
  nodeIds: string[]; // Canonical IDs, including the source/repository identity.
  screens: Array<{
    id: string;
    via: 'direct-use' | 'potential-impact';
    evidenceArtifact: ArtifactId;
  }>;
  journeys: Array<{ id: string; screenIds: string[] }>;
  personas: Array<{
    id: string;
    screenIds: string[];
    declared: boolean;
    evidenceArtifact: ArtifactId;
  }>;
  counts: { screens: Counted; journeys: Counted; personas: Counted };
  limitationKeys: string[];
};
```

Use cached core `flowWalks`/`affectedReach`, `journeyTree` and `personaOfScreen` in the report fold, once per
context rather than per rendered row. Dedupe each count's IDs; overlapping persona groups do not form an
additive screen breakdown. Empty placement is valid for a workflow/dependency finding or missing context.
The business register can say “Invoice submission needs review: the approval check is not known to cover
this action.” The code register adds route, rule, producer and weakness details. Both reference the same
finding and limitations; neither says reachability establishes exploitability. Apply the same shape to gaps.

## 3. Define a rule and its applicability before its worker

**PR 06.** This original rule is a candidate locator, not an interprocedural injection detector.

```json
{
  "schema": "sentinel-rule/draft-1",
  "familyId": "sentinel.sql.dynamic-query",
  "revision": "1",
  "titleKey": "sentinel.rule.dynamicQuery",
  "scopeKind": "source-file",
  "languages": ["typescript", "javascript"],
  "requires": ["source-bytes", "pattern-match"],
  "implementation": {
    "adapterId": "pattern-engine",
    "rulePath": "detectors/dynamic-query.yml"
  },
  "meaning": "candidate",
  "evidenceRequired": ["source-span", "matched-pattern"],
  "limitations": ["Does not establish attacker control or feasible execution."],
  "mappings": {"cwe": ["CWE-89"]},
  "fixtures": {
    "positive": ["fixtures/sql/concatenated.ts"],
    "negative": ["fixtures/sql/parameterized.ts"]
  },
  "license": {"spdx": "MIT", "origin": "sentinel-original"}
}
```

Production structured limitations and user-visible text use catalog keys. Hash all rule files, fixtures and
provenance into the approved pack revision. A Java variant uses a separate implementation with its own fixtures.
SQL parameterization syntax and recognized library versions are explicit, not assumed from method names.

A stronger check for attacker-controlled input reaching that sink declares `interprocedural-flow` and any
required framework capability. If the profile lacks them, retain an unsupported check. Do not substitute a
pattern hit or an agent's opinion under the stronger check's ID.

```ts
type Applicability =
  | { kind: 'not-applicable'; reasonCode: string }
  | { kind: 'unknown'; reasonCode: string }
  | { kind: 'applicable' };

type CheckPlan = {
  id: string;
  scopeId: string;
  environmentDigest: Digest;
  applicability: Applicability;
  requiredCapabilities: string[];
  requiredByPolicy: boolean;
  implementationId?: string;
} & (
  | { mode: 'deterministic' | 'guided-review'; ruleRevisionDigest: Digest }
  | { mode: 'general-review'; reviewPolicyDigest: Digest }
);
```

Unknown applicability cannot become not-applicable to improve a completion percentage. The planning fold
records the unknown reason and required work/coverage consequence. Repositories may request additional rules,
but the owner-required set is unioned in and cannot be weakened by repository config.

## 4. Separate adapter intent from worker execution

**PRs 07, 10–13, 18.** An adapter builds a declarative request. The supervisor enforces it.

```ts
interface WorkerInvocation {
  adapterId: string;
  adapterDigest: Digest;
  toolDigest: Digest;
  protocol: 'sentinel-worker/draft-1';
  executable: string;                 // Resolved from the trusted installation.
  argv: string[];                     // Never shell text.
  sourceArtifact: ArtifactId;
  ruleArtifacts: ArtifactId[];
  databaseArtifacts: ArtifactId[];
  limits: {
    deadlineMs: number;
    memoryBytes: number;
    cpuQuota: number;
    maxPids: number;
    maxOutputBytes: number;
  };
  effects: {
    build: false;
    network: 'none';
    dependencyResolution: 'none' | 'local-cache';
    databaseFetch: false;
    telemetry: 'off';
    runtimeTargets: false;
  };
}

interface ScannerAdapter {
  id: string;
  outputGranularity: CoverageEvidence['granularity'];
  prepare(input: {
    snapshot: ArtifactId;
    rules: ArtifactId[];
    databases: ArtifactId[];
  }): WorkerInvocation;
  // Runtime validation and reconciliation happen again in the coordinator.
  normalize(output: unknown): {
    observations: unknown[];
    scannedScopes: string[];
    skipped: Array<{ scopeId: string; reasonCode: string }>;
    diagnostics: Array<{ code: string; scopeId?: string }>;
  };
}
```

No scanner's command-line flags are guessed into this plan. PR 01/adapter conformance tests establish the exact
supported invocation and output fields of each pinned tool. For example, OSV documents that full `--offline`
and `--offline-vulnerabilities` have different network behavior; the latter alone cannot satisfy the declared
effect. [OSV offline mode](https://google.github.io/osv-scanner/usage/offline-mode/)

## 5. Enforce publication uniqueness in the ledger

**PRs 03, 08.** This relational skeleton demonstrates ownership constraints. It is intentionally smaller than
the full migration: artifact links, checks, observations, coverage and events add their own foreign keys.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES runs(id),
  coordinator_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('planned','running','pausing','paused','canceling','canceled','completed'))
) STRICT;

CREATE TABLE work_units (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  input_fingerprint TEXT NOT NULL,
  active_attempt_id TEXT,
  PRIMARY KEY (id, revision),
  FOREIGN KEY (active_attempt_id, id, revision)
    REFERENCES attempts(id, work_id, work_revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  coordinator_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('running','succeeded','failed','interrupted','canceled','canceled-after-spend')),
  usage_certainty TEXT NOT NULL CHECK (usage_certainty IN ('confirmed','unknown','not-applicable')),
  UNIQUE (work_id, work_revision, ordinal),
  UNIQUE (id, work_id, work_revision),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision)
) STRICT;

CREATE TABLE publications (
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  result_digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (work_id, work_revision),
  FOREIGN KEY (work_id, work_revision) REFERENCES work_units(id, revision),
  FOREIGN KEY (attempt_id, work_id, work_revision)
    REFERENCES attempts(id, work_id, work_revision)
) STRICT;

CREATE INDEX work_by_run_revision ON work_units(run_id, id, revision);
```

The work ID identifies a logical unit across its child-run lineage. The coordinator allocates a fresh revision
atomically for reassessment; an unrelated unit receives a new ID. The composite primary key permits revisions
1 and 2 in different runs while their attempts/publications remain distinct. Insert work with a null active
attempt, insert the attempt, then set that reference in the same transaction. The deferred foreign key checks
it belongs to that exact work revision at commit. No second coordinator can allocate a competing revision.

Never update a work row's identity/revision in place to represent a new run. Reuse is a separate derivation
referencing a prior publication, not a second execution. The run index only locates revisions; scheduler
readiness requires state/dependency checks in the full schema, so the index is not called `ready_work`.

The regression must create a parent and child run, insert the **same work ID** at revisions 1 and 2, accept
one publication for each, then reject a second revision-1 publication from another revision-1 attempt.
Separately reject a publication and an active-attempt reference using the other revision's attempt. Check
foreign keys and integrity after each rollback. This would have caught the original `id PRIMARY KEY` defect;
testing duplicate publication alone did not exercise the child-run contract.

**Orchestration sketch:** the helper names below specify responsibilities that implementation must supply.

```ts
async function acceptCandidate(candidate: WorkerResult, deps: PublicationDependencies) {
  // Check message limits, schemas, hashes, scope, citations and inventory join.
  const checked = await deps.validator.validate(candidate);

  // Pins staging roots against GC until commit/abort; fsync + rename precedes DB links.
  const staged = await deps.objects.publishDurably(checked.artifacts);
  try {
    // Synchronous callback: never await a worker or network request inside this transaction.
    return deps.ledger.immediateTransaction(tx => {
      const current = tx.readWorkAndAttempt(
        checked.workId, checked.workRevision, checked.attemptId,
      );
      tx.requireCurrentOwner(current, checked.coordinatorEpoch);
      tx.requireActiveAttempt(current, checked.attemptId, checked.workRevision);
      tx.requireInputFingerprint(current, checked.inputFingerprint);
      tx.requireRunState(current.runId, ['running', 'pausing']);
      if (checked.claim) tx.requireUnexpiredClaim(checked.claim, deps.clock.now());

      // The unique key rejects a second accepted publication, including a late attempt.
      tx.insertPublication(checked);
      tx.linkArtifacts(staged);
      tx.appendObservations(checked.observations);
      tx.appendCoverage(checked.coverage);
      tx.finishAttempt(checked.attemptId, 'succeeded');
      tx.appendEvent(current.runId, 'work-published', {
        workId: checked.workId, workRevision: checked.workRevision,
      });
      return tx.publicationReceipt(checked.workId, checked.workRevision);
    });
  } finally {
    // Committed links now pin objects; unreferenced blobs wait for GC's grace period.
    await staged.releaseStagingPins();
  }
}
```

The coordinator computes `result_digest`; it does not trust the worker's value. A retry of an already
accepted identical client message can return its existing receipt through idempotency handling. A different
payload under the same idempotency key is a conflict. Cancellation rejects findings publication but still
permits separate authenticated cleanup/usage records, so confirmed spend is not lost.

## 6. Make work identity explicit

**PR 06 onward.** Store the complete fingerprint inputs as an inspectable artifact alongside their hash.

```ts
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';

function contentKey(value: unknown): Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

interface WorkIdentity {
  contract: string;
  implementationDigest: Digest;
  inputArtifacts: ArtifactId[];       // Deterministic ordered roles, not arbitrary map order.
  influenceManifest: ArtifactId;
  ruleDigest?: Digest;
  toolDigest?: Digest;
  frameworkModelDigest?: Digest;
  resolvedFrameworksDigest?: Digest;
  environmentDigest: Digest;
  effectivePolicyDigest: Digest;
  limitsDigest: Digest;
  advisoryDatabaseDigest?: Digest;
  promptDigest?: Digest;
  providerIdentityDigest?: Digest;
  toolPolicyDigest?: Digest;
}

function workKey(identity: WorkIdentity): Digest {
  return contentKey(identity);
}
```

The schema rejects undefined/unrepresentable values before hashing, and the canonicalization version is
pinned. Source content, missing resolution candidates and directory membership can all influence a negative
result. An agent's read set is audit evidence, not a sufficient influence set. Unknown model revisions do not
gain reproducibility from a stable alias string; fresh review is the default for requested model reruns.

## 7. Framework facts express a property and uncertainty

**PRs 14–18.** A broad secured/unsecured boolean hides too much. Use an explicit property-level result.

```ts
type ControlProperty =
  | 'authentication-required'
  | 'authorization-enforced'
  | 'input-validation'
  | 'cookie-integrity'
  | 'cookie-confidentiality';

type ControlEvaluation = {
  surfaceId: string;
  environmentDigest: Digest;
  property: ControlProperty;
  verdict: 'protected' | 'unprotected' | 'unknown';
  frameworkPackDigest: Digest;
  frameworkVersionEvidence: ArtifactId;
  orderedControlIds: string[];
  evidence: SourceEvidence[];
  unresolved: Array<{ code: string; scopeId: string }>;
  influenceManifest: ArtifactId;
};
```

A Spring chain can establish authentication for a supported route without proving object-level authorization.
A successful cookie decryption does not establish safe outbound issuance, tamper resistance, TLS or cookie
flags. Custom control semantics remain unknown until their evidence is validated; an agent explanation alone
cannot rewrite the coded framework fact.

## 8. Provider API and bounded review loop

**PRs 21–22.** Keep credentials, policy, budget ownership and the evidence broker outside model control.

```ts
interface ProviderReply {
  body: unknown;
  identity: {
    requestedModel: string;
    returnedModel: string | null;
    immutableRevision: string | null;
    source: 'provider-response' | 'local-weight-digest' | 'unknown';
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    monetaryCost: string | null; // Decimal amount; currency/rate revision is in the invocation.
    certainty: 'confirmed' | 'estimated' | 'unknown';
  };
  finishReason: 'complete' | 'length' | 'cancelled' | 'unknown';
}

interface ReviewProvider {
  readonly id: string;
  readonly adapterDigest: Digest;
  generate(input: {
    approvedContextArtifact: ArtifactId;
    responseSchemaArtifact: ArtifactId;
    maxOutputTokens: number;
    operationId: string;
    signal: AbortSignal;
  }): Promise<ProviderReply>;
}
```

The provider implementation obtains the approved artifact through a trusted reader and converts it to its
transport format. It cannot accept arbitrary filesystem paths or caller-supplied credential values. A provider
that lacks strict structured output can still be evaluated, but its output always passes the same validator.

```ts
async function reviewScope(job: ReviewJob, deps: ReviewDependencies) {
  const session = await deps.evidence.openScoped(job.scope, job.inputDigest);
  while (session.canContinue()) {
    // Includes prior messages and tool results: charge the complete serialized request.
    const packet = await session.nextApprovedPacket();
    await deps.policy.assertDisclosure(job.providerRef, packet);
    const reservation = await deps.budgets.reserve({
      runId: job.runId,
      operationId: packet.operationId,
      inputTokensUpperBound: packet.inputTokensUpperBound,
      maxOutputTokens: job.maxOutputTokens,
      priceRevision: job.priceRevision,
    });
    try {
      const reply = await deps.provider.generate({
        approvedContextArtifact: packet.artifact,
        responseSchemaArtifact: job.responseSchema,
        maxOutputTokens: job.maxOutputTokens,
        operationId: packet.operationId,
        signal: job.signal,
      });
      await reservation.reconcile(reply.usage);
      const action = await deps.validator.validateReply(reply, session);
      // Only typed evidence tools or a final assessment are permitted.
      await session.applyValidatedAction(action);
      await deps.checkpoints.saveSettledOperation(job, packet, reply, action);
    } catch (error) {
      // Network failure/cancellation can happen after provider-side computation.
      await reservation.retainUnknownUsageUnlessSettled();
      throw deps.errors.toSafeReviewError(error);
    }
  }
  return session.finalizeWithCoverageAndFrontiers();
}
```

Budget reservation is atomic across jobs; cancellation fences result publication before a late response.
The evidence broker enforces scope even if a prompt instructs otherwise. Validate negative-result coverage
against the planned packet/inspection ledger; a valid citation on one positive claim says nothing about
uninspected files. Store the settled operation before starting another call; uncertain interrupted calls need
an explicit retry policy and retained budget, not an assumed free replay.

## 9. Comparability comes before resolution

**PR 19.** The comparison service returns a reason for every unpaired historical finding.

```ts
type DetectionConditions = {
  ruleRevision: Digest;
  engine: Digest;
  capabilities: Digest;
  environment: Digest;
  relevantLimits: Digest;
};

function sameDetection(a: DetectionConditions, b: DetectionConditions): boolean {
  return a.ruleRevision === b.ruleRevision
    && a.engine === b.engine
    && a.capabilities === b.capabilities
    && a.environment === b.environment
    && a.relevantLimits === b.relevantLimits;
}
```

Resolution also requires a complete current check covering the former affected scope, validated issue matching,
and no remaining observation for that issue. Equal detection conditions alone are insufficient. A reviewed
compatibility mapping can establish equivalence across versions; persist its rationale and scope. If the rule
narrows or an engine disappears, return changed detection/unassessed scope and preserve the historical issue.

## 10. Differential selection must include negative space

**PRs 27–28.** This is algorithmic pseudocode, not an implementation of graph equivalence.

```ts
function selectRerun(change: ChangeSet, baseline: Baseline, current: SnapshotPlan) {
  if (!baseline.integrityValid || !compatibleSchemas(baseline, current)) {
    return fullRelevantScope('baseline-unavailable-or-incompatible');
  }

  const seeds = new Set(change.changedFiles);
  addAll(seeds, change.addedFiles);
  addAll(seeds, change.removedFiles);
  const affected = reverseClosureOverOldAndNewDependencies(seeds, baseline, current);

  for (const framework of change.frameworkVersions) invalidateFrameworkScopes(affected, framework);
  for (const rule of change.ruleRevisions) replanRuleApplicability(affected, rule);
  for (const declaration of change.resolutionCandidates) {
    invalidateCandidateScopeOrBroaden(affected, declaration);
  }
  invalidateNewAndRemovedSurfaces(affected, baseline, current);
  invalidateAdvisoryAndDecisionInputs(affected, change);
  broadenAtUnknownFrontiers(affected, baseline, current);

  return explainEveryRunOrReuseDecision(affected, baseline, current);
}
```

A forced work rerun bypasses its reuse decision and reevaluates dependent work after new output hashes are
known. Identical new outputs can justify later deterministic reuse only after that reevaluation. Fresh agent
review remains fresh unless explicitly reused with original attribution.

## 11. Test cases should assert product behavior

**PRs 03, 08, 19, 20, 23a/23b, 28.** Implement these as fixture-driven integration tests with fake clocks/providers
and real isolated storage/process boundaries where the behavior depends on them.

```ts
const acceptanceCases = [
  {
    name: 'a child work revision has its own publication',
    arrange: 'one logical work ID in parent revision 1 and child revision 2',
    act: 'publish each revision; retry revision 1; attempt a cross-revision reference',
    expect: 'two valid publications; duplicate and mismatched attempt rejected',
  },
  {
    name: 'a route finding belongs to the journey that reaches it',
    arrange: 'pinned source-bound context with one screen, journey and persona',
    act: 'fold the finding and open its existing Map gate card',
    expect: 'same scoped finding, business sentence and evidence; no added graph fields',
  },
  {
    name: 'a mismatched current graph cannot relocate saved evidence',
    arrange: 'saved finding; current source/config no longer matches context receipt',
    act: 'request placement and open evidence',
    expect: 'explicit context limitation; captured bytes remain readable; no guessed screen',
  },
  {
    name: 'an agent cannot confirm its own disposition or paid work',
    arrange: 'policy match requires human confirmation; capability and credentials permit',
    act: 'submit a caller-controlled human name and confirmation boolean',
    expect: 'no approval or paid admission; awaiting-confirmation outcome, CLI exit 4',
  },
  {
    name: 'a late worker cannot publish after cancellation',
    arrange: 'running attempt; controlled worker waits before result',
    act: 'cancel run; release worker result',
    expect: 'no accepted publication; cancellation and usage facts retained',
  },
  {
    name: 'a rule narrowing is not a repaired vulnerability',
    arrange: 'baseline finding; next rule excludes the same unchanged endpoint',
    act: 'run and compare',
    expect: 'changed detection; historical issue remains reviewable',
  },
  {
    name: 'a new route can invalidate a prior mitigation',
    arrange: 'one evidenced protected path; add a bypass entry to the same sink',
    act: 'evaluate next snapshot and existing disposition',
    expect: 'old path retains its evidence; new path remains open',
  },
  {
    name: 'a scanner exit code does not establish omitted-file coverage',
    arrange: 'exit zero; result lists one scanned file and one timeout',
    act: 'normalize and evaluate required coverage',
    expect: 'finding results retained; partial coverage; policy exit 2',
  },
  {
    name: 'a model change does not require current source',
    arrange: 'saved source bundle; original checkout removed',
    act: 'restore and request a new model assessment',
    expect: 'new child run; same source hashes; new attributed model attempt',
  },
];
```

For E4, inject crashes before artifact durability, after durability but before transaction, inside the
transaction and after commit before acknowledgement. Repeat each 20 times with real process termination;
verify foreign keys, SQLite integrity, accepted-result uniqueness and object availability. Add external-claim
expiry/takeover in PR 23b. Do not replace these with mocks of the publication function. The full matrix is
opt-in under `SENTINEL_RECOVERY_FULL=1`; selected CI uses `SENTINEL_RECOVERY_SMOKE=1` for one kill per boundary.
Real-container cases require `SENTINEL_ISOLATION=1`. Ordinary recursive tests skip these modes with an explicit
reason; an explicitly selected CI job fails a missing prerequisite. Fast state/contract tests always run.

Keep fixtures under `packages/sentinel/test/fixtures/`. Synthetic secrets get exact inert-line allowlists in
the repository gitleaks configuration, never a directory exemption. Store locks/manifests under non-manifest
fixture names; materialize real names only in temporary trees, with no package-manager execution.

## 12. Proposed operator walkthrough

**PRs 09, 19, 26; optional model command from 22.** These commands express intended behavior and are not runnable today.

```sh
# Capture permitted local inputs and prepare a pinned plan. No scanner/model starts.
farsight-sentinel plan --profile static --out plan.json

# Review the saved plan's capabilities, gaps, effects and budget.
farsight-sentinel plan show --file plan.json

# Submit once; if confirmation is required, it returns a pending action (exit 4).
farsight-sentinel run --plan plan.json --detach
# An owner confirms the exact pending digest/effects in an authenticated local flow.
# The service then admits that approved action once; a caller boolean is not authority.
farsight-sentinel status --run run-id --wait --json
farsight-sentinel pause --run run-id
farsight-sentinel resume --run run-id

# Reassess the saved code under changed rules.
farsight-sentinel rerun --from run-id --rules approved-rules.lock.json
# Optional model capability after PR 22, with its own disclosure/budget approval.
farsight-sentinel rerun --from run-id --model review-provider --stage agent-review --force

# These use retained evidence; report generation does not rescan.
farsight-sentinel compare --from run-id --to child-run-id
farsight-sentinel report --run child-run-id --format sarif --out sentinel.sarif
farsight-sentinel bundle --run child-run-id --profile private-replay --out scan-bundle.tar.gz
farsight-sentinel restore --bundle scan-bundle.tar.gz --into restored-scan
```

`run` rechecks trusted policy and plan integrity; editing `plan.json` cannot grant permission. An unavailable
approved tool produces a prerequisite/coverage error, not an automatic installation. Restore adopts data,
not source grants, credentials, executable trust or permission to run. A bridge alias can expose the same
operations as `farsight sentinel ...` once PR 24 lands.

The deterministic walkthrough reaches CLI/MCP/GUI through 23a/24/25/26 without a provider. Model review,
external claims (23b) and model GUI details (25b) have separate gates. A finished scan uses exits 0/1/2/3 for
policy success/findings/required-coverage failure/execution error; exit 4 is a pending approval, never a scan
verdict. JSON retains all findings and coverage facts regardless of the selected exit code.
