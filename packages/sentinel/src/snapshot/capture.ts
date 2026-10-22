// Capture: enumerate the authorised sources into one immutable inventory, then pin and store it through the PR 03
// store facade. Order (each step completes before the next):
//
//   1. enumerate every source and hash every included file (no byte is stored yet);
//   2. build the snapshot envelope and check it against its contract;
//   3. register staging for every artifact (source bytes, then the manifest) before a byte is written;
//   4. write the bytes, each re-read and re-hashed against the inventory;
//   5. working copy only: enumerate again; any difference discards the attempt (stages aborted) and retries;
//   6. publish each stage under the running attempt the caller names for it.
//
// A failure before publication aborts every stage it registered: the bytes written become unreferenced and wait
// for an explicit prune. Nothing here opens the ledger database or the owner lock; it uses the facade only.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { ArtifactId, CaptureEntry, Id, SnapshotEnvelope, SnapshotSource, WorkRef } from '../contracts/index.js';
import { MAX_ENVELOPE_BYTES } from '../contracts/index.js';
import type { PublicationReceipt, SentinelStore, StoredObject } from '../store/index.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import { enumerateCommit, trackedBlobs, type SubmoduleRequest } from './committed.js';
import { SnapshotError } from './errors.js';
import { GitReadError, GitRepository } from './git.js';
import { CaptureChanged, Inventory } from './inventory.js';
import { digestOf, resolvePolicy, type CapturePolicy } from './policy.js';
import { enumerateWorktree } from './worktree.js';

export type CaptureModeRequest = 'committed-tree' | 'working-copy';

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
  /** A local Git LFS object folder the capture may read pointer content from. Nothing is downloaded. */
  readonly lfsObjects?: string;
  /** Committed-tree only: submodules to capture as their own sources, from local clones. */
  readonly submodules?: readonly SubmoduleRequest[];
}

/** The running attempt a stage is published under. Each stage is one publication, so each needs its own. */
export interface CaptureStageTarget {
  readonly work: WorkRef;
  readonly attemptId: Id;
}

export interface CaptureStageInfo {
  readonly index: number;
  readonly count: number;
  /** `content`: source bytes only; `manifest`: the snapshot, linking to published content; `combined`: both. */
  readonly role: 'content' | 'manifest' | 'combined';
}

export interface CaptureRequest {
  readonly mode: CaptureModeRequest;
  readonly sources: readonly CaptureSourceRequest[];
  readonly policy?: Partial<CapturePolicy>;
  /** Called once per stage, before it is registered. */
  readonly publishTo: (stage: CaptureStageInfo) => CaptureStageTarget;
  /** Defaults to the system clock. */
  readonly now?: () => string;
  /** Artifacts per stage, 1..4095 (default 4095, the ledger's limit less the manifest's slot). */
  readonly stageSize?: number;
}

export interface CaptureResult {
  readonly snapshot: SnapshotEnvelope;
  /** The stored snapshot manifest: its id is the snapshot's artifact id. */
  readonly artifact: StoredObject;
  readonly publications: readonly PublicationReceipt[];
  /** How many times the working copy was read before it held still (1 for a committed tree). */
  readonly attempts: number;
}

/** The facade operations capture uses. Satisfied by `SentinelStore`. */
export type CaptureStore = Pick<SentinelStore, 'storePath' | 'objects' | 'ledger' | 'assertHeld'>;

/** The ledger's per-stage limit is 4096 artifacts; one slot stays free for the manifest in a combined stage. */
const STAGE_LIMIT = 4095;
const CAPTURE_IMPLEMENTATION = 'sentinel-capture/1';

const canonical = (path: string, what: string): string => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new SnapshotError('sentinel.capture.rootNotCanonical', what);
  let real: string;
  try { real = realpathSync.native(path); } catch { throw new SnapshotError('sentinel.capture.rootUnreadable', what); }
  if (real !== path) throw new SnapshotError('sentinel.capture.rootNotCanonical', what);
  return real;
};

