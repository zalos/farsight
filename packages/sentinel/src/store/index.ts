// The supported store facade (ADR 19): one call opens a Sentinel store the only way production may open it.
//
// openStore() acquires the real owner lock first (runtime gate, canonical local owner-only folder, lifetime
// lock), then opens the content-addressed object store under that owner, then opens (creating or migrating)
// the ledger with the object store's own verifier, so a publication is accepted only after the bytes it names
// were re-read and hashed in this store. The ledger registers itself with the owner, so closing the store
// closes the ledger while the lock is still held. A failure anywhere in the open releases what was taken.
//
// What is deliberately not reachable from here: the SQLite connection or module, the owner's lock database,
// the ledger's migration list and failpoints, the object store's filesystem seam, and any way to publish
// without byte verification or under a stand-in owner. Those remain internal test seams of their modules.
//
// Importing this module opens nothing, starts no process and touches no file; the SQLite module is imported
// lazily by the first openStore().
import type { ArtifactId, Id } from '../contracts/index.js';
import { StoreError, STORE_ERROR_CODES, type StoreErrorCode } from './errors.js';
import { inspectReachability, type GcErrorCode, type PrunePlan, type ReachabilityReport } from './gc.js';
import { openLedger, type Ledger } from './ledger.js';
import {
  ledgerObjectVerifier,
  planPruneFromLedger,
  reachabilityFromLedger,
  refFromLedgerReceipt,
  toLedgerReceipt,
} from './objects-ledger.js';
import {
  ObjectStore,
  ObjectStoreError,
  canonicalJsonBytes,
  identify,
  rawDigestOf,
  type ObjectCheck,
  type ObjectStoreErrorCode,
} from './objects.js';
import { acquireStoreOwner, type StoreOwner } from './owner.js';
import { bindOwner } from './owner-binding.js';
import { budgetedObjectRead, readBudgetCheckpoint, readBudgetFailure } from './read-budget.js';
import type { FilesystemIdentity } from './paths.js';
import {
  SQLITE_RELEASE_POLICY,
  qualificationFor,
  type QualifiedRuntime,
  type QualificationStatus,
  type SqliteReleasePolicy,
} from './runtime.js';
import {
  LEDGER_ERROR_CODES,
  LedgerError,
  type ArtifactCodec,
  type LedgerErrorCode,
  type MigrationReport,
  type ObjectReceipt as LedgerObjectReceipt,
} from './store-types.js';

export { StoreError, LedgerError, ObjectStoreError, SQLITE_RELEASE_POLICY, qualificationFor };
export type { QualifiedRuntime, QualificationStatus, SqliteReleasePolicy };
export type { StoreErrorCode, LedgerErrorCode, ObjectStoreErrorCode, GcErrorCode, FilesystemIdentity, MigrationReport };
export type { ReachabilityReport, PrunePlan, ObjectCheck, ArtifactCodec };
export {
  ARTIFACT_CODECS,
  ARTIFACT_PRIVACY,
  LEDGER_EVENT_KINDS,
  ATTEMPT_END_STATES,
  MAX_ARTIFACT_BYTES,
  MAX_EVENT_PAGE,
  MAX_SNAPSHOT_ARTIFACTS,
} from './store-types.js';
export type {
  ArtifactPrivacy,
  StagedArtifact,
  StageId,
  PublishInput,
  PublicationReceipt,
  EndAttemptInput,
  AttemptEndState,
  AdmitSnapshotInput,
  SnapshotRecord,
  IdempotencyRef,
  LedgerEvent,
  LedgerEventKind,
  EventPage,
  GcSnapshot,
} from './store-types.js';

/**
 * A stored object as the ledger records it: the receipt a publication names. Returned by `objects.put()` only
 * after the bytes are written, fsynced, verified and atomically linked into this store.
 */
export type StoredObject = LedgerObjectReceipt;

/** The identity of bytes before anything is written: what `registerStaging` pins before `objects.put()`. */
export interface ObjectIdentityRef {
  readonly id: ArtifactId;
  readonly rawSize: number;
}

