// The test chip's words (round 2026-10-10, proposal 4 — every test number carries
// its scope): the short scope words a test number prints on its chip, the
// not-built sentence, and *distinct* with its per-screen table. Spread into
// STRINGS in strings.ts. Same rules as the rest of the catalog: both registers, a
// define on every word, defines in plain words.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const EVIDENCE_STRINGS: Record<string, StringEntry> = {
  // ── a case several projects ran (outsider demo 2026-10-13, F3): passed where it ran, the skip said beside it ──
  'tests.projectSplit': same('passed on {passed} · skipped on {skipped}',
    'The case ran under more than one project (a browser size, a device). It passed where it ran; the projects named after it skipped it, each by its own written condition, quoted in brackets. A skip there is not a skip of the case.'),
  'tests.projectSplitMany': same('{n} of them passed on {passed} · skipped on {skipped}',
    'Cases that ran under more than one project (a browser size, a device): each passed where it ran, and the projects named after it skipped them by their own written conditions, quoted in brackets. They are counted as passed.'),
  'tests.biz.projectSplit': same('passed on {passed}; not run on {skipped} by its own condition',
    'The check ran in more than one setting (a screen size, a device). It passed where it ran; the setting named after it was left out on purpose, for the reason written in brackets.'),
  'tests.biz.projectSplitMany': same('{n} of them passed on {passed}; not run on {skipped} by their own condition',
    'Checks that ran in more than one setting (a screen size, a device): each passed where it ran, and the settings named after it were left out on purpose, for the reasons written in brackets.'),
  'tests.projectSkipped': same('{project} ({reason})',
    'A project that skipped the case, and the reason the case’s own skip condition wrote, quoted as written.'),
  'tests.projectReasons': same('{n} written reasons',
    'The cases this project skipped wrote different reasons; each case lists its own.'),
  'tests.skippedOn': same('skipped on {skipped}',
    'The projects that skipped this case, each with the reason its own skip condition wrote. No project passed it.'),
  'tests.biz.skippedOn': same('not run on {skipped}',
    'The settings this check was left out of, each with the reason written for it. It did not run anywhere.'),
  'readiness.note.projectSkip': same('note: {name} — {split}',
    'The journey’s own case passed on one project and was skipped on another by its own written condition. Said on the row, never a reason to hold: the case passed where it ran.'),
  'state.unit.journeysHeld': same('{n} journeys held in the release brief by their own case',
    'Fully built journeys whose own declared end-to-end case failed, or that no project passed. The release brief holds them, so they are counted apart from the journeys that passed.'),
  'state.unit.journeysHeldOne': { hud: '1 journey held in the release brief by its own case', professional: '1 journey held in the release brief by its own case', singularOf: 'state.unit.journeysHeld' },
  'readiness.held.line': same('held in the release brief: {reason}',
    'The release brief holds this journey: one of its own declared cases failed, or no project passed it. Said beside the test word so a pass is never read without the hold.'),
  'readiness.biz.held.line': same('held back in the release brief: {reason}',
    'The release brief holds this journey back: one of its own checks failed, or did not run anywhere. Said beside the test word so a pass is never read without it.'),
  'count.scope.route': same('on the routes it will call', 'What the number beside it counts over: the routes a screen that is designed and not built will call. The screen has no code a test can reach.'),
  'count.over.journey': same('over this journey', 'The number beside it counts the test cases that reach any part of this journey, each case once however many screens it reaches.'),
  'count.over.screen': same('over this screen', 'The number beside it counts the test cases that reach this one screen: its page, the calls it makes and the checks those calls meet.'),
  'count.over.action': same('over this action', 'The number beside it counts the test cases that reach any part of this one action: its call, the code that answers it and the checks on the way.'),
  'count.over.part': same('over this part alone', 'The number beside it counts only the test cases that reach this one part of the code, not the action or the screen it belongs to.'),
  'count.over.gate': same('over this gate', 'The number beside it counts the test cases that reach this checkpoint, or a call in front of it.'),
  'count.over.route': same('over the route it will call', 'The screen is designed and not built, so no test can reach it. The number beside it counts the test cases that reach the routes the design says it will call.'),
  'count.over.affected': same('over what this change reaches', 'The number beside it counts the test cases that reach the part that changed, or anything that uses it as far out as the answer looked.'),
  'count.over.source': same('over this source', 'The number beside it counts the test cases of one source at one test level.'),
  'count.over.selection': same('over the sources and level selected', 'The number beside it counts the test cases in the sources and at the level this page has selected.'),
  'count.over.workspace': same('over every source in scope', 'The number beside it counts the test cases of every source in scope.'),
  'tests.notBuilt.word': same('designed, not built', 'The design names this screen and no code for it exists yet.'),
  'tests.notBuilt.sentence': same('no test can reach a screen with no code', 'A screen that is designed and not built has nothing a test can run, so it has no test verdict. Cases that reach the routes it will call are counted beside it, with their own scope.'),
  'tests.distinct': same('distinct', 'Counts each part or case once across the journey: a case that reaches two screens is counted once here. The per-screen numbers overlap, so they add up to more than this total.'),
  'tests.distinct.head': same('distinct over this journey', 'A part or a case two screens share is counted once in the journey total. The table shows the same journey counted screen by screen.'),
  'tests.distinct.perScreen': same('per screen', 'The sum of the per-screen numbers: a part or a case two screens share is counted on each.'),
  'tests.distinct.total': same('distinct', 'The journey total: each part or case once.'),
  'tests.distinct.actions': same('actions', 'Things a person can do on the screen: one call to the API and the work behind it.'),
  'tests.distinct.gates': same('gates & rules', 'The checkpoints and rules the screen’s calls meet.'),
  'tests.distinct.cases': same('test cases', 'Test cases that reach the screen.'),
  'tests.scopeLine.action': same('{n} over its action {name}', 'Test cases that reach one action of this screen: its call and the code that answers it.'),
  'tests.scopeLine.gate': same('{n} over the gate {name}', 'Test cases that reach one checkpoint this screen’s calls meet.'),
  'tests.scopeLine.page': same('{n} over the page’s own code', 'Test cases that reach the screen’s page or the components it draws, rather than a call or a checkpoint.'),
  'tests.noneKnown': same('no test is known to reach: {list}', 'Screens of this journey no indexed test reaches. A floor: a test this build could not read is not counted, so this says what is known, not that none exists.'),
  'tests.col.evidenceWord': same('evidence word', 'The case’s own evidence word on this part, as the screen prints it: declared only, reached by tests, verified by a run, passed by its own declaration or seen by a coverage run.'),
  'tests.obsPart.cases': same('{n} placed by a run’s coverage', 'Cases a results report named and a coverage report placed on this code.'),
  'tests.obsPart.declared': same('{n} passed, by their own declaration', 'End-to-end cases a results report says passed, each declaring that it covers this code.'),
  'tests.obsPart.runs': same('{n} run reports', 'Run-level coverage reports: a run reached this code and the report does not say which case did.'),
  'tests.levelRows': same('{n} journeys no {level} test is known to reach', 'Journeys left out of the table under this level filter: no case of the selected level reaches them.'),
};
