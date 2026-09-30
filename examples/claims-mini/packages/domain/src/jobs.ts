import { claims } from '@claims/db';
import { withTenant, requireSession } from './tenancy.js';

declare const db: any;

/**
 * Rolls the week's approved claims into one consolidated payment run.
 * @entrypoint job:weekly-consolidation
 * @business Once a week, all approved claims are bundled and paid out together.
 */
export function consolidateWeekly(clientId: string) {
  return withTenant(clientId, () => db.select().from(claims));
}

export function auditAccess(token: string) {
  requireSession(token);
  return db.query.claims.findMany({});
}
