// Capture: enumerate the authorised sources into one immutable inventory, then pin, store and admit it through the
// store facade. Order (each step completes before the next):
//
//   1. enumerate every source and hash every included file (no byte is stored yet);
//   2. build the snapshot envelope and its materialization sidecar, and check the envelope against its contract;
//   3. register every artifact as unbound staging (source bytes in batches, then the manifest and the sidecar)
//      before a byte is written;
//   4. write the source bytes, each re-read and re-hashed against the inventory;
//   5. working copy only: enumerate again; any difference discards the attempt (stages aborted) and retries;
//   6. write the manifest and the sidecar, then admit the snapshot: one ledger transaction re-verifies every
//      object, records the snapshot and releases every stage.
//
// A failure before admission aborts every stage it registered: the bytes written become unreferenced and wait for
// an explicit prune. Nothing here opens the ledger database or the owner lock; it uses the facade only.
import { withAdmissionFence } from '../store/admission-fence.js';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { ArtifactId, CaptureEntry, Id, SnapshotEnvelope, SnapshotSource } from '../contracts/index.js';
import { MAX_ENVELOPE_BYTES } from '../contracts/index.js';
import { MAX_ARTIFACT_BYTES } from '../store/store-types.js';
import type { SentinelStore, SnapshotRecord, StoredObject } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { heldStoreRoot, type HeldStoreRoot } from '../store/owner-binding.js';
import { hasIdentity } from '../store/paths.js';
import { validateEnvelope } from '../validate.js';
import { enumerateCommit, trackedBlobs, type SubmoduleRequest } from './committed.js';
import { SnapshotError } from './errors.js';
import { GitReadBudget, GitReadError, GitRepository } from './git.js';
import { CaptureChanged, Inventory } from './inventory.js';
import {
  MATERIALIZATION_SCHEMA,
  inventoryDigestOf,
  materializationSources,
  type Materialization,
  type MaterializedSource,
} from './materialization.js';
import { digestOf, isRecordablePath, resolvePolicy, type CapturePolicy } from './policy.js';
import { enumerateWorktree } from './worktree.js';
import { sha256Hex } from '../kernel/digest.js';

/** What a capture reads: a committed tree (from Git objects, never the checkout) or the working copy as it is. */
export type CaptureModeRequest = 'committed-tree' | 'working-copy';

/** One source to capture: its id, a stable repository name, the owner-authorised root and committed-tree options. */
export interface CaptureSourceRequest {
  readonly sourceId: Id;
  /** A stable identity for the repository (a remote URL or a local name). Never resolved or contacted. */
  readonly repositoryId: string;
  /** The canonical absolute folder the owner authorised. */
  readonly root: string;
  /** Committed-tree only: `HEAD` (default), a full ref name or a full commit id. */
  readonly revision?: string;
  /** A Git directory outside `root` (a linked worktree's), permitted explicitly. */
  readonly gitDir?: string;
  /** The common Git directory a linked worktree's Git directory names, permitted explicitly (with `gitDir`). */
  readonly commonDir?: string;
  /** A local Git LFS object folder the capture may read pointer content from. Nothing is downloaded. */
  readonly lfsObjects?: string;
  /** Committed-tree only: submodules to capture as their own sources, from local clones. */
  readonly submodules?: readonly SubmoduleRequest[];
}

/** One capture: its mode, its sources, the capture policy and the stage size, with test seams for the clock. */
export interface CaptureRequest {
  readonly mode: CaptureModeRequest;
  readonly sources: readonly CaptureSourceRequest[];
  readonly policy?: Partial<CapturePolicy>;
  /** Defaults to the system clock. */
  readonly now?: () => string;
  /** Source artifacts per stage, 1..4096 (default 4096, the ledger's per-stage limit). */
  readonly stageSize?: number;
  /** Called after every stage is registered and before the first byte is written (a test seam; no effect). */
  readonly onStaged?: (stageIds: readonly string[]) => void;
}

/** A published capture: the snapshot envelope, its ledger record, its stored manifest and materialization. */
export interface CaptureResult {
  readonly snapshot: SnapshotEnvelope;
  /** The ledger's record of the admitted snapshot. */
  readonly record: SnapshotRecord;
  /** The stored snapshot manifest. */
  readonly artifact: StoredObject;
  readonly materialization: Materialization;
  /** How many times the working copy was read before it held still (1 for a committed tree). */
  readonly attempts: number;
}

