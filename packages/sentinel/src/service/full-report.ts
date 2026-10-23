// The full report of a completed scanner run (PR 19 over the PR 09 command path, ADR 38). Everything comes from the
// run's own ledger: the exact admitted analysis plan, the accepted publication of each of its work units, the
// bootstrap's retained snapshot and parser index. A scanner's finding becomes an observation only when its accepted
// record is bound to this run, snapshot, unit and attempt and each location it cites is a captured file the unit was
// assigned, with exactly those bytes; a span is checked against the bytes, never taken on the record's word. Nothing
// is read from the workspace, a report file or another product: no stored JSON is authority for a finding, a
// coverage verdict or a comparison, which are recomputed from accepted evidence every time.
//
// Placement is optional and owner-confirmed: an application graph the owner supplies is pinned (reports/context.ts)
// only with the owner's spent `context.pin` receipt and only when it binds to the captured bytes; its inputs are the
// files as they are on disk now, so a graph made after the source changed does not bind.
import { acceptedPaths } from './path-report.js';
import type { ReportStructuralPaths } from '../contracts/report.js';
import { createHash, createHmac } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, CoverageEnvelope, ObservationEnvelope, PlanCheck, PlanWork, SnapshotEnvelope, ReportControlInspection } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import type { SentinelStore } from '../store/index.js';
import { loadPlan } from '../execution/plans.js';
import { retainedBootstrapForReport, type RetainedAncestorRevision } from '../execution/retained-bootstrap.js';
import type { ParserIndex, ParserResult } from '../snapshot/parser.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_FINDINGS_SCHEMA, PREVIEW_RULE } from '../adapters/preview-detector.js';
import { secretObservation } from '../reports/accepted-secrets.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { resolveWithheldLocation } from '../snapshot/locations.js';
import type { WithheldLocationEvidence } from '../contracts/index.js';
import { compareAssessments, type CheckAssessment, type Comparison } from '../findings/compare.js';
import type { Finding } from '../findings/correlate.js';
import {
  buildReport, contextPinIntent, findingsOf, pinApplicationContext, renderHtml, renderMarkdown, toSarif,
  type BaselineFindingSummary, type ContextGraph, type DisclosureProfile, type PinnedContext, type PlannedCheck,
} from '../reports/index.js';
import { canonicalJson } from '@farsight/graph';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { RuleLockBook } from './rule-locks.js';
import { acceptedInspection } from './inspection-report.js';
import { ReportKeyError, withheldLocationKey } from './report-key.js';

/** The scanner adapters whose accepted records this report reads, and the preview detector's own findings. */
const SECRETS_ADAPTER = 'secrets-gitleaks';
const SCANNER_ADAPTERS = new Set(['pattern-semgrep', 'advisories-osv', 'iac-trivy', 'ci-zizmor', SECRETS_ADAPTER]);
const FINDING_SCHEMA = 'sentinel-driver-finding/draft-1';
const COVERAGE_SCHEMA = 'sentinel-coverage/draft-1';
const DRIVER_REPORT_SCHEMA = 'sentinel-driver-report/draft-1';
export const REPORT_FORMATS = ['md', 'json', 'html', 'sarif'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
/** The largest application graph a context pin reads. */
export const MAX_CONTEXT_BYTES = 64 * 1024 * 1024;

export class FullReportError extends Error {
  constructor(readonly code: 'sentinel.report.runNotReportable' | 'sentinel.report.evidenceUnbound' | 'sentinel.report.contextInvalid' | 'sentinel.report.outExists',
    readonly facts: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = 'FullReportError';
  }
}

const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const unbound = (reason: string): never => { throw new FullReportError('sentinel.report.evidenceUnbound', { reason }); };
const isRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fileScope = (sourceId: string, path: string) => `${sourceId}:${path}`;

/** One run's accepted evidence, read and checked: what a report and a comparison are built from. */
export interface RunAssessment {
  readonly runId: string;
  readonly planRevision: number;
  readonly snapshot: SnapshotEnvelope;
  readonly checks: readonly PlanCheck[];
  readonly units: readonly PlanWork[];
  readonly observations: readonly ObservationEnvelope[];
  readonly inspections: readonly ReportControlInspection[];
  readonly structuralPaths: readonly ReportStructuralPaths[];
  readonly coverage: readonly CoverageEnvelope[];
  readonly plannedChecks: readonly PlannedCheck[];
  readonly inventory: { readonly included: number; readonly seenByNoStage: number; readonly unknownScopeBoundaries: number };
  readonly analyses: readonly { readonly sourceId: string; readonly result: ParserResult; readonly index: ParserIndex }[];
  /** Detection conditions per rule family, from the admitted plan and profile. */
  readonly conditions: ReadonlyMap<string, CheckAssessment['conditions']>;
  readonly ledgerSequence: number;
  readonly ruleLock: unknown;
  /**
   * The opaque, store-keyed identity of a withheld citation's file: stable across this store's captures, never its path.
   * Identical bytes in two files are two keys. Keyed by the store's own secret, never the public store id.
   */
  readonly withheldKey: (e: WithheldLocationEvidence) => string;
  /** Files (`sourceId:relativePath`) whose name the secret scan matched: never printed or used to place anything. */
  readonly withheldFiles: ReadonlySet<string>;
  /**
   * The candidates the secret scan's matched text yields (tokensOf), read from the private snapshot and held in memory
   * only. Diagnostic: the report does not depend on them; a run with any secret match withholds all source and context
   * text instead (withholdSecretRun).
   */
  readonly secretTokens: ReadonlySet<string>;
  /** Same-snapshot selected ancestors, proven through their exact admitted selection edges; privacy only. */
  readonly selectedAncestors: readonly RetainedAncestorRevision[];
}

function lastSequence(store: SentinelStore, runId: string): number {
  let sequence = 0;
  for (let after = 0; ;) {
    const page = store.ledger.readEvents({ runId, after, limit: 500 });
    for (const e of page.events) sequence = e.sequence;
    if (!page.more) return sequence;
    after = page.cursor;
  }
}

/** The innermost parser-index node over these exact bytes whose span contains the cited span. */
function nodeAt(index: ParserIndex | undefined, path: string, content: string, span: { startByte: number; endByte: number }): string | undefined {
  let best: { id: string; size: number } | undefined;
  for (const n of index?.nodes ?? []) {
    if (n.path !== path || n.content !== content || !n.byteSpan) continue;
    if (n.byteSpan.startByte > span.startByte || n.byteSpan.endByte < span.endByte) continue;
    const size = n.byteSpan.endByte - n.byteSpan.startByte;
    if (!best || size < best.size) best = { id: n.nodeId, size };
  }
  return best?.id;
}

/** UTF-8 byte offsets of 1-based inclusive lines `start..end` in `bytes`. */
function lineSpan(bytes: Uint8Array, start: number, end: number): { startByte: number; endByte: number } | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return undefined;
  let line = 1, s = -1, e = bytes.length;
  if (start === 1) s = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    line++;
    if (line === start && s < 0) s = i + 1;
    if (line === end + 1) { e = i; break; }
  }
  return s < 0 || s > e || line < end ? undefined : { startByte: s, endByte: Math.max(e, s) };
}

