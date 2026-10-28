// The viewer's read model of retained scans (Sentinel v2 §4, lane L-UX U-1): one pure fold from the records the held
// owner service gathers (`owner-ui/scans.ts`) into the answers the SCANS · PIPELINE · STAGE stops draw. It reads plain
// records only: no store, no network, no clock. Every count is a core `Counted` with a `sentinel.viewer.scope.*` (or an
// existing Sentinel) scope in core's COUNT_SCOPES; a duration, a price and a CPU share are measures that carry their
// scope too (docs/COUNTS.md § Sentinel read model). A stage is the work unit's stage contract until the declared
// pipeline lands (P-3), then the stage id.
//
// A scan is addressed by its run id; its number is a display ordinal only, exact and stable (the order the store
// created its runs). What never leaves this fold's own fields: a plan, unit or attempt id, an artifact handle or a
// store path. An opened check or review also carries retained text verbatim (an output, an exchange), bounded and to
// the paired owner only; that text is the record as kept and may name the record's own ids.
// Digests that identify what ran (an implementation, an image, a prompt) are provenance and are carried; the viewer
// prints them and the run id outside the business register only. When the scan's accepted evidence holds a secret
// match, every file name, prompt text, model message, retained output and request detail is withheld here, as the
// report withholds them (`withheld: true`). A retained output that is the source itself is never streamed here.
// Core's `Counted` shape, through the contract that already declares it, so an installed package resolves its types.
import type { ReportCount as Counted, ReportCountPart as CountPart } from '../../contracts/report.js';
// The four kinds a declared pipeline names (README §3.1), the same words its provenance records carry. The viewer's
// projection is not the retained StageProvenance record itself: that names artifact handles and work refs, which
// never leave this fold.
import type { PipelineStageKind } from '../../contracts/pipeline.js';

export const READ_MODEL_SCHEMAS = Object.freeze({
  scans: 'sentinel-viewer-scans/draft-1',
  scan: 'sentinel-viewer-scan/draft-1',
  stage: 'sentinel-viewer-stage/draft-1',
  unit: 'sentinel-viewer-unit/draft-1',
} as const);

/** The bounds every answer keeps, whatever the store holds. */
export const READ_MODEL_LIMITS = Object.freeze({
  scans: 64,
  stages: 256,
  unitsPerStage: 256,
  attemptsPerUnit: 16,
  turnsPerUnit: 64,
  observationsPerUnit: 16,
  citationsPerObservation: 8,
  inspectedPerUnit: 32,
  outputsPerUnit: 16,
  /** A prompt's text. */
  textBytes: 64 * 1024,
  /** One retained output's text, in characters. */
  outputChars: 32 * 1024,
  /** One message of one exchange with the model, in characters. */
  turnChars: 2000,
  messageChars: 2000,
  pathChars: 512,
  argvItems: 32,
  argChars: 512,
  environmentNames: 32,
});

// ---- the records the service gathers (input) ----

export type WorkerPlace = 'in-process' | 'child' | 'container' | 'external';
export type UsageCertainty = 'confirmed' | 'unknown' | 'not-applicable';
export type OutputPrivacy = 'metadata' | 'source-derived' | 'source';

export interface AttemptRecord {
  readonly ordinal: number;
  readonly state: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly worker: WorkerPlace;
  readonly usage: {
    readonly certainty: UsageCertainty;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly monetaryCost?: string;
    readonly currency?: string;
  };
  readonly accepted: boolean;
  /** A catalog code, only when it is one. */
  readonly error: string | null;
}

/**
 * The safe fields of one try's retained invocation record, read only after the record was authenticated against its
 * attempt, work, owner epoch and pinned adapter: a worker's (`sentinel-invocation/draft-1`: isolation, image, argv,
 * environment names, limits) or Sentinel's own in-process operation's (`sentinel-operation-invocation/draft-1`: the
 * operation it ran). The argv is as recorded; the fold scrubs host paths and tokens from it before it leaves.
 */
export interface InvocationRecordView {
  /** The try's ordinal. */
  readonly attempt: number;
  readonly adapter: { readonly id: string; readonly version: string; readonly digest: string };
  readonly isolation: 'container' | 'child' | 'in-process';
  /** The coordinator operation an in-process try ran (`capture`, `parse`, `inventory`, a review); null for a worker. */
  readonly operation: string | null;
  readonly image: { readonly reference: string; readonly id: string; readonly architecture: string } | null;
  readonly argv: readonly string[];
  readonly environmentNames: readonly string[];
  readonly limits: {
    readonly memoryBytes: number;
    readonly cpus: number;
    readonly pids: number;
    readonly timeoutMs: number;
  } | null;
}
/** An authenticated invocation, or the catalog code that says why there is none to show. */
export type InvocationRead = InvocationRecordView | { readonly absent: string };

/** One retained output of an accepted publication: its schema, privacy class and size, never its handle. */
export interface OutputRecord {
  readonly schema: string;
  readonly privacy: OutputPrivacy;
  /** The decoded size the store recorded, or null when it records none. */
  readonly bytes: number | null;
}
/** The same output with its text, read for the one unit a STAGE detail opens; `reason` says why there is no text. */
export interface RawOutputRecord extends OutputRecord {
  readonly text: string | null;
  readonly reason: string | null;
}

/** What a review unit was asked to review: one rule over its scope (guided), or a set of files (general). */
export type ReviewedRecord =
  | {
      readonly kind: 'rule';
      readonly familyId: string;
      readonly revision: number;
      /** The scope id the rule's check covers (`<source>:<relative path>`, or a whole source). */
      readonly scope: string;
    }
  | { readonly kind: 'files' };

export interface UnitRecord {
  /** Internal identity, used to join dependencies inside the fold; never copied into an answer. */
  readonly key: string;
  readonly planRevision: number;
  readonly stage: string;
  readonly contract: string;
  readonly adapterId: string | null;
  readonly implementationDigest: string;
  readonly dependencies: readonly string[];
  readonly checks: number;
  /** Scope ids as the plan names them (`<source>:<relative path>`, or a whole source). */
  readonly scopes: readonly string[];
  readonly inputs: number;
  /** The first captured files the unit was given, by relative path (a whole-source scope names none of its own). */
  readonly inputPaths: readonly string[];
  readonly review: { readonly providerId: string; readonly modelId: string } | null;
  readonly reviewed: ReviewedRecord | null;
  readonly work: {
    readonly state: string;
    readonly reason: string | null;
    readonly kind: string;
    readonly deadlineMs: number;
    /** The scan whose publication this unit reused, when it was satisfied by reuse. */
    readonly reusedFrom: { readonly id: string; readonly number: number | null } | null;
  } | null;
  readonly attempts: readonly AttemptRecord[];
  /** The authenticated invocation of the accepted (else the latest) try; undefined when this read did not look. */
  readonly invocation?: InvocationRead | null;
  /** The accepted publication's outputs, in order; null before one is accepted. */
  readonly outputs: readonly OutputRecord[] | null;
}

export interface AdapterRecord {
  /** The registry's version, only when it holds the exact adapter the plan pinned (a fallback for Sentinel's own code). */
  readonly version: string | null;
  readonly kind: 'external' | 'built-in' | 'operation' | null;
  /** Whether this installation's registry still holds the exact adapter the plan pinned. */
  readonly registry: 'current' | 'changed' | 'absent';
}

export interface TurnRecord {
  readonly outcome: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly inputBytes: number | null;
  /** The request Sentinel sent, its last user message, as retained. */
  readonly sent: string | null;
  /** The model's reply that ended this turn, as it was sent back in the next request (or null). */
  readonly reply: string | null;
}

export interface ReviewRecord {
  readonly unitKey: string;
  readonly model: {
    readonly requested: string | null;
    readonly reported: string | null;
    readonly source: string;
  } | null;
  readonly prompt: {
    readonly name: string;
    readonly revision: number;
    readonly digest: string;
    readonly bytes: number;
    readonly text: string | null;
  };
  readonly skills: readonly {
    readonly name: string;
    readonly revision: number;
    readonly digest: string;
    readonly bytes: number;
  }[];
  readonly verdict: string | null;
  readonly outcome: string;
  readonly totals: {
    readonly steps: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly usage: string;
  };
  readonly turns: readonly TurnRecord[];
  readonly observations: readonly {
    readonly message: string;
    readonly severity: string;
    readonly citations: readonly { readonly path: string; readonly startByte: number; readonly endByte: number }[];
  }[];
  readonly inspected: readonly string[];
}

