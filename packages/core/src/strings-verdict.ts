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
  'readiness.distinct.total': same('distinct', 'Each case or gate once, however many journeys reach it.'),
};
