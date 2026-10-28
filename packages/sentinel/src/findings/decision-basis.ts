// Private accepted-finding authority. Descriptive JSON is never a constructor for this capability.
import type { SentinelStore } from '../store/index.js';
import type { Workspace } from '../service/local.js';
import { assessRun } from '../service/full-report.js';
import { findingsOf } from '../reports/document.js';
import {
  retainedSourceForAdmission,
  readRetainedSourceProof,
  type ProofTiming,
  type RetainedSourceProof,
  type RetainedSourceAncestor,
} from '../execution/retained-source.js';
import { loadPlan } from '../execution/plans.js';
import { retainedBootstrapForReport } from '../execution/retained-bootstrap.js';
import { selectedSecretPrivacy } from '../reports/selected-privacy.js';
import { verifyWorkEnvelope, capturedInputsOf } from '../planner/boundary.js';
import { inputFingerprintOf } from '../execution/supervisor.js';
import { importOwnerContext, ownerContextOf, type ImportOwnerContext } from '../evidence/owner-context.js';
import { deepFreeze } from '../policy/immutable.js';
import { canonicalJson, digestOf } from '../store/ledger-json.js';
import { readAcceptedReportImport } from '../evidence/reader.js';
import { evidenceLedgerFor } from '../store/evidence-binding.js';
import { fail, validId } from './decision-data.js';

/**
 * The retained description of one accepted finding: the exact source ancestor, the finding's fingerprint and site, the
 * accepted publications and checks that produced it, its citations and its artifact closure. A decision stores it as
 * its basis; it is never authority by itself (`revalidateFindingRecord` derives it again).
 */
export interface AcceptedFindingRecord {
  readonly schema: 'sentinel-accepted-finding-basis/2';
  readonly storeId: string;
  readonly workspaceDigest: string;
  readonly profileId: string;
  readonly ancestor: RetainedSourceAncestor;
  readonly findingId: string;
  readonly fingerprint: string;
  readonly findingSite: string;
  readonly familyId: string;
  readonly scope: { readonly kind: 'finding-source'; readonly sourceId: string; readonly findingId: string };
  readonly observationIds: readonly string[];
  readonly publications: readonly {
    readonly attemptId: string;
    readonly invocation: string;
    readonly work: { readonly id: string; readonly revision: number };
    readonly outputs: readonly string[];
    readonly checks: readonly {
      readonly id: string;
      readonly scopeId: string;
      readonly ruleRevision: number;
      readonly definitionDigest: string;
      readonly adapterDigest: string;
    }[];
  }[];
  readonly citations: readonly {
    readonly sourceId: string;
    readonly content: string;
    readonly startByte: number;
    readonly endByte: number;
  }[];
  readonly closure: readonly string[];
}
declare const brand: unique symbol;
/**
 * The opaque capability that a finding was derived from accepted evidence for this owner. Only
 * `acceptedFindingBasisFor` mints one; a copy or its JSON has no authority.
 */
export interface AcceptedFindingBasis {
  readonly [brand]: true;
}
interface State {
  context: ImportOwnerContext;
  proof: RetainedSourceProof;
  record: AcceptedFindingRecord;
}
const bases = new WeakMap<object, State>();
/** One report's opaque, owner-bound reuse. It never survives its original deadline or grants authority from JSON. */
export interface FindingReadSession {
  readonly session: unique symbol;
}
interface PrivacyPin {
  runId: string;
  revision: number;
  planDigest: string;
  snapshotId: string | null;
  state: string;
}
interface ReadSession {
  store: SentinelStore;
  ws: Workspace;
  context: ImportOwnerContext;
  timing: ProofTiming;
  closed: boolean;
  assessments: Map<string, Promise<Awaited<ReturnType<typeof assessRun>>>>;
  findings: Map<string, Promise<Awaited<ReturnType<typeof findingsOf>>>>;
  plans: Map<string, Promise<Awaited<ReturnType<typeof loadPlan>>>>;
  proofs: Map<string, Promise<RetainedSourceProof>>;
  records: Map<string, Promise<AcceptedFindingBasis>>;
  supports: Map<string, Promise<readonly OwnerDecisionSupport[]>>;
  supportReads: Map<string, { basis: AcceptedFindingBasis; evidence: readonly string[]; baselineRunId?: string }>;
  verified: Set<string>;
  tokens: Set<AcceptedFindingBasis>;
  privacy: Map<string, Promise<boolean>>;
  privacyPins: Map<string, PrivacyPin>;
}
const readSessions = new WeakMap<object, ReadSession>();
/**
 * Opens one report's read session over this store and workspace: assessments, plans, proofs and supports read through
 * it are reused until `finishFindingReadSession` closes it.
 */