export interface ScanRecord {
  /** The run id, the scan's address. */
  readonly id: string;
  /** Its place in the order the store created its runs, oldest first: a display number, exact and stable. */
  readonly number: number;
  readonly parent: { readonly id: string; readonly number: number | null } | null;
  /** The recorded run state, or `awaiting` for an admitted rerun that has not run. */
  readonly state: string;
  readonly outcome: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly planRevision: number;
  readonly profileId: string;
  readonly deadlineMs: number;
  readonly sources: readonly { readonly commit: string | null; readonly dirty: boolean }[] | null;
  readonly units: readonly UnitRecord[];
  readonly adapters: Readonly<Record<string, AdapterRecord>>;
  /**
   * The full report fold's own counts, copied as the report prints them (never refolded here), and its findings by
   * the adapter whose rule found each (a partition of the same list); the reason when there is no report. The
   * report's *folders never listed* is not carried: the preview and full report folds count it differently today.
   */
  readonly report:
    | {
        readonly findings: Counted;
        readonly seenByNoStage: Counted;
        readonly findingsByAdapter: Readonly<Record<string, number>>;
      }
    | { readonly absent: string };
  /** The command result `run` and `status` print for a finished scan (canonicalResult); null before it finishes. */
  readonly result: {
    readonly outcome: string;
    readonly reasonCode: string;
    readonly requiredChecks: number | null;
    readonly requiredComplete: number | null;
  } | null;
  /** Review traces, when the scan's reviews are readable and nothing is withheld. */
  readonly review: {
    readonly status: 'available' | 'withheld' | 'unavailable' | 'unreadable';
    readonly units: readonly ReviewRecord[];
  };
  /** A secret match in the accepted evidence: every file name, output and model text is withheld. */
  readonly withheld: boolean;
}

// ---- the answers (output) ----

export type StageKindWord = PipelineStageKind;
export type StageStatus = 'done' | 'running' | 'waiting' | 'failed' | 'held' | 'reused' | 'not-run';

/** A length of time and what it is the length of. */
export interface Duration {
  readonly ms: number;
  readonly scope: string;
  readonly source: string;
}

/** A quantity that need not be whole (a CPU share), with the catalog words it prints in and its scope. */
export interface Measure {
  readonly value: number;
  readonly unit: string;
  readonly scope: string;
  readonly source: string;
}

/** What the model work cost, and on what basis; never `0` for a cost nobody reported. */
export interface Cost {
  readonly basis: 'none' | 'recorded' | 'unobserved' | 'mixed';
  readonly amount: string | null;
  readonly currency: string | null;
  readonly scope: string;
  readonly source: string;
}

/** One try's invocation as its authenticated record names it: argv scrubbed of host paths and tokens. */
export interface InvocationView {
  readonly attempt: number;
  readonly adapter: { readonly id: string; readonly version: string; readonly digest: string };
  readonly isolation: 'container' | 'child' | 'in-process';
  readonly operation: string | null;
  readonly image: { readonly reference: string; readonly id: string; readonly architecture: string } | null;
  readonly argv: readonly string[];
  readonly environmentNames: readonly string[];
  /** A worker's recorded limits; null for Sentinel's own in-process operation, which runs under the service's. */
  readonly limits: {
    readonly memory: Counted;
    readonly processes: Counted;
    readonly cpus: Measure;
    readonly timeout: Duration;
  } | null;
}

/** README §3.1/§3.2 provenance, coded against the plan until P-1's contract lands: what ran, which version, where. */
export interface Provenance {
  readonly kind: StageKindWord;
  readonly where: WorkerPlace | 'provider' | null;
  readonly implementation: {
    readonly adapter: string | null;
    /** The version the try's invocation record names; for Sentinel's own in-process code, this installation's. */
    readonly version: string | null;
    readonly versionFrom: 'invocation' | 'registry' | null;
    readonly digest: string;
    /** Whether this installation still holds the exact adapter the plan pinned. */
    readonly registry: 'current' | 'changed' | 'absent';
  };
  /** What the first check's try ran, from its retained invocation record; null with a reason when there is none. */
  readonly invocation: InvocationView | null;
  readonly invocationAbsent: string | null;
  readonly provider: { readonly id: string; readonly model: string } | null;
  readonly model: {
    readonly requested: string | null;
    readonly reported: string | null;
    readonly source: string;
  } | null;
  readonly prompt: {
    readonly name: string;
    readonly revision: number;
    readonly digest: string;
    readonly bytes: Counted;
  } | null;
  readonly skills:
    | readonly { readonly name: string; readonly revision: number; readonly digest: string; readonly bytes: Counted }[]
    | null;
  readonly deadline: Duration | null;
}

export interface IoChip {
  /** A `sentinel.viewer.io.*` catalog key. */
  readonly key: string;
  /** The stage that produced it, when it came from one. */
  readonly stage?: string;
  readonly count?: Counted;
}

export interface StageCard {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly kind: StageKindWord;
  readonly status: StageStatus;
  readonly level: number;
  readonly after: readonly string[];
  readonly startedAt: string | null;
  readonly duration: Duration | null;
  readonly provenance: Provenance;
  readonly counts: {
    /** The stage's units: *checks* for a tool or built-in stage, *reviews* for an agent stage. */
    readonly units: Counted;
    readonly attempts: Counted;
    readonly inputs: Counted;
    readonly findings: Counted | null;
    readonly modelObservations: Counted | null;
    readonly turns: Counted | null;
    readonly tokensIn: Counted | null;
    readonly tokensOut: Counted | null;
  };
  readonly cost: Cost;
  readonly reads: readonly IoChip[];
  readonly produces: readonly IoChip[];
  /** Why the stage is held, when it is: a catalog code. */
  readonly heldBy: string | null;
  /** Error codes the stage's tries ended with, each once. */
  readonly errors: readonly string[];
}

export interface ScanRow {
  /** The run id: the address of this scan's PIPELINE, STAGE and report reads. Never printed in the business register. */
  readonly id: string;
  /** A display number, exact and stable: the scan's place in the order the store made its runs. */
  readonly number: number;
  readonly parent: { readonly id: string; readonly number: number | null } | null;
  readonly state: string;
  readonly outcome: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly duration: Duration | null;
  readonly pipeline: {
    readonly revision: number | null;
    readonly absent: string | null;
    readonly profile: string;
    readonly planRevision: number;
  };
  readonly source: { readonly commit: string | null; readonly dirty: boolean; readonly sources: Counted } | null;
  readonly policy: { readonly word: string; readonly reasonCode: string | null };
  readonly counts: {
    readonly stages: Counted;
    readonly agentic: Counted;
    readonly findings: Counted | null;
    readonly modelObservations: Counted | null;
    readonly coverage: Counted | null;
    /** The report's *n of m captured files seen by no check*: `of` is every captured file. */
    readonly seenByNoStage: Counted | null;
    /**
     * The report's *folders never listed*: not shown as one fact while the preview and the full report count it
     * differently (`absent.unknownScopeBoundaries` says so).
     */
    readonly unknownScopeBoundaries: null;
  };
  /** Why a null count is null: catalog codes keyed by the count's name. */
  readonly absent: Readonly<Record<string, string>>;
  readonly cost: Cost;
  readonly withheld: boolean;
}

/** Whether this browser can start a scan, and why not: the owner panel's own refusals, said before a press. */
export interface ScanAction {
  readonly available: boolean;
  /** A catalog code when it is not available (no adopted settings; a model stage needs the owner command line). */
  readonly reasonCode: string | null;
}

