// Building one Trivy attempt: which captured files are configuration inputs, whether the pinned checks bundle is
// there, and the line-oriented job the in-container shim reads. A file the engine would read but that cannot be sent
// (an unsupported name, too large, past the target bound, or no bundle) is recorded with its reason, never dropped.
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Id as sha256 } from '../../kernel/digest.js';
import type { ArtifactId } from '../../contracts/common.js';
import type { CapturedInput } from '../../execution/supervisor.js';
import { isSafeRelativePath } from '../../validate.js';
import {
  TRIVY_CHECKS_BUNDLE,
  TRIVY_ENGINE_TIMEOUT_SECONDS,
  TRIVY_WORKER_BYTES,
  TRIVY_WORKER_DIGEST,
  type TrivyAdapterBuild,
  type TrivyConfigType,
} from './adapter.js';
import type { ChecksBundle } from './bundle.js';
import { trivyFail } from './errors.js';

/** What the engine would make of a captured file, by Trivy 0.76.1's own name rules. */
export type TrivyFileKind = TrivyConfigType | 'kubernetes-candidate' | 'terraform-variables';

const TYPE_OF: Record<Exclude<TrivyFileKind, 'terraform-variables'>, TrivyConfigType> = {
  dockerfile: 'dockerfile',
  kubernetes: 'kubernetes',
  'kubernetes-candidate': 'kubernetes',
  terraform: 'terraform',
};

/**
 * The kind of a captured file. Dockerfiles follow the engine's rule (`Dockerfile`/`Containerfile` with any extension,
 * or that word as the extension, case-insensitively); Kubernetes manifests are YAML the engine still has to recognize.
 */
export function trivyKindOf(relativePath: string): TrivyFileKind | undefined {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  for (const word of ['dockerfile', 'containerfile']) {
    if (base.toLowerCase() === word + ext.toLowerCase() || ext.toLowerCase() === `.${word}`) return 'dockerfile';
  }
  if (base.endsWith('.tf') || base.endsWith('.tf.json')) return 'terraform';
  if (base.endsWith('.tfvars') || base.endsWith('.tfvars.json')) return 'terraform-variables';
  if (/\.ya?ml$/i.test(base)) return 'kubernetes-candidate';
  return undefined;
}

/** The engine reads only these path characters here; a segment that is empty, `.` or `..` is never sent. */
const SENDABLE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const sendable = (p: string) => SENDABLE.test(p) && p.split('/').every((s) => s !== '.' && s !== '..');
/** Downloaded Terraform modules are a dependency cache, not the repository's configuration. */
const inCache = (p: string) => p.split('/').includes('.terraform');

/** A captured file offered to a job: its source-relative path, its artifact id and its sealed copy. */
export interface ConfigTarget {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly path: string;
}
/** A verified bundle and where its archive is now. */
export interface BundleInput {
  readonly bundle: ChecksBundle;
  readonly path: string;
}

/** A file the job sends to the engine, by its index in the container, its captured identity and its kind. */
export interface TrivyJobTarget {
  readonly index: number;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: TrivyFileKind;
  readonly type: TrivyConfigType;
}
/**
 * Why a file is not sent: not configuration, a dependency cache, a variables file, a path, size or count bound, or no
 * bundle.
 */
export type TrivyUnsentReason =
  | 'not-configuration'
  | 'dependency-cache'
  | 'variables-file'
  | 'path-unsupported'
  | 'too-large'
  | 'too-many'
  | 'bundle-missing';
/** A file the job does not send, with why. */
export interface TrivyUnsent {
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly kind: TrivyFileKind | null;
  readonly reason: TrivyUnsentReason;
}

/** The job a worker runs: the pinned bundle, the targets, what it leaves out and why, and the engine's bound. */
export interface TrivyJob {
  readonly schema: 'sentinel-trivy-job/draft-1';
  readonly worker: string;
  readonly bundle: ChecksBundle | null;
  readonly targets: readonly TrivyJobTarget[];
  readonly unsent: readonly TrivyUnsent[];
  readonly engineTimeoutSeconds: number;
}

/** A built job: the job, the digest of the file the worker reads (null when nothing runs) and the sealed inputs. */
export interface BuiltTrivyJob {
  readonly job: TrivyJob;
  /** Digest of the line file the worker reads; the run record must name it. Null when nothing is run. */
  readonly jobDigest: ArtifactId | null;
  readonly inputs: readonly CapturedInput[];
}