/** How openStore acquires the store: SQLite's busy budget and the build label recorded with migrations. */
export interface OpenStoreOptions {
  /** SQLite's busy budget for a contended owner lock, in ms (0–10000, default 250). Not a lease. */
  readonly waitMs?: number;
  /** Recorded beside each applied ledger migration (for example a package version). */
  readonly build?: string;
}

/** The ledger's domain operations. There is no connection, statement, transaction callback or close here. */
export type StoreLedger = Pick<
  Ledger,
  | 'createRun'
  | 'setRunState'
  | 'createWork'
  | 'startAttempt'
  | 'endAttempt'
  | 'registerStaging'
  | 'abortStaging'
  | 'publish'
  | 'pinReport'
  | 'readEvents'
  | 'getWork'
  | 'getAttempt'
  | 'getPublication'
  | 'objectsOf'
  | 'currentSequence'
  | 'admitSnapshot'
  | 'getSnapshot'
  | 'admitPlan'
  | 'getPlan'
  | 'latestPlan'
  | 'listPlans'
  | 'advanceRunPlan'
  | 'setWorkState'
  | 'interruptStaleAttempts'
  | 'getRun'
  | 'listRuns'
  | 'listAttempts'
  | 'countAttempts'
  | 'listOpenStages'
>;

/** The store's object operations: identify, put, read and check bytes, all bound to the held store. */
export interface StoreObjects {
  /** The artifact id and size of bytes, computed without writing. */
  identify(bytes: Uint8Array): ObjectIdentityRef;
  /** The artifact id and size of a structured value's canonical JSON, computed without writing. */
  identifyCanonicalJson(value: unknown): ObjectIdentityRef;
  /**
   * Durably stores verbatim bytes (gzip-encoded; the artifact id always hashes the raw bytes). With `expect`, the
   * identity registered as staging, different bytes are refused before anything is written.
   */
  put(bytes: Uint8Array, options?: PutObjectOptions): Promise<StoredObject>;
  putCanonicalJson(value: unknown, options?: PutObjectOptions): Promise<StoredObject>;
  /** The raw bytes, after checking the stored digest and size, the decode bound, raw size and raw digest. */
  read(ref: StoredObject): Promise<Buffer>;
  /** Refuses bytes that are not the canonical JSON form of what they parse to. */
  readCanonicalJson(ref: StoredObject): Promise<unknown>;
  /** Never throws for a missing, corrupt or unsafe object; reports which. */
  check(ref: StoredObject): Promise<ObjectCheck>;
}

/** What a put must match: the identity registered as staging, so different bytes are refused before any write. */
export interface PutObjectOptions {
  /** The identity registered as staging; different bytes are refused before anything is written. */
  readonly expect?: ObjectIdentityRef;
}

/** The runtime a store was opened under: SQLite, Node, platform and the behaviour checks that passed. */
export interface StoreRuntimeFacts {
  readonly sqlite: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly checks: readonly string[];
}

/** An open store: its folder, id and epoch, the ledger, the objects, and the checks that it is still held. */
export interface SentinelStore {
  /** The canonical store folder. */
  readonly storePath: string;
  /** Stable for the life of the store. */
  readonly storeId: Id;
  /** This acquisition's coordinator epoch; envelopes created under an earlier one are refused. */
  readonly epoch: Id;
  readonly filesystem: FilesystemIdentity;
  readonly runtime: StoreRuntimeFacts;
  /** What the open did to the ledger schema, with the verified pre-upgrade backup when one was taken. */
  readonly migration: MigrationReport;
  readonly ledger: StoreLedger;
  readonly objects: StoreObjects;
  /** False once closed or once the lock is lost. */
  readonly held: boolean;
  /** Throws unless this process still holds the store. */
  assertHeld(): void;
  /** Reads an accepted artifact's bytes through a representation the ledger recorded; refuses unknown ids. */
  readArtifact(id: ArtifactId): Promise<Buffer>;
  /** SQLite's integrity and foreign-key checks over the ledger. Object bytes are checked by `inspect`. */
  checkIntegrity(): { integrity: string; foreignKeyViolations: number };
  /**
   * Reachability from the ledger's roots at one committed sequence, reading and verifying every reachable and
   * recorded object. Read-only; fails closed if the ledger moves during the inspection.
   */
  inspect(): Promise<ReachabilityReport>;
  /**
   * A dry-run prune plan: what an explicit, later prune could remove. Never deletes anything; lists no candidate
   * when anything reachable or recorded fails to verify or the ledger moves during the plan.
   */
  planPrune(): Promise<PrunePlan>;
  /** Closes the ledger, then releases the owner lock. Idempotent. */
  close(): void;
}