/** The facade operations capture uses. Satisfied by `SentinelStore`. */
export type CaptureStore = Pick<SentinelStore, 'storePath' | 'objects' | 'ledger' | 'assertHeld'>;

/** The ledger's per-stage limit. */
const STAGE_LIMIT = 4096;
const CAPTURE_IMPLEMENTATION = 'sentinel-capture/1';

const canonical = (path: string, what: string): string => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new SnapshotError('sentinel.capture.rootNotCanonical', what);
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new SnapshotError('sentinel.capture.rootUnreadable', what);
  }
  if (real !== path) throw new SnapshotError('sentinel.capture.rootNotCanonical', what);
  return real;
};

function checkRequest(request: CaptureRequest): CapturePolicy {
  const bad = (detail: string): never => {
    throw new SnapshotError('sentinel.capture.invalidRequest', detail);
  };
  if (!request || typeof request !== 'object') bad('no request');
  if (request.mode !== 'committed-tree' && request.mode !== 'working-copy')
    bad('mode must be committed-tree or working-copy');
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 64)
    bad('1..64 sources');
  if (request.onStaged !== undefined && typeof request.onStaged !== 'function') bad('onStaged must be a function');
  const ids = new Set<string>();
  for (const s of request.sources) {
    if (!s || typeof s.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s.sourceId))
      bad('a source id is not a valid id');
    if (ids.has(s.sourceId)) bad(`source ${s.sourceId} is listed twice`);
    ids.add(s.sourceId);
    if (typeof s.repositoryId !== 'string' || s.repositoryId.length < 1 || s.repositoryId.length > 512)
      bad(`${s.sourceId}: repositoryId`);
    canonical(s.root, s.sourceId);
    if (s.lfsObjects !== undefined) canonical(s.lfsObjects, `${s.sourceId} lfsObjects`);
    if (s.gitDir !== undefined) canonical(s.gitDir, `${s.sourceId} gitDir`);
    if (s.commonDir !== undefined) canonical(s.commonDir, `${s.sourceId} commonDir`);
    if (request.mode === 'working-copy' && (s.revision !== undefined || (s.submodules?.length ?? 0) > 0)) {
      bad(`${s.sourceId}: revision and submodules apply to committed-tree capture only`);
    }
    const paths = new Set<string>();
    for (const sub of s.submodules ?? []) {
      // The same checks a primary source gets, all before anything is read.
      if (!sub || typeof sub.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sub.sourceId))
        bad(`${s.sourceId}: a submodule source id is not a valid id`);
      if (ids.has(sub.sourceId)) bad(`source ${sub.sourceId} is listed twice`);
      ids.add(sub.sourceId);
      if (typeof sub.repositoryId !== 'string' || sub.repositoryId.length < 1 || sub.repositoryId.length > 512)
        bad(`${sub.sourceId}: repositoryId`);
      if (typeof sub.path !== 'string' || !isRecordablePath(sub.path) || paths.has(sub.path))
        bad(`${sub.sourceId}: the submodule path is not a safe, unique path`);
      paths.add(sub.path);
      canonical(sub.root, sub.sourceId);
      if (sub.lfsObjects !== undefined) canonical(sub.lfsObjects, `${sub.sourceId} lfsObjects`);
      if (sub.gitDir !== undefined) canonical(sub.gitDir, `${sub.sourceId} gitDir`);
      if (sub.commonDir !== undefined) canonical(sub.commonDir, `${sub.sourceId} commonDir`);
    }
  }
  if (
    request.stageSize !== undefined &&
    (!Number.isSafeInteger(request.stageSize) || request.stageSize < 1 || request.stageSize > STAGE_LIMIT)
  ) {
    bad(`stageSize must be 1..${STAGE_LIMIT}`);
  }
  try {
    return resolvePolicy(request.policy);
  } catch (e) {
    return bad((e as Error).message);
  }
}

/**
 * The held store as this source's walk sees it. A working copy excludes the store only at its exact canonical folder
 * with the identity it was acquired with; a source that is the store, lies inside it, or reaches it under another
 * name is refused. A look-alike store (anything openStore() did not return) has no held root and exempts nothing.
 */
