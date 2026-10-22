// Building one OSV attempt: which captured files are dependency inputs, which pinned advisory snapshots apply, and the
// line-oriented job the in-container shim reads. Real relative paths stay here; the container sees an index and a
// fixed basename per file. A file whose ecosystem has no snapshot is not sent: it is an explicit `databaseAbsent` gap.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId } from '../../contracts/common.js';
import type { CapturedInput } from '../../execution/supervisor.js';
import { isSafeRelativePath } from '../../validate.js';
import { OSV_ENGINE_TIMEOUT_SECONDS, OSV_WORKER_BYTES, OSV_WORKER_DIGEST, type OsvAdapterBuild } from './adapter.js';
import { osvFail } from './errors.js';
import type { AdvisorySnapshot } from './acquire.js';

export type Ecosystem = 'npm' | 'Maven';
export type DependencyFileKind = 'npm-package-lock' | 'npm-pnpm-lock' | 'maven-pom' | 'cyclonedx-sbom';

/** The basename the container uses for each kind: the names OSV-Scanner recognizes, from a fixed list. */
export const CONTAINER_BASENAME: Readonly<Record<DependencyFileKind, string>> = Object.freeze({
  'npm-package-lock': 'package-lock.json', 'npm-pnpm-lock': 'pnpm-lock.yaml', 'maven-pom': 'pom.xml', 'cyclonedx-sbom': 'sentinel.cdx.json',
});
/** The ecosystems a kind needs a snapshot for. An SBOM can name either, so it needs both. */
export const KIND_ECOSYSTEMS: Readonly<Record<DependencyFileKind, readonly Ecosystem[]>> = Object.freeze({
  'npm-package-lock': ['npm'], 'npm-pnpm-lock': ['npm'], 'maven-pom': ['Maven'], 'cyclonedx-sbom': ['npm', 'Maven'],
});

export function dependencyKindOf(relativePath: string): DependencyFileKind | undefined {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  if (base === 'package-lock.json') return 'npm-package-lock';
  if (base === 'pnpm-lock.yaml') return 'npm-pnpm-lock';
  if (base === 'pom.xml') return 'maven-pom';
  if (base.endsWith('.cdx.json')) return 'cyclonedx-sbom';
  return undefined;
}

export interface DependencyTarget { readonly relativePath: string; readonly artifact: ArtifactId; readonly path: string }

/** A verified snapshot and where its zip is now. */
export interface SnapshotInput { readonly snapshot: AdvisorySnapshot; readonly path: string }

export interface OsvJobTarget { readonly index: number; readonly relativePath: string; readonly artifact: ArtifactId; readonly kind: DependencyFileKind }
export interface OsvUnsent { readonly relativePath: string; readonly artifact: ArtifactId; readonly kind: DependencyFileKind | null; readonly reason: 'not-dependency-file' | 'database-absent' }

export interface OsvJob {
  readonly schema: 'sentinel-osv-job/draft-1';
  readonly worker: string;
  readonly targets: readonly OsvJobTarget[];
  readonly unsent: readonly OsvUnsent[];
  readonly databases: readonly AdvisorySnapshot[];
  readonly engineTimeoutSeconds: number;
}

export interface BuiltOsvJob {
  readonly job: OsvJob;
  /** Digest of the line file the worker reads; the run record must name it. */
  readonly jobDigest: ArtifactId;
  readonly inputs: readonly CapturedInput[];
}

export const MAX_OSV_TARGETS = 1_000;
const sha256 = (b: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function digestOfFile(path: string): ArtifactId {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) osvFail('sentinel.osv.targetInvalid', 'not a regular file');
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    for (let off = 0; ;) { const n = readSync(fd, buf, 0, buf.length, off); if (!n) break; hash.update(buf.subarray(0, n)); off += n; }
    return `sha256:${hash.digest('hex')}`;
  } finally { closeSync(fd); }
}