/**
 * Opens a Sentinel store at a canonical, absolute, local, owner-only folder (created 0700 when absent). Fails
 * closed: an unqualified SQLite release or host, an alias or link on the path, a network or unrecognised file
 * system, another owner, a newer ledger schema or a failed migration all refuse, and release what was taken.
 */
export async function openStore(storePath: string, options: OpenStoreOptions = {}): Promise<SentinelStore> {
  const owner = await acquireStoreOwner(storePath, options.waitMs === undefined ? {} : { waitMs: options.waitMs });
  try {
    const objects = new ObjectStore(owner);
    const ledger = await openLedger(owner, {
      objects: ledgerObjectVerifier(objects),
      ...(options.build === undefined ? {} : { build: options.build }),
    });
    return facade(owner, ledger, objects);
  } catch (error) {
    try {
      owner.close();
    } catch {
      /* the open's own failure is the one to report; the lock is released regardless */
    }
    throw error;
  }
}

const LEDGER_METHODS = [
  'createRun',
  'setRunState',
  'createWork',
  'startAttempt',
  'endAttempt',
  'registerStaging',
  'abortStaging',
  'publish',
  'pinReport',
  'readEvents',
  'getWork',
  'getAttempt',
  'getPublication',
  'objectsOf',
  'currentSequence',
  'admitSnapshot',
  'getSnapshot',
  'admitPlan',
  'getPlan',
  'latestPlan',
  'listPlans',
  'advanceRunPlan',
  'setWorkState',
  'interruptStaleAttempts',
  'getRun',
  'listRuns',
  'listAttempts',
  'countAttempts',
  'listOpenStages',
] as const satisfies readonly (keyof StoreLedger)[];

const objectRef = (receipt: StoredObject) => {
  const ref = refFromLedgerReceipt(receipt);
  if (!ref) throw new ObjectStoreError('sentinel.object.invalidInput', 'not a stored-object receipt');
  return ref;
};

const identityOf = (bytes: Uint8Array): ObjectIdentityRef => {
  const id = identify(bytes);
  return Object.freeze({ id: id.artifactId, rawSize: id.rawSize });
};