function storeBoundary(root: string, held: HeldStoreRoot | undefined): HeldStoreRoot | undefined {
  if (!held) return undefined;
  if (root === held.path || root.startsWith(held.path + sep)) {
    throw new SnapshotError('sentinel.capture.invalidRequest', 'a source root cannot be the store or lie inside it');
  }
  if (hasIdentity(root, held.identity))
    throw new SnapshotError('sentinel.capture.storeAliased', 'the source root is the store under another name');
  return held;
}

/** The Git directories a source explicitly permits outside its root, as the reader's options. */
const gitGrants = (s: { gitDir?: string; commonDir?: string }) => ({
  ...(s.gitDir === undefined ? {} : { gitDir: s.gitDir }),
  ...(s.commonDir === undefined ? {} : { commonDir: s.commonDir }),
});

function openRepo(root: string, grants: { gitDir?: string; commonDir?: string }, budget: GitReadBudget): GitRepository {
  try {
    return GitRepository.open(root, { ...grants, budget });
  } catch (e) {
    if (e instanceof GitReadError && e.code === 'unsupported')
      throw new SnapshotError('sentinel.capture.gitUnsupported', e.message);
    throw new SnapshotError('sentinel.capture.notRepository', e instanceof Error ? e.message : '');
  }
}

function gitFailure(e: unknown): never {
  if (e instanceof GitReadError) {
    if (e.code === 'unsupported') throw new SnapshotError('sentinel.capture.gitUnsupported', e.message);
    throw new SnapshotError('sentinel.capture.revisionUnresolved', e.message);
  }
  throw e;
}

/** `repos` stay open while their read closures may still run; the caller closes them. */
interface Enumerated {
  readonly inv: Inventory;
  readonly sources: SnapshotSource[];
  readonly repos: GitRepository[];
}

/** What a stability recheck compares: entries, sources (without times) and the sidecar facts. */
function fingerprint(e: Enumerated): string {
  const entries = [...e.inv.entries].sort(compareEntries);
  return JSON.stringify({
    entries,
    sources: e.sources.map(({ capturedAt: _t, ...r }) => r),
    materialization: materializationSources(
      e.inv,
      e.sources.map((s) => s.sourceId),
      entries,
    ),
  });
}

function enumerate(
  request: CaptureRequest,
  policy: CapturePolicy,
  store: CaptureStore,
  now: () => string,
  budget: GitReadBudget,
  stillWithin: () => void,
): Enumerated {
  stillWithin();
  const inv = new Inventory(policy);
  const sources: SnapshotSource[] = [];
  const repos: GitRepository[] = [];
  // Resolved, and the hold checked, once per enumeration; the walk checks it again at the store's folder.
  const held = heldStoreRoot(store);
  try {
    for (const s of request.sources) {
      stillWithin();
      const root = canonical(s.root, s.sourceId);
      const st = lstatSync(root);
      if (!st.isDirectory()) throw new SnapshotError('sentinel.capture.rootUnreadable', s.sourceId);
      const storeHeld = storeBoundary(root, held);
      if (request.mode === 'committed-tree') {
        const repo = openRepo(root, gitGrants(s), budget);
        repos.push(repo);
        let commit: string;
        let found;
        try {
          commit = repo.resolveCommit(s.revision ?? 'HEAD');
          found = enumerateCommit(inv, {
            sourceId: s.sourceId,
            repo,
            commit,
            lfsObjects: s.lfsObjects,
            submodules: s.submodules ?? [],
            stillWithin,
          });
        } catch (e) {
          if (e instanceof CaptureChanged || e instanceof SnapshotError) throw e;
          return gitFailure(e);
        }
        sources.push({ sourceId: s.sourceId, repositoryId: s.repositoryId, commit, dirty: false, capturedAt: now() });
        for (const sub of found) {
          const subRoot = canonical(sub.request.root, sub.request.sourceId);
          const subRepo = openRepo(subRoot, gitGrants(sub.request), budget);
          repos.push(subRepo);
          let present = false;
          try {
            present = subRepo.readObject(sub.commit, 64 * 1024 * 1024)?.type === 'commit';
          } catch {
            present = false;
          }
          const marker = inv.entries.findIndex(
            (e) => e.sourceId === s.sourceId && e.relativePath === sub.request.path && e.kind === 'directory-boundary',
          );
          if (!present) {
            if (marker >= 0)
              inv.entries[marker] = {
                sourceId: s.sourceId,
                relativePath: sub.request.path,
                kind: 'directory-boundary',
                disposition: 'unreadable',
                reasonCode: 'sentinel.capture.submoduleCommitMissing',
                knownDescendants: null,
              };
            continue;
          }
          try {
            enumerateCommit(inv, {
              sourceId: sub.request.sourceId,
              repo: subRepo,
              commit: sub.commit,
              lfsObjects: sub.request.lfsObjects,
              submodules: [],
              stillWithin,
            });
          } catch (e) {
            if (e instanceof CaptureChanged || e instanceof SnapshotError) throw e;
            return gitFailure(e);
          }
          sources.push({
            sourceId: sub.request.sourceId,
            repositoryId: sub.request.repositoryId,
            commit: sub.commit,
            dirty: false,
            capturedAt: now(),
          });
        }
      } else {
        let repo: GitRepository | undefined;
        // A repository the reader refuses (unsafe layout, unsupported format, over budget) names no commit: the copy
        // is then recorded with commit null and dirty true, never claimed clean.
        try {
          repo = GitRepository.open(root, { ...gitGrants(s), budget });
        } catch {
          repo = undefined;
        }
        if (repo) repos.push(repo);
        let commit: string | null = null;
        if (repo) {
          try {
            commit = repo.resolveCommit('HEAD');
          } catch {
            commit = null;
          }
        }
        const start = inv.entries.length;
        enumerateWorktree(inv, { sourceId: s.sourceId, root, store: storeHeld, lfsObjects: s.lfsObjects, stillWithin });
        const dirty =
          commit === null || repo === undefined
            ? true
            : differsFromCommit(repo, commit, s.sourceId, inv.entries.slice(start), inv, stillWithin);
        sources.push({ sourceId: s.sourceId, repositoryId: s.repositoryId, commit, dirty, capturedAt: now() });
      }
    }
  } catch (e) {
    for (const r of repos) r.close();
    throw e;
  }
  inv.refuseCaseCollisions();
  return { inv, sources, repos };
}

