// The words of a change's affected set and of the release readiness brief (round 2026-10-10, proposal 6):
// `farsight affected` (a commit range or a pull request → farsight-affected v1, the PR comment and check)
// and `farsight readiness` / `#/readiness/<storyline>` (one row per step, ship or hold with the reason).
// Spread into STRINGS in strings.ts. Same rules as the rest of the catalog: both registers, a define on
// every word, defines in plain words.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const AFFECTED_STRINGS: Record<string, StringEntry> = {
  // ── the counts of a change (core affected.ts affectedRange) ──
  'count.unit.affectedCommits': same('{n} commits', 'The commits the change holds: those between the two commits named, or the pull request’s own.'),
  'count.unit.affectedCommitsOne': one('1 commit', 'count.unit.affectedCommits'),
  'count.unit.affectedFiles': same('{n} files changed', 'The files the change touches from where it starts to where it ends, each once however many commits touched it.'),
  'count.unit.affectedFilesOne': one('1 file changed', 'count.unit.affectedFiles'),
  'count.unit.affectedChanged': same('{n} parts changed', 'The functions, pages, calls, records and checks whose definition a changed line starts in or sits under. A floor: the graph knows where a part starts, not where it ends.'),
  'count.unit.affectedChangedOne': one('1 part changed', 'count.unit.affectedChanged'),
  'count.unit.affectedGates': same('{n} gates and rules on the changed path', 'The checks met by an action that runs changed code, and any check that changed itself, each once.'),
  'count.unit.affectedGatesOne': one('1 gate or rule on the changed path', 'count.unit.affectedGates'),
  'count.unit.affectedWrites': same('{n} record writes on the changed path', 'A record and the part that writes it, on an action that runs changed code — one row per record and writer.'),
  'count.unit.affectedWritesOne': one('1 record write on the changed path', 'count.unit.affectedWrites'),
  'count.unit.affectedContracts': same('{n} calls on the changed path', 'The calls to a service made by an action that runs changed code, and any call whose own code changed, each once.'),
  'count.unit.affectedContractsOne': one('1 call on the changed path', 'count.unit.affectedContracts'),
  'count.unit.affectedCases': same('{n} test cases to run', 'Every case that reaches a changed part, or what uses one, counted once however many changed parts it reaches. Its own last run is beside it.'),
  'count.unit.affectedCasesOne': one('1 test case to run', 'count.unit.affectedCases'),
  'count.part.fileAdded': same('{n} added', 'Files the change creates.'),
  'count.part.fileModified': same('{n} changed', 'Files the change edits or renames.'),
  'count.part.fileDeleted': same('{n} deleted', 'Files the change removes.'),
  'count.part.gateChanged': same('{n} changed themselves', 'Their own code is among the changed lines.'),
  'count.part.gateOnPath': same('{n} met on the way', 'Their own code did not change; an action that runs changed code meets them.'),

  // ── the release readiness brief (core readiness.ts) ──
  'count.unit.readinessRows': same('{n} steps', 'The journeys the storyline chains, each a step, and the branches that leave it — one row of the brief each.'),
  'count.unit.readinessRowsOne': one('1 step', 'count.unit.readinessRows'),
  'count.unit.readinessShip': same('{n} ship', 'Rows with no reason to hold: every screen built, and no case in scope failed or was skipped on its own last run.'),
  'count.unit.readinessShipOne': one('1 ships', 'count.unit.readinessShip'),
  'count.unit.readinessHold': same('{n} hold', 'Rows with a reason to hold: a screen not built, or a case in scope that failed or was skipped on its own last run.'),
  'count.unit.readinessHoldOne': one('1 holds', 'count.unit.readinessHold'),
  'count.unit.readinessSkipped': same('{n} skipped cases', 'Test cases over the storyline whose own last run skipped them, each once however many steps they reach.'),
  'count.unit.readinessSkippedOne': one('1 skipped case', 'count.unit.readinessSkipped'),
  'count.unit.readinessUnreached': same('{n} gates no test is known to reach', 'Gates and rules on the storyline’s screens that no case reaches, neither the gate itself nor a call it guards — each once.'),
  'count.unit.readinessUnreachedOne': one('1 gate no test is known to reach', 'count.unit.readinessUnreached'),
  'count.unit.readinessRules': same('{n} gates and rules', 'The distinct gates and rules the storyline’s screens meet, each once.'),
  'count.unit.readinessRulesOne': one('1 gate or rule', 'count.unit.readinessRules'),
  'count.part.holdNotBuilt': same('{n} not built', 'Rows held first because a screen they name is designed and not yet built.'),
  'count.part.holdFailed': same('{n} with a failed case', 'Rows held first because a case in scope failed on its own last run.'),
  'count.part.holdSkipped': same('{n} with a skipped case', 'Rows held first because a case in scope was skipped on its own last run.'),
  'readiness.hold.notBuilt': same('not built', 'A screen this step names is designed and not yet built: nothing can run it.'),
  'readiness.hold.failed': same('a case failed', 'A test case in this step’s scope failed on its own last run.'),
  'readiness.hold.skipped': same('a case was skipped', 'A test case in this step’s scope was skipped on its own last run: what it checks was not checked.'),
};
