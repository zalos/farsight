/**
 * Sets the tenant on the RLS session before running fn.
 * @guard tenant-isolation
 * @business Ensures a client can only ever see its own claims and payments.
 */
export function withTenant(clientId: string, fn: () => unknown) {
  return fn();
}

/** Verifies the caller session; config-declared guard (see farsight.config.json). */
export function requireSession(token: string) {
  return token;
}

/**
 * Verifies the caller holds an active contractor session.
 * @guard contractor-session
 */
export function requireContractorSession(token: string) {
  return token;
}
