// Draft types for the Sentinel ledger and its seams with the ownership lock and the object store. The ledger is the
// only writer of the database; nothing here exposes a connection, a statement or a transaction callback.
import type { ArtifactId, AttemptUsage, Count, Digest, Id, Ordinal, Timestamp, WorkRef } from '../contracts/index.js';
import { SentinelError } from '../kernel/errors.js';

/**
 * What the ledger needs from the store owner (the ownership lock implements it; this is a structural subset so the
 * owner's own type satisfies it). `assertHeld()` throws when the lock is no longer held by this process.
 */
export interface LedgerOwner {
  readonly storePath: string;
  readonly storeId: Id;
  /** A fresh, never-reused identity for this acquisition of the store. */
  readonly epoch: Id;
  /** The SQLite runtime the owner already checked against the release policy; the ledger opens through it only. */
  readonly runtime: { readonly sqlite: typeof import('node:sqlite') };
  /** The checked store layout; the ledger lives at `layout.ledger` and nowhere else. */
  readonly layout: { readonly root: string; readonly ledger: string; readonly owner: string };
  assertHeld(): void;
  /** The ledger registers itself so releasing ownership closes it first. Required: a ledger never outlives its owner. */
  registerResource(resource: { close(): void }): unknown;
}

/** Why the ledger refused: each is a catalog key in core strings-sentinel-storage-errors.ts. */
export const LEDGER_ERROR_CODES = [
  'sentinel.store.sqliteUnsupported',
  'sentinel.store.notLedger',
  'sentinel.store.unsafePath',
  'sentinel.store.newerSchema',
  'sentinel.store.migrationMismatch',
  'sentinel.store.migrationFailed',
  'sentinel.store.backupFailed',
  'sentinel.store.storeMismatch',
  'sentinel.store.ownerNotHeld',
  'sentinel.store.staleEpoch',
  'sentinel.store.closed',
  'sentinel.store.invalidInput',
  'sentinel.store.notFound',
  'sentinel.store.conflict',
  'sentinel.store.notActiveAttempt',
  'sentinel.store.wrongState',
  'sentinel.store.alreadyPublished',
  'sentinel.store.idempotencyConflict',
  'sentinel.store.stagingMismatch',
  'sentinel.store.objectMissing',
  'sentinel.store.objectVerifierUnavailable',
  'sentinel.store.asyncTransaction',
  'sentinel.store.snapshotStale',
  'sentinel.store.corruptRecord',
] as const;
/** One of {@link LEDGER_ERROR_CODES}. */
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/**
 * A stable ledger failure; the message is `<code>: <message>`. The message is safe context, never raw input bytes or a
 * filesystem secret.
 */
export class LedgerError extends SentinelError<LedgerErrorCode> {
  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, `${code}: ${message}`, { cause: options?.cause });
    this.name = 'LedgerError';
  }
}

// ---- The ledger ↔ object-store seam (draft; frozen early so both sides can build against it) ----

/** How an object's bytes are stored. The artifact ID always hashes the raw (decoded) bytes. */
/** `gzip` is any verified gzip member, whatever level wrote it; the writer's level is the object store's choice. */
export const ARTIFACT_CODECS = ['identity', 'gzip'] as const;
/** One of {@link ARTIFACT_CODECS}. */
export type ArtifactCodec = (typeof ARTIFACT_CODECS)[number];

/**
 * Ordered least to most protected. A reference records its own class; an artifact's floor is the most protected
 * class any reference ever gave it and never decreases.
 */
export const ARTIFACT_PRIVACY = ['metadata', 'source-derived', 'source'] as const;
/** One of {@link ARTIFACT_PRIVACY}. */
export type ArtifactPrivacy = (typeof ARTIFACT_PRIVACY)[number];

/** Largest decoded object the store accepts (16 MiB). */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** A staging registration's identity, chosen by the coordinator before any byte is written. */
export type StageId = Id;