export function findingReadSessionFor(store: SentinelStore, ws: Workspace, timing: ProofTiming): FindingReadSession {
  const token = Object.freeze({}) as FindingReadSession,
    context = importOwnerContext(store, ws, timing);
  readSessions.set(token, {
    store,
    ws,
    context,
    timing,
    closed: false,
    assessments: new Map(),
    findings: new Map(),
    plans: new Map(),
    proofs: new Map(),
    records: new Map(),
    supports: new Map(),
    supportReads: new Map(),
    verified: new Set(),
    tokens: new Set(),
    privacy: new Map(),
    privacyPins: new Map(),
  });
  return token;
}
function readSession(
  token: FindingReadSession | undefined,
  store: SentinelStore,
  ws: Workspace,
): ReadSession | undefined {
  if (token === undefined) return undefined;
  const s = readSessions.get(token);
  if (!s || s.closed || s.store !== store || s.ws !== ws)
    return fail('sentinel.decision.unauthorized', 'foreign report read session');
  ownerContextOf(s.context);
  return s;
}
function memo<K, V>(map: Map<K, Promise<V>> | undefined, key: K, read: () => Promise<V>): Promise<V> {
  if (!map) return read();
  let result = map.get(key);
  if (!result) {
    result = read();
    map.set(key, result);
  }
  return result;
}
/**
 * Closes a read session after verifying again everything it reused: every support read, every accepted finding basis
 * and every privacy pin. A closed or unknown session is `sentinel.decision.unauthorized`; a privacy ancestor that
 * changed is `sentinel.decision.staleState`. The session is closed even when a check throws.
 */
export async function finishFindingReadSession(token: FindingReadSession): Promise<void> {
  const s = readSessions.get(token);
  if (!s || s.closed) return fail('sentinel.decision.unauthorized', 'closed report read session');
  try {
    ownerContextOf(s.context);
    for (const support of s.supportReads.values()) {
      await readOwnerSupport(support.basis, s.ws, support.evidence, support.baselineRunId);
      ownerContextOf(s.context);
    }
    for (const basis of s.tokens) acceptedFindingOf(basis);
    for (const pin of s.privacyPins.values()) assertPrivacyPin(s.store, pin);
    ownerContextOf(s.context);
  } finally {
    s.closed = true;
    readSessions.delete(token);
  }
}

/**
 * The state behind an accepted finding basis, after reading its retained source proof again, so a lost owner, a passed
 * deadline or changed retained bytes refuse here too. A value this module did not mint is
 * `sentinel.decision.unauthorized`.
 */
