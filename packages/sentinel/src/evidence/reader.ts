// A retained acceptance authenticates owner-associated imported claims only. It never rehydrates a live receipt,
// worker, qualified producer or mitigation capability. The opaque read handle has no mutation/launch consumer.
import type { NormalizedImport } from '../imports/normalize.js';
import { normalizeImport } from '../imports/normalize.js';
import { IMPORT_ADAPTER } from '../imports/types.js';
import {
  retainedSourceForAdmission,
  readRetainedSourceProof,
  type ProofTiming,
  type RetainedSourceProof,
} from '../execution/retained-source.js';
import { loadPlan } from '../execution/plans.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { assessRun } from '../service/full-report.js';
import type { Workspace } from '../service/local.js';
import type { SentinelStore } from '../store/index.js';
import { evidenceLedgerFor, type EvidenceAcceptance } from '../store/evidence-binding.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { compareTimestamps, isCalendarTimestamp } from '../validate.js';
import { deepFreeze } from '../policy/immutable.js';
import { auditUnavailable, boundedAudit, verifyRetainedAudit } from './audit.js';
import {
  admissionOf,
  rootOf,
  EVIDENCE_LIMITS,
  checkEvidenceBounds,
  type EvidenceIdentity,
  type ImportPublication,
} from './import-operation.js';
import { importOwnerContext, ownerContextOf, type ImportOwnerContext } from './owner-context.js';
import { evidencePoint } from './test-hooks.js';

declare const brand: unique symbol;
export interface AcceptedImportedReport {
  readonly [brand]: true;
}
interface ReadState {
  context: ImportOwnerContext;
  record: EvidenceAcceptance;
  proof: RetainedSourceProof;
  document: NormalizedImport;
}
const accepted = new WeakMap<object, ReadState>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type Edge = { parent: string; child: string };
/** Orders link edges by parent, then by child. */
function byEdge(a: Edge, b: Edge): number {
  if (a.parent < b.parent) return -1;
  if (a.parent > b.parent) return 1;
  if (a.child < b.child) return -1;
  if (a.child > b.child) return 1;
  return 0;
}
const sortedEdges = (v: readonly Edge[]) => [...v].sort(byEdge);
const json = (b: Buffer): unknown => JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(b));
type OwnerContext = ReturnType<typeof ownerContextOf>;
type Normalized = Extract<ReturnType<typeof normalizeImport>, { status: 'normalized' }>;

/**
 * The publication of an acceptance record, once the record, its operation identity and its acceptance event agree on
 * one acceptance of this candidate in this store and workspace, and its five role ids are distinct digests, apart from
 * the root. Anything else is `auditUnavailable`.
 */
function acceptedPublication(record: EvidenceAcceptance, c: OwnerContext, candidateDigest: string): ImportPublication {
  const store = c.store;
  const i = record.identity,
    p = i.publication;
  if (
    !p ||
    i.schema !== 'sentinel-report-import-operation/1' ||
    i.storeId !== store.storeId ||
    i.id !== record.operationId ||
    i.epoch !== record.epoch ||
    i.candidateDigest !== record.candidateDigest ||
    i.bindingDigest !== record.bindingDigest ||
    i.priorHead !== record.previous ||
    p.root !== record.root ||
    p.workspaceDigest !== c.workspaceDigest ||
    !same(p.adapter, IMPORT_ADAPTER) ||
    record.event.kind !== 'evidence-accepted' ||
    record.event.epoch !== i.epoch ||
    !same(record.event.payload, {
      operationId: i.id,
      candidateDigest: i.candidateDigest,
      root: p.root,
      bindingDigest: i.bindingDigest,
      previous: i.priorHead,
    }) ||
    !isCalendarTimestamp(record.acceptedAt) ||
    compareTimestamps(record.acceptedAt, p.admission.decidedAt) < 0
  )
    auditUnavailable();
  const roleKeys = ['raw', 'manifest', 'normalized', 'candidate', 'admission'];
  if (
    !p.roles ||
    Object.keys(p.roles).sort().join('|') !== roleKeys.sort().join('|') ||
    new Set([...Object.values(p.roles), p.root]).size !== 6 ||
    Object.values(p.roles).some((id) => typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id)) ||
    p.roles.candidate !== candidateDigest
  )
    auditUnavailable();
  return p;
}

/**
 * Reads the retained objects `ids` in order, checking the owner before and after each read. Every one must exist,
 * declare a size of at most 16 MiB with the total within the evidence byte bound, and read back at exactly that size.
 */
