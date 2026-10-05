// The doors' words (round 2026-10-05 §3): every detail that names something in
// the graph is a link to where that thing is best read, and the Map and the
// journey open each other at the same step. Spread into STRINGS in strings.ts.
// Same rules as the rest of the catalog: both registers, a define on every word,
// defines in plain words. A door's word says what you will read there, never a
// path or an identifier, so every register can print it.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const DOOR_STRINGS: Record<string, StringEntry> = {
  'door.group': same('where to read it', 'The places this detail can be read in full: its code, its contract, its cases, its tracker, its design. Enter opens the first; the o key opens the editor.'),
  'door.editor': same('open in the editor', 'Opens the file at this line in your code editor, on this machine.'),
  'door.codemap': same('see it on the code map', 'Shows this part on the code map, selected, with what it is joined to.'),
  'door.contract': same('read the contract', 'Opens this operation on the APIs page: what it promises, what it needs and what it answers, beside the code that serves it.'),
  'door.spec': same('read the spec file', 'Opens the API description file at the line that declares this operation.'),
  'door.handler': same('open the handler in the editor', 'Opens the code that answers this call in your code editor, at its first line.'),
  'door.schema': same('open the schema in the editor', 'Opens the file that declares this record, at its line, in your code editor.'),
  'door.cases': same('see the cases', 'Opens the Tests page kept to this journey: every case that runs over it, with how each is known and its last run.'),
  'door.testFile': same('open the test file in the editor', 'Opens the file the case is written in, at its line, in your code editor.'),
  'door.work': same('see it on the work board', 'Opens this item on the Work page: its state, who has it and what it changed.'),
  'door.tracker': same('open in the tracker', 'Opens this item in the tracker it comes from, in a new tab.'),
  'door.page': same('see the page on the code map', 'Shows the page that serves this screen on the code map, with the parts it draws.'),
  'door.design': same('open the design file in the editor', 'Opens the design file that declares this screen, in your code editor.'),
  'door.figma': same('open in Figma', 'Opens the frame this screen was designed in, in a new tab.'),
  'door.included': same('see where it is included', 'Opens the code map on the projects and files that bring this package in.'),
  'door.journey': same('open the journey here', 'Opens this journey as its timeline, at this screen, with this part selected when there is one. The same place, the other picture.'),
  'door.map': same('see it on the Map', 'Opens this journey on the Map, its screens in order, with the screen you are on framed. The same place, the other picture.'),
  'key.doors': same('On a detail: open where it is read in full; o opens it in the editor'),
  'door.expand': same('more', 'Opens this detail in place: its code where the reader may read code, and where to read it in full.'),
  'door.codeLoading': same('reading the lines…', 'The code is being read from the file on this machine.'),
  'door.codeNone': same('no lines could be read', 'The file is not on this machine, or the part was found without a span of lines.'),
  'door.codeMore': same('the rest is in the editor', 'Only the first lines are drawn here; the editor door opens the whole part.'),
  // §3.3 — the Map's marks left open by the clarity pass
  'map.cover.mark.stale': same('stale', 'The tests that cover this journey were last run before the code they cover changed. Run them again to know whether it still works.'),
  'map.cover.mark.notBuilt': same('not built', 'At least one screen this journey names is designed and not yet served by a page in the code.'),
  'map.floor.read': same('{n} journeys · zoom in to read', 'So many journeys share the board that their words would be smaller than can be read; the cards keep a smallest size and clip. Zoom in, or band the board, to read them.'),
  'map.floor.scope': same('every journey on this board', 'All the journeys the board draws at this zoom, in every band.'),
};
