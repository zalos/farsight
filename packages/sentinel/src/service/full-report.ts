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
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, existsSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, CoverageEnvelope, ObservationEnvelope, PlanCheck, PlanWork, SnapshotEnvelope } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import type { SentinelStore } from '../store/index.js';
import { loadPlan } from '../execution/plans.js';
import { loadBootstrap } from '../execution/bootstrap.js';
import type { ParserIndex, ParserResult } from '../snapshot/parser.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_FINDINGS_SCHEMA } from '../adapters/preview-detector.js';
import { compareAssessments, type CheckAssessment, type Comparison } from '../findings/compare.js';
import type { Finding } from '../findings/correlate.js';
import {
  buildReport, contextPinIntent, findingsOf, pinApplicationContext, renderHtml, renderMarkdown, toSarif,
  type BaselineFindingSummary, type ContextGraph, type DisclosureProfile, type PinnedContext, type PlannedCheck,
} from '../reports/index.js';
import { canonicalJson } from '@farsight/graph';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { RuleLockBook } from './rule-locks.js';

/** The scanner adapters whose accepted records this report reads, and the preview detector's own findings. */
const SCANNER_ADAPTERS = new Set(['pattern-semgrep', 'advisories-osv', 'iac-trivy', 'ci-zizmor']);
const FINDING_SCHEMA = 'sentinel-driver-finding/draft-1';
const COVERAGE_SCHEMA = 'sentinel-coverage/draft-1';
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
  readonly coverage: readonly CoverageEnvelope[];
  readonly plannedChecks: readonly PlannedCheck[];
  readonly inventory: { readonly included: number; readonly seenByNoStage: number; readonly unknownScopeBoundaries: number };
  readonly analyses: readonly { readonly sourceId: string; readonly result: ParserResult; readonly index: ParserIndex }[];
  /** Detection conditions per rule family, from the admitted plan and profile. */
  readonly conditions: ReadonlyMap<string, CheckAssessment['conditions']>;
  readonly ledgerSequence: number;
  readonly ruleLock: unknown;
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
  let line = 1, s = -1, e = bytes.length;
  if (start === 1) s = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    line++;
    if (line === start && s < 0) s = i + 1;
    if (line === end + 1) { e = i; break; }
  }
  return s < 0 || s > e ? undefined : { startByte: s, endByte: Math.max(e, s) };
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
  const boot = (await loadPlan(store, runId, 1)).plan;
  const inventoryUnit = boot.units.find(u => u.stage === 'inventory');
  if (!inventoryUnit) throw new FullReportError('sentinel.report.runNotReportable', { runId, reason: 'no inventory' });
  const evidence = await loadBootstrap(store, runId, { id: inventoryUnit.id, revision: inventoryUnit.revision });
  const snapshot = evidence.snapshot;
  if (snapshot.id !== plan.pins.snapshotId) unbound('the bootstrap snapshot is not the plan\'s');
  const captured = new Map<string, { content: string; bytes: number }>();
  for (const e of snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') captured.set(fileScope(e.sourceId, e.relativePath), { content: e.content, bytes: e.bytes });
  const indexOf = new Map(evidence.analyses.map(a => [a.sourceId, a.index]));
  const read = new Map<string, Promise<Buffer>>();
  const bytesOf = (id: string) => { let p = read.get(id); if (!p) read.set(id, p = store.readArtifact(id as never)); return p; };
  const pinOf = (familyId: string, revision: number) => plan.pins.rules.find(r => r.familyId === familyId && r.revision === revision);
  const adapterDigest = (id: string) => admitted.profile.adapters.find((a: { adapterId: string }) => a.adapterId === id)?.digest;
  // A rule's own severity, from the exact packs the admitted lock names (a scanner that reports none is judged by it).
  const severityOf = new Map<string, string>();
  for (const [familyId, d] of ruleDefinitions(options.trustDir, admitted.ruleLock)) severityOf.set(familyId, d.severity);

  const coverage: CoverageEnvelope[] = [];
  const observations: ObservationEnvelope[] = [];
  const unitChecks = new Map(plan.units.map(u => [u.id, new Set(u.checks)]));
  for (const unit of plan.units) {
    const pub = store.ledger.getPublication({ id: unit.id, revision: unit.revision });
    if (!pub) continue;
    const assigned = new Map(unit.inputs.map(i => [fileScope(i.sourceId, i.relativePath), i.content]));
    // A citation is evidence only of bytes this unit was assigned and the capture holds under that path.
    const cite = async (sourceId: string, path: string, content: string | null, span: { startByte: number; endByte: number } | 'file' | { lines: [number, number] }) => {
      const key = fileScope(sourceId, path);
      if (content === null || assigned.get(key) !== content || captured.get(key)?.content !== content) return unbound(`${path} is not assigned captured bytes`);
      const bytes = await bytesOf(content);
      if (sha(bytes) !== content) unbound('a captured artifact is not its bytes');
      const s = span === 'file' ? { startByte: 0, endByte: bytes.length }
        : 'lines' in span ? (lineSpan(bytes, span.lines[0], span.lines[1]) ?? unbound(`lines outside ${path}`))
          : span;
      if (!Number.isSafeInteger(s.startByte) || !Number.isSafeInteger(s.endByte) || s.startByte < 0 || s.endByte < s.startByte || s.endByte > bytes.length) unbound(`a span outside ${path}`);
      const nodeId = nodeAt(indexOf.get(sourceId), path, content, s);
      return { snapshotId: snapshot.id, sourceId, relativePath: path, content: content as ArtifactId, span: { startByte: s.startByte, endByte: s.endByte }, ...(nodeId ? { nodeId } : {}) };
    };
    for (const output of pub.outputs) {
      if (output.schema !== COVERAGE_SCHEMA && output.schema !== FINDING_SCHEMA && output.schema !== PREVIEW_FINDINGS_SCHEMA && output.schema !== 'application/json') continue;
      let value: any;
      try { value = JSON.parse((await store.readArtifact(output.id as never)).toString('utf8')); } catch { continue; }
      if (output.schema === COVERAGE_SCHEMA) {
        if (value?.runId !== runId || value.workId !== unit.id || value.workRevision !== unit.revision || value.basis?.kind !== 'executed' || value.basis.attemptId !== pub.attemptId) unbound('accepted coverage is bound to another unit or attempt');
        if (!unitChecks.get(unit.id)!.has(value.checkId)) unbound('accepted coverage names a check its unit was not assigned');
        const valid = validateEnvelope('coverage', value);
        if (!valid.ok) return unbound(`accepted coverage does not fit its contract: ${valid.errors[0]?.path}`);
        coverage.push(valid.value as CoverageEnvelope);
        continue;
      }
      if (output.schema === FINDING_SCHEMA) {
        if (!unit.adapterId || !SCANNER_ADAPTERS.has(unit.adapterId)) unbound('a scanner finding from a unit no scanner ran');
        if (value?.runId !== runId || value.snapshotId !== snapshot.id || value.work?.id !== unit.id || value.work?.revision !== unit.revision || value.attemptId !== pub.attemptId
          || value.sourceId !== unit.sourceId || value.adapter !== unit.adapterId) unbound('an accepted finding is bound to another run, unit or attempt');
        observations.push(...await scannerObservations(value, unit, pub.attemptId, pub.acceptedAt, cite, pinOf, adapterDigest(unit.adapterId!), severityOf));
        continue;
      }
      // The preview detector's own findings document (its checks are the unit's), when this unit ran it.
      if (value?.schema !== PREVIEW_FINDINGS_SCHEMA) continue;
      if (unit.adapterId !== PREVIEW_DETECTOR_ID) unbound('preview findings from a unit the preview detector did not run');
      if (canonicalJson([...(value.checks ?? [])].sort()) !== canonicalJson([...unit.checks].sort())) unbound('preview findings for other checks');
      for (const f of value.findings ?? []) {
        const check = plan.checks.find(c => c.id === unit.checks[0]);
        const pin = check ? pinOf(check.familyId, check.ruleRevision) : undefined;
        if (!check || !pin || !isRecord(f) || typeof f.path !== 'string' || !Number.isSafeInteger(f.line)) unbound('a preview finding without its check');
        const ev = await cite(unit.sourceId!, f.path, f.input, { lines: [f.line, f.line] });
        observations.push(observation({
          schema: 'sentinel-observation/draft-1', id: `obs.${sha(canonicalJson({ unit: unit.id, path: f.path, line: f.line, rule: f.rule })).slice(7, 39)}`, snapshotId: snapshot.id,
          producer: { kind: 'scanner', adapterId: PREVIEW_DETECTOR_ID, adapterDigest: adapterDigest(PREVIEW_DETECTOR_ID)!, attemptId: pub.attemptId },
          producerRuleId: String(f.rule), rule: { familyId: pin!.familyId, revisionDigest: pin!.definitionDigest }, originalSeverity: severityOf.get(pin!.familyId) ?? 'unspecified',
          message: `${pin!.familyId}: SQL text assembled from strings (foundation preview)`, evidence: [ev], limitationKeys: ['sentinel.report.previewOnly'], observedAt: pub.acceptedAt,
        }));
      }
    }
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
  return {
    runId, planRevision: run.planRevision, snapshot, checks: plan.checks, units: plan.units, observations, coverage, plannedChecks, inventory,
    analyses: evidence.analyses, conditions, ledgerSequence: lastSequence(store, runId), ruleLock: admitted.ruleLock,
  };
}

function observation(o: ObservationEnvelope): ObservationEnvelope {
  const valid = validateEnvelope('observation', o);
  if (!valid.ok) return unbound(`an observation does not fit its contract: ${valid.errors[0]?.path} ${valid.errors[0]?.message}`);
  return valid.value as ObservationEnvelope;
}

type Cite = (sourceId: string, path: string, content: string | null, span: { startByte: number; endByte: number } | 'file' | { lines: [number, number] }) => Promise<any>;

/** One observation per rule family a scanner finding was assigned to, citing only assigned captured bytes. */
async function scannerObservations(f: any, unit: PlanWork, attemptId: string, observedAt: string, cite: Cite,
  pinOf: (familyId: string, revision: number) => { familyId: string; definitionDigest: string } | undefined, adapterDigest: string | undefined,
  severityOf: ReadonlyMap<string, string>): Promise<ObservationEnvelope[]> {
  const src = unit.sourceId!;
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
  for (const check of f.assignedChecks ?? []) {
    const pin = pinOf(check.familyId, check.revision);
    if (!pin || !unit.checks.includes(check.id)) unbound('a finding assigned to a check its unit was not given');
    out.push(observation({
      schema: 'sentinel-observation/draft-1', id: `obs.${sha(canonicalJson({ finding: f.id, check: check.id })).slice(7, 39)}`, snapshotId: f.snapshotId,
      producer: { kind: 'scanner', adapterId: unit.adapterId!, adapterDigest: adapterDigest as never, attemptId },
      producerRuleId: producerRuleId.slice(0, 256), rule: { familyId: pin!.familyId, revisionDigest: pin!.definitionDigest as never },
      originalSeverity: (severity === 'unspecified' ? severityOf.get(pin!.familyId) ?? severity : severity).slice(0, 200), message: message.slice(0, 4000), evidence: evidence.slice(0, 256), limitationKeys: [], observedAt,
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
  const findings = await findingsOf(a.observations, id => store.readArtifact(id as never));
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

/** Reads an owner-supplied graph file, bounded, and the repository name its nodes use. */
export function readContextGraph(file: ContextFile): { graph: ContextGraph; repo: string } {
  const fd = openSync(file.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CONTEXT_BYTES) throw new FullReportError('sentinel.report.contextInvalid', { reason: 'not a regular file within the size bound' });
    const buf = Buffer.alloc(st.size);
    for (let off = 0; off < st.size;) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    text = buf.toString('utf8');
  } finally { closeSync(fd); }
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
    const path = join(root, e.relativePath);
    if (!existsSync(path)) continue;
    try { out.push({ relativePath: e.relativePath, content: sha(readFileSync(path)) }); } catch { /* unreadable now: not an input */ }
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
  if (req.baselineRunId) {
    const baseline = await assessRun(store, req.baselineRunId, { trustDir: req.trustDir });
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
    disclosure: req.disclosure, observations: current.observations, coverage: current.coverage, plannedChecks: current.plannedChecks,
    inventory: current.inventory, readContent, ...(contexts ? { contexts } : {}), rules: ruleWords(req.trustDir, current.ruleLock),
    ...(comparison ? { comparison } : {}),
  }, currentFindings);
  const doc = build.document;
  return {
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
