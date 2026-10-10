// The swimlanes' words (round 2026-10-10 §2): a storyline drawn as lanes of who acts — one per persona that owns a
// journey of it and one per store its calls write to — its screens as columns, the record's moves as pills in the
// store lane, and the lifecycle underneath. Spread into STRINGS in strings.ts like strings-doors.ts. Same rules as
// the rest of the catalog: both registers, a define on every word, defines in plain words (no backticks, no
// markdown, no dotted identifiers, no placeholders in a define).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const LANES_STRINGS: Record<string, StringEntry> = {
  // the layout control beside the storyline picker
  'map.layout.pick': same('layout', 'How the storyline is drawn: as a chain of its journeys, or as lanes of who acts with the record they move underneath.'),
  'map.layout.chain': same('chain', 'The storyline as a chain: each journey a card, in order, its branches below the journey they leave from.'),
  'map.layout.lanes': same('lanes', 'The storyline as swimlanes: a lane for each kind of person who acts in it and one for each store its code writes to, the screens in order as columns, and the record’s moves in the store lane.'),
  'key.mapLanes': same('On a storyline: switch between the chain and the lanes'),

  // the board's header and the lanes
  'lanes.tag': same('lanes', 'This storyline is drawn as swimlanes. The lanes come from the personas the design names and the stores the code writes to; nothing is drawn by hand.'),
  'lanes.count.lanes': same('{n} lanes', 'The lanes drawn: one for each kind of person who owns a journey of this storyline, and one for each store its code writes to.'),
  'lanes.count.lanesOne': one('1 lane', 'lanes.count.lanes'),
  'lanes.scope.lane': same('in this lane', 'What the number beside it counts over: the screens drawn in this one lane — the screens of the journeys this kind of person owns in the storyline.'),
  'lanes.count.screens': same('{n} screens', 'Screens drawn in this lane. A screen reached again on a later journey of the main path is drawn once; a branch’s screens are drawn on their own lane.'),
  'lanes.count.screensOne': one('1 screen', 'lanes.count.screens'),
  'lanes.count.writes': same('{n} writes', 'What the storyline’s code writes in this store: each status it moves a record into, and each other record it writes, counted once however many screens make it.'),
  'lanes.count.writesOne': one('1 write', 'lanes.count.writes'),
  'lanes.count.distinctScreens': same('{n} screens', 'The different screens of this storyline, each counted once however many of its journeys reach it, branches included.'),
  'lanes.count.distinctScreensOne': one('1 screen', 'lanes.count.distinctScreens'),
  'lanes.count.built': same('{n} of {m} built', 'Screens of this storyline that a page in the code serves, out of every screen it names.'),
  'lanes.count.branches': same('{n} branches', 'Journeys that leave this storyline at one of its journeys when a condition holds, as the design declares them.'),
  'lanes.count.branchesOne': one('1 branch', 'lanes.count.branches'),
  'lanes.part.personaLanes': same('{n} for a kind of person', 'Lanes of the people who own a journey of this storyline, from the personas the design names.'),
  'lanes.part.storeLanes': same('{n} for a store', 'Lanes of the stores this storyline’s code writes to.'),
  'lanes.part.mainPath': same('{n} on the main path', 'Screens of the storyline’s journeys in their declared order.'),
  'lanes.part.branch': same('{n} on a branch', 'Screens of a journey that leaves the storyline when a condition holds.'),
  'lanes.part.statusMoves': same('{n} status moves', 'Moves of a record into a status the code declares, made by code this storyline runs.'),
  'lanes.part.recordsWritten': same('{n} records written', 'Records the storyline writes whose statuses the code does not declare.'),
  'lanes.part.folded': same('{n} in records not drawn', 'Writes to records past the ones the lane has room for; their names are in the lane’s last line.'),
  'lanes.part.built': same('{n} built', 'Screens a page in the code serves.'),
  'lanes.part.notBuilt': same('{n} designed, not built', 'Screens the design names that no page in the code serves yet.'),
  'lanes.footer.from': same('lanes from the manifest’s personas and the stores the code writes', 'Where the lanes come from: a lane for each persona the design names who owns a journey here, and one for each store the walked code writes to. The design may name a lane or a hand-off; it never draws one the code does not show.'),
  'lanes.footer.reading': same('reading {n} of {m} journeys', 'The lanes are drawn from each journey’s walk; the ones not read yet add their screens and moves when they land.'),
  'lanes.hint': same('click a screen, or zoom into it, to walk its journey from there', 'A screen on the lanes is a screen of a journey: opening it lands on that journey’s street at that screen, the same zoom that goes on to the screen itself.'),
  'lanes.persona.none': same('nobody named', 'Journeys whose design names no persona: their screens share one lane.'),
  'lanes.store.sub': same('{kind} · written by this storyline', 'A store this storyline’s code writes to; its lane holds the records it writes, the moves first.'),

  // the stages and their decisions
  'lanes.stage.open': same('walk this journey from this screen', 'Opens the journey this screen belongs to on its street, at this screen.'),
  'lanes.stage.branch': same('branch · when {when}', 'This screen belongs to a journey that leaves the storyline at the journey it is drawn after, when this condition holds.'),
  'lanes.stage.built': same('built', 'A page in the code serves this screen.'),
  'lanes.decision': same('decision', 'A choice the code makes on this screen, in the words the team wrote. It is drawn beside the screen, never as a screen of its own, so the count of screens stays true.'),
  'lanes.decision.more': same('+{n}', 'More choices the code makes on this screen; the tip lists them.'),

  // the pills
  'lanes.pill.created': same('created ({status})', 'A move into the first status the code declares for this record: where a new one starts.'),
  'lanes.pill.move': same('status → {status}', 'A move of this record into a status, made by code this storyline runs.'),
  'lanes.pill.written': same('written', 'This storyline writes the record; the code declares no statuses for it.'),
  'lanes.pill.by': same('by {name}', 'The code that makes this move or this write.'),
  'lanes.pill.from': same('made on {names}', 'The screens of this storyline whose code makes this move.'),
  'lanes.pill.more': same('+{n} records written', 'More records this storyline writes in this store, past the ones the lane has room for; the tip names them.'),
  'lanes.pill.unchecked': same('the prior status is not checked by the code', 'The code that makes this move does not compare the record’s status first, so it would make the move from any status.'),

  // the arrows
  'lanes.arrow.seen': same('seen · {status}', 'A screen in another lane reads the record and shows it in this status: what that person sees change without doing anything. Drawn from a hand-off the design names, only when the screen reads the record.'),
  'lanes.arrow.declared': same('named by the design', 'This hand-off is written in the design manifest or the configuration; the code shows both its ends.'),

  // the legend
  'lanes.legend.title': same('what the lanes draw', 'The marks on the swimlane board and what each means.'),
  'lanes.legend.moves': same('moves the record', 'A screen whose code moves a record into a status or writes it.'),
  'lanes.legend.seen': same('seen to change', 'A screen in another lane that reads the record in that status.'),
  'lanes.legend.notBuilt': same('designed, not built', 'A screen the design names that no page in the code serves yet.'),
  'lanes.legend.branch': same('branch', 'A journey that leaves the storyline when a condition holds, drawn on the lane of the person who acts in it.'),
  'lanes.legend.needs': same('needs before a move', 'What the code checks before it makes the move: who may make it and the state the record must be in.'),

  // notes: what the design names that the graph cannot find, never drawn
  'lanes.notes': same('{n} notes', 'Lanes or hand-offs the design names that the code does not show. They are not drawn; the tip lists each.'),
  'lanes.notesOne': one('1 note', 'lanes.notes'),
  'lanes.note.persona': same('lane {id}: persona {persona} owns no journey of this storyline — not drawn', 'A lane the design names for a person who owns no journey of the storyline.'),
  'lanes.note.store': same('lane {id}: no call of this storyline writes to {store} — not drawn', 'A lane the design names for a store the storyline’s code does not write to.'),
  'lanes.note.handoff': same('hand-off {from} → {to}: {why} — not drawn', 'A hand-off the design names whose ends the code does not show.'),
  'lanes.why.noScreen': same('{ref} is not a screen of this storyline', 'The hand-off names a journey and screen number this storyline does not have.'),
  'lanes.why.noStoreLane': same('{ref} is not a store lane of this storyline', 'The hand-off names a lane that is not one of the stores this storyline writes to.'),
  'lanes.why.noMove': same('no code of this storyline moves a record of {store} into {status}', 'The hand-off names a status nothing this storyline runs moves a record into.'),
  'lanes.why.noStatus': same('it names no status', 'A seen hand-off needs the status the screen sees.'),
  'lanes.why.noRead': same('{screen} does not read {record}', 'The screen’s walk reads nothing of the record the hand-off names.'),
  'lanes.why.sameLane': same('the screen is in the store’s own lane', 'A hand-off joins two lanes.'),
};