export function acceptedFindingOf(value: AcceptedFindingBasis): Readonly<State> {
  const s = bases.get(value);
  if (!s) return fail('sentinel.decision.unauthorized', 'no accepted finding authority');
  const c = ownerContextOf(s.context);
  readRetainedSourceProof(c.store, s.proof, s.record.ancestor, { signal: c.signal, deadlineAt: c.deadlineAt });
  return s;
}
/** The only input selection is an actual finding ID. No caller assessment, scope facts, graph or policy is accepted. */
export async function acceptedFindingBasisFor(
  store: SentinelStore,
  ws: Workspace,
  runId: string,
  findingId: string,
  timing: ProofTiming,
  session?: FindingReadSession,
): Promise<AcceptedFindingBasis> {
  if (!validId(runId) || !/^finding\.[0-9a-f]{40}$/.test(findingId))
    return fail('sentinel.decision.invalidInput', 'invalid finding selection');
  const cache = readSession(session, store, ws),
    context = cache?.context ?? importOwnerContext(store, ws, timing),
    c = ownerContextOf(context);
  const assessmentKey = canonicalJson(privacyPin(store, runId));
  const assessment = await memo(cache?.assessments, assessmentKey, () =>
    assessRun(store, runId, { trustDir: c.trustDir }),
  );
  ownerContextOf(context);
  const findings = await memo(cache?.findings, runId, () =>
    findingsOf(assessment.observations, (id) => store.readArtifact(id), { withheldKey: assessment.withheldKey }),
  );
  ownerContextOf(context);
  const finding = findings.find((f) => f.id === findingId);
  if (!finding || finding.sourceIds.length !== 1 || finding.observations.length === 0)
    return fail('sentinel.decision.notFound', 'no single-source accepted finding');
  const run = store.ledger.getRun(runId),
    revision = run?.planRevision;
  if (!run || run.state !== 'completed' || revision !== assessment.planRevision)
    return fail('sentinel.decision.staleState', 'executed revision changed');
  const { plan } = await memo(cache?.plans, runId + ':' + revision, () => loadPlan(store, runId, revision));
  ownerContextOf(context);
  const ancestor = {
    runId,
    revision,
    planDigest: plan.digest,
    snapshotId: assessment.snapshot.id,
    sourceId: finding.sourceIds[0]!,
  };
  const proof = await memo(cache?.proofs, canonicalJson(ancestor), () =>
    retainedSourceForAdmission(store, ancestor, cache?.timing ?? timing),
  );
  const source = readRetainedSourceProof(store, proof, ancestor, timing);
  ownerContextOf(context);
  // This genuine proof already hash-read every source body. Reuse only those roles in this report's private session.
  if (cache) for (const entry of source.closure) if (entry.role === 'source-content') cache.verified.add(entry.id);
  const publications: AcceptedFindingRecord['publications'][number][] = [],
    seen = new Set<string>(),
    closure = new Set(source.closure.map((x) => x.id));
  for (const normalized of finding.observations) {
    const observation = normalized.observation,
      p = observation.producer;
    if (
      p.kind !== 'scanner' ||
      !observation.rule ||
      observation.rule.familyId !== finding.ruleFamilyId ||
      normalized.anchors.some((a) => a.sourceId !== ancestor.sourceId)
    )
      return fail('sentinel.decision.unauthorized', 'finding is not an accepted source check');
    if (seen.has(p.attemptId)) continue;
    seen.add(p.attemptId);
    const attempt = store.ledger.getAttempt(p.attemptId),
      pub = attempt && store.ledger.getPublication(attempt.work);
    const unit = attempt && plan.units.find((u) => u.id === attempt.work.id && u.revision === attempt.work.revision);
    if (
      !attempt ||
      attempt.state !== 'succeeded' ||
      !attempt.envelope.invocation ||
      !pub ||
      pub.attemptId !== attempt.id ||
      !unit ||
      unit.sourceId !== ancestor.sourceId ||
      unit.adapterId !== p.adapterId
    )
      return fail('sentinel.decision.unauthorized', 'unbound accepted producer');
    const check = plan.checks.find(
      (k) =>
        unit.checks.includes(k.id) &&
        k.familyId === observation.rule!.familyId &&
        k.state === 'planned' &&
        k.sourceId === ancestor.sourceId,
    );
    const rule =
      check && plan.pins.rules.find((r) => r.familyId === check.familyId && r.revision === check.ruleRevision);
    if (!check || !rule || rule.definitionDigest !== observation.rule.revisionDigest)
      return fail('sentinel.decision.unauthorized', 'unbound rule revision');
    const ids = pub.outputs.map((o) => o.id).sort();
    for (const id of [...ids, attempt.envelope.invocation]) closure.add(id);
    publications.push({
      attemptId: attempt.id,
      invocation: attempt.envelope.invocation,
      work: attempt.work,
      outputs: ids,
      checks: [
        {
          id: check.id,
          scopeId: check.scopeId,
          ruleRevision: check.ruleRevision,
          definitionDigest: rule.definitionDigest,
          adapterDigest: p.adapterDigest,
        },
      ],
    });
  }
  if (closure.size > 2048) return fail('sentinel.decision.scopeExceeded', 'finding closure exceeds its bound');
  for (const id of closure) {
    if (!cache?.verified.has(id)) {
      await store.readArtifact(id as never);
      ownerContextOf(context);
      cache?.verified.add(id);
    }
  }
  const record = deepFreeze({
    schema: 'sentinel-accepted-finding-basis/2' as const,
    storeId: store.storeId,
    workspaceDigest: c.workspaceDigest,
    profileId: plan.pins.profileId,
    ancestor,
    findingId,
    fingerprint: finding.fingerprint.exact,
    findingSite: finding.fingerprint.probable,
    familyId: finding.ruleFamilyId,
    scope: { kind: 'finding-source' as const, sourceId: ancestor.sourceId, findingId },
    observationIds: [...finding.observationIds].sort(),
    publications: publications.sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    citations: finding.anchors.map((a) => ({
      sourceId: a.sourceId,
      content: a.content,
      startByte: a.span.startByte,
      endByte: a.span.endByte,
    })),
    closure: [...closure].sort(),
  });
  const token = Object.freeze({}) as AcceptedFindingBasis;
  bases.set(token, { context, proof, record });
  acceptedFindingOf(token);
  cache?.tokens.add(token);
  return token;
}
/** Retained JSON only selects what must be independently rederived; matching bytes alone are never authority. */
export async function revalidateFindingRecord(
  store: SentinelStore,
  ws: Workspace,
  record: AcceptedFindingRecord,
  timing: ProofTiming,
  session?: FindingReadSession,
): Promise<AcceptedFindingBasis> {
  const cache = readSession(session, store, ws);
  const fresh = await memo(cache?.records, canonicalJson(record), () =>
    acceptedFindingBasisFor(store, ws, record.ancestor.runId, record.findingId, timing, session),
  );
  if (canonicalJson(acceptedFindingOf(fresh).record) !== canonicalJson(record))
    return fail('sentinel.decision.staleState', 'accepted finding identity changed');
  return fresh;
}
/** The digest of an accepted finding's record, after its authority is checked again. */
export const acceptedFindingDigest = (basis: AcceptedFindingBasis) => digestOf(acceptedFindingOf(basis).record);

