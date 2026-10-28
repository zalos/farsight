// The report document (PR 19, ADR 38): one deterministic `sentinel-report/draft-1` projection that every rendering
// (JSON, Markdown, HTML, SARIF) reads. It keeps the observations' ids, groups them into findings, places them through
// the pinned context, labels them against a baseline when one is given, lists coverage gaps, counts everything with
// the scope it counts over, and carries the definitions of every word it uses so a recipient needs neither product.
// A disclosure profile decides which evidence is embedded; withheld evidence keeps its identity and reason, and
// never changes a finding, a coverage verdict or a count. Secret evidence is never embedded and never located.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import { STRINGS } from '@farsight/core/dist/strings.js';
import type {
  ArtifactId,
  CoverageEnvelope,
  FindingPlace,
  ObservationEnvelope,
  ReportCount,
  ReportDefinition,
  ReportEnvelope,
  ReportEvidence,
  ReportFinding,
  ReportGap,
  ReportControlInspection,
  ReportStructuralPaths,
  ReportHistoricalFinding,
  ReportReviewObservation,
  RegisterText,
  Provenance,
  WorkRef,
} from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { correlate, type Finding } from '../findings/correlate.js';
import { normalizeObservation, SEVERITIES, type NormalizeOptions, type Severity } from '../findings/normalize.js';
import type { Comparison } from '../findings/compare.js';
import { contextProblem, type PinnedContext } from './context.js';
import { placeFiles, placeNodes, unplaced } from './place.js';
import { camel, labelKey, labelPartKey } from './words.js';

/** The `source` every count in a report document names: this fold, at its version. */
export const REPORT_SOURCE = 'sentinel report fold draft-1';
/**
 * The disclosure profiles: `private` embeds source excerpts, `shareable` keeps locations only. Neither ever embeds or
 * locates a secret, and withheld evidence never changes a finding, a coverage verdict or a count.
 */
export const DISCLOSURE_PROFILES = Object.freeze({
  private: Object.freeze({ embedSource: true, locations: true, note: 'source excerpts embedded; secrets never' }),
  shareable: Object.freeze({
    embedSource: false,
    locations: true,
    note: 'no source excerpts; locations kept; secrets never',
  }),
});
/** The name of a disclosure profile. */
export type DisclosureProfile = keyof typeof DISCLOSURE_PROFILES;

const MAX_EXCERPT_CHARS = 2000;
const MAX_EVIDENCE = 64;
const digest = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;

/**
 * A report document the fold refuses: `sentinel.report.invalidInput` (an unknown profile, a comparison that misses a
 * finding, coverage that is repeated or for an unplanned check), `sentinel.report.invalidDocument` (the result does not
 * fit its contract) or `sentinel.report.tooLarge` (more SARIF results than the export allows).
 */
