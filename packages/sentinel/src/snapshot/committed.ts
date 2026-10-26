// Committed-tree enumeration: the pinned commit's tree, read object by object from the local repository (git.ts).
// The bytes are the stored blobs exactly as committed: no checkout, so no filter, attribute or hook applies.
import { GitReadError, GitRepository, MAX_METADATA_OBJECT_BYTES } from './git.js';
import { CaptureChanged, Inventory, lfsPointer, resolveLfs } from './inventory.js';
import { beyondPathBounds, checkName, folderExclusion, joinPath, symlinkVerdict } from './policy.js';
import type { CaptureReasonCode } from './errors.js';

export interface SubmoduleRequest {
  /** The submodule's path in the parent's tree. */
  readonly path: string;
  readonly sourceId: string;
  readonly repositoryId: string;
  /** Canonical absolute folder of a local clone holding the pinned commit. */
  readonly root: string;
  readonly lfsObjects?: string;
  /** As for a primary source: a Git directory and common directory outside `root`, permitted explicitly. */
  readonly gitDir?: string;
  readonly commonDir?: string;
}

export interface CommittedSource {
  readonly sourceId: string;
  readonly repo: GitRepository;
  readonly commit: string;
  readonly lfsObjects: string | undefined;
  readonly submodules: readonly SubmoduleRequest[];
  /** Internal preparation checkpoint; absent for legacy callers. */
  readonly stillWithin?: () => void;
}

/** A submodule found at a gitlink whose permitted local clone should be captured as its own source. */
export interface FoundSubmodule {
  readonly request: SubmoduleRequest;
  readonly commit: string;
}

const corruptOrMissing = (e: unknown): CaptureReasonCode | undefined =>
  !(e instanceof GitReadError)
    ? undefined
    : e.code === 'corrupt'
      ? 'sentinel.capture.gitObjectCorrupt'
      : e.code === 'limit'
        ? 'sentinel.capture.gitReadLimit'
        : undefined;

/** Enumerates one commit's tree. Returns the submodules to capture as separate sources. */
export function enumerateCommit(inv: Inventory, src: CommittedSource): FoundSubmodule[] {
  const found: FoundSubmodule[] = [];
  walkTree(inv, src, '', src.repo.treeOf(src.commit), found);
  return found;
}

function walkTree(inv: Inventory, src: CommittedSource, rel: string, treeOid: string, found: FoundSubmodule[]): void {
  src.stillWithin?.();
  let entries;
  try {
    entries = src.repo.readTree(treeOid);
  } catch (e) {
    const reason = corruptOrMissing(e);
    if (!reason) throw e;
    if (rel === '') throw e;
    inv.boundary(src.sourceId, rel, 'unreadable', reason);
    return;
  }
  if (!entries) {
    if (rel === '') throw new GitReadError('unresolved', "the commit's root tree is not present");
    inv.boundary(src.sourceId, rel, 'unreadable', 'sentinel.capture.gitObjectMissing');
    return;
  }
  const children = entries
    .map((e) => ({ e, check: checkName(e.name, true) }))
    .sort((a, b) => (a.check.name < b.check.name ? -1 : a.check.name > b.check.name ? 1 : 0));
  if (
    rel !== '' &&
    beyondPathBounds(
      rel,
      children.map((c) => c.check.name),
    )
  ) {
    inv.boundary(src.sourceId, rel, 'refused', 'sentinel.capture.pathLimit');
    return;
  }
  if (!inv.reserve(children.length)) {
    if (rel === '') throw new GitReadError('unsupported', 'the root tree has more entries than the capture may record');
    inv.boundary(src.sourceId, rel, 'refused', 'sentinel.capture.entryLimit');
    return;
  }
  inv.listed(src.sourceId, rel);
  for (const { e, check } of children) {
    src.stillWithin?.();
    const path = joinPath(rel, check.name);
    inv.release();
    const isTree = e.mode === '40000' || e.mode === '040000';
    const isBlob = e.mode === '100644' || e.mode === '100755' || e.mode === '100664';
    if (check.refused) {
      if (isTree || e.mode === '160000') inv.boundary(src.sourceId, path, 'refused', check.refused);
      else if (e.mode === '120000') inv.symlink(src.sourceId, path, 'refused', check.refused);
      else inv.recorded(src.sourceId, path, 'refused', check.refused);
      continue;
    }
    if (isTree) {
      // Committed blobs are never the live store: a tree at the store's path is ordinary committed source.
      const excluded = folderExclusion(inv.policy, src.sourceId, path);
      if (excluded) {
        inv.boundary(src.sourceId, path, 'excluded', excluded);
        continue;
      }
      walkTree(inv, src, path, e.oid, found);
      continue;
    }
    if (e.mode === '160000') {
      inv.gitlink(src.sourceId, path, e.oid);
      const request = src.submodules.find((s) => s.path === path);
      if (!request) {
        inv.boundary(src.sourceId, path, 'excluded', 'sentinel.capture.submoduleNotCaptured');
        continue;
      }
      found.push({ request, commit: e.oid });
      inv.boundary(src.sourceId, path, 'excluded', 'sentinel.capture.submoduleCapturedSeparately');
      continue;
    }
    if (e.mode === '120000') {
      let target: string | undefined;
      try {
        target = src.repo.readObject(e.oid, 4096)?.data.toString('utf8');
      } catch {
        target = undefined;
      }
      if (target === undefined) {
        inv.symlink(src.sourceId, path, 'refused', 'sentinel.capture.gitObjectMissing');
        continue;
      }
      const verdict = symlinkVerdict(path, target);
      inv.symlink(
        src.sourceId,
        path,
        verdict === 'sentinel.capture.symlinkEscapes' ? 'refused' : 'excluded',
        verdict,
        target,
      );
      continue;
    }
    if (!isBlob) {
      inv.recorded(src.sourceId, path, 'refused', 'sentinel.capture.specialFile');
      continue;
    }
    if (folderExclusion(inv.policy, src.sourceId, path) === 'sentinel.capture.excludedByPolicy') {
      inv.recorded(src.sourceId, path, 'excluded', 'sentinel.capture.excludedByPolicy');
      continue;
    }
    addBlob(inv, src, path, e.oid, e.mode);
  }
}

