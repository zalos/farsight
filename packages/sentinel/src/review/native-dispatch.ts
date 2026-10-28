// A native review unit's run and publication: the admitted coordinator unit hands its sealed native stage to the
// agent runner its adopted pin names (through the provider-kind registry), and publishes what came back through the
// same prepared-outputs path a brokered review uses. The CLI's own loop ran over the unit's captured files (and the
// fold-applied upstream artifacts it was bound to); what it answered becomes cited observations, beside one native
// review record, one agent provenance record and the retained transcript and instruction record.
import { createHash } from 'node:crypto';
import type { ArtifactId, Digest, WorkRef } from '../contracts/common.js';
import type { ObservationEnvelope } from '../contracts/observation.js';
import type { ObservationEvidence } from '../contracts/common.js';
import type { AgentProvenance, StageInputBinding } from '../contracts/pipeline.js';
import type { PlanWork } from '../contracts/plan.js';
import type { PreparedOutputs } from '../execution/bootstrap.js';
import type { SentinelStore } from '../store/index.js';
import { canonicalDigest } from '../policy/digest.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import { reviewFail } from './errors.js';
import type { InstructionArtifact } from './instructions.js';
import type { NativeReviewOutput } from './native.js';
import type { ModelEnvelope } from './providers/broker.js';
import type { ProviderBinding } from './providers/profile.js';
import type { AgentRunner, NativeInstructionRecord, NativeRunResult } from './runner.js';
import type { SessionSpec } from './session.js';
import type { ReviewRuntime } from './dispatch.js';

/** The native review record's schema: what one native unit published, bound to its admitted inputs. */
export const NATIVE_REVIEW_SCHEMA = 'sentinel-native-review/draft-1';
/** An agent stage's provenance record (`contracts/pipeline.ts AgentProvenance`), as a native unit publishes it. */
export const AGENT_PROVENANCE_SCHEMA = 'sentinel-agent-provenance/draft-1';
/** The retained instruction record a native run sealed before its broker call. */
export const NATIVE_INSTRUCTIONS_SCHEMA = 'sentinel-native-instructions/draft-1';
const TRANSCRIPT_SCHEMA = 'application/x-ndjson';
const SHARE_SCHEMA = 'text/markdown';
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;

const sha = (b: Uint8Array) => ('sha256:' + createHash('sha256').update(b).digest('hex')) as ArtifactId;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const raw = (bytes: Uint8Array, schema: string, links: readonly ArtifactId[] = []): InstructionArtifact =>
  Object.freeze({ id: sha(bytes), bytes, schema, links: Object.freeze([...links]) });
const json = (value: unknown, schema: string, links: readonly ArtifactId[] = []): InstructionArtifact =>
  Object.freeze({
    id: canonicalDigest(value) as ArtifactId,
    bytes: canonicalJsonBytes(value),
    schema,
    links: Object.freeze([...links]),
  });
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** The byte span of one 1-based line (its text without the line break), or of the whole file when no line is named. */
export function lineSpan(bytes: Uint8Array, line: number | null): { startByte: number; endByte: number } {
  if (line === null) return { startByte: 0, endByte: bytes.byteLength };
  let start = 0;
  for (let n = 1; n < line; n++) {
    const nl = Buffer.from(bytes).indexOf(10, start);
    if (nl < 0) return reviewFail('sentinel.review.outputSchema', 'an observation cites a line the file does not have');
    start = nl + 1;
  }
  if (start >= bytes.byteLength && line > 1)
    return reviewFail('sentinel.review.outputSchema', 'an observation cites a line the file does not have');
  const nl = Buffer.from(bytes).indexOf(10, start);
  return { startByte: start, endByte: nl < 0 ? bytes.byteLength : nl };
}

export interface NativeReviewRun {
  readonly store: SentinelStore;
  readonly unit: Readonly<PlanWork>;
  readonly attemptId: string;
  readonly spec: SessionSpec;
  readonly runtime: ReviewRuntime;
  readonly envelope: ModelEnvelope;
  /** The current genuine binding, re-checked against the admitted selection on every read. */
  readonly binding: () => ProviderBinding;
  readonly runner: AgentRunner;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly stageInputs?: readonly StageInputBinding[];
}

/**
 * Runs one admitted native review unit and prepares its publication. The inputs are the unit's own captured files
 * (exact bytes, by content) and, under `upstream/`, the fold-applied artifacts its bindings resolved to; nothing else
 * reaches the scratch tree. A run the runner refuses throws (no output is published); its private failed-attempt
 * record stays with the error.
 */
