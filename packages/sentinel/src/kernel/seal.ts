// A record sealed by its own digest (README §6, L0): `digest` is the canonical digest of every other field, so an
// edit after sealing is detectable. Plan revisions, instruction manifests and review requests are sealed this way.
import { digestOf, type CanonicalRefuse, type Sha256Id } from './digest.js';

/** A record carrying the digest of everything else in it. */
export type Sealed<T extends object> = T & { readonly digest: Sha256Id };

/**
 * A new object holding `body`'s fields and `digest`, the {@link digestOf} of `body`. `body` itself is not changed.
 * Refuses, with a TypeError, a body that already has its own `digest` field (the seal would cover an old digest);
 * refuses through `refuse` what canonicalJson refuses.
 */
export function sealDigest<T extends object>(body: T, refuse?: CanonicalRefuse): Sealed<T> {
  if (Object.prototype.hasOwnProperty.call(body, 'digest')) throw new TypeError('a sealed body has no digest field');
  return { ...body, digest: digestOf(body, refuse) };
}

const notCanonical = Symbol('not canonical');

/**
 * True only when `record.digest` is a string equal to the {@link digestOf} of every other own field. False, never an
 * error, for a record whose other fields have no canonical form: such a record cannot be sealed, so it is not.
 */
export function verifySealedDigest(record: { readonly digest?: unknown }): boolean {
  const { digest, ...rest } = record;
  if (typeof digest !== 'string') return false;
  try {
    return (
      digest ===
      digestOf(rest, () => {
        throw notCanonical;
      })
    );
  } catch (e) {
    if (e === notCanonical) return false;
    throw e;
  }
}
