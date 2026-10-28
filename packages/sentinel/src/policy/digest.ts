// One digest rule for structured policy inputs: SHA-256 over canonical JSON (sorted keys, no whitespace), the same
// canonical form the object store uses, so a receipt, a lock and the object holding it agree on identity.
import { canonicalJsonBytes } from '../store/objects.js';
import { sha256Id } from '../kernel/digest.js';

/** The content address of bytes (the kernel's sha256Id). */
export const sha256Digest = (bytes: Uint8Array): string => sha256Id(bytes);

/** The digest of a structured policy input over the object store's canonical bytes; refuses what they refuse. */
export const canonicalDigest = (value: unknown): string => sha256Digest(canonicalJsonBytes(value));
