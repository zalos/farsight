// Capture reason codes and the one error type capture and restore raise. Every code is a catalog key
// (packages/core/src/strings-sentinel-capture.ts); a test pins these lists against the catalog.
import { sentinelCaptureWord } from '@farsight/core/dist/strings-sentinel-capture.js';
import { SentinelError } from '../kernel/errors.js';

/** Why an enumerated entry was recorded without its bytes. */
export const CAPTURE_REASON_CODES = Object.freeze([
  'sentinel.capture.excludedGitInternals',
  'sentinel.capture.excludedStore',
  'sentinel.capture.excludedDependencyCache',
  'sentinel.capture.excludedByPolicy',
  'sentinel.capture.symlinkNotFollowed',
  'sentinel.capture.symlinkEscapes',
  'sentinel.capture.unsafePath',
  'sentinel.capture.pathEncoding',
  'sentinel.capture.caseCollision',
  'sentinel.capture.specialFile',
  'sentinel.capture.unreadable',
  'sentinel.capture.tooLarge',
  'sentinel.capture.quotaExceeded',
  'sentinel.capture.entryLimit',
  'sentinel.capture.pathLimit',
  'sentinel.capture.gitObjectMissing',
  'sentinel.capture.gitObjectCorrupt',
  'sentinel.capture.gitReadLimit',
  'sentinel.capture.lfsObjectMissing',
  'sentinel.capture.lfsObjectMismatch',
  'sentinel.capture.lfsStoreUnsafe',
  'sentinel.capture.submoduleNotCaptured',
  'sentinel.capture.submoduleCapturedSeparately',
  'sentinel.capture.submoduleCommitMissing',
] as const);
/** One of {@link CAPTURE_REASON_CODES}. */
export type CaptureReasonCode = (typeof CAPTURE_REASON_CODES)[number];

/** Why a whole capture or restore was refused. */
export const SNAPSHOT_ERROR_CODES = Object.freeze([
  'sentinel.capture.invalidRequest',
  'sentinel.capture.rootNotCanonical',
  'sentinel.capture.rootUnreadable',
  'sentinel.capture.notRepository',
  'sentinel.capture.gitUnsupported',
  'sentinel.capture.revisionUnresolved',
  'sentinel.capture.unstable',
  'sentinel.capture.manifestTooLarge',
  'sentinel.capture.contractInvalid',
  'sentinel.capture.notSnapshot',
  'sentinel.capture.storeAliased',
  'sentinel.capture.restoreTargetUnsafe',
  'sentinel.capture.restoreIntegrity',
  'sentinel.capture.locationUnresolved',
] as const);
/** One of {@link SNAPSHOT_ERROR_CODES}. */
export type SnapshotErrorCode = (typeof SNAPSHOT_ERROR_CODES)[number];

/** A whole capture or restore refused; the message is the catalog's sentence for `code` with its detail. */
export class SnapshotError extends SentinelError<SnapshotErrorCode> {
  constructor(code: SnapshotErrorCode, detail = '', options?: { cause?: unknown }) {
    super(code, sentinelCaptureWord(code, { detail }), { cause: options?.cause });
    this.name = 'SnapshotError';
  }
}
