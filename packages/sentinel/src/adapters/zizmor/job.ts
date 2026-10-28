// Building one zizmor attempt: which captured files are CI inputs zizmor supports, and the line-oriented job the
// in-container shim reads. A supported file that cannot be sent is recorded with its reason, never dropped.
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Id as sha256 } from '../../kernel/digest.js';
import type { ArtifactId } from '../../contracts/common.js';
import type { CapturedInput } from '../../execution/supervisor.js';
import { isSafeRelativePath } from '../../validate.js';
import {
  ZIZMOR_ENGINE_TIMEOUT_SECONDS,
  ZIZMOR_WORKER_BYTES,
  ZIZMOR_WORKER_DIGEST,
  type ZizmorAdapterBuild,
} from './adapter.js';
import { zizmorFail } from './errors.js';

/** A CI configuration file the adapter reads: a workflow, an action definition or a Dependabot configuration. */
export type CiFileKind = 'workflow' | 'action' | 'dependabot';

/** The kind of a captured file, by zizmor 1.31.1's collection layout. */
export function ciKindOf(relativePath: string): CiFileKind | undefined {
  const parts = relativePath.split('/');
  const base = parts.at(-1)!;
  if (!/\.ya?ml$/.test(base)) return undefined;
  if (parts.length >= 3 && parts.at(-2) === 'workflows' && parts.at(-3) === '.github') return 'workflow';
  if (base === 'action.yml' || base === 'action.yaml') return 'action';
  if ((base === 'dependabot.yml' || base === 'dependabot.yaml') && parts.at(-2) === '.github') return 'dependabot';
  return undefined;
}

const SENDABLE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const sendable = (p: string) => SENDABLE.test(p) && p.split('/').every((s) => s !== '.' && s !== '..');

/** A captured file offered to a job: its source-relative path, its artifact id and its sealed copy. */
export interface CiTarget {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly path: string;
}
/** A file the job sends to the engine, by its index in the container, its captured identity and its kind. */
export interface ZizmorJobTarget {
  readonly index: number;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: CiFileKind;
}
/** Why a file is not sent: not CI configuration, a path the container cannot carry, or a size or count bound. */
export type ZizmorUnsentReason = 'not-ci-configuration' | 'path-unsupported' | 'too-large' | 'too-many';
/** A file the job does not send, with why. */
export interface ZizmorUnsent {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: CiFileKind | null;
  readonly reason: ZizmorUnsentReason;
}

/** The job a worker runs: the targets, what it leaves out and why, and the engine's bound. */
export interface ZizmorJob {
  readonly schema: 'sentinel-zizmor-job/draft-1';
  readonly worker: string;
  readonly targets: readonly ZizmorJobTarget[];
  readonly unsent: readonly ZizmorUnsent[];
  readonly engineTimeoutSeconds: number;
}
/** A built job: the job, the digest of the file the worker reads (null when nothing runs) and the sealed inputs. */
export interface BuiltZizmorJob {
  readonly job: ZizmorJob;
  readonly jobDigest: ArtifactId | null;
  readonly inputs: readonly CapturedInput[];
}

/** The most files one attempt sends; the rest are listed as unsent (`too-many`), never dropped. */
export const MAX_ZIZMOR_TARGETS = 2_000;
/** The largest file one attempt sends; a larger one is listed as unsent (`too-large`). */
export const MAX_ZIZMOR_FILE_BYTES = 1_048_576;
/** The most bytes one attempt sends in all; past it, files are listed as unsent (`too-many`). */
export const MAX_ZIZMOR_TOTAL_BYTES = 64 * 1_048_576;