/** One piece of evidence an owner decision names: a finding artifact or an accepted import root, by id. */
export interface OwnerDecisionSupport {
  readonly id: string;
  readonly kind: 'finding-artifact' | 'accepted-import';
  readonly root: string;
}
/** Supporting imports retain their original authority. These bytes cannot establish a control or mint a finding. */
export async function readOwnerSupport(
  basis: AcceptedFindingBasis,
  ws: Workspace,
  evidence: readonly string[],
  baselineRunId?: string,
  session?: FindingReadSession,
): Promise<readonly OwnerDecisionSupport[]> {
  const state = acceptedFindingOf(basis),
    context = ownerContextOf(state.context),
    cache = readSession(session, context.store, ws);
  if (cache) {
    const key = canonicalJson({ record: digestOf(state.record), evidence, baselineRunId: baselineRunId ?? null });
    return memo(cache.supports, key, async () => {
      const result = await readOwnerSupport(basis, ws, evidence, baselineRunId);
      if (evidence.length) cache.supportReads.set(key, { basis, evidence: [...evidence], baselineRunId });
      return result;
    });
  }
  const s = acceptedFindingOf(basis),
    c = ownerContextOf(s.context),
    out: OwnerDecisionSupport[] = [];
  for (const id of evidence) {
    if (s.record.closure.includes(id)) {
      await c.store.readArtifact(id);
      acceptedFindingOf(basis);
      out.push({ id, kind: 'finding-artifact', root: id });
      continue;
    }
    const record = evidenceLedgerFor(c.store).acceptance(id);
    if (!record || canonicalJson(record.identity.ancestor) !== canonicalJson(s.record.ancestor))
      return fail('sentinel.decision.unauthorized', 'support is not accepted for this exact source ancestor');
    const view = await readAcceptedReportImport(c.store, ws, id, {
      timing: { signal: c.signal, deadlineAt: c.deadlineAt },
      ...(baselineRunId ? { baselineRunId } : {}),
    });
    acceptedFindingOf(basis);
    if (view.root !== record.root) return fail('sentinel.decision.unauthorized', 'support changed');
    out.push({ id, kind: 'accepted-import', root: view.root });
  }
  acceptedFindingOf(basis);
  return deepFreeze(out);
}