export interface ScansAnswer {
  readonly schema: typeof READ_MODEL_SCHEMAS.scans;
  readonly workspace: string;
  readonly scanAction: ScanAction;
  readonly scans: readonly ScanRow[];
  readonly counts: {
    /** Every scan the store keeps. */
    readonly scans: Counted;
    /** The scans this page shows, of every scan kept. */
    readonly shown: Counted;
  };
  /**
   * The page: `before` is the cursor it was read with (null for the newest page); `older` the cursor of the next
   * older page (`/api/sentinel/scans/before/<older>`), null when this page reaches the first scan.
   */
  readonly page: { readonly before: number | null; readonly older: number | null };
  /** Older scans exist beyond this page. */
  readonly more: boolean;
  readonly readOnly: true;
}

export interface ScanAnswer {
  readonly schema: typeof READ_MODEL_SCHEMAS.scan;
  readonly workspace: string;
  readonly scan: ScanRow;
  readonly stages: readonly StageCard[];
  /** Stage ids by level, top to bottom; stages on one level ran side by side. */
  readonly levels: readonly (readonly string[])[];
  readonly review: string;
  readonly readOnly: true;
}

export interface AttemptRow {
  readonly ordinal: number;
  readonly state: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly duration: Duration | null;
  readonly where: WorkerPlace;
  readonly accepted: boolean;
  readonly error: string | null;
  readonly usage: UsageCertainty;
}

/** Retained text, bounded: `truncated` when the record held more than the read model carries. */
export interface TextPart {
  readonly text: string;
  readonly truncated: boolean;
}

export interface TurnRow {
  readonly number: number;
  readonly outcome: string;
  readonly sent: {
    readonly key: string;
    readonly tool?: string;
    readonly ok?: boolean;
    readonly path?: string;
    readonly lines?: readonly [number, number];
    readonly files?: Counted;
  } | null;
  readonly reply: {
    readonly key: string;
    readonly path?: string;
    readonly lines?: readonly [number, number];
    readonly verdict?: string;
    readonly claims?: Counted;
  } | null;
  readonly counts: {
    readonly tokensIn: Counted | null;
    readonly tokensOut: Counted | null;
    readonly inputBytes: Counted | null;
  };
  /**
   * The exchange's retained text, in a unit's detail only: what Sentinel sent and the model's reply, each bounded.
   * Undefined in a stage's list; null with `textAbsent` when it is withheld or was not retained.
   */
  readonly text?: { readonly sent: TextPart | null; readonly reply: TextPart | null } | null;
  readonly textAbsent?: string | null;
}

/** What a review was asked to review, said without a path when the scan is withheld. */
export type ReviewedView =
  | {
      readonly kind: 'rule';
      readonly rule: string;
      readonly revision: number;
      /** The file the rule's check covers; null for a whole source, or when withheld. */
      readonly path: string | null;
    }
  | { readonly kind: 'files'; readonly files: Counted };

export interface UnitRow {
  readonly number: number;
  /** The file it covered, or the first of its files; null when withheld or when it covers a whole source. */
  readonly label: string | null;
  /** What a review was asked to review; null for a check. */
  readonly reviewed: ReviewedView | null;
  readonly status: StageStatus;
  readonly startedAt: string | null;
  readonly duration: Duration | null;
  readonly attempts: readonly AttemptRow[];
  readonly counts: {
    readonly files: Counted;
    readonly attempts: Counted;
    readonly inputs: Counted;
    readonly tokensIn: Counted | null;
    readonly tokensOut: Counted | null;
    readonly turns: Counted | null;
    readonly modelObservations: Counted | null;
  };
  readonly cost: Cost;
  readonly review: {
    readonly model: {
      readonly requested: string | null;
      readonly reported: string | null;
      readonly source: string;
    } | null;
    readonly verdict: string | null;
    readonly outcome: string;
    readonly turns: readonly TurnRow[];
    readonly observations: readonly {
      readonly message: string;
      readonly severity: string;
      readonly citations: readonly { readonly path: string; readonly startByte: number; readonly endByte: number }[];
      readonly counts: { readonly citations: Counted };
    }[];
    readonly inspected: readonly string[];
  } | null;
}

export interface StageAnswer {
  readonly schema: typeof READ_MODEL_SCHEMAS.stage;
  readonly workspace: string;
  readonly scan: ScanRow;
  readonly stage: StageCard;
  readonly units: readonly UnitRow[];
  readonly more: boolean;
  /** The prompt the stage's model was given, when it is readable and nothing is withheld. */
  readonly prompt: {
    readonly name: string;
    readonly revision: number;
    readonly digest: string;
    readonly bytes: Counted;
    readonly text: string | null;
  } | null;
  readonly review: string;
  /**
   * The STAGE answer carries the owner's own retained text (the prompt, the model's observations, the paths it read)
   * to the paired owner's page only; a secret match withholds all of it. Never a shareable rendering.
   */
  readonly disclosure: 'owner-private';
  readonly readOnly: true;
}

/** One retained output of one check or review, with its bounded text when its class and the scan allow it. */
export interface OutputView {
  /** The `sentinel.viewer.io.*` word it is shown as. */
  readonly key: string;
  readonly schema: string;
  readonly privacy: OutputPrivacy;
  readonly size: Counted | null;
  readonly text: string | null;
  readonly truncated: boolean;
  /** Why there is no text: a catalog code (withheld, the source itself, not text, too large, unreadable). */
  readonly withheld: string | null;
}

/** One check or review of one stage, opened: its tries, what ran, its retained outputs and, for a model, every message. */
export interface UnitAnswer {
  readonly schema: typeof READ_MODEL_SCHEMAS.unit;
  readonly workspace: string;
  readonly scan: ScanRow;
  readonly stage: StageCard;
  readonly unit: UnitRow;
  readonly invocation: InvocationView | null;
  readonly invocationAbsent: string | null;
  readonly outputs: readonly OutputView[];
  readonly outputsMore: boolean;
  readonly review: string;
  readonly disclosure: 'owner-private';
  readonly readOnly: true;
}

// ---- the fold ----

const SOURCE = 'sentinel viewer read model draft-1';
const SCOPE = Object.freeze({
  scans: 'sentinel.viewer.scope.scans',
  scan: 'sentinel.viewer.scope.scan',
  stage: 'sentinel.viewer.scope.stage',
  check: 'sentinel.viewer.scope.check',
  review: 'sentinel.viewer.scope.review',
  turn: 'sentinel.viewer.scope.turn',
  output: 'sentinel.viewer.scope.output',
  attempt: 'sentinel.viewer.scope.attempt',
});

function count(
  n: number,
  unit: string,
  scope: string,
  source: string,
  extra: { bizUnit?: string; of?: number; breakdown?: CountPart[] } = {},
): Counted {
  return {
    n,
    ...(extra.of !== undefined ? { of: extra.of } : {}),
    unit,
    ...(extra.bizUnit ? { bizUnit: extra.bizUnit } : {}),
    scope,
    source: `${SOURCE} · ${source}`,
    ...(extra.breakdown && extra.breakdown.length ? { breakdown: extra.breakdown } : {}),
  };
}

const STATUS_PART: Readonly<Record<StageStatus, string>> = {
  done: 'sentinel.viewer.count.part.done',
  running: 'sentinel.viewer.count.part.running',
  waiting: 'sentinel.viewer.count.part.waiting',
  failed: 'sentinel.viewer.count.part.failed',
  held: 'sentinel.viewer.count.part.held',
  reused: 'sentinel.viewer.count.part.reused',
  'not-run': 'sentinel.viewer.count.part.notRun',
};
const STATUS_ORDER: readonly StageStatus[] = ['done', 'reused', 'running', 'waiting', 'held', 'failed', 'not-run'];

function statusBreakdown(statuses: readonly StageStatus[]): CountPart[] {
  return STATUS_ORDER.map((s) => ({ key: STATUS_PART[s], n: statuses.filter((x) => x === s).length })).filter(
    (p) => p.n > 0,
  );
}

const CHECK_NAMES: Readonly<Record<string, string>> = {
  'sentinel.preview.detector': 'sentinel.viewer.stage.preview',
  'secrets-gitleaks': 'sentinel.viewer.stage.secrets',
  'advisories-osv': 'sentinel.viewer.stage.dependencies',
  'pattern-semgrep': 'sentinel.viewer.stage.patterns',
  'iac-trivy': 'sentinel.viewer.stage.infrastructure',
  'ci-zizmor': 'sentinel.viewer.stage.workflows',
  'framework-controls': 'sentinel.viewer.stage.controls',
  'bounded-paths': 'sentinel.viewer.stage.paths',
};