export class ReportError extends Error {
  constructor(
    readonly code: 'sentinel.report.invalidInput' | 'sentinel.report.invalidDocument' | 'sentinel.report.tooLarge',
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

/** A baseline finding as the comparison and the historical list need it. */
export interface BaselineFindingSummary {
  readonly id: string;
  readonly ruleFamilyId: string;
  readonly severity: Severity;
  readonly title: RegisterText;
  readonly place?: FindingPlace;
}

/** One check the admitted plan holds, with the captured files it was to cover. */
export interface PlannedCheck {
  readonly checkId: string;
  readonly sourceId: string;
  /** The captured files (relative paths) the check was planned over, for placing a gap. */
  readonly files: readonly string[];
}

/**
 * Everything `buildReport` folds into one document. Besides it, the fold reads only the catalog's words, so the same
 * input and catalog give the same document.
 */
export interface ReportInput {
  readonly id: string;
  readonly run: ReportEnvelope['run'];
  readonly ledgerSequence: number;
  readonly evaluatedAt: string;
  readonly catalogVersion: string;
  readonly disclosure: DisclosureProfile;
  readonly observations: readonly ObservationEnvelope[];
  readonly coverage: readonly CoverageEnvelope[];
  readonly inspections?: readonly ReportControlInspection[];
  readonly structuralPaths?: readonly ReportStructuralPaths[];
  /** Every check the plan holds, with the files it was to cover; a planned check without a coverage record is a gap. */
  readonly plannedChecks: readonly PlannedCheck[];
  readonly inventory: {
    readonly included: number;
    readonly seenByNoStage: number;
    readonly unknownScopeBoundaries: number;
  };
  readonly readContent: (id: ArtifactId) => Promise<Uint8Array>;
  /** Pinned contexts by snapshot source id; a source without one is reported unplaced. */
  readonly contexts?: ReadonlyMap<string, PinnedContext>;
  /** Readable words for rule families, from the rule pack. */
  readonly rules?: ReadonlyMap<string, { readonly title: RegisterText; readonly explanation: RegisterText }>;
  /**
   * Files (`sourceId:relativePath`) whose location is withheld, such as a file whose name the secret scan matched: never
   * used to place anything, since a symbol id names its file.
   */
  readonly withheldFiles?: ReadonlySet<string>;
  /**
   * Model observations with the stage and unit that published them: a cited class beside the findings, never grouped
   * into them. Absent: the document has no review section.
   */
  readonly reviews?: readonly {
    readonly observation: ObservationEnvelope;
    readonly stage: string;
    readonly unit: WorkRef;
  }[];
  /** One provenance record per published attempt. Absent: the document has no provenance section. */
  readonly provenance?: readonly Provenance[];
  /** A comparison computed with `compareAssessments` over these findings and a baseline's. */
  readonly comparison?: {
    readonly baselineReportId: string;
    readonly result: Comparison;
    readonly baselineFindings: ReadonlyMap<string, BaselineFindingSummary>;
  };
}

/** A built report: the validated document, the findings it was built from, and the artifacts it names. */
export interface ReportBuild {
  readonly document: ReportEnvelope;
  /** The findings as correlated, for a comparison or a later run's baseline. */
  readonly findings: readonly Finding[];
  /** Artifacts the document names that the caller stores with it (contexts and receipts). */
  readonly artifacts: readonly { readonly id: ArtifactId; readonly bytes: Uint8Array }[];
}

/** Correlates a run's observations into findings, reading each cited span once. */
export async function findingsOf(
  observations: readonly ObservationEnvelope[],
  readContent: (id: ArtifactId) => Promise<Uint8Array>,
  options: NormalizeOptions = {},
): Promise<Finding[]> {
  const cache = new Map<string, Promise<Uint8Array>>();
  const normalized = [];
  for (const o of observations) normalized.push(await normalizeObservation(o, readContent, cache, options));
  return correlate(normalized);
}

function lineOf(bytes: Uint8Array, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < bytes.length; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

/**
 * Builds the `sentinel-report/draft-1` document. Findings are correlated from the observations (or taken from
 * `precomputed`), placed only through a pinned context bound to this run's snapshot and source, and their evidence is
 * embedded or withheld by the disclosure profile; a secret is always withheld (`sentinel.report.withheld.secret`).
 * Every planned check without complete coverage becomes a gap, every count carries its scope, and every catalog word
 * used travels with its definition. Throws `ReportError`: `sentinel.report.invalidInput` for an unknown profile, a
 * comparison that does not cover every finding or lacks a baseline summary, or coverage that is repeated or for an
 * unplanned check; `sentinel.report.invalidDocument` when the result does not validate against its contract.
 */
export async function buildReport(input: ReportInput, precomputed?: readonly Finding[]): Promise<ReportBuild> {
  if (!DISCLOSURE_PROFILES[input.disclosure])
    throw new ReportError('sentinel.report.invalidInput', 'unknown disclosure profile');
  const profile = DISCLOSURE_PROFILES[input.disclosure];
  const findings = precomputed ?? (await findingsOf(input.observations, input.readContent));
  const cache = new Map<string, Promise<Uint8Array>>();
  const read = (id: string) => {
    let p = cache.get(id);
    if (!p) cache.set(id, (p = input.readContent(id)));
    return p;
  };
  const used = new Set<string>();
  const artifacts = new Map<string, Uint8Array>();
  for (const [sourceId, ctx] of input.contexts ?? []) {
    if (contextProblem(ctx, { snapshotId: input.run.snapshotId, sourceId })) continue;
    if (ctx.artifact) artifacts.set(ctx.artifact.id, ctx.artifact.bytes);
    artifacts.set(ctx.receipt.id, ctx.receipt.bytes);
  }
  const outcomes = new Map(input.comparison?.result.current.map((o) => [o.findingId, o]) ?? []);

  const reportFindings: ReportFinding[] = [];
  for (const f of findings) {
    const sourceId = f.sourceIds[0]!;
    const ctx = f.sourceIds.length === 1 ? input.contexts?.get(sourceId) : undefined;
    const bound = f.observations.every(
      (o) =>
        o.snapshotId === input.run.snapshotId &&
        o.observation.evidence.every((e) => e.snapshotId === input.run.snapshotId && e.sourceId === sourceId),
    );
    // A secret finding is never placed: its symbols name the file it is in.
    const place = f.secret
      ? unplaced('unavailable', ['sentinel.place.secretWithheld'])
      : f.sourceIds.length > 1
        ? unplaced('unavailable', ['sentinel.place.noContext'])
        : !bound
          ? unplaced('mismatched', ['sentinel.place.contextMismatch'])
          : placeNodes(ctx, f.nodeIds, { snapshotId: input.run.snapshotId, sourceId });
    const evidence: ReportEvidence[] = [];
    const seen = new Set<string>();
    for (const o of f.observations) {
      for (const e of o.observation.evidence) {
        const where = 'location' in e ? `entry:${e.entry}` : `path:${e.relativePath}`;
        const key = `${e.sourceId}\u0000${where}\u0000${e.content}\u0000${e.span.startByte}\u0000${e.span.endByte}`;
        if (seen.has(key) || evidence.length >= MAX_EVIDENCE) continue;
        seen.add(key);
        const id = `ev.${digest(key).slice(7, 39)}`;
        // A secret, or a citation whose location the producer withheld, is never read, located or excerpted.
        if (f.secret || 'location' in e) {
          evidence.push({ id, state: 'withheld', reasonCode: 'sentinel.report.withheld.secret', content: e.content });
          used.add('sentinel.report.withheld.secret');
          continue;
        }
        const bytes = Buffer.from(await read(e.content));
        const start = Math.min(e.span.startByte, bytes.length),
          end = Math.min(e.span.endByte, bytes.length);
        const location = {
          relativePath: e.relativePath,
          startByte: start,
          endByte: Math.max(end, start + 1),
          startLine: lineOf(bytes, start),
          endLine: lineOf(bytes, Math.max(start, end - 1)),
        };
        if (!profile.embedSource) {
          evidence.push({
            id,
            state: 'withheld',
            reasonCode: 'sentinel.report.withheld.shareable',
            content: e.content,
            location,
          });
          used.add('sentinel.report.withheld.shareable');
        } else
          evidence.push({
            id,
            state: 'embedded',
            excerpt: bytes.subarray(start, end).toString('utf8').slice(0, MAX_EXCERPT_CHARS),
            content: e.content,
            location,
          });
      }
    }
    const words = input.rules?.get(f.ruleFamilyId);
    const firstLoc = f.secret ? undefined : evidence.find((e) => e.location)?.location;
    // Disclosure covers every field, not only evidence: a secret finding carries only the rule pack's words or fixed
    // ones, and a producer's message (untrusted text that can quote source or name a path) is shown only in a private
    // report of a finding that is not a secret.
    const title: RegisterText = f.secret
      ? (words?.title ?? { business: 'A possible secret the checks found', code: f.ruleFamilyId })
      : (words?.title ?? {
          business: `A ${f.severity === 'info' ? 'recorded' : f.severity} issue the checks found`,
          code: `${f.ruleFamilyId}${firstLoc ? ` at ${firstLoc.relativePath}:${firstLoc.startLine}` : ''}`,
        });
    const message = !f.secret && profile.embedSource ? f.observations.map((o) => o.observation.message)[0] : undefined;
    const explanation: RegisterText = {
      business: [
        words?.explanation.business,
        f.secret ? 'Where it is and what it says are withheld from every report.' : placeSentence(place),
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 4000),
      code: (words?.explanation.code ?? message ?? `${f.ruleFamilyId}: see the evidence locations.`).slice(0, 4000),
    };
    const outcome = outcomes.get(f.id);
    if (outcome) {
      used.add(outcome.reasonCode);
      used.add(labelKey(outcome.label));
    }
    for (const k of place.limitationKeys) used.add(k);
    reportFindings.push({
      id: f.id,
      observationIds: [...f.observationIds],
      ruleFamilyId: f.ruleFamilyId,
      severity: f.severity,
      title,
      explanation,
      place,
      ...(outcome
        ? {
            comparison: outcome.label,
            comparisonReason: outcome.reasonCode,
            ...(outcome.match
              ? { match: { kind: outcome.match.kind, baselineFindingIds: [...outcome.match.baselineFindingIds] } }
              : {}),
          }
        : {}),
      fingerprint: { ...f.fingerprint },
      evidence,
    });
  }
  if (input.comparison && reportFindings.some((f) => !f.comparison))
    throw new ReportError('sentinel.report.invalidInput', 'the comparison does not cover every finding');

  // Model observations: each cited span embedded under the same profile as a finding's, a withheld location never read
  // or located, and the model's statement only in a private report. Never a finding, never coverage.
  const reviews: ReportReviewObservation[] | undefined = input.reviews ? [] : undefined;
  for (const r of input.reviews ?? []) {
    const o = r.observation;
    if (o.producer.kind !== 'model-review' || o.snapshotId !== input.run.snapshotId)
      throw new ReportError(
        'sentinel.report.invalidInput',
        `observation ${o.id} is not a model review of this capture`,
      );
    const evidence: ReportEvidence[] = [];
    const seen = new Set<string>();
    for (const e of o.evidence) {
      const where = 'location' in e ? `entry:${e.entry}` : `path:${e.relativePath}`;
      const key = `${e.sourceId}\u0000${where}\u0000${e.content}\u0000${e.span.startByte}\u0000${e.span.endByte}`;
      if (seen.has(key) || evidence.length >= MAX_EVIDENCE || e.snapshotId !== input.run.snapshotId) continue;
      seen.add(key);
      const id = `ev.${digest(key).slice(7, 39)}`;
      if ('location' in e || input.withheldFiles?.has(`${e.sourceId}:${e.relativePath}`)) {
        evidence.push({ id, state: 'withheld', reasonCode: 'sentinel.report.withheld.secret', content: e.content });
        used.add('sentinel.report.withheld.secret');
        continue;
      }
      const bytes = Buffer.from(await read(e.content));
      const start = Math.min(e.span.startByte, bytes.length),
        end = Math.min(e.span.endByte, bytes.length);
      const location = {
        relativePath: e.relativePath,
        startByte: start,
        endByte: Math.max(end, start + 1),
        startLine: lineOf(bytes, start),
        endLine: lineOf(bytes, Math.max(start, end - 1)),
      };
      if (!profile.embedSource) {
        evidence.push({
          id,
          state: 'withheld',
          reasonCode: 'sentinel.report.withheld.shareable',
          content: e.content,
          location,
        });
        used.add('sentinel.report.withheld.shareable');
      } else
        evidence.push({
          id,
          state: 'embedded',
          excerpt: bytes.subarray(start, end).toString('utf8').slice(0, MAX_EXCERPT_CHARS),
          content: e.content,
          location,
        });
    }
    for (const k of o.limitationKeys) used.add(k);
    reviews!.push({
      id: o.id,
      stage: r.stage,
      unit: { id: r.unit.id, revision: r.unit.revision },
      attemptId: o.producer.attemptId,
      model: structuredClone(o.producer.model),
      promptDigest: o.producer.promptDigest,
      ruleFamilyId: o.rule?.familyId ?? null,
      severity: o.originalSeverity,
      ...(profile.embedSource ? { message: o.message } : {}),
      evidence,
      limitationKeys: [...o.limitationKeys],
    });
  }
  if (reviews) for (const key of ['heading', 'proposed', 'model', 'unrated']) used.add(`sentinel.report.review.${key}`);
  // A host interpreter's absolute path names this computer's folders (a home folder, a user name): private only.
  const provenance = input.provenance
    ? structuredClone([...input.provenance]).map((p) => {
        if (p.kind === 'script' && !profile.embedSource) delete p.interpreter.path;
        return p;
      })
    : undefined;
  if (provenance) {
    used.add('sentinel.report.provenance.heading');
    for (const p of provenance) {
      used.add(`sentinel.report.provenance.where.${p.where}`);
      if (p.kind === 'agent')
        used.add(`sentinel.report.provenance.cost.${p.cost.basis === 'rates' ? 'rates' : p.cost.reason}`);
    }
  }

  const historical: ReportHistoricalFinding[] = (input.comparison?.result.historical ?? []).map((h) => {
    const b = input.comparison!.baselineFindings.get(h.baselineFindingId);
    if (!b)
      throw new ReportError('sentinel.report.invalidInput', `baseline finding ${h.baselineFindingId} has no summary`);
    used.add(h.reasonCode);
    used.add(labelKey(h.label));
    const place = b.place ?? unplaced('unavailable', ['sentinel.place.noContext']);
    for (const k of place.limitationKeys) used.add(k);
    return {
      baselineFindingId: b.id,
      ruleFamilyId: b.ruleFamilyId,
      severity: b.severity,
      title: b.title,
      label: h.label,
      reasonCode: h.reasonCode,
      ...(h.match ? { match: { kind: h.match.kind, baselineFindingIds: [...h.match.baselineFindingIds] } } : {}),
      place,
    };
  });

  // Every planned check has exactly one coverage record; a planned check with none is a gap, never a silent pass.
  const planned = new Map(input.plannedChecks.map((p) => [p.checkId, p]));
  if (planned.size !== input.plannedChecks.length)
    throw new ReportError('sentinel.report.invalidInput', 'a planned check is listed twice');
  const recorded = new Map<string, CoverageEnvelope>();
  for (const c of input.coverage) {
    if (!planned.has(c.checkId))
      throw new ReportError('sentinel.report.invalidInput', `coverage for ${c.checkId}, which the plan does not hold`);
    if (recorded.has(c.checkId))
      throw new ReportError('sentinel.report.invalidInput', `two coverage records for ${c.checkId}`);
    recorded.set(c.checkId, c);
  }
  const gapPlace = (p: PlannedCheck, files: readonly string[]) => {
    const ctx = input.contexts?.get(p.sourceId);
    const placeable = files.filter((f) => !input.withheldFiles?.has(`${p.sourceId}:${f}`));
    return placeFiles(ctx, placeable, { snapshotId: input.run.snapshotId, sourceId: p.sourceId });
  };
  const gaps: ReportGap[] = [];
  for (const p of input.plannedChecks) {
    const c = recorded.get(p.checkId);
    if (c?.status === 'complete') continue;
    const status: ReportGap['status'] = c ? (c.status as ReportGap['status']) : 'not-run';
    const reasonCode = !c
      ? 'sentinel.report.gap.noCoverage'
      : c.basis.kind === 'unavailable'
        ? c.basis.reasonCode
        : `sentinel.report.gap.${camel(c.status)}`;
    used.add(reasonCode);
    const def = STRINGS[reasonCode];
    // A partial check is placed by the scopes it skipped; anything else by the whole scope it was planned over.
    const skipped =
      c?.skipped
        .map((x) => x.scopeId)
        .filter((x) => x.startsWith(`${p.sourceId}:`))
        .map((x) => x.slice(p.sourceId.length + 1)) ?? [];
    const place = gapPlace(p, c?.status === 'partial' && skipped.length ? skipped : p.files);
    for (const k of place.limitationKeys) used.add(k);
    gaps.push({
      checkId: p.checkId,
      status,
      reasonCode,
      explanation: {
        business: (def?.professional ?? reasonCode).slice(0, 4000),
        code: `${p.checkId}: ${c ? c.status : 'no coverage record'}${c?.skipped.length ? ` (${c.skipped.length} scopes skipped)` : ''}`.slice(
          0,
          4000,
        ),
      },
      place,
    });
  }

  const severityParts = SEVERITIES.map((s) => ({
    key: `sentinel.count.part.${s}`,
    n: reportFindings.filter((f) => f.severity === s).length,
  })).filter((p) => p.n);
  const rc = (n: number, unit: string, scope: string, extra: Partial<ReportCount> = {}): ReportCount => ({
    n,
    unit,
    scope,
    source: REPORT_SOURCE,
    ...extra,
  });
  const historicalParts = [...new Set(historical.map((h) => h.label))]
    .sort()
    .map((l) => ({ key: labelPartKey(l), n: historical.filter((h) => h.label === l).length }));
  const inspections = input.inspections?.length ? structuredClone([...input.inspections]) : undefined;
  const structuralPaths = input.structuralPaths?.length ? structuredClone([...input.structuralPaths]) : undefined;
  const queries = structuralPaths?.flatMap((p) => p.evidence.results) ?? [];
  if (structuralPaths) {
    for (const k of [
      'heading',
      'pinnedQuery',
      'queryLine',
      'stepLine',
      'reached',
      'notReachedComplete',
      'notReachedBounded',
    ])
      used.add(`sentinel.paths.report.${k}`);
    for (const p of structuralPaths) {
      used.add(p.limitationKey);
      for (const key of p.evidence.limitationKeys) used.add(key);
      for (const r of p.evidence.results) for (const key of r.frontierReasons) used.add(key);
    }
  }
  const answers = inspections?.flatMap((i) => i.rows) ?? [];
  if (inspections) {
    for (const key of [
      'reportHeading',
      'libraryLine',
      'versionItem',
      'checkLine',
      'answerLine',
      'frontierLine',
      'noVersion',
    ])
      used.add(`sentinel.controls.${key}`);
    for (const i of inspections) {
      used.add(i.limitationKey);
      for (const r of i.rows) if (r.reasonCode) used.add(r.reasonCode);
      for (const c of i.checks) for (const reason of c.reasons) used.add(reason);
      for (const f of i.frontiers) used.add(f.reasonCode);
    }
  }
  const counts: ReportEnvelope['counts'] = {
    findings: rc(reportFindings.length, 'sentinel.count.findings', 'sentinel.scope.report', {
      bizUnit: 'sentinel.count.issues',
      ...(severityParts.length ? { breakdown: severityParts } : {}),
    }),
    observations: rc(
      new Set(reportFindings.flatMap((f) => f.observationIds)).size,
      'sentinel.count.observations',
      'sentinel.scope.report',
    ),
    coverageGaps: rc(gaps.length, 'sentinel.count.gaps', 'sentinel.scope.report'),
    plannedChecks: rc(input.plannedChecks.length, 'sentinel.count.plannedChecks', 'sentinel.scope.report'),
    seenByNoStage: rc(input.inventory.seenByNoStage, 'sentinel.count.seenByNoStage', 'sentinel.scope.inventory', {
      of: input.inventory.included,
    }),
    unknownScopeBoundaries: rc(
      input.inventory.unknownScopeBoundaries,
      'sentinel.count.unknownBoundaries',
      'sentinel.scope.inventory',
    ),
    ...(structuralPaths
      ? {
          pathQueries: rc(queries.length, 'sentinel.paths.count.queries', 'sentinel.scope.report', {
            recheck: { cli: `farsight-sentinel report ${input.run.id} --full --format json` },
            breakdown: ['reached', 'not-reached-complete', 'not-reached-bounded'].map((outcome) => ({
              key: `sentinel.paths.count.${camel(outcome)}`,
              n: queries.filter((q) => q.outcome === outcome).length,
            })),
          }),
        }
      : {}),
    ...(inspections
      ? {
          controlAnswers: rc(answers.length, 'sentinel.count.controlAnswers', 'sentinel.scope.report', {
            recheck: { cli: `farsight-sentinel report ${input.run.id} --json` },
            breakdown: ['established', 'partial', 'not-run'].map((state) => ({
              key: `sentinel.count.control.${state === 'not-run' ? 'notRun' : state}`,
              n: answers.filter((r) => r.state === state).length,
            })),
          }),
        }
      : {}),
    ...(reviews
      ? {
          reviewObservations: rc(reviews.length, 'sentinel.count.reviewObservations', 'sentinel.scope.report', {
            recheck: { cli: `farsight-sentinel report ${input.run.id} --full --format json` },
          }),
        }
      : {}),
    ...(input.comparison
      ? {
          historical: rc(
            historical.length,
            'sentinel.count.historical',
            'sentinel.scope.report',
            historicalParts.length ? { breakdown: historicalParts } : {},
          ),
        }
      : {}),
  };
  const countKeys = (c: ReportCount) => [
    c.unit,
    c.scope,
    ...(c.bizUnit ? [c.bizUnit] : []),
    ...(c.breakdown ?? []).map((p) => p.key),
  ];
  for (const c of Object.values(counts)) if (c) for (const k of countKeys(c)) used.add(k);
  for (const f of reportFindings)
    for (const c of Object.values(f.place.counts)) for (const k of countKeys(c)) used.add(k);
  for (const g of gaps) for (const c of Object.values(g.place.counts)) for (const k of countKeys(c)) used.add(k);
  for (const h of historical) for (const c of Object.values(h.place.counts)) for (const k of countKeys(c)) used.add(k);
  for (const s of SEVERITIES) used.add(`sentinel.report.severity.${s}`);

  // A unit's singular form travels with it, defined by its plural's definition.
  for (const key of [...used]) if (STRINGS[`${key}One`]?.singularOf === key) used.add(`${key}One`);
  const definitions: ReportDefinition[] = [...used].sort().flatMap((key) => {
    const e = STRINGS[key];
    const define = e?.define ?? (e?.singularOf ? STRINGS[e.singularOf]?.define : undefined);
    return e && define
      ? [
          {
            key,
            text: { business: e.professional.slice(0, 4000), code: e.hud.slice(0, 4000) },
            define: define.slice(0, 4000),
          },
        ]
      : [];
  });
  const closure = new Set<string>([...artifacts.keys()]);
  for (const f of reportFindings) {
    for (const e of f.evidence) closure.add(e.content);
    if (f.place.context) {
      closure.add(f.place.context.artifact);
      closure.add(f.place.context.sourceBindingReceipt);
    }
  }
  for (const g of gaps)
    if (g.place.context) {
      closure.add(g.place.context.artifact);
      closure.add(g.place.context.sourceBindingReceipt);
    }
  for (const r of reviews ?? []) for (const e of r.evidence) closure.add(e.content);
  for (const i of inspections ?? []) {
    closure.add(i.artifact);
    for (const id of Object.values(i.analysis)) closure.add(id);
  }
  for (const p of structuralPaths ?? []) {
    closure.add(p.artifact);
    closure.add(p.request);
    closure.add(p.job);
    for (const r of p.evidence.results)
      for (const path of r.paths)
        for (const step of path.steps) for (const site of step.sites) closure.add(site.content);
  }
  const document: ReportEnvelope = {
    schema: 'sentinel-report/draft-1',
    id: input.id,
    run: input.run,
    ledgerSequence: input.ledgerSequence,
    evaluatedAt: input.evaluatedAt,
    catalogVersion: input.catalogVersion,
    disclosure: {
      profile: input.disclosure,
      profileDigest: digest({ profile: input.disclosure, rules: DISCLOSURE_PROFILES[input.disclosure] }),
    },
    // Complete only when every planned check covered its scope and every captured file was seen and listed.
    completeness:
      gaps.length || input.inventory.seenByNoStage > 0 || input.inventory.unknownScopeBoundaries > 0
        ? 'partial'
        : 'complete',
    baseline: input.comparison ? { reportId: input.comparison.baselineReportId } : null,
    counts,
    findings: reportFindings,
    gaps,
    decisions: [],
    ...(inspections ? { inspections } : {}),
    ...(structuralPaths ? { structuralPaths } : {}),
    ...(input.comparison ? { historical } : {}),
    ...(reviews ? { reviews } : {}),
    ...(provenance ? { provenance } : {}),
    definitions,
    artifactClosure: [...closure].sort(),
  };
  const valid = validateEnvelope('report', document);
  if (!valid.ok)
    throw new ReportError(
      'sentinel.report.invalidDocument',
      `the report does not fit its contract: ${valid.errors[0]?.code} at ${valid.errors[0]?.path}: ${valid.errors[0]?.message}`,
    );
  return {
    document: valid.value as ReportEnvelope,
    findings,
    artifacts: [...artifacts].map(([id, bytes]) => ({ id, bytes })),
  };
}

const others = (n: number) => (n <= 0 ? '' : n === 1 ? ' and 1 other screen' : ` and ${n} other screens`);

/** One business sentence about where a finding sits, from the same place fold. */
function placeSentence(p: FindingPlace): string {
  if (p.binding !== 'matched') return 'It could not be placed on a screen of the application.';
  const direct = p.screens.filter((s) => s.via === 'direct-use');
  const journeyOf = (id: string) => p.journeys.find((j) => j.screenIds.includes(id))?.label.business;
  if (direct.length) {
    const s = direct[0]!;
    const j = journeyOf(s.id);
    return `It is used directly by the ${s.label.business} screen${j ? ` in the ${j} journey` : ''}${others(direct.length - 1)}.`;
  }
  if (p.screens.length)
    return `It may affect the ${p.screens[0]!.label.business} screen${others(p.screens.length - 1)} through code that depends on it.`;
  return 'It is not on any screen the application context names.';
}