/**
 * Whether a working copy is anything but its commit: true unless every tracked file was captured with the same Git
 * blob id and the same executable bit, every tracked link is a link whose target hashes to the committed blob, and
 * nothing else was captured. Anything that cannot be compared (a tracked file excluded, too large or unreadable; a
 * link target not recorded) counts as a difference.
 */
function differsFromCommit(
  repo: GitRepository,
  commit: string,
  sourceId: string,
  entries: readonly CaptureEntry[],
  inv: Inventory,
  stillWithin: () => void,
): boolean {
  const tracked = trackedBlobs(repo, commit, stillWithin);
  if (!tracked) return true;
  const gitlinks = [...tracked].filter(([, v]) => v.startsWith('160000:')).map(([p]) => p);
  const underGitlink = (p: string) => gitlinks.some((g) => p === g || p.startsWith(`${g}/`));
  const captured = new Map<string, CaptureEntry>();
  for (const e of entries) {
    if ((e.kind === 'file' && e.disposition === 'included') || e.kind === 'symlink') {
      if (!underGitlink(e.relativePath)) captured.set(e.relativePath, e);
    }
  }
  const key = (path: string) => `${sourceId}\u0000${path}`;
  for (const [path, value] of tracked) {
    stillWithin();
    const [mode, oid] = value.split(':') as [string, string];
    if (mode === '160000') continue;
    const mine = captured.get(path);
    if (!mine) return true;
    captured.delete(path);
    if (mode === '120000') {
      if (mine.kind !== 'symlink') return true;
      const target = inv.symlinkTargets.get(key(path));
      if (target === undefined || repo.hashObject('blob', Buffer.from(target, 'utf8')) !== oid) return true;
      continue;
    }
    if (mine.kind !== 'file' || mine.disposition !== 'included') return true;
    const facts = inv.facts.get(key(path));
    if (!facts || facts.executable !== (mode === '100755')) return true;
    if (inv.gitBlobIdOf(mine.content, repo) !== oid) return true;
  }
  return captured.size > 0;
}

const compareEntries = (a: CaptureEntry, b: CaptureEntry) =>
  a.sourceId < b.sourceId
    ? -1
    : a.sourceId > b.sourceId
      ? 1
      : a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : 0;

