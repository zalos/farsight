// The Map surface's words (docs/proposals/map-view.md): `#/map`, the zoomable
// board of journeys — neighbourhood, street, property. Spread into STRINGS in
// strings.ts like strings-work-hud.ts. Same rules as the rest of the catalog:
// both registers, a define on every word a reader may not know, defines in
// plain words (no backticks, no markdown, no dotted identifiers, no
// placeholders). Lanes write here in blocks: lane A's (the surface, the canvas
// and the street), lane B's (the property) below it, then the map pass's lettered blocks (§L: the legend, the
// links, the business words).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

// §N — defines shared by a plural and its singular, word for word
const SCREENS_REACHED = 'Of the screens this journey names, how many the walk through the code reached, starting at its first screen and following what each screen leads to. A screen met twice is one screen. The ones it did not reach are still named; they are counted apart, as not reached.';
const PART_REACHED = 'Named screens the walk through the code reached. With the ones not reached, they add up to the screens the journey names.';
const PART_NOT_REACHED = 'Named screens the walk through the code did not get to: a screen nothing on the way leads to, or one not built yet.';
const COMMITS = 'The application’s commits, each once, that changed this screen’s page, a component it draws or a handler its calls reach, among the commits read for this source. A count of commits, not of lines or files.';
const PART_LINES = 'Commits whose diff changed lines inside one of these parts.';
const PART_FILE = 'Commits that changed the file one of these parts lives in, where the lines were not resolved to parts.';

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
    define: 'The board zoomed out: every journey as one card with its name, how far it is built, whether it is at risk and how many journeys it leads to, in a panel per band. Click one or zoom in to walk it; its sentence and all its numbers are in its header there.',
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
  'map.levels': same('Zoom level', 'Which of the five stops the Map is at — every journey, one journey, one screen, one action, the code behind it. Each button goes there.'),
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
  'map.tool.zoomIn': same('Zoom in', 'Zoom in to the next stop: from all journeys to one journey fitted, then to where its calls and data read, then to one screen large enough to enter. When the hint says a screen can be entered, this enters it. The plus key does the same.'),
  'map.tool.zoomOut': same('Zoom out', 'Zoom out to the previous stop. From inside a journey it stops at that journey fitted before it goes out to all journeys. The minus key does the same.'),
  'map.tool.fit': same('Fit', 'Fit what is in view: the journey you are on, with its calls and data when they are shown, or every journey when you are looking at all of them. The zero key does the same.'),
  'map.tool.full': same('Full screen', 'Give the board the whole screen. The controls stay; Esc or this button gives it back.'),
  'map.zoom': same('zoom', 'How far the board is zoomed in: 1 is the size a screen is drawn at on its street. Below 0.5 the board shows all journeys. Zooming stops at all journeys, one journey fitted, its calls readable and one screen large; a screen opens only when the hint has said so and you zoom in again. This is the board’s scale, not a count of anything.'),

  // hints along the bottom edge
  'map.hint.nb': same('Click a journey, or zoom in, to walk its screens'),
  'map.hint.st': same('Click a screen to open it · p shows the calls and data under each screen'),
  'map.hint.near': same('Zoom in again to enter {name}'),
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
  'map.screen.ordinal': same('screen', 'This screen’s place in the journey, counting from the first screen a person meets. A position, not a count.'),
  'map.screen.planned': same('designed, not built', 'A design manifest names this screen and no page in the code serves its route yet.'),
  'map.screen.open': same('Open this screen'),
  'map.then': same('then', 'The next screen in the order the journey’s design names them.'),

  // the plumbing under each screen
  'map.lane.title': same('What each screen does · its calls, then what they read and write',
    'Each screen owns the path straight below it. The same record is drawn under every screen that uses it, so nothing crosses; the journey’s own numbers still count it once.'),
  'map.lane.reads': same('reads', 'This call looks up the record or the store, or listens to the message. Drawn in the cool colour.'),
  'map.lane.writes': same('writes', 'This call saves to the record or the store, or publishes the message. Drawn in the warm colour.'),
  'map.lane.both': same('reads · writes', 'This call both looks up and saves to the record or the store.'),
  'map.lane.noService': same('no service named', 'The walk reached this call without an API the workspace names, so it has no service colour.'),
  'map.call.again': same('again', 'The journey already made this call on an earlier screen. It is drawn here too because this screen makes it as well.'),

  // evidence on a call — the APIs surface’s classes, and the two absences
  'map.ev.specBacked': same('spec-backed', 'The API’s spec declares this operation and the code implements it.'),
  'map.ev.implied': same('implied', 'The code serves this route and no spec on file declares it, so what it accepts and returns is read from the code alone.'),
  'map.ev.declared': same('declared, not called', 'This screen’s design names the operation and no code on the screen calls it. It is drawn dashed, with nothing beside it, because nothing was walked.'),

  // kinds, as the plumbing and the explore card name them
  'map.kind.call': same('call'),
  'map.kind.record': same('record', 'A table or collection the application keeps.'),
  'map.mode.reached': same('reached', 'The code reaches this, but which way the data flows was not recorded: the call does not say in plain code whether it looks something up or saves it. Drawn as a plain dim line.'),
  'map.kind.message': same('message', 'An event or a queue message: one part publishes it, others listen.'),
  'map.kind.external': same('third party', 'A system outside the application that the code calls, such as a document reader. One the application keeps its data in, such as an ERP, is drawn as a store instead.'),

  // data stores (docs/proposals/data-stores.md): which store a record lives in, and outside systems used as stores
  'map.store.legend': same('stores', 'The data stores this journey’s calls reach: the databases its records live in and the outside systems it keeps data in, each with its colour.'),
  'map.store.kind.sql': same('database', 'A database the application keeps its records in as tables.'),
  'map.store.kind.document': same('document store', 'A database that keeps records as documents rather than tables.'),
  'map.store.kind.files': same('file store', 'A place the application keeps files, such as uploaded documents.'),
  'map.store.kind.erp': same('ERP', 'A business system outside the application, such as an accounting or resource planning system, that the application reads from and saves to as its own store of record.'),
  'map.store.kind.other': same('store', 'Somewhere the application keeps data, of a kind not named more precisely.'),
  'map.store.known': same('known from', 'How the store was found: the code first, the workspace settings only where the code says nothing.'),
  'map.store.via.factory': same('the table’s own declaration', 'The table was declared with a helper that belongs to one database engine, so the code itself names the store.'),
  'map.store.via.sdk': same('the package the code uses', 'The code uses a package that belongs to this store: the one database driver in this source, so every table in it lives in that database, or an outside system’s own client library.'),
  'map.store.via.datasource': same('the schema file’s data source', 'The data source block of the schema file names the database engine.'),
  'map.store.via.jpa': same('the application’s data source setting', 'The application’s settings name the database connection, and the engine is read from it.'),
  'map.store.via.config': same('the workspace settings', 'The code does not name this store; the workspace’s Farsight settings do.'),

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
  'map.portfolio.board': same('Board', 'The same journeys drawn side by side on the map: each journey a block you can zoom into, its screens in order with the calls and data under each.'),

  // Settings → Experiments
  'set.flagMap': same('Map of journeys'),
  'set.flagMapSub': same('adds a MAP tab and a Board button on the Portfolio — every journey on one zoomable board, its screens in order with the calls and data under each; off by default, per workspace'),

  // the keymap panel
  'key.mapPlumb': same('Map: show or hide the calls and data under each screen'),
  'key.mapZoom': same('Map: zoom in or out to the next stop; fit the journey in view, or every journey from the board'),
  'key.mapStep': same('Map: previous or next screen of the open screen’s journey'),

  // the street's folds: a call's data beyond its first three, a screen's calls beyond its first four
  'map.fold.data': same('{n} more', 'The rest of what this call reads and writes, folded so the pathway stays short. Writes are drawn first, so what is folded is reads. Open it to draw them all here; the journey’s own counts never change.'),
  'map.fold.calls': same('{n} more calls', 'The rest of the calls this screen makes, folded so its pathway stays short. Open it to draw them all here, in order.'),
  'map.fold.less': same('fewer', 'Fold this call’s records, messages and third parties back to its first three.'),
  'map.fold.lessCalls': same('fewer calls', 'Fold this screen’s calls back to its first four.'),
  'map.fold.scopeCall': same('this call', 'One call on one screen of this journey.'),
  'map.fold.scopeScreen': same('this screen', 'One screen of this journey.'),

  // §L — the legend, the lines between journeys, whole words, and the business lens on the map (lane L)
  'map.tool.legend': same('Legend', 'What the lines, colours, stripes and marks on the board mean. It stays closed until you ask: this button or the g key opens and closes it.'),
  'map.legend.title': same('What the board draws', 'Every line, colour, stripe and mark the map uses, with the word it stands for. Only what is on this board is listed.'),
  'map.legend.close': same('Close the legend'),
  'map.legend.expand': same('show', 'Open the legend in full: every line, colour and mark this board draws, with its word.'),
  'map.legend.between': same('Between journeys', 'The lines that join one journey to another. Each journey says which journeys it needs first, leads to, or is part of; the board draws what they say and infers nothing.'),
  'map.legend.requires': same('the journey at the point needs the one at the tail first',
    'A journey that requires another is drawn as the other leading to it, once. Read the arrow backwards for requires.'),
  'map.legend.under': same('Under each screen', 'With the calls and data shown, each screen has its calls stacked below it, and beside each call what it reads and writes.'),
  'map.legend.both': same('reads and writes', 'This call both looks up and saves to the record or the store. The line carries an arrowhead at each end.'),
  'map.legend.screens': same('On a screen', 'The marks on a screen card and on its calls.'),
  'map.legend.built': same('built', 'A screen the design names and a page in the code serves. Its left stripe is green.'),
  'map.legend.againSay': same('made on an earlier screen too', 'The journey made this same call on a screen before this one; it is drawn again under every screen that makes it.'),
  'map.legend.times': same('×n', 'A checkpoint met more than once on one screen is listed once, with the number of times beside it.'),
  'map.legend.timesSay': same('met this many times on one screen', 'Shown beside a gate or rule in a screen’s list, instead of listing it again.'),
  'map.legend.evidence': same('What proves a journey runs', 'The word each journey’s tests earned: a case a run named, a case that declares what it covers and passed, or a coverage run alone. The words are the Tests page’s.'),
  'map.legend.hint': same('The legend button or the g key opens and closes this; ? shows every key.'),
  'map.link.requires': same('requires', 'This journey needs the other one finished first. Drawn as the other journey leading to this one.'),
  'map.link.both': same('lead to each other', 'Each of the two journeys says it leads to the other, so the line carries an arrowhead at each end and one label.'),
  'map.cover.more': same('+{n}', 'More numbers about this journey, folded so the cover stays readable. Zoom in to see them all in the journey’s header.'),
  'map.cover.moreOf': same('numbers on this cover', 'The numbers a journey’s cover would print if it had room.'),
  'map.fold.scopeJourney': same('this journey', 'One journey on the board.'),
  // the business lens: a data node’s kind in plain words, a checkpoint as a check or a rule
  'map.biz.kind.sql': same('database record', 'Information the application keeps in a database, such as a table of invoices.'),
  'map.biz.kind.document': same('stored document', 'Information the application keeps as a document in a database.'),
  'map.biz.kind.files': same('file', 'A file the application keeps, such as an uploaded document.'),
  'map.biz.kind.erp': same('ERP record', 'Information the application keeps in a business system outside it, such as an accounting system.'),
  'map.biz.kind.other': same('stored record', 'Information the application keeps somewhere.'),
  'map.biz.kind.record': same('stored record', 'Information the application keeps, such as a list of invoices.'),
  'map.biz.kind.message': same('notice', 'A notice one part of the application sends and others act on, such as invoice finalized.'),
  'map.biz.kind.external': same('outside system', 'A system outside the application that it asks for something, such as a document reader.'),
  'map.biz.check': same('check', 'A check on who may get through: being signed in, or holding the right permission.'),
  'map.biz.rule': same('rule', 'A rule about what may be sent: what a form must contain before it is accepted.'),
  'map.prop.timesSame': same('×{n}', 'How many times this screen meets a checkpoint said in these words, added over every checkpoint the code names this way.'),

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
  'map.prop.tab.changes': same('Changes', 'The application’s commits that changed this screen’s parts, newest first; then, labelled apart, what the index measured between the latest sync and the one before it.'),

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
  'map.prop.gates.head': same('Checks and rules on this screen', 'Each checkpoint a request from this screen meets, in the order the walk met it, with how many times: a check on who may get through, a rule on what may be sent.'),
  'map.prop.gates.decisions': same('Decisions somebody wrote down', 'The branches in the code that carry a sentence a person wrote, saying what happens on each side.'),
  'map.prop.gates.mute': same('{n} more that nobody put in plain words', 'Checkpoints on this screen whose only name is the code’s own. They are counted here and named in the hybrid and code lenses.'),
  'map.prop.kind.guard': same('guard', 'A check on who may get through: a session, a scope, a role.'),
  'map.prop.kind.rule': same('rule', 'A check on what is sent: a schema or a validation the request must satisfy.'),
  'map.prop.planned': same('planned', 'Declared by the design or the specification and not found in the code yet.'),
  'map.prop.times': same('×{n}', 'How many times the walk of this screen met this same checkpoint.'),

  // apis
  'map.prop.apis.head': same('Calls this screen makes', 'Every call to a service on this screen, in the order the user meets them.'),
  'map.prop.apis.records': same('Data this screen reaches', 'The records and stores the calls on this screen look up or save to, each named once and grouped by the store it lives in.'),
  'map.prop.apis.reads': same('reads {list}', 'The records this call looks up.'),
  'map.prop.apis.writes': same('writes {list}', 'The records this call saves to.'),
  'map.prop.apis.reached': same('reaches {list}', 'The records and stores this call reaches without the code saying which way the data flows.'),
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
  'map.prop.tests.cases': same('Cases that run over this screen', 'The test cases whose walk reaches a part of this screen on this journey, with what each one last said. Not the Affected count: that one counts tests reaching what uses a thing picked, within the distance chosen.'),
  'map.prop.tests.verifiedNote': same('Verified means a results report named a case that ran over these parts. A coverage report alone reads as seen by a coverage run.', 'The difference between a case a run named and a line a coverage run touched.'),
  'map.prop.tests.reports': same('Coverage runs that name no case', 'Reports of a whole run that touched this screen’s code without naming which case did. They are counted apart from the cases.'),
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
  'map.prop.changes.head': same('What the index changed', 'Not commits: what the latest sync’s reading of the code measured against the sync before it — a part added, removed or moved, an edge whose confidence changed — kept to the page, its components and the handlers its calls reach.'),
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
  'map.prop.foot.step': same('screen {n} of {m} reached · {journey}', 'Where this screen sits among the screens the walk through the code reached, in the order a person meets them. The journey’s design may name more screens than the walk reached; when it does, the line below says how many.'),
  'map.prop.foot.alsoIn': same('also in', 'Other journeys that show this same screen. Open one to see the screen in that journey.'),
  // long lists and long texts on a real screen
  'map.prop.more': same('more', 'Show the rest of what was written here, in place.'),
  'map.prop.less': same('less', 'Show only the first sentences again.'),
  'map.prop.showAll': same('show all {n}', 'The list shows its first ten rows; this opens every row in place.'),
  'map.prop.showFewer': same('show the first {n} only', 'Fold the list back to its first rows.'),
  'map.prop.listRows': same('{n} rows', 'The rows of this list for this screen, each one shown once it is opened.'),
  'map.prop.storiesFold': same('{n} stories on {m} parts', 'The parts of this screen that have stories of their own, folded into one chip. Open it to see each part with its stories.'),
  'map.prop.storiesN': same('{n} stories', 'Stories that draw a part of this screen on its own, added up over the parts that have any.'),
  'map.prop.storyParts': same('{n} parts', 'Parts of this screen, the page or a component it draws, that have at least one story.'),
  'map.prop.storiesLess': same('fewer', 'Fold the parts with stories back into one chip.'),
  'map.prop.alsoMore': same('{n} more', 'More journeys show this same screen; this opens them in place.'),
  'map.prop.alsoN': same('{n} journeys', 'Other journeys whose screens include this one, beyond the three shown.'),
  'map.prop.foot.go': same('open this screen', 'Go to this screen of the journey.'),

  // §N — one number, one word (lane N, docs/proposals/map-pass-2026-10-03.md): every count on the
  // Map says its unit and its scope, tests travel with their evidence word, the cover names the owner
  // and the ERP reach, and the Changes tab reads the application's commits before the index's facts.
  'count.unit.screensReached': same('{n} reached', SCREENS_REACHED),
  'count.unit.screensReachedOne': same('1 reached', SCREENS_REACHED),
  'count.part.screensReached': same('{n} reached by the walk through the code', PART_REACHED),
  'count.part.screensReachedOne': same('1 reached by the walk through the code', PART_REACHED),
  'count.part.screensNotReached': same('{n} not reached', PART_NOT_REACHED),
  'count.part.screensNotReachedOne': same('1 not reached', PART_NOT_REACHED),
  'map.prop.foot.declared': same('{n} declared, {k} not reached', 'The screens this journey’s design names, reached or not, and how many of them the walk through the code did not reach. The tip on the second number names each one with why: not reached, or not built.'),
  'map.cover.owner': same('owner · {owner}', 'Who owns this journey, as its design manifest says — the same name the Portfolio prints in its Owner column. Absent when the manifest names nobody.'),
  'map.cover.erp': same('reaches the ERP · {via}', 'The walk of this journey reaches an outside system the code or the settings name as an ERP. The Portfolio’s column of the same name says the same.'),
  'map.cover.erpDeclared': same('ERP hand-off declared, not built', 'The contract declares an approval or a posting call for this journey that no code implements yet — the hand-off to the ERP is planned, not built. The Portfolio says declared in the spec, not built.'),
  'map.prop.changes.commits': same('Commits that touched this screen’s parts', 'The application’s own commits, newest first, that changed the page, one of its components or a handler its calls reach — read from the commit history Farsight keeps for this source.'),
  'map.prop.changes.countCommits': same('{n} commits', COMMITS),
  'map.prop.changes.countCommitsOne': same('1 commit', COMMITS),
  'count.part.commitLines': same('{n} changed lines inside a part', PART_LINES),
  'count.part.commitLinesOne': same('1 changed lines inside a part', PART_LINES),
  'count.part.commitFile': same('{n} changed a part’s file', PART_FILE),
  'count.part.commitFileOne': same('1 changed a part’s file', PART_FILE),
  'map.prop.changes.how.lines': same('these lines', 'The commit changed lines inside this part, read from its diff.'),
  'map.prop.changes.how.file': same('its file', 'The commit changed the file this part lives in. Which lines it changed is resolved to parts only for commits that name a work item, so this one is matched by its file.'),
  'map.prop.changes.notRead': same('no commit history has been read for this source', 'A sync reads the source’s commits when it is a git checkout. None has been read for this one, so no commit can be shown — not that none exists.'),
  'map.prop.changes.noCommit': same('no commit read touched these parts', 'The commits read for this source were searched, and none changed the page, its components or the handlers its calls reach.'),
  'map.prop.changes.commitsFailed': same('The commit history did not answer.', 'The request for this screen’s commits failed. Nothing here is a fact about the code.'),
  'map.prop.changes.by': same('by {author}', 'Who made the commit, as git recorded it.'),
  'map.prop.changes.partsMore': same('{n} more parts', 'Other parts of this screen the same commit changed, beyond the three named.'),
  'map.prop.changes.partsMoreOne': one('1 more part', 'map.prop.changes.partsMore'),

  // §K — keyboard reach, fast travel and stable links (lane K)
  'map.asOf': same('as of sync {n}', 'The sync this board is drawn from, with the day it was taken and, outside the business words, the source commit it read. Every number on the map is as of this sync, so a picture of the map says when it was true.'),
  'map.tool.link': same('Copy link', 'Copy a link to exactly this picture: the journey, how far the board is zoomed and where it sits, the open card or screen, and the words it is read in. Whoever opens the link sees the same view. The y key does the same.'),
  'map.link.copied': same('Link copied — it opens this same picture'),
  'map.link.select': same('The link is selected beside the tools — copy it from there'),
  'key.mapTab': same('Map: Tab walks the journeys, then each screen, its calls and its data; Enter opens what has the focus'),
  'key.mapJk': same('Map: next or previous screen on the street'),
  'key.mapHl': same('Map: previous or next journey'),
  'key.mapArrows': same('Map: move the board; with Shift, further'),
  'key.mapLink': same('Map: copy the link to this picture'),
  // §I — the Affected mode (lane I, map pass 2, docs/proposals/map-pass-2026-10-03.md §4): pick a thing and
  // the board dims to what reaches it, at every altitude. The numbers are core affectedReach()'s Counteds over
  // one impact answer; the distance words are the impact panel's own, and the business words count no links.
  'count.scope.affected': same('on what reaches it',
    'What the number counts over: the thing picked on the Map, the parts that use it as far out as the distance chosen, and the journeys and screens whose own path meets either. Each thing once.'),
  'count.unit.affectedJourneys': same('in {n} journeys',
    'Journeys whose path through the code meets the thing picked, or meets something that uses it within the distance chosen. A journey is counted once, however many of its screens do.'),
  'count.unit.affectedJourneysOne': one('in 1 journey', 'count.unit.affectedJourneys'),
  'count.unit.affectedScreens': same('{n} screens reach it (reached by walks)',
    'Distinct screens — the pages journeys walk through — whose own part of a journey’s path meets the thing picked, or something that uses it within the distance chosen. A screen four journeys share is one screen here; the list names each journey it is on. Not the designs the manifest declares: a page reached by walks may have no design, and a design no walk.'),
  'count.unit.affectedScreensOne': one('1 screen reaches it (reached by walks)', 'count.unit.affectedScreens'),
  'count.unit.affectedCalls': same('{n} calls reach it',
    'Calls to a service, each once, that use the thing picked within the distance chosen — and the thing itself when it is a call.'),
  'count.unit.affectedCallsOne': one('1 call reaches it', 'count.unit.affectedCalls'),
  'count.unit.affectedTests': same('{n} tests reach what uses it',
    'Distinct tests that reach anything using the thing picked, from what uses it directly out to the distance chosen, each test once. The same set the impact panel, the command line and the agent tool print.'),
  'count.unit.affectedTestsOne': one('1 test reaches what uses it', 'count.unit.affectedTests'),
  'count.part.reachSelf': same('{n} meet it on their own path',
    'Their path through the code meets the thing picked itself. That says they use it, however much code lies between; it is not a distance.'),
  'count.part.reachSelfOne': one('1 meets it on its own path', 'count.part.reachSelf'),
  'count.part.reachDirect': same('{n} through what uses it directly',
    'First met through something that uses the thing picked with nothing in between.'),
  'count.part.reachDirectOne': one('1 through what uses it directly', 'count.part.reachDirect'),
  'count.part.reachThrough': same('{n} through what uses those',
    'First met one link further out: through something that uses what uses the thing picked.'),
  'count.part.reachThroughOne': one('1 through what uses those', 'count.part.reachThrough'),
  'count.part.reachFar': same('{n} further out',
    'First met further out again, within the distance chosen.'),
  'count.part.reachFarOne': one('1 further out', 'count.part.reachFar'),
  'map.affected.title': {
    hud: 'Blast radius',
    professional: 'Affected',
    define: 'What reaches the thing you picked: the journeys, screens, calls and tests whose path meets it or meets something that uses it. Everything else on the board is dimmed, not hidden. Read one distance at a time; nothing here is added up.',
  },
  'map.affected.action': same('What’s affected', 'Dim the whole board to what reaches this: every journey, screen and call whose path meets it, at every zoom. Esc or clear leaves the mode.'),
  'map.affected.actionShort': same('Affected', 'Dim the whole board to what reaches the parts this change touched, at every zoom. Esc or clear leaves the mode.'),
  'map.affected.on': same('what reaches', 'The thing the board is dimmed around. Everything that reaches it stays lit, with how it reaches it.'),
  'map.affected.clear': same('clear', 'Leave the Affected mode and light the whole board again. Esc does the same.'),
  'map.affected.reading': same('reading what reaches it…', 'The answer is asked once per distance and kept until the next sync.'),
  'map.affected.failed': same('The answer about what reaches this did not come back.', 'The request failed, so the board is not dimmed. Nothing here is a fact about the code.'),
  'map.affected.unknown': same('Nothing on the board matches this link.', 'The link names something this graph does not hold — an old link, or a part of a source not in scope. The board is left lit.'),
  'map.affected.noParts': same('no part of the code is known to be touched by this', 'Neither the commits naming this item nor its links name a part of the indexed code, so there is nothing to dim the board around.'),
  'map.affected.partsMore': same('{n} more parts not asked', 'The change touched more parts than the board asks about at once. The first ones are drawn; these are not, so the picture is a floor.'),
  'map.affected.partsScope': same('the parts this change touched', 'Parts of the indexed code the commits changed, or the work item names.'),
  'map.affected.seed': same('the thing picked', 'Ringed: what the board is dimmed around.'),
  'map.affected.self': same('its path meets it', 'This one’s own path through the code meets the thing picked. It uses it, however much code lies between; this is not a distance.'),
  'map.affected.at': same('reached at hop {n}', 'Hops are links in the code. The fewest links between the thing picked and something on this one’s path: one is what uses it directly, two what uses those.'),
  'map.affected.bizAt1': same('through what uses it directly', 'Something on this one’s path uses the thing picked with nothing in between.'),
  'map.affected.bizAt2': same('through what uses those', 'Something on this one’s path uses what uses the thing picked.'),
  'map.affected.bizFar': same('further out', 'Something on this one’s path reaches the thing picked further out again.'),
  'map.affected.not': same('not reached', 'Nothing on this one’s path meets the thing picked or anything using it, within the distance chosen.'),
  'map.affected.bySeeds': same('reached by these parts', 'The change touched several parts. Each was asked about on its own, and this is how each one reaches here; they are never added together.'),
  'map.affected.tab': same('Affected', 'What reaches the thing the board is dimmed around — journeys, screens, calls and tests, one distance at a time, with where the answer stopped.'),
  'map.affected.tabOff': same('Pick something and choose What’s affected to see what reaches it.', 'The Affected tab answers once the board is dimmed around something.'),
  'map.affected.journeys': same('journeys', 'Journeys whose path meets it at this distance.'),
  'map.affected.screens': same('screens', 'Screens whose own part of the path meets it at this distance.'),
  'map.affected.calls': same('calls', 'Calls to a service that use it at this distance — or the thing itself, when it is a call.'),
  'map.affected.tests': same('tests first met here', 'Tests that reach something listed at this distance and nothing nearer. Each test is listed once, at the nearest distance it reaches.'),
  'map.affected.testsBiz': same('{n} tests first met here', 'Tests that reach something at this distance and nothing nearer, each once.'),
  'map.affected.stop': same('not followed past {name}', 'The answer stopped here: a part used all over the code, or the end of the distance chosen. More may stand behind it.'),
  'map.affected.seedFor': same('asked about', 'With several parts, the tab answers for one at a time. Pick the part whose answer to read.'),
  'map.affected.alsoIn': same('also in — reach', 'The other journeys this screen is in, each marked with whether its path reaches the thing picked.'),
  // §Z — zoom and frame (lane Z, map pass 2)
  'map.edge.more': same('{n} more', 'Screens of this journey past this edge of the board. Click to slide the board to them; the journey’s own counts never change.'),
  'map.edge.scope': same('this journey, past the edge of the board', 'The screens of the journey in view whose middle is outside the board on this side.'),
  // §R2 — round 2 of the map pass (the second swarm's fixes)
  'map.affected.fit': same('fit these', 'Frame the journeys that reach the thing picked, not the whole board, so the lit ones read at the fit. Fit and 0 do the same while the mode is on.'),
  'map.affected.list': same('list these', 'Open the answer as a list: the journeys, screens, owners and tests that reach the thing picked, one distance at a time, with copy as CSV or JSON.'),
  'map.affected.listTitle': same('What reaches it, as a list', 'The same answer the board is dimmed around, written out: per distance the journeys with their owners, each screen once with the journeys it is on, the owners, and the tests first met there.'),
  'map.affected.owners': same('owners', 'The owners the journey manifest names for the journeys reached at this distance, each once.'),
  'map.affected.listClose': same('Close the list', 'Close the list. The board stays dimmed until clear or Esc.'),
  'map.affected.copyCsv': same('copy as CSV', 'Copy these rows as comma-separated values: seed, distance, kind, id, name, journeys, owner, evidence. The same rows as the list.'),
  'map.affected.copyJson': same('copy as JSON', 'Copy these rows as JSON under a header that names them farsight-affected version 0. Version 0 is not a frozen contract: its fields may still change.'),
  'map.affected.copiedRows': same('copied {n} rows', 'The rows are on the clipboard, exactly as the list shows them.'),
  'map.affected.copyField': same('select and copy the rows below', 'The clipboard refused the copy, so the rows are in the field below, selected, for you to copy.'),
  'map.affected.noMore': same('nothing more past {n}', 'Asking further out finds nothing new: every answer stopped at this distance, so a longer reach would print the same numbers.'),
  'map.affected.within': same('within how far {n}', 'The tests count runs from what uses the thing picked directly out to the distance chosen on the bar — not every test of the application.'),
  'map.affected.onJourneys': same('on {list}', 'The journeys this screen is on that reach the thing picked. The screen is counted once.'),
  'map.screen.onJourney': same('on this journey', 'These numbers count this screen’s own part of this journey’s walk through the code. The same screen on another journey can print other numbers, because that journey reaches it by another path.'),
  'map.risk.title': same('at risk', 'The journeys on this board whose evidence is stale, whose screens are not all built, or that reach the ERP — counted from the same facts their covers print.'),
  'count.unit.riskStale': same('{n} journeys stale', 'Journeys whose tests were last seen by a run made before the code changed: the journey’s header says stale, and its card on the board carries the at-risk mark. Each journey once.'),
  'count.unit.riskStaleOne': one('1 journey stale', 'count.unit.riskStale'),
  'count.unit.riskNotBuilt': same('{n} not fully built', 'Journeys with at least one screen designed and not built yet: its card on the board says partly built, or designed, not built. Each journey once.'),
  'count.unit.riskNotBuiltOne': one('1 not fully built', 'count.unit.riskNotBuilt'),
  'count.unit.riskErp': same('{n} reach the ERP', 'Journeys whose calls reach the ERP, so a change on them can change what the finance system receives. Each journey once.'),
  'count.unit.riskErpOne': one('1 reaches the ERP', 'count.unit.riskErp'),
  'map.backTo': same('back to {name}', 'The journey you opened is off the stage. This brings it back into view, framed the way it opens.'),
  'map.affected.copyFailed': same('nothing was copied', 'Neither the clipboard nor a selected field would take the rows.'),

  // §C — the clarity pass (2026-10-04): the board draws by altitude — a card per journey, a panel per band, lines on hover
  'map.level.nb.short': { hud: 'Town', professional: 'All', define: 'Short for the board zoomed out, where every journey is one card. The same button as the whole name, on a narrow window.' },
  'map.level.st.short': { hud: 'Street', professional: 'Journey', define: 'Short for one journey’s screens in order. The same button as the whole name, on a narrow window.' },
  'map.level.pr.short': { hud: 'House', professional: 'Screen', define: 'Short for one screen up close. The same button as the whole name, on a narrow window.' },
  'map.cover.status.built': same('built', 'Every screen this journey names is served by a page in the code. The tip counts them.'),
  'map.cover.status.partly': same('partly built · {n} of {m}', 'Some of the screens this journey names are served by a page in the code and some are only designed. The tip counts both.'),
  'map.cover.status.none': same('designed, not built', 'The design names this journey’s screens and no page in the code serves any of them yet.'),
  'map.cover.risk': same('at risk', 'This journey’s tests were last seen by a run made before the code changed, or not every screen it names is built yet; the tip says which. The at-risk bar above the board counts these journeys.'),
  'map.cover.risk.stale': same('tests stale', 'The tests that cover this journey were last run before the code they cover changed.'),
  'map.cover.risk.notBuilt': same('not every screen built', 'At least one screen this journey names is designed and not served by a page in the code yet.'),
  'map.cover.leads': same('→ {n}', 'How many journeys this one leads to. At the board the lines are drawn only for the journey under the pointer; zoom in to see them all.'),
  'map.cover.leadsOf': same('leads to {n} journeys', 'The journeys a person goes on to after this one, as the design says or as their shared screens show. A pair that lead to each other counts at both ends.'),
  'map.cover.leadsOfOne': one('leads to 1 journey', 'map.cover.leadsOf'),
  'map.band.journeys': same('{n} journeys', 'The journeys drawn in this band. Banded by persona, a journey for two people is in both bands, once as its card and once as a card that leads to it.'),
  'map.band.journeysOne': one('1 journey', 'map.band.journeys'),
  'map.band.scope': same('this band', 'One band of journeys on the board: one source, one domain or one persona.'),
};
