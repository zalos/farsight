// The Map surface's words (docs/proposals/map-view.md): `#/map`, the zoomable
// board of journeys — neighbourhood, street, property. Spread into STRINGS in
// strings.ts like strings-work-hud.ts. Same rules as the rest of the catalog:
// both registers, a define on every word a reader may not know, defines in
// plain words (no backticks, no markdown, no dotted identifiers, no
// placeholders). Two lanes write here: lane A's block (the surface, the canvas
// and the street) and lane B's block (the property) below it.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const MAP_STRINGS: Record<string, StringEntry> = {
  // §A — surface, canvas, street (lane A)
  'nav.map': {
    hud: 'Atlas',
    professional: 'Map',
    define: 'Every journey drawn on one board you can zoom like a whiteboard: all journeys side by side, one journey’s screens in order with the calls they make, then one screen up close.',
  },
  'map.level.nb': {
    hud: 'Neighbourhood',
    professional: 'All journeys',
    define: 'The board zoomed out: every journey as one block with its name, its sentence and its numbers, and the shape of its screens showing through underneath. Click one or zoom in to walk it.',
  },
  'map.level.st': {
    hud: 'Street',
    professional: 'One journey',
    define: 'One journey’s screens in the order a person meets them. With the calls and data shown, each screen has its own path down: the calls it makes, and what each call reads and writes.',
  },
  'map.level.pr': {
    hud: 'Property',
    professional: 'One screen',
    define: 'One screen up close: its picture as designed, and everything Farsight knows about it. Zoom out or press Esc to go back to its journey.',
  },
  'map.levels': same('Zoom level', 'Which of the three heights the board is at. Each button goes there.'),
  'map.crumb.root': same('Journeys'),
  'map.loading': same('loading the journeys…', 'The board has asked the server for the journeys the design manifests name and has no answer yet. This is not an empty result.'),
  'map.failed': {
    hud: 'Could not load the journeys for the map.',
    professional: 'Could not load the journeys for the map.',
    invariant: true,
    define: 'The request did not return an answer. Nothing on the board is measured, and no absence shown here is a fact about the application.',
  },
  'map.empty': same('No journey is declared in this workspace’s design manifests.',
    'The map draws the journeys a design manifest names, in the order it names their screens. A workspace without one has nothing to draw here; the Journeys surface still walks the code from its entry points.'),

  // the board's tools
  'map.tool.plumb': {
    hud: 'Plumbing',
    professional: 'Calls and data',
    define: 'Show under each screen the calls it makes, stacked in order with the colour of the service each one reaches, and beside each call the records, messages and third parties it reads and writes. Press p to switch.',
  },
  'map.tool.lens': same('Lens', 'Switch the words between the business register, which shows only what people wrote and never an identifier, and hybrid, which adds the code’s names. Press the lens buttons in the top bar for the code lens.'),
  'map.tool.zoomIn': same('Zoom in', 'Zoom in about the middle of the board. The plus key does the same.'),
  'map.tool.zoomOut': same('Zoom out', 'Zoom out about the middle of the board. The minus key does the same.'),
  'map.tool.fit': same('Fit', 'Zoom out until every journey fits on the screen. The zero key does the same.'),
  'map.tool.full': same('Full screen', 'Give the board the whole screen. The controls stay; Esc or this button gives it back.'),
  'map.zoom': same('zoom', 'How far the board is zoomed in: 1 is the size a screen is drawn at on its street. Below 0.5 the board shows all journeys; from 1.6 a screen near the middle opens when a zoom ends. This is the board’s scale, not a count of anything.'),

  // hints along the bottom edge
  'map.hint.nb': same('Click a journey, or zoom in, to walk its screens'),
  'map.hint.st': same('Click a screen to open it · p shows the calls and data under each screen'),
  'map.hint.near': same('Zoom in to open {name}'),
  'map.hint.pr': same('Esc or zoom out to go back to the journey'),

  // a district at the neighbourhood level
  'map.cover.loading': same('reading this journey…', 'Its screens and numbers arrive from the journey walk, one journey at a time. Nothing here is missing yet; it has not been read.'),
  'map.cover.failed': same('could not read this journey', 'The walk of this journey did not return an answer, so the board prints none of its numbers rather than zeros.'),
  'map.cover.enter': {
    hud: 'Walk the street',
    professional: 'Open this journey',
    define: 'Zoom into this journey: its screens in order, each with what it does.',
  },

  // a screen on the street
  'map.screen.ordinal': same('step', 'This screen’s place in the journey, counting from the first screen a person meets. A position, not a count.'),
  'map.screen.planned': same('designed, not built', 'A design manifest names this screen and no page in the code serves its route yet.'),
  'map.screen.open': same('Open this screen'),
  'map.then': same('then', 'The next screen in the order the journey’s design names them.'),

  // the plumbing under each screen
  'map.lane.title': same('What each screen does · its calls, then what they read and write',
    'Each screen owns the path straight below it. The same record is drawn under every screen that uses it, so nothing crosses; the journey’s own numbers still count it once.'),
  'map.lane.reads': same('reads', 'This call reads the record, or listens to the message. Drawn in the cool colour.'),
  'map.lane.writes': same('writes', 'This call writes the record, publishes the message or sends a request to the third party. Drawn in the warm colour.'),
  'map.lane.both': same('reads · writes', 'This call both reads and writes the record.'),
  'map.lane.noService': same('no service named', 'The walk reached this call without an API the workspace names, so it has no service colour.'),
  'map.call.again': same('again', 'The journey already made this call on an earlier screen. It is drawn here too because this screen makes it as well.'),

  // evidence on a call — the APIs surface’s classes, and the two absences
  'map.ev.specBacked': same('spec-backed', 'The API’s spec declares this operation and the code implements it.'),
  'map.ev.implied': same('implied', 'The code serves this route and no spec on file declares it, so what it accepts and returns is read from the code alone.'),
  'map.ev.declared': same('declared, not called', 'This screen’s design names the operation and no code on the screen calls it. It is drawn dashed, with nothing beside it, because nothing was walked.'),

  // kinds, as the plumbing and the explore card name them
  'map.kind.call': same('call'),
  'map.kind.record': same('record', 'A table or collection the application keeps.'),
  'map.kind.message': same('message', 'An event or a queue message: one part publishes it, others listen.'),
  'map.kind.external': same('third party', 'A system outside the application that the code calls, such as an ERP or a document reader.'),

  // links between districts
  'map.link.leadsTo': same('leads to', 'A person who finishes this journey goes on to the next one, as the design says or as their shared screens show.'),
  'map.link.partOf': same('part of', 'Every screen of the smaller journey is also a screen of the larger one.'),

  // the explore card
  'map.card.close': same('Close'),
  'map.card.on': same('on', 'The screens of this journey this call or record is drawn under. Each one opens that screen.'),
  'map.card.onNone': same('on no screen of this journey'),
  'map.card.openApis': same('Open on APIs'),
  'map.card.openCode': same('Open on the code map'),
  'map.card.handler': same('handled by'),

  // the property, until its own view answers
  'map.prop.back': same('Back to the journey'),
  'map.prop.loading': same('opening this screen…'),
  'map.prop.prev': same('Previous screen'),
  'map.prop.next': same('Next screen'),

  // the door from the Portfolio, and the switch
  'map.portfolio.view': same('View', 'The same journeys as a table, or drawn on the map.'),
  'map.portfolio.table': same('Table', 'One row per journey, with what is built, declared, tested and linked.'),

  // Settings → Experiments
  'set.flagMap': same('Map of journeys'),
  'set.flagMapSub': same('adds a MAP tab and a Map button on the Portfolio — every journey on one zoomable board, its screens in order with the calls and data under each; off by default, per workspace'),

  // the keymap panel
  'key.mapPlumb': same('Map: show or hide the calls and data under each screen'),
  'key.mapZoom': same('Map: zoom in, zoom out, fit every journey'),
  'key.mapStep': same('Map: previous or next screen of the open screen’s journey'),
};
