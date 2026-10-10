// The Map's five stops and its one layout control (lanes round 2026-10-10, proposal 1): the Map keeps the frame and
// gains the two altitudes only the journey view had — an action's beats, and the code behind a beat. Spread into
// STRINGS in strings.ts. Same rules as the rest of the catalog: both registers, a define on every word, defines in
// plain words.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const STOP_STRINGS: Record<string, StringEntry> = {
  'map.level.act': {
    hud: 'Room',
    professional: 'One action',
    define: 'One thing a person does on a screen, opened into its beats: what the screen did, the call it made, what the service did in turn and what came back, with every layer of the system down the side.',
  },
  'map.level.act.short': { hud: 'Room', professional: 'Action', define: 'Short for one action opened into its beats. The same button as the whole name, on a narrow window.' },
  'map.level.code': {
    hud: 'Blueprint',
    professional: 'Code',
    define: 'The lines behind the beat you are on, opened in the dock beside the beats: its documentation, its code, its forks, its tests and what a change to it touches.',
  },
  'map.level.code.short': { hud: 'Blueprint', professional: 'Code', define: 'Short for the code behind one beat, in the dock. The same button as the whole name, on a narrow window.' },
  'map.layout': same('Layout', 'How the stop you are at is drawn. The choices change with the stop; the lens, the calls and data, and where the code opens stay as they are.'),
  'map.layout.chain': same('chain', 'Every journey as a card, banded, the storyline drawn as a chain in its order.'),
  'map.layout.screens': same('screens', 'One journey as its screens in order, with each screen’s calls and data beneath it when they are shown.'),
  'map.layout.table': same('table', 'One journey as a table: every stop across, every layer of the system down — what the person sees, the calls, the service, the checks, the records and what proves it runs.'),
  'map.layout.beats': same('beats', 'One action as its beats across and the layers of the system down, an arrow from each beat to the next.'),
  'map.layout.ladder': same('ladder', 'One action as a sequence, time running down: the systems it uses as columns, one line per thing it did.'),
  'map.crumb.screen': same('screen {n} of {m}', 'Where this screen stands among the journey’s screens, in the order a person meets them.'),
  'map.crumb.action': same('action {n} of {m}', 'Where this action stands among the things a person does on this screen, in the order the screen’s design lists them.'),
  'map.act.strip': same('the street', 'The journey’s screens in order, small, with the one you are on lit. Click one to open it.'),
  'map.act.hint': same('← → walk the beats · − back to the screen · + opens the code', 'The keys at an action: the arrows move from beat to beat, minus goes back to the screen, plus opens the code behind the beat you are on.'),
  'map.code.hint': same('← → walk the beats · − closes the code', 'The keys with the code open: the arrows move from beat to beat and the code follows, minus closes the code.'),
  'map.act.walk': same('walk its beats', 'Opens this action on the Map, one stop down from the screen: what the screen did, the call, what the service did in turn and what came back.'),
  'map.act.none': same('nothing to walk on this screen', 'The walk met no action on this screen: no call is made from it and nothing it does was found in the code.'),
  'map.act.loading': same('reading the walk…', 'The journey’s walk, part by part, is being read from the server.'),
  'map.dock': same('Where the code opens', 'Where the dock with the code sits: in place under the beats, pinned to the bottom, or on the right. Remembered for this browser, the same as the journey’s.'),
  'map.table.hint': same('Layout · screens draws the street again · click a stop to walk its beats · + opens a screen', 'The journey as a table. Switch the layout back to screens for the street; click a column to open that action’s beats.'),
  'map.head.lifecycle': same('status lifecycle', 'The statuses a record this journey moves goes through, read from the code, with the part of the system that moves it to each.'),
  'export.surface.street': same('Map stop', 'The Map at the stop on screen: one journey’s street, its table, or one action’s beats.'),
  'key.mapBeats': same('Map, at an action: walk its beats; − back to the screen, + opens the code'),
  'key.mapLayout': same('Map: the next layout at this stop'),
};
