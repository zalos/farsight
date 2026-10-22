// The rule lock: an immutable record of exactly which pack revisions, tools and databases may be used. Promotion is
// an owner action confirmed by a receipt for this candidate against this lock; it returns a new lock revision that
// names its predecessor's digest and never changes the predecessor. A plan pins a lock digest, so promoting a pack
// update leaves every existing plan exactly as it was.
import type { ActionIntent, LockedDatabase, LockedPack, LockedTool, RuleLockEnvelope } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { canonicalDigest } from '../policy/digest.js';
import { policyFail } from '../policy/errors.js';
import { intentDigest, receiptAuthority, type ConsumedReceipt } from '../policy/receipts.js';
import { isValidatedPack, type ValidatedPack } from './pack.js';
import { deepFreeze } from '../policy/immutable.js';

export type PromotionCandidate =
  | { kind: 'pack'; pack: ValidatedPack }
  | { kind: 'tool'; tool: Omit<LockedTool, 'promotion'> }
  | { kind: 'database'; database: Omit<LockedDatabase, 'promotion'> };

const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');

/** The digest a plan pins. */
export const lockDigest = (lock: RuleLockEnvelope): string => canonicalDigest(lock);

/** The first lock: nothing promoted yet. */
export function emptyLock(now: Date): RuleLockEnvelope {
  return deepFreeze({ schema: 'sentinel-rulelock/draft-1', revision: 1, previous: null, packs: [], tools: [], databases: [], createdAt: stamp(now) });
}

/**
 * Exactly what promotion would write, without its promotion record: the validated pack's lock entry (inventory,
 * rights, rules and their digests), or the tool or database entry. Taken as a private deep copy, so nothing the
 * caller does afterwards changes what is digested or written.
 */
function candidateEntry(c: PromotionCandidate): object {
  if (c.kind === 'pack') {
    if (!isValidatedPack(c.pack)) policyFail('sentinel.rules.promotionUnauthorized', 'a pack is promoted only as validatePack returned it');
    return structuredClone(c.pack.entry);
  }
  return structuredClone(c.kind === 'tool' ? c.tool : c.database);
}

const entryDigest = (kind: PromotionCandidate['kind'], entry: object) => canonicalDigest({ kind: `sentinel-lock-candidate/${kind}/1`, entry });

/** The candidate's digest: the canonical digest of the complete entry promotion would write. */
export function candidateDigest(c: PromotionCandidate): string {
  return entryDigest(c.kind, candidateEntry(c));
}

/**
 * The exact intent the owner confirms: promote this candidate into this lock. Packs are `rule.promote`; a tool or
 * database digest is `tool.acquire`. Recording a digest here authorizes no download and no execution by itself.
 */
export function promotionIntent(lock: RuleLockEnvelope, c: PromotionCandidate): ActionIntent {
  return intentFor(lock, c.kind, candidateDigest(c));
}

function intentFor(lock: RuleLockEnvelope, kind: PromotionCandidate['kind'], input: string): ActionIntent {
  return {
    action: kind === 'pack' ? 'rule.promote' : 'tool.acquire',
    input,
    effects: ['local-artifacts'],
    budget: { maxTokens: null, maxCost: null, currency: null },
    scope: { profile: null, provider: null, targets: [lockDigest(lock)] },
  };
}

/** Verifies that a loaded lock is the one a plan pinned; any other lock is refused, never substituted. */
export function verifyPinnedLock(value: unknown, pinned: string): RuleLockEnvelope {
  const checked = validateEnvelope('rulelock', value);
  if (!checked.ok) return policyFail('sentinel.rules.lockInvalid', `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`);
  if (lockDigest(checked.value) !== pinned) policyFail('sentinel.rules.lockInvalid', 'the lock is not the revision the plan pinned');
  return deepFreeze(checked.value);
}

/**
 * A new lock revision with the candidate promoted. The given lock is unchanged. The entry written is the private copy
 * whose digest the receipt confirmed, so a candidate edited after confirmation is refused, never half-applied.
 */
export function promote(lock: RuleLockEnvelope, c: PromotionCandidate, receipt: ConsumedReceipt, now: Date): RuleLockEnvelope {
  const authority = receiptAuthority(receipt);
  if (!authority) return policyFail('sentinel.rules.promotionUnauthorized', 'promotion needs the owner’s spent receipt');
  const base: RuleLockEnvelope = structuredClone(lock);
  const entry = candidateEntry(c);
  const intent = intentFor(base, c.kind, entryDigest(c.kind, entry));
  if (authority.action !== intent.action || authority.intentDigest !== intentDigest(intent)) {
    policyFail('sentinel.rules.promotionUnauthorized', 'the receipt confirms another candidate or another lock revision');
  }
  const promotion = { receipt: authority.digest, at: stamp(now) };
  const next: RuleLockEnvelope = { ...base, revision: base.revision + 1, previous: lockDigest(base), createdAt: stamp(now) };
  if (c.kind === 'pack') {
    const pack = entry as Omit<LockedPack, 'promotion'>;
    const others = next.packs.filter(p => p.packId !== pack.packId);
    const taken = new Set(others.flatMap(p => p.rules.map(r => r.familyId)));
    const clash = pack.rules.find(r => taken.has(r.familyId));
    if (clash) policyFail('sentinel.rules.familyConflict', `${clash.familyId} is already locked by another pack`);
    next.packs = [...others, { ...pack, promotion }].sort((a, b) => (a.packId < b.packId ? -1 : 1));
  } else if (c.kind === 'tool') {
    const tool = entry as Omit<LockedTool, 'promotion'>;
    next.tools = [...next.tools.filter(t => !(t.adapterId === tool.adapterId && t.platform === tool.platform)), { ...tool, promotion }];
  } else {
    const database = entry as Omit<LockedDatabase, 'promotion'>;
    next.databases = [...next.databases.filter(d => d.databaseId !== database.databaseId), { ...database, promotion }];
  }
  const checked = validateEnvelope('rulelock', next);
  if (!checked.ok) policyFail(c.kind === 'pack' ? 'sentinel.rules.lockInvalid' : 'sentinel.rules.candidateInvalid', `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`);
  return deepFreeze(next);
}
