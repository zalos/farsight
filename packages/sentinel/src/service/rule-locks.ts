// The owner's rule locks, in the owner's private state outside every checkout. Each lock revision is stored once,
// content-addressed by its digest, and never rewritten. Which revision is current is a chain of create-once links:
// `first` names the first selected revision and `next/<digest>` names the one revision that succeeded it. Creating a
// link is the compare-and-swap: only one promotion can ever succeed a given revision, however many race, so a
// promotion confirmed against a revision that is no longer current is refused, never merged or lost.
// Every record is published whole or not at all (publish-once.ts): a reader, a racing promotion or a crash never
// meets a final name with partial content, so a failure cannot poison the chain.
// A lock is trusted only as read back here and verified against the digest it is filed under: a repository can
// ship no lock and select none. Promotion itself is E's (rules/lock.ts promote); this file only keeps its results.
import { basename, dirname, join } from 'node:path';
import type { RuleLockEnvelope } from '../contracts/index.js';
import { PolicyError } from '../policy/index.js';
import { ensurePrivateDir } from '../policy/user-state.js';
import { ensureDurableDir, publishOnce, readPublished, UnsafeRecordError, type PublishHooks } from './publish-once.js';
import { lockDigest, verifyPinnedLock } from '../rules/index.js';
import { ServiceError } from './owner-service.js';

const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_POINTER_BYTES = 1024;
/** Revisions a chain may hold before it is refused as unusable rather than walked without end. */
const MAX_REVISIONS = 100_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UNSAFE = 'sentinel.receipt.storeUnsafe' as const;

export interface CurrentLock {
  readonly lock: RuleLockEnvelope;
  readonly digest: string;
}

/** Any unsafe owner-private file below (a link, another account's, open to others) is the service record error. */
function safely<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if ((e instanceof PolicyError && e.code === UNSAFE) || e instanceof UnsafeRecordError) throw new ServiceError('sentinel.service.recordUnsafe');
    throw e;
  }
}

export class RuleLockBook {
  readonly #dir: string;
  readonly #revisions: string;

  readonly #hooks: PublishHooks;

  /** `trustDir` is the owner's private Sentinel state (adoption, receipts). `hooks` is a crash-test seam only. */
  constructor(trustDir: string, options: { hooks?: PublishHooks } = {}) {
    this.#hooks = options.hooks ?? {};
    this.#dir = join(trustDir, 'rules');
    this.#revisions = join(this.#dir, 'locks');
  }

  /** The digest the chain ends at, or null when no lock was ever selected. */
  currentDigest(): string | null {
    let digest = this.#link('first');
    if (digest === null) return null;
    for (let i = 0; i < MAX_REVISIONS; i++) {
      const next = this.#link(join('next', `${digest.slice(7)}.json`));
      if (next === null) return digest;
      digest = next;
    }
    throw new ServiceError('sentinel.service.recordUnsafe');
  }

  /** One link's target, or null when the link does not exist. */
  #link(name: string): string | null {
    const bytes = safely(() => readPublished(dirname(join(this.#dir, name)), basename(name), MAX_POINTER_BYTES));
    if (!bytes) return null;
    let v: { schema?: unknown; digest?: unknown };
    try { v = JSON.parse(bytes.toString('utf8')); } catch { throw new ServiceError('sentinel.service.recordUnsafe'); }
    if (v?.schema !== 'sentinel-lock-link/draft-1' || typeof v.digest !== 'string' || !DIGEST.test(v.digest)) throw new ServiceError('sentinel.service.recordUnsafe');
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
    const bytes = safely(() => readPublished(this.#revisions, `${digest.slice(7)}.json`, MAX_LOCK_BYTES));
    if (!bytes) throw new ServiceError('sentinel.service.recordUnsafe');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ServiceError('sentinel.service.recordUnsafe'); }
    return verifyPinnedLock(value, digest);
  }

  /** Files a revision under its digest, once. A revision already filed must be the same lock. Returns the digest. */
  store(lock: RuleLockEnvelope): string {
    const digest = lockDigest(lock);
    safely(() => { ensureDurableDir(this.#revisions); ensurePrivateDir(this.#revisions, UNSAFE); });
    const created = publishOnce(this.#revisions, `${digest.slice(7)}.json`, Buffer.from(JSON.stringify(lock)), this.#hooks);
    if (!created) this.read(digest);
    return digest;
  }

  /**
   * Makes `digest` (already stored) current by linking it after `expected` (null: as the first). The link is created
   * once: if any revision already succeeded `expected`, this promotion raced another and is refused.
   */
  select(digest: string, expected: string | null): void {
    this.read(digest);
    if (expected !== null) this.read(expected);
    const dir = expected === null ? this.#dir : join(this.#dir, 'next');
    const name = expected === null ? 'first' : `${expected.slice(7)}.json`;
    safely(() => { ensureDurableDir(dir); ensurePrivateDir(dir, UNSAFE); });
    const linked = publishOnce(dir, name, Buffer.from(JSON.stringify({ schema: 'sentinel-lock-link/draft-1', digest })), this.#hooks);
    if (!linked) throw new ServiceError('sentinel.service.lockChanged');
  }
}