/** The catalog key a stage is named by, from its work unit's stage and adapter. */
export function stageName(stage: string, adapterId: string | null): string {
  if (stage === 'capture') return 'sentinel.viewer.stage.capture';
  if (stage === 'parse') return 'sentinel.viewer.stage.parse';
  if (stage === 'inventory') return 'sentinel.viewer.stage.inventory';
  if (stage === 'review-general') return 'sentinel.viewer.stage.reviewGeneral';
  if (stage === 'review-guided') return 'sentinel.viewer.stage.reviewGuided';
  if (stage === 'check') return (adapterId && CHECK_NAMES[adapterId]) || 'sentinel.viewer.stage.otherCheck';
  return 'sentinel.viewer.stage.other';
}

/** README §3.1's four kinds over the work contract's `StageKind`, as contracts/pipeline.ts maps them. */
export function kindOf(unit: UnitRecord, adapter: AdapterRecord | undefined): StageKindWord {
  const k = unit.work?.kind;
  if (k === 'agentic' || unit.review) return 'agent';
  if (k === 'external-tool' || adapter?.kind === 'external') return 'tool';
  if (k === 'script') return 'script';
  return 'builtin';
}

const SCHEMA_IO: Readonly<Record<string, string>> = {
  'sentinel-bootstrap-capture/draft-1': 'sentinel.viewer.io.snapshot',
  'sentinel-parser-result/draft-1': 'sentinel.viewer.io.parsed',
  'sentinel-bootstrap-inventory/draft-1': 'sentinel.viewer.io.inventory',
  'sentinel-worker/draft-1#result': 'sentinel.viewer.io.toolResult',
  'application/json': 'sentinel.viewer.io.toolResult',
  'sentinel-coverage/draft-1': 'sentinel.viewer.io.coverage',
  'sentinel-coverage-scope/draft-1': 'sentinel.viewer.io.coverage',
  'sentinel-coverage-limitations/draft-1': 'sentinel.viewer.io.coverage',
  'sentinel-driver-finding/draft-1': 'sentinel.viewer.io.findings',
  'sentinel-driver-report/draft-1': 'sentinel.viewer.io.toolResult',
  'sentinel-preview-findings/draft-1': 'sentinel.viewer.io.findings',
  'sentinel-observation/draft-1': 'sentinel.viewer.io.observations',
  'sentinel-review-record/draft-1': 'sentinel.viewer.io.reviewRecord',
  'sentinel-review-request/draft-1': 'sentinel.viewer.io.requests',
  'sentinel-review-instructions/draft-1': 'sentinel.viewer.io.instructions',
  'text/plain': 'sentinel.viewer.io.prompt',
  'sentinel-controls/draft-1': 'sentinel.viewer.io.controls',
  'sentinel-inspection/draft-1': 'sentinel.viewer.io.inspection',
};
/** The io word an output schema is shown as. */
export const ioOf = (schema: string): string => SCHEMA_IO[schema] ?? 'sentinel.viewer.io.other';

const FINAL = new Set(['completed', 'canceled']);

function unitStatus(unit: UnitRecord, scanFinal: boolean): StageStatus {
  const s = unit.work?.state;
  if (s === 'published') return 'done';
  if (s === 'satisfied-by-reuse') return 'reused';
  if (s === 'running' || s === 'leased') return 'running';
  if (s === 'failed') return 'failed';
  if (s === 'blocked' || s === 'disabled-by-policy') return 'held';
  return scanFinal ? 'not-run' : 'waiting';
}

function stageStatus(statuses: readonly StageStatus[]): StageStatus {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.length && statuses.every((s) => s === 'reused')) return 'reused';
  if (statuses.length && statuses.every((s) => s === 'done' || s === 'reused')) return 'done';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('held')) return 'held';
  return statuses.includes('not-run') ? 'not-run' : 'waiting';
}

const ms = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
};
const duration = (v: number | null, scope: string, source: string): Duration | null =>
  v === null ? null : { ms: v, scope, source: `${SOURCE} · ${source}` };

/** Decimal strings added exactly (12 fractional digits); null for anything that is not a plain decimal. */
function addDecimal(values: readonly string[]): string | null {
  const SCALE = 12;
  let total = 0n;
  for (const v of values) {
    const m = /^(\d{1,20})(?:\.(\d{1,12}))?$/.exec(v);
    if (!m) return null;
    total += BigInt(m[1]!) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? '').padEnd(SCALE, '0') || '0');
  }
  const whole = total / 10n ** BigInt(SCALE),
    frac = (total % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The cost of a set of tries: none when no model ran, unobserved when any model try was not priced. */
export function costOf(attempts: readonly AttemptRecord[], scope: string, source: string): Cost {
  const model = attempts.filter((a) => a.usage.certainty !== 'not-applicable');
  const base = { scope, source: `${SOURCE} · ${source}` };
  if (!model.length) return { basis: 'none', amount: null, currency: null, ...base };
  if (model.some((a) => a.usage.monetaryCost === undefined || a.usage.certainty !== 'confirmed'))
    return { basis: 'unobserved', amount: null, currency: null, ...base };
  const currencies = new Set(model.map((a) => a.usage.currency ?? ''));
  if (currencies.size !== 1 || currencies.has('')) return { basis: 'mixed', amount: null, currency: null, ...base };
  const amount = addDecimal(model.map((a) => a.usage.monetaryCost!));
  if (amount === null) return { basis: 'unobserved', amount: null, currency: null, ...base };
  return { basis: 'recorded', amount, currency: [...currencies][0]!, ...base };
}

/** Tokens over a set of tries; null when no try reported that side. */
function tokens(attempts: readonly AttemptRecord[], side: 'inputTokens' | 'outputTokens'): number | null {
  const reported = attempts.filter((a) => typeof a.usage[side] === 'number');
  return reported.length ? reported.reduce((n, a) => n + (a.usage[side] as number), 0) : null;
}

const bounded = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** A scope id's file path, or null for a whole source. */
function scopePath(scope: string): string | null {
  const i = scope.indexOf(':');
  return i > 0 && i < scope.length - 1 ? bounded(scope.slice(i + 1), READ_MODEL_LIMITS.pathChars) : null;
}

interface Stage {
  readonly id: string;
  readonly units: UnitRecord[];
  readonly first: number;
}

function groupStages(units: readonly UnitRecord[]): Stage[] {
  const byId = new Map<string, Stage>();
  units.forEach((u, i) => {
    const s = byId.get(u.contract);
    if (s) s.units.push(u);
    else byId.set(u.contract, { id: u.contract, units: [u], first: i });
  });
  return [...byId.values()];
}

/** Stages by level (a stage sits one level under the deepest stage it reads), each level in plan order. */
function levelsOf(stages: readonly Stage[]): { levels: string[][]; after: Map<string, string[]> } {
  const owner = new Map<string, string>();
  for (const s of stages) for (const u of s.units) owner.set(u.key, s.id);
  const after = new Map<string, string[]>();
  for (const s of stages) {
    const deps = new Set<string>();
    for (const u of s.units)
      for (const d of u.dependencies) {
        const o = owner.get(d);
        if (o && o !== s.id) deps.add(o);
      }
    after.set(s.id, [...deps]);
  }
  const level = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // a cycle cannot be planned; never loop on a malformed record
    seen.add(id);
    const deps = after.get(id) ?? [];
    const l = deps.length ? Math.max(...deps.map((d) => visit(d, seen))) + 1 : 0;
    level.set(id, l);
    return l;
  };
  for (const s of stages) visit(s.id, new Set());
  const levels: string[][] = [];
  for (const s of [...stages].sort((a, b) => a.first - b.first)) {
    const l = level.get(s.id)!;
    (levels[l] ??= []).push(s.id);
  }
  return { levels: levels.filter((l) => l && l.length), after };
}

