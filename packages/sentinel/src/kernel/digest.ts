// The one canonical JSON form and the one SHA-256 helper every Sentinel identity is built from (the L0 kernel of
// docs/proposals/sentinel-v2/README.md §6). The kernel imports nothing from the rest of the package.
//
// canonicalJson is the object store's implementation moved here unchanged; store/objects.ts and store/ledger-json.ts
// both answer through it. test/kernel-digest.test.ts holds the two implementations it replaced, copied verbatim from
// main at 5aad3a6b, and proves the three byte-identical on every JSON fixture in the repository and on every object a
// real run retains.
import { createHash } from 'node:crypto';

/** A SHA-256 content address: `sha256:` and 64 lower-case hex characters. */
export type Sha256Id = `sha256:${string}`;

/** Why canonicalJson refused a value. */
export type CanonicalRefusalReason = 'tooDeep' | 'nonFinite' | 'noJsonForm' | 'cyclic' | 'notPlain' | 'symbolKey';

/** One refusal: its reason and a short sentence naming the kind of value refused, never any part of the value. */
export interface CanonicalRefusal {
  readonly reason: CanonicalRefusalReason;
  readonly message: string;
}

/** Raises a refusal as the caller's own error; it must throw. */
export type CanonicalRefuse = (refusal: CanonicalRefusal) => never;

/** The deepest nesting canonicalJson accepts: a value nested deeper is refused, never truncated. */
export const MAX_CANONICAL_DEPTH = 256;

/** The default refusal: a TypeError, the error JSON itself raises for a value it cannot write. */
const refuseAsTypeError: CanonicalRefuse = (refusal) => {
  throw new TypeError(`canonical JSON refuses this value: ${refusal.message}`);
};

/**
 * The canonical JSON spelling of a value, the bytes every structured digest is taken over.
 *
 * Guarantees: object keys are sorted by UTF-16 code unit; there is no whitespace; strings, finite numbers, booleans
 * and null are written as `JSON.stringify` writes them (so `-0` is `0`); equal values always give the same string.
 *
 * Refuses, through `refuse` (a TypeError by default), anything JSON cannot round-trip exactly: `undefined` (as a
 * member, an array item or a hole in a sparse array), a function, a symbol, a bigint, a non-finite number, an object
 * whose prototype is neither `Object.prototype` nor `null` (a Date, a Map, a class instance, a typed array), a symbol
 * key, a cycle, and nesting deeper than {@link MAX_CANONICAL_DEPTH} levels. A shared sub-object that is not a cycle is
 * written at each place it appears. Nothing is ever dropped: a value is written whole or refused.
 */
export function canonicalJson(value: unknown, refuse: CanonicalRefuse = refuseAsTypeError): string {
  const stop = (reason: CanonicalRefusalReason, message: string): never => {
    refuse({ reason, message });
    throw new TypeError(`canonical JSON refuses this value: ${message}`); // a refuse that returned
  };
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string => {
    if (depth > MAX_CANONICAL_DEPTH) stop('tooDeep', `structure is nested deeper than ${MAX_CANONICAL_DEPTH} levels`);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) stop('nonFinite', 'non-finite number');
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    }
    if (typeof v !== 'object') return stop('noJsonForm', `${typeof v} has no JSON form`);
    if (seen.has(v)) stop('cyclic', 'cyclic structure');
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = `[${Array.from(v, (item) => walk(item, depth + 1)).join(',')}]`;
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) stop('notPlain', 'only plain objects have a canonical form');
      if (Object.getOwnPropertySymbols(v).length) stop('symbolKey', 'symbol keys have no JSON form');
      const keys = Object.keys(v).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(value, 0);
}

/** {@link canonicalJson} as UTF-8 bytes; refuses exactly what it refuses. */
export function canonicalJsonBytes(value: unknown, refuse?: CanonicalRefuse): Buffer {
  return Buffer.from(canonicalJson(value, refuse), 'utf8');
}

/** The SHA-256 of bytes, or of a string's UTF-8 bytes, as 64 lower-case hex characters. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The content address of bytes, or of a string's UTF-8 bytes: `sha256:<hex>`. */
export function sha256Id(data: Uint8Array | string): Sha256Id {
  return `sha256:${sha256Hex(data)}`;
}

/**
 * The digest of a structured value: {@link sha256Id} over its {@link canonicalJson} bytes. The object store files a
 * value stored as canonical JSON under exactly this id. Refuses exactly what canonicalJson refuses.
 */
export function digestOf(value: unknown, refuse?: CanonicalRefuse): Sha256Id {
  return sha256Id(canonicalJson(value, refuse));
}
