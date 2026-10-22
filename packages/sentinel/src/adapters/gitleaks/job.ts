// Building one secret-scan attempt: which captured files are sent, the line-oriented job the shim reads, and the
// attempt's inputs in the order the shim relies on (shim, job, contents). A file that is not sent is an explicit
// skipped scope with its reason, never a silent omission:
// - `sentinel.secrets.fileTooLarge`: above the size limit;
// - `sentinel.secrets.pathUnsupported`: a path the job's one-line format cannot carry (a line break or other control
//   character other than a tab in a name);
// - `sentinel.secrets.toolAllowlisted`: a path the pinned default configuration's global allowlist skips.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactId, CatalogKey, Id } from '../../contracts/common.js';
import type { CapturedInput } from '../../execution/supervisor.js';
import { isSafeRelativePath } from '../../validate.js';
import { GITLEAKS_MAX_FILE_BYTES, GITLEAKS_PRODUCTION_BUILD, type GitleaksAdapterBuild } from './adapter.js';
import { GITLEAKS_GLOBAL_ALLOWLIST_PATHS } from './rules.js';

export interface SecretsTarget {
  /** Source-relative path as captured. */
  readonly relativePath: string;
  /** The captured content's digest. */
  readonly artifact: ArtifactId;
  /** Where the captured bytes are now; re-hashed here and again when the execution service copies them. */
  readonly path: string;
}

export interface SecretsJobFile { readonly index: number; readonly relativePath: string; readonly artifact: ArtifactId; readonly bytes: number }
export interface SecretsUnsent { readonly relativePath: string; readonly artifact: ArtifactId; readonly reasonCode: CatalogKey }

export interface SecretsJob {
  readonly schema: 'sentinel-gitleaks-job/draft-1';
  readonly snapshotId: Id;
  readonly sourceId: Id;
  readonly worker: ArtifactId;
  readonly files: readonly SecretsJobFile[];
  readonly unsent: readonly SecretsUnsent[];
}

export interface BuiltSecretsJob {
  readonly job: SecretsJob;
  /** Digest of the line file the shim reads; the run record must name it. */
  readonly jobDigest: ArtifactId;
  readonly inputs: readonly CapturedInput[];
}

export const MAX_SECRETS_FILES = 100_000;
/** The prefix Gitleaks prints before each path: the shim scans `scan` from its work folder, the tree one level down. */
export const SCANNER_PATH_PREFIX = 'scan/tree/';

const sha256 = (b: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(b).digest('hex')}`;
// A tab is carried (the report's file field is last, so it may hold tabs); every other control character is not.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export class SecretsInputError extends Error {
  constructor(readonly code: CatalogKey, detail: string) { super(`${code}: ${detail}`); }
}
const invalid = (detail: string): never => { throw new SecretsInputError('sentinel.secrets.inputInvalid', detail); };

function measure(path: string): { digest: ArtifactId; bytes: number } {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) invalid('a target is not a regular file');
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    let off = 0;
    for (;;) { const n = readSync(fd, buf, 0, buf.length, off); if (!n) break; hash.update(buf.subarray(0, n)); off += n; }
    return { digest: `sha256:${hash.digest('hex')}`, bytes: off };
  } finally { closeSync(fd); }
}

/** Whether the pinned default configuration's global allowlist skips this path. */
export function toolAllowlisted(relativePath: string): boolean {
  const seen = `${SCANNER_PATH_PREFIX}${relativePath}`;
  return GITLEAKS_GLOBAL_ALLOWLIST_PATHS.some(re => re.test(seen));
}

export function buildSecretsJob(scope: { snapshotId: Id; sourceId: Id; targets: readonly SecretsTarget[] }, dir: string,
  adapter: GitleaksAdapterBuild = GITLEAKS_PRODUCTION_BUILD): BuiltSecretsJob {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.snapshotId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.sourceId)) invalid('snapshot or source id');
  if (scope.targets.length > MAX_SECRETS_FILES) invalid(`at most ${MAX_SECRETS_FILES} files per attempt`);
  const seen = new Set<string>();
  const files: SecretsJobFile[] = [];
  const unsent: SecretsUnsent[] = [];
  const sorted = [...scope.targets].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const t of sorted) {
    if (!isSafeRelativePath(t.relativePath)) invalid('unsafe target path');
    if (seen.has(t.relativePath)) invalid('duplicate target path');
    seen.add(t.relativePath);
    const { digest, bytes } = measure(t.path);
    if (digest !== t.artifact) invalid('a target does not match its artifact id');
    const skip = (reasonCode: CatalogKey) => unsent.push({ relativePath: t.relativePath, artifact: t.artifact, reasonCode });
    if (CONTROL.test(t.relativePath)) { skip('sentinel.secrets.pathUnsupported'); continue; }
    if (bytes > GITLEAKS_MAX_FILE_BYTES) { skip('sentinel.secrets.fileTooLarge'); continue; }
    if (toolAllowlisted(t.relativePath)) { skip('sentinel.secrets.toolAllowlisted'); continue; }
    files.push({ index: files.length, relativePath: t.relativePath, artifact: t.artifact, bytes });
  }
  // A file whose path is also a folder of another cannot be rebuilt (the container's tmpfs is case-sensitive, so only
  // exact names collide); the shim would refuse the whole job, so it is refused here first.
  const folders = new Set<string>();
  for (const f of files) for (let i = f.relativePath.indexOf('/'); i >= 0; i = f.relativePath.indexOf('/', i + 1)) folders.add(f.relativePath.slice(0, i));
  if (files.some(f => folders.has(f.relativePath))) invalid('a target path is also a folder');
  const lines = ['sentinel-gitleaks-job/1', ...files.map(f => `F ${f.index} ${f.artifact.slice(7)} ${f.relativePath}`)];
  const text = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const jobDigest = sha256(text);
  const job: SecretsJob = Object.freeze({
    schema: 'sentinel-gitleaks-job/draft-1', snapshotId: scope.snapshotId, sourceId: scope.sourceId, worker: adapter.workerDigest,
    files: Object.freeze(files.map(f => Object.freeze(f))), unsent: Object.freeze(unsent.map(u => Object.freeze(u))),
  });
  const write = (name: string, bytes: Uint8Array) => { const p = join(dir, name); writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' }); return p; };
  const inputs: CapturedInput[] = [{ id: adapter.workerDigest, path: write('worker.sh', adapter.workerBytes) }, { id: jobDigest, path: write('job.txt', text) }];
  const known = new Set(inputs.map(i => i.id));
  for (const f of files) if (!known.has(f.artifact)) { known.add(f.artifact); inputs.push({ id: f.artifact, path: sorted.find(x => x.artifact === f.artifact)!.path }); }
  return Object.freeze({ job, jobDigest, inputs: Object.freeze(inputs) });
}
