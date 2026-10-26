// Resolving the rules a plan may use: from a lock the plan pinned, plus validated packs the caller already holds,
// to each rule's original definition. Pure: nothing is read, downloaded or re-acquired. A pack is used only when it
// is validatePack's own object and its complete lock entry (inventory, rights, rules and digests) is exactly the one
// the lock records; each rule's definition digest is recomputed from that pack's manifest and file digests and must
// equal the lock's. A missing, stale, newer, forged or mismatched pack is refused, never substituted.
import type { LockedPack, PackFile, RuleDefinition, RuleLockEnvelope } from '../contracts/index.js';
import { canonicalDigest } from '../policy/digest.js';
import { policyFail } from '../policy/errors.js';
import { deepFreeze } from '../policy/immutable.js';
import { verifyPinnedLock } from './lock.js';
import { isValidatedPack, ruleDefinitionDigest, type ValidatedPack } from './pack.js';

/** One locked rule, resolved: its original definition and the pins that tie it to the lock. */
export interface ResolvedRule {
  readonly familyId: string;
  readonly revision: number;
  readonly definition: RuleDefinition;
  readonly definitionDigest: string;
  readonly packId: string;
  readonly packDigest: string;
  /** The digest of the lock it was resolved from (the plan's pin). */
  readonly lockDigest: string;
}

const entryOf = (p: LockedPack) => {
  const { promotion: _p, ...entry } = p;
  return entry;
};

/**
 * Resolves `familyIds` (every locked rule when omitted) from the lock pinned as `pin`. `lock` may be the parsed JSON
 * of a stored lock; it is validated and must have exactly the pinned digest. Results are deep-frozen, sorted by
 * family id.
 */
export function resolveLockedRules(
  lock: unknown,
  pin: string,
  packs: readonly ValidatedPack[],
  familyIds?: readonly string[],
): readonly ResolvedRule[] {
  const verified: RuleLockEnvelope = verifyPinnedLock(lock, pin);
  const byFamily = new Map<string, LockedPack>();
  for (const p of verified.packs) for (const r of p.rules) byFamily.set(r.familyId, p);
  const wanted = [...new Set(familyIds ?? [...byFamily.keys()])].sort();
  const missing = wanted.filter((f) => !byFamily.has(f));
  if (missing.length)
    policyFail(
      'sentinel.rules.ruleNotLocked',
      `${missing.length} requested rule(s) are not in the pinned lock, e.g. ${missing[0]}`,
    );

  const matched = new Map<string, ValidatedPack>();
  const packFor = (locked: LockedPack): ValidatedPack => {
    const hit = matched.get(locked.packId);
    if (hit) return hit;
    const candidates = packs.filter(
      (p) => typeof p === 'object' && p !== null && (p as ValidatedPack).entry?.packId === locked.packId,
    );
    if (!candidates.length)
      policyFail('sentinel.rules.packMissing', `pack ${locked.packId} is not among the validated packs given`);
    const want = canonicalDigest(entryOf(locked));
    const pack = candidates.find((p) => isValidatedPack(p) && canonicalDigest(p.entry) === want);
    if (!pack)
      return policyFail(
        'sentinel.rules.packMismatch',
        `no validated pack given matches the locked entry for ${locked.packId}`,
      );
    matched.set(locked.packId, pack);
    return pack;
  };

  const out: ResolvedRule[] = wanted.map((familyId) => {
    const locked = byFamily.get(familyId)!;
    const pack = packFor(locked);
    const pinned = locked.rules.find((r) => r.familyId === familyId)!;
    const definition = pack.manifest.rules.find((r) => r.familyId === familyId);
    const files = new Map<string, PackFile>(pack.files.map((f) => [f.path, f]));
    const named = definition
      ? [definition.implementation.rulePath, ...definition.fixtures.positive, ...definition.fixtures.negative].map(
          (p) => files.get(p),
        )
      : [];
    if (
      !definition ||
      named.some((f) => !f) ||
      definition.revision !== pinned.revision ||
      ruleDefinitionDigest(definition, named as PackFile[]) !== pinned.definitionDigest
    ) {
      policyFail('sentinel.rules.packMismatch', `${familyId} does not match its locked definition digest`);
    }
    return {
      familyId,
      revision: pinned.revision,
      definition: structuredClone(definition!),
      definitionDigest: pinned.definitionDigest,
      packId: locked.packId,
      packDigest: locked.packDigest,
      lockDigest: pin,
    };
  });
  return deepFreeze(out);
}
