import type { StringEntry } from './strings.js';

// Sentinel's deterministic planner (PR 06): why a check is not planned, why a plan is refused, and the words for a
// check's planning state. Both registers carry the same words until the PR 09 vocabulary freeze, as in
// strings-sentinel-cli.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_PLAN_STRINGS: Record<string, StringEntry> = {
  'sentinel.plan.capabilityUnavailable': same('this profile cannot establish a capability the rule needs', 'A rule names what must be established before it can be checked. This profile has no stage that establishes one of them, so the check is kept as unsupported rather than run with something weaker.'),
  'sentinel.plan.adapterNotLocked': same('the rule\'s scanner is not pinned in the rule lock', 'Only scanners pinned by digest in the rule lock, or built into Sentinel, may run a rule. This one is neither, so the check is kept as unsupported.'),
  'sentinel.plan.parseRequired': same('the rule needs parser evidence this file does not have', 'The rule reads parsed structure, and this file did not parse or was not selected by the parser, so the check cannot run on it.'),
  'sentinel.plan.frameworkUnresolved': same('the framework this rule applies to is unresolved for this source', 'The rule applies only where its framework is in use. That framework\'s version could not be resolved, so whether the rule applies stays unknown rather than being assumed either way.'),
  'sentinel.plan.frameworkNotDetected': same('the framework this rule applies to was not detected in this source', 'The rule applies only where its framework is in use. The snapshot names no version of it for this source, which does not show it is absent, so whether the rule applies stays unknown and the check is kept.'),
  'sentinel.plan.unknownDescendants': same('a folder holds files capture did not list', 'Capture recorded this folder without listing its contents, so how many files the rule would apply to there is unknown.'),
  'sentinel.plan.ruleNotLocked': same('the policy selects a rule the rule lock does not contain', 'A rule can be planned only from a pinned rule lock. This rule is selected by the policy but is not in the lock, so none of its checks can be planned.'),
  'sentinel.plan.invalidInput': same('the planner refused malformed input: {detail}', 'A plan input did not have the form the planner requires, so no plan was written.'),
  'sentinel.plan.cycle': same('the plan\'s work depends on itself: {detail}', 'Work in a plan must form a graph without cycles, so every unit can finish. A cycle was found and the plan was refused.'),
  'sentinel.plan.unknownDependency': same('a work unit depends on work the plan does not know: {detail}', 'Every dependency must name work in the plan or work an earlier plan already published.'),
  'sentinel.plan.tooManyChecks': same('the plan would hold more checks than allowed: {detail}', 'A plan revision has an upper bound on checks, so planning cannot use unbounded memory. Narrow the scope or the rules.'),
  'sentinel.plan.tooMuchWork': same('the plan would hold more work units than allowed: {detail}', 'A plan revision has an upper bound on work units. Narrow the scope or the rules.'),
  'sentinel.plan.pinMismatch': same('a plan input is not the one the plan is pinned to: {detail}', 'A plan revision follows the snapshot, analysis, rule lock and policy it was given. Input that names something else is refused rather than mixed in.'),
  'sentinel.plan.statePlanned': same('planned', 'The check is assigned to a work unit that will run it.'),
  'sentinel.plan.stateUnsupported': same('unsupported', 'This profile cannot run the check. It stays in the plan with its reason and never counts as covered.'),
  'sentinel.plan.stateApplicabilityUnknown': same('applicability unknown', 'Whether the rule applies here could not be decided, so the check is neither run nor dropped.'),
  'sentinel.plan.stateScopeUnavailable': same('scope unavailable', 'The file or surface exists but cannot be checked as captured or parsed.'),
  'sentinel.plan.stateScopeUnknown': same('scope unknown', 'Capture did not list the contents of this folder, so the files the rule would apply to are unknown.'),
};

export function sentinelPlanWord(key: string, values: Record<string, string | number> = {}): string {
  const entry = SENTINEL_PLAN_STRINGS[key];
  if (!entry) throw new Error(key);
  let text = entry.professional;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
