// The status lifecycle's words (swarm-fixes round 2026-10-05, finding 7): the statuses a record's
// field may hold, read from the code, and the moves between them that a function performs.
// Spread into STRINGS in strings.ts. Same rules as the rest of the catalog: both registers, a
// define on every word, defines in plain words, no identifier in a word.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
/** the singular of a count's words; its define is copied from the plural at construction */
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const LIFECYCLE_STRINGS: Record<string, StringEntry> = {
  'lifecycle.word': { hud: 'status lifecycle', professional: 'status lifecycle', define: 'The statuses a record can be in, in the order the code declares them, and each move between them that some code makes. Read from the code: a status is listed because a declaration names it, a move only with the code that makes it.' },
  'lifecycle.ofRecord': same('{name} · {field}', 'The record and the field that holds its status.'),
  'lifecycle.declaredBy': same('declared in {where}', 'Where the code lists these statuses — a database check on the column, or a list, a schema or a type in the code. The first is the order shown.'),
  'lifecycle.move': same('{from} → {to}', 'A move some code makes: the record leaves the first status for the second. The code that makes it is one click away.'),
  'lifecycle.moveInto': same('→ {to}', 'A move into this status that some code makes, from a status the code does not check first.'),
  'lifecycle.by': same('by {name}', 'The code that writes this status.'),
  'lifecycle.unwritten': same('no code moves it here', 'The code declares this status but nothing in the code writes it: no screen or service can put a record into it yet.'),
  'lifecycle.none': same('no status list is declared for this record', 'Nothing in the code lists the statuses this record can be in — no database check on a status column and no list, schema or type that a status field of it is declared with.'),
  'lifecycle.via.assignment': same('sets the field', 'The code sets the status field on the record directly.'),
  'lifecycle.via.update-call': same('in an update', 'The code passes the new status in the changes it asks the store to save.'),
  'lifecycle.via.sql': same('in a database statement', 'The code writes the new status in a database update statement.'),
  'lifecycle.more': same('+{n} more records', 'Other records this journey moves between statuses. Each one\u2019s whole lifecycle is on the screen that moves it.'),
  // counts (docs/COUNTS.md § Lifecycle)
  'lifecycle.count.statuses': same('{n} statuses', 'How many statuses the code declares for this record’s status field.'),
  'lifecycle.count.statusesOne': one('1 status', 'lifecycle.count.statuses'),
  'lifecycle.count.transitions': same('{n} moves with a writer', 'How many moves between statuses some code makes, each counted once per piece of code that makes it.'),
  'lifecycle.count.transitionsOne': one('1 move with a writer', 'lifecycle.count.transitions'),
  'lifecycle.count.unwritten': same('{n} statuses no code moves to', 'How many declared statuses no code writes: the record can only be in them if something outside this code puts it there.'),
  'lifecycle.count.unwrittenOne': one('1 status no code moves to', 'lifecycle.count.unwritten'),
  'lifecycle.part.written': same('{n} some code moves to', 'Declared statuses that at least one piece of code writes.'),
  'lifecycle.part.unwritten': same('{n} no code moves to', 'Declared statuses no code writes.'),
  'lifecycle.part.withFrom': same('{n} that check the status first', 'Moves whose code compares the record’s status to one status before it writes the new one.'),
  'lifecycle.part.noFrom': same('{n} that do not check it first', 'Moves whose code writes the new status without comparing the old one to a single status first.'),

  // ── one state machine, two views of it (round 2026-10-10 §3): the persona's words, the constant, what moves it ──
  'lifecycle.count.moved': same('{n} some code moves to', 'How many of the declared statuses at least one piece of code writes.'),
  'lifecycle.count.movedOne': one('1 some code moves to', 'lifecycle.count.moved'),
  'lifecycle.biz.moved': same('{n} that the app moves', 'How many of these statuses something in the app puts a record into.'),
  'lifecycle.biz.movedOne': one('1 that the app moves', 'lifecycle.biz.moved'),
  'lifecycle.biz.unmoved': same('{n} nothing moves yet', 'How many of these statuses nothing in the app puts a record into yet. A record can only be in one if something outside the app puts it there.'),
  'lifecycle.biz.unmovedOne': one('1 nothing moves yet', 'lifecycle.biz.unmoved'),
  'lifecycle.count.overlays': same('{n} conditions that are not a status', 'How many things a person sees about this record that are not one of its statuses, such as an open request in another list. Named in the settings file; the code still decides what writes them.'),
  'lifecycle.count.overlaysOne': one('1 condition that is not a status', 'lifecycle.count.overlays'),
  'lifecycle.biz.ofRecord': same('{name}', 'The record whose statuses these are.'),
  'lifecycle.unmovedYet': same('no code moves it yet', 'Nothing in the code puts a record into this status yet: no screen or service can reach it.'),
  'lifecycle.word.declared': same('the word people use · in the code: {status}', 'The word this kind of user has for the status, written in the settings file. The code’s own name for it follows.'),
  'lifecycle.word.undeclared': same('no word declared for this status · in the code: {status}', 'Nobody has written down what this kind of user calls this status, so it is shown as the code’s name in plain words. Add one under lifecycle in the settings file.'),
  'lifecycle.toggle': same('what each one means', 'Open a table of every status: the word people use, the name in the code, and what in the app moves a record into it.'),
  'lifecycle.table.persona': same('what {persona} sees', 'The word this kind of user has for each status. Where nobody wrote one down, the code’s name in plain words.'),
  'lifecycle.table.personaNone': same('what it is called', 'The word people use for each status. Where nobody wrote one down, the code’s name in plain words.'),
  'lifecycle.table.code': same('in the code', 'The status as the code spells it — the value a person would search the code or the database for.'),
  'lifecycle.table.moves': same('what moves it', 'The code that puts a record into this status, and the journey screen it runs from when a journey reaches it.'),
  'lifecycle.table.nothing': same('nothing in the code moves it yet', 'The code declares this status but nothing writes it, so no screen or service can put a record into it yet.'),
  'lifecycle.table.on': same('{journey} · screen {n}', 'The journey and the screen this code runs from. Opens the journey at that screen.'),
  'lifecycle.table.offJourney': same('no journey reaches it', 'No journey’s screens reach this code, so there is no screen to open. It may run from a job, a message or a part no journey walks.'),
  'lifecycle.table.reading': same('reading what moves each status…', 'Placing each piece of code that moves a status on the journey screen it runs from.'),
  'lifecycle.table.failed': same('could not read what moves each status', 'The server did not answer. The statuses and their words above are still from this journey’s answer.'),
  'lifecycle.overlay.word': same('not a status', 'A condition a person sees about this record that is not one of its statuses — a row in another list, named in the settings file. The code decides what writes it.'),
  'lifecycle.overlay.code': same('{when} — not a status', 'When this condition holds, as the settings file says it. It is drawn apart from the statuses so nobody mistakes it for one.'),
  'lifecycle.overlay.table': same('in {table}', 'The list this condition is read from.'),
  'lifecycle.footer.named': same('names from farsight.config.json → lifecycle.views · statuses and moves read from the code', 'The words come from the lifecycle block of the settings file; which statuses exist and what moves a record between them come from the code, never from the settings.'),
  'lifecycle.footer.namedBiz': same('names written in the app’s Farsight settings · statuses and moves read from the code', 'The words come from the settings somebody wrote for this app; which statuses exist and what moves a record between them come from the code, never from the settings.'),
  'lifecycle.footer.plain': same('no words are declared for these statuses — each is the code’s name in plain words · statuses and moves read from the code', 'Nobody has written down what people call these statuses, so each is shown as the code’s name in plain words. Add the words under lifecycle in the settings file.'),
  'lifecycle.view.line': same('{persona} calls them', 'The words this kind of user has for the statuses, each followed by the code’s name for it.'),
};
