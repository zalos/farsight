// Explicit owner-selected text only: no filesystem/plugin/vendor skill discovery or authority from copied JSON.
import { createHash } from 'node:crypto';
import type { ArtifactId, Digest } from '../contracts/common.js';
import type { InstructionContent, ReviewInstructionsEnvelope } from '../contracts/instructions.js';
import { snapshot } from '../policy/immutable.js';
import { canonicalDigest as digestOf } from '../policy/digest.js';
import { reviewFail } from './errors.js';
import type { PromptArtifact } from './prompts.js';
export const INSTRUCTION_LIMITS = Object.freeze({ contentBytes: 65536, skills: 16, resources: 32, totalBytes: 524288 });
export interface SkillSelection {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
  readonly resources?: readonly { readonly id: string; readonly revision: number; readonly text: string }[];
}
declare const brand: unique symbol;
export interface PreparedInstructions {
  readonly [brand]: true;
}
export interface InstructionArtifact {
  readonly id: ArtifactId;
  readonly bytes: Uint8Array;
  readonly schema: string;
  readonly links: readonly ArtifactId[];
}
interface State {
  manifest: ReviewInstructionsEnvelope;
  text: string;
  artifacts: readonly InstructionArtifact[];
}
const prepared = new WeakMap<object, State>(),
  ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bad = (): never => reviewFail('sentinel.review.invalidInput', 'instruction inputs exceed their fixed contract');