export function buildOsvJob(targets: readonly DependencyTarget[], snapshots: readonly SnapshotInput[], dir: string, adapter?: OsvAdapterBuild): BuiltOsvJob {
  if (targets.length > MAX_OSV_TARGETS) osvFail('sentinel.osv.targetInvalid', `at most ${MAX_OSV_TARGETS} targets per attempt`);
  const byEcosystem = new Map<Ecosystem, SnapshotInput>();
  for (const s of snapshots) {
    if (byEcosystem.has(s.snapshot.ecosystem)) osvFail('sentinel.osv.snapshotInvalid', `two snapshots for ${s.snapshot.ecosystem}`);
    if (digestOfFile(s.path) !== s.snapshot.sha256) osvFail('sentinel.osv.snapshotInvalid', `the ${s.snapshot.ecosystem} snapshot does not match its digest`);
    byEcosystem.set(s.snapshot.ecosystem, s);
  }
  const seen = new Set<string>();
  const sent: OsvJobTarget[] = [];
  const unsent: OsvUnsent[] = [];
  for (const t of targets) {
    if (!isSafeRelativePath(t.relativePath)) osvFail('sentinel.osv.targetInvalid', 'unsafe target path');
    if (seen.has(t.relativePath)) osvFail('sentinel.osv.targetInvalid', 'duplicate target path');
    seen.add(t.relativePath);
    if (digestOfFile(t.path) !== t.artifact) osvFail('sentinel.osv.targetInvalid', `${t.relativePath} does not match its artifact id`);
    const kind = dependencyKindOf(t.relativePath);
    if (!kind) { unsent.push({ relativePath: t.relativePath, artifact: t.artifact, kind: null, reason: 'not-dependency-file' }); continue; }
    if (KIND_ECOSYSTEMS[kind].some(e => !byEcosystem.has(e))) { unsent.push({ relativePath: t.relativePath, artifact: t.artifact, kind, reason: 'database-absent' }); continue; }
    sent.push({ index: sent.length, relativePath: t.relativePath, artifact: t.artifact, kind });
  }
  const worker = adapter ? { bytes: adapter.workerBytes, digest: adapter.workerDigest } : { bytes: OSV_WORKER_BYTES, digest: OSV_WORKER_DIGEST };
  const lines = ['sentinel-osv-job/1', `S ${OSV_ENGINE_TIMEOUT_SECONDS}`];
  for (const [ecosystem, s] of byEcosystem) lines.push(`D ${ecosystem} ${s.snapshot.sha256.slice(7)}`);
  for (const t of sent) lines.push(`T ${t.index} ${CONTAINER_BASENAME[t.kind]} ${t.artifact.slice(7)}`);
  const text = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const jobDigest = sha256(text);
  const job: OsvJob = Object.freeze({
    schema: 'sentinel-osv-job/draft-1', worker: worker.digest, targets: Object.freeze(sent), unsent: Object.freeze(unsent),
    databases: Object.freeze([...byEcosystem.values()].map(s => s.snapshot)), engineTimeoutSeconds: OSV_ENGINE_TIMEOUT_SECONDS,
  });
  const write = (name: string, bytes: Uint8Array) => { const p = join(dir, name); writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' }); return p; };
  const inputs: CapturedInput[] = [{ id: worker.digest, path: write('worker.sh', worker.bytes) }, { id: jobDigest, path: write('job.txt', text) }];
  const known = new Set(inputs.map(i => i.id));
  for (const s of byEcosystem.values()) if (!known.has(s.snapshot.sha256)) { known.add(s.snapshot.sha256); inputs.push({ id: s.snapshot.sha256, path: s.path }); }
  for (const t of sent) if (!known.has(t.artifact)) { known.add(t.artifact); inputs.push({ id: t.artifact, path: targets.find(x => x.artifact === t.artifact)!.path }); }
  return Object.freeze({ job, jobDigest, inputs: Object.freeze(inputs) });
}
