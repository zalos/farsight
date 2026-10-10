/**
 * What a gate protects, and who it matters to (gates lane, 2026-10-10).
 *
 * A journey on the reference app listed 24 gates and rules; a business reader wants the ones about
 * who may act and what state the records must be in, and folds the rest. `gateClass()` reads the
 * class off what the parser and the team already said — a precondition's own class, the `@guard`
 * label, the tags — never off a guess about the code; `gateTier()` maps the class to a tier, which
 * `farsight.config.json → gateTiers` or `@guard[tier]` may override (recorded in `meta.tierFrom`).
 *
 * No imports beyond types and the config-check rule, so the journey walk (query.ts) reads it
 * without a cycle.
 */
import type { GraphNode, GateClass, GateTier } from './graph.js';
import { isConfigCheck } from './config-check.js';

export type { GateClass, GateTier } from './graph.js';

/** The tag the parser writes on a `@guard` that moves a record's status: the action itself. */
export const ACTION_GATE_TAG = 'action-gate';
/** The tag on a rule the parser built out of a refusing comparison (parsers/src/preconditions.ts). */
export const PRECONDITION_TAG = 'precondition';

/** The classes in the order a reader meets them: who, the record, then policy, then the technical checks. */
export const GATE_CLASS_ORDER: readonly GateClass[] = [
  'identity', 'authorisation', 'record-state', 'completeness', 'integrity', 'data-protection', 'input', 'platform', 'configuration', 'action-gate',
];
export const GATE_TIERS: readonly GateTier[] = ['business', 'policy', 'technical'];

/** The tier a class gives when nobody overrode it. */
export const TIER_OF_CLASS: Record<GateClass, GateTier> = {
  identity: 'business', authorisation: 'business', 'record-state': 'business', completeness: 'business',
  integrity: 'policy', 'data-protection': 'policy',
  input: 'technical', platform: 'technical', configuration: 'technical',
  // an action marked as a gate is the action: never folded, never counted as a gate
  'action-gate': 'business',
};

// Read off the words the team wrote (the `@guard` label after the colon) and the declaring name — first match wins.
const CLASS_WORDS: [GateClass, RegExp][] = [
  ['data-protection', /\bbank|\biban\b|account number|\bpii\b|gdpr|personal data|privacy|redact|forbidden.?account|card number/i],
  ['platform', /csrf|same.?origin|rate.?limit|throttl|multipart|upload (size|limit)|body size|path.?id|id shape|\bcors\b|content.?type|return.?to|redirect target|problem/i],
  ['integrity', /four.?eyes|duplicate|idempot|dedup|second (person|approver|pair)|agrees|checksum|signature|tamper/i],
  ['completeness', /readiness|complete|required (field|doc)|missing|attachment|requirement/i],
  ['record-state', /state machine|transition|lifecycle|\bstatus\b|\bstate\b/i],
  ['authorisation', /\brole|\bscope|permission|\bowner|ownership|\badmin|tenant|\baccess\b|\bmay\b|allowed|approver|entitle/i],
  ['identity', /session|signed.?in|sign.?in|log.?in|authenticat|\bauth\b|token|jwt|principal|\buser\b|magic.?link|\botp\b/i],
];

/** The class a gate is: a precondition's own, an action marked as a gate, a config check, a schema's input shape, else read off its words. */
export function gateClass(node: Pick<GraphNode, 'kind' | 'name' | 'tags' | 'precondition' | 'snippet' | 'loc' | 'gateTier'>): GateClass {
  if (node.precondition) return node.precondition.class;
  const tags = node.tags ?? [];
  if (tags.includes(ACTION_GATE_TAG)) return 'action-gate';
  if (tags.includes('env-schema') || isConfigCheck(node as GraphNode)) return 'configuration';
  if (node.kind === 'rule') {
    // a schema is the data's shape: input, unless its name says it is about policy
    const hit = CLASS_WORDS.find(([c, re]) => (c === 'data-protection' || c === 'integrity') && re.test(node.name));
    return hit ? hit[0] : 'input';
  }
  const i = node.name.indexOf(': ');
  const phrase = i > 0 ? node.name.slice(i + 2) : '';
  const ident = i > 0 ? node.name.slice(0, i) : node.name;
  // the words a person wrote first, then the declaring name split into words
  for (const text of [phrase, ident.replace(/([a-z0-9])([A-Z])/g, '$1 $2')]) {
    if (!text) continue;
    const hit = CLASS_WORDS.find(([, re]) => re.test(text));
    if (hit) return hit[0];
  }
  // a guard nobody's words place: somebody marked it a gate on who may go on
  return 'authorisation';
}

/** Where the tier came from: its class, `farsight.config.json → gateTiers`, or `@guard[tier]`. */
export type TierFrom = 'class' | 'config' | 'annotation';

/** The tier a gate is in, and why: an override on the node (config or annotation) wins over its class. */
export function gateTierOf(node: Parameters<typeof gateClass>[0]): { tier: GateTier; class: GateClass; tierFrom: TierFrom } {
  const cls = gateClass(node);
  if (node.gateTier) return { tier: node.gateTier.tier, class: cls, tierFrom: node.gateTier.from };
  if (node.precondition?.tier) return { tier: node.precondition.tier, class: cls, tierFrom: 'class' };
  return { tier: TIER_OF_CLASS[cls], class: cls, tierFrom: 'class' };
}
export function gateTier(node: Parameters<typeof gateClass>[0]): GateTier {
  return gateTierOf(node).tier;
}
/** True for a `@guard` that moves a record's status: drawn as its action, never listed as a gate on itself. */
export function isActionGate(node: Pick<GraphNode, 'tags'> | undefined): boolean {
  return !!node?.tags?.includes(ACTION_GATE_TAG);
}