/** What the coordinator intends to publish, registered durably before the object store writes a byte. */
export interface StagedArtifact {
  id: ArtifactId;
  /** A contract version (`sentinel-observation/draft-1`) or a media type (`text/plain`). */
  schema: string;
  privacy: ArtifactPrivacy;
  /** Artifacts this one names; their bytes must be staged or already present. */
  links?: ArtifactId[];
}

/** What the object store returns once an object's bytes are durable (written, verified, fsynced, renamed). */
export interface ObjectReceipt {
  id: ArtifactId;
  codec: ArtifactCodec;
  /** SHA-256 of the stored (possibly compressed) bytes. */
  storedDigest: Digest;
  rawSize: Count;
  storedSize: Count;
}

/** What the object store measured by re-reading a stored representation in this store. Never an echo of a receipt. */
export interface VerifiedObject extends ObjectReceipt {
  /** The store whose object directory was read; must equal the ledger's store. */
  storeId: Id;
}

/**
 * The object store's verifier. `verify` re-reads the named representation from this store's own objects, recomputes
 * the stored digest and size and the decoded raw digest and size, and returns what it measured, or null when the
 * object is absent, unreadable or corrupt. The ledger accepts a receipt only when every measured field equals it.
 * Publication fails closed without a verifier; a ledger opened without one can do everything except publish.
 */
export interface ObjectVerifier {
  verify(ref: { id: ArtifactId; codec: ArtifactCodec }): VerifiedObject | null;
}

// ---- Ledger inputs and outputs ----

/** A client's idempotency key. The same key with the same request replays the first result; another request is refused. */
export interface IdempotencyRef {
  clientId: Id;
  key: Id;
}

/** One publication: the work and attempt, the staging registration, and one receipt per staged artifact. */
export interface PublishInput {
  work: WorkRef;
  attemptId: Id;
  stageId: StageId;
  /** One receipt per staged artifact; the set must equal the staging registration. */
  receipts: ObjectReceipt[];
  /** The staged artifacts that are this attempt's outputs, in order. Others are only reachable through links. */
  outputs: ArtifactId[];
  endedAt: Timestamp;
  /** The usage observed at the end. Omitted: the start's usage stands. Never invented by the ledger. */
  usage?: AttemptUsage;
  idempotency?: IdempotencyRef;
}

/** The most artifacts one snapshot admission accepts across its stages. */
export const MAX_SNAPSHOT_ARTIFACTS = 262_144;

/**
 * A captured snapshot, admitted without a run. Its stages were registered without an attempt before any byte was
 * written; the receipts name every artifact they hold (content, manifest, materialization), each verified again.
 */
export interface AdmitSnapshotInput {
  snapshotId: Id;
  stageIds: StageId[];
  /** The `sentinel-snapshot/draft-1` envelope's artifact. */
  manifest: ArtifactId;
  /** The capture's materialization sidecar. */
  materialization: ArtifactId;
  inventoryDigest: Digest;
  receipts: ObjectReceipt[];
  idempotency?: IdempotencyRef;
}

/** One plan revision to admit: its run, revision, kind, digest, predecessor and the pins it binds. */
export interface AdmitPlanInput {
  runId: Id;
  revision: Ordinal;
  kind: 'bootstrap' | 'analysis';
  /** The plan revision's own digest. */
  digest: Digest;
  /** The digest of revision - 1 of this run; null exactly for revision 1. */
  previous: Digest | null;
  /** The canonical JSON of the exact plan revision. */
  plan: ArtifactId;
  /** The pinned rule lock and effective policy: both for an analysis revision, neither for a bootstrap one. */
  ruleLock: ArtifactId | null;
  policy: ArtifactId | null;
  /** The trusted execution profile the plan was made and is run under. */
  profile: ArtifactId;
  /** A selected rerun's selection record (analysis revisions only); null or absent otherwise. */
  selection?: ArtifactId | null;
  /** The admitted snapshot an analysis revision pins; null for a bootstrap revision. */
  snapshotId: Id | null;
  /** Unbound stages of this epoch holding exactly the receipts' artifacts, the plan linking each pinned one. */
  stageIds: StageId[];
  receipts: ObjectReceipt[];
  idempotency?: IdempotencyRef;
}

