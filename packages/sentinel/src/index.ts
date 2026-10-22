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