async function readRetainedObjects(
  context: ImportOwnerContext,
  store: SentinelStore,
  ids: readonly string[],
): Promise<{ bytes: Map<string, Buffer>; size: number }> {
  const bytes = new Map<string, Buffer>();
  let size = 0;
  for (const id of ids) {
    ownerContextOf(context);
    const refs = store.ledger.objectsOf(id);
    if (!refs.length) auditUnavailable();
    const declared = Math.max(...refs.map((r) => r.rawSize));
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > 16 * 1024 * 1024 ||
      size + declared > EVIDENCE_LIMITS.bytes
    )
      auditUnavailable();
    const data = await store.readArtifact(id);
    ownerContextOf(context);
    if (data.length !== declared) auditUnavailable();
    size += data.length;
    bytes.set(id, data);
  }
  return { bytes, size };
}

/**
 * Parses the retained root, admission and candidate, and checks that the root and the admission are exactly what the
 * operation identity derives and that all three are stored as their canonical bytes. Returns the parsed candidate.
 */
function retainedCandidate(bytes: ReadonlyMap<string, Buffer>, p: ImportPublication, i: EvidenceIdentity): unknown {
  const root = json(bytes.get(p.root)!),
    audit = json(bytes.get(p.roles.admission)!),
    candidate = json(bytes.get(p.roles.candidate)!);
  boundedAudit(audit);
  if (
    !same(root, rootOf(i)) ||
    !bytes.get(p.root)!.equals(Buffer.from(canonicalJson(root))) ||
    !same(audit, admissionOf(i)) ||
    !bytes.get(p.roles.admission)!.equals(Buffer.from(canonicalJson(audit))) ||
    !bytes.get(p.roles.candidate)!.equals(Buffer.from(canonicalJson(candidate)))
  )
    auditUnavailable();
  return candidate;
}

/**
 * Checks that the operation's intent is exactly the `evidence.import` of this run's profile and source, and that its
 * state digest binds this store, binding, candidate, prior head, workspace and epoch.
 */
function checkImportIntent(c: OwnerContext, i: EvidenceIdentity): void {
  const store = c.store;
  const run = store.ledger.getRun(i.ancestor.runId);
  if (!run) auditUnavailable();
  const expectedIntent = {
    action: 'evidence.import',
    input: i.candidateDigest,
    effects: ['local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: {
      profile: run.envelope.requestedScope.profile,
      provider: null,
      targets: ['report-import', i.ancestor.runId, `revision:${i.ancestor.revision}`, i.ancestor.sourceId],
    },
  };
  if (
    !same(i.intent, expectedIntent) ||
    i.stateDigest !==
      digestOf({
        storeId: store.storeId,
        bindingDigest: i.bindingDigest,
        candidateDigest: i.candidateDigest,
        priorHead: i.priorHead,
        workspaceDigest: c.workspaceDigest,
        epoch: i.epoch,
      })
  )
    auditUnavailable();
}

/**
 * Normalizes the retained raw report and manifest again, checks that the result is the retained normalized document
 * and that the candidate is exactly the one derived from it over this source closure, and returns the normalization.
 */
function renormalized(
  c: OwnerContext,
  bytes: ReadonlyMap<string, Buffer>,
  p: ImportPublication,
  i: EvidenceIdentity,
  { candidate, closure }: { readonly candidate: unknown; readonly closure: readonly string[] },
): Normalized {
  const store = c.store;
  const normalized = normalizeImport(bytes.get(p.roles.raw)!, bytes.get(p.roles.manifest)!);
  if (
    normalized.status !== 'normalized' ||
    normalized.digest !== p.roles.normalized ||
    !bytes.get(p.roles.normalized)!.equals(Buffer.from(normalized.canonical))
  )
    auditUnavailable();
  const expectedCandidate = {
    schema: 'sentinel-report-import-candidate/1',
    domain: 'report-import',
    storeId: store.storeId,
    ancestor: i.ancestor,
    workspaceDigest: c.workspaceDigest,
    sourceClosure: closure,
    adapter: normalized.document.adapter,
    raw: normalized.document.input.rawDigest,
    manifest: normalized.document.input.manifestDigest,
    normalized: normalized.digest,
    authority: 'owner-associated-imported-claims',
  };
  if (!same(candidate, expectedCandidate) || digestOf(candidate) !== i.candidateDigest) auditUnavailable();
  return normalized;
}