/** An admitted plan revision as the ledger records it. */
export interface PlanRecord {
  runId: Id;
  revision: Ordinal;
  kind: 'bootstrap' | 'analysis';
  digest: Digest;
  previous: Digest | null;
  plan: ArtifactId;
  ruleLock: ArtifactId | null;
  policy: ArtifactId | null;
  profile: ArtifactId;
  /** A selected rerun's selection record, or null. */
  selection: ArtifactId | null;
  snapshotId: Id | null;
  sequence: Count;
  admittedAt: Timestamp;
}

/** Artifacts accepted with an attempt's start (its invocation record and what it links), from one unbound stage. */
export interface AttemptRecords {
  stageId: StageId;
  receipts: ObjectReceipt[];
}

/** An admitted snapshot as the ledger records it: its manifest, materialization, inventory digest and sequence. */
export interface SnapshotRecord {
  snapshotId: Id;
  manifest: ArtifactId;
  materialization: ArtifactId;
  inventoryDigest: Digest;
  sequence: Count;
  admittedAt: Timestamp;
}

/** An accepted publication: its work and attempt, the result digest the ledger computed, its sequence and time. */
export interface PublicationReceipt {
  work: WorkRef;
  attemptId: Id;
  /** Computed by the ledger over the attempt, its outputs and their receipts; never taken from a worker. */
  resultDigest: Digest;
  sequence: Count;
  acceptedAt: Timestamp;
}

/** How an attempt can end other than by publishing. */
export const ATTEMPT_END_STATES = ['failed', 'interrupted', 'canceled', 'canceled-after-spend'] as const;
/** One of {@link ATTEMPT_END_STATES}. */
export type AttemptEndState = (typeof ATTEMPT_END_STATES)[number];

/** An attempt that ends without publishing: how it ended, when, and the work's state afterwards. */
export interface EndAttemptInput {
  work: WorkRef;
  attemptId: Id;
  state: AttemptEndState;
  endedAt: Timestamp;
  /** The work's state afterwards: retry-eligible (`ready`) or terminal (`failed`). */
  workState: 'ready' | 'failed';
  /**
   * Why it ended, recorded in the final envelope (code, retryable) and, bounded, beside it (detail). The detail is
   * safe structured context, at most 4 KiB as JSON; never an input's contents or a credential.
   */
  error?: AttemptError;
  /** The usage observed at the end; `canceled-after-spend` needs confirmed usage, here or from the start. */
  usage?: AttemptUsage;
  /** Private artifacts staged for this failed or canceled attempt before any bytes were written. */
  retained?: { stageId: StageId; receipts: ObjectReceipt[]; record: ArtifactId };
  idempotency?: IdempotencyRef;
}

/** Metadata only: the object store and its disclosure policy own the bytes. */
export interface RetainedAttempt {
  attemptId: Id;
  work: WorkRef;
  state: 'failed' | 'canceled' | 'canceled-after-spend';
  code: string;
  record: { id: ArtifactId; schema: string; privacy: ArtifactPrivacy };
  linked: Array<{ id: ArtifactId; schema: string; privacy: ArtifactPrivacy }>;
  sequence: Count;
}

/** An ended attempt's recorded failure. */
export interface AttemptError {
  /** A catalog key (sentinel.<area>.<word>). */
  code: string;
  retryable: boolean;
  /** An accepted artifact holding longer diagnostics, when there is one. */
  diagnostics?: ArtifactId;
  detail?: Record<string, unknown>;
}

/** A work revision's held or released state, set by the coordinator from the plan's dependency decisions. */
export type WorkTransition = 'ready' | 'blocked' | 'disabled-by-policy';

