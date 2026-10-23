// Capture reason codes and the one error type capture and restore raise. Every code is a catalog key
// (packages/core/src/strings-sentinel-capture.ts); a test pins these lists against the catalog.
import { sentinelCaptureWord } from '@farsight/core/dist/strings-sentinel-capture.js';

/** Why an enumerated entry was recorded without its bytes. */
export const CAPTURE_REASON_CODES = Object.freeze([
  'sentinel.capture.excludedGitInternals', 'sentinel.capture.excludedStore', 'sentinel.capture.excludedDependencyCache',
  'sentinel.capture.excludedByPolicy', 'sentinel.capture.symlinkNotFollowed', 'sentinel.capture.symlinkEscapes',
  'sentinel.capture.unsafePath', 'sentinel.capture.pathEncoding', 'sentinel.capture.caseCollision',
  'sentinel.capture.specialFile', 'sentinel.capture.unreadable', 'sentinel.capture.tooLarge',
  'sentinel.capture.quotaExceeded', 'sentinel.capture.entryLimit', 'sentinel.capture.pathLimit', 'sentinel.capture.gitObjectMissing',
  'sentinel.capture.gitObjectCorrupt', 'sentinel.capture.gitReadLimit', 'sentinel.capture.lfsObjectMissing', 'sentinel.capture.lfsObjectMismatch',
  'sentinel.capture.lfsStoreUnsafe',
  'sentinel.capture.submoduleNotCaptured', 'sentinel.capture.submoduleCapturedSeparately',
  'sentinel.capture.submoduleCommitMissing',
] as const);
export type CaptureReasonCode = typeof CAPTURE_REASON_CODES[number];

/** Why a whole capture or restore was refused. */
export const SNAPSHOT_ERROR_CODES = Object.freeze([
  'sentinel.capture.invalidRequest', 'sentinel.capture.rootNotCanonical', 'sentinel.capture.rootUnreadable',
  'sentinel.capture.notRepository', 'sentinel.capture.gitUnsupported', 'sentinel.capture.revisionUnresolved',
  'sentinel.capture.unstable', 'sentinel.capture.manifestTooLarge', 'sentinel.capture.contractInvalid',
  'sentinel.capture.notSnapshot', 'sentinel.capture.storeAliased', 'sentinel.capture.restoreTargetUnsafe', 'sentinel.capture.restoreIntegrity', 'sentinel.capture.locationUnresolved',
] as const);
export type SnapshotErrorCode = typeof SNAPSHOT_ERROR_CODES[number];

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode, detail = '', options?: { cause?: unknown }) {
    super(sentinelCaptureWord(code, { detail }), options);
    this.name = 'SnapshotError';
    this.code = code;
  }
}