/**
 * Checks the operation's staged artifacts, the acceptance's links and its privacy floors against what an accepted
 * import of these roles over this source closure must have (every role at least source-derived, every source body
 * `source`), then the evidence bounds.
 */
function checkAcceptedArtifacts(
  record: EvidenceAcceptance,
  p: ImportPublication,
  i: EvidenceIdentity,
  read: {
    readonly ids: readonly string[];
    readonly size: number;
    readonly closure: readonly string[];
    readonly source: ReturnType<typeof readRetainedSourceProof>;
  },
): void {
  const { ids, size, closure, source } = read;
  const expectedArtifacts = [
    { id: p.roles.raw, schema: 'application/octet-stream', privacy: 'source-derived', links: [] },
    { id: p.roles.manifest, schema: 'sentinel-import-manifest/draft-1', privacy: 'source-derived', links: [] },
    { id: p.roles.normalized, schema: 'sentinel-import-normalized/draft-1', privacy: 'source-derived', links: [] },
    {
      id: p.roles.candidate,
      schema: 'sentinel-report-import-candidate/1',
      privacy: 'source-derived',
      links: [...new Set([p.roles.raw, p.roles.manifest, p.roles.normalized, ...closure])].filter(
        (id) => id !== p.roles.candidate,
      ),
    },
    { id: p.roles.admission, schema: 'sentinel-evidence-admission/1', privacy: 'source-derived', links: [] },
    {
      id: p.root,
      schema: 'sentinel-accepted-evidence/1',
      privacy: 'source-derived',
      links: [p.roles.candidate, p.roles.admission],
    },
  ];
  if (!same(i.artifacts, expectedArtifacts)) auditUnavailable();
  const expectedLinks = expectedArtifacts.flatMap((a) => a.links.map((child) => ({ parent: a.id, child })));
  if (!same(sortedEdges(expectedLinks), sortedEdges(record.links))) auditUnavailable();
  const floors = new Map(record.floors.map((v) => [v.id, v.privacy]));
  for (const id of ids) if (!['source', 'source-derived'].includes(floors.get(id) ?? '')) auditUnavailable();
  for (const entry of source.closure)
    if (entry.role === 'source-content' && floors.get(entry.id) !== 'source') auditUnavailable();
  checkEvidenceBounds(ids.length, size, closure.length, expectedLinks.length);
}

/**
 * Checks that an acceptance's predecessor, when it names one, is an earlier acceptance under the same binding, and that
 * the acceptance has not changed while it was read.
 */
function checkAcceptanceChain(
  ops: ReturnType<typeof evidenceLedgerFor>,
  record: EvidenceAcceptance,
  candidateDigest: string,
): void {
  if (record.previous) {
    const previous = ops.acceptance(record.previous);
    if (!previous || previous.bindingDigest !== record.bindingDigest || previous.sequence >= record.sequence)
      auditUnavailable();
  }
  const unchanged = ops.acceptance(candidateDigest);
  if (!unchanged || !same(unchanged, record)) auditUnavailable();
}

/**
 * Internal retained read, used for lost acknowledgements before a fresh spend. Authenticates one accepted import of
 * `candidateDigest` from its retained records alone: the acceptance, its source proof, its six role objects, its
 * audited admission, its intent, a fresh normalization and its artifacts, links and floors, each refusing with
 * `auditUnavailable`. Returns an opaque handle `reportImportView` reads; nothing else accepts it.
 */
