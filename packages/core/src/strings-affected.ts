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

  // ── the affected set in words: the CLI, the pull-request comment and the check (cli affected.ts) ──
  'affected.title.pr': same('Affected by this pull request', 'What the pull request’s changed lines reach in the application: the journeys that run them, what they meet on the way, and the tests to run.'),
  'affected.title.range': same('Affected by these commits', 'What the changed lines between two commits reach in the application: the journeys that run them, what they meet on the way, and the tests to run.'),
  'affected.head.changed': same('What changed', 'The parts of the code a changed line starts in or sits under.'),
  'affected.head.journeys': same('Journeys touched', 'The journeys whose walk runs a changed part, or something that uses one, each once.'),
  'affected.head.path': same('On the changed path', 'What the actions that run changed code meet: the gates and rules, the records they write, the calls they make.'),
  'affected.head.gates': same('gates', 'The checks a request meets on the changed path.'),
  'affected.head.writes': same('record writes', 'The records written on the changed path, by which part, and the status it moves them to when the record’s lifecycle says.'),
  'affected.head.calls': same('calls', 'The calls to a service on the changed path, with whether a contract declares them.'),
  'affected.head.tests': same('Tests to run', 'Every case that reaches a changed part or what uses it, once each, with its own last run.'),
  'affected.storyline.step': same('step {n} of {m} · {name}', 'Where the journey stands in the storyline: its position in the chain, and the storyline’s name.'),
  'affected.storyline.branch': same('branch of {name}', 'The journey leaves the storyline at this step only when its condition holds.'),
  'affected.hop.self': same('runs the change', 'The journey’s own walk runs a changed part.'),
  'affected.hop.far': same('{n} hops out', 'The journey’s walk meets something that uses a changed part, this many calls away. A path, not a consequence.'),
  'affected.none.journeys': same('no journey runs this change', 'No journey’s walk meets a changed part or what uses it, as far as the graph knows.'),
  'affected.none.path': same('nothing on the changed path', 'No action that runs changed code meets a gate, writes a record or makes a call, as far as the graph knows.'),
  'affected.none.tests': same('no test is known to reach this change', 'No case covers a changed part or what uses it, as far as the graph knows.'),
  'affected.verdict': same('{passed} passed · {skipped} skipped · {failed} failed · last run {date} · {since} commits since', 'Every listed case by its own last run, the newest of those runs, and how many commits the head has after it.'),
  'affected.verdict.noRun': same('no run names these cases', 'None of the listed cases has a run a results report recorded.'),
  'affected.moves': same('status {from} → {to} via {writer}', 'The status move the record’s lifecycle records for this writer.'),
  'affected.movesAny': same('status → {to} via {writer}', 'The status the writer sets; the code does not compare the status it had before.'),
  'affected.writes': same('written by {writer}', 'The part on the changed path that writes this record.'),
  'affected.more': same('+{n} more', 'More rows than are shown here; the JSON document lists them all.'),
  'affected.footnote': same('Selected from the graph at sync {sync}; a test the graph cannot tie to the changed path is not listed. Updated in place on every run.', 'How the list was made and what it leaves out.'),
  'affected.rerun': same('the same answer as JSON', 'The command that prints this answer as the frozen farsight-affected v1 document.'),
  'affected.check.context': same('farsight/affected', 'The name of the check Farsight leaves on the pull request’s head commit.'),
  'affected.check.desc': same('{tests} tests selected · {passed} passed · {skipped} skipped · {failed} failed on the changed path', 'The check’s one line: how many cases reach the change, and their own last runs.'),
  'affected.post.waiting': same('waiting for --confirm: nothing was posted', 'The three verdicts allow the post, and a person must confirm it: run the same command with --confirm.'),
  'affected.post.denied': same('not posted', 'One of the three verdicts said no; the reason is beside it.'),
  'affected.post.done': same('posted: {url}', 'The comment was written (or updated in place) and the check left on the head commit.'),
  'affected.png.none': same('no browser available: the picture was not drawn', 'Drawing the picture needs Playwright’s browser, which this install does not have.'),
  'affected.png.done': same('picture saved: {path}', 'The stamped picture of the affected set was written to this file.'),
};
