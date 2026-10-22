// Rule packs and the rule lock (PR 06, ADR 23). Staging and validation read data only; promotion needs the owner's
// spent receipt and writes a new immutable lock revision.
export { readPackDirectory, validatePack, isValidatedPack, inventoryDigest, ruleDefinitionDigest, PACK_MANIFEST, PACK_LIMITS, MAX_PACK_FILES, MAX_PACK_FILE_BYTES, MAX_PACK_BYTES } from './pack.js';
export type { ValidatedPack, PackLimits } from './pack.js';
export { emptyLock, lockDigest, candidateDigest, promotionIntent, verifyPinnedLock, promote } from './lock.js';
export type { PromotionCandidate } from './lock.js';
export { resolveLockedRules } from './resolve.js';
export type { ResolvedRule } from './resolve.js';