function policyOf(scan: ScanRecord): { word: string; reasonCode: string | null } {
  if (scan.state !== 'completed') {
    if (scan.state === 'canceled') return { word: 'sentinel.viewer.policy.stopped', reasonCode: null };
    return { word: 'sentinel.viewer.policy.inProgress', reasonCode: null };
  }
  const code = scan.result?.reasonCode ?? null;
  const word =
    code === 'sentinel.service.previewNotCoverage'
      ? 'sentinel.viewer.policy.preview'
      : code === 'sentinel.service.policyNotEvaluated'
        ? 'sentinel.viewer.policy.notEvaluated'
        : code === 'sentinel.service.executionFailed' || scan.outcome === 'execution-failure'
          ? 'sentinel.viewer.policy.failed'
          : 'sentinel.viewer.policy.incomplete';
  return { word, reasonCode: code };
}

function reviewsOf(scan: ScanRecord): Map<string, ReviewRecord> {
  return new Map(
    scan.withheld || scan.review.status !== 'available' ? [] : scan.review.units.map((r) => [r.unitKey, r]),
  );
}

const TOKEN_ARG =
  /^(--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|credential|apikey|api-key|auth)[A-Za-z0-9_-]*=).+$/i;
const HOST_PATH =
  /(?:^|[\s=:,])(?:file:\/\/)?(?:[A-Za-z]:)?[\\/](?:Users|home|private|var[\\/]folders|tmp|root|Volumes)[\\/]/;
/**
 * An invocation's argv with nothing of the host in it: a token argument keeps its name only; for a child process
 * (whose argv names this computer's Node, gate, module and scratch folders) every absolute path or file URL is
 * `<host path>`; in a container, paths are the container's own, but one naming a host folder is scrubbed too.
 */
export function scrubArgv(argv: readonly unknown[], isolation: 'container' | 'child' | 'in-process'): string[] {
  return argv.slice(0, READ_MODEL_LIMITS.argvItems).map((a) => {
    if (typeof a !== 'string') return '<other>';
    const token = TOKEN_ARG.exec(a);
    if (token) return `${token[1]}<redacted>`;
    if (HOST_PATH.test(a)) return '<host path>';
    if (isolation !== 'container' && (/^file:/i.test(a) || /^(?:[A-Za-z]:)?[\\/]/.test(a))) return '<host path>';
    return bounded(a, READ_MODEL_LIMITS.argChars);
  });
}

function invocationView(v: InvocationRecordView, scope: string): InvocationView {
  return {
    attempt: v.attempt,
    adapter: { id: v.adapter.id, version: bounded(v.adapter.version, 64), digest: v.adapter.digest },
    isolation: v.isolation,
    operation: v.operation === null ? null : bounded(v.operation, 64),
    image: v.image,
    argv: scrubArgv(v.argv, v.isolation),
    environmentNames: v.environmentNames
      .slice(0, READ_MODEL_LIMITS.environmentNames)
      .filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n)),
    limits: v.limits
      ? {
          memory: count(v.limits.memoryBytes, 'sentinel.viewer.count.bytes', scope, 'invocation record, limits'),
          processes: count(v.limits.pids, 'sentinel.viewer.count.processes', scope, 'invocation record, limits'),
          cpus: {
            value: v.limits.cpus,
            unit: 'sentinel.viewer.measure.cpus',
            scope,
            source: `${SOURCE} · invocation record, limits`,
          },
          timeout: { ms: v.limits.timeoutMs, scope, source: `${SOURCE} · invocation record, limits` },
        }
      : null,
  };
}

const isInvocation = (v: InvocationRead | null | undefined): v is InvocationRecordView => !!v && !('absent' in v);

function provenanceOf(
  scan: ScanRecord,
  units: readonly UnitRecord[],
  kind: StageKindWord,
  where: Provenance['where'],
  traces: readonly ReviewRecord[],
  scope: string,
): Provenance {
  const first = units[0]!;
  const adapter = first.adapterId ? scan.adapters[first.adapterId] : undefined;
  // The stage speaks through the first check that has a retained invocation (the one PIPELINE shows), else says why.
  const read = units.find((u) => isInvocation(u.invocation))?.invocation ?? units.find((u) => u.invocation)?.invocation;
  const inv = isInvocation(read) ? read : null;
  const models = new Set(traces.map((t) => JSON.stringify(t.model)));
  const prompts = new Set(traces.map((t) => t.prompt.digest));
  const bytes = (n: number) => count(n, 'sentinel.viewer.count.bytes', scope, 'review instructions, recorded bytes');
  return {
    kind,
    where,
    implementation: {
      adapter: first.adapterId,
      version: inv ? bounded(inv.adapter.version, 64) : (adapter?.version ?? null),
      versionFrom: inv ? 'invocation' : adapter?.version ? 'registry' : null,
      digest: first.implementationDigest,
      registry: adapter?.registry ?? 'absent',
    },
    invocation: inv ? invocationView(inv, SCOPE.attempt) : null,
    invocationAbsent: inv
      ? null
      : read && 'absent' in read
        ? read.absent
        : first.attempts.length || first.work?.state === 'published'
          ? 'sentinel.viewer.invocation.notRead'
          : 'sentinel.viewer.where.notYet',
    provider: first.review ? { id: first.review.providerId, model: first.review.modelId } : null,
    model: traces.length && models.size === 1 ? traces[0]!.model : null,
    prompt:
      traces.length && prompts.size === 1
        ? {
            name: traces[0]!.prompt.name,
            revision: traces[0]!.prompt.revision,
            digest: traces[0]!.prompt.digest,
            bytes: bytes(traces[0]!.prompt.bytes),
          }
        : null,
    skills: traces.length
      ? traces[0]!.skills.map((s) => ({ name: s.name, revision: s.revision, digest: s.digest, bytes: bytes(s.bytes) }))
      : null,
    deadline: first.work?.deadlineMs ? duration(first.work.deadlineMs, scope, 'work envelope, resources') : null,
  };
}