/** Every kind of event the ledger appends. */
export const LEDGER_EVENT_KINDS = [
  'epoch-opened',
  'run-created',
  'run-state',
  'work-created',
  'attempt-started',
  'attempt-ended',
  'work-published',
  'staging-registered',
  'staging-aborted',
  'report-pinned',
  'snapshot-admitted',
  'work-state',
  'plan-admitted',
  'run-plan-advanced',
  'evidence-opened',
  'evidence-staged',
  'evidence-transferred',
  'evidence-aborted',
  'evidence-accepted',
  'evidence-abandoned',
] as const;
/** One of {@link LEDGER_EVENT_KINDS}. */
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

/** One appended ledger event: its sequence, kind, run, work, epoch and payload. */
export interface LedgerEvent {
  sequence: Count;
  kind: LedgerEventKind;
  runId: Id | null;
  work: WorkRef | null;
  epoch: Id;
  at: Timestamp;
  payload: Record<string, unknown>;
}

/** One page of ledger events and where the next begins. */
export interface EventPage {
  events: LedgerEvent[];
  /** Pass as `after` to continue; equals the last event's sequence, or the request's `after` when empty. */
  cursor: Count;
  more: boolean;
}

/** The most events one page returns. */
export const MAX_EVENT_PAGE = 500;

/**
 * Everything garbage collection must keep, read in one transaction at one ledger sequence. The object store's
 * collector computes reachability from these roots through `links`; the ledger never deletes bytes.
 */
export interface GcSnapshot {
  /** The ledger's own store identity, never a caller's. */
  storeId: Id;
  /** Always true: the snapshot is the full committed state, read in one transaction. */
  complete: true;
  /** The last event sequence; every change to a root appends an event, so an unchanged sequence means unchanged roots. */
  sequence: Count;
  /** Artifacts with an accepted reference: publication outputs and their links' owners, and admitted snapshots' roots. */
  referenced: ArtifactId[];
  /** Artifacts pinned by an open staging registration, accepted or not. */
  staged: ArtifactId[];
  /** Artifacts pinned by a retained report's closure. */
  reports: ArtifactId[];
  /**
   * Every artifact a retained work or attempt envelope names: influence manifests, reuse derivations, invocations,
   * ended attempts' outputs and diagnostics. All are roots: there is no retention lifecycle until an explicit prune.
   */
  retained: ArtifactId[];
  /** The subset of `retained` named by work or attempts that have not finished. */
  active: ArtifactId[];
  /** Every recorded parent → child link. */
  links: Array<[ArtifactId, ArtifactId]>;
  /** Every recorded physical representation. */
  objects: ObjectReceipt[];
}

/** One numbered, checksummed schema step. Applied in one transaction with every other pending step. */
export interface Migration {
  version: Ordinal;
  name: string;
  sql: string;
}

/** How a ledger is opened: the build label for migrations, the clock, the object verifier and test failpoints. */
export interface OpenLedgerOptions {
  /** Recorded beside each applied migration. */
  build?: string;
  /** The clock for ledger-written timestamps; defaults to the system clock. */
  now?: () => Timestamp;
  /** Required to publish; see ObjectVerifier. */
  objects?: ObjectVerifier;
  /** Test seam: replaces the shipped migration list. */
  migrations?: readonly Migration[];
  /** Test seam: thrown from inside the named step to prove its failure path. */
  failpoint?: (point: LedgerFailpoint) => void;
}

/** A named point inside a ledger transaction where a test can inject a failure. */
export type LedgerFailpoint =
  | 'backup:before'
  | 'backup:after-copy'
  | 'migrate:after-sql'
  | 'publish:before-commit'
  | 'end:before-commit'
  | 'staging:before-commit'
  | 'snapshot:before-commit'
  | 'plan:before-commit';

/** What opening a ledger migrated: the schema versions before and after, and the verified backup taken. */
export interface MigrationReport {
  from: Count;
  to: Count;
  /** The verified backup taken before an upgrade of an existing ledger; null for a new or current one. */
  backupPath: string | null;
}
