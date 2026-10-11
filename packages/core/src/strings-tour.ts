// The tour's words (round 2026-10-10, proposal 8: walk me through it). Spread into STRINGS in strings.ts.
//
// The tour is assembled, never written: every clause is one of these templates, filled with names and sentences
// the graph holds, and each clause carries the node it cites. A template that names code (a function, a file and
// line) has a `tour.biz.*` twin with the code left out — the business register prints the twin, and the code stays
// in the tip. Same rules as the rest of the catalog: both registers, a define on every word, defines in plain words.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const TOUR_STRINGS: Record<string, StringEntry> = {
  // ── the panel ──────────────────────────────────────────────────────────────────────────────────────────────
  'tour.title': {
    hud: 'Walk me through it',
    professional: 'Walk me through it',
    define: 'A guided walk through a storyline or a journey: one stop per screen and one per hand-off, where the code moves the record on. Every sentence is put together from facts the graph holds, and each part of a sentence names the thing it was read from.',
  },
  'tour.open': same('walk me through it', 'Opens the guided walk through this storyline or journey on the Map: one stop per screen and per hand-off, each sentence read from the graph.'),
  'key.walk': same('On the Map: walk me through it — the guided walk and Ask beside the board', 'Opens or closes the guided walk beside the Map: one stop per screen and per hand-off, and a box to ask a question answered from the graph.'),
  'tour.tool': same('WALK', 'The guided walk through the storyline or journey on the Map: one stop per screen and per hand-off. Every sentence is read from the graph and names what it was read from.'),
  'tour.stopOf': same('stop {n} of {m}', 'Where this stop sits in the walk: one stop per screen, in the order the storyline runs, and one per hand-off between them.'),
  'tour.prev': same('‹ prev', 'The stop before this one; the Map moves with it.'),
  'tour.next': same('next ›', 'The next stop; the Map moves with it.'),
  'tour.close': same('close the walk', 'Closes the walk. The Map stays where the last stop put it.'),
  'tour.derived': same('every sentence is read from the graph · nothing is inferred by a model',
    'The walk is put together from templates filled with what the code, the design and the test runs say. No language model writes or rewrites it, so each part of each sentence can be traced to the thing it names.'),
  'tour.referenced': same('referenced', 'The parts this stop names, each a door: a click frames it on the Map at the right stop.'),
  'tour.dots': same('the stops of this walk', 'One dot per stop; the filled one is the stop on screen. A click goes to that stop.'),
  'tour.empty': same('nothing to walk', 'The storyline or journey has no screen the graph can place, so there is no stop to show. A design manifest that lists its screens, or pages the code serves, gives the walk its stops.'),
  'tour.loading': same('putting the walk together…', 'The walk is being assembled from the graph.'),
  'tour.failed': same('the walk could not be put together: {error}', 'The server could not assemble the walk for this storyline or journey; the reason it gave follows.'),
  'tour.kind.screen': same('screen', 'A stop on one screen of a journey: what it is for, what it reads and writes, what must be true before its actions go through, and what its tests say.'),
  'tour.kind.handoff': same('hand-off', 'A stop on a move the code makes to a record: who makes it, to what status, what must be true first, and whether the code checks the status it moves from.'),
  'tour.kind.handoffs': same('hand-offs', 'The moves the code makes to a record along the walk, each its own stop.'),
  'tour.branch': same('branch of {name} · when {when}', 'This journey leaves the storyline from the journey named, under the condition given, as the design declares it.'),
  'tour.cite': same('read from', 'What this part of the sentence was read from. A click frames it on the Map at the right stop; its tip names it as the code does.'),
  'tour.notChecked': same('not checked by the code', 'The code that makes this move does not compare the status the record is in before it writes the new one: nothing in the code stops the move from any status. The design may expect a check; the graph found none.'),

  // ── a screen stop ──────────────────────────────────────────────────────────────────────────────────────────
  'tour.screen.title': same('{screen}', 'The screen this stop is on.'),
  'tour.screen.sub': same('{journey} · screen {n} of {m}', 'The journey this screen belongs to, and where it sits among that journey’s screens.'),
  'tour.screen.words': same('{words}', 'What the screen is for, in the words somebody wrote: a business sentence on its page, else the description in the design.'),
  'tour.screen.noWords': {
    hud: 'Nobody has written what {screen} is for yet.',
    professional: 'Nobody has written what {screen} is for yet.',
    define: 'Neither the page that serves this screen nor the design describes it. A business sentence on the page, or a description in the design manifest, would be read here.',
  },
  'tour.screen.who': same('{persona} uses it.', 'Who the journey is for, as the design or the configuration declares it.'),
  'tour.ref.after': same('After “{action}” moved the {record} to {status} (stop {stop}), this screen comes next.',
    'The stop before this one was a hand-off: the walk names it so the screen is read in its place.'),
  'tour.ref.reads': same('It reads the {record} that {screen} wrote (stop {stop}).',
    'An earlier stop of this walk wrote the record this screen reads: the two are joined by the record, as the code shows.'),
  'tour.screen.actions': same('From here a person can: {list}.', 'The actions this screen starts, each in the words its code or its contract carries.'),
  'tour.screen.noActions': same('Nothing on this screen calls the system.', 'The walk found no call this screen makes: it shows what it was given.'),
  'tour.screen.reads': same('It reads {list}.', 'The records this screen’s actions read, with the store each lives in when the graph names it.'),
  'tour.screen.writes': same('It writes {list}.', 'The records this screen’s actions write, with the store each lives in when the graph names it.'),
  'tour.screen.calls': same('It reaches {list}.', 'The third parties this screen’s actions call.'),
  'tour.inStore': same('the {record} record in {store}', 'A record and the data store it lives in, as the code or the configuration names it.'),
  'tour.record': same('the {record} record', 'A record the code reads or writes; the graph names no store for it.'),
  'tour.noneKnown': same('no test is known to reach it', 'No indexed test reaches this check, neither the check itself nor a call it guards. A floor: a test this build could not read is not counted.'),
  'tour.screen.needs': same('Before its actions go through: {list}.', 'What must be true before this screen’s actions go through — the checks that matter to the business and the policies, in the words somebody wrote, else the check’s own name.'),
  'tour.screen.technical': same('…and {count}, listed on the Map.', 'The technical checks on this screen — input shape and platform checks — counted, not listed; the gate list on the Map names each.'),
  'tour.verdict': same('Tests: {word} — {count} {scope}{runs}.', 'What the tests say, in the one verdict every surface prints, with how many cases it counts and the scope it counts over.'),
  'tour.noTests': same('No test is known to reach {what}.', 'No indexed test reaches this. A floor: a test this build could not read is not counted, so this says what is known, not that none exists.'),
  'tour.screen.notBuilt': same('{screen} is designed, not built: no test can reach a screen with no code.', 'The design names this screen and no page in the code serves it yet, so it has no verdict.'),

  // ── a hand-off stop ────────────────────────────────────────────────────────────────────────────────────────
  'tour.handoff.title': same('The {record} becomes {status}', 'A move the code makes to a record: the record and the status it is moved to.'),
  'tour.handoff.sub': same('{journey} · on {screen}', 'The journey and the screen whose action makes this move.'),
  'tour.handoff.who': same('{persona} moves the {record} to {status} with “{action}” on {screen}; {writer} writes it ({at}).',
    'Who makes the move, with which action on which screen, and the code that writes the new status, with its file and line.'),
  'tour.handoff.creates': same('This creates the {record}: there is no status to move it from.', 'The code writes the record in its first declared status, so the move starts it rather than changing it.'),
  'tour.handoff.checked': same('The code checks that the {record} is {from} first.', 'The code that makes this move compares the status the record is in before it writes the new one.'),
  'tour.handoff.unchecked': same('Not checked by the code: nothing compares the status the {record} is in before {writer} moves it.',
    'The code that makes this move does not compare the status the record is in first. Nothing in the code stops the move from any status.'),
  'tour.handoff.needsHead': same('What must be true first:', 'The checks that matter to the business and the policies on the action that makes the move, each with what the tests say about it.'),
  'tour.need': same('{words}', 'One thing that must be true before the move goes through, in the words somebody wrote, else the check’s own name.'),
  'tour.decision': same('A decision on the way: {label}', 'A choice the code makes on the way to the move that somebody put in plain words.'),
  'tour.handoff.technical': same('…and {count}.', 'The technical checks on the action that makes the move — input shape and platform checks — counted, not listed.'),
  'tour.handoff.proof': same('Tests of the move: {word} — {count} {scope}{runs}.', 'What the tests say about the code that writes the new status, in the one verdict, with how many cases reach it and over what.'),

  // ── the business register: the same sentences with the code left out (the code is in the tip) ─────────────────
  'tour.biz.handoff.who': same('{persona} moves the {record} to {status} with “{action}” on {screen}.',
    'Who makes the move, with which action on which screen.'),
  'tour.biz.handoff.unchecked': same('Not checked: nothing makes sure the {record} is in the right state before it moves.',
    'The system does not look at the record’s state before it moves it on, so nothing stops the move from any state.'),
  'tour.biz.handoff.checked': same('The {record} must be {from} first — the system checks it.', 'The system looks at the record’s state before it moves it on.'),
  'tour.biz.verdict': same('Tests: {word} — {count} {scope}{runs}.', 'What the tests say, with how many tests it counts and over what.'),
  'tour.biz.handoff.proof': same('Tests of the move: {word} — {count} {scope}{runs}.', 'What the tests say about the move, with how many tests reach it and over what.'),

  'tour.biz.theMove': same('this move', 'The move the stop is about: the record put into its new status.'),

  // ── its numbers ───────────────────────────────────────────────────────────────────────────────────────────
  'count.unit.tourStops': same('{n} stops', 'The stops of a guided walk: one per screen the storyline or journey shows, each once, and one per hand-off — a move the code makes to a record along the way.'),
  'count.unit.tourStopsOne': one('1 stop', 'count.unit.tourStops'),
  'count.part.tourScreens': same('{n} screens', 'The stops on a screen, each screen once however many journeys of the storyline show it.'),
  'count.part.tourScreensOne': one('1 screen', 'count.part.tourScreens'),
  'count.part.tourHandoffs': same('{n} hand-offs', 'The stops on a move the code makes to a record, each move once.'),
  'count.part.tourHandoffsOne': one('1 hand-off', 'count.part.tourHandoffs'),
};
