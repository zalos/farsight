import type { StringEntry } from './strings.js';

// The words for the counts a Sentinel report carries (PR 02 draft contracts; the report fold arrives in PR 19).
// Each count is a Counted with one of the sentinel.scope.* scopes in COUNT_SCOPES (docs/COUNTS.md § Sentinel).
const same = (text: string, define: string): StringEntry => ({ hud: text, professional: text, define });
const one = (text: string, pluralKey: string): StringEntry => ({ hud: text, professional: text, singularOf: pluralKey });

export const SENTINEL_REPORT_STRINGS: Record<string, StringEntry> = {
  'sentinel.scope.report': same('in this report', 'What the number beside it counts over: one saved report of one scan, as of the moment the report was made.'),
  'sentinel.scope.finding': same('for this finding', 'What the number beside it counts over: the screens, journeys or people one finding is placed on, each counted once.'),
  'sentinel.scope.inventory': same('in the captured files', 'What the number beside it counts over: the files and folders the scan captured and listed, before any check ran.'),

  'sentinel.count.findings': same('{n} findings', 'Issues the report lists after grouping what the checks found. Several checks that saw the same weakness count as one finding.'),
  'sentinel.count.findingsOne': one('1 finding', 'sentinel.count.findings'),
  'sentinel.count.issues': same('{n} issues', 'Problems the report asks someone to look at, each counted once however many checks noticed it.'),
  'sentinel.count.issuesOne': one('1 issue', 'sentinel.count.issues'),
  'sentinel.count.observations': same('{n} observations', 'What the checks reported before grouping, each claim once. One finding can rest on several observations.'),
  'sentinel.count.observationsOne': one('1 observation', 'sentinel.count.observations'),
  'sentinel.count.gaps': same('{n} gaps in the checks', 'Checks that did not cover everything they were meant to, because they were unsupported, did not run, failed or covered only part of their scope.'),
  'sentinel.count.gapsOne': one('1 gap in the checks', 'sentinel.count.gaps'),
  'sentinel.count.plannedChecks': same('{n} planned checks', 'Every check the scan planned, whether it ran, was unsupported or was not needed. Each check is one rule over one part of the code.'),
  'sentinel.count.plannedChecksOne': one('1 planned check', 'sentinel.count.plannedChecks'),
  'sentinel.count.seenByNoStage': same('{n} of {m} captured files seen by no check', 'Captured files that no finished check looked at, out of every captured file. It is printed even when it is zero, so an empty result never hides unread files.'),
  'sentinel.count.unknownBoundaries': same('{n} folders never listed', 'Folders the scan skipped as a whole, such as excluded or unreadable ones. Their contents are unknown and are never counted as zero files.'),
  'sentinel.count.unknownBoundariesOne': one('1 folder never listed', 'sentinel.count.unknownBoundaries'),
  'sentinel.count.screens': same('{n} screens', 'Screens of the application a finding is placed on, from the saved application context, each counted once across journeys.'),
  'sentinel.count.screensOne': one('1 screen', 'sentinel.count.screens'),
  'sentinel.count.part.critical': same('{n} critical', 'Findings the checks rated most severe.'),
  'sentinel.count.part.high': same('{n} high', 'Findings the checks rated high severity.'),
  'sentinel.count.part.medium': same('{n} medium', 'Findings the checks rated medium severity.'),
  'sentinel.count.part.low': same('{n} low', 'Findings the checks rated low severity.'),
  'sentinel.count.part.info': same('{n} for information', 'Findings recorded for information, with no severity rating.'),
};
