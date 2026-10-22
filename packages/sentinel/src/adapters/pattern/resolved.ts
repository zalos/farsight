// From PR 06's resolved rules to the adapter's rules. The planner resolves the locked rules (resolveLockedRules on the
// rules-and-policy branch: a pinned lock plus the exact validated packs) and reads the detector bytes from captured,
// immutable pack objects; this module accepts only rules this adapter can run faithfully, checks each detector's
// bytes against the pack file digest the lock pins, and reports every other rule as unsupported with a reason, so the
// planner keeps an explicit gap instead of a silent drop. Nothing here reads a file or runs anything.
//
// The two input shapes below are structural subsets of PR 06's ResolvedRule and PackFile, so those types are
// assignable to them without this branch importing that one.
import { createHash } from 'node:crypto';
import { PATTERN_ADAPTER } from './adapter.js';
import { patternFail } from './errors.js';
import { patternRuleOf, type PatternLanguage, type PatternRule } from './job.js';

export interface ResolvedRuleInput {
  readonly familyId: string;
  readonly revision: number;
  readonly definitionDigest: string;
  readonly packDigest: string;
  readonly lockDigest: string;
  readonly definition: {
    readonly familyId: string;
    readonly revision: number;
    readonly applicability: { readonly languages: readonly string[]; readonly scopeKind: string; readonly frameworks?: readonly string[] };
    readonly requires: readonly string[];
    readonly implementation: { readonly adapterId: string; readonly rulePath: string };
  };
}

/** A pack file as the validated pack records it: its path and the digest of its bytes. */
export interface PackFileInput { readonly path: string; readonly digest: string }

export const PATTERN_UNSUPPORTED_REASONS = [
  'sentinel.pattern.unsupported.otherAdapter', 'sentinel.pattern.unsupported.scope', 'sentinel.pattern.unsupported.framework',
  'sentinel.pattern.unsupported.capability', 'sentinel.pattern.unsupported.language',
] as const;
export type PatternUnsupportedReason = typeof PATTERN_UNSUPPORTED_REASONS[number];

/** Capabilities this adapter can provide. A rule requiring anything else (framework order, interprocedural flow) is unsupported. */
export const PATTERN_PROVIDES: ReadonlySet<string> = new Set(['source-bytes', 'pattern-match', 'source-span']);
const LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript', 'java']);
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export interface ResolvedPatternRules {
  readonly rules: readonly PatternRule[];
  readonly unsupported: readonly { readonly familyId: string; readonly reasonCode: PatternUnsupportedReason }[];
}

/**
 * `files` is the validated pack's file list (path → digest); `bytesOf(digest)` returns captured bytes. A detector
 * whose bytes do not hash to the pinned digest, or which is not in the pack, is refused outright (`ruleInvalid`):
 * that is a broken pin, not an unsupported rule.
 */
export function patternRulesFromResolved(resolved: readonly ResolvedRuleInput[], files: readonly PackFileInput[], bytesOf: (digest: string) => Uint8Array): ResolvedPatternRules {
  const byPath = new Map(files.map(f => [f.path, f.digest]));
  const rules: PatternRule[] = [];
  const unsupported: { familyId: string; reasonCode: PatternUnsupportedReason }[] = [];
  for (const r of resolved) {
    const d = r.definition;
    if (d.familyId !== r.familyId || d.revision !== r.revision) patternFail('sentinel.pattern.ruleInvalid', `${r.familyId}: the definition is not the resolved rule`);
    const gap = (reasonCode: PatternUnsupportedReason) => { unsupported.push({ familyId: r.familyId, reasonCode }); };
    if (d.implementation.adapterId !== PATTERN_ADAPTER.id) { gap('sentinel.pattern.unsupported.otherAdapter'); continue; }
    if (d.applicability.scopeKind !== 'source-file') { gap('sentinel.pattern.unsupported.scope'); continue; }
    if (d.applicability.frameworks?.length) { gap('sentinel.pattern.unsupported.framework'); continue; }
    if (d.requires.some(c => !PATTERN_PROVIDES.has(c))) { gap('sentinel.pattern.unsupported.capability'); continue; }
    if (!d.applicability.languages.length || d.applicability.languages.some(l => !LANGUAGES.has(l))) { gap('sentinel.pattern.unsupported.language'); continue; }
    const digest = byPath.get(d.implementation.rulePath);
    if (!digest) patternFail('sentinel.pattern.ruleInvalid', `${r.familyId}: its detector is not in the pinned pack`);
    const bytes = bytesOf(digest!);
    if (sha256(bytes) !== digest) patternFail('sentinel.pattern.ruleInvalid', `${r.familyId}: the detector bytes do not match the pinned digest`);
    const rule = patternRuleOf(r.familyId, r.revision, bytes);
    const declared = [...d.applicability.languages].sort().join(',');
    if ([...rule.languages].sort().join(',') !== declared) patternFail('sentinel.pattern.ruleInvalid', `${r.familyId}: the engine rule's languages differ from its definition`);
    rules.push(Object.freeze({
      ...rule, languages: Object.freeze([...d.applicability.languages] as PatternLanguage[]),
      pins: Object.freeze({ definitionDigest: r.definitionDigest, packDigest: r.packDigest, lockDigest: r.lockDigest, detectorDigest: digest! }),
    }));
  }
  return Object.freeze({ rules: Object.freeze(rules), unsupported: Object.freeze(unsupported) });
}
