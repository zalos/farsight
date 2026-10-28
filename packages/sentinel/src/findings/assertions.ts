// Deployment claims are deliberately separate from graph control facts. Claiming runtime-observed in JSON is
// still only a claim: verification requires the bounded importer's private provenance, added at the import seam.
import type { Digest, NodeId } from '../contracts/common.js';
import type { AssertionTrust } from '../contracts/disposition.js';
import { snapshot } from '../policy/immutable.js';
import { compareTimestamps } from '../validate.js';
import { fail, fields, list, timestamp, unique, validDigest, validId, validNode } from './decision-data.js';

/** The control properties a deployment assertion may claim. */
export const ASSERTION_PROPERTIES = [
  'authentication',
  'authorization',
  'csrf',
  'input-validation',
  'rate-limit',
  'security-headers',
  'cors',
  'cookie-integrity',
  'cookie-confidentiality',
  'cookie-secure',
  'cookie-http-only',
  'cookie-same-site',
] as const;
/** One of `ASSERTION_PROPERTIES`. */
export type AssertionProperty = (typeof ASSERTION_PROPERTIES)[number];
/** The direction of traffic an assertion covers at its surfaces. */
export type AssertionDirection = 'inbound' | 'outbound';
/**
 * A claim about a deployed control on some surfaces, bound to the environment, deployment and control digests it was
 * made against. It is a claim even when `trust` says `runtime-observed`: only the bounded importer's provenance can
 * verify it.
 */
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
/**
 * Copies and checks at most 64 assertions: exact fields, known trust, property and direction, at least one surface and
 * unique surfaces and evidence, digest-shaped bindings, an expiry after the last verification, and for
 * `runtime-observed` a verification time, an expiry and evidence. Anything else, or a repeated assertion id, is
 * `sentinel.decision.invalidInput`. Returns a frozen copy.
 */
export function checkedAssertions(given: unknown): readonly DeploymentAssertion[] {
  const all = snapshot(given);
  list(all, 64, (a): a is DeploymentAssertion => {
    fields(a, [
      'id',
      'trust',
      'property',
      'direction',
      'surfaceIds',
      'environmentDigest',
      'deploymentDigest',
      'controlDigest',
      'evidence',
      'lastVerifiedAt',
      'expiresAt',
    ]);
    list(a.surfaceIds, 256, validNode);
    list(a.evidence, 64, validDigest);
    if (a.surfaceIds.length === 0 || !unique(a.surfaceIds) || !unique(a.evidence)) return false;
    if (
      !validId(a.id) ||
      !['asserted', 'imported-config', 'runtime-observed'].includes(a.trust) ||
      !ASSERTION_PROPERTIES.includes(a.property) ||
      !['inbound', 'outbound'].includes(a.direction) ||
      ![a.environmentDigest, a.deploymentDigest, a.controlDigest].every(validDigest) ||
      (a.lastVerifiedAt !== null && !timestamp(a.lastVerifiedAt)) ||
      (a.expiresAt !== null && !timestamp(a.expiresAt))
    )
      return false;
    if (
      a.trust === 'runtime-observed' &&
      (a.lastVerifiedAt === null || a.expiresAt === null || a.evidence.length === 0)
    )
      return false;
    if (a.lastVerifiedAt !== null && a.expiresAt !== null && compareTimestamps(a.expiresAt, a.lastVerifiedAt) <= 0)
      return false;
    return true;
  });
  if (!unique(all.map((a) => a.id))) fail('sentinel.decision.invalidInput', 'assertion identities are unique');
  return snapshot(all);
}
