// The owner's rule locks, in the owner's private state outside every checkout. Each lock revision is stored once,
// content-addressed by its digest, and never rewritten; which revision is current is one small pointer replaced
// atomically, and only from the revision it was read at (a promotion that raced another is refused, never merged).
// A lock is trusted only as read back here and verified against the digest it is filed under: a repository can
// ship no lock and select none. Promotion itself is E's (rules/lock.ts promote); this file only keeps its results.
import { join } from 'node:path';
import type { RuleLockEnvelope } from '../contracts/index.js';
import { PolicyError } from '../policy/index.js';
import { createPrivateFileOnce, ensurePrivateDir, readPrivateFile, writePrivateFileAtomic } from '../policy/user-state.js';
import { lockDigest, verifyPinnedLock } from '../rules/index.js';
import { ServiceError } from './owner-service.js';

const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_POINTER_BYTES = 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UNSAFE = 'sentinel.receipt.storeUnsafe' as const;

export interface CurrentLock {
  readonly lock: RuleLockEnvelope;
  readonly digest: string;
}

/** Any unsafe owner-private file below (a link, another account's, open to others) is the service record error. */
function safely<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PolicyError && e.code === UNSAFE) throw new ServiceError('sentinel.service.recordUnsafe');
    throw e;
  }
}

export class RuleLockBook {
  readonly #dir: string;
  readonly #revisions: string;

  /** `trustDir` is the owner's private Sentinel state (adoption, receipts). */
  constructor(trustDir: string) {
    this.#dir = join(trustDir, 'rules');
    this.#revisions = join(this.#dir, 'locks');
  }

  /** The digest the current pointer names, or null when no lock was ever selected. */
  currentDigest(): string | null {
    const bytes = safely(() => readPrivateFile(join(this.#dir, 'current.json'), MAX_POINTER_BYTES, UNSAFE));
    if (!bytes) return null;
    let v: { schema?: unknown; digest?: unknown };
    try { v = JSON.parse(bytes.toString('utf8')); } catch { throw new ServiceError('sentinel.service.recordUnsafe'); }
    if (v?.schema !== 'sentinel-lock-current/draft-1' || typeof v.digest !== 'string' || !DIGEST.test(v.digest)) throw new ServiceError('sentinel.service.recordUnsafe');
    return v.digest;
  }

  /** The current lock, read back and verified against the digest the pointer names; null when none was selected. */
  current(): CurrentLock | null {
    const digest = this.currentDigest();
    return digest === null ? null : { lock: this.read(digest), digest };
  }

  /** One stored revision, verified: its bytes must be the lock that digest names. */
  read(digest: string): RuleLockEnvelope {
    if (!DIGEST.test(digest)) throw new ServiceError('sentinel.service.recordUnsafe');
    const bytes = safely(() => readPrivateFile(join(this.#revisions, `${digest.slice(7)}.json`), MAX_LOCK_BYTES, UNSAFE));
    if (!bytes) throw new ServiceError('sentinel.service.recordUnsafe');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ServiceError('sentinel.service.recordUnsafe'); }
    return verifyPinnedLock(value, digest);
  }

  /** Files a revision under its digest, once. A revision already filed must be the same lock. Returns the digest. */
  store(lock: RuleLockEnvelope): string {
    const digest = lockDigest(lock);
    safely(() => ensurePrivateDir(this.#revisions, UNSAFE));
    const created = safely(() => createPrivateFileOnce(this.#revisions, `${digest.slice(7)}.json`, Buffer.from(JSON.stringify(lock)), UNSAFE));
    if (!created) this.read(digest);
    return digest;
  }

  /**
   * Makes `digest` (already stored) current, but only if the pointer still names `expected` (null: none selected
   * yet). Another promotion that landed in between refuses this one rather than being overwritten.
   */
  select(digest: string, expected: string | null): void {
    this.read(digest);
    if (this.currentDigest() !== expected) throw new ServiceError('sentinel.service.lockChanged');
    safely(() => writePrivateFileAtomic(this.#dir, 'current.json',
      Buffer.from(JSON.stringify({ schema: 'sentinel-lock-current/draft-1', digest })), UNSAFE));
  }
}
