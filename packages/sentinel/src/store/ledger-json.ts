// Canonical JSON and digests for ledger-computed identities (request digests, result digests, plan revisions). The
// one implementation is the kernel's (kernel/digest.ts); this module keeps its import path and its contract for the
// folders that use it. The ledger's own copy was deleted once kernel-digest.test.ts proved the two byte-identical on
// every JSON fixture and every retained object.
import { canonicalJson as kernelCanonicalJson, digestOf as kernelDigestOf } from '../kernel/digest.js';

/**
 * The canonical JSON of a value: keys sorted by UTF-16 code unit, no whitespace. Refuses, with a TypeError, a value
 * that would silently disappear or change (undefined, a function, a non-finite number, a bigint, a non-plain
 * object, a symbol key, a cycle, nesting past 256 levels) rather than encoding it.
 */
export function canonicalJson(value: unknown): string {
  return kernelCanonicalJson(value);
}

/** `sha256:<hex>` of {@link canonicalJson}'s UTF-8 bytes; refuses exactly what it refuses. */
export const digestOf = (value: unknown): string => kernelDigestOf(value);
