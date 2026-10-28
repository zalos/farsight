// Building one secret-scan attempt: which captured files are sent, the line-oriented job the shim reads, and the
// attempt's inputs in the order the shim relies on (shim, job, contents). A file that is not sent is an explicit
// skipped scope with its reason, never a silent omission:
// - `sentinel.secrets.fileTooLarge`: above the size limit;
// - `sentinel.secrets.pathUnsupported`: a path the job's one-line format cannot carry (a line break or other control
//   character other than a tab in a name);
// - `sentinel.secrets.toolAllowlisted`: a path the pinned default configuration's global allowlist skips — the file
//   itself, or any folder above it, since Gitleaks prunes a matching folder and everything under it unreported.
//
// Every target's name is also screened: the shim writes the names, one per line, to `scan/paths.txt` beside the tree
// (never inside it), so the pinned engine tells which names are themselves shaped like a secret. The job carries a
// sent file as `F <index> <content> <path>` and the name of a file not sent as `N <path>`; the names file is those
// paths in job order. A name too long for one line, or names too many for the engine's size limit, cannot be
// screened and is withheld from every result (normalize.ts).
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Id as sha256 } from '../../kernel/digest.js';
import { SentinelError } from '../../kernel/errors.js';
import type { ArtifactId, CatalogKey, Id } from '../../contracts/common.js';
import type { IncludedFileEntry, SnapshotEnvelope } from '../../contracts/snapshot.js';
import type { CapturedInput } from '../../execution/supervisor.js';
import { isSafeRelativePath } from '../../validate.js';
import { GITLEAKS_MAX_FILE_BYTES, GITLEAKS_PRODUCTION_BUILD, type GitleaksAdapterBuild } from './adapter.js';
import { GITLEAKS_GLOBAL_ALLOWLIST_PATHS } from './rules.js';

/** One captured file to scan: its entry in the snapshot (which names its source, path and content) and its bytes. */
export interface SecretsTarget {
  /** Index of the file's entry in `SnapshotEnvelope.entries`: an included file of this source. */
  readonly entry: number;
  /** Where the captured bytes are now; re-hashed here and again when the execution service copies them. */
  readonly path: string;
}

/** The part of the snapshot the job reads: its identity and its entries. */
export type SecretsSnapshot = Pick<SnapshotEnvelope, 'id' | 'entries'>;

/** `ordinal`: the target's place in path order over every target of the job, the basis of its opaque reference. */
/** Job records are private (the job holds paths); results cite `entry` only. */
export interface SecretsJobFile {
  readonly index: number;
  readonly ordinal: number;
  readonly entry: number;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly bytes: number;
}
/** A captured file the job does not send, by its entry, with the catalog reason why. */
export interface SecretsUnsent {
  readonly ordinal: number;
  readonly entry: number;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
  readonly reasonCode: CatalogKey;
}

/** A name the engine screens: line `line` (1-based) of `scan/paths.txt`. */
export interface SecretsJobName {
  readonly line: number;
  readonly relativePath: string;
  readonly artifact: ArtifactId;
}

/** The job a worker runs over one source of one snapshot: the files sent, what is left out and the names screened. */
export interface SecretsJob {
  readonly schema: 'sentinel-gitleaks-job/draft-1';
  readonly snapshotId: Id;
  readonly sourceId: Id;
  readonly worker: ArtifactId;
  readonly files: readonly SecretsJobFile[];
  readonly unsent: readonly SecretsUnsent[];
  /** The names the engine screens, in `scan/paths.txt` order; empty when they cannot all be screened. */
  readonly names: readonly SecretsJobName[];
  /** Whether the names were screened (they fit the engine's size limit). When false, every name is withheld. */
  readonly namesScreened: boolean;
}

/** A built job: the job, the digest of the file the shim reads and the sealed inputs the attempt needs. */
export interface BuiltSecretsJob {
  readonly job: SecretsJob;
  /** Digest of the line file the shim reads; the run record must name it. */
  readonly jobDigest: ArtifactId;
  readonly inputs: readonly CapturedInput[];
}

