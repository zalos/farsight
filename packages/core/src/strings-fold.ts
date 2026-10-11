// The fold's words (cleanup pass 2026-10-11, nothing on the Map overflows): a row of chips that has no room folds its
// last ones into one `+n` whose tip lists them, a path too long for its line keeps its two ends, and a rail of tabs
// that has no room folds the last tabs into one menu. Spread into STRINGS in strings.ts like strings-doors.ts. Same
// rules as the rest of the catalog: both registers, a define on every word, defines in plain words (no backticks, no
// markdown, no dotted identifiers, no placeholders in a define).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const FOLD_STRINGS: Record<string, StringEntry> = {
  'fold.more': same('+{n}', 'More items of this row, folded so none of them is cut off. Its tip lists them; zoom in or open the card to see them all.'),
  'fold.moreOf': same('items folded here', 'The items this row would print if it had room, in the order it prints them.'),
  'fold.scopeCard': same('this card', 'One card on the Map: a journey, a screen, a stage of a storyline or a record’s move.'),
  'fold.scopeRow': same('this row', 'One row of items on the Map: a legend, a list of names, the chips under a heading.'),
  'fold.path': same('the whole path', 'The full path of the file, of which the line shows the start and the end.'),
  'fold.tabs': same('more', 'The tabs that do not fit on the rail beside the others. Pick one to open it.'),
  'fold.statusesOf': same('statuses folded here', 'The statuses this lifecycle line would print if it had room, in the order the code declares them. The table behind what each one means lists them all.'),
  'fold.scopeLifecycle': same('this record’s lifecycle', 'Every status the code declares for this one record, in its declared order.'),
  'fold.chipsOf': same('parts folded here', 'The parts this line cites that do not fit beside the others, in the order it cites them. Each is a door to the part.'),
};