function facade(owner: StoreOwner, ledger: Ledger, store: ObjectStore): SentinelStore {
  const ledgerView = Object.freeze(
    Object.fromEntries(
      LEDGER_METHODS.map((name) => [
        name,
        (...args: unknown[]) => {
          try {
            return (ledger[name] as (...args: unknown[]) => unknown).apply(ledger, args);
          } catch (error) {
            readBudgetFailure(sentinel, error);
            throw error;
          }
        },
      ]),
    ),
  ) as unknown as StoreLedger;

  // The registered identity is checked by the object store before any byte is written.
  const putOptions = (options: PutObjectOptions = {}) =>
    options.expect
      ? {
          expect: {
            artifactId: options.expect.id,
            rawDigest: rawDigestOf(options.expect.id),
            rawSize: options.expect.rawSize,
          },
        }
      : {};

  const objects: StoreObjects = Object.freeze({
    identify: identityOf,
    identifyCanonicalJson: (value: unknown) => identityOf(canonicalJsonBytes(value)),
    put: async (bytes: Uint8Array, options?: PutObjectOptions) =>
      toLedgerReceipt(await store.put(bytes, putOptions(options))),
    putCanonicalJson: async (value: unknown, options?: PutObjectOptions) =>
      toLedgerReceipt(await store.putCanonicalJson(value, putOptions(options))),
    read: (ref: StoredObject) => {
      const captured = objectRef(ref);
      return budgetedObjectRead(sentinel, { rawSize: captured.rawSize!, storedSize: captured.encodedSize! }, () =>
        store.read(captured),
      );
    },
    readCanonicalJson: (ref: StoredObject) => {
      const captured = objectRef(ref);
      return budgetedObjectRead(sentinel, { rawSize: captured.rawSize!, storedSize: captured.encodedSize! }, () =>
        store.readCanonicalJson(captured),
      );
    },
    check: (ref: StoredObject) => {
      const captured = objectRef(ref);
      return budgetedObjectRead(sentinel, { rawSize: captured.rawSize!, storedSize: captured.encodedSize! }, () =>
        store.check(captured),
      );
    },
  });

  const runtime: StoreRuntimeFacts = Object.freeze({
    sqlite: owner.runtime.sqliteVersion,
    node: owner.runtime.node,
    platform: owner.runtime.platform,
    arch: owner.runtime.arch,
    checks: owner.runtime.checks,
  });

  const sentinel: SentinelStore = Object.freeze({
    storePath: owner.storePath,
    storeId: owner.storeId,
    epoch: owner.epoch,
    filesystem: owner.filesystem,
    runtime,
    migration: ledger.migration,
    ledger: ledgerView,
    objects,
    get held() {
      return owner.held;
    },
    assertHeld: () => owner.assertHeld(),
    async readArtifact(id: ArtifactId): Promise<Buffer> {
      const recorded = ledgerView.objectsOf(id);
      if (recorded.length === 0) throw new LedgerError('sentinel.store.notFound', 'no accepted artifact has that id');
      let last: unknown;
      for (const receipt of recorded) {
        try {
          return await objects.read(receipt);
        } catch (error) {
          readBudgetCheckpoint(sentinel);
          last = error;
        }
      }
      throw last;
    },
    checkIntegrity: () => ledger.checkIntegrity(),
    inspect: () =>
      inspectReachability(store, reachabilityFromLedger(ledger.gcSnapshot()), {
        readSequence: () => ledger.currentSequence(),
      }),
    planPrune: () => planPruneFromLedger(store, ledger),
    close: () => owner.close(),
  });
  // Internal only (owner-binding.ts): lets package code bind worker execution to this store's lock.
  bindOwner(sentinel, owner);
  return sentinel;
}

// ---- error codes ----

// Exhaustive by construction: a code added to (or removed from) a module's union fails to compile here.
const OBJECT_CODES = {
  'sentinel.object.invalidInput': true,
  'sentinel.object.tooLarge': true,
  'sentinel.object.digestMismatch': true,
  'sentinel.object.missing': true,
  'sentinel.object.corrupt': true,
  'sentinel.object.corruptExisting': true,
  'sentinel.object.wrongStore': true,
  'sentinel.object.unsafePath': true,
  'sentinel.object.notCanonical': true,
  'sentinel.object.io': true,
} as const satisfies Record<ObjectStoreErrorCode, true>;
const GC_CODES = {
  'sentinel.gc.incompleteSnapshot': true,
  'sentinel.gc.wrongStore': true,
  'sentinel.gc.invalidSnapshot': true,
  'sentinel.gc.missingReachable': true,
  'sentinel.gc.missingRecorded': true,
  'sentinel.gc.corruptObject': true,
  'sentinel.gc.sequenceUnverified': true,
  'sentinel.gc.snapshotMoved': true,
  'sentinel.gc.unreadableStore': true,
} as const satisfies Record<GcErrorCode, true>;

/** Every reason code the store can report, by the module that raises it. Each is a catalog key with a define. */
export const STORAGE_ERROR_CODES = Object.freeze({
  owner: STORE_ERROR_CODES,
  ledger: Object.freeze([...LEDGER_ERROR_CODES]) as readonly LedgerErrorCode[],
  objects: Object.freeze(Object.keys(OBJECT_CODES)) as readonly ObjectStoreErrorCode[],
  gc: Object.freeze(Object.keys(GC_CODES)) as readonly GcErrorCode[],
});