/**
 * Reads one completed run's accepted evidence. Refuses a run that is not a completed analysis, and any accepted
 * record that names another run, snapshot, unit or attempt, or cites bytes the unit was not assigned.
 */
export async function assessRun(store: SentinelStore, runId: string, options: { trustDir?: string } = {}): Promise<RunAssessment> {
  const run = store.ledger.getRun(runId);
  if (!run || run.state !== 'completed') throw new FullReportError('sentinel.report.runNotReportable', { runId, state: run?.state ?? null });
  const admitted = await loadPlan(store, runId, run.planRevision);
  const plan = admitted.plan;
  if (plan.kind !== 'analysis' || !plan.pins.snapshotId) throw new FullReportError('sentinel.report.runNotReportable', { runId, reason: 'not an analysis' });
  const evidence = await retainedBootstrapForReport(store, runId, admitted).catch(() => unbound('the retained bootstrap lineage or its accepted evidence is unbound'));
  const snapshot = evidence.snapshot;
  if (snapshot.id !== plan.pins.snapshotId) unbound('the bootstrap snapshot is not the plan\'s');
  const captured = new Map<string, { content: string; bytes: number }>();
  for (const e of snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') captured.set(fileScope(e.sourceId, e.relativePath), { content: e.content, bytes: e.bytes });
  const indexOf = new Map(evidence.analyses.map(a => [a.sourceId, a.index]));
  const read = new Map<string, Promise<Buffer>>();
  const bytesOf = (id: string) => { let p = read.get(id); if (!p) read.set(id, p = store.readArtifact(id as never)); return p; };
  const checkOf = new Map(plan.checks.map(c => [c.id, c]));
  const pinOf = (familyId: string, revision: number) => plan.pins.rules.find(r => r.familyId === familyId && r.revision === revision);
  const adapterDigest = (id: string) => admitted.profile.adapters.find((a: { adapterId: string }) => a.adapterId === id)?.digest;
  // A rule's own severity, from the exact packs the admitted lock names (a scanner that reports none is judged by it).
  const severityOf = new Map<string, string>();
  for (const [familyId, d] of ruleDefinitions(options.trustDir, admitted.ruleLock)) severityOf.set(familyId, d.severity);

  // Files whose name the secret scan matched: a path that may hold a secret is never printed, in any profile.
  const nameWithheld = new Set<string>();
  const secretTokens = new Set<string>();
  const entryIndex = new Map<string, number>();
  snapshot.entries.forEach((e, i) => { if (e.kind === 'file' && e.disposition === 'included') entryIndex.set(fileScope(e.sourceId, e.relativePath), i); });
  // The key is the store's own secret, read only when a withheld citation needs one: a run with no secret evidence
  // reports without the owner's trust folder.
  let key: Buffer | undefined;
  const keyOf = () => {
    if (key) return key;
    if (!options.trustDir) return unbound('a withheld citation needs the owner\'s report key');
    try { return (key = withheldLocationKey(options.trustDir, store.storeId)); } catch (e) {
      if (e instanceof ReportKeyError) return unbound(e.reason);
      throw e;
    }
  };
  const locationKeyOf = withheldKeyFor(keyOf, snapshot);

  const coverage: CoverageEnvelope[] = [];
  const observations: ObservationEnvelope[] = [];
  const inspections: ReportControlInspection[] = [];
  const unitChecks = new Map(plan.units.map(u => [u.id, new Set(u.checks)]));
  for (const unit of plan.units) {
    const pub = store.ledger.getPublication({ id: unit.id, revision: unit.revision });
    if (!pub) continue;
    if (unit.adapterId === 'framework-controls') inspections.push(await acceptedInspection(store, admitted, unit, evidence, unbound));
    const assigned = new Map(unit.inputs.map(i => [fileScope(i.sourceId, i.relativePath), i.content]));
    // Resolve a finding's claim through the admitted check, never through an independently supplied family pin.
    const assignedCheck = (id: string) => {
      const check = checkOf.get(id);
      const pin = check && pinOf(check.familyId, check.ruleRevision);
      if (!check || !pin || check.state !== 'planned' || !unit.checks.includes(id)
        || check.unit?.id !== unit.id || check.unit.revision !== unit.revision || check.sourceId !== unit.sourceId
        || pin.adapterId !== unit.adapterId || !unit.scopes.includes(check.scopeId)) return unbound('a finding has no exact admitted check');
      return { check, pin };
    };
    // A citation is evidence only of bytes this unit was assigned and the capture holds under that path.
    const cite = async (sourceId: string, path: string, content: string | null, span: { startByte: number; endByte: number } | 'file' | { lines: [number, number] }) => {
      const key = fileScope(sourceId, path);
      // Reasons never name the path: it may be one the secret scan withholds.
      if (content === null || assigned.get(key) !== content || captured.get(key)?.content !== content) return unbound('a citation is not assigned captured bytes');
      const bytes = await bytesOf(content);
      if (sha(bytes) !== content) unbound('a captured artifact is not its bytes');
      const s = span === 'file' ? { startByte: 0, endByte: bytes.length }
        : 'lines' in span ? (lineSpan(bytes, span.lines[0], span.lines[1]) ?? unbound('cited lines outside the captured file'))
          : span;
      if (!Number.isSafeInteger(s.startByte) || !Number.isSafeInteger(s.endByte) || s.startByte < 0 || s.endByte < s.startByte || s.endByte > bytes.length) unbound('a span outside the captured file');
      const nodeId = nodeAt(indexOf.get(sourceId), path, content, s);
      return { snapshotId: snapshot.id, sourceId, relativePath: path, content: content as ArtifactId, span: { startByte: s.startByte, endByte: s.endByte }, ...(nodeId ? { nodeId } : {}) };
    };
    // A scanner unit's own report states how many findings it accepted; the publication must hold exactly that many, so
    // a dropped or added finding record refuses the report rather than reading as fewer (or more) findings.
    let findingRecords = 0;
    const driverReports: number[] = [];
    let previewDocuments = 0;
    for (const output of pub.outputs) {
      if (output.schema !== COVERAGE_SCHEMA && output.schema !== FINDING_SCHEMA && output.schema !== PREVIEW_FINDINGS_SCHEMA && output.schema !== DRIVER_REPORT_SCHEMA && output.schema !== 'application/json') continue;
      let value: any;
      try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await store.readArtifact(output.id as never))); }
      catch { return unbound('accepted report evidence is unavailable or is not UTF-8 JSON'); }
      if (!isRecord(value)) unbound('accepted report evidence is not an object');
      if (output.schema === COVERAGE_SCHEMA) {
        if (value?.runId !== runId || value.workId !== unit.id || value.workRevision !== unit.revision || value.basis?.kind !== 'executed' || value.basis.attemptId !== pub.attemptId) unbound('accepted coverage is bound to another unit or attempt');
        if (!unitChecks.get(unit.id)!.has(value.checkId)) unbound('accepted coverage names a check its unit was not assigned');
        const valid = validateEnvelope('coverage', value);
        if (!valid.ok) return unbound(`accepted coverage does not fit its contract: ${valid.errors[0]?.path}`);
        coverage.push(valid.value as CoverageEnvelope);
        continue;
      }
      if (output.schema === DRIVER_REPORT_SCHEMA) {
        if (!unit.adapterId || (!SCANNER_ADAPTERS.has(unit.adapterId) && unit.adapterId !== 'framework-controls') || value.runId !== runId || value.work?.id !== unit.id || value.work?.revision !== unit.revision
          || value.attemptId !== pub.attemptId || !Number.isSafeInteger(value.findings) || value.findings < 0) unbound('an accepted scanner report is bound to another unit or attempt');
        driverReports.push(value.findings);
        continue;
      }
      if (output.schema === FINDING_SCHEMA) {
        findingRecords++;
        if (!unit.adapterId || !SCANNER_ADAPTERS.has(unit.adapterId)) unbound('a scanner finding from a unit no scanner ran');
        // A secret-scan record is read only as one, from a unit the secret scanner ran; nothing else is read as one.
        if ((unit.adapterId === SECRETS_ADAPTER) !== (value.kind === 'secret')) unbound('an accepted finding has another adapter kind');
        if (unit.adapterId === SECRETS_ADAPTER) {
          const secret = await secretObservation(value, { unit, attemptId: pub.attemptId, runId, snapshot, assignedCheck, adapterDigest: adapterDigest(SECRETS_ADAPTER), bytesOf, severityOf, refuse: unbound, observation, tokensOf });
          observations.push(secret.observation);
          for (const path of secret.names) nameWithheld.add(path);
          for (const token of secret.tokens) secretTokens.add(token);
          continue;
        }
        if (value?.runId !== runId || value.snapshotId !== snapshot.id || value.work?.id !== unit.id || value.work?.revision !== unit.revision || value.attemptId !== pub.attemptId
          || value.sourceId !== unit.sourceId || value.adapter !== unit.adapterId) unbound('an accepted finding is bound to another run, unit or attempt');
        observations.push(...await scannerObservations(value, unit, pub.attemptId, pub.acceptedAt, cite, assignedCheck, adapterDigest(unit.adapterId!), severityOf));
        continue;
      }
      // The preview detector's own findings document (its checks are the unit's), when this unit ran it.
      if (value?.schema !== PREVIEW_FINDINGS_SCHEMA) {
        if (output.schema === PREVIEW_FINDINGS_SCHEMA) unbound('accepted preview evidence does not fit its declared schema');
        continue;
      }
      if (unit.adapterId !== PREVIEW_DETECTOR_ID) unbound('preview findings from a unit the preview detector did not run');
      if (++previewDocuments !== 1) unbound('an accepted preview unit has multiple findings documents');
      if (value.detector !== PREVIEW_DETECTOR_ID || value.rule !== PREVIEW_RULE || !Array.isArray(value.checks)
        || !Array.isArray(value.scopes) || canonicalJson([...value.scopes].sort()) !== canonicalJson([...unit.scopes].sort())) unbound('accepted preview findings do not identify their detector and scopes');
      if (canonicalJson([...value.checks].sort()) !== canonicalJson([...unit.checks].sort())) unbound('preview findings for other checks');
      if (!Array.isArray(value.findings) || unit.checks.length !== 1) unbound('preview findings without their exact check');
      for (const f of value.findings) {
        const { check, pin } = assignedCheck(unit.checks[0]!);
        if (!isRecord(f) || f.rule !== PREVIEW_RULE || typeof f.path !== 'string' || !Number.isSafeInteger(f.line)) unbound('a preview finding without its check');
        const ev = await cite(unit.sourceId!, f.path, f.input, { lines: [f.line, f.line] });
        if (check.scopeId !== fileScope(ev.sourceId, ev.relativePath)) unbound('a preview finding is outside its admitted check scope');
        observations.push(observation({
          schema: 'sentinel-observation/draft-1', id: `obs.${sha(canonicalJson({ unit: unit.id, path: f.path, line: f.line, rule: f.rule })).slice(7, 39)}`, snapshotId: snapshot.id,
          producer: { kind: 'scanner', adapterId: PREVIEW_DETECTOR_ID, adapterDigest: adapterDigest(PREVIEW_DETECTOR_ID)!, attemptId: pub.attemptId },
          producerRuleId: String(f.rule), rule: { familyId: pin!.familyId, revisionDigest: pin!.definitionDigest }, originalSeverity: severityOf.get(pin!.familyId) ?? 'unspecified',
          message: `${pin!.familyId}: SQL text assembled from strings (foundation preview)`, evidence: [ev], limitationKeys: ['sentinel.report.previewOnly'], observedAt: pub.acceptedAt,
        }));
      }
    }
    if (unit.adapterId && SCANNER_ADAPTERS.has(unit.adapterId) && (driverReports.length !== 1 || driverReports[0] !== findingRecords)) {
      unbound('a scanner unit\'s accepted findings do not match its own report');
    }
    // Raw scanner JSON and other auxiliary documents are not findings. The preview producer, however, always
    // publishes its one findings document, even when its genuine result is empty or skipped.
    if (unit.adapterId === PREVIEW_DETECTOR_ID && previewDocuments !== 1) unbound('an accepted preview unit has no findings document');
  }

  // A citation by another scanner of a file whose name the secret scan matched is withheld the same way: by its capture
  // entry, never its path or a symbol (a symbol id names its file). Decided from the run's own evidence, so every
  // profile and every rendering of this run withholds it alike.
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i]!;
    if (!o.evidence.some(e => !('location' in e) && nameWithheld.has(fileScope(e.sourceId, e.relativePath)))) continue;
    observations[i] = observation({ ...o, evidence: o.evidence.map(e => {
      if ('location' in e || !nameWithheld.has(fileScope(e.sourceId, e.relativePath))) return e;
      return { location: 'withheld' as const, snapshotId: e.snapshotId, sourceId: e.sourceId, entry: entryIndex.get(fileScope(e.sourceId, e.relativePath))!, content: e.content, span: e.span };
    }) });
  }

  // Every planned check, with the captured files it was to cover (a gap is placed by them).
  const unitOf = new Map(plan.units.map(u => [u.id, u]));
  const nodePath = new Map<string, string>();
  for (const a of evidence.analyses) for (const n of a.index.nodes) nodePath.set(n.nodeId, n.path);
  const plannedChecks: PlannedCheck[] = plan.checks.map(c => {
    const prefix = `${c.sourceId}:`;
    const files = c.scopeId.startsWith(prefix) && captured.has(c.scopeId) ? [c.scopeId.slice(prefix.length)]
      : nodePath.has(c.scopeId) ? [nodePath.get(c.scopeId)!]
        : (c.unit ? unitOf.get(c.unit.id)?.inputs.filter(i => i.sourceId === c.sourceId).map(i => i.relativePath) ?? [] : []);
    return { checkId: c.id, sourceId: c.sourceId, files: [...new Set(files)].sort() };
  });
  // Files captured that no check was planned over, and folders capture could not list.
  const scoped = new Set<string>();
  for (const p of plannedChecks) for (const f of p.files) scoped.add(fileScope(p.sourceId, f));
  // A gap is placed by its files' symbols; a withheld name is not used to place anything.
  for (const p of plannedChecks) (p as unknown as { files: string[] }).files = p.files.filter(f => !nameWithheld.has(fileScope(p.sourceId, f)));
  const inventory = {
    included: captured.size,
    seenByNoStage: [...captured.keys()].filter(k => !scoped.has(k)).length,
    unknownScopeBoundaries: snapshot.entries.filter(e => e.kind === 'directory-boundary' && e.disposition !== 'excluded').length,
  };
  // The conditions a check of each rule family ran under: the rule revision, the engine, what it was trusted to
  // establish, and the environment and limits. Equal across runs only when nothing that changes detection changed.
  const conditions = new Map<string, CheckAssessment['conditions']>();
  for (const c of plan.checks) {
    const pin = pinOf(c.familyId, c.ruleRevision);
    const adapterId = pin?.adapterId ?? '';
    conditions.set(c.familyId, {
      ruleRevision: pin?.definitionDigest ?? `revision ${c.ruleRevision}`,
      engine: `${adapterId}@${adapterDigest(adapterId) ?? 'unregistered'}${plan.pins.tools.filter(t => t.adapterId === adapterId).map(t => `@${t.artifactDigest}`).join('')}`,
      capabilities: sha(canonicalJson(admitted.profile.capabilities.filter((f: { adapterId: string }) => f.adapterId === adapterId))),
      environment: c.environment,
      relevantLimits: sha(canonicalJson({ resources: admitted.profile.resources, databases: plan.pins.databases })),
    });
  }
  const structuralPaths:ReportStructuralPaths[]=[];
  for(const unit of plan.units.filter(u=>u.adapterId==='bounded-paths'))if(store.ledger.getPublication(unit))structuralPaths.push(await acceptedPaths(store,admitted,unit,unbound));
  return {
    runId, planRevision: run.planRevision, snapshot, checks: plan.checks, units: plan.units, observations, inspections, structuralPaths, coverage, plannedChecks, inventory,
    analyses: evidence.analyses, conditions, ledgerSequence: lastSequence(store, runId), ruleLock: admitted.ruleLock,
    withheldKey: e => locationKeyOf(e), withheldFiles: nameWithheld, secretTokens, selectedAncestors: evidence.selectedAncestors,
  };
}