function addBlob(inv: Inventory, src: CommittedSource, path: string, oid: string, mode: string): void {
  const git = { mode, oid };
  const executable = mode === '100755';
  let header;
  try {
    header = src.repo.objectHeader(oid);
  } catch (e) {
    const reason = corruptOrMissing(e);
    if (!reason) throw e;
    inv.recorded(src.sourceId, path, 'unreadable', reason);
    return;
  }
  if (!header) {
    inv.recorded(src.sourceId, path, 'unreadable', 'sentinel.capture.gitObjectMissing');
    return;
  }
  const tooBig = inv.sizeRefusal(header.size);
  if (tooBig) {
    inv.recorded(src.sourceId, path, 'too-large', tooBig, header.size);
    return;
  }
  const read = () => {
    const obj = src.repo.readObject(oid, Math.min(inv.policy.maxFileBytes, MAX_METADATA_OBJECT_BYTES));
    if (!obj || obj.type !== 'blob') throw new CaptureChanged(`${path}'s object is no longer readable`);
    return obj.data;
  };
  let bytes: Buffer;
  try {
    const obj = src.repo.readObject(oid, Math.min(inv.policy.maxFileBytes, MAX_METADATA_OBJECT_BYTES));
    if (!obj) {
      inv.recorded(src.sourceId, path, 'unreadable', 'sentinel.capture.gitObjectMissing');
      return;
    }
    if (obj.type !== 'blob') {
      inv.recorded(src.sourceId, path, 'unreadable', 'sentinel.capture.gitObjectCorrupt');
      return;
    }
    bytes = obj.data;
  } catch (e) {
    const reason = corruptOrMissing(e);
    if (!reason) throw e;
    inv.recorded(src.sourceId, path, 'unreadable', reason, header.size);
    return;
  }
  const pointer = lfsPointer(bytes);
  if (pointer) {
    const big = inv.sizeRefusal(pointer.size);
    if (big) {
      inv.recorded(src.sourceId, path, 'too-large', big, pointer.size);
      return;
    }
    const lfs = resolveLfs(pointer, src.lfsObjects);
    if ('reason' in lfs) {
      inv.recorded(src.sourceId, path, 'unreadable', lfs.reason, pointer.size);
      return;
    }
    inv.included(
      src.sourceId,
      path,
      lfs.bytes,
      () => {
        const again = resolveLfs(pointer, src.lfsObjects);
        if ('reason' in again) throw new CaptureChanged(`${path}'s LFS content changed during capture`);
        return again.bytes;
      },
      { executable, git, lfs: pointer },
    );
    return;
  }
  inv.included(src.sourceId, path, bytes, read, { executable, git });
}

/** Git blob ids of every regular file in a commit, or undefined when any object on the way is unavailable. */
export function trackedBlobs(
  repo: GitRepository,
  commit: string,
  stillWithin?: () => void,
): Map<string, string> | undefined {
  let checkpointFailure: { error: unknown } | undefined;
  const checkpoint = () => {
    try {
      stillWithin?.();
    } catch (error) {
      checkpointFailure = { error };
      throw error;
    }
  };
  const out = new Map<string, string>();
  const walk = (rel: string, oid: string): boolean => {
    checkpoint();
    let entries;
    try {
      entries = repo.readTree(oid);
    } catch {
      return false;
    }
    if (!entries) return false;
    for (const e of entries) {
      checkpoint();
      const c = checkName(e.name, true);
      if (c.refused) return false;
      const path = joinPath(rel, c.name);
      if (e.mode === '40000' || e.mode === '040000') {
        if (!walk(path, e.oid)) return false;
      } else out.set(path, `${e.mode}:${e.oid}`);
    }
    return true;
  };
  try {
    return walk('', repo.treeOf(commit)) ? out : undefined;
  } catch {
    if (checkpointFailure) throw checkpointFailure.error;
    return undefined;
  }
}
