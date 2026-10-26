// One accepted Gitleaks record's existing full-report binding checks, shared by privacy-only retained readers.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type {
  ObservationEnvelope,
  PlanWork,
  PlanCheck,
  SnapshotEnvelope,
  WithheldLocationEvidence,
} from '../contracts/index.js';
import {
  NAME_LIMITATIONS,
  NAME_MESSAGE,
  OBSERVATION_LIMITATIONS,
  OBSERVATION_MESSAGE,
} from '../adapters/gitleaks/normalize.js';
import { GITLEAKS_RULE_IDS } from '../adapters/gitleaks/rules.js';
import { resolveWithheldLocation } from '../snapshot/locations.js';
const SECRETS_ADAPTER = 'secrets-gitleaks';
const isRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const fileScope = (sourceId: string, path: string) => `${sourceId}:${path}`;

export async function secretObservation(
  v: any,
  ctx: {
    unit: PlanWork;
    attemptId: string;
    runId: string;
    snapshot: SnapshotEnvelope;
    adapterDigest: string | undefined;
    assignedCheck: (id: string) => { check: PlanCheck; pin: { familyId: string; definitionDigest: string } };
    bytesOf: (id: string) => Promise<Buffer>;
    severityOf: ReadonlyMap<string, string>;
    refuse: (reason: string) => never;
    observation: (value: ObservationEnvelope) => ObservationEnvelope;
    tokensOf: (text: string) => string[];
  },
): Promise<{ observation: ObservationEnvelope; names: string[]; tokens: string[] }> {
  const { unit, snapshot, refuse: unbound, observation, tokensOf } = ctx;
  if (
    v.adapter !== SECRETS_ADAPTER ||
    v.runId !== ctx.runId ||
    v.snapshotId !== snapshot.id ||
    v.work?.id !== unit.id ||
    v.work?.revision !== unit.revision ||
    v.attemptId !== ctx.attemptId ||
    v.schema !== 'sentinel-observation/draft-1'
  )
    unbound('an accepted secret finding is bound to another run, unit or attempt');
  if (
    !Array.isArray(v.assignedChecks) ||
    canonicalJson(v.assignedChecks.map((c: any) => c?.id).sort()) !== canonicalJson([...unit.checks].sort())
  )
    unbound("a secret finding is not assigned exactly its unit's checks");
  const pins = v.assignedChecks.map((claim: any) => {
    const { check, pin } = ctx.assignedCheck(claim.id);
    if (
      claim.familyId !== check.familyId ||
      claim.revision !== check.ruleRevision ||
      check.scopeKind !== 'repository' ||
      check.scopeId !== unit.sourceId
    )
      unbound('a secret finding changes its admitted check tuple');
    return pin;
  });
  const pin = pins[0]!;
  if (pins.some((p: any) => p.familyId !== pin.familyId || p.definitionDigest !== pin.definitionDigest))
    unbound('a secret finding spans rule families');
  if (v.rule !== undefined && (v.rule?.familyId !== pin.familyId || v.rule?.revisionDigest !== pin.definitionDigest))
    unbound('a secret finding claims another rule');
  const p = v.producer;
  if (
    !isRecord(p) ||
    p.kind !== 'scanner' ||
    p.adapterId !== SECRETS_ADAPTER ||
    p.attemptId !== ctx.attemptId ||
    !ctx.adapterDigest ||
    p.adapterDigest !== ctx.adapterDigest
  )
    unbound('a secret finding names another producer');
  if (typeof v.producerRuleId !== 'string' || !GITLEAKS_RULE_IDS.has(v.producerRuleId))
    unbound('a secret finding names an unknown detector');
  const name = v.message === NAME_MESSAGE && canonicalJson(v.limitationKeys) === canonicalJson([...NAME_LIMITATIONS]);
  const content =
    v.message === OBSERVATION_MESSAGE &&
    canonicalJson(v.limitationKeys) === canonicalJson([...OBSERVATION_LIMITATIONS]);
  if (!name && !content) unbound('a secret finding carries text other than the redacted message');
  if (!Array.isArray(v.evidence) || !v.evidence.length || v.evidence.length > 256)
    unbound('a secret finding cites nothing');
  const names: string[] = [];
  const tokens: string[] = [];
  const assigned = new Set(unit.inputs.map((i) => `${i.sourceId}\u0000${i.relativePath}\u0000${i.content}`));
  for (const e of v.evidence) {
    if (
      !isRecord(e) ||
      e.location !== 'withheld' ||
      'relativePath' in e ||
      'nodeId' in e ||
      e.snapshotId !== snapshot.id ||
      e.sourceId !== unit.sourceId
    )
      unbound('a secret finding cites a location it may not');
    const found = resolveWithheldLocation(snapshot, e as WithheldLocationEvidence);
    if (!found.ok) return unbound('a secret finding cites a file its unit was not assigned');
    const resolved = found;
    if (!assigned.has(`${resolved.entry.sourceId}\u0000${resolved.entry.relativePath}\u0000${resolved.entry.content}`))
      unbound('a secret finding cites a file its unit was not assigned');
    const bytes = await ctx.bytesOf(resolved.entry.content);
    if (sha(bytes) !== resolved.entry.content) unbound('a captured artifact is not its bytes');
    const span = e.span;
    if (
      !isRecord(span) ||
      !Number.isSafeInteger(span.startByte) ||
      !Number.isSafeInteger(span.endByte) ||
      span.startByte < 0 ||
      span.endByte < span.startByte ||
      span.endByte > bytes.length ||
      (name && (span.startByte !== 0 || span.endByte !== 0)) ||
      (content && span.endByte === span.startByte)
    )
      unbound('a secret finding cites a span outside its captured file');
    if (name) {
      names.push(fileScope(resolved.entry.sourceId, resolved.entry.relativePath));
      tokens.push(...tokensOf(resolved.entry.relativePath));
    }
    // The matched lines hold the value somewhere; every long token on them is treated as secret.
    else tokens.push(...tokensOf(bytes.subarray(span.startByte, span.endByte).toString('utf8')));
  }
  const original = String(v.originalSeverity ?? '');
  const o = observation({
    schema: 'sentinel-observation/draft-1',
    id: v.id,
    snapshotId: snapshot.id,
    producer: { kind: 'scanner', adapterId: SECRETS_ADAPTER, adapterDigest: p.adapterDigest, attemptId: ctx.attemptId },
    producerRuleId: v.producerRuleId,
    rule: { familyId: pin.familyId, revisionDigest: pin.definitionDigest as never },
    originalSeverity: (original === 'unrated' ? (ctx.severityOf.get(pin.familyId) ?? original) : original).slice(
      0,
      200,
    ),
    message: v.message,
    evidence: v.evidence.map((e: any) => ({
      location: 'withheld',
      snapshotId: e.snapshotId,
      sourceId: e.sourceId,
      entry: e.entry,
      content: e.content,
      span: { startByte: e.span.startByte, endByte: e.span.endByte },
    })),
    limitationKeys: [...v.limitationKeys],
    observedAt: v.observedAt,
  } as ObservationEnvelope);
  return { observation: o, names, tokens };
}
