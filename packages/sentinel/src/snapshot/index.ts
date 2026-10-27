// The snapshot facade (PR 04): capture authorised sources into one immutable snapshot admitted by the ledger;
// reopen and restore it from the store alone; reconcile it against an independent walk. It works through the store
// facade (`openStore()`) and never opens the ledger database or the owner lock. Importing it opens nothing and
// starts no process.
export { captureSnapshot } from './capture.js';
export type {
  CaptureRequest,
  CaptureSourceRequest,
  CaptureModeRequest,
  CaptureResult,
  CaptureStore,
} from './capture.js';
export type { SubmoduleRequest } from './committed.js';
export { openSnapshot, restoreSnapshot, readSnapshot } from './materialize.js';
export type { OpenedSnapshot, RestoreOptions, RestoredSnapshot, RestoredSource, RestoreStore } from './materialize.js';
export { MATERIALIZATION_SCHEMA, validateMaterialization } from './materialization.js';
export type { Materialization, MaterializedSource, MaterializedFile } from './materialization.js';
export { reconcileInventory } from './reconcile.js';
export { resolveWithheldLocation } from './locations.js';
export type { ResolvedLocation } from './locations.js';
export type { Reconciliation } from './reconcile.js';
export { DEFAULT_CAPTURE_POLICY } from './policy.js';
export type { CapturePolicy } from './policy.js';
export { SnapshotError, SNAPSHOT_ERROR_CODES, CAPTURE_REASON_CODES } from './errors.js';
export type { SnapshotErrorCode, CaptureReasonCode } from './errors.js';
