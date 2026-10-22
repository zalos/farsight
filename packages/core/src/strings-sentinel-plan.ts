import type { StringEntry } from './strings.js';

// Sentinel's deterministic planner (PR 06): why a check is not planned, why a plan is refused, and the words for a
// check's planning state. Both registers carry the same words until the PR 09 vocabulary freeze, as in
// strings-sentinel-cli.ts.
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });

export const SENTINEL_PLAN_STRINGS: Record<string, StringEntry> = {
  'sentinel.plan.capabilityUnavailable': same('no registered adapter establishes a capability the rule needs', 'A rule names what must be established before it can be checked. No adapter in the trusted registry is recorded as establishing one of them, so the check is kept as unsupported rather than run with something weaker.'),
  'sentinel.plan.capabilityNotPermitted': same('this profile does not permit relying on a capability the rule needs', 'The capability is established by a registered adapter, but the profile does not permit checks to rely on it, so the check is kept as unsupported.'),
  'sentinel.plan.adapterNotRegistered': same('the rule\'s adapter is not in the trusted adapter registry', 'Only adapters Sentinel\'s own code registered, by digest, may run a rule. This one is not registered, so the check is kept as unsupported.'),
  'sentinel.plan.surfacesUndiscovered': same('this file may hold surfaces the parser could not discover', 'Routes and pages are found only in files that parsed. This file of the rule\'s languages did not parse, so any surface in it is unknown and stays a gap in required coverage.'),
  'sentinel.plan.repositoryTooLarge': same('the repository holds more captured files than one whole-repository check may read', 'A whole-repository check reads the complete captured file set or nothing. This source has more files than the bound, so the check is kept as unavailable rather than run over part of it.'),
  'sentinel.plan.operationUnbound': same('no registered operation runs this bootstrap stage yet', 'Capture, parse and inventory run only through operations Sentinel registered. None is bound for this stage, so its work stays blocked and is never run by a generic worker.'),
  'sentinel.plan.toolMismatch': same('the rule lock approves another version or build of this scanner', 'An external scanner runs only when the rule lock approved exactly the registered tool: the same version and the same image digest. The lock\'s entry names something else, so the check is kept as unsupported.'),
  'sentinel.plan.adapterNotLocked': same('the rule\'s scanner is not pinned in the rule lock', 'Only scanners pinned by digest in the rule lock, or built into Sentinel, may run a rule. This one is neither, so the check is kept as unsupported.'),
  'sentinel.plan.parseRequired': same('the rule needs parser evidence this file does not have', 'The rule reads parsed structure, and this file did not parse or was not selected by the parser, so the check cannot run on it.'),
  'sentinel.plan.frameworkUnresolved': same('the framework this rule applies to is unresolved for this source', 'The rule applies only where its framework is in use. That framework\'s version could not be resolved, so whether the rule applies stays unknown rather than being assumed either way.'),
  'sentinel.plan.frameworkNotDetected': same('the framework this rule applies to was not detected in this source', 'The rule applies only where its framework is in use. The snapshot names no version of it for this source, which does not show it is absent, so whether the rule applies stays unknown and the check is kept.'),
  'sentinel.plan.inputNotCaptured': same('the file this check reads is not a captured file of the snapshot', 'A check reads exactly the captured bytes the plan pins. This scope names a file the snapshot did not capture, so the check cannot be planned on it.'),
  'sentinel.plan.unknownDescendants': same('a folder holds files capture did not list', 'Capture recorded this folder without listing its contents, so how many files the rule would apply to there is unknown.'),
  'sentinel.plan.ruleNotLocked': same('the policy selects a rule the rule lock does not contain', 'A rule can be planned only from a pinned rule lock. This rule is selected by the policy but is not in the lock, so none of its checks can be planned.'),
  'sentinel.plan.coverageMissing': same('no coverage record shows this check ran', 'Required coverage counts only a coverage record for this run, this check and the work that was assigned it. Work finishing is not such a record.'),
  'sentinel.plan.coverageNotComplete': same('the check ran but did not cover its whole scope', 'The check\'s coverage record is partial, unsupported, not run or an error, so it does not complete required coverage.'),
  'sentinel.plan.coverageWrongUnit': same('the coverage record names other work than the plan assigned', 'A record counts only for the exact work revision the plan assigned the check to.'),
  'sentinel.plan.coverageImported': same('imported coverage does not complete a required check', 'Evidence imported from another tool or report is kept, but a required check is complete only when it ran in this run or reused work the plan names.'),
  'sentinel.plan.coverageReuseUnproven': same('reused coverage does not complete a required check yet', 'A reused result counts only with a recorded derivation of the exact earlier check, scope, rule, inputs and environment it came from. No such derivation is recorded yet, so the check stays incomplete rather than borrowing coverage.'),
  'sentinel.plan.coverageTooCoarse': same('the coverage record is coarser than the check', 'A check of one file, surface, manifest or CI file under one rule is completed only by a record for that file and rule. A record over many files or rules does not show that this one was covered.'),
  'sentinel.plan.coverageConflict': same('coverage records for this check disagree', 'More than one counting record names this check with different statuses, so none is trusted.'),
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
