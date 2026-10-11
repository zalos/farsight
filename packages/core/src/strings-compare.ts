// The compare words (round 2026-10-10, proposal 7): two syncs of one storyline set side by side, the deltas between
// them from a closed set of five kinds (built · gate · writer · contract · verdict), each a sentence in the hybrid
// and code words and one in the business words, each with a door. Spread into STRINGS in strings.ts like
// strings-doors.ts. Same rules as the rest of the catalog: both registers, a define on every word, defines in plain
// words (no backticks, no markdown, no dotted identifiers, no placeholders in a define). The business sentences live
// under map.biz.compare.* so lint RULE 5 holds them to the business register's words.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const COMPARE_STRINGS: Record<string, StringEntry> = {
  // the counts
  'count.scope.compare': same('over this storyline, between the two syncs', 'What the number beside it counts over: the journeys of this storyline and its branches, as either sync declares them, and what their walks reach — compared between the earlier sync and the later one.'),
  'count.unit.deltas': same('{n} changes', 'Changes on this storyline between the two syncs, each one of five kinds: a screen built, a gate on a call, a writer of a status, an operation on the contract, a journey’s test verdict. Nothing else is counted as a change here.'),
  'count.unit.deltasOne': one('1 change', 'count.unit.deltas'),
  'count.unit.journeysChanged': same('{n} of {m} journeys changed', 'Journeys of this storyline whose card carries at least one change, out of the journeys either sync draws.'),
  'count.part.delta.built': same('built {n}', 'Screens served by a page at one sync and not the other.'),
  'count.part.delta.gate': same('gate {n}', 'Gates that stand in front of a call or an action of this storyline at one sync and not the other.'),
  'count.part.delta.writer': same('writer {n}', 'Statuses of a record this storyline reaches that gained or lost the code that moves the record into them.'),
  'count.part.delta.contract': same('contract {n}', 'Operations this storyline reaches that were added to the API contract, taken off it, or changed on it.'),
  'count.part.delta.verdict': same('verdict {n}', 'Journeys whose one test verdict changed its word, its status, its skips or its failures.'),

  // the kinds and the ways they went
  'compare.kind.built': same('built', 'A screen of the storyline that a page in the code now serves, or no longer serves.'),
  'compare.kind.gate': same('gate', 'A gate or a precondition in front of a call or an action of the storyline, added or removed.'),
  'compare.kind.writer': same('writer', 'A status of a record the storyline reaches that gained or lost the code that moves the record into it.'),
  'compare.kind.contract': same('contract', 'An operation the storyline reaches, added to the API contract, taken off it, or changed on it.'),
  'compare.kind.verdict': same('verdict', 'A journey whose one test verdict changed between the two syncs.'),
  'compare.change.added': same('added', 'It is there at the later sync and was not at the earlier one.'),
  'compare.change.removed': same('removed', 'It was there at the earlier sync and is not at the later one.'),
  'compare.change.changed': same('changed', 'It is there at both syncs and is not the same.'),

  // the sentences — hybrid and code words; identifiers are set apart where they are printed
  'compare.delta.built.added': same('{screen} is now built', 'A page in the code serves this screen at the later sync; at the earlier one it was designed and not built.'),
  'compare.delta.built.removed': same('{screen} is no longer built', 'At the earlier sync a page served this screen; at the later one nothing does.'),
  'compare.delta.gate.added': same('{screen} gained a gate: {gate} now guards {call}', 'A gate stands in front of this call at the later sync that did not at the earlier one.'),
  'compare.delta.gate.removed': same('{screen} lost a gate: {gate} no longer guards {call}', 'A gate that stood in front of this call at the earlier sync does not at the later one.'),
  'compare.delta.writer.added': same('{status} gained a writer: {writer} now sets it', 'Code that moves the record into this status is there at the later sync and was not at the earlier one.'),
  'compare.delta.writer.removed': same('{status} lost a writer: {writer} no longer sets it', 'Code that moved the record into this status at the earlier sync does not at the later one.'),
  'compare.delta.contract.added': same('{op} was added to the contract and is called', 'The API description declares this operation at the later sync, and code of this storyline calls it.'),
  'compare.delta.contract.addedUncalled': same('{op} was added to the contract; nothing on this storyline calls it yet', 'The API description declares this operation at the later sync; no code of this storyline calls it.'),
  'compare.delta.contract.removed': same('{op} was taken off the contract', 'The API description declared this operation at the earlier sync and does not at the later one.'),
  'compare.delta.contract.implemented': same('{op} is now built: the contract declared it and code now serves it', 'At the earlier sync the API description declared this operation and no code served it; at the later one code serves it.'),
  'compare.delta.contract.unimplemented': same('{op} is declared and no longer served by code', 'At the earlier sync code served this declared operation; at the later one nothing does.'),
  'compare.delta.contract.status': same('{op} moved on the contract: {from} → {to}', 'How the API description and the code agree on this operation changed between the two syncs.'),
  'compare.delta.contract.shape': same('{op} changed on the contract: what it takes, answers or requires', 'The parameters, the request, the answers or the security the API description gives this operation changed between the two syncs.'),
  'compare.delta.verdict.changed': same('{journey}: its cases went {from} → {to}', 'The one test verdict of this journey, read the same way every surface reads it, changed between the two syncs. Freshness is said apart and is never a change here.'),
  'compare.verdict.skipped': same('{n} skipped', 'Cases in scope whose own last run was skipped.'),
  'compare.verdict.failed': same('{n} failed', 'Cases in scope whose own last run failed.'),

  // the sentences — business words: the screen’s and the gate’s own words, never an identifier
  'map.biz.compare.built.added': same('{screen} is now built', 'The screen now exists in the application; at the earlier sync it was designed and not built.'),
  'map.biz.compare.built.removed': same('{screen} is no longer built', 'The screen existed in the application at the earlier sync and does not at the later one.'),
  'map.biz.compare.gate.added': same('{screen} gained a check: {words}', 'The application now checks this before it goes on, where it did not at the earlier sync.'),
  'map.biz.compare.gate.removed': same('{screen} lost a check: {words}', 'The application checked this at the earlier sync and no longer does.'),
  'map.biz.compare.writer.added': same('the application can now set {record} to {status}', 'Something in the application now moves the record into this status; at the earlier sync nothing on this path did it this way.'),
  'map.biz.compare.writer.removed': same('one way to set {record} to {status} is gone', 'Something in the application moved the record into this status at the earlier sync and no longer does.'),
  'map.biz.compare.contract.added': same('a new service operation is promised and used: {what}', 'The service’s published description now promises this operation, and this storyline uses it.'),
  'map.biz.compare.contract.addedUncalled': same('a new service operation is promised and not used yet: {what}', 'The service’s published description now promises this operation; nothing on this storyline uses it yet.'),
  'map.biz.compare.contract.removed': same('a service operation is no longer promised: {what}', 'The service’s published description promised this operation at the earlier sync and does not now.'),
  'map.biz.compare.contract.implemented': same('a promised service operation now works: {what}', 'The service promised this operation at the earlier sync and nothing provided it; now the application does.'),
  'map.biz.compare.contract.unimplemented': same('a promised service operation no longer works: {what}', 'The application provided this promised operation at the earlier sync and does not now.'),
  'map.biz.compare.contract.status': same('a service operation changed how it is promised: {what}', 'Whether the service promises this operation and whether the application provides it changed.'),
  'map.biz.compare.contract.shape': same('a service operation changed what it asks for or answers: {what}', 'What the service asks for, answers or requires for this operation changed between the two syncs.'),
  'map.biz.compare.verdict.changed': same('the checks on {journey} went {from} → {to}', 'What the automated checks say about this journey changed between the two syncs.'),

  // the doors
  'compare.door.screen': same('open the screen', 'Opens this screen on its journey, on the Map.'),
  'compare.door.gate': same('open the gate card', 'Opens the gate’s card: what it allows, where it stands, its code and the tests that reach it.'),
  'compare.door.move': same('see the move', 'Shows the code that moves the record into this status on the code map.'),
  'compare.door.cases': same('see the cases', 'Opens the Tests page kept to this journey: every case that runs over it, with its last run.'),
  'compare.door.contract': same('read the contract', 'Opens this operation on the APIs page: what it promises beside the code that serves it.'),

  // notes the comparison prints when it cannot say something
  'compare.note.metaA': same('sync {sync} was recorded before history kept the storyline’s declaration; it is read with the later sync’s', 'An older sync keeps its code, not the manifest’s words. Its journeys are found by the later sync’s storyline, which is said rather than assumed.'),
  'compare.note.newStoryline': same('sync {sync} draws no storyline of this id: everything on it is new since', 'The earlier sync does not declare this storyline, so every screen of the later one would be a change; none is listed one by one.'),
  'compare.note.goneStoryline': same('sync {sync} draws no storyline of this id: it was taken out since', 'The later sync does not declare this storyline.'),

  // the Map's compare control (toolbar) and the panel
  'compare.control': same('compare', 'Set two syncs of this storyline side by side: the board draws the later one, the cards carry what changed, and a panel lists each change as a sentence with where to read it.'),
  'compare.control.off': same('off', 'No comparison: the board draws the sync this server serves, with no change marks.'),
  'compare.control.range': same('sync {a} → sync {b}', 'The earlier sync and the later one being compared. The board draws the later one.'),
  'compare.control.since': same('since {date}', 'The earlier sync is the last one recorded on or before this day.'),
  'compare.choice.previous': same('the sync before', 'Compare the sync this server serves with the one recorded just before it.'),
  'compare.choice.sync': same('sync {n} · {date}', 'Compare from this recorded sync to the one this server serves.'),
  'compare.choice.lastGreen': same('since the last green run', 'Compare from the newest earlier sync at which no case of this storyline had failed or been skipped on its own last run.'),
  'compare.choice.date': same('since a day…', 'Compare from the last sync recorded on or before the day you give.'),
  'compare.choice.datePrompt': same('compare since which day (YYYY-MM-DD)?', 'The earlier end of the comparison is the last sync recorded on or before this day.'),
  'compare.choice.tag': same('since a release…', 'Compare from the sync that read the release you name.'),
  'compare.choice.tagPrompt': same('compare since which release (its tag)?', 'The earlier end of the comparison is the sync that ingested this release’s commit.'),
  'compare.loading': same('comparing…', 'The two syncs are being read from history and compared.'),
  'compare.panel.title': same('what changed on this storyline', 'Every change between the two syncs on this storyline, each one of five kinds, as a sentence with where to read it in full.'),
  'compare.panel.none': same('nothing changed on this storyline between these two syncs', 'Neither a screen built, a gate, a writer, an operation on the contract nor a verdict differs between the two syncs.'),
  'compare.panel.closed': same('every change is one of: built · gate · writer · contract · verdict', 'The five kinds are a closed set. A change outside them, a body of code edited say, is on the Changes page, not here.'),
  'compare.panel.close': same('close the comparison', 'Ends the comparison: the board draws the sync this server serves, with no change marks.'),
  'compare.panel.save': same('save A → B', 'Saves the storyline board with its changes and this list, dated, as a picture or a document, with both syncs named in its footer.'),
  'compare.panel.unheld': same('sync {sync} is not indexed in this server’s history', 'The history this server reads does not hold that sync: it was never recorded here, or it was pruned. The comparison cannot be drawn.'),
  'compare.panel.headNote': same('the board draws sync {b}', 'The later end of the comparison, the state the board and its cards show.'),
  'compare.panel.notes': same('{n} notes', 'What the comparison could not say; the tip lists each.'),
  'compare.export.what': same('changes on {storyline} · sync {a} → sync {b}', 'What the saved picture shows: one storyline, the later sync drawn, with what changed since the earlier one.'),

  // the Changes page's storyline rows: each storyline, the same range, on the Map
  'changes.storylines.title': same('on the storylines', 'The same two syncs, one storyline at a time, on the Map: what changed in screens built, gates, writers, the contract and the verdicts, each change with where to read it.'),
  'changes.storylines.open': same('see what changed on {name}', 'Opens this storyline on the Map comparing the same two syncs, with the change marks on its cards and the list beside the board.'),

  // the chips on the cards
  'compare.chip.gate.added': same('+{n} gates', 'Gates added in front of this journey’s calls or actions since the earlier sync.'),
  'compare.chip.gate.addedOne': one('+1 gate', 'compare.chip.gate.added'),
  'compare.chip.gate.removed': same('−{n} gates', 'Gates in front of this journey’s calls or actions at the earlier sync that are gone.'),
  'compare.chip.gate.removedOne': one('−1 gate', 'compare.chip.gate.removed'),
  'compare.chip.built.added': same('now built · {n} of {m}', 'A screen of this journey is now served by a page; how many of its screens are built at the later sync.'),
  'compare.chip.built.removed': same('no longer built · {n} of {m}', 'A screen of this journey lost its page since the earlier sync; how many of its screens are built at the later sync.'),
  'compare.chip.writer.added': same('+{n} writers', 'Statuses that gained code moving the record into them, made by code this journey runs.'),
  'compare.chip.writer.addedOne': one('+1 writer', 'compare.chip.writer.added'),
  'compare.chip.writer.removed': same('−{n} writers', 'Statuses that lost code moving the record into them, code this journey ran.'),
  'compare.chip.writer.removedOne': one('−1 writer', 'compare.chip.writer.removed'),
  'compare.chip.contract.added': same('contract +{n} operations', 'Operations this journey reaches that were added to the API contract.'),
  'compare.chip.contract.addedOne': one('contract +1 operation', 'compare.chip.contract.added'),
  'compare.chip.contract.removed': same('contract −{n} operations', 'Operations this journey reached that were taken off the API contract.'),
  'compare.chip.contract.removedOne': one('contract −1 operation', 'compare.chip.contract.removed'),
  'compare.chip.contract.changed': same('contract · {n} changed', 'Operations this journey reaches whose contract changed: built, unbuilt, or what they take and answer.'),
  'compare.chip.verdict': same('{from} → {to}', 'This journey’s one test verdict at the earlier sync and at the later one.'),
  'map.biz.compare.chip.gate.added': same('+{n} checks', 'Checks the application now makes on this journey that it did not before.'),
  'map.biz.compare.chip.gate.addedOne': one('+1 check', 'map.biz.compare.chip.gate.added'),
  'map.biz.compare.chip.gate.removed': same('−{n} checks', 'Checks the application made on this journey that it no longer makes.'),
  'map.biz.compare.chip.gate.removedOne': one('−1 check', 'map.biz.compare.chip.gate.removed'),
  'map.biz.compare.chip.writer.added': same('+{n} status changes', 'New ways this journey moves a record into a status.'),
  'map.biz.compare.chip.writer.addedOne': one('+1 status change', 'map.biz.compare.chip.writer.added'),
  'map.biz.compare.chip.writer.removed': same('−{n} status changes', 'Ways this journey moved a record into a status that are gone.'),
  'map.biz.compare.chip.writer.removedOne': one('−1 status change', 'map.biz.compare.chip.writer.removed'),
  'map.biz.compare.chip.contract.added': same('+{n} service operations', 'Service operations this journey uses that are newly promised.'),
  'map.biz.compare.chip.contract.addedOne': one('+1 service operation', 'map.biz.compare.chip.contract.added'),
  'map.biz.compare.chip.contract.removed': same('−{n} service operations', 'Service operations this journey used that are no longer promised.'),
  'map.biz.compare.chip.contract.removedOne': one('−1 service operation', 'map.biz.compare.chip.contract.removed'),
  'map.biz.compare.chip.contract.changed': same('{n} service operations changed', 'Service operations this journey uses whose promise changed.'),
};