/** The most files one attempt sends; more is refused, never truncated. */
export const MAX_SECRETS_FILES = 100_000;
/** The prefix Gitleaks prints before each path: the shim scans `scan` from its work folder, the tree one level down. */
export const SCANNER_PATH_PREFIX = 'scan/tree/';

// A tab is carried (the report's file field is last, so it may hold tabs); every other control character is not.
// eslint-disable-next-line no-control-regex -- Job lines reject control characters except the permitted tab in paths.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
/** Whether one line of the job (and of the names file) can carry this path. */
export const lineSafe = (relativePath: string) => !CONTROL.test(relativePath);

/** The secrets job refused its inputs; `code` is a catalog key and the message is `<code>: <detail>`. */
export class SecretsInputError extends SentinelError<CatalogKey> {
  constructor(code: CatalogKey, detail: string) {
    super(code, `${code}: ${detail}`);
    this.name = 'SecretsInputError';
  }
}
const invalid = (detail: string): never => {
  throw new SecretsInputError('sentinel.secrets.inputInvalid', detail);
};

function measure(path: string): { digest: ArtifactId; bytes: number } {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) invalid('a target is not a regular file');
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, off);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      off += n;
    }
    return { digest: `sha256:${hash.digest('hex')}`, bytes: off };
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the pinned engine would skip this path: the global allowlist matches the file, or any folder above it
 * (Gitleaks prunes a matching folder whole, e.g. `images.png/token.env` or `package-lock.json/x`). Matched against
 * the paths as the engine walks them, `scan`, `scan/tree`, `scan/tree/<folder>…`, `scan/tree/<path>`.
 */
export function toolAllowlisted(relativePath: string): boolean {
  const parts = relativePath.split('/');
  const seen = [
    'scan',
    'scan/tree',
    ...parts.map((_, i) => `${SCANNER_PATH_PREFIX}${parts.slice(0, i + 1).join('/')}`),
  ];
  return seen.some((path) => GITLEAKS_GLOBAL_ALLOWLIST_PATHS.some((re) => re.test(path)));
}

/**
 * Builds one attempt's job over the targets of one source in one snapshot. Refuses, with a SecretsInputError
 * `sentinel.secrets.inputInvalid`: a missing snapshot or source id, more than {@link MAX_SECRETS_FILES} targets, a
 * target that is not an included file of that source, a duplicate entry or path, an unsafe path, a path that is also a
 * folder, and a target whose bytes do not match its artifact id. A file the engine cannot carry is listed as unsent.
 */
