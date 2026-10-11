// The same conservative boundary protects pinned lessons and shared memories.
// Return a boolean only: callers must never include a matching value in errors.
const CREDENTIAL_SHAPE = /keychain:|\benv:[A-Z_]|\b(?:bearer|basic)\s+[A-Za-z0-9+/=._-]{12,}|[A-Za-z0-9+_=-]{32,}/i;

export function containsCredentialShape(value: string): boolean {
  return CREDENTIAL_SHAPE.test(value);
}
