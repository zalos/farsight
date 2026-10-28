// The private record a refused native run keeps (`sentinel-attempt-retained/draft-1`), built from the runner's
// `NativeFailedAttempt` when the run is refused: the record, and the bytes it links by handle (the CLI's stream, its
// session export, the instructions as delivered), each `source`. The store keeps them with the attempt's end; the
// accepted-secret withholding fold runs over the record and its links before any owner read.
import type { ArtifactId, AttemptRetainedEnvelope, RetainedLink } from '../contracts/index.js';
import { canonicalDigest, sha256Digest } from '../policy/digest.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import type { NativeFailedAttempt } from './runner.js';

export const ATTEMPT_RETAINED_SCHEMA = 'sentinel-attempt-retained/draft-1';
const TRANSCRIPT_SCHEMA = 'application/x-ndjson';
const TEXT_SCHEMA = 'text/markdown';
// The contract's bounds (contracts/review.ts AttemptRetainedEnvelope).
const MAX_ANSWER = 262144;
const MAX_TASK = 524288;
const MAX_FILES = 1024;
const MAX_TOOLS = 4096;
const MAX_PATH = 4096;
const MAX_SKILLS = 16;
const MAX_SKILL_FILES = 256;
const MAX_PACKS = 64;

/** One artifact a retained record stores: its handle, its bytes, what they are, what it links, and its privacy. */
export interface RetainedArtifact {
  readonly id: ArtifactId;
  readonly bytes: Uint8Array;
  readonly schema: string;
  readonly links: readonly ArtifactId[];
  readonly privacy: 'source';
}

/** A refused run's private record, ready for the store: the record first (its links name the rest), then the bytes. */
export interface RetainedNativeAttempt {
  readonly record: AttemptRetainedEnvelope;
  readonly artifacts: readonly RetainedArtifact[];
}

/**
 * The retained record of one refused native run. Each text and list is kept within the contract's bounds, and
 * `truncated` says when one was cut; the linked transcript holds the whole stream. The record is validated under its
 * contract before it is returned.
 */
export function retainedAttemptOf(failed: NativeFailedAttempt): RetainedNativeAttempt {
  let truncated = false;
  const cut = <T>(items: readonly T[], max: number): T[] => {
    if (items.length > max) truncated = true;
    return items.slice(0, max);
  };
  const text = (value: string, max: number): string => {
    if (value.length > max) truncated = true;
    return value.slice(0, max);
  };
  const raw = (role: RetainedLink['role'], bytes: Uint8Array, schema: string) => ({
    role,
    artifact: Object.freeze({
      id: sha256Digest(bytes) as ArtifactId,
      bytes,
      schema,
      links: Object.freeze([]),
      privacy: 'source' as const,
    }) as RetainedArtifact,
  });
  // The session export exists only when the CLI wrote one before it was stopped.
  const linked = [
    raw('transcript', failed.transcript, TRANSCRIPT_SCHEMA),
    ...(failed.share.byteLength ? [raw('share', failed.share, TEXT_SCHEMA)] : []),
    raw('instructions', failed.instructions, TEXT_SCHEMA),
  ];
  const p = failed.provenance;
  const ir = failed.instructionRecord;
  const record: AttemptRetainedEnvelope = {
    schema: ATTEMPT_RETAINED_SCHEMA,
    privacy: 'source',
    disclosure: failed.disclosure,
    withholding: failed.withholding,
    stage: ir.stage,
    failure: failed.failure,
    completed: failed.completed,
    finalAnswer: failed.finalAnswer === null ? null : text(failed.finalAnswer, MAX_ANSWER),
    filesRead: cut(failed.filesRead, MAX_FILES),
    tools: cut(failed.tools, MAX_TOOLS).map((t) => ({
      tool: text(t.tool, 200) || 'unnamed',
      path: t.path === null ? null : text(t.path, MAX_PATH),
    })),
    task: text(failed.task, MAX_TASK),
    truncated: false,
    provenance: {
      mode: p.mode,
      runner: p.runner,
      runnerVersion: p.runnerVersion ? text(p.runnerVersion, 200) : null,
      profileId: p.profileId,
      executableDigest: p.executableDigest,
      installation: p.installation
        ? { source: text(p.installation.source, 200), executablePath: p.installation.executablePath }
        : null,
      model: { ...p.model },
      promptDigest: p.promptDigest,
      skillDigests: cut(p.skillDigests, MAX_SKILLS),
      turns: p.turns,
      tokens: { ...p.tokens },
      cost: { ...p.cost },
      deadline: { ...p.deadline },
      where: p.where,
    },
    instructionRecord: {
      stage: ir.stage,
      instructions: { ref: ir.instructions.ref, digest: ir.instructions.digest },
      inputs: cut(ir.inputs, MAX_FILES).map((i) => ({ relativePath: i.relativePath, digest: i.digest })),
      task: { digest: ir.task.digest },
      skills: cut(ir.skills, MAX_SKILLS).map((k) => ({
        ref: k.ref,
        digest: k.digest,
        files: cut(k.files, MAX_SKILL_FILES).map((f) => ({ path: f.path, digest: f.digest })),
      })),
      packs: cut(ir.packs, MAX_PACKS).map((k) => ({ ref: k.ref, digest: k.digest })),
    },
    links: linked.map(({ role, artifact: a }) => ({
      role,
      handle: a.id,
      schema: a.schema,
      bytes: a.bytes.byteLength,
      privacy: 'source' as const,
    })),
  };
  record.truncated = truncated;
  const checked = validateEnvelope('attemptretained', record);
  if (!checked.ok)
    throw new Error(
      `sentinel.contract.invariant: the retained attempt record does not validate: ${checked.errors[0]?.path} ${checked.errors[0]?.message}`,
    );
  const own: RetainedArtifact = Object.freeze({
    id: canonicalDigest(record) as ArtifactId,
    bytes: canonicalJsonBytes(record),
    schema: ATTEMPT_RETAINED_SCHEMA,
    links: Object.freeze(linked.map((l) => l.artifact.id)),
    privacy: 'source',
  });
  return Object.freeze({ record, artifacts: Object.freeze([own, ...linked.map((l) => l.artifact)]) });
}
