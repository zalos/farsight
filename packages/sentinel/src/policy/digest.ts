// One digest rule for structured policy inputs: SHA-256 over canonical JSON (sorted keys, no whitespace), the same
// canonical form the object store uses, so a receipt, a lock and the object holding it agree on identity.
import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../store/objects.js';

export const sha256Digest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const canonicalDigest = (value: unknown): string => sha256Digest(canonicalJsonBytes(value));