const sha = (b: Uint8Array) => ('sha256:' + createHash('sha256').update(b).digest('hex')) as ArtifactId;
/** Immutable data preparation. It does not authorize provider use, change tool scope, or retain bytes by itself. */
export function prepareInstructions(input: {
  readonly prompt: PromptArtifact;
  readonly skills: readonly SkillSelection[];
}): PreparedInstructions {
  if (!input || typeof input !== 'object') return bad();
  let selected: typeof input;
  try {
    const prompt = input.prompt,
      skills = input.skills;
    if (!prompt || typeof prompt !== 'object' || !Array.isArray(skills) || skills.length > INSTRUCTION_LIMITS.skills)
      return bad();
    const text = (s: unknown): string => {
      if (typeof s !== 'string' || s.length > INSTRUCTION_LIMITS.contentBytes) return bad();
      return s;
    };
    selected = {
      prompt: { id: prompt.id, version: prompt.version, text: text(prompt.text) },
      skills: skills.map((s) => {
        if (!s || typeof s !== 'object') return bad();
        const resources = s.resources ?? [];
        if (!Array.isArray(resources) || resources.length > INSTRUCTION_LIMITS.resources) return bad();
        return {
          id: s.id,
          revision: s.revision,
          text: text(s.text),
          resources: resources.map((r) => {
            if (!r || typeof r !== 'object') return bad();
            return { id: r.id, revision: r.revision, text: text(r.text) };
          }),
        };
      }),
    };
  } catch {
    return bad();
  }
  const artifacts = new Map<ArtifactId, InstructionArtifact>();
  let total = 0,
    resourceCount = 0;
  const content = (id: string, revision: number, text: string): InstructionContent => {
    if (
      typeof id !== 'string' ||
      !ID.test(id) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > 1000000 ||
      typeof text !== 'string' ||
      text.includes('\u0000')
    )
      bad();
    const bytes = Buffer.from(text, 'utf8');
    if (
      bytes.toString('utf8') !== text ||
      bytes.length > INSTRUCTION_LIMITS.contentBytes ||
      (total += bytes.length) > INSTRUCTION_LIMITS.totalBytes
    )
      bad();
    const digest = sha(bytes);
    artifacts.set(digest, { id: digest, bytes, schema: 'text/plain', links: [] });
    return { id, revision, content: digest, digest, bytes: bytes.length };
  };
  if (!Array.isArray(selected.skills) || selected.skills.length > INSTRUCTION_LIMITS.skills) bad();
  const prompt = content(selected.prompt.id, selected.prompt.version, selected.prompt.text),
    seen = new Set<string>();
  const skills = selected.skills.map((s) => {
    if (seen.has(s.id)) bad();
    seen.add(s.id);
    const base = content(s.id, s.revision, s.text),
      resources = s.resources ?? [];
    if (!Array.isArray(resources) || (resourceCount += resources.length) > INSTRUCTION_LIMITS.resources) bad();
    const names = new Set<string>();
    return {
      ...base,
      rendered: true as const,
      resources: resources.map((r) => {
        if (names.has(r.id)) bad();
        names.add(r.id);
        return content(r.id, r.revision, r.text);
      }),
    };
  });
  // Canonical framing is versioned. Text is appended verbatim; no substitution, trimming, Unicode normalization or discovery.
  const text = assemble(selected.prompt.text, selected.skills);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > INSTRUCTION_LIMITS.totalBytes) bad();
  const assembled = sha(bytes);
  artifacts.set(assembled, { id: assembled, bytes, schema: 'text/plain', links: [] });
  const body = {
    schema: 'sentinel-review-instructions/draft-1' as const,
    assembly: 'sentinel.review.instructions/1' as const,
    prompt,
    skills,
    assembled: { content: assembled, digest: assembled as Digest, bytes: bytes.length },
    vendorInstructions: 'unobserved' as const,
    vendorSkillDiscovery: 'not-performed' as const,
  };
  const manifest = snapshot({ ...body, digest: digestOf(body) as Digest });
  const token = Object.freeze({}) as PreparedInstructions;
  prepared.set(token, { manifest, text, artifacts: [...artifacts.values()] });
  return token;
}
function frame(id: string, revision: number, text: string) {
  const b = Buffer.from(text, 'utf8');
  return { id, revision, bytes: b.length, digest: sha(b) };
}
function assemble(prompt: string, skills: readonly SkillSelection[]): string {
  return [
    prompt,
    ...skills.map((s) =>
      [
        '<sentinel-selected-skill ' + JSON.stringify(frame(s.id, s.revision, s.text)) + '>',
        s.text,
        ...(s.resources ?? []).flatMap((r) => [
          '<sentinel-included-resource ' + JSON.stringify(frame(r.id, r.revision, r.text)) + '>',
          r.text,
          '</sentinel-included-resource>',
        ]),
        '</sentinel-selected-skill>',
      ].join('\n'),
    ),
  ].join('\n\n');
}
function state(handle: PreparedInstructions): State {
  const s = handle && typeof handle === 'object' ? prepared.get(handle) : undefined;
  if (!s) return reviewFail('sentinel.review.integrity', 'not a prepared instruction binding');
  return s;
}
export const instructionManifest = (handle: PreparedInstructions): ReviewInstructionsEnvelope => state(handle).manifest;
export const renderedInstructions = (handle: PreparedInstructions): string => state(handle).text;
export interface InstructionIdentity {
  readonly assembly: 'sentinel.review.instructions/1';
  readonly digest: Digest;
  readonly prompt: Readonly<{ revision: number; digest: Digest; bytes: number }>;
  readonly skills: readonly Readonly<{
    revision: number;
    digest: Digest;
    bytes: number;
    resources: readonly Readonly<{ revision: number; digest: Digest; bytes: number }>[];
  }>[];
  readonly assembled: Readonly<{ digest: Digest; bytes: number }>;
}
/** Identity data only: owner labels, paths, text and artifact lookup handles are deliberately omitted. */
export function instructionIdentity(handle: PreparedInstructions): InstructionIdentity {
  const m = state(handle).manifest,
    content = (c: InstructionContent) => ({ revision: c.revision, digest: c.digest, bytes: c.bytes });
  return snapshot({
    assembly: m.assembly,
    digest: m.digest,
    prompt: content(m.prompt),
    skills: m.skills.map((s) => ({ ...content(s), resources: s.resources.map(content) })),
    assembled: { digest: m.assembled.digest, bytes: m.assembled.bytes },
  });
}

/** Copies only private bytes belonging to this exact prepared binding; cannot read arbitrary artifact ids. */
export function instructionArtifacts(handle: PreparedInstructions): readonly InstructionArtifact[] {
  return Object.freeze(
    state(handle).artifacts.map((a) =>
      Object.freeze({ ...a, bytes: Uint8Array.from(a.bytes), links: Object.freeze([...a.links]) }),
    ),
  );
}