function stageCard(
  scan: ScanRecord,
  stage: Stage,
  number: number,
  level: number,
  after: readonly string[],
  stagesById: ReadonlyMap<string, Stage>,
): StageCard {
  const final = FINAL.has(scan.state);
  const first = stage.units[0]!;
  const adapter = first.adapterId ? scan.adapters[first.adapterId] : undefined;
  const kind = kindOf(first, adapter);
  // inside a stage, a tool's (or Sentinel's own) unit is a check and an agent's a review — never *step* or *task*
  const unitWord = kind === 'agent' ? 'sentinel.viewer.count.reviews' : 'sentinel.viewer.count.checks';
  const statuses = stage.units.map((u) => unitStatus(u, final));
  const attempts = stage.units.flatMap((u) => u.attempts);
  const starts = attempts.map((a) => a.startedAt).sort();
  const ends = attempts.map((a) => a.endedAt);
  const status = stageStatus(statuses);
  const lastEnd = ends.includes(null) ? null : ([...(ends as string[])].sort().at(-1) ?? null);
  const reviews = reviewsOf(scan);
  const traces = stage.units.map((u) => reviews.get(u.key)).filter((r): r is ReviewRecord => !!r);
  const review = kind === 'agent';
  const where: Provenance['where'] = review
    ? 'provider'
    : (attempts.find((a) => a.accepted)?.worker ?? attempts.at(-1)?.worker ?? null);
  const tIn = tokens(attempts, 'inputTokens'),
    tOut = tokens(attempts, 'outputTokens');
  const observations = traces.reduce((n, t) => n + t.observations.length, 0);
  const turns = traces.reduce((n, t) => n + t.turns.length, 0);
  const allTraced = review && traces.length === stage.units.length && !scan.withheld;
  const findingsN =
    'findings' in scan.report && first.adapterId ? (scan.report.findingsByAdapter[first.adapterId] ?? 0) : null;
  const produced = new Map<string, Counted | undefined>();
  for (const u of stage.units) for (const o of u.outputs ?? []) produced.set(ioOf(o.schema), undefined);
  if (allTraced)
    produced.set(
      'sentinel.viewer.io.observations',
      count(observations, 'sentinel.viewer.count.modelObservations', SCOPE.stage, 'review records, observations', {
        bizUnit: 'sentinel.viewer.count.modelNotes',
      }),
    );
  const reads: IoChip[] = after.map((id) => {
    const producer = stagesById.get(id)!;
    const out = producer.units.flatMap((u) => u.outputs ?? []).map((o) => ioOf(o.schema));
    const key = out.find((k) => k !== 'sentinel.viewer.io.toolResult' && k !== 'sentinel.viewer.io.other') ?? out[0];
    return { key: key ?? 'sentinel.viewer.io.other', stage: id };
  });
  const inputs = stage.units.reduce((n, u) => n + u.inputs, 0);
  if (inputs)
    reads.push({
      key: 'sentinel.viewer.io.capturedFiles',
      count: count(inputs, 'sentinel.viewer.count.inputs', SCOPE.stage, 'plan units, inputs', {
        bizUnit: 'sentinel.viewer.count.inputs',
      }),
    });
  const held = stage.units.find(
    (u) => u.work?.reason && (u.work.state === 'blocked' || u.work.state === 'disabled-by-policy'),
  );
  return {
    id: stage.id,
    number,
    name: stageName(first.stage, first.adapterId),
    kind,
    status,
    level,
    after,
    startedAt: starts[0] ?? null,
    duration:
      status === 'running' || status === 'waiting'
        ? null
        : duration(ms(starts[0] ?? null, lastEnd), SCOPE.stage, 'attempts, first start to last end'),
    provenance: provenanceOf(scan, stage.units, kind, where, traces, SCOPE.stage),
    counts: {
      units: count(stage.units.length, unitWord, SCOPE.stage, 'plan units by stage', {
        bizUnit: unitWord,
        breakdown: statusBreakdown(statuses),
      }),
      attempts: count(attempts.length, 'sentinel.viewer.count.attempts', SCOPE.stage, 'ledger attempts', {
        bizUnit: 'sentinel.viewer.count.tries',
      }),
      inputs: count(inputs, 'sentinel.viewer.count.inputs', SCOPE.stage, 'plan units, inputs', {
        bizUnit: 'sentinel.viewer.count.inputs',
      }),
      findings:
        findingsN === null || kind === 'agent' || first.stage !== 'check'
          ? null
          : count(findingsN, 'sentinel.count.findings', SCOPE.stage, 'report findings by the adapter of their rule', {
              bizUnit: 'sentinel.count.issues',
            }),
      modelObservations: allTraced
        ? count(observations, 'sentinel.viewer.count.modelObservations', SCOPE.stage, 'review records, observations', {
            bizUnit: 'sentinel.viewer.count.modelNotes',
          })
        : null,
      turns: allTraced
        ? count(turns, 'sentinel.viewer.count.turns', SCOPE.stage, 'review records, operations', {
            bizUnit: 'sentinel.viewer.count.exchanges',
          })
        : null,
      tokensIn: tIn === null ? null : count(tIn, 'sentinel.viewer.count.tokensIn', SCOPE.stage, 'attempt usage'),
      tokensOut: tOut === null ? null : count(tOut, 'sentinel.viewer.count.tokensOut', SCOPE.stage, 'attempt usage'),
    },
    cost: costOf(attempts, SCOPE.stage, 'attempt usage'),
    reads,
    produces: [...produced].map(([key, c]) => (c ? { key, count: c } : { key })),
    heldBy: held?.work?.reason ?? null,
    errors: [...new Set(attempts.map((a) => a.error).filter((e): e is string => !!e))],
  };
}

interface Folded {
  readonly row: ScanRow;
  readonly stages: readonly StageCard[];
  readonly levels: readonly (readonly string[])[];
  readonly groups: ReadonlyMap<string, Stage>;
}

function fold(scan: ScanRecord): Folded {
  const stages = groupStages(scan.units).slice(0, READ_MODEL_LIMITS.stages);
  const groups = new Map(stages.map((s) => [s.id, s]));
  const { levels, after } = levelsOf(stages);
  const cards: StageCard[] = [];
  levels.forEach((ids, level) =>
    ids.forEach((id) =>
      cards.push(stageCard(scan, groups.get(id)!, cards.length + 1, level, after.get(id) ?? [], groups)),
    ),
  );
  const statuses = cards.map((c) => c.status);
  const agents = cards.filter((c) => c.kind === 'agent');
  // The preview and the full report count folders never listed differently today: no single number is shown.
  const absent: Record<string, string> = { unknownScopeBoundaries: 'sentinel.viewer.absent.foldsDisagree' };
  const report = 'findings' in scan.report ? scan.report : null;
  if (!report) {
    const why = (scan.report as { absent: string }).absent;
    absent.findings = why;
    absent.seenByNoStage = why;
  }
  let modelObservations: Counted | null = null;
  if (!agents.length)
    modelObservations = count(
      0,
      'sentinel.viewer.count.modelObservations',
      SCOPE.scan,
      'review records, observations',
      {
        bizUnit: 'sentinel.viewer.count.modelNotes',
      },
    );
  else if (scan.withheld) absent.modelObservations = 'sentinel.viewer.absent.withheld';
  else if (agents.every((c) => c.counts.modelObservations))
    modelObservations = count(
      agents.reduce((n, c) => n + c.counts.modelObservations!.n, 0),
      'sentinel.viewer.count.modelObservations',
      SCOPE.scan,
      'review records, observations',
      { bizUnit: 'sentinel.viewer.count.modelNotes' },
    );
  else
    absent.modelObservations =
      scan.review.status === 'unreadable'
        ? 'sentinel.viewer.absent.reviewUnreadable'
        : 'sentinel.viewer.absent.notFinished';
  let coverage: Counted | null = null;
  if (scan.result?.requiredChecks != null && scan.result.requiredComplete != null)
    coverage = count(
      scan.result.requiredComplete,
      'sentinel.viewer.count.requiredCovered',
      SCOPE.scan,
      "canonicalResult facts, requiredComplete of requiredChecks (the run command's own numbers)",
      {
        of: scan.result.requiredChecks,
        bizUnit: 'sentinel.viewer.count.requiredCovered',
      },
    );
  else
    absent.coverage =
      scan.state !== 'completed'
        ? 'sentinel.viewer.absent.notFinished'
        : (scan.result?.reasonCode ?? 'sentinel.viewer.absent.notRecorded');
  const first = scan.sources?.[0];
  const row: ScanRow = {
    id: scan.id,
    number: scan.number,
    parent: scan.parent,
    state: scan.state,
    outcome: scan.outcome,
    createdAt: scan.createdAt,
    completedAt: scan.completedAt,
    duration: duration(ms(scan.createdAt, scan.completedAt), SCOPE.scan, 'run, created to completed'),
    pipeline: {
      revision: null,
      absent: 'sentinel.viewer.absent.pipelineUndeclared',
      profile: scan.profileId,
      planRevision: scan.planRevision,
    },
    source: first
      ? {
          commit: first.commit,
          dirty: first.dirty,
          sources: count(scan.sources!.length, 'sentinel.viewer.count.sources', SCOPE.scan, 'snapshot sources', {
            bizUnit: 'sentinel.viewer.count.sources',
          }),
        }
      : null,
    policy: policyOf(scan),
    counts: {
      stages: count(cards.length, 'sentinel.viewer.count.stages', SCOPE.scan, 'plan units grouped by stage', {
        bizUnit: 'sentinel.viewer.count.stages',
        breakdown: statusBreakdown(statuses),
      }),
      agentic: count(agents.length, 'sentinel.viewer.count.agentic', SCOPE.scan, 'stages of kind agent', {
        bizUnit: 'sentinel.viewer.count.checkedByModel',
      }),
      findings: report ? report.findings : null,
      modelObservations,
      coverage,
      seenByNoStage: report ? report.seenByNoStage : null,
      unknownScopeBoundaries: null,
    },
    absent,
    cost: costOf(
      scan.units.flatMap((u) => u.attempts),
      SCOPE.scan,
      'attempt usage',
    ),
    withheld: scan.withheld,
  };
  return { row, stages: cards, levels, groups };
}

