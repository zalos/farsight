// The rule lock: an immutable record of exactly which pack revisions, tools and databases may be used. Promotion is
// an owner action confirmed by a receipt for this candidate against this lock; it returns a new lock revision that
// names its predecessor's digest and never changes the predecessor. A plan pins a lock digest, so promoting a pack
// update leaves every existing plan exactly as it was.
import type { ActionIntent, LockedDatabase, LockedTool, RuleLockEnvelope } from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { canonicalDigest } from '../policy/digest.js';
import { policyFail } from '../policy/errors.js';
import { intentDigest, isConsumedReceipt, type ConsumedReceipt } from '../policy/receipts.js';
import type { ValidatedPack } from './pack.js';

export type PromotionCandidate =
  | { kind: 'pack'; pack: ValidatedPack }
  | { kind: 'tool'; tool: Omit<LockedTool, 'promotion'> }
  | { kind: 'database'; database: Omit<LockedDatabase, 'promotion'> };

const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The digest a plan pins. */
export const lockDigest = (lock: RuleLockEnvelope): string => canonicalDigest(lock);

/** The first lock: nothing promoted yet. */
export function emptyLock(now: Date): RuleLockEnvelope {
  return deepFreeze({ schema: 'sentinel-rulelock/draft-1', revision: 1, previous: null, packs: [], tools: [], databases: [], createdAt: stamp(now) });
}

/** The candidate's own digest: the pack inventory, or the canonical tool/database entry. */
export function candidateDigest(c: PromotionCandidate): string {
  return c.kind === 'pack' ? c.pack.packDigest : canonicalDigest(c.kind === 'tool' ? c.tool : c.database);
}

/**
 * The exact intent the owner confirms: promote this candidate into this lock. Packs are `rule.promote`; a tool or
 * database digest is `tool.acquire`. Recording a digest here authorizes no download and no execution by itself.
 */
export function promotionIntent(lock: RuleLockEnvelope, c: PromotionCandidate): ActionIntent {
  return {
    action: c.kind === 'pack' ? 'rule.promote' : 'tool.acquire',
    input: candidateDigest(c),
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

/** A new lock revision with the candidate promoted. The given lock is unchanged. */
export function promote(lock: RuleLockEnvelope, c: PromotionCandidate, receipt: ConsumedReceipt, now: Date): RuleLockEnvelope {
  if (!isConsumedReceipt(receipt)) policyFail('sentinel.rules.promotionUnauthorized', 'promotion needs the owner’s spent receipt');
  const intent = promotionIntent(lock, c);
  if (receipt.receipt.action !== intent.action || receipt.receipt.intentDigest !== intentDigest(intent)) {
    policyFail('sentinel.rules.promotionUnauthorized', 'the receipt confirms another candidate or another lock revision');
  }
  const promotion = { receipt: receipt.digest, at: stamp(now) };
  const next: RuleLockEnvelope = structuredClone({ ...lock, revision: lock.revision + 1, previous: lockDigest(lock), createdAt: stamp(now) });
  if (c.kind === 'pack') {
    const { manifest, packDigest, files, rules } = c.pack;
    const others = next.packs.filter(p => p.packId !== manifest.packId);
    const taken = new Set(others.flatMap(p => p.rules.map(r => r.familyId)));
    const clash = rules.find(r => taken.has(r.familyId));
    if (clash) policyFail('sentinel.rules.familyConflict', `${clash.familyId} is already locked by another pack`);
    next.packs = [...others, {
      packId: manifest.packId, version: manifest.version, packDigest, rights: structuredClone(manifest.rights),
      files: structuredClone([...files]), rules: structuredClone([...rules]), promotion,
    }].sort((a, b) => (a.packId < b.packId ? -1 : 1));
  } else if (c.kind === 'tool') {
    next.tools = [...next.tools.filter(t => !(t.adapterId === c.tool.adapterId && t.platform === c.tool.platform)), { ...structuredClone(c.tool), promotion }];
  } else {
    next.databases = [...next.databases.filter(d => d.databaseId !== c.database.databaseId), { ...structuredClone(c.database), promotion }];
  }
  const checked = validateEnvelope('rulelock', next);
  if (!checked.ok) policyFail(c.kind === 'pack' ? 'sentinel.rules.lockInvalid' : 'sentinel.rules.candidateInvalid', `${checked.errors[0]?.path || '/'}: ${checked.errors[0]?.message ?? 'invalid'}`);
  return deepFreeze(next);
}
