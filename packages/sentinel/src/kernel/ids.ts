// The identifier and digest patterns, written once (README §6, L0). contracts/common.ts states the same forms as the
// published schema bounds (`Id`, `Digest`); these are the runtime checks. The patterns are frozen, so no module can
// recompile one and change what every other module accepts.

/** A ledger identifier: a letter or digit, then letters, digits, `.`, `_`, `:` or `-`; at most 128 characters. */
export const ID_PATTERN: RegExp = Object.freeze(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** A SHA-256 content address: `sha256:` and 64 lower-case hex characters. */
export const DIGEST_PATTERN: RegExp = Object.freeze(/^sha256:[0-9a-f]{64}$/);

/** A bare SHA-256: 64 lower-case hex characters. */
export const HEX64_PATTERN: RegExp = Object.freeze(/^[0-9a-f]{64}$/);

/** True only for a string that is a ledger identifier ({@link ID_PATTERN}). */
export const isId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

/** True only for a string that is a content address ({@link DIGEST_PATTERN}). */
export const isDigest = (value: unknown): value is `sha256:${string}` =>
  typeof value === 'string' && DIGEST_PATTERN.test(value);

/** True only for a string of 64 lower-case hex characters ({@link HEX64_PATTERN}). */
export const isHex64 = (value: unknown): value is string => typeof value === 'string' && HEX64_PATTERN.test(value);

/** The 64 hex characters of a content address, or undefined when the value is not one. */
export const hexOfDigest = (value: unknown): string | undefined => (isDigest(value) ? value.slice(7) : undefined);