export async function runNativeReview(r: NativeReviewRun): Promise<PreparedOutputs> {
  const { store, spec, envelope, runner } = r;
  const native = spec.native;
  if (!native || native.runner !== runner.id || !runner.modes.includes('native'))
    return reviewFail('sentinel.review.invalidInput', 'a native review runs on the runner its adopted pin names');
  store.assertHeld();
  const started = Date.now();
  const inputs: { relativePath: string; bytes: Uint8Array }[] = [];
  for (const f of spec.scope.files) {
    const bytes = await r.store.readArtifact(f.content as ArtifactId);
    if (bytes.byteLength !== f.bytes || sha(bytes) !== f.content)
      return reviewFail('sentinel.review.integrity', 'a captured input differs from its sealed content');
    inputs.push({ relativePath: f.relativePath, bytes: Uint8Array.from(bytes) });
  }
  const upstream: ArtifactId[] = [];
  let upstreamBytes = 0;
  for (const [i, b] of (r.stageInputs ?? []).entries())
    for (const [j, id] of b.artifacts.entries()) {
      const bytes = await r.store.readArtifact(id);
      if ((upstreamBytes += bytes.byteLength) > MAX_UPSTREAM_BYTES)
        return reviewFail('sentinel.review.invalidInput', 'the bound upstream artifacts exceed a native stage input');
      inputs.push({ relativePath: `upstream/${i}-${j}-${id.slice(7, 23)}.json`, bytes: Uint8Array.from(bytes) });
      upstream.push(id);
    }
  store.assertHeld();
  const remaining = Math.floor((r.deadlineAt - Date.now()) / 1000);
  if (remaining < 1) return reviewFail('sentinel.review.invalidInput', 'the unit deadline leaves no time to run');
  let sealed: NativeInstructionRecord | undefined;
  const operationId = `${spec.sessionId}:native`;
  const ran = await runner.run(
    {
      id: native.stage,
      kind: 'agent',
      mode: 'native',
      runner: native.runner,
      model: r.binding().model,
      ...(native.instructions !== undefined ? { instructions: native.instructions } : {}),
      ...(native.skills?.length ? { skills: native.skills } : {}),
      produces: native.produces,
      budget: { ...native.budget, seconds: Math.min(native.budget.seconds, remaining) },
    },
    inputs,
    {
      native: {
        broker: r.runtime.broker,
        envelope,
        binding: r.binding(),
        operationId,
        signal: r.signal,
        ...(r.runtime.trustDir !== undefined ? { trustDir: r.runtime.trustDir } : {}),
        // Sealed before anything is sent; the publication retains these exact bytes.
        retain: async (record) => void (sealed = record),
      },
    },
  );
  store.assertHeld();
  r.binding();
  if (ran.mode !== 'native' || !sealed || sealed !== ran.instructionRecord)
    return reviewFail('sentinel.review.integrity', 'the native run did not seal the record it sent');
  return publishNative(r, ran, new Map(inputs.map((i) => [i.relativePath, i.bytes])), upstream, operationId, started);
}

