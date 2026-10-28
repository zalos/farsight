// The viewer's read model of retained scans (Sentinel v2 §4, lane L-UX U-1): one pure fold from the records the held
// owner service gathers (`owner-ui/scans.ts`) into the answers the SCANS · PIPELINE · STAGE stops draw. It reads plain
// records only: no store, no network, no clock. Every count is a core `Counted` with a `sentinel.viewer.scope.*` (or an
// existing Sentinel) scope; a duration and a price are measures that carry their scope too (docs/COUNTS.md § Sentinel
// read model). A stage is the work unit's stage contract until the declared pipeline lands (P-3), then the stage id.
//
// What never leaves this fold: a run, plan, unit or attempt id, an artifact handle or a store path. A scan is
// addressed by its number in the workspace's list; a stage by its contract. Digests that identify what ran (an
// implementation, an image, a prompt) are provenance and are carried; the viewer prints them outside the business
// register only. When the scan's accepted evidence holds a secret match, every file name, prompt text, model message
// and request detail is withheld here, as the report withholds them (`withheld: true`).
// Core's `Counted` shape, through the contract that already declares it, so an installed package resolves its types.
import type { ReportCount as Counted, ReportCountPart as CountPart } from '../../contracts/report.js';

export const READ_MODEL_SCHEMAS = Object.freeze({
  scans: 'sentinel-viewer-scans/draft-1',
  scan: 'sentinel-viewer-scan/draft-1',
  stage: 'sentinel-viewer-stage/draft-1',
} as const);

/** The bounds every answer keeps, whatever the store holds. */
export const READ_MODEL_LIMITS = Object.freeze({
  scans: 64,
  stages: 256,
  stepsPerStage: 256,
  attemptsPerStep: 16,
  turnsPerStep: 64,
  observationsPerStep: 16,
  citationsPerObservation: 8,
  inspectedPerStep: 32,
  textBytes: 64 * 1024,
  messageChars: 2000,
  pathChars: 512,
});

// ---- the records the service gathers (input) ----

export type WorkerPlace = 'in-process' | 'child' | 'container' | 'external';
export type UsageCertainty = 'confirmed' | 'unknown' | 'not-applicable';

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
  readonly review: { readonly providerId: string; readonly modelId: string } | null;
  readonly work: {
    readonly state: string;
    readonly reason: string | null;
    readonly kind: string;
    readonly deadlineMs: number;
    /** The scan number whose publication this unit reused, when it was satisfied by reuse and that scan is listed. */
    readonly reusedFrom: number | null;
  } | null;
  readonly attempts: readonly AttemptRecord[];
  /** The accepted publication's output schemas, in order; null before one is accepted. */
  readonly outputs: readonly string[] | null;
}

export interface AdapterRecord {
  /** The registry's version, only when it holds the exact adapter the plan pinned. */
  readonly version: string | null;
  readonly kind: 'external' | 'built-in' | 'operation' | null;
  readonly image: string | null;
  readonly command: readonly string[] | null;
  /** Whether this installation's registry still holds the exact adapter the plan pinned. */
  readonly registry: 'current' | 'changed' | 'absent';
}

