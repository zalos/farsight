import type { StringEntry } from './strings.js';

// Sentinel source capture (PR 04): why an enumerated entry was recorded without its bytes, and why a capture or a
// restore was refused. Each key is the stable reason code a snapshot entry or a SnapshotError carries. Both
// registers carry the same words until the PR 09 vocabulary freeze, as in strings-sentinel-store.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_CAPTURE_STRINGS: Record<string, StringEntry> = {
  'sentinel.capability.draftCapture': same('draft source capture only', 'A library can capture committed trees and working copies into an immutable snapshot, record what it could not read, and restore it from the store. Nothing parses or scans the snapshot yet.'),
  // ---- entry reasons: recorded, never silently dropped ----
  'sentinel.capture.excludedGitInternals': same('Git internals are not captured', 'The repository\'s own .git folder holds history and configuration, not the source being scanned. It is recorded as a boundary whose contents were not listed.'),
  'sentinel.capture.excludedStore': same('the Sentinel store is not captured', 'The folder holding Sentinel\'s own records sits inside the source. It is recorded as a boundary and never read as source.'),
  'sentinel.capture.excludedDependencyCache': same('a dependency cache is not captured', 'Installed packages and build-tool caches are downloaded copies, not the repository\'s own source. They are recorded as a boundary whose contents were not listed.'),
  'sentinel.capture.excludedByPolicy': same('excluded by the capture policy', 'The owner\'s capture policy names this path as out of scope. It is recorded as excluded so the gap stays visible.'),
  'sentinel.capture.symlinkNotFollowed': same('a symbolic link is recorded, not followed', 'A link is never followed during capture, so its target is not part of the snapshot. Its existence is recorded.'),
  'sentinel.capture.symlinkEscapes': same('a symbolic link points outside the source', 'The link\'s target is outside the authorised source folder. It is refused and its target is never read.'),
  'sentinel.capture.unsafePath': same('a path that could escape or alter the restored tree is refused', 'The name is empty, a dot segment, contains a slash or NUL, or is a .git folder inside a commit. Restoring it could write outside the snapshot, so it is refused.'),
  'sentinel.capture.pathEncoding': same('a file name that is not valid UTF-8 is refused', 'Snapshot paths are UTF-8 text. A name in another encoding cannot be recorded faithfully, so the entry is refused and shown with its bytes in hexadecimal.'),
  'sentinel.capture.caseCollision': same('paths that differ only by letter case are refused', 'Two or more paths become the same path on a case-insensitive file system, so restoring them could overwrite one with another. Every path in the group is refused.'),
  'sentinel.capture.specialFile': same('a device, pipe or socket is not captured', 'Only regular files carry source. Special files are recorded and refused so that reading them cannot block or have side effects.'),
  'sentinel.capture.unreadable': same('this could not be read', 'The operating system refused to open or list it. For a folder, how many files it holds is unknown, not zero.'),
  'sentinel.capture.tooLarge': same('larger than the per-file capture limit', 'Files above the capture policy\'s size limit are recorded with their size and not captured.'),
  'sentinel.capture.quotaExceeded': same('the capture\'s total size limit was reached', 'The capture policy bounds the total bytes captured. Files reached after the limit are recorded with their size and not captured.'),
  'sentinel.capture.entryLimit': same('the capture\'s entry limit was reached before this folder was listed', 'The capture policy bounds how many entries one snapshot records. This folder was not listed, so how many files it holds is unknown, not zero.'),
  'sentinel.capture.pathLimit': same('this folder is nested too deeply, or holds names too long, to be listed', 'Folders more than 256 levels deep, or whose entries would have paths longer than 4096 characters, are not listed. The folder is recorded as a boundary; how many files it holds is unknown, not zero.'),
  'sentinel.capture.gitObjectMissing': same('the Git object is not in the local repository', 'The commit names this file or folder but its object is not stored locally, as in a partial clone. Nothing is fetched; how much it holds is unknown.'),
  'sentinel.capture.gitObjectCorrupt': same('the Git object is damaged', 'The stored object does not decompress, exceeds its declared size or does not hash to its id, so its contents are not trusted.'),
  'sentinel.capture.gitReadLimit': same('the Git object could not be read within the reader\'s limits', 'The object may be intact, but reading it would need more than the reader allows, for example a header behind more compressed padding than it searches. It is recorded as unreadable, not as damaged.'),
  'sentinel.capture.lfsObjectMissing': same('the Git LFS content is not available locally', 'The file is a Git LFS pointer and its content is not in a local LFS store the capture was permitted to read. Nothing is downloaded.'),
  'sentinel.capture.lfsObjectMismatch': same('the local Git LFS content does not match its pointer', 'The content found for this LFS pointer has a different size or digest than the pointer records, so it is not captured.'),
  'sentinel.capture.lfsStoreUnsafe': same('the local Git LFS folder holds a link or changed while it was read', 'Content is read from the permitted LFS folder only through real folders that stay the same throughout the read. A link, or a folder replaced mid-read, could point outside it, so the content is refused, not followed.'),
  'sentinel.capture.submoduleNotCaptured': same('a submodule is recorded, not captured', 'The commit pins another repository here. It is captured only when that repository is explicitly given as a local source; otherwise how much it holds is unknown.'),
  'sentinel.capture.submoduleCapturedSeparately': same('this submodule is captured as its own source', 'The submodule\'s pinned commit was read from the local repository the capture was given and is recorded as a separate source with its own identity.'),
  'sentinel.capture.submoduleCommitMissing': same('the submodule\'s pinned commit is not in the given repository', 'The local repository given for this submodule does not hold the commit the parent pins. Nothing is fetched; how much it holds is unknown.'),
  // ---- refusals of a whole capture or restore ----
  'sentinel.capture.invalidRequest': same('the capture request is not valid: {detail}', 'A capture names one or more sources, each with an id, a repository identity and an absolute folder, and a mode.'),
  'sentinel.capture.rootNotCanonical': same('a source folder must be given by its canonical absolute path: {detail}', 'A path through a link, a relative path or a different letter case could name another folder between checks, so only the canonical path is accepted.'),
  'sentinel.capture.rootUnreadable': same('a source folder could not be read: {detail}', 'The authorised source folder is missing or not a readable folder, so nothing was captured from it.'),
  'sentinel.capture.notRepository': same('a committed-tree capture needs a local Git repository: {detail}', 'Committed capture reads the pinned commit\'s objects from the source\'s own repository. This source has none that can be read.'),
  'sentinel.capture.gitUnsupported': same('this Git repository uses a feature the capture does not read: {detail}', 'The capture reads loose objects and version 2 pack files in SHA-1 or SHA-256 repositories with file-based refs. Anything else is refused rather than guessed.'),
  'sentinel.capture.revisionUnresolved': same('the revision could not be resolved to a commit: {detail}', 'A revision is HEAD, a full ref name or a full commit id, and its commit must be present locally.'),
  'sentinel.capture.unstable': same('the working copy kept changing during capture', 'A working-copy capture reads every file, stores it, then reads the tree again. The tree changed on every attempt, so no snapshot was published. Stop the edits and capture again.'),
  'sentinel.capture.manifestTooLarge': same('the snapshot manifest exceeds the largest object the store keeps', 'The list of captured entries must fit in one stored object. Narrow the sources or lower the entry limit.'),
  'sentinel.capture.contractInvalid': same('the snapshot does not satisfy its contract: {detail}', 'Every snapshot is checked against its published schema before anything is stored. This one was not, so nothing was stored.'),
  'sentinel.capture.notSnapshot': same('the artifact is not a stored snapshot', 'Only an accepted snapshot artifact can be restored.'),
  'sentinel.capture.restoreTargetUnsafe': same('the restore folder must be a new, empty folder given by its canonical path', 'A restore writes a fresh read-only tree. An existing or linked folder could mix it with other files, so it is refused.'),
  'sentinel.capture.restoreIntegrity': same('the restored tree does not match its snapshot: {detail}', 'After writing, every restored file is read back and the tree listed again. A difference means the restore cannot be trusted.'),
};

export function sentinelCaptureWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_CAPTURE_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
