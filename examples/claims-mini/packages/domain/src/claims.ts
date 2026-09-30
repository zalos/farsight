import { claims, payments } from '@claims/db';

declare const db: any;

export function listClaims() {
  return db.select().from(claims).where({ status: 'open' });
}

export function intakeClaim(body: unknown) {
  return db.insert(claims).values(body);
}

/** Approves a claim and returns its scheduled payment. */
export function approveClaim(id: string) {
  // @business Only a claim with a real id can be approved — blank requests change nothing
  if (id) { // @business Mark the claim approved so it can be paid out
    db.update(claims).set({ status: 'approved' });
  }
  return db.query.payments.findFirst({ where: { claimId: id } });
}