export interface RetainedInstructionTrace {
  readonly disclosure: 'private-only';
  readonly authority: 'accepted-coordinator-review';
  readonly record: import('../contracts/review.js').ReviewRecordEnvelope;
  readonly instructions: ReviewInstructionsEnvelope;
  readonly requests: readonly import('../contracts/instructions.js').ReviewRequestEnvelope[];
  readonly contents: readonly InstructionArtifact[];
  readonly observations: readonly import('../contracts/observation.js').ObservationEnvelope[];
}
/** Owner-only replay of this accepted review publication, never an arbitrary artifact-id/file reader or shareable view. */
export async function readPublishedInstructions(
  store: import('../store/index.js').SentinelStore,
  work: import('../contracts/common.js').WorkRef,
  options?: Readonly<{ signal?: AbortSignal; deadlineAt?: number }>,
): Promise<RetainedInstructionTrace> {
  const { boundOwner } = await import('../store/owner-binding.js'),
    { validateEnvelope } = await import('../validate.js'),
    { loadPlan } = await import('../execution/plans.js'),
    { verifyWorkEnvelope, influenceManifestOf, canonicalArtifactId } = await import('../planner/boundary.js');
  const deadlineAt = options?.deadlineAt ?? Date.now() + 20000;
  const owner = boundOwner(store),
    epoch = store.epoch;
  owner.assertHeld();
  const fence = () => {
    if (options?.signal?.aborted || Date.now() >= deadlineAt)
      reviewFail('sentinel.review.integrity', 'private trace read expired');
    owner.assertHeld();
    if (store.epoch !== epoch || boundOwner(store) !== owner)
      reviewFail('sentinel.review.integrity', 'retained instruction owner changed');
  };
  const row = store.ledger.getWork(work),
    pub = store.ledger.getPublication(work),
    attempt = pub && store.ledger.getAttempt(pub.attemptId);
  if (
    !row ||
    !pub ||
    !attempt ||
    attempt.state !== 'succeeded' ||
    row.state !== 'published' ||
    attempt.work.id !== work.id ||
    attempt.work.revision !== work.revision
  )
    return reviewFail('sentinel.review.integrity', 'not an accepted model review publication');
  const admitted = await loadPlan(store, row.runId, row.envelope.planRevision),
    unit = admitted.plan.units.find((u) => u.id === work.id && u.revision === work.revision),
    invocationId = attempt.envelope.invocation;
  fence();
  if (
    !unit?.review ||
    !invocationId ||
    attempt.envelope.worker.kind !== 'coordinator-operation' ||
    attempt.envelope.worker.adapterId !== unit.adapterId ||
    attempt.envelope.worker.adapterDigest !== unit.implementationDigest
  )
    return reviewFail('sentinel.review.integrity', 'not a fixed coordinator review operation');
  try {
    verifyWorkEnvelope(admitted.plan, row.envelope);
  } catch {
    return reviewFail('sentinel.review.integrity', 'review work differs from its exact admitted plan');
  }
  const influence = influenceManifestOf(admitted.plan, unit);
  if (canonicalArtifactId(influence) !== row.envelope.influenceManifest)
    return reviewFail('sentinel.review.integrity', 'review influence differs');
  const invocation = JSON.parse(
    new TextDecoder('utf8', { fatal: true }).decode(await store.readArtifact(invocationId)),
  );
  fence();
  if (
    invocation.format !== 'sentinel-operation-invocation/draft-1' ||
    invocation.store !== store.storeId ||
    invocation.attemptId !== attempt.id ||
    invocation.coordinatorEpoch !== attempt.epoch ||
    digestOf(invocation.work) !== digestOf({ id: work.id, revision: work.revision }) ||
    invocation.adapter?.id !== unit.adapterId ||
    invocation.adapter?.digest !== unit.implementationDigest ||
    invocation.operation !== unit.stage ||
    invocation.plan?.runId !== row.runId ||
    invocation.plan?.revision !== admitted.plan.revision ||
    invocation.plan?.digest !== admitted.plan.digest ||
    invocation.influenceManifest !== row.envelope.influenceManifest ||
    invocation.snapshotId !== admitted.plan.pins.snapshotId ||
    invocation.sourceId !== unit.sourceId
  )
    return reviewFail('sentinel.review.integrity', 'review invocation differs');
  const { policyRevision, envelopeId, admissionDigest, ...invokedReview } = invocation.review ?? {};
  if (
    digestOf(invokedReview) !== digestOf(unit.review) ||
    policyRevision !== admitted.plan.pins.policyDigest ||
    typeof envelopeId !== 'string' ||
    typeof admissionDigest !== 'string'
  )
    return reviewFail('sentinel.review.integrity', 'review admission differs');
  const admissionBytes = await store.readArtifact(admissionDigest);
  fence();
  let admission: any;
  try {
    admission = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(admissionBytes));
  } catch {
    return reviewFail('sentinel.review.integrity', 'review admission is unavailable');
  }
  const expectedIntent = {
    action: 'paid.admit',
    input: unit.review.selection.bindingDigest,
    effects: ['paid-inference', ...(unit.review.terms.disclosure === 'hosted' ? ['source-disclosure', 'network'] : [])],
    budget: unit.review.terms.budget,
    scope: { profile: null, provider: unit.review.selection.providerId, targets: [row.runId] },
  };
  if (
    !validateEnvelope('admission', admission).ok ||
    admission.action !== 'paid.admit' ||
    admission.intentDigest !== digestOf(expectedIntent) ||
    admission.policyRevision !== policyRevision ||
    admission.outcome !== 'admitted' ||
    admission.requestedBy?.principal !== 'human' ||
    admission.requestedBy?.channel !== 'owner-cli'
  )
    return reviewFail('sentinel.review.integrity', 'review admission did not permit this producer');
  if (pub.outputs.length > 512)
    return reviewFail('sentinel.review.integrity', 'retained instruction publication exceeds its bound');
  const outputs = new Map(pub.outputs.map((o) => [o.id, o])),
    cache = new Map<ArtifactId, Buffer>();
  let total = 0;
  const read = async (id: ArtifactId) => {
    if (cache.has(id)) return cache.get(id)!;
    if (!outputs.has(id))
      return reviewFail('sentinel.review.integrity', 'instruction bytes are outside this publication');
    const representations = store.ledger.objectsOf(id);
    if (
      !representations.length ||
      representations.some((r) => !Number.isSafeInteger(r.rawSize) || r.rawSize < 0) ||
      total + representations[0]!.rawSize > 8 * 1024 * 1024
    )
      return reviewFail('sentinel.review.integrity', 'retained instruction bytes exceed their bound');
    total += representations[0]!.rawSize;
    const bytes = await store.readArtifact(id);
    fence();
    cache.set(id, bytes);
    return bytes;
  };
  const json = async (id: ArtifactId) => {
    try {
      return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await read(id)));
    } catch {
      return reviewFail('sentinel.review.integrity', 'retained instruction JSON is unavailable');
    }
  };
  const recordIds = pub.outputs.filter((o) => o.schema === 'sentinel-review-record/draft-1');
  if (recordIds.length !== 1) return reviewFail('sentinel.review.integrity', 'one exact review record is required');
  const record = await json(recordIds[0]!.id),
    valid = validateEnvelope('review', record);
  if (!valid.ok || !record.instructions || record.attemptId !== attempt.id || record.runId !== row.runId)
    return reviewFail('sentinel.review.integrity', 'retained review binding differs');
  const binding = record.instructions;
  if (
    record.specDigest !== row.envelope.inputFingerprint ||
    binding.manifest !== unit.review.instructions ||
    binding.digest !== unit.review.instructionDigest ||
    binding.sourcePacket !== unit.review.sourcePacket ||
    binding.segmentId !== unit.review.segmentId ||
    digestOf(binding.selection) !== digestOf(unit.review.selection) ||
    record.snapshotId !== admitted.plan.pins.snapshotId ||
    record.sourceId !== unit.sourceId
  )
    return reviewFail('sentinel.review.integrity', 'review record changes its admitted inputs');
  const instructions = await json(binding.manifest);
  if (
    outputs.get(binding.manifest)?.schema !== 'sentinel-review-instructions/draft-1' ||
    !validateEnvelope('instructions', instructions).ok ||
    instructions.digest !== binding.digest ||
    instructions.assembled.content !== binding.assembled
  )
    return reviewFail('sentinel.review.integrity', 'retained instruction manifest differs');
  const contents: InstructionArtifact[] = [];
  for (const item of [
    instructions.prompt,
    instructions.assembled,
    ...instructions.skills.flatMap((s: any) => [s, ...s.resources]),
  ]) {
    const bytes = await read(item.content);
    if (bytes.length !== item.bytes || sha(bytes) !== item.digest)
      return reviewFail('sentinel.review.integrity', 'retained instruction text differs');
    contents.push({ id: item.content, bytes: Uint8Array.from(bytes), schema: 'text/plain', links: [] });
  }
  const decode = (id: ArtifactId) => {
    try {
      return new TextDecoder('utf8', { fatal: true }).decode(cache.get(id)!);
    } catch {
      return reviewFail('sentinel.review.integrity', 'retained instruction text is not UTF8');
    }
  };
  const selected = instructions.skills.map((s: any) => ({
    id: s.id,
    revision: s.revision,
    text: decode(s.content),
    resources: s.resources.map((r: any) => ({ id: r.id, revision: r.revision, text: decode(r.content) })),
  }));
  if (assemble(decode(instructions.prompt.content), selected) !== decode(instructions.assembled.content))
    return reviewFail('sentinel.review.integrity', 'selected instructions were not rendered exactly');
  const scope = await json(binding.sourcePacket);
  if (
    canonicalDigestFor(scope) !== binding.sourcePacket ||
    scope.snapshotId !== record.snapshotId ||
    scope.sourceId !== record.sourceId ||
    !Array.isArray(scope.files) ||
    scope.files.length > 20000
  )
    return reviewFail('sentinel.review.integrity', 'retained source packet differs');
  const captured = store.ledger.getSnapshot(record.snapshotId);
  if (!captured) return reviewFail('sentinel.review.integrity', 'retained source snapshot unavailable');
  const sizes = store.ledger.objectsOf(captured.manifest);
  if (!sizes.length || total + sizes[0]!.rawSize > 8 * 1024 * 1024)
    return reviewFail('sentinel.review.integrity', 'retained snapshot exceeds trace read bound');
  total += sizes[0]!.rawSize;
  const manifestBytes = await store.readArtifact(captured.manifest);
  fence();
  let capture: any;
  try {
    capture = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(manifestBytes));
  } catch {
    return reviewFail('sentinel.review.integrity', 'retained capture is unavailable');
  }
  if (!validateEnvelope('snapshot', capture).ok || capture.id !== record.snapshotId)
    return reviewFail('sentinel.review.integrity', 'retained snapshot differs');
  for (const f of scope.files)
    if (
      !capture.entries.some(
        (e: any) =>
          e.kind === 'file' &&
          e.disposition === 'included' &&
          e.sourceId === record.sourceId &&
          e.relativePath === f.relativePath &&
          e.content === f.content &&
          e.bytes === f.bytes,
      )
    )
      return reviewFail('sentinel.review.integrity', 'source packet contains unassigned captured bytes');
  const requests = [];
  for (const operation of record.operations) {
    if (!operation.request)
      return reviewFail('sentinel.review.integrity', 'instruction-bound operation lost its request');
    const request = await json(operation.request);
    if (
      outputs.get(operation.request)?.schema !== 'sentinel-review-request/draft-1' ||
      !validateEnvelope('reviewrequest', request).ok ||
      request.sessionId !== record.sessionId ||
      request.operationId !== operation.operationId ||
      request.specDigest !== record.specDigest ||
      request.instructionDigest !== binding.digest ||
      request.scopeDigest !== binding.sourcePacket ||
      request.runId !== record.runId ||
      request.snapshotId !== record.snapshotId ||
      request.sourceId !== record.sourceId ||
      request.segmentId !== binding.segmentId ||
      digestOf(request.selection ?? null) !== digestOf(binding.selection ?? null) ||
      request.messages[0]?.content !== new TextDecoder('utf8', { fatal: true }).decode(await read(binding.assembled))
    )
      return reviewFail('sentinel.review.integrity', 'retained request binding differs');
    requests.push(request);
  }
  const observationIds = pub.outputs.filter((o) => o.schema === 'sentinel-observation/draft-1');
  if (observationIds.length > 16)
    return reviewFail('sentinel.review.integrity', 'too many accepted model observations');
  const expectedSpec = await (await import('./plan.js')).readReviewSpec(store, unit),
    observations: import('../contracts/observation.js').ObservationEnvelope[] = [];
  fence();
  for (const output of observationIds) {
    const observation = await json(output.id);
    if (
      !validateEnvelope('observation', observation).ok ||
      !record.observations.includes(observation.id) ||
      observation.snapshotId !== record.snapshotId ||
      observation.producer.kind !== 'model-review' ||
      observation.producer.adapterId !== unit.adapterId ||
      observation.producer.adapterDigest !== unit.implementationDigest ||
      observation.producer.attemptId !== attempt.id ||
      observation.producer.promptDigest !== instructions.assembled.digest ||
      digestOf(observation.producer.model) !== digestOf(record.model) ||
      observation.producerRuleId !== expectedSpec.producerRuleId ||
      digestOf(observation.rule ?? null) !== digestOf(expectedSpec.rule ?? null)
    )
      return reviewFail('sentinel.review.integrity', 'accepted observation differs from this review');
    for (const ev of observation.evidence) {
      const file = scope.files.find((f: any) => f.relativePath === ev.relativePath && f.content === ev.content);
      if (
        ev.location !== undefined ||
        ev.snapshotId !== record.snapshotId ||
        ev.sourceId !== record.sourceId ||
        !file ||
        !ev.span ||
        ev.span === 'file' ||
        !Number.isSafeInteger(ev.span.startByte) ||
        !Number.isSafeInteger(ev.span.endByte) ||
        ev.span.startByte < 0 ||
        ev.span.endByte < ev.span.startByte ||
        ev.span.endByte > file.bytes
      )
        return reviewFail('sentinel.review.integrity', 'model evidence is outside its assigned captured scope');
      if (!cache.has(ev.content)) {
        const sizes = store.ledger.objectsOf(ev.content);
        if (!sizes.length || total + sizes[0]!.rawSize > 8388608)
          return reviewFail('sentinel.review.integrity', 'model evidence exceeds the trace read bound');
        total += sizes[0]!.rawSize;
        const bytes = await store.readArtifact(ev.content);
        fence();
        if (bytes.length !== file.bytes || sha(bytes) !== file.content)
          return reviewFail('sentinel.review.integrity', 'model citation bytes differ');
        cache.set(ev.content, bytes);
      }
    }
    observations.push(snapshot(observation));
  }
  if (
    new Set(observations.map((o) => o.id)).size !== record.observations.length ||
    record.observations.some((id: string) => !observations.some((o) => o.id === id))
  )
    return reviewFail('sentinel.review.integrity', 'accepted model observation set differs');
  fence();
  if (
    digestOf(store.ledger.getWork(work)) !== digestOf(row) ||
    digestOf(store.ledger.getAttempt(attempt.id)) !== digestOf(attempt) ||
    digestOf(store.ledger.getPublication(work)) !== digestOf(pub)
  )
    return reviewFail('sentinel.review.integrity', 'retained publication changed');
  return Object.freeze({
    disclosure: 'private-only',
    authority: 'accepted-coordinator-review',
    record: snapshot(record),
    instructions: snapshot(instructions),
    requests: snapshot(requests),
    observations: Object.freeze(observations),
    contents: Object.freeze(contents),
  });
}
const canonicalDigestFor = (value: unknown) => digestOf(value);
