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

  // §B — property (lane B)
  'map.prop.level': {
    hud: 'Property',
    professional: 'One screen',
    define: 'One screen of a journey up close: the picture of it, what it asks the services for, what stands in front of it, what proves it runs, and the screens before and after it.',
  },
  'map.prop.back': {
    hud: 'Back to the street',
    professional: 'Back to the journey',
    define: 'Close this screen and return to the whole journey, centred on the screen you were looking at.',
  },
  'map.prop.crumb': same('Journeys', 'Every journey in the workspace. The trail reads from all journeys, to this one, to this screen.'),
  'map.prop.tabs': same('About this screen', 'What the rail beside the picture can show about this one screen, one subject per tab.'),

  // the rail's eight tabs — HUD words, each with what it shows
  'map.prop.tab.overview': same('Overview', 'This screen in a few lines: what the user does here, the counts at a glance, the calls it makes, what stands in front of it and the work that touched it.'),
  'map.prop.tab.gates': { hud: 'Gates', professional: 'Gates & rules', define: 'The guards that decide who may get through and the rules that check what they send, met on this screen, with the decisions somebody wrote down.' },
  'map.prop.tab.apis': same('APIs', 'Every call this screen makes to a service, in the order the user meets them: which service, what it is for, how sure the graph is of it, and which records it reads or writes.'),
  'map.prop.tab.ux': same('UX', 'What the user sees: the page, the components on it, and the stories that draw those components on their own.'),
  'map.prop.tab.tests': same('Tests', 'What proves this screen runs: the cases that reach it, whether a run named them, and when that run was.'),
  'map.prop.tab.route': same('Route', 'Where this screen lives: its address in the app, whether it is built or only designed, where it is declared, and the other ways a user arrives at it.'),
  'map.prop.tab.work': same('Work', 'Work items from the connected trackers that name this screen, and what the trackers and the code disagree about.'),
  'map.prop.tab.changes': same('Changes', 'What changed in the parts of this screen between the latest sync and the one before it.'),

  // hero
  'map.prop.hero.open': same('open the picture larger', 'Show the design picture of this screen at full size.'),
  'map.prop.ph.head': same('No picture of this screen', 'The design names this screen but Farsight has no picture of it to show: either none is declared, or the one declared could not be fetched.'),
  'map.prop.ph.parts': same('Parts found', 'The page and the components the code draws on this screen, as far as the graph found them.'),
  'map.prop.ph.noParts': same('no components found', 'The graph found no page or component in the code for this screen. A screen that is designed and not built has none yet.'),

  // overview
  'map.prop.ov.what': { hud: 'What the user does here', professional: 'What the user does here', define: 'The sentence somebody wrote for this screen, in the design or in the code. Nothing is made up when nobody wrote one.' },
  'map.prop.ov.glance': same('At a glance', 'The counts for this screen alone. Each one names what it counts when you open it.'),
  'map.prop.ov.calls': { hud: 'Asks the service for', professional: 'Calls', define: 'The calls this screen makes to a service, by what each is for.' },
  'map.prop.ov.gates': { hud: 'Stands behind', professional: 'Gates and rules', define: 'The guards and rules a request from this screen has to pass.' },
  'map.prop.ov.work': same('Work that names it', 'Work items whose links name this screen. Asked of the trackers only when a work source is connected.'),
  'map.prop.ov.more': same('see all', 'Open the tab that lists every one of these.'),

  // gates
  'map.prop.gates.head': same('Guards and rules on this screen', 'Each checkpoint a request from this screen meets, in the order the walk met it, with how many times.'),
  'map.prop.gates.decisions': same('Decisions somebody wrote down', 'The branches in the code that carry a sentence a person wrote, saying what happens on each side.'),
  'map.prop.gates.mute': same('{n} more that nobody put in plain words', 'Checkpoints on this screen whose only name is the code’s own. They are counted here and named in the hybrid and code lenses.'),
  'map.prop.kind.guard': same('guard', 'A check on who may get through: a session, a scope, a role.'),
  'map.prop.kind.rule': same('rule', 'A check on what is sent: a schema or a validation the request must satisfy.'),
  'map.prop.planned': same('planned', 'Declared by the design or the specification and not found in the code yet.'),
  'map.prop.times': same('×{n}', 'How many times the walk of this screen met this same checkpoint.'),

  // apis
  'map.prop.apis.head': same('Calls this screen makes', 'Every call to a service on this screen, in the order the user meets them.'),
  'map.prop.apis.records': same('Records this screen reaches', 'The stored records the calls on this screen read or write, each named once.'),
  'map.prop.apis.reads': same('reads {list}', 'The records this call looks up.'),
  'map.prop.apis.writes': same('writes {list}', 'The records this call saves to.'),
  'map.prop.apis.readsWrites': same('reads and writes', 'The calls on this screen both look this record up and save to it.'),
  'map.prop.apis.noData': same('reaches no record', 'The walk found no stored record behind this call.'),
  'map.prop.apis.notBuilt': same('Not built: the design declares these calls and no code makes them yet.', 'The screen is designed and not built, so its calls are what the design says it will ask for.'),
  'map.prop.ev.declared': same('declared, never called', 'The design says this screen uses this operation and the built code on it never calls it.'),
  'map.prop.apis.repeat': same('again', 'The same call as one made earlier on this screen, drawn once.'),
  'map.prop.apis.noService': same('no service named', 'The call reaches a route no specification or service in the graph claims.'),
  'map.prop.ev.specBacked': same('spec-backed', 'The call’s route is declared in a specification and found in the code.'),
  'map.prop.ev.implied': same('implied', 'The code serves this route and no specification on file declares it.'),

  // ux
  'map.prop.ux.page': same('Page', 'The screen as the code routes to it.'),
  'map.prop.ux.components': same('Components on this screen', 'The components the page draws, as the walk of this screen met them.'),
  'map.prop.ux.stories': same('Stories', 'Stories that draw a part of this screen on its own, live from the team’s Storybook.'),
  'map.prop.ux.noPage': same('no page in the code for this route', 'The design names this screen and the code has no page at its address yet.'),
  'map.prop.kind.page': same('page', 'A screen the app routes to.'),
  'map.prop.kind.component': same('component', 'A part of a screen that the code draws.'),

  // tests
  'map.prop.tests.head': same('What proves this screen runs', 'The evidence for this screen alone: the word the fold chose, the run behind it and the counts of cases.'),
  'map.prop.tests.cases': same('Cases that reach it', 'The test cases whose walk reaches a part of this screen, with what each one last said.'),
  'map.prop.tests.verifiedNote': same('Verified means a results report named a case that ran over these parts. A coverage report alone reads as seen by a coverage run.', 'The difference between a case a run named and a line a coverage run touched.'),
  'map.prop.tests.reports': same('Coverage runs that name no case', 'Reports of a whole run that touched this screen’s code without naming which case did. They are counted apart from the cases.'),
  'map.prop.tests.byRun': same('named by a run', 'A results report named this case and it ran.'),
  'map.prop.tests.byDeclaration': same('passed, declared here', 'This case declares the screen it covers and its last run passed.'),
  'map.prop.tests.reached': same('reaches it', 'The walk from this case reaches a part of this screen; no run named it.'),

  // route
  'map.prop.route.head': same('Address', 'Where the app puts this screen.'),
  'map.prop.route.declaredIn': same('declared in {file}', 'The design or specification file that names this screen.'),
  'map.prop.route.codeAt': same('routed in {file}', 'The place in the code that sends a user to this screen.'),
  'map.prop.route.noCode': same('no page in the code yet', 'Nothing in the indexed code routes to this screen.'),
  'map.prop.route.ways': same('Other ways in', 'Other parts of the app that lead a user to this screen, besides the journey you came along.'),
  'map.prop.route.journeys': same('This journey and its neighbours', 'The journeys this one needs first, leads to, or is part of.'),
  'map.prop.route.links': same('References', 'Links to the design and the documents written about this screen.'),

  // work
  'map.prop.work.head': same('Work items that name this screen', 'Items from the connected trackers linked to this screen’s page, as of the last sync.'),
  'map.prop.work.findings': same('Findings', 'What a tracker says about this screen that the code does not bear out, with both sides.'),
  'map.prop.work.noSource': same('No work source is connected, so no tracker was asked.', 'A work source is added in the workspace settings; until then nothing here is a fact about the work.'),
  'map.prop.work.failed': same('The trackers’ cache did not answer.', 'The request for this screen’s work items failed. Nothing here is a fact about the work.'),

  // changes
  'map.prop.changes.head': same('What changed in this screen’s parts', 'Changes the latest sync measured against the one before it, kept to the page, its components and the handlers its calls reach.'),
  'map.prop.changes.range': same('sync {base} to sync {head}', 'The two syncs compared: the older one first.'),
  'map.prop.changes.noEarlier': same('no earlier sync to compare against', 'Only one sync of this source has been recorded, so there is nothing to measure a change against.'),
  'map.prop.changes.noHistory': same('history is not kept on this server', 'This server has no snapshot store, so no change can be measured.'),
  'map.prop.changes.none': same('nothing on this screen changed between these syncs', 'The comparison ran and none of its changes is to a part of this screen.'),
  'map.prop.changes.failed': same('The comparison did not answer.', 'The request for the changes failed. Nothing here is a fact about the code.'),
  'map.prop.loading': same('asking…', 'The page has asked the server and has no answer yet. This is not an empty result.'),

  // step bar
  'map.prop.foot.before': same('Before this', 'The screen the user sees just before this one in the journey.'),
  'map.prop.foot.after': same('After this', 'The screen the user sees next in the journey.'),
  'map.prop.foot.start': same('start of the journey', 'Nothing comes before this screen in the journey.'),
  'map.prop.foot.end': same('end of the journey', 'Nothing comes after this screen in the journey.'),
  'map.prop.foot.step': same('screen {n} of {m} in {journey}', 'Where this screen sits in the journey, counting its screens in order.'),
  'map.prop.foot.alsoIn': same('also in', 'Other journeys that show this same screen. Open one to see the screen in that journey.'),
  'map.prop.foot.go': same('open this screen', 'Go to this screen of the journey.'),
};