/**
 * Candidates cut at a value's own boundaries (quotes, assignment, separators, paths) are kept from 3 characters: a
 * supported detector can match a short value (curl's `user:pass`, measured at 7 characters). 3 is not a proved minimum
 * for every supported detector. Runs of letters and
 * digits split out of longer text are kept only from 8, since shorter runs are ordinary words rather than a value.
 */
const MIN_BOUNDED = 3;
const MIN_RUN = 8;

/**
 * Candidate strings a matched line or name yields (quoted strings, assignment right-hand sides, pieces at common
 * separators, runs of letters and digits), held in memory only. Diagnostic: a report does not depend on them, because
 * the scanner reports whole lines and no such heuristic is proved complete; a run with any secret match withholds all
 * source and context text instead (withholdSecretRun).
 */
export function tokensOf(text: string): string[] {
  const out = new Set<string>();
  const add = (t: string, min = MIN_BOUNDED) => { const v = t.trim(); if (v.length >= min) out.add(v); };
  add(text);
  for (const m of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) add(m[1] ?? m[2] ?? m[3] ?? '');
  // The right-hand side of the first assignment, unquoted values included (`key=a:b:c`, `key=base64==`), up to a
  // trailing comment, without a trailing comma or surrounding quotes.
  const rhs = /^[^=:]*[=:]\s*(.*)$/.exec(text.trim())?.[1];
  if (rhs !== undefined) {
    const value = rhs.replace(/\s+#.*$/, '').replace(/[,;]\s*$/, '').trim();
    add(value); add(value.replace(/^["'`](.*)["'`]$/, '$1')); add(value.split(/\s+/)[0] ?? '');
  }
  for (const t of text.split(/[\s"'`]+/)) add(t);
  // A path's segments, with and without a final extension: a matched name is withheld wherever it appears alone.
  for (const t of text.split(/[\s"'`/\\@]+/)) { add(t); add(t.replace(/\.[A-Za-z0-9]{1,8}$/, '')); }
  for (const t of text.split(/[\s"'`=,;#(){}\[\]<>]+/)) add(t);
  for (const t of text.split(/[^A-Za-z0-9]+/)) add(t, MIN_RUN);
  return [...out];
}

/**
 * The positions in a report document whose value Sentinel itself generates and the contract constrains: the schema,
 * enums, catalog keys, digests, content and artifact ids, generated run, check, finding, evidence, observation and
 * report ids, counts' words, decisions and the catalog's definitions. Trust is by position in the contract, never by a
 * key's name or a value's spelling: a context-owned id or label is screened however it is spelled, and so is anything
 * a confirmed graph or captured source supplies (titles, explanations, excerpts, paths, node ids, screen, journey and
 * persona ids, labels and references, count part labels).
 */
const PLACE = String.raw`(?:findings|gaps|historical)\.\*\.place`;
const COUNT = String.raw`(?:unit|bizUnit|scope|source|breakdown\.\*\.key|recheck\.cli|recheck\.mcp|n|of|breakdown\.\*\.n)`;
const TRUSTED = new RegExp('^(?:' + [
  String.raw`schema|id|run\.(?:id|snapshotId|planRevision)|ledgerSequence|evaluatedAt|catalogVersion`,
  String.raw`disclosure\.(?:profile|profileDigest)|completeness|baseline\.reportId|artifactClosure\.\*`,
  // Exact scalar paths only: a later field added to either (a disposition's rationale, say) is screened until it is
  // listed here on purpose. Definitions are the catalog's own words (document.ts); a decision's fields are generated.
  String.raw`definitions\.\*\.(?:key|define|text\.business|text\.code)`,
  String.raw`decisions\.\*\.(?:dispositionId|findingId|validity|expiresAt)`,
  String.raw`counts\.[A-Za-z]+\.` + COUNT,
  String.raw`findings\.\*\.(?:id|observationIds\.\*|ruleFamilyId|severity|comparison|comparisonReason|match\.kind|match\.baselineFindingIds\.\*|fingerprint\.(?:version|exact|probable))`,
  String.raw`findings\.\*\.evidence\.\*\.(?:id|state|reasonCode|content|location\.(?:startByte|endByte|startLine|endLine))`,
  String.raw`gaps\.\*\.(?:checkId|status|reasonCode)`,
  // Fixed generated structure only. Surface/source ids, versions, scope ids and fact ids remain untrusted text.
  String.raw`inspections\.\*\.(?:artifact|attemptId|assessment|recognised|extent|limitationKey|work\.(?:id|revision)|analysis\.(?:result|index|artifact|manifest))`,
  String.raw`inspections\.\*\.libraries\.\*\.(?:framework|packDigest|ran|reasonCode|envelopes|supportedScope\.properties\.\*)`,
  String.raw`inspections\.\*\.rows\.\*\.(?:property|state|verdict|reasonCode|claims\.\*\.(?:framework|verdict))`,
  String.raw`inspections\.\*\.checks\.\*\.(?:checkId|familyId|state|reasons\.\*)`,
  String.raw`inspections\.\*\.frontiers\.\*\.reasonCode`,
  // Fixed structural-query vocabulary and content identities only; node/edge/source/site text is withheld.
  String.raw`structuralPaths\.\*\.(?:artifact|attemptId|request|job|limitationKey|statementKey|detailLoss|work\.(?:id|revision)|ancestor\.(?:runId|revision|planDigest))`,
  String.raw`structuralPaths\.\*\.evidence\.(?:schema|analysisFingerprint|graphDigest|boundsDigest|establishes|limitationKeys\.\*|producer\.(?:implementation|digest)|bounds\.edgeKinds\.\*)`,
  String.raw`structuralPaths\.\*\.evidence\.results\.\*\.(?:outcome|frontierReasons\.\*|paths\.\*\.(?:id|steps\.\*\.(?:kind|resolution)))`,
  String.raw`structuralPaths\.\*\.evidence\.frontiers\.\*\.reasonCode`,
  String.raw`historical\.\*\.(?:baselineFindingId|ruleFamilyId|severity|label|reasonCode|match\.kind|match\.baselineFindingIds\.\*)`,
  PLACE + String.raw`\.(?:binding|limitationKeys\.\*|context\.(?:artifact|sourceBindingReceipt|projectionVersion))`,
  PLACE + String.raw`\.counts\.[A-Za-z]+\.` + COUNT,
  PLACE + String.raw`\.screens\.\*\.(?:via|evidenceArtifact)`,
  PLACE + String.raw`\.personas\.\*\.(?:declared|evidenceArtifact)`,
].join('|') + ')$');

/** The catalog key a report carries when it withholds source and context text because the secret scan matched. */
export const SECRET_RUN_WITHHELD = 'sentinel.report.withheld.secretRun';
/** Positions rebuilt from trusted words only, in a projection that withholds source and context text. */
const REBUILT = /^(?:findings\.\*\.(?:title|explanation)\.(?:business|code)|historical\.\*\.title\.(?:business|code)|gaps\.\*\.explanation\.(?:business|code))$/;

/**
 * The fail-closed projection of a report whose run (or baseline) has accepted secret-scan matches. The scanner reports
 * whole matched lines, not the value's exact bytes, so no text a captured file or a confirmed graph supplied can be
 * proved free of a matched value; instead of screening it by heuristic, all of it is withheld:
 * - every finding's title and explanation are rebuilt from the rule pack's catalog words only (or fixed words), and a
 *   gap's explanation is already catalog words and generated facts;
 * - every evidence item is withheld with no excerpt and no location (a path is source text);
 * - every other source- or context-controlled string (context ids, labels and references, node ids, count part
 *   labels) becomes one opaque word per distinct original, so references still match and placement keeps its shape;
 * - every place records the limitation, and its definition travels with the report.
 * Generated structure (TRUSTED) is kept, so the document keeps its contract; the caller validates it again.
 */
export function withholdSecretRun(input: any, words: ReadonlyMap<string, { title: { business: string; code: string }; explanation: { business: string; code: string } }>): any {
  const doc = structuredClone(input);
  for(const section of doc.structuralPaths??[]){section.detailLoss=SECRET_RUN_WITHHELD;for(const r of section.evidence.results)for(const p of r.paths)for(const step of p.steps)step.sites=[];}
  const fixed = STRINGS[SECRET_RUN_WITHHELD]!;
  const generic = (severity: string) => `A ${severity === 'info' ? 'recorded' : severity} issue the checks found`;
  const places: any[] = [];
  for (const f of doc.findings ?? []) {
    const w = words.get(f.ruleFamilyId);
    f.title = { business: (w?.title.business ?? generic(f.severity)).slice(0, 4000), code: (w?.title.code ?? f.ruleFamilyId).slice(0, 4000) };
    f.explanation = { business: [w?.explanation.business, fixed.professional].filter(Boolean).join(' ').slice(0, 4000), code: (w?.explanation.code || f.ruleFamilyId).slice(0, 4000) };
    f.evidence = f.evidence.map((e: any) => (e.state === 'withheld' && e.reasonCode === 'sentinel.report.withheld.secret'
      ? { id: e.id, state: 'withheld', reasonCode: e.reasonCode, content: e.content }
      : { id: e.id, state: 'withheld', reasonCode: SECRET_RUN_WITHHELD, content: e.content }));
    places.push(f.place);
  }
  for (const h of doc.historical ?? []) {
    const w = words.get(h.ruleFamilyId);
    h.title = { business: (w?.title.business ?? generic(h.severity)).slice(0, 4000), code: (w?.title.code ?? h.ruleFamilyId).slice(0, 4000) };
    places.push(h.place);
  }
  for (const g of doc.gaps ?? []) places.push(g.place);
  for (const place of places) place.limitationKeys = [...new Set([...place.limitationKeys, SECRET_RUN_WITHHELD])].sort();
  const opaque = new Map<string, string>();
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      if (TRUSTED.test(path) || REBUILT.test(path)) return v;
      let w = opaque.get(v);
      if (!w) opaque.set(v, w = `withheld-${opaque.size + 1}`);
      return w;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, path ? `${path}.*` : '*'));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]));
    return v;
  };
  const out: any = walk(doc, '');
  if (!(out.definitions ?? []).some((d: any) => d.key === SECRET_RUN_WITHHELD)) {
    out.definitions = [...(out.definitions ?? []), { key: SECRET_RUN_WITHHELD, text: { business: fixed.professional, code: fixed.hud }, define: fixed.define ?? '' }]
      .sort((a: any, b: any) => (a.key < b.key ? -1 : 1));
  }
  return out;
}

/**
 * The opaque key of a withheld citation's file: an HMAC of its source and path under the store's own secret key
 * (report-key.ts), never the public store id. The same file in any capture of this store has the same key, so a
 * comparison can continue a secret finding; without the secret, neither a report nor a bundle, nor both together
 * with the store id, lets anyone confirm a guessed path. A reference that does not resolve in this snapshot refuses.
 */
function withheldKeyFor(key: () => Buffer, snapshot: SnapshotEnvelope): (e: WithheldLocationEvidence) => string {
  return e => {
    const resolved = resolveWithheldLocation(snapshot, e);
    if (!resolved.ok) return unbound('a withheld citation does not resolve in the captured snapshot');
    return `loc.${createHmac('sha256', key()).update('sentinel-withheld-location/2\u0000').update(`${resolved.entry.sourceId}\u0000${resolved.entry.relativePath}`).digest('hex').slice(0, 32)}`;
  };
}

/**
 * One accepted secret-scan record, read as exactly the observation the secret scanner may make: bound to this run,
 * snapshot, unit, attempt and adapter; assigned exactly the unit's admitted checks; a known detector; the fixed
 * redacted message and limitations; and only withheld citations, each resolving in the private snapshot to a captured
 * file this unit was assigned, with a span inside those bytes (a name match cites no span). Its rule family is the
 * admitted check's. Anything else refuses the report: a malformed or foreign record is never read as zero findings.
 */

function observation(o: ObservationEnvelope): ObservationEnvelope {
  const valid = validateEnvelope('observation', o);
  if (!valid.ok) return unbound(`an observation does not fit its contract: ${valid.errors[0]?.path} ${valid.errors[0]?.message}`);
  return valid.value as ObservationEnvelope;
}

type Cite = (sourceId: string, path: string, content: string | null, span: { startByte: number; endByte: number } | 'file' | { lines: [number, number] }) => Promise<any>;

/** One observation per rule family a scanner finding was assigned to, citing only assigned captured bytes. */
async function scannerObservations(f: any, unit: PlanWork, attemptId: string, observedAt: string, cite: Cite,
  assignedCheck: (id: string) => { check: PlanCheck; pin: { familyId: string; definitionDigest: string } }, adapterDigest: string | undefined,
  severityOf: ReadonlyMap<string, string>): Promise<ObservationEnvelope[]> {
  const src = unit.sourceId!;
  const kinds: Record<string, string> = { 'pattern-semgrep': 'pattern', 'advisories-osv': 'advisory', 'iac-trivy': 'misconfiguration', 'ci-zizmor': 'ci-audit' };
  if (kinds[unit.adapterId!] !== f.kind) unbound('an accepted finding has another adapter kind');
  if (!Array.isArray(f.assignedChecks) || !f.assignedChecks.length || f.assignedChecks.length > unit.checks.length) unbound('a finding without assigned checks');
  const seen = new Set<string>();
  const assigned = f.assignedChecks.map((claim: any) => {
    if (!isRecord(claim) || typeof claim.id !== 'string' || seen.has(claim.id)) return unbound('a finding repeats or omits an assigned check');
    seen.add(claim.id);
    const resolved = assignedCheck(claim.id);
    if (claim.familyId !== resolved.check.familyId || claim.revision !== resolved.check.ruleRevision
      || (f.kind === 'pattern' && (f.familyId !== claim.familyId || f.revision !== claim.revision))) unbound('a finding changes its admitted check tuple');
    return resolved;
  });
  const evidence: any[] = [];
  let producerRuleId: string, severity: string, message: string;
  switch (f.kind) {
    case 'pattern':
      producerRuleId = String(f.familyId);
      severity = 'unspecified';
      message = `${f.familyId}: ${f.evidence?.kind === 'local-taint' ? 'untrusted input reaches a sink in the same file' : 'the pattern matched'}`;
      evidence.push(await cite(src, f.relativePath, f.artifact, { startByte: f.span?.startByte, endByte: f.span?.endByte }));
      break;
    case 'ci-audit':
      producerRuleId = String(f.audit);
      severity = String(f.severity ?? 'unspecified').toLowerCase();
      message = `zizmor ${f.audit} (${String(f.confidence ?? 'unknown')} confidence)`;
      for (const l of [f.primary, ...(f.related ?? [])]) evidence.push(await cite(src, l.relativePath, l.artifact, { startByte: l.span?.startByte, endByte: l.span?.endByte }));
      break;
    case 'misconfiguration': {
      producerRuleId = String(f.checkId);
      severity = String(f.severity ?? 'unspecified').toLowerCase();
      message = `${f.checkId} (${f.configType})`;
      if (f.artifact === null) {
        // A whole Terraform module folder: cited by each assigned captured file under it.
        for (const i of unit.inputs) if (i.sourceId === src && (f.relativePath === '.' || i.relativePath.startsWith(`${f.relativePath}/`))) evidence.push(await cite(src, i.relativePath, i.content, 'file'));
      } else evidence.push(await cite(src, f.relativePath, f.artifact, f.lines ? { lines: [f.lines.start, f.lines.end] } : 'file'));
      break;
    }
    default: {
      if (!Array.isArray(f.occurrences)) unbound('an accepted finding of an unknown kind');
      producerRuleId = String(f.advisories?.ids?.[0] ?? f.key);
      severity = 'unspecified';
      message = `${f.ecosystem} ${f.name}@${f.version}: ${(f.advisories?.ids ?? []).slice(0, 8).join(', ')} (${f.certainty})`;
      for (const o of f.occurrences) evidence.push(await cite(src, o.relativePath, o.artifact, 'file'));
    }
  }
  if (!evidence.length) unbound('an accepted finding cites nothing');
  const out: ObservationEnvelope[] = [];
  // These scanner drivers admit exact file scopes. Unknown or wider scope strings do not prove a citation belongs
  // to a check. Each observation cites only that check's scope; correlated findings can still combine occurrences.
  const within = (check: PlanCheck, e: any) => check.sourceId === e.sourceId && check.scopeId === fileScope(e.sourceId, e.relativePath);
  if (evidence.some(e => !assigned.some(({ check }: { check: PlanCheck }) => within(check, e)))) unbound('a finding cites bytes outside its assigned checks');
  for (const { check, pin } of assigned) {
    const scopedEvidence = evidence.filter(e => within(check, e));
    if (!scopedEvidence.length) unbound('a finding is outside its admitted check scope');
    out.push(observation({
      schema: 'sentinel-observation/draft-1', id: `obs.${sha(canonicalJson({ finding: f.id, check: check.id })).slice(7, 39)}`, snapshotId: f.snapshotId,
      producer: { kind: 'scanner', adapterId: unit.adapterId!, adapterDigest: adapterDigest as never, attemptId },
      producerRuleId: producerRuleId.slice(0, 256), rule: { familyId: pin!.familyId, revisionDigest: pin!.definitionDigest as never },
      originalSeverity: (severity === 'unspecified' ? severityOf.get(pin!.familyId) ?? severity : severity).slice(0, 200), message: message.slice(0, 4000), evidence: scopedEvidence.slice(0, 256), limitationKeys: [], observedAt,
    } as ObservationEnvelope));
  }
  return out;
}

/** The rule definitions of the packs the run's admitted lock names, read from the owner's held packs. */
function ruleDefinitions(trustDir: string | undefined, lock: any): Map<string, { severity: string; titleKey: string }> {
  const out = new Map<string, { severity: string; titleKey: string }>();
  if (!trustDir || !lock?.packs) return out;
  const book = new RuleLockBook(trustDir);
  for (const p of lock.packs) {
    let pack;
    try { pack = book.readPack(p.packDigest); } catch { continue; }
    for (const r of pack.manifest.rules) out.set(r.familyId, { severity: r.severity, titleKey: r.titleKey });
  }
  return out;
}

/** The rule families' words, from the catalog entries their definitions name. */
function ruleWords(trustDir: string | undefined, lock: any): Map<string, { title: { business: string; code: string }; explanation: { business: string; code: string } }> {
  const words = new Map();
  for (const [familyId, d] of ruleDefinitions(trustDir, lock)) {
    const e = STRINGS[d.titleKey];
    if (!e) continue;
    const define = (e.define ?? '').slice(0, 4000);
    words.set(familyId, { title: { business: e.professional.slice(0, 4000), code: e.hud.slice(0, 4000) }, explanation: { business: define, code: define } });
  }
  return words;
}

/** Everything a comparison needs of one side, from its accepted evidence. */
async function sideOf(store: SentinelStore, a: RunAssessment) {
  const findings = await findingsOf(a.observations, id => store.readArtifact(id as never), { withheldKey: a.withheldKey });
  const byFamily = new Map<string, { status: CheckAssessment['status']; files: Set<string> }>();
  const coverageOf = new Map(a.coverage.map(c => [c.checkId, c]));
  const files = new Map(a.plannedChecks.map(p => [p.checkId, p]));
  for (const c of a.checks) {
    const s = byFamily.get(c.familyId) ?? { status: 'complete' as CheckAssessment['status'], files: new Set<string>() };
    const record = coverageOf.get(c.id);
    if (record?.status === 'complete') for (const f of files.get(c.id)?.files ?? []) s.files.add(fileScope(c.sourceId, f));
    // A check with no coverage record did not run: the family's assessment is not complete.
    else s.status = record ? record.status : 'not-run';
    byFamily.set(c.familyId, s);
  }
  const checks: CheckAssessment[] = [...byFamily].map(([ruleFamilyId, s]) => ({ ruleFamilyId, status: s.status, files: s.files, conditions: a.conditions.get(ruleFamilyId)! }));
  return { findings, checks };
}

export interface ContextFile {
  /** The application graph file the owner supplies: an object with `nodes` and `edges` (Farsight's graph.json). */
  readonly path: string;
  /** The repository name its node locations use; inferred when the graph locates nodes under one name only. */
  readonly repo?: string;
}

export interface FullReportRequest {
  readonly store: SentinelStore;
  readonly runId: string;
  readonly workspace: string;
  readonly trustDir?: string;
  readonly disclosure: DisclosureProfile;
  readonly baselineRunId?: string;
  readonly now: Date;
  readonly context?: { readonly graph: ContextGraph; readonly repo: string; readonly authorization?: unknown };
}

/** One bounded regular descriptor. A FIFO cannot block open; links, short reads and a changing file are refused. */
function readRegularBounded(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('not a bounded regular file');
    const bytes = Buffer.alloc(Number(before.size));
    for (let off = 0; off < bytes.length;) {
      const n = readSync(fd, bytes, off, bytes.length - off, off);
      if (!n) throw new Error('short read');
      off += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error('file changed');
    return bytes;
  } finally { closeSync(fd); }
}

/** Reads an owner-supplied graph file, bounded, and the repository name its nodes use. */
export function readContextGraph(file: ContextFile): { graph: ContextGraph; repo: string } {
  let text: string;
  try { text = new TextDecoder('utf8', { fatal: true }).decode(readRegularBounded(file.path, MAX_CONTEXT_BYTES)); }
  catch { throw new FullReportError('sentinel.report.contextInvalid', { reason: 'not a readable regular UTF-8 file within the size bound' }); }
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new FullReportError('sentinel.report.contextInvalid', { reason: 'not JSON' }); }
  if (!isRecord(v) || !Array.isArray(v.nodes) || !Array.isArray(v.edges)) throw new FullReportError('sentinel.report.contextInvalid', { reason: 'no nodes and edges' });
  const repos = new Set<string>();
  for (const n of v.nodes) if (isRecord(n) && isRecord(n.loc) && typeof n.loc.repo === 'string') repos.add(n.loc.repo);
  const repo = file.repo ?? (repos.size === 1 ? [...repos][0] : undefined);
  if (!repo) throw new FullReportError('sentinel.report.contextInvalid', { reason: 'name the repository with --repo', repos: [...repos].slice(0, 16) });
  return { graph: { nodes: v.nodes, edges: v.edges, ...(isRecord(v.meta) ? { meta: v.meta } : {}) } as ContextGraph, repo };
}

/**
 * The inputs a supplied graph is pinned against: every captured included file of the source, with the content id of
 * its bytes on disk now (absent when the file is gone). A graph made from the tree as it is now binds only when the
 * tree still holds the captured bytes.
 */
export function workspaceInputs(snapshot: SnapshotEnvelope, sourceId: string, root: string): { relativePath: string; content: string }[] {
  const out: { relativePath: string; content: string }[] = [];
  for (const e of snapshot.entries) {
    if (e.sourceId !== sourceId || e.kind !== 'file' || e.disposition !== 'included') continue;
    // Current bytes can only confirm this capture when their hash matches. Never read past its captured size. Check every
    // folder as well: replacing a captured parent with a link must not read a different tree. As in capture,
    // identity checks detect swaps between observations, not a swap restored between those checks.
    try {
      const parts = e.relativePath.split('/');
      if (parts.some(p => !p || p === '.' || p === '..') || e.relativePath.includes('\\')) continue;
      const folders = [root, ...parts.slice(0, -1).map((_, i) => join(root, ...parts.slice(0, i + 1)))];
      const chain = folders.map(path => ({ path, stat: lstatSync(path, { bigint: true }) }));
      if (chain.some(d => !d.stat.isDirectory() || d.stat.isSymbolicLink())) continue;
      const bytes = readRegularBounded(join(root, e.relativePath), e.bytes);
      if (chain.some(d => {
        const after = lstatSync(d.path, { bigint: true });
        return !after.isDirectory() || after.isSymbolicLink() || after.dev !== d.stat.dev || after.ino !== d.stat.ino;
      })) continue;
      out.push({ relativePath: e.relativePath, content: sha(bytes) });
    } catch { /* unreadable, replaced or outside the captured bound now: not an input */ }
  }
  return out;
}

/** The exact owner intent that pins this graph for this run's snapshot and source. */
export function contextIntentFor(snapshot: SnapshotEnvelope, sourceId: string, root: string, graph: ContextGraph, repo: string) {
  const inputs = workspaceInputs(snapshot, sourceId, root);
  return { inputs, intent: contextPinIntent({ snapshot, sourceId, repo, graph, inputs })! };
}

export interface FullReport {
  readonly document: any;
  readonly json: string;
  readonly markdown: string;
  readonly html: string;
  readonly sarif: unknown;
  readonly comparison?: Comparison;
  readonly context: { readonly binding: PinnedContext['binding']; readonly reasons: readonly string[] } | null;
  /** The run, its baseline or a proven same-capture selected ancestor has accepted secret matches. */
  readonly withheldForSecrets: boolean;
}

/**
 * Privacy knowledge survives holding Gitleaks in a selected child. Ancestors come only from reportBootstrap's proven
 * same-capture selection chain, never an arbitrary parent id or a store-wide search. Their observations are checked
 * by the existing reader and used only as a withholding flag, never as the child's findings, coverage or comparison.
 */
async function knownSecretMatches(store: SentinelStore, assessment: RunAssessment): Promise<boolean> {
  if (assessment.observations.some(o => o.producer.kind === 'scanner' && o.producer.adapterId === SECRETS_ADAPTER)) return true;
  const admitted = await loadPlan(store, assessment.runId, assessment.planRevision);
  try { return (await selectedSecretPrivacy(store, assessment.runId, admitted)).hasMatches; }
  catch { return unbound('accepted selected-ancestor privacy evidence is unavailable, malformed or unbound'); }
}

/** Builds the full report of a completed run, optionally placed and compared, from accepted evidence alone. */
export async function fullReport(req: FullReportRequest): Promise<FullReport> {
  const { store, runId, now } = req;
  const current = await assessRun(store, runId, { trustDir: req.trustDir });
  const sourceIds = [...new Set(current.snapshot.entries.map(e => e.sourceId))];
  let pinned: PinnedContext | undefined;
  if (req.context) {
    const sourceId = sourceIds.length === 1 ? sourceIds[0]! : 'workspace';
    const { inputs } = contextIntentFor(current.snapshot, sourceId, req.workspace, req.context.graph, req.context.repo);
    pinned = pinApplicationContext({ snapshot: current.snapshot, sourceId, repo: req.context.repo, graph: req.context.graph, inputs,
      producer: { tool: 'owner-supplied application graph', version: 'unknown' }, authorization: req.context.authorization });
  }
  const contexts = pinned ? new Map([[pinned.sourceId, pinned]]) : undefined;
  const readContent = (id: string) => store.readArtifact(id as never);
  let comparison: { baselineReportId: string; result: Comparison; baselineFindings: Map<string, BaselineFindingSummary> } | undefined;
  let currentFindings: readonly Finding[] | undefined;
  let baselineSecret: boolean | undefined;
  if (req.baselineRunId) {
    const baseline = await assessRun(store, req.baselineRunId, { trustDir: req.trustDir });
    baselineSecret = await knownSecretMatches(store, baseline);
    const b = await sideOf(store, baseline);
    const c = await sideOf(store, current);
    currentFindings = c.findings;
    const analysed = new Set<string>();
    const nodeIds = new Set<string>();
    for (const a of current.analyses) {
      for (const e of a.result.entries) if (e.class === 'parsed') analysed.add(fileScope(a.sourceId, e.path));
      for (const n of a.index.nodes) nodeIds.add(n.nodeId);
    }
    const files = new Set<string>();
    for (const e of current.snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') files.add(fileScope(e.sourceId, e.relativePath));
    const unknownScope = current.snapshot.entries.filter(e => e.kind === 'directory-boundary' && e.disposition !== 'excluded').map(e => `${fileScope(e.sourceId, e.relativePath)}/`);
    const result = compareAssessments({ baseline: b, current: { ...c, surfaces: { files, unknownScope, graph: { nodeIds, analysedFiles: analysed } } } });
    const words = ruleWords(req.trustDir, baseline.ruleLock);
    const baselineFindings = new Map<string, BaselineFindingSummary>(b.findings.map(f => [f.id, {
      id: f.id, ruleFamilyId: f.ruleFamilyId, severity: f.severity,
      title: words.get(f.ruleFamilyId)?.title ?? { business: `A ${f.severity === 'info' ? 'recorded' : f.severity} issue the checks found`, code: f.ruleFamilyId },
    }]));
    comparison = { baselineReportId: reportIdOf(req.baselineRunId), result, baselineFindings };
  }
  const build = await buildReport({
    id: reportIdOf(runId, req.baselineRunId), run: { id: runId, snapshotId: current.snapshot.id, planRevision: current.planRevision },
    ledgerSequence: current.ledgerSequence, evaluatedAt: now.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z'), catalogVersion: 'draft-1',
    disclosure: req.disclosure, inspections: current.inspections, structuralPaths:current.structuralPaths, observations: current.observations, coverage: current.coverage, plannedChecks: current.plannedChecks,
    inventory: current.inventory, readContent, withheldFiles: current.withheldFiles, ...(contexts ? { contexts } : {}), rules: ruleWords(req.trustDir, current.ruleLock),
    ...(comparison ? { comparison } : {}),
  }, currentFindings ?? await findingsOf(current.observations, readContent, { withheldKey: current.withheldKey }));
  // Accepted secret matches in either run or its proven same-capture selected ancestry make every source/context
  // string unproved (the scanner reports whole lines), so all of it is withheld. Clean ancestry keeps normal detail.
  const secretRun = (baselineSecret ?? false) || await knownSecretMatches(store, current);
  const doc = secretRun ? withholdSecretRun(build.document, ruleWords(req.trustDir, current.ruleLock)) : build.document;
  const valid = validateEnvelope('report', doc);
  if (!valid.ok) throw new FullReportError('sentinel.report.evidenceUnbound', { reason: 'the withheld report does not fit its contract' });
  return {
    withheldForSecrets: secretRun,
    document: doc, json: canonicalJson(doc), markdown: renderMarkdown(doc), html: renderHtml(doc), sarif: toSarif(doc),
    ...(comparison ? { comparison: comparison.result } : {}),
    context: pinned ? { binding: pinned.binding, reasons: [...pinned.reasons] } : null,
  };
}

export const reportIdOf = (runId: string, baselineRunId?: string) =>
  baselineRunId ? `report.${sha(`${runId}\u0000${baselineRunId}`).slice(7, 39)}` : `report.${sha(runId).slice(7, 39)}`;

/** The rendering of one format. */
export function renderingOf(r: FullReport, format: ReportFormat): string {
  return format === 'md' ? r.markdown : format === 'html' ? r.html : format === 'sarif' ? `${JSON.stringify(r.sarif, null, 2)}\n` : `${r.json}\n`;
}

/** Writes a report to a new file, never over an existing one: owner-private (0600). */
export function writeNewFile(path: string, text: string): void {
  let fd: number;
  try { fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new FullReportError('sentinel.report.outExists', { path });
    throw e;
  }
  try {
    const bytes = Buffer.from(text, 'utf8');
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
  } finally { closeSync(fd); }
}