export async function validateAcceptedImport(
  context: ImportOwnerContext,
  candidateDigest: string,
): Promise<AcceptedImportedReport> {
  const c = ownerContextOf(context),
    store = c.store,
    ops = evidenceLedgerFor(store),
    record = ops.acceptance(candidateDigest);
  if (!record) auditUnavailable();
  const i = record.identity,
    p = acceptedPublication(record, c, candidateDigest);
  const proof = await retainedSourceForAdmission(store, i.ancestor, { signal: c.signal, deadlineAt: c.deadlineAt });
  ownerContextOf(context);
  const source = readRetainedSourceProof(store, proof, i.ancestor, { signal: c.signal, deadlineAt: c.deadlineAt });
  const closure = [...new Set(source.closure.map((v) => v.id))].sort();
  if (
    !same(closure, i.closure) ||
    i.bindingDigest !== digestOf({ domain: 'report-import', storeId: store.storeId, ancestor: i.ancestor })
  )
    auditUnavailable();
  const ids = [p.roles.raw, p.roles.manifest, p.roles.normalized, p.roles.candidate, p.roles.admission, p.root];
  const { bytes, size } = await readRetainedObjects(context, store, ids);
  const candidate = retainedCandidate(bytes, p, i);
  verifyRetainedAudit(context, {
    receipt: i.receipt,
    receiptDigest: i.receiptDigest,
    admission: p.admission,
    intent: i.intent,
    stateDigest: i.stateDigest,
    policyRevision: i.policyRevision,
  });
  checkImportIntent(c, i);
  const normalized = renormalized(c, bytes, p, i, { candidate, closure });
  checkAcceptedArtifacts(record, p, i, { ids, size, closure, source });
  checkAcceptanceChain(ops, record, candidateDigest);
  evidencePoint('after-payload-reads');
  ownerContextOf(context);
  readRetainedSourceProof(store, proof, i.ancestor, { signal: c.signal, deadlineAt: c.deadlineAt });
  const token = Object.freeze({}) as AcceptedImportedReport;
  accepted.set(token, { context, record, proof, document: normalized.document });
  return token;
}
/** Existing report privacy readers authenticate all scanner/selected-ancestor records. No imported tag counts. */
async function privacy(context: ImportOwnerContext, runId: string): Promise<'clean' | 'secret' | 'unassessed'> {
  const c = ownerContextOf(context),
    run = c.store.ledger.getRun(runId);
  if (!run) auditUnavailable();
  if (run.state === 'canceled') return 'unassessed'; // No claim of a clean canceled run; withhold all imported text.
  if (run.state !== 'completed') auditUnavailable();
  const a = await assessRun(c.store, runId, { trustDir: c.trustDir });
  ownerContextOf(context);
  if (a.observations.some((o) => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks'))
    return 'secret';
  const plan = await loadPlan(c.store, runId, a.planRevision);
  ownerContextOf(context);
  const inherited = await selectedSecretPrivacy(c.store, runId, plan);
  ownerContextOf(context);
  return inherited.hasMatches ? 'secret' : 'clean';
}
/** This is a data projection, never a producer/finding/mitigation authority constructor. No source-closure body is exported. */
export async function reportImportView(value: AcceptedImportedReport, options: { baselineRunId?: string } = {}) {
  const s = accepted.get(value);
  if (!s) auditUnavailable();
  const c = ownerContextOf(s.context),
    i = s.record.identity;
  readRetainedSourceProof(c.store, s.proof, i.ancestor, { signal: c.signal, deadlineAt: c.deadlineAt });
  const run = c.store.ledger.getRun(i.ancestor.runId);
  if (!run) auditUnavailable();
  const runIds = new Set([
    i.ancestor.runId,
    ...(run.envelope.baselineId ? [run.envelope.baselineId] : []),
    ...(options.baselineRunId ? [options.baselineRunId] : []),
  ]);
  if (runIds.size > 3) auditUnavailable();
  let reason: 'accepted-secret-match' | 'privacy-unassessed-canceled-run' | null = null;
  for (const id of runIds) {
    const state = await privacy(s.context, id);
    if (state === 'secret') reason = 'accepted-secret-match';
    else if (state === 'unassessed' && reason === null) reason = 'privacy-unassessed-canceled-run';
  }
  const result = deepFreeze({
    schema: 'sentinel-import-view/1',
    kind: 'imported-report',
    authority: 'owner-associated-imported-claims',
    candidateDigest: s.record.candidateDigest,
    root: s.record.root,
    withheld: reason !== null,
    limitation: reason,
    counts: {
      claims: s.document.claims.length,
      exchanges: s.document.exchanges.length,
      cookies: s.document.cookies.length,
    },
    // No heuristic substitutes source strings. Any match (current/baseline/selected ancestor) removes the entire
    // caller-controlled payload in both disclosure profiles. Counts and structural digests remain useful.
    document: reason === null ? structuredClone(s.document) : null,
  });
  evidencePoint('after-privacy');
  ownerContextOf(s.context);
  readRetainedSourceProof(c.store, s.proof, i.ancestor, { signal: c.signal, deadlineAt: c.deadlineAt });
  return result;
}
export async function readAcceptedReportImport(
  store: SentinelStore,
  ws: Workspace,
  candidateDigest: string,
  options: { timing: ProofTiming; baselineRunId?: string },
) {
  const context = importOwnerContext(store, ws, options.timing),
    value = await validateAcceptedImport(context, candidateDigest);
  return reportImportView(value, { ...(options.baselineRunId ? { baselineRunId: options.baselineRunId } : {}) });
}