/** Current, baseline and selected-ancestor privacy is derived from accepted publications, never observation JSON. */
export async function findingSecretPrivacy(
  basis: AcceptedFindingBasis,
  ws: Workspace,
  baselineRunId?: string,
  session?: FindingReadSession,
): Promise<boolean> {
  const s = acceptedFindingOf(basis),
    c = ownerContextOf(s.context),
    cache = readSession(session, c.store, ws);
  const ids = new Set([s.record.ancestor.runId, ...(baselineRunId ? [baselineRunId] : [])]);
  const current = c.store.ledger.getRun(s.record.ancestor.runId);
  if (current?.envelope.baselineId) ids.add(current.envelope.baselineId);
  let withheld = false;
  for (const id of ids) {
    const pin = privacyPin(c.store, id),
      key = canonicalJson(pin);
    cache?.privacyPins.set(key, pin);
    const secret = await memo(cache?.privacy, key, async () => {
      // A canceled run is always coarse-withheld. Nonterminal or unreadable evidence cannot establish clean.
      if (pin.state === 'canceled') return true;
      if (pin.state !== 'completed')
        return fail('sentinel.decision.unauthorized', 'privacy ancestor is not reportable');
      const assessment = await memo(cache?.assessments, key, () => assessRun(c.store, id, { trustDir: c.trustDir }));
      acceptedFindingOf(basis);
      assertPrivacyPin(c.store, pin);
      if (assessment.planRevision !== pin.revision || assessment.snapshot.id !== pin.snapshotId)
        return fail('sentinel.decision.unauthorized', 'privacy assessment changed');
      const admitted = await loadPlan(c.store, id, pin.revision);
      acceptedFindingOf(basis);
      assertPrivacyPin(c.store, pin);
      if (admitted.plan.digest !== pin.planDigest)
        return fail('sentinel.decision.unauthorized', 'privacy plan changed');
      await verifyCurrentSecretInvocations(c.store, admitted, assessment.snapshot, basis);
      assertPrivacyPin(c.store, pin);
      if (
        assessment.observations.some(
          (o) => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks',
        )
      )
        return true;
      if (admitted.selection) {
        const retained = await retainedBootstrapForReport(c.store, id, admitted);
        acceptedFindingOf(basis);
        assertPrivacyPin(c.store, pin);
        for (const ancestor of retained.selectedAncestors) {
          const ancestorPin = privacyPin(c.store, ancestor.runId);
          if (
            ancestorPin.revision !== ancestor.revision ||
            ancestorPin.planDigest !== ancestor.planDigest ||
            ancestorPin.snapshotId !== pin.snapshotId
          )
            return fail('sentinel.decision.unauthorized', 'privacy selection changed');
          cache?.privacyPins.set(canonicalJson(ancestorPin), ancestorPin);
        }
      }
      const privacy = await selectedSecretPrivacy(c.store, id, admitted);
      acceptedFindingOf(basis);
      assertPrivacyPin(c.store, pin);
      return privacy.hasMatches;
    });
    acceptedFindingOf(basis);
    assertPrivacyPin(c.store, pin);
    withheld ||= secret;
  }
  if (cache) for (const pin of cache.privacyPins.values()) assertPrivacyPin(c.store, pin);
  acceptedFindingOf(basis);
  return withheld;
}
function privacyPin(store: SentinelStore, runId: string): PrivacyPin {
  const r = store.ledger.getRun(runId),
    p = r && store.ledger.getPlan(runId, r.planRevision);
  if (!r || !p) return fail('sentinel.decision.unauthorized', 'privacy ancestor unavailable');
  return { runId, revision: r.planRevision, planDigest: p.digest, snapshotId: r.envelope.snapshotId, state: r.state };
}
function assertPrivacyPin(store: SentinelStore, pin: PrivacyPin): void {
  if (canonicalJson(privacyPin(store, pin.runId)) !== canonicalJson(pin))
    return fail('sentinel.decision.staleState', 'privacy ancestor changed');
}