function publishNative(
  r: NativeReviewRun,
  ran: NativeRunResult,
  bytesOf: ReadonlyMap<string, Uint8Array>,
  upstream: readonly ArtifactId[],
  operationId: string,
  started: number,
): PreparedOutputs {
  const { unit, spec } = r;
  const native = spec.native!;
  const ended = Date.now();
  const work: WorkRef = { id: unit.id, revision: unit.revision };
  const record = ran.instructionRecord;
  // The retained private bytes: the CLI's stream, its own session export, and the instruction record it was sent.
  const transcript = raw(ran.transcript, TRANSCRIPT_SCHEMA);
  const share = ran.share.byteLength ? raw(ran.share, SHARE_SCHEMA) : null;
  const instructions = json(
    {
      schema: NATIVE_INSTRUCTIONS_SCHEMA,
      disclosure: record.disclosure,
      withholding: record.withholding,
      stage: record.stage,
      instructions: {
        ref: record.instructions.ref,
        digest: record.instructions.digest,
        bytes: b64(record.instructions.bytes),
      },
      inputs: record.inputs,
      task: record.task,
      skills: record.skills.map((k) => ({
        ref: k.ref,
        digest: k.digest,
        files: k.files.map((f) => ({ path: f.path, digest: f.digest, bytes: b64(f.bytes) })),
      })),
      packs: record.packs,
    },
    NATIVE_INSTRUCTIONS_SCHEMA,
  );
  const artifacts = [transcript, ...(share ? [share] : []), instructions];
  // Cited observations, one per answer item, each citation re-derived from the unit's captured bytes.
  const output = ran.output.value as NativeReviewOutput;
  const byPath = new Map(spec.scope.files.map((f) => [f.relativePath, f]));
  const observations: ObservationEnvelope[] = (output.observations ?? []).map((o, i) => {
    const f = byPath.get(o.path);
    const evidence: ObservationEvidence[] = [];
    if (f) {
      const bytes = bytesOf.get(o.path)!;
      evidence.push({
        snapshotId: spec.scope.snapshotId,
        sourceId: spec.scope.sourceId,
        relativePath: f.relativePath,
        content: f.content as ArtifactId,
        span: lineSpan(bytes, o.line),
      });
    }
    const obs: ObservationEnvelope = {
      schema: 'sentinel-observation/draft-1',
      id: `obs-${canonicalDigest({ session: spec.sessionId, attempt: r.attemptId, i, o }).slice(7, 39)}`,
      snapshotId: spec.scope.snapshotId,
      producer: {
        kind: 'model-review',
        adapterId: spec.adapterId,
        adapterDigest: spec.adapterDigest,
        attemptId: r.attemptId,
        model: {
          requestedModel: ran.provenance.model.requested,
          returnedModel: ran.provenance.model.reported,
          immutableRevision: null,
          source: 'host-reported',
        },
        promptDigest: (ran.provenance.promptDigest ?? record.task.digest) as Digest,
      },
      producerRuleId: spec.producerRuleId,
      ...(spec.rule ? { rule: { familyId: spec.rule.familyId, revisionDigest: spec.rule.revisionDigest } } : {}),
      originalSeverity: o.kind,
      message: o.claim.slice(0, 4000),
      evidence,
      limitationKeys: ['sentinel.review.limitation.modelClaim'],
      observedAt: stamp(ended),
    };
    const checked = validateEnvelope('observation', obs);
    if (!checked.ok)
      reviewFail(
        'sentinel.review.integrity',
        `an observation does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`,
      );
    return obs;
  });
  const observationIds = observations.map((o) => canonicalDigest(o) as ArtifactId);
  const usage = r.runtime.ledger.reservationOf(r.envelope.id, operationId);
  const confirmed = usage?.state === 'settled';
  const p = ran.provenance;
  const provenance: AgentProvenance = {
    kind: 'agent',
    stage: native.stage,
    unit: work,
    attempt: r.attemptId,
    where: 'sandboxed-cli',
    startedAt: stamp(started),
    endedAt: stamp(ended),
    durationMs: Math.max(0, ended - started),
    read: [...spec.scope.files.map((f) => f.content as ArtifactId), ...upstream].slice(0, 1024),
    wrote: [...artifacts.map((a) => a.id), ...observationIds].slice(0, 1024),
    invocation: null,
    mode: 'native',
    runner: p.runner,
    runnerVersion: p.runnerVersion,
    executableDigest: p.executableDigest,
    model: { requested: p.model.requested, reported: p.model.reported, identitySource: 'host-reported' },
    promptDigest: p.promptDigest,
    skillDigests: [...p.skillDigests],
    wires: [],
    transcript: transcript.id,
    turns: p.turns,
    tokens: {
      input: p.tokens.input,
      output: p.tokens.output,
      certainty: p.tokens.certainty === 'confirmed' ? 'confirmed' : 'unknown',
    },
    cost: p.cost,
    deadline: { grantedMs: p.deadline.grantedMs, usedMs: p.deadline.usedMs },
  };
  const provenanceId = canonicalDigest(provenance) as ArtifactId;
  const nativeRecord = {
    schema: NATIVE_REVIEW_SCHEMA,
    runId: spec.runId,
    attemptId: r.attemptId,
    work,
    sessionId: spec.sessionId,
    specDigest: unit.review!.specDigest,
    snapshotId: spec.scope.snapshotId,
    sourceId: spec.scope.sourceId,
    segmentId: unit.review!.segmentId,
    selection: unit.review!.selection,
    stage: native.stage,
    output: ran.output,
    filesRead: ran.filesRead,
    tools: ran.tools,
    secondaryModels: ran.secondaryModels,
    transcript: transcript.id,
    share: share?.id ?? null,
    instructions: instructions.id,
    packs: ran.packs,
    observations: observations.map((o) => o.id),
    provenance: provenanceId,
  };
  const links = artifacts.map((a) => a.id);
  const records: PreparedOutputs['records'] = [
    { value: nativeRecord, schema: NATIVE_REVIEW_SCHEMA, privacy: 'source-derived', links },
    { value: provenance, schema: AGENT_PROVENANCE_SCHEMA, privacy: 'source-derived', links: [transcript.id] },
    ...observations.map((value) => ({
      value,
      schema: value.schema,
      privacy: 'source-derived' as const,
      links,
    })),
  ];
  return {
    records,
    artifacts,
    outputs: records.map((x) => canonicalDigest(x.value) as ArtifactId),
    bytes:
      artifacts.reduce((n, a) => n + a.bytes.byteLength, 0) +
      records.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x.value)), 0),
    usage: confirmed
      ? { certainty: 'confirmed', inputTokens: usage!.usedInputTokens ?? 0, outputTokens: usage!.usedOutputTokens ?? 0 }
      : { certainty: 'unknown' },
  };
}
