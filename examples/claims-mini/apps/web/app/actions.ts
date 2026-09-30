'use server';
import { approveClaim } from '@claims/domain';

/** @business Approve a claim so payment can be scheduled. */
export async function approveClaimAction(id: string) {
  return approveClaim(id);
}
