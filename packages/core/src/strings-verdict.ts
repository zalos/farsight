// The round-3 swarm's words (2026-10-11): a journey's verdict when it is partly built, the runs line as one
// sentence, the readiness header's *distinct*, Ask's *did you mean*, and the absences that were blanks. Spread into
// STRINGS in strings.ts, like strings-doors.ts. Same rules as the rest of the catalog: both registers, a define on
// every word, defines in plain words.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const VERDICT_STRINGS: Record<string, StringEntry> = {
  // ── build state wins (finding 3) ──
  'tests.builtOnly.before': same('partly built · {n} of {m}',
    'Only some of this journey’s screens have code. Its test verdict is about the screens that are built; the others have no code for a test to reach.'),
  'tests.builtOnly.after': same('over the {n} built screens',
    'The verdict beside this counts only the screens that have code. A screen that is designed and not built has no verdict.'),
  'tests.builtOnly.afterOne': one('over the 1 built screen', 'tests.builtOnly.after'),
  'state.unit.journeysBuiltOnly': same('{n} journeys not fully built, so no journey verdict',
    'Journeys with a screen that is designed and not built. Their test words are about the screens that are built, or about code they share with other journeys, so they are counted apart from the journeys whose verdict covers the whole journey.'),
  'state.unit.journeysBuiltOnlyOne': one('1 journey not fully built, so no journey verdict', 'state.unit.journeysBuiltOnly'),
  'count.part.partlyBuilt': same('{n} partly built', 'Journeys with some screens built: the word is about those screens only.'),
  'count.part.noScreenBuilt': same('{n} with no screen built', 'Journeys none of whose screens has code: what reaches them reaches code they share with other journeys.'),
  // ── the word names what it is a verdict over (finding 4) ──
  'tip.journey.obs.byDecl': same('earned by',
    'The cases whose own results earned this word: end-to-end cases that declare they cover this, each passed in its last recorded run.'),
  'tests.runs.lead': same('by their own last runs',
    'Every case counted here, by what its own last recorded run said: passed, failed, skipped, flaky, or no run recorded. The parts add up to the cases.'),
  // ── readiness: a hold names its case, other skips are notes, the header says distinct (finding 5) ──
  'readiness.note.skipped': same('note: {n} other cases skipped',
    'Cases in this journey’s scope that were skipped on their own last run and do not declare this journey. Said here, never a reason to hold: only the journey’s own declared cases and its screens hold it.'),
  'readiness.note.skippedOne': one('note: 1 other case skipped', 'readiness.note.skipped'),
  'readiness.note.failed': same('note: {n} other cases failed',
    'Cases in this journey’s scope that failed on their own last run and do not declare this journey. Said here, never a reason to hold.'),
  'readiness.note.failedOne': one('note: 1 other case failed', 'readiness.note.failed'),
  'readiness.distinct.head': same('distinct over the storyline, and on each row',
    'The header counts each case or gate once over the whole storyline. A row counts what its own journey reaches, so a case two journeys share is on both rows.'),
  'readiness.distinct.row': same('on its row', 'What this journey’s own row counts.'),
  'readiness.distinct.sum': same('rows added up', 'The rows added together: a shared case or gate counted once per journey.'),
  // ── an HTTP status the code answers with, in words, for the business register (finding 10) ──
  'http.word.400': same('a refusal (the request is not valid)', 'The service answers that what was sent is not a valid request.'),
  'http.word.401': same('a refusal (nobody is signed in)', 'The service answers that the person is not signed in.'),
  'http.word.403': same('a refusal (not allowed)', 'The service answers that the person is signed in and not allowed to do this.'),
  'http.word.404': same('a not found', 'The service answers that what was asked for does not exist, or is not for this person to see.'),
  'http.word.409': same('a refusal (the record is not in the right state)', 'The service answers that the record is in a state that does not allow this.'),
  'http.word.413': same('a refusal (too large)', 'The service answers that what was sent is larger than it accepts.'),
  'http.word.415': same('a refusal (a kind of file it does not take)', 'The service answers that what was sent is not a kind it accepts.'),
  'http.word.422': same('a refusal (the details do not pass the checks)', 'The service answers that the request is well formed and its details do not pass the checks.'),
  'http.word.429': same('a refusal (too many tries)', 'The service answers that too many requests came too quickly.'),
  'http.word.5xx': same('a failure of the service', 'The service answers that it failed to do what was asked.'),
  'readiness.distinct.total': same('distinct', 'Each case or gate once, however many journeys reach it.'),
};
