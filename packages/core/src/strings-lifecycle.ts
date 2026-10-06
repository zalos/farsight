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
};