function buildEnvelope(
  mode: CaptureModeRequest,
  policy: CapturePolicy,
  e: Enumerated,
  createdAt: string,
  attempt: number,
): SnapshotEnvelope {
  const captureMode = mode === 'committed-tree' ? 'committed-tree' : 'working-copy-stability-checked';
  const policyDigest = digestOf({ mode: captureMode, policy });
  const entries = [...e.inv.entries].sort(compareEntries);
  const facts = materializationSources(
    e.inv,
    e.sources.map((s) => s.sourceId),
    entries,
  );
  const inventoryDigest = inventoryDigestOf(captureMode, policyDigest, e.sources, entries, facts);
  const id = `snap-${sha256Hex(`${inventoryDigest}|${createdAt}|${attempt}`).slice(0, 32)}`;
  return {
    schema: 'sentinel-snapshot/draft-1',
    id,
    inventoryDigest,
    createdAt,
    capture: { mode: captureMode, policyDigest },
    environmentProfileDigest: digestOf({
      capture: CAPTURE_IMPLEMENTATION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    sources: e.sources,
    entries,
    frameworkVersions: [],
    artifacts: { parser: [], diagnostics: [] },
  };
}

/** Captures the sources into one snapshot and admits it. See the module comment for the order of effects. */
export function captureSnapshot(store: CaptureStore, request: CaptureRequest): Promise<CaptureResult> {
  return captureWithBudget(store, request, new GitReadBudget());
}

/**
 * Internal test seam (not exported from the facade): the capture with a caller's Git read budget. One budget serves
 * every repository the capture opens (sources, submodules, both working-copy enumerations, every retry); each is
 * closed when its capture attempt ends, which releases what it reserved.
 */
export async function captureWithBudget(
  store: CaptureStore,
  request: CaptureRequest,
  budget: GitReadBudget,
  stillWithin?: () => void,
  beforeAdmission?: () => void,
): Promise<CaptureResult> {
  // Internal only: callers retain their original owner/deadline/signal. Never a CaptureRequest/JSON field.
  const checkpoint = stillWithin
    ? () => {
        store.assertHeld();
        stillWithin();
      }
    : () => {};
  checkpoint();
  const policy = checkRequest(request);
  const now = request.now ?? (() => new Date().toISOString());
  store.assertHeld();
  for (let attempt = 1; attempt <= policy.stabilityAttempts; attempt++) {
    try {
      checkpoint();
      return await captureOnce(
        store,
        request,
        policy,
        now,
        attempt,
        budget,
        checkpoint,
        stillWithin !== undefined,
        beforeAdmission,
      );
    } catch (e) {
      // A Git read refused after enumeration (a re-read reloading an index over the budget) is explicit too.
      if (e instanceof GitReadError) gitFailure(e);
      if (!(e instanceof CaptureChanged)) throw e;
      if (attempt === policy.stabilityAttempts) throw new SnapshotError('sentinel.capture.unstable', '', { cause: e });
    }
  }
  throw new SnapshotError('sentinel.capture.unstable');
}

async function captureOnce(
  store: CaptureStore,
  request: CaptureRequest,
  policy: CapturePolicy,
  now: () => string,
  attempt: number,
  budget: GitReadBudget,
  stillWithin: () => void,
  admissionFence: boolean,
  beforeAdmission?: () => void,
): Promise<CaptureResult> {
  const first = enumerate(request, policy, store, now, budget, stillWithin);
  let second: Enumerated | undefined;
  try {
    stillWithin();
    return await captureEnumerated(
      store,
      request,
      policy,
      now,
      attempt,
      first,
      budget,
      (e) => {
        second = e;
      },
      stillWithin,
      admissionFence,
      beforeAdmission,
    );
  } finally {
    // The committed-tree read closures reopen pack files on demand; every handle is closed here, once nothing reads.
    for (const r of [...first.repos, ...(second?.repos ?? [])]) r.close();
  }
}

async function captureEnumerated(
  store: CaptureStore,
  request: CaptureRequest,
  policy: CapturePolicy,
  now: () => string,
  attempt: number,
  first: Enumerated,
  budget: GitReadBudget,
  keep: (e: Enumerated) => void,
  stillWithin: () => void,
  admissionFence: boolean,
  beforeAdmission?: () => void,
): Promise<CaptureResult> {
  stillWithin();
  const envelope = buildEnvelope(request.mode, policy, first, now(), attempt);
  const valid = validateEnvelope('snapshot', envelope);
  if (!valid.ok)
    throw new SnapshotError(
      'sentinel.capture.contractInvalid',
      valid.errors
        .slice(0, 3)
        .map((x) => `${x.path} ${x.message}`)
        .join('; '),
    );
  const manifest = canonicalJsonBytes(envelope);
  if (manifest.length > MAX_ENVELOPE_BYTES)
    throw new SnapshotError('sentinel.capture.manifestTooLarge', `${manifest.length} bytes`);
  const manifestId = store.objects.identify(manifest);
  const materialization: Materialization = {
    schema: MATERIALIZATION_SCHEMA,
    snapshotId: envelope.id,
    inventoryDigest: envelope.inventoryDigest,
    sources: materializationSources(
      first.inv,
      envelope.sources.map((s) => s.sourceId),
      envelope.entries,
    ) as MaterializedSource[],
  };
  const sidecar = canonicalJsonBytes(materialization);
  if (sidecar.length > MAX_ARTIFACT_BYTES)
    throw new SnapshotError('sentinel.capture.manifestTooLarge', `materialization ${sidecar.length} bytes`);
  const sidecarId = store.objects.identify(sidecar);

  const contentIds = [...first.inv.contents.keys()].sort();
  const size = request.stageSize ?? STAGE_LIMIT;
  const batches: ArtifactId[][] = [];
  for (let i = 0; i < contentIds.length; i += size) batches.push(contentIds.slice(i, i + size));
  const stageId = (i: number) => `${envelope.id}.stage-${i}`;
  const rootsStage = stageId(batches.length);
  const open: string[] = [];
  const receipts: StoredObject[] = [];

  try {
    // 3. Pin everything about to be written before the first byte is: source bytes, then the two roots, which link
    //    to content held by the other (unbound) stages.
    batches.forEach((ids, i) => {
      stillWithin();
      store.ledger.registerStaging(
        stageId(i),
        ids.map((id) => ({ id, schema: 'application/octet-stream', privacy: 'source' as const })),
      );
      open.push(stageId(i));
    });
    stillWithin();
    store.ledger.registerStaging(rootsStage, [
      { id: manifestId.id, schema: 'sentinel-snapshot/draft-1', privacy: 'source-derived', links: contentIds },
      { id: sidecarId.id, schema: MATERIALIZATION_SCHEMA, privacy: 'source', links: [manifestId.id] },
    ]);
    open.push(rootsStage);
    request.onStaged?.([...open]);
    stillWithin();
    // 4. Write the source bytes, each verified against the inventory.
    for (const id of contentIds) {
      stillWithin();
      const content = first.inv.contents.get(id)!;
      receipts.push(await store.objects.put(content.read(), { expect: { id, rawSize: content.bytes } }));
      stillWithin();
    }
    // 5. A working copy must hold still across the whole capture.
    if (request.mode === 'working-copy') {
      store.assertHeld();
      const second = enumerate(request, policy, store, now, budget, stillWithin);
      keep(second);
      stillWithin();
      if (fingerprint(first) !== fingerprint(second))
        throw new CaptureChanged('the working copy changed during capture');
    }
    // 6. The roots, then one admission that verifies every object again and releases every stage.
    stillWithin();
    const manifestReceipt = await store.objects.put(manifest, { expect: manifestId });
    stillWithin();
    receipts.push(manifestReceipt, await store.objects.put(sidecar, { expect: sidecarId }));
    stillWithin();
    store.assertHeld();
    beforeAdmission?.();
    stillWithin();
    const admit = () =>
      store.ledger.admitSnapshot({
        snapshotId: envelope.id,
        stageIds: [...open],
        manifest: manifestId.id,
        materialization: sidecarId.id,
        inventoryDigest: envelope.inventoryDigest,
        receipts,
      });
    const record = admissionFence ? withAdmissionFence(store, stillWithin, admit) : admit();
    open.length = 0;
    return Object.freeze({ snapshot: envelope, record, artifact: manifestReceipt, materialization, attempts: attempt });
  } catch (e) {
    for (const stage of open) {
      try {
        store.ledger.abortStaging(stage);
      } catch {
        /* the original failure is the one reported */
      }
    }
    throw e;
  }
}

/** The file this implementation runs from (moved by the packer into a bundle chunk): its bytes are the operation adapter's digest. */
export const CAPTURE_IMPLEMENTATION_URL: string = import.meta.url;