export interface TurnRecord {
  readonly outcome: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly inputBytes: number;
  /** The request Sentinel sent, read from its last user message (never its evidence text). */
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
  readonly number: number;
  readonly parentNumber: number | null;
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
   * The report fold's own counts, copied as the report prints them (never refolded here), and its findings by the
   * adapter whose rule found each (a partition of the same list); the reason when there is no report.
   */
  readonly report:
    | {
        readonly findings: Counted;
        readonly seenByNoStage: Counted;
        readonly unknownScopeBoundaries: Counted;
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
  /** A secret match in the accepted evidence: every file name and model text is withheld. */
  readonly withheld: boolean;
}

// ---- the answers (output) ----

export type StageKindWord = 'builtin' | 'tool' | 'script' | 'agent';
export type StageStatus = 'done' | 'running' | 'waiting' | 'failed' | 'held' | 'reused' | 'not-run';

/** A length of time and what it is the length of. */
export interface Duration {
  readonly ms: number;
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

/** README §3.1/§3.2 provenance, coded against the plan until P-1's contract lands: what ran, which version, where. */
export interface Provenance {
  readonly kind: StageKindWord;
  readonly where: WorkerPlace | 'provider' | null;
  readonly implementation: {
    readonly adapter: string | null;
    readonly version: string | null;
    readonly digest: string;
    /** Whether this installation still holds the exact adapter the plan pinned. */
    readonly registry: 'current' | 'changed' | 'absent';
  };
  readonly image: string | null;
  readonly command: readonly string[] | null;
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
    readonly bytes: number;
  } | null;
  readonly skills:
    | readonly { readonly name: string; readonly revision: number; readonly digest: string; readonly bytes: number }[]
    | null;
  readonly deadlineMs: number | null;
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
    readonly steps: Counted;
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
  readonly number: number;
  readonly parent: number | null;
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
  readonly source: { readonly commit: string | null; readonly dirty: boolean; readonly sources: number } | null;
  readonly policy: { readonly word: string; readonly reasonCode: string | null };
  readonly counts: {
    readonly stages: Counted;
    readonly agentic: Counted;
    readonly findings: Counted | null;
    readonly modelObservations: Counted | null;
    readonly coverage: Counted | null;
    /** The report's *n of m captured files seen by no check*: `of` is every captured file. */
    readonly seenByNoStage: Counted | null;
    /** The report's *folders never listed*. */
    readonly unknownScopeBoundaries: Counted | null;
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
  readonly counts: { readonly scans: Counted };
  /** Older scans exist beyond the listed ones. */
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

export interface TurnRow {
  readonly number: number;
  readonly outcome: string;
  readonly sent: {
    readonly key: string;
    readonly tool?: string;
    readonly ok?: boolean;
    readonly path?: string;
    readonly lines?: readonly [number, number];
    readonly files?: number;
  } | null;
  readonly reply: {
    readonly key: string;
    readonly path?: string;
    readonly lines?: readonly [number, number];
    readonly verdict?: string;
    readonly claims?: number;
  } | null;
  readonly counts: { readonly tokensIn: Counted | null; readonly tokensOut: Counted | null };
  readonly inputBytes: number;
}

export interface StepRow {
  readonly number: number;
  /** The file it covered, or the first of its files; null when withheld or when it covers a whole source. */
  readonly label: string | null;
  readonly files: number;
  readonly status: StageStatus;
  readonly startedAt: string | null;
  readonly duration: Duration | null;
  readonly attempts: readonly AttemptRow[];
  readonly counts: {
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
  readonly steps: readonly StepRow[];
  readonly more: boolean;
  /** The prompt the stage's model was given, when it is readable and nothing is withheld. */
  readonly prompt: {
    readonly name: string;
    readonly revision: number;
    readonly digest: string;
    readonly bytes: number;
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

// ---- the fold ----

const SOURCE = 'sentinel viewer read model draft-1';
const SCOPE = Object.freeze({
  scans: 'sentinel.viewer.scope.scans',
  scan: 'sentinel.viewer.scope.scan',
  stage: 'sentinel.viewer.scope.stage',
  step: 'sentinel.viewer.scope.task',
  turn: 'sentinel.viewer.scope.turn',
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

/** README §3.1's four kinds over today's `StageKind` (coded, external-tool, agentic; script once P-1 adds it). */
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
  const models = new Set(traces.map((t) => JSON.stringify(t.model)));
  const prompts = new Set(traces.map((t) => t.prompt.digest));
  const tIn = tokens(attempts, 'inputTokens'),
    tOut = tokens(attempts, 'outputTokens');
  const observations = traces.reduce((n, t) => n + t.observations.length, 0);
  const turns = traces.reduce((n, t) => n + t.turns.length, 0);
  const findingsN =
    'findings' in scan.report && first.adapterId ? (scan.report.findingsByAdapter[first.adapterId] ?? 0) : null;
  const produced = new Map<string, Counted | undefined>();
  for (const u of stage.units) for (const schema of u.outputs ?? []) produced.set(ioOf(schema), undefined);
  if (review && traces.length === stage.units.length && !scan.withheld)
    produced.set(
      'sentinel.viewer.io.observations',
      count(observations, 'sentinel.viewer.count.modelObservations', SCOPE.stage, 'review records, observations', {
        bizUnit: 'sentinel.viewer.count.modelNotes',
      }),
    );
  const reads: IoChip[] = after.map((id) => {
    const producer = stagesById.get(id)!;
    const out = producer.units.flatMap((u) => u.outputs ?? []).map(ioOf);
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
    provenance: {
      kind,
      where,
      implementation: {
        adapter: first.adapterId,
        version: adapter?.version ?? null,
        digest: first.implementationDigest,
        registry: adapter?.registry ?? 'absent',
      },
      image: adapter?.image ?? null,
      command: adapter?.command ?? null,
      provider: first.review ? { id: first.review.providerId, model: first.review.modelId } : null,
      model: traces.length && models.size === 1 ? traces[0]!.model : null,
      prompt:
        traces.length && prompts.size === 1
          ? {
              name: traces[0]!.prompt.name,
              revision: traces[0]!.prompt.revision,
              digest: traces[0]!.prompt.digest,
              bytes: traces[0]!.prompt.bytes,
            }
          : null,
      skills: traces.length ? traces[0]!.skills : null,
      deadlineMs: first.work?.deadlineMs ?? null,
    },
    counts: {
      steps: count(stage.units.length, 'sentinel.viewer.count.units', SCOPE.stage, 'plan units by stage', {
        bizUnit: 'sentinel.viewer.count.tasks',
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
      modelObservations:
        review && traces.length === stage.units.length && !scan.withheld
          ? count(
              observations,
              'sentinel.viewer.count.modelObservations',
              SCOPE.stage,
              'review records, observations',
              {
                bizUnit: 'sentinel.viewer.count.modelNotes',
              },
            )
          : null,
      turns:
        review && traces.length === stage.units.length && !scan.withheld
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
  const absent: Record<string, string> = {};
  const report = 'findings' in scan.report ? scan.report : null;
  if (!report) {
    const why = (scan.report as { absent: string }).absent;
    absent.findings = why;
    absent.seenByNoStage = why;
    absent.unknownScopeBoundaries = why;
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
    number: scan.number,
    parent: scan.parentNumber,
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
    source: first ? { commit: first.commit, dirty: first.dirty, sources: scan.sources!.length } : null,
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
      unknownScopeBoundaries: report ? report.unknownScopeBoundaries : null,
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

/** The SCANS stop: the workspace's retained scans, newest first. */
export function scansAnswer(
  workspace: string,
  rows: readonly ScanRow[],
  more: boolean,
  scanAction: ScanAction = { available: false, reasonCode: 'sentinel.preparation.unavailable' },
): ScansAnswer {
  const listed = rows.slice(0, READ_MODEL_LIMITS.scans);
  return {
    schema: READ_MODEL_SCHEMAS.scans,
    workspace,
    scanAction,
    scans: listed,
    counts: {
      scans: count(listed.length, 'sentinel.viewer.count.scans', SCOPE.scans, 'ledger runs, newest first', {
        bizUnit: 'sentinel.viewer.count.scans',
      }),
    },
    more: more || rows.length > listed.length,
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

/** What Sentinel sent in a turn: the task, or the answer to the model's last request (never its evidence text). */
export function sentOf(text: string | null, withheld: boolean): TurnRow['sent'] {
  const v = parse(text);
  if (!v) return null;
  if (typeof v.task === 'string')
    return { key: 'sentinel.viewer.turn.task', ...(Array.isArray(v.files) ? { files: v.files.length } : {}) };
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
      ...(Array.isArray(v!.claims) ? { claims: v!.claims.length } : {}),
    };
  return { key: 'sentinel.viewer.turn.unreadable' };
}

function stepRow(scan: ScanRecord, unit: UnitRecord, number: number, review: ReviewRecord | undefined): StepRow {
  const final = FINAL.has(scan.state);
  const status = unitStatus(unit, final);
  const attempts = unit.attempts.slice(-READ_MODEL_LIMITS.attemptsPerStep);
  const ends = unit.attempts.map((a) => a.endedAt);
  const lastEnd = ends.includes(null) ? null : ([...(ends as string[])].sort().at(-1) ?? null);
  const paths = scan.withheld ? [] : unit.scopes.map(scopePath).filter((p): p is string => !!p);
  const tIn = tokens(unit.attempts, 'inputTokens'),
    tOut = tokens(unit.attempts, 'outputTokens');
  const withheld = scan.withheld;
  return {
    number,
    label: paths[0] ?? null,
    files: unit.scopes.map(scopePath).filter(Boolean).length,
    status,
    startedAt: unit.attempts[0]?.startedAt ?? null,
    duration:
      status === 'running' || status === 'waiting'
        ? null
        : duration(ms(unit.attempts[0]?.startedAt ?? null, lastEnd), SCOPE.step, 'attempts, first start to last end'),
    attempts: attempts.map((a) => ({
      ordinal: a.ordinal,
      state: a.state,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      duration: duration(ms(a.startedAt, a.endedAt), SCOPE.step, 'attempt, start to end'),
      where: a.worker,
      accepted: a.accepted,
      error: a.error,
      usage: a.usage.certainty,
    })),
    counts: {
      attempts: count(unit.attempts.length, 'sentinel.viewer.count.attempts', SCOPE.step, 'ledger attempts', {
        bizUnit: 'sentinel.viewer.count.tries',
      }),
      inputs: count(unit.inputs, 'sentinel.viewer.count.inputs', SCOPE.step, 'plan unit, inputs', {
        bizUnit: 'sentinel.viewer.count.inputs',
      }),
      tokensIn: tIn === null ? null : count(tIn, 'sentinel.viewer.count.tokensIn', SCOPE.step, 'attempt usage'),
      tokensOut: tOut === null ? null : count(tOut, 'sentinel.viewer.count.tokensOut', SCOPE.step, 'attempt usage'),
      turns: review
        ? count(review.turns.length, 'sentinel.viewer.count.turns', SCOPE.step, 'review record, operations', {
            bizUnit: 'sentinel.viewer.count.exchanges',
          })
        : null,
      modelObservations: review
        ? count(
            review.observations.length,
            'sentinel.viewer.count.modelObservations',
            SCOPE.step,
            'review record, observations',
            {
              bizUnit: 'sentinel.viewer.count.modelNotes',
            },
          )
        : null,
    },
    cost: costOf(unit.attempts, SCOPE.step, 'attempt usage'),
    review: review
      ? {
          model: review.model,
          verdict: review.verdict,
          outcome: review.outcome,
          turns: review.turns.slice(0, READ_MODEL_LIMITS.turnsPerStep).map((t, i) => ({
            number: i + 1,
            outcome: t.outcome,
            sent: sentOf(t.sent, withheld),
            // The last reply ends the session and is kept as its verdict and observations, not as a request.
            reply:
              t.reply === null && t.outcome === 'final'
                ? {
                    key: 'sentinel.viewer.turn.final',
                    ...(review.verdict ? { verdict: review.verdict } : {}),
                    claims: review.observations.length,
                  }
                : replyOf(t.reply, withheld),
            counts: {
              tokensIn:
                t.inputTokens === null
                  ? null
                  : count(
                      t.inputTokens,
                      'sentinel.viewer.count.tokensIn',
                      SCOPE.turn,
                      'review record, operation usage',
                    ),
              tokensOut:
                t.outputTokens === null
                  ? null
                  : count(
                      t.outputTokens,
                      'sentinel.viewer.count.tokensOut',
                      SCOPE.turn,
                      'review record, operation usage',
                    ),
            },
            inputBytes: t.inputBytes,
          })),
          observations: review.observations.slice(0, READ_MODEL_LIMITS.observationsPerStep).map((o) => {
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
                citations: count(
                  o.citations.length,
                  'sentinel.viewer.count.citations',
                  SCOPE.step,
                  'observation evidence',
                ),
              },
            };
          }),
          inspected: review.inspected
            .slice(0, READ_MODEL_LIMITS.inspectedPerStep)
            .map((p) => bounded(p, READ_MODEL_LIMITS.pathChars)),
        }
      : null,
  };
}

/** The STAGE stop: one stage's retained record, step by step; null when the scan has no such stage. */
export function stageAnswer(workspace: string, scan: ScanRecord, stageId: string): StageAnswer | null {
  const f = fold(scan);
  const card = f.stages.find((s) => s.id === stageId);
  const group = f.groups.get(stageId);
  if (!card || !group) return null;
  const reviews = reviewsOf(scan);
  const units = group.units.slice(0, READ_MODEL_LIMITS.stepsPerStage);
  const traces = units.map((u) => reviews.get(u.key)).filter((r): r is ReviewRecord => !!r);
  const prompt = traces[0]?.prompt ?? null;
  return {
    schema: READ_MODEL_SCHEMAS.stage,
    workspace,
    scan: f.row,
    stage: card,
    steps: units.map((u, i) => stepRow(scan, u, i + 1, reviews.get(u.key))),
    more: group.units.length > units.length,
    prompt:
      prompt && new Set(traces.map((t) => t.prompt.digest)).size === 1
        ? {
            name: prompt.name,
            revision: prompt.revision,
            digest: prompt.digest,
            bytes: prompt.bytes,
            text: prompt.text === null ? null : prompt.text.slice(0, READ_MODEL_LIMITS.textBytes),
          }
        : null,
    review: scan.withheld ? 'withheld' : scan.review.status,
    disclosure: 'owner-private',
    readOnly: true,
  };
}