/** One row of the SCANS stop. */
export function scanRow(scan: ScanRecord): ScanRow {
  return fold(scan).row;
}

/**
 * The SCANS stop: one page of the workspace's retained scans, newest first. `total` is every scan the store keeps;
 * `before` the cursor the page was read with. The rows' numbers are exact, so `older` is the oldest number listed.
 */
export function scansAnswer(
  workspace: string,
  rows: readonly ScanRow[],
  page: { readonly total: number; readonly before: number | null },
  scanAction: ScanAction = { available: false, reasonCode: 'sentinel.preparation.unavailable' },
): ScansAnswer {
  const listed = rows.slice(0, READ_MODEL_LIMITS.scans);
  const total = Math.max(page.total, listed.length);
  const oldest = listed.at(-1)?.number ?? null;
  const older = oldest !== null && oldest > 1 ? oldest : null;
  return {
    schema: READ_MODEL_SCHEMAS.scans,
    workspace,
    scanAction,
    scans: listed,
    counts: {
      scans: count(total, 'sentinel.viewer.count.scans', SCOPE.scans, 'ledger run-created events, every run', {
        bizUnit: 'sentinel.viewer.count.scans',
      }),
      shown: count(listed.length, 'sentinel.viewer.count.scansShown', SCOPE.scans, 'this page of the runs', {
        of: total,
        bizUnit: 'sentinel.viewer.count.scansShown',
      }),
    },
    page: { before: page.before, older },
    more: older !== null,
    readOnly: true,
  };
}

/** The PIPELINE stop: one scan's stages, top to bottom, with each stage's provenance. */
export function scanAnswer(workspace: string, scan: ScanRecord): ScanAnswer {
  const f = fold(scan);
  return {
    schema: READ_MODEL_SCHEMAS.scan,
    workspace,
    scan: f.row,
    stages: f.stages,
    levels: f.levels,
    review: scan.withheld ? 'withheld' : scan.review.status,
    readOnly: true,
  };
}

/** A stage's units in the order its STAGE stop lists them (the fold's own grouping); [] when there is no such stage. */
export function stageUnits(scan: ScanRecord, stageId: string): readonly UnitRecord[] {
  return (
    groupStages(scan.units)
      .find((s) => s.id === stageId)
      ?.units.slice(0, READ_MODEL_LIMITS.unitsPerStage) ?? []
  );
}

const PATH = /^[^\0\n\r]{1,512}$/;
const lines = (a: unknown, b: unknown): readonly [number, number] | undefined =>
  Number.isSafeInteger(a) && Number.isSafeInteger(b) && (a as number) >= 1 && (b as number) >= (a as number)
    ? [a as number, b as number]
    : undefined;