// assessRun binds findings/counts/citations. Privacy also requires the retained current scanner's actual owner invocation,
// just as selectedSecretPrivacy requires it for ancestors. No copied observation or producer label supplies this proof.
async function verifyCurrentSecretInvocations(
  store: SentinelStore,
  admitted: Awaited<ReturnType<typeof loadPlan>>,
  snapshot: Awaited<ReturnType<typeof assessRun>>['snapshot'],
  basis: AcceptedFindingBasis,
): Promise<void> {
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null),
    bad = (): never => fail('sentinel.decision.unauthorized', 'accepted secret invocation unavailable or unbound'),
    plan = admitted.plan;
  for (const unit of plan.units.filter((u) => u.adapterId === 'secrets-gitleaks')) {
    const row = store.ledger.getWork(unit),
      pub = store.ledger.getPublication(unit);
    if (!pub) {
      if (row?.state === 'published') bad();
      continue;
    }
    const attempt = store.ledger.getAttempt(pub.attemptId),
      digest = admitted.profile.adapters.find((a) => a.adapterId === unit.adapterId)?.digest;
    if (
      !row ||
      row.runId !== plan.runId ||
      row.envelope.planRevision !== plan.revision ||
      row.state !== 'published' ||
      !same(pub.work, { id: unit.id, revision: unit.revision }) ||
      !attempt ||
      attempt.state !== 'succeeded' ||
      !same(attempt.work, pub.work) ||
      !attempt.envelope.invocation ||
      !digest ||
      unit.implementationDigest !== digest ||
      row.envelope.stage.implementationDigest !== digest ||
      attempt.envelope.worker?.kind !== 'owned-container' ||
      !same(attempt.envelope.worker.ownershipLabels, {
        store: store.storeId,
        attempt: attempt.id,
        epoch: attempt.epoch,
      })
    )
      bad();
    try {
      verifyWorkEnvelope(plan, row!.envelope);
      capturedInputsOf(plan, unit, snapshot);
    } catch {
      return bad();
    }
    let invocation: any;
    try {
      invocation = JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(await store.readArtifact(attempt!.envelope.invocation!)),
      );
    } catch {
      return bad();
    }
    acceptedFindingOf(basis);
    if (
      invocation?.format !== 'sentinel-invocation/draft-1' ||
      invocation.store !== store.storeId ||
      invocation.attemptId !== attempt!.id ||
      !same(invocation.work, pub.work) ||
      invocation.coordinatorEpoch !== attempt!.epoch ||
      invocation.adapter?.id !== unit.adapterId ||
      invocation.adapter?.digest !== digest ||
      invocation.isolation !== 'container' ||
      !Array.isArray(invocation.inputs) ||
      invocation.inputs.some((i: unknown) => typeof i !== 'string') ||
      invocation.inputFingerprint !== inputFingerprintOf(invocation.inputs) ||
      unit.inputs.some((i) => !invocation.inputs.includes(i.content)) ||
      !Array.isArray(invocation.assignment?.checks) ||
      !Array.isArray(invocation.assignment?.scopes) ||
      !same([...invocation.assignment.checks].sort(), [...unit.checks].sort()) ||
      !same([...invocation.assignment.scopes].sort(), [...unit.scopes].sort())
    )
      bad();
  }
}