function checkRequest(request: CaptureRequest): CapturePolicy {
  const bad = (detail: string): never => { throw new SnapshotError('sentinel.capture.invalidRequest', detail); };
  if (!request || typeof request !== 'object') bad('no request');
  if (request.mode !== 'committed-tree' && request.mode !== 'working-copy') bad('mode must be committed-tree or working-copy');
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 64) bad('1..64 sources');
  if (typeof request.publishTo !== 'function') bad('publishTo must name the attempt each stage is published under');
  const ids = new Set<string>();
  for (const s of request.sources) {
    if (!s || typeof s.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s.sourceId)) bad('a source id is not a valid id');
    if (ids.has(s.sourceId)) bad(`source ${s.sourceId} is listed twice`);
    ids.add(s.sourceId);
    if (typeof s.repositoryId !== 'string' || s.repositoryId.length < 1 || s.repositoryId.length > 512) bad(`${s.sourceId}: repositoryId`);
    canonical(s.root, s.sourceId);
    if (s.lfsObjects !== undefined) canonical(s.lfsObjects, `${s.sourceId} lfsObjects`);
    if (s.gitDir !== undefined) canonical(s.gitDir, `${s.sourceId} gitDir`);
    if (request.mode === 'working-copy' && (s.revision !== undefined || (s.submodules?.length ?? 0) > 0)) {
      bad(`${s.sourceId}: revision and submodules apply to committed-tree capture only`);
    }
    for (const sub of s.submodules ?? []) {
      if (!sub || typeof sub.path !== 'string' || typeof sub.sourceId !== 'string') bad(`${s.sourceId}: a submodule needs a path and a source id`);
      if (ids.has(sub.sourceId)) bad(`source ${sub.sourceId} is listed twice`);
      ids.add(sub.sourceId);
      canonical(sub.root, `${sub.sourceId}`);
    }
  }
  if (request.stageSize !== undefined && (!Number.isSafeInteger(request.stageSize) || request.stageSize < 1 || request.stageSize > STAGE_LIMIT)) {
    bad(`stageSize must be 1..${STAGE_LIMIT}`);
  }
  try { return resolvePolicy(request.policy); } catch (e) { return bad((e as Error).message); }
}

/** The store folder relative to `root` when it lies inside it. */
function storeInside(root: string, storePath: string): string | undefined {
  let store: string;
  try { store = realpathSync.native(storePath); } catch { return undefined; }
  if (store === root) throw new SnapshotError('sentinel.capture.invalidRequest', 'a source root cannot be the store itself');
  if (!store.startsWith(root + sep)) return undefined;
  return relative(root, store).split(sep).join('/');
}