function verifiedSize(t: CiTarget): number {
  let fd: number;
  try {
    fd = openSync(t.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch {
    return zizmorFail('sentinel.zizmor.targetInvalid', `${t.relativePath}: not readable`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) zizmorFail('sentinel.zizmor.targetInvalid', `${t.relativePath}: not a regular file`);
    if (st.size > MAX_ZIZMOR_FILE_BYTES) return st.size;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size || sha256(buf) !== t.artifact)
      zizmorFail('sentinel.zizmor.targetInvalid', `${t.relativePath}: the bytes are not the captured artifact`);
    return st.size;
  } finally {
    closeSync(fd);
  }
}

/** Builds the job. With nothing to send, nothing runs. */
export function buildZizmorJob(
  targets: readonly CiTarget[],
  dir: string,
  adapter?: ZizmorAdapterBuild,
): BuiltZizmorJob {
  const seen = new Set<string>();
  for (const t of targets) {
    if (!isSafeRelativePath(t.relativePath) || seen.has(t.relativePath))
      zizmorFail('sentinel.zizmor.targetInvalid', 'each target is a distinct safe relative path');
    if (!/^sha256:[0-9a-f]{64}$/.test(t.artifact))
      zizmorFail('sentinel.zizmor.targetInvalid', `${t.relativePath}: not an artifact id`);
    seen.add(t.relativePath);
  }
  const sorted = [...targets].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  const sent: ZizmorJobTarget[] = [];
  const sentFiles: CiTarget[] = [];
  const unsent: ZizmorUnsent[] = [];
  let total = 0;
  for (const t of sorted) {
    const kind = ciKindOf(t.relativePath) ?? null;
    const skip = (reason: ZizmorUnsentReason) =>
      unsent.push({ relativePath: t.relativePath, artifact: t.artifact, kind, reason });
    if (kind === null) {
      skip('not-ci-configuration');
      continue;
    }
    if (!sendable(t.relativePath)) {
      skip('path-unsupported');
      continue;
    }
    const size = verifiedSize(t);
    if (size > MAX_ZIZMOR_FILE_BYTES) {
      skip('too-large');
      continue;
    }
    if (sent.length >= MAX_ZIZMOR_TARGETS || total + size > MAX_ZIZMOR_TOTAL_BYTES) {
      skip('too-many');
      continue;
    }
    total += size;
    sent.push({ index: sent.length, relativePath: t.relativePath, artifact: t.artifact, kind });
    sentFiles.push(t);
  }
  const worker = adapter ?? { workerBytes: ZIZMOR_WORKER_BYTES, workerDigest: ZIZMOR_WORKER_DIGEST };
  const job: ZizmorJob = Object.freeze({
    schema: 'sentinel-zizmor-job/draft-1',
    worker: worker.workerDigest,
    targets: Object.freeze(sent),
    unsent: Object.freeze(unsent),
    engineTimeoutSeconds: ZIZMOR_ENGINE_TIMEOUT_SECONDS,
  });
  if (sent.length === 0) return Object.freeze({ job, jobDigest: null, inputs: Object.freeze([]) });
  const lines = [
    'sentinel-zizmor-job/1',
    `S ${ZIZMOR_ENGINE_TIMEOUT_SECONDS}`,
    ...sent.map((t) => `T ${t.index} ${t.artifact.slice(7)} ${t.relativePath}`),
  ];
  const bytes = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const jobDigest = sha256(bytes);
  const jobPath = join(dir, 'job.txt');
  writeFileSync(jobPath, bytes, { mode: 0o600 });
  const workerPath = join(dir, 'worker.sh');
  writeFileSync(workerPath, worker.workerBytes, { mode: 0o600 });
  const inputs: CapturedInput[] = [
    { id: worker.workerDigest, path: workerPath },
    { id: jobDigest, path: jobPath },
  ];
  const ids = new Set(inputs.map((i) => i.id));
  for (const t of sentFiles)
    if (!ids.has(t.artifact)) {
      inputs.push({ id: t.artifact, path: t.path });
      ids.add(t.artifact);
    }
  return Object.freeze({ job, jobDigest, inputs: Object.freeze(inputs) });
}
