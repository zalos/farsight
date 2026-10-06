// The gate card's words (swarm-fixes round 2026-10-05, finding 4): a gate answers its click with one card —
// what it allows, where it stands, its code, the calls it guards and the tests that reach them — and a config
// check is said to be one. Spread into STRINGS in strings.ts like strings-doors.ts. Same rules as the rest of
// the catalog: both registers, a define on every word a reader may not know, defines in plain words (no
// backticks, no markdown, no dotted identifiers, no placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const GATE_STRINGS: Record<string, StringEntry> = {
  // ── the numbers ────────────────────────────────────────────────────────────
  'count.scope.gate': same('for this gate',
    'What the number beside it counts over: one gate, and the calls a request goes through to meet it. A test is counted once, whether it reaches the gate itself or a call in front of it.'),
  'count.unit.configChecks': same('{n} config checks',
    'Checks on how the application was started, such as a setting that must be present or a mode that is refused in production. They run when the application reads its settings, not on any one request, so they are counted apart from the gates.'),
  'count.unit.configChecksOne': one('1 config check', 'count.unit.configChecks'),
  'count.unit.gateSitsOn': same('{n} parts it sits on',
    'The parts of the code this gate stands in front of directly: the functions and requests that run only once it lets them through.'),
  'count.unit.gateSitsOnOne': one('1 part it sits on', 'count.unit.gateSitsOn'),
  'count.unit.gateCalls': same('{n} of {m} calls',
    'The calls to the service that reach this gate on their way, out of every call the graph knows. A call the gate sits on directly and a call that reaches it further down are both counted, each once.'),
  'count.part.gateCallsOwn': same('{n} it guards directly',
    'Calls the gate stands in front of itself: nothing else runs for them until it lets them through.'),
  'count.part.gateCallsUnder': same('{n} that reach it further down',
    'Calls that run other code first and meet the gate on the way, so the gate stands in front of part of what they do.'),
  'count.unit.gatePages': same('{n} pages',
    'Pages drawn on the server that meet this gate before they are shown. A config check is usually met here, because a page reads the settings to draw itself.'),
  'count.unit.gatePagesOne': one('1 page', 'count.unit.gatePages'),

  // ── the card ───────────────────────────────────────────────────────────────
  'gate.card': same('gate', 'One checkpoint, answered: what it allows, where it stands, its code, the calls it guards and the tests that reach them.'),
  'gate.open': same('open this gate', 'Opens the gate card: what it allows, where it stands, its code, the calls it guards and the tests that reach them.'),
  'gate.kind.guard': { hud: 'gate', professional: 'check',
    define: 'A checkpoint on who may go on: signed in, owns the thing, within the rate limit. Its words are policy.' },
  'gate.kind.rule': same('rule', 'A shape the data has to match before it is accepted, such as a required field or an allowed value.'),
  'gate.kind.config': same('config check',
    'A check on how the application was started, not on a request: a setting that must be present, or a mode refused in production. It runs when the application reads its settings.'),
  'gate.kind.declared': same('declared in the config', 'Named in the source’s configuration file rather than found in the code: somebody said this is a gate.'),
  'gate.sec.allows': same('What it allows', 'What this checkpoint lets through and what it refuses, in the words somebody wrote for it.'),
  'gate.sec.where': same('Where it stands', 'The calls and pages a request goes through to meet this checkpoint, and the parts it sits on directly.'),
  'gate.sec.code': same('Its code', 'The checkpoint’s own lines, read from the file on this machine.'),
  'gate.sec.calls': same('The calls it guards', 'Each call to the service that meets this checkpoint on its way, nearest first, with where to read its contract and its handler.'),
  'gate.sec.tests': same('The tests that reach it', 'Each test that reaches this checkpoint itself or a call in front of it, once, with how it is known to reach it.'),
  'gate.sec.sitsOn': same('It sits on', 'The parts this checkpoint stands in front of directly.'),
  'gate.says.phrase': same('Lets a request through only when: {words}', 'The requirement the developer wrote beside the check, as written.'),
  'gate.says.rulePhrase': same('The data has to match: {words}', 'The shape the developer named for the data, as written.'),
  'gate.says.none': same('Nobody has written down what this allows.',
    'No sentence was written for this checkpoint, so the card can say where it stands and what reaches it, but not what it means.'),
  'gate.who.biz': same('Ask the team that owns the {project} code to write one sentence about it.',
    'The people who own the code a checkpoint lives in are the ones who can say what it is for.'),
  'gate.who.bizNoProject': same('Ask the team that owns this code to write one sentence about it.',
    'The people who own the code a checkpoint lives in are the ones who can say what it is for.'),
  'gate.who.code': same('Write it as a business line above {ident} in {path}, or name it in the source’s config file.',
    'A sentence in the doc comment above the function, tagged business, becomes the words every view and the business register print for this checkpoint.'),
  'gate.config.sentence': same('Checks how the application was started, not a request. It runs wherever the application reads its settings.',
    'A config check is met by every call and page that reads the settings, so it is listed apart from the gates a screen’s own requests meet.'),
  'gate.reach': same('reached through {calls} and {pages}', 'The calls and the pages a request or a drawing goes through to meet this checkpoint.'),
  'gate.depth.own': same('guards it directly', 'The checkpoint stands in front of this call itself.'),
  'gate.depth.under': same('{n} calls down', 'The call runs other code first; the checkpoint is met this many calls below it.'),
  'gate.depth.underOne': one('1 call down', 'gate.depth.under'),
  'gate.calls.none': same('no call reaches it in this graph',
    'No route the graph knows goes through this checkpoint. It may be met only at start-up, or only by code the graph did not read.'),
  'gate.tests.none': same('no test reaches it',
    'No test in the graph reaches this checkpoint or a call in front of it.'),
  'gate.tests.onGate': same('reaches the check itself', 'The test runs the checkpoint’s own code.'),
  'gate.tests.viaCall': same('through {call}', 'The test reaches a call in front of the checkpoint, and so the checkpoint on the way.'),
  'gate.more': same('{n} more', 'More of these than the card draws; the count beside the heading counts them all.'),
  'gate.floor': same('at least these', 'The walk up to the calls stopped at its limit, so there may be more than are listed.'),
  'gate.loading': same('reading what reaches it…', 'The service is working out the calls and the tests that reach this checkpoint.'),
  'gate.unavailable': same('the service could not say what reaches it', 'The calls and tests could not be read from the service just now; the rest of the card is from the page.'),
  'gate.atStep': same('show it in the journey', 'Selects the action this checkpoint was met in, in the journey on screen.'),

  // ── the journey's list ─────────────────────────────────────────────────────
  'journey.bizGroup.configChecks': same('Config checks',
    'Checks on how the application was started that this screen’s code meets on the way: a setting that must be present, or a mode refused in production. They are not gates on this screen’s requests, so they are listed and counted apart.'),
  'map.prop.gates.config': same('Config checks met on the way',
    'Checks on how the application was started that this screen’s code meets when it reads its settings. They guard no call of this screen in particular, so they are not counted with its gates.'),
};
