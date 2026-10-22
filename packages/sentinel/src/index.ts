// The supported library facade. Importing it has no side effects: no ledger, process, network or scanner.
export * from './contracts/index.js';
export {
  validateEnvelope, parseEnvelope, schemaOf, negotiateProtocol, policyResultOf, POLICY_EXIT_CODES, MAX_REPORTED_ERRORS,
  isCalendarTimestamp, compareTimestamps, isSafeRelativePath,
} from './validate.js';
export type {
  EnvelopeTypes, ContractError, ContractErrorCode, ValidationResult, PolicyFacts,
} from './validate.js';
export { CAPABILITIES, capability } from './capabilities.js';
export type { Capability, CapabilityState } from './capabilities.js';
// The local store (ADR 19). Only the facade is public; opening a store is an explicit call, never an import effect.
export {
  openStore, STORAGE_ERROR_CODES, StoreError, LedgerError, ObjectStoreError, SQLITE_RELEASE_POLICY, qualificationFor,
} from './store/index.js';
export type {
  SentinelStore, StoreLedger, StoreObjects, StoredObject, ObjectIdentityRef, OpenStoreOptions, PutObjectOptions,
  StoreRuntimeFacts, StoreErrorCode, LedgerErrorCode, ObjectStoreErrorCode, GcErrorCode,
} from './store/index.js';
// Source capture (PR 04): authorised sources into one immutable snapshot admitted by the ledger; reopen, restore
// and reconcile. Capturing is an explicit call through an open store, never an import effect.
export {
  captureSnapshot, openSnapshot, restoreSnapshot, readSnapshot, reconcileInventory, validateMaterialization, SnapshotError,
  SNAPSHOT_ERROR_CODES, CAPTURE_REASON_CODES, DEFAULT_CAPTURE_POLICY, MATERIALIZATION_SCHEMA,
} from './snapshot/index.js';
export type {
  CaptureRequest, CaptureSourceRequest, CaptureModeRequest, CaptureResult, CaptureStore, SubmoduleRequest, OpenedSnapshot,
  RestoreOptions, RestoredSnapshot, RestoredSource, RestoreStore, Materialization, MaterializedSource, MaterializedFile,
  Reconciliation, CapturePolicy, SnapshotErrorCode, CaptureReasonCode,
} from './snapshot/index.js';
// Rule packs, the rule lock and trusted policy (ADR 21). Pure or explicit-path calls; nothing runs at import.
export * from './rules/index.js';
export * from './policy/index.js';
export { MAX_RECEIPT_TTL_MS } from './validate.js';