export function buildSecretsJob(
  scope: { snapshot: SecretsSnapshot; sourceId: Id; targets: readonly SecretsTarget[] },
  dir: string,
  adapter: GitleaksAdapterBuild = GITLEAKS_PRODUCTION_BUILD,
): BuiltSecretsJob {
  const snapshotId = scope.snapshot?.id;
  if (
    typeof snapshotId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.sourceId)
  )
    invalid('snapshot or source id');
  if (scope.targets.length > MAX_SECRETS_FILES) invalid(`at most ${MAX_SECRETS_FILES} files per attempt`);
  // Each target is an included file of this source in this snapshot; its path and digest come from the entry.
  const entries = new Set<number>();
  const resolved = scope.targets.map((t) => {
    const e = Number.isSafeInteger(t.entry) ? scope.snapshot.entries[t.entry] : undefined;
    if (!e || e.kind !== 'file' || e.disposition !== 'included' || e.sourceId !== scope.sourceId)
      invalid('a target is not an included file of this source in this snapshot');
    if (entries.has(t.entry)) invalid('duplicate target entry');
    entries.add(t.entry);
    const file = e as IncludedFileEntry;
    return { entry: t.entry, relativePath: file.relativePath, artifact: file.content, path: t.path };
  });
  const seen = new Set<string>();
  const files: SecretsJobFile[] = [];
  const unsent: SecretsUnsent[] = [];
  const sorted = [...resolved].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  for (const [ordinal, t] of sorted.entries()) {
    const entry = { entry: t.entry };
    if (!isSafeRelativePath(t.relativePath)) invalid('unsafe target path');
    if (seen.has(t.relativePath)) invalid('duplicate target path');
    seen.add(t.relativePath);
    const { digest, bytes } = measure(t.path);
    if (digest !== t.artifact) invalid('a target does not match its artifact id');
    const skip = (reasonCode: CatalogKey) =>
      unsent.push({ ordinal, relativePath: t.relativePath, artifact: t.artifact, reasonCode, ...entry });
    if (CONTROL.test(t.relativePath)) {
      skip('sentinel.secrets.pathUnsupported');
      continue;
    }
    if (bytes > GITLEAKS_MAX_FILE_BYTES) {
      skip('sentinel.secrets.fileTooLarge');
      continue;
    }
    if (toolAllowlisted(t.relativePath)) {
      skip('sentinel.secrets.toolAllowlisted');
      continue;
    }
    files.push({ index: files.length, ordinal, relativePath: t.relativePath, artifact: t.artifact, bytes, ...entry });
  }
  // A file whose path is also a folder of another cannot be rebuilt (the container's tmpfs is case-sensitive, so only
  // exact names collide); the shim would refuse the whole job, so it is refused here first.
  const folders = new Set<string>();
  for (const f of files)
    for (let i = f.relativePath.indexOf('/'); i >= 0; i = f.relativePath.indexOf('/', i + 1))
      folders.add(f.relativePath.slice(0, i));
  if (files.some((f) => folders.has(f.relativePath))) invalid('a target path is also a folder');
  // Names to screen: every sent file, then every unsent one a line can carry; all of them, or none.
  const screenable = [
    ...files.map((f) => ({ relativePath: f.relativePath, artifact: f.artifact })),
    ...unsent
      .filter((u) => !CONTROL.test(u.relativePath))
      .map((u) => ({ relativePath: u.relativePath, artifact: u.artifact })),
  ];
  const nameBytes = screenable.reduce((n, x) => n + Buffer.byteLength(x.relativePath) + 1, 0);
  // A name a line cannot carry is withheld on its own; past the engine's size limit none is screened.
  const namesScreened = nameBytes <= GITLEAKS_MAX_FILE_BYTES;
  const names: SecretsJobName[] = namesScreened ? screenable.map((x, i) => ({ line: i + 1, ...x })) : [];
  const lines = [
    'sentinel-gitleaks-job/1',
    ...files.map((f) => `F ${f.index} ${f.artifact.slice(7)} ${f.relativePath}`),
    ...(namesScreened ? unsent.filter((u) => !CONTROL.test(u.relativePath)).map((u) => `N ${u.relativePath}`) : []),
  ];
  const text = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const jobDigest = sha256(text);
  const job: SecretsJob = Object.freeze({
    schema: 'sentinel-gitleaks-job/draft-1',
    snapshotId,
    sourceId: scope.sourceId,
    worker: adapter.workerDigest,
    files: Object.freeze(files.map((f) => Object.freeze(f))),
    unsent: Object.freeze(unsent.map((u) => Object.freeze(u))),
    names: Object.freeze(names.map((n) => Object.freeze(n))),
    namesScreened,
  });
  const write = (name: string, bytes: Uint8Array) => {
    const p = join(dir, name);
    writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' });
    return p;
  };
  const inputs: CapturedInput[] = [
    { id: adapter.workerDigest, path: write('worker.sh', adapter.workerBytes) },
    { id: jobDigest, path: write('job.txt', text) },
  ];
  const known = new Set(inputs.map((i) => i.id));
  for (const f of files)
    if (!known.has(f.artifact)) {
      known.add(f.artifact);
      inputs.push({ id: f.artifact, path: sorted.find((x) => x.artifact === f.artifact)!.path });
    }
  return Object.freeze({ job, jobDigest, inputs: Object.freeze(inputs) });
}