/** The most files one attempt sends; the rest are listed as unsent (`too-many`), never dropped. */
export const MAX_TRIVY_TARGETS = 2_000;
/** The largest file one attempt sends; a larger one is listed as unsent (`too-large`). */
export const MAX_TRIVY_FILE_BYTES = 1_048_576;
/** The most bytes one attempt sends in all; past it, files are listed as unsent (`too-many`). */
export const MAX_TRIVY_TOTAL_BYTES = 64 * 1_048_576;

/** Hashes a captured file without following a link; refuses one that is not the artifact it claims to be. */
function verifiedSize(t: ConfigTarget): number {
  let fd: number;
  try {
    fd = openSync(t.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch {
    return trivyFail('sentinel.trivy.targetInvalid', `${t.relativePath}: not readable`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) trivyFail('sentinel.trivy.targetInvalid', `${t.relativePath}: not a regular file`);
    if (st.size > MAX_TRIVY_FILE_BYTES) return st.size;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size || sha256(buf) !== t.artifact)
      trivyFail('sentinel.trivy.targetInvalid', `${t.relativePath}: the bytes are not the captured artifact`);
    return st.size;
  } finally {
    closeSync(fd);
  }
}

/**
 * Builds the job. `dir` receives the job file; inputs are the worker, the bundle, the job and each sent file. With no
 * bundle nothing is sent and nothing runs: every configuration file is a `bundle-missing` gap.
 */
export function buildTrivyJob(
  targets: readonly ConfigTarget[],
  bundle: BundleInput | null,
  dir: string,
  adapter?: TrivyAdapterBuild,
): BuiltTrivyJob {
  const seen = new Set<string>();
  for (const t of targets) {
    if (!isSafeRelativePath(t.relativePath) || seen.has(t.relativePath))
      trivyFail('sentinel.trivy.targetInvalid', 'each target is a distinct safe relative path');
    if (!/^sha256:[0-9a-f]{64}$/.test(t.artifact))
      trivyFail('sentinel.trivy.targetInvalid', `${t.relativePath}: not an artifact id`);
    seen.add(t.relativePath);
  }
  if (
    bundle &&
    (bundle.bundle.layer !== TRIVY_CHECKS_BUNDLE.layer || bundle.bundle.manifest !== TRIVY_CHECKS_BUNDLE.manifest)
  ) {
    trivyFail('sentinel.trivy.bundleInvalid', 'only the pinned checks bundle is accepted');
  }
  const sorted = [...targets].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  const sent: TrivyJobTarget[] = [];
  const sentFiles: ConfigTarget[] = [];
  const unsent: TrivyUnsent[] = [];
  let total = 0;
  for (const t of sorted) {
    const kind = trivyKindOf(t.relativePath) ?? null;
    const skip = (reason: TrivyUnsentReason) =>
      unsent.push({ relativePath: t.relativePath, artifact: t.artifact, kind, reason });
    if (kind === null) {
      skip('not-configuration');
      continue;
    }
    if (inCache(t.relativePath)) {
      skip('dependency-cache');
      continue;
    }
    if (kind === 'terraform-variables') {
      skip('variables-file');
      continue;
    }
    if (!sendable(t.relativePath)) {
      skip('path-unsupported');
      continue;
    }
    const size = verifiedSize(t);
    if (size > MAX_TRIVY_FILE_BYTES) {
      skip('too-large');
      continue;
    }
    if (sent.length >= MAX_TRIVY_TARGETS || total + size > MAX_TRIVY_TOTAL_BYTES) {
      skip('too-many');
      continue;
    }
    if (!bundle) {
      skip('bundle-missing');
      continue;
    }
    total += size;
    sent.push({ index: sent.length, relativePath: t.relativePath, artifact: t.artifact, kind, type: TYPE_OF[kind] });
    sentFiles.push(t);
  }
  const worker = adapter ?? { workerBytes: TRIVY_WORKER_BYTES, workerDigest: TRIVY_WORKER_DIGEST };
  const job: TrivyJob = Object.freeze({
    schema: 'sentinel-trivy-job/draft-1',
    worker: worker.workerDigest,
    bundle: bundle?.bundle ?? null,
    targets: Object.freeze(sent),
    unsent: Object.freeze(unsent),
    engineTimeoutSeconds: TRIVY_ENGINE_TIMEOUT_SECONDS,
  });
  if (!bundle || sent.length === 0) return Object.freeze({ job, jobDigest: null, inputs: Object.freeze([]) });
  const lines = [
    'sentinel-trivy-job/1',
    `S ${TRIVY_ENGINE_TIMEOUT_SECONDS}`,
    `B ${bundle.bundle.layer.slice(7)}`,
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
    { id: bundle.bundle.layer, path: bundle.path },
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
