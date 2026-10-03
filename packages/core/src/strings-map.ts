// The MAP surface's words (docs/proposals/map-view.md). Spread into STRINGS in
// strings.ts; kept apart so the two lanes that build the map add their blocks
// without touching each other or the main catalog. Same rules as the rest of the
// catalog: both registers, a define on every word a reader may not know, defines
// in plain words (no backticks, no markdown, no dotted identifiers, no placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const MAP_STRINGS: Record<string, StringEntry> = {
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
