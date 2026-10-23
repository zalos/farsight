// Deployment claims are deliberately separate from graph control facts. Claiming runtime-observed in JSON is
// still only a claim: verification requires the bounded importer's private provenance, added at the import seam.
import type { Digest, NodeId } from '../contracts/common.js';
import type { AssertionTrust } from '../contracts/disposition.js';
import { snapshot } from '../policy/immutable.js';
import { compareTimestamps } from '../validate.js';
import { fail, fields, list, timestamp, unique, validDigest, validId, validNode } from './decision-data.js';

export const ASSERTION_PROPERTIES = ['authentication', 'authorization', 'csrf', 'input-validation', 'rate-limit',
  'security-headers', 'cors', 'cookie-integrity', 'cookie-confidentiality', 'cookie-secure', 'cookie-http-only', 'cookie-same-site'] as const;
export type AssertionProperty = typeof ASSERTION_PROPERTIES[number];
export type AssertionDirection = 'inbound' | 'outbound';
export interface DeploymentAssertion {
  readonly id: string;
  readonly trust: AssertionTrust;
  readonly property: AssertionProperty;
  readonly direction: AssertionDirection;
  readonly surfaceIds: readonly NodeId[];
  readonly environmentDigest: Digest;
  readonly deploymentDigest: Digest;
  readonly controlDigest: Digest;
  readonly evidence: readonly Digest[];
  readonly lastVerifiedAt: string | null;
  readonly expiresAt: string | null;
}
export function checkedAssertions(given: unknown): readonly DeploymentAssertion[] {
  const all = snapshot(given);
  list(all, 64, (a): a is DeploymentAssertion => {
    fields(a, ['id', 'trust', 'property', 'direction', 'surfaceIds', 'environmentDigest', 'deploymentDigest', 'controlDigest', 'evidence', 'lastVerifiedAt', 'expiresAt']);
    list(a.surfaceIds, 256, validNode); list(a.evidence, 64, validDigest);
    if (a.surfaceIds.length === 0 || !unique(a.surfaceIds) || !unique(a.evidence)) return false;
    if (!validId(a.id) || !['asserted', 'imported-config', 'runtime-observed'].includes(a.trust) || !ASSERTION_PROPERTIES.includes(a.property)
      || !['inbound', 'outbound'].includes(a.direction) || ![a.environmentDigest, a.deploymentDigest, a.controlDigest].every(validDigest)
      || (a.lastVerifiedAt !== null && !timestamp(a.lastVerifiedAt)) || (a.expiresAt !== null && !timestamp(a.expiresAt))) return false;
    if (a.trust === 'runtime-observed' && (a.lastVerifiedAt === null || a.expiresAt === null || a.evidence.length === 0)) return false;
    if (a.lastVerifiedAt !== null && a.expiresAt !== null && compareTimestamps(a.expiresAt, a.lastVerifiedAt) <= 0) return false;
    return true;
  });
  if (!unique(all.map(a => a.id))) fail('sentinel.decision.invalidInput', 'assertion identities are unique');
  return snapshot(all);
}