const parse = (text: string | null): Record<string, unknown> | null => {
  if (!text || text.length > 65536) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const path = (v: unknown): string | undefined => (typeof v === 'string' && PATH.test(v) ? v : undefined);

/** What Sentinel sent in a turn: the assignment, or the answer to the model's last request, by its shape. */
export function sentOf(text: string | null, withheld: boolean): TurnRow['sent'] {
  const v = parse(text);
  if (!v) return null;
  if (typeof v.task === 'string')
    return {
      key: 'sentinel.viewer.turn.task',
      ...(Array.isArray(v.files)
        ? { files: count(v.files.length, 'sentinel.viewer.count.files', SCOPE.turn, 'the request, its files') }
        : {}),
    };
  if (typeof v.tool === 'string') {
    const data = v.data && typeof v.data === 'object' ? (v.data as Record<string, unknown>) : {};
    const p = withheld ? undefined : path(data.path);
    const l = lines(data.startLine, data.endLine);
    return {
      key: 'sentinel.viewer.turn.toolResult',
      tool: bounded(v.tool, 32),
      ...(typeof v.ok === 'boolean' ? { ok: v.ok } : {}),
      ...(p ? { path: p } : {}),
      ...(l ? { lines: l } : {}),
    };
  }
  return null;
}

/** The model's reply that ended a turn, by the closed grammar it was allowed to use. */
export function replyOf(text: string | null, withheld: boolean): TurnRow['reply'] {
  if (text === null) return null;
  const v = parse(text);
  const action = v?.action;
  if (action === 'list') return { key: 'sentinel.viewer.turn.list' };
  if (action === 'rule') return { key: 'sentinel.viewer.turn.rule' };
  if (action === 'paths') return { key: 'sentinel.viewer.turn.paths' };
  if (action === 'read') {
    const p = withheld ? undefined : path(v!.path);
    const l = lines(v!.startLine, v!.endLine);
    return { key: 'sentinel.viewer.turn.read', ...(p ? { path: p } : {}), ...(l ? { lines: l } : {}) };
  }
  if (action === 'final')
    return {
      key: 'sentinel.viewer.turn.final',
      ...(typeof v!.verdict === 'string' ? { verdict: bounded(v!.verdict, 32) } : {}),
      ...(Array.isArray(v!.claims) ? { claims: claims(v!.claims.length) } : {}),
    };
  return { key: 'sentinel.viewer.turn.unreadable' };
}

const claims = (n: number) => count(n, 'sentinel.viewer.count.claims', SCOPE.turn, "the model's reply, its claims");
const textPart = (raw: string | null, max: number): TextPart | null =>
  raw === null ? null : { text: raw.length > max ? raw.slice(0, max) : raw, truncated: raw.length > max };

function reviewedOf(scan: ScanRecord, unit: UnitRecord, scope: string): ReviewedView | null {
  if (!unit.reviewed) return null;
  if (unit.reviewed.kind === 'rule')
    return {
      kind: 'rule',
      rule: bounded(unit.reviewed.familyId, 128),
      revision: unit.reviewed.revision,
      path: scan.withheld ? null : (scopePath(unit.reviewed.scope) ?? null),
    };
  return {
    kind: 'files',
    files: count(unit.inputs, 'sentinel.viewer.count.files', scope, 'plan unit, inputs', {
      bizUnit: 'sentinel.viewer.count.files',
    }),
  };
}

function unitRow(
  scan: ScanRecord,
  unit: UnitRecord,
  number: number,
  review: ReviewRecord | undefined,
  detail = false,
): UnitRow {
  const final = FINAL.has(scan.state);
  const scope = unit.review || unit.work?.kind === 'agentic' ? SCOPE.review : SCOPE.check;
  const status = unitStatus(unit, final);
  const attempts = unit.attempts.slice(-READ_MODEL_LIMITS.attemptsPerUnit);
  const ends = unit.attempts.map((a) => a.endedAt);
  const lastEnd = ends.includes(null) ? null : ([...(ends as string[])].sort().at(-1) ?? null);
  const scoped = unit.scopes.map(scopePath).filter((p): p is string => !!p);
  const withheld = scan.withheld;
  const paths = withheld
    ? []
    : scoped.length
      ? scoped
      : unit.inputPaths.map((p) => bounded(p, READ_MODEL_LIMITS.pathChars));
  const tIn = tokens(unit.attempts, 'inputTokens'),
    tOut = tokens(unit.attempts, 'outputTokens');
  return {
    number,
    label: paths[0] ?? null,
    reviewed: reviewedOf(scan, unit, scope),
    status,
    startedAt: unit.attempts[0]?.startedAt ?? null,
    duration:
      status === 'running' || status === 'waiting'
        ? null
        : duration(ms(unit.attempts[0]?.startedAt ?? null, lastEnd), scope, 'attempts, first start to last end'),
    attempts: attempts.map((a) => ({
      ordinal: a.ordinal,
      state: a.state,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      duration: duration(ms(a.startedAt, a.endedAt), scope, 'attempt, start to end'),
      where: a.worker,
      accepted: a.accepted,
      error: a.error,
      usage: a.usage.certainty,
    })),
    counts: {
      files: count(scoped.length || unit.inputs, 'sentinel.viewer.count.files', scope, 'plan unit, scopes or inputs', {
        bizUnit: 'sentinel.viewer.count.files',
      }),
      attempts: count(unit.attempts.length, 'sentinel.viewer.count.attempts', scope, 'ledger attempts', {
        bizUnit: 'sentinel.viewer.count.tries',
      }),
      inputs: count(unit.inputs, 'sentinel.viewer.count.inputs', scope, 'plan unit, inputs', {
        bizUnit: 'sentinel.viewer.count.inputs',
      }),
      tokensIn: tIn === null ? null : count(tIn, 'sentinel.viewer.count.tokensIn', scope, 'attempt usage'),
      tokensOut: tOut === null ? null : count(tOut, 'sentinel.viewer.count.tokensOut', scope, 'attempt usage'),
      turns: review
        ? count(review.turns.length, 'sentinel.viewer.count.turns', scope, 'review record, operations', {
            bizUnit: 'sentinel.viewer.count.exchanges',
          })
        : null,
      modelObservations: review
        ? count(
            review.observations.length,
            'sentinel.viewer.count.modelObservations',
            scope,
            'review record, observations',
            {
              bizUnit: 'sentinel.viewer.count.modelNotes',
            },
          )
        : null,
    },
    cost: costOf(unit.attempts, scope, 'attempt usage'),
    review: review
      ? {
          model: review.model,
          verdict: review.verdict,
          outcome: review.outcome,
          turns: review.turns.slice(0, READ_MODEL_LIMITS.turnsPerUnit).map((t, i) => {
            const usage = (n: number | null, unit: string, source: string) =>
              n === null ? null : count(n, unit, SCOPE.turn, source);
            const row: TurnRow = {
              number: i + 1,
              outcome: t.outcome,
              sent: sentOf(t.sent, withheld),
              // The last reply ends the session and is kept as its verdict and observations, not as a request.
              reply:
                t.reply === null && t.outcome === 'final'
                  ? {
                      key: 'sentinel.viewer.turn.final',
                      ...(review.verdict ? { verdict: review.verdict } : {}),
                      claims: claims(review.observations.length),
                    }
                  : t.reply === null && t.outcome === 'failed'
                    ? { key: 'sentinel.viewer.turn.failed' }
                    : t.reply === null && /^sentinel\.[A-Za-z0-9.]+$/.test(t.outcome)
                      ? { key: t.outcome } // the reply was refused or the call failed: the recorded reason, in words
                      : replyOf(t.reply, withheld),
              counts: {
                tokensIn: usage(t.inputTokens, 'sentinel.viewer.count.tokensIn', 'review record, operation usage'),
                tokensOut: usage(t.outputTokens, 'sentinel.viewer.count.tokensOut', 'review record, operation usage'),
                inputBytes: usage(t.inputBytes, 'sentinel.viewer.count.bytes', 'review record, operation input bytes'),
              },
            };
            if (!detail) return row;
            // A unit's detail carries the exchange's own retained words, bounded, unless the scan withholds them.
            if (withheld) return { ...row, text: null, textAbsent: 'sentinel.viewer.absent.withheld' };
            const sent = textPart(t.sent, READ_MODEL_LIMITS.turnChars),
              reply = textPart(t.reply, READ_MODEL_LIMITS.turnChars);
            return sent || reply
              ? { ...row, text: { sent, reply }, textAbsent: null }
              : { ...row, text: null, textAbsent: 'sentinel.viewer.absent.notRecorded' };
          }),
          observations: review.observations.slice(0, READ_MODEL_LIMITS.observationsPerUnit).map((o) => {
            const citations = o.citations.slice(0, READ_MODEL_LIMITS.citationsPerObservation).map((c) => ({
              path: bounded(c.path, READ_MODEL_LIMITS.pathChars),
              startByte: c.startByte,
              endByte: c.endByte,
            }));
            return {
              message: bounded(o.message, READ_MODEL_LIMITS.messageChars),
              severity: bounded(o.severity, 32),
              citations,
              counts: {
                citations: count(o.citations.length, 'sentinel.viewer.count.citations', scope, 'observation evidence'),
              },
            };
          }),
          inspected: review.inspected
            .slice(0, READ_MODEL_LIMITS.inspectedPerUnit)
            .map((p) => bounded(p, READ_MODEL_LIMITS.pathChars)),
        }
      : null,
  };
}

/** The STAGE stop: one stage's retained record, check by check or review by review; null when there is no such stage. */
export function stageAnswer(workspace: string, scan: ScanRecord, stageId: string): StageAnswer | null {
  const f = fold(scan);
  const card = f.stages.find((s) => s.id === stageId);
  const group = f.groups.get(stageId);
  if (!card || !group) return null;
  const reviews = reviewsOf(scan);
  const units = group.units.slice(0, READ_MODEL_LIMITS.unitsPerStage);
  const traces = units.map((u) => reviews.get(u.key)).filter((r): r is ReviewRecord => !!r);
  const prompt = traces[0]?.prompt ?? null;
  return {
    schema: READ_MODEL_SCHEMAS.stage,
    workspace,
    scan: f.row,
    stage: card,
    units: units.map((u, i) => unitRow(scan, u, i + 1, reviews.get(u.key))),
    more: group.units.length > units.length,
    prompt:
      prompt && new Set(traces.map((t) => t.prompt.digest)).size === 1
        ? {
            name: prompt.name,
            revision: prompt.revision,
            digest: prompt.digest,
            bytes: count(
              prompt.bytes,
              'sentinel.viewer.count.bytes',
              SCOPE.stage,
              'review instructions, recorded bytes',
            ),
            text: prompt.text === null ? null : prompt.text.slice(0, READ_MODEL_LIMITS.textBytes),
          }
        : null,
    review: scan.withheld ? 'withheld' : scan.review.status,
    disclosure: 'owner-private',
    readOnly: true,
  };
}

/**
 * One retained output as the detail shows it: its text only when the scan holds no secret match, its class is not
 * the source itself, and it is text; at most `outputChars` of it.
 */
export function outputView(scan: ScanRecord, o: RawOutputRecord): OutputView {
  const base = {
    key: ioOf(o.schema),
    schema: bounded(o.schema, 128),
    privacy: o.privacy,
    size:
      o.bytes === null ? null : count(o.bytes, 'sentinel.viewer.count.bytes', SCOPE.output, 'the store, decoded size'),
  };
  const reason = scan.withheld
    ? 'sentinel.viewer.absent.withheld'
    : o.privacy === 'source'
      ? 'sentinel.viewer.raw.source'
      : o.text === null
        ? (o.reason ?? 'sentinel.viewer.raw.unreadable')
        : null;
  if (reason || o.text === null) return { ...base, text: null, truncated: false, withheld: reason };
  const max = READ_MODEL_LIMITS.outputChars;
  return { ...base, text: o.text.slice(0, max), truncated: o.text.length > max, withheld: null };
}

/**
 * One check or review opened (the STAGE stop's detail): its tries, what its try ran (from the retained invocation),
 * its retained outputs, and for a review every exchange with the model's own words. Null when there is no such unit.
 */
export function unitAnswer(
  workspace: string,
  scan: ScanRecord,
  stageId: string,
  number: number,
  detail: { readonly invocation: InvocationRead | null; readonly outputs: readonly RawOutputRecord[] },
): UnitAnswer | null {
  const f = fold(scan);
  const card = f.stages.find((s) => s.id === stageId);
  const units = stageUnits(scan, stageId);
  const unit = units[number - 1];
  if (!card || !unit) return null;
  const review = reviewsOf(scan).get(unit.key);
  const inv = isInvocation(detail.invocation) ? detail.invocation : null;
  const shown = detail.outputs.slice(0, READ_MODEL_LIMITS.outputsPerUnit);
  return {
    schema: READ_MODEL_SCHEMAS.unit,
    workspace,
    scan: f.row,
    stage: card,
    unit: unitRow(scan, unit, number, review, true),
    invocation: inv ? invocationView(inv, SCOPE.attempt) : null,
    invocationAbsent: inv
      ? null
      : detail.invocation && 'absent' in detail.invocation
        ? detail.invocation.absent
        : 'sentinel.viewer.where.notYet',
    outputs: shown.map((o) => outputView(scan, o)),
    outputsMore: detail.outputs.length > shown.length,
    review: scan.withheld ? 'withheld' : scan.review.status,
    disclosure: 'owner-private',
    readOnly: true,
  };
}