function openRepo(root: string, gitDir: string | undefined): GitRepository {
  try { return GitRepository.open(root, gitDir === undefined ? {} : { gitDir }); } catch (e) {
    if (e instanceof GitReadError && e.code === 'unsupported') throw new SnapshotError('sentinel.capture.gitUnsupported', e.message);
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

interface Enumerated { readonly inv: Inventory; readonly sources: SnapshotSource[] }

function enumerate(request: CaptureRequest, policy: CapturePolicy, store: CaptureStore, now: () => string): Enumerated {
  const inv = new Inventory(policy);
  const sources: SnapshotSource[] = [];
  const repos: GitRepository[] = [];
  try {
    for (const s of request.sources) {
      const root = canonical(s.root, s.sourceId);
      const st = lstatSync(root);
      if (!st.isDirectory()) throw new SnapshotError('sentinel.capture.rootUnreadable', s.sourceId);
      const storeRel = storeInside(root, store.storePath);
      if (request.mode === 'committed-tree') {
        const repo = openRepo(root, s.gitDir);
        repos.push(repo);
        let commit: string;
        let found;
        try {
          commit = repo.resolveCommit(s.revision ?? 'HEAD');
          found = enumerateCommit(inv, { sourceId: s.sourceId, repo, commit, lfsObjects: s.lfsObjects, submodules: s.submodules ?? [], storeRel });
        } catch (e) { if (e instanceof CaptureChanged || e instanceof SnapshotError) throw e; return gitFailure(e); }
        sources.push({ sourceId: s.sourceId, repositoryId: s.repositoryId, commit, dirty: false, capturedAt: now() });
        for (const sub of found) {
          const subRoot = canonical(sub.request.root, sub.request.sourceId);
          const subRepo = openRepo(subRoot, undefined);
          repos.push(subRepo);
          let present = false;
          try { present = subRepo.readObject(sub.commit, 64 * 1024 * 1024)?.type === 'commit'; } catch { present = false; }
          const marker = inv.entries.findIndex(e => e.sourceId === s.sourceId && e.relativePath === sub.request.path && e.kind === 'directory-boundary');
          if (!present) {
            if (marker >= 0) inv.entries[marker] = { sourceId: s.sourceId, relativePath: sub.request.path, kind: 'directory-boundary',
              disposition: 'unreadable', reasonCode: 'sentinel.capture.submoduleCommitMissing', knownDescendants: null };
            continue;
          }
          try {
            enumerateCommit(inv, { sourceId: sub.request.sourceId, repo: subRepo, commit: sub.commit, lfsObjects: sub.request.lfsObjects,
              submodules: [], storeRel: storeInside(subRoot, store.storePath) });
          } catch (e) { if (e instanceof CaptureChanged || e instanceof SnapshotError) throw e; return gitFailure(e); }
          sources.push({ sourceId: sub.request.sourceId, repositoryId: sub.request.repositoryId, commit: sub.commit, dirty: false, capturedAt: now() });
        }
      } else {
        let repo: GitRepository | undefined;
        try { repo = GitRepository.open(root, s.gitDir === undefined ? {} : { gitDir: s.gitDir }); } catch { repo = undefined; }
        if (repo) repos.push(repo);
        let commit: string | null = null;
        if (repo) { try { commit = repo.resolveCommit('HEAD'); } catch { commit = null; } }
        const start = inv.entries.length;
        enumerateWorktree(inv, { sourceId: s.sourceId, root, storeRel, lfsObjects: s.lfsObjects });
        const dirty = commit === null || repo === undefined ? true : differsFromCommit(repo, commit, inv.entries.slice(start), inv);
        sources.push({ sourceId: s.sourceId, repositoryId: s.repositoryId, commit, dirty, capturedAt: now() });
      }
    }
  } finally {
    for (const r of repos) r.close();
  }
  inv.refuseCaseCollisions();
  return { inv, sources };
}

/**
 * Whether a working copy is anything but its commit: true unless every tracked file was captured with the same
 * Git blob id and nothing else was captured. A tracked file that was not captured (excluded, too large, unreadable)
 * cannot be compared, so the copy is not claimed clean.
 */
function differsFromCommit(repo: GitRepository, commit: string, entries: readonly CaptureEntry[], inv: Inventory): boolean {
  const tracked = trackedBlobs(repo, commit);
  if (!tracked) return true;
  const gitlinks = [...tracked].filter(([, v]) => v.startsWith('160000:')).map(([p]) => p);
  const underGitlink = (p: string) => gitlinks.some(g => p === g || p.startsWith(`${g}/`));
  const captured = new Map<string, string>();
  for (const e of entries) {
    if (e.kind === 'file' && e.disposition === 'included') {
      if (underGitlink(e.relativePath)) continue;
      captured.set(e.relativePath, e.content);
    } else if (e.kind === 'symlink') captured.set(e.relativePath, 'symlink');
  }
  for (const [path, value] of tracked) {
    if (value.startsWith('160000:')) continue;
    const mine = captured.get(path);
    if (mine === undefined) return true;
    if (value.startsWith('120000:')) { if (mine !== 'symlink') return true; }
    else if (mine === 'symlink' || inv.gitBlobIdOf(mine, repo) !== value.slice(value.indexOf(':') + 1)) return true;
    captured.delete(path);
  }
  return captured.size > 0;
}

const compareEntries = (a: CaptureEntry, b: CaptureEntry) =>
  (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);

function buildEnvelope(mode: CaptureModeRequest, policy: CapturePolicy, e: Enumerated, createdAt: string, attempt: number): SnapshotEnvelope {
  const captureMode = mode === 'committed-tree' ? 'committed-tree' : 'working-copy-stability-checked';
  const policyDigest = digestOf({ mode: captureMode, policy });
  const entries = [...e.inv.entries].sort(compareEntries);
  const inventoryDigest = digestOf({
    mode: captureMode, policyDigest, entries,
    sources: e.sources.map(({ capturedAt: _t, ...rest }) => rest),
  });
  const id = `snap-${createHash('sha256').update(`${inventoryDigest}|${createdAt}|${attempt}`).digest('hex').slice(0, 32)}`;
  return {
    schema: 'sentinel-snapshot/draft-1', id, inventoryDigest, createdAt,
    capture: { mode: captureMode, policyDigest },
    environmentProfileDigest: digestOf({ capture: CAPTURE_IMPLEMENTATION, node: process.version, platform: process.platform, arch: process.arch }),
    sources: e.sources, entries, frameworkVersions: [], artifacts: { parser: [], diagnostics: [] },
  };
}

const sameInventory = (a: Enumerated, b: Enumerated) =>
  JSON.stringify([...a.inv.entries].sort(compareEntries)) === JSON.stringify([...b.inv.entries].sort(compareEntries))
  && JSON.stringify(a.sources.map(({ capturedAt: _t, ...r }) => r)) === JSON.stringify(b.sources.map(({ capturedAt: _t, ...r }) => r));

/** Captures the sources into one snapshot and publishes it. See the module comment for the order of effects. */
export async function captureSnapshot(store: CaptureStore, request: CaptureRequest): Promise<CaptureResult> {
  const policy = checkRequest(request);
  const now = request.now ?? (() => new Date().toISOString());
  store.assertHeld();
  for (let attempt = 1; attempt <= policy.stabilityAttempts; attempt++) {
    try {
      return await captureOnce(store, request, policy, now, attempt);
    } catch (e) {
      if (!(e instanceof CaptureChanged)) throw e;
      if (attempt === policy.stabilityAttempts) throw new SnapshotError('sentinel.capture.unstable', '', { cause: e });
    }
  }
  throw new SnapshotError('sentinel.capture.unstable');
}

async function captureOnce(store: CaptureStore, request: CaptureRequest, policy: CapturePolicy, now: () => string, attempt: number):
  Promise<CaptureResult> {
  const first = enumerate(request, policy, store, now);
  const envelope = buildEnvelope(request.mode, policy, first, now(), attempt);
  const valid = validateEnvelope('snapshot', envelope);
  if (!valid.ok) throw new SnapshotError('sentinel.capture.contractInvalid', valid.errors.slice(0, 3).map(x => `${x.path} ${x.message}`).join('; '));
  const manifest = canonicalJsonBytes(envelope);
  if (manifest.length > MAX_ENVELOPE_BYTES) throw new SnapshotError('sentinel.capture.manifestTooLarge', `${manifest.length} bytes`);
  const manifestId = store.objects.identify(manifest);

  const contentIds = [...first.inv.contents.keys()].sort();
  const size = request.stageSize ?? STAGE_LIMIT;
  const combined = contentIds.length + 1 <= size;
  const batches: ArtifactId[][] = [];
  if (!combined) for (let i = 0; i < contentIds.length; i += size) batches.push(contentIds.slice(i, i + size));
  const stageCount = combined ? 1 : batches.length + 1;
  const stageId = (i: number) => `${envelope.id}.stage-${i}`;
  const open: { stageId: string; target: CaptureStageTarget; ids: ArtifactId[]; role: CaptureStageInfo['role'] }[] = [];
  const published = new Set<string>();
  const publications: PublicationReceipt[] = [];
  const receipts = new Map<ArtifactId, StoredObject>();
  const manifestArtifact = { id: manifestId.id, schema: 'sentinel-snapshot/draft-1', privacy: 'source-derived' as const, links: contentIds };
  const contentArtifact = (id: ArtifactId) => ({ id, schema: 'application/octet-stream', privacy: 'source' as const, links: [] });

  const register = (index: number, role: CaptureStageInfo['role'], ids: ArtifactId[], withManifest: boolean) => {
    const target = request.publishTo({ index, count: stageCount, role });
    const artifacts = [...ids.map(contentArtifact), ...(withManifest ? [manifestArtifact] : [])];
    store.ledger.registerStaging(stageId(index), artifacts, target);
    open.push({ stageId: stageId(index), target, ids: withManifest ? [...ids, manifestId.id] : ids, role });
  };
  const publish = (stage: typeof open[number]) => {
    const outputs = stage.role === 'content' ? stage.ids : [manifestId.id];
    publications.push(store.ledger.publish({ work: stage.target.work, attemptId: stage.target.attemptId, stageId: stage.stageId,
      receipts: stage.ids.map(id => receipts.get(id)!), outputs, endedAt: now() }));
    published.add(stage.stageId);
  };

  try {
    // 3. Pin everything about to be written before the first byte is.
    if (combined) register(0, 'combined', contentIds, true);
    else batches.forEach((ids, i) => register(i, 'content', ids, false));
    // 4. Write the source bytes, each verified against the inventory.
    for (const id of contentIds) {
      const content = first.inv.contents.get(id)!;
      receipts.set(id, await store.objects.put(content.read(), { expect: { id, rawSize: content.bytes } }));
    }
    // 5. A working copy must hold still across the whole capture.
    if (request.mode === 'working-copy') {
      const second = enumerate(request, policy, store, now);
      if (!sameInventory(first, second)) throw new CaptureChanged('the working copy changed during capture');
    }
    store.assertHeld();
    // 6. Publish: source bytes first, so the manifest's links name accepted artifacts.
    if (combined) {
      receipts.set(manifestId.id, await store.objects.put(manifest, { expect: manifestId }));
      publish(open[0]!);
    } else {
      for (const stage of open) publish(stage);
      register(batches.length, 'manifest', [], true);
      receipts.set(manifestId.id, await store.objects.put(manifest, { expect: manifestId }));
      publish(open[open.length - 1]!);
    }
  } catch (e) {
    for (const stage of open) {
      if (published.has(stage.stageId)) continue;
      try { store.ledger.abortStaging(stage.stageId); } catch { /* the original failure is the one reported */ }
    }
    throw e;
  }
  return Object.freeze({ snapshot: envelope, artifact: receipts.get(manifestId.id)!, publications: Object.freeze(publications), attempts: attempt });
}
