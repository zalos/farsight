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
  'map.act.onScreen': same('action {n} of {m} on this screen', 'Where this action stands among the things a person does on this screen — the same count the breadcrumb and the screen strip print. The journey’s stops, which also count an action done again, are the drill’s rail.'),
  'map.act.strip': same('the street', 'The journey’s screens in order, small, with the one you are on lit. Click one to open it.'),
  'map.act.hint': same('← → walk the beats · − back to the screen · + opens the code', 'The keys at an action: the arrows move from beat to beat, minus goes back to the screen, plus opens the code behind the beat you are on.'),
  'map.code.hint': same('← → walk the beats · − closes the code', 'The keys with the code open: the arrows move from beat to beat and the code follows, minus closes the code.'),
  'map.act.walk': same('walk its beats', 'Opens this action on the Map, one stop down from the screen: what the screen did, the call, what the service did in turn and what came back.'),
  'map.act.none': same('nothing to walk on this screen', 'The walk met no action on this screen: no call is made from it and nothing it does was found in the code.'),
  'map.act.loading': same('reading the walk…', 'The journey’s walk, part by part, is being read from the server.'),
  'map.dock': same('Where the code opens', 'Where the dock with the code sits: in place under the beats, pinned to the bottom, or on the right. Remembered for this browser, the same as the journey’s.'),
  'map.table.hint': same('j k walk the parts · d moves the code · click a stop to walk its beats · Layout · screens draws the street again', 'The journey as a table. j and k select the next or previous part, with its code in the dock; d moves the dock; a click on a column opens that action’s beats; switching the layout back to screens draws the street.'),
  'map.head.lifecycle': same('status lifecycle', 'The statuses a record this journey moves goes through, read from the code, with the part of the system that moves it to each.'),
  // ── the chrome that holds still (cleanup pass 2026-10-11, lane P1) ──────────────────────────────────────────
  'map.layout.drill': same('drill', 'The journey’s actions as a rail of numbered stops across the top, the screens spanning them, and the action picked opened into its beats below — the layers of the system down the side. [ and ] move along the rail.'),
  'map.layout.journeyLanes': same('lanes', 'This journey as swimlanes: a lane for the person who does it and one for each store its code writes to, its screens in order as columns, and the record’s moves in the store lane.'),
  'map.layout.one': same('one view', 'This stop is drawn one way: one screen up close, its picture and everything known about it.'),
  'map.rail': same('the actions', 'Every action of the journey as a numbered stop, in the order a person meets them, with the screens above the stops they hold. Click one, or press [ and ], to open it.'),
  'map.view': same('View', 'What the board draws: one storyline or every journey, what the journeys are banded by, and a comparison of two syncs. The same choices as on the board, folded here below it.'),
  'map.view.storyline': same('storyline', 'Draw one storyline, its journeys in order, or every journey.'),
  'map.view.band': same('band by', 'What the board groups the journeys by.'),
  'map.dock.title': same('Dock', 'The column beside the Map where what you open sits: the guided walk, the code behind a beat, a part’s code, what each status means, a comparison of two syncs and a journey’s whole description. The Map beside it shrinks; nothing is drawn over it.'),
  'map.dock.close': same('close this panel', 'Closes the panel on top of the dock. The dock closes when nothing is left in it.'),
  'map.dock.code': same('code', 'The beat you are on, opened: its documentation, its code, its forks, its tests and what a change to it touches.'),
  'map.dock.part': same('part', 'The part of the journey you selected on the table, with its contract or its code.'),
  'map.dock.about': same('about', 'The journey’s whole description, in the words somebody wrote for it.'),
  'map.head.more': same('more ›', 'Opens the rest of the journey’s description in the dock.'),
  'map.head.title': same('the journey', 'The journey you are in: its name, who it is for, where it stands in its storyline, its numbers, the statuses its records go through and the first sentence of what it is for. It stays put above the stage at every stop below the board.'),
  'map.head.lcMeans': same('what each one means ›', 'Opens the table of every status in the dock: the word people use, the name in the code, and what in the app moves a record into it.'),
  'map.head.foldMore': same('+{n}', 'More of this journey’s numbers than fit on the line. Each one is listed here; widen the window to see them on the line.'),
  'tour.more': same('more ›', 'The rest of what somebody wrote for this screen.'),
  'tour.less': same('‹ less', 'Back to the first two sentences.'),
  'export.surface.street': same('Map stop', 'The Map at the stop on screen: one journey’s street, its table, or one action’s beats.'),
  'key.mapBeats': same('Map, at an action: walk its beats; − back to the screen, + opens the code'),
  'key.mapLayout': same('Map: the next layout at this stop'),
};
