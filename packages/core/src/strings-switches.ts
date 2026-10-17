// The switches' words (lane moves, 2026-10-13): a call the code holds under a branch on a module-level constant
// whose value means it does not run. *Switched off* is the state of one call — never an absence word (the six stay
// six) and never an evidence class (the three stay three). Spread into STRINGS in strings.ts like strings-doors.ts.
// Same rules as the rest of the catalog: both registers, a define on every word, defines in plain words (no
// backticks, no markdown, no dotted identifiers, no placeholders in a define). A line that names code has a
// `switch.biz.*` twin with the code left out.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const SWITCHES_STRINGS: Record<string, StringEntry> = {
  'switch.word': same('switched off', 'The code makes this call only when a constant it fixes says so, and the constant says no. The call is in the code and does not run; nothing it would do is credited to the action that holds it.'),
  'switch.by': same('switched off by {flag} = {value}', 'The call sits under a branch on a constant the code declares, and the constant’s value means the branch does not run. Flipping the constant is a code change.'),
  'switch.biz.by': same('switched off for now', 'The application holds this path in its code but has it turned off by a setting written into the code — usually a decision still open. It does not happen today.'),
  'switch.alsoFrom': same('also reached from {count}', 'Other actions whose live path runs the same code that makes this move. The action that calls that code most directly is named first; the rest fold here.'),
  'switch.ask.off': same('One more path reaches {writer} — {action} on {screen} — but the code switches that call off: {flag} = {value} at {at}.', 'A call to the code that makes the move exists on another action, under a constant whose value means it does not run. It is listed so the path is not hidden, and it is never the answer.'),
  'switch.biz.ask.off': same('{action} on {screen} could also do it, but the application has that turned off for now.', 'Another action holds the same move in its code, switched off by a setting written into the code. It does not happen today.'),
  'switch.tour.off': same('{action} on {screen} also holds a call to {writer}, switched off: {flag} = {value} ({at}). The move is made here instead.', 'The same move is written into another action’s code under a constant that switches it off; the walk names it once, where it would have happened, and credits the move to the action whose path runs it.'),
  'switch.biz.tour.off': same('{action} on {screen} could also do this, but the application has that turned off for now.', 'Another action holds the same move, switched off by a setting written into the code. It does not happen today.'),
  'switch.section': same('switches', 'The constants the code declares that turn a call on or off, each with its value, where it is declared and the calls it decides. Read from the code; flipping one is a code change.'),
  'switch.on': same('on', 'The constant’s value lets the calls it guards run.'),
  'switch.offWord': same('off', 'The constant’s value stops at least one call it guards from running.'),
  'switch.line': same('{flag} = {value} · {state} · {at} · decides {calls}', 'One constant: its value, whether the calls it guards run, where it is declared and the calls it decides.'),
  'switch.calls': same('{n} calls', 'The calls in the code that sit under a branch on this constant, each caller and callee once.'),
  'switch.callsOne': one('1 call', 'switch.calls'),
  'switch.overview': same('switches: {count} — constants that turn a call on or off ({off} switched off)', 'The constants the code declares that a branch tests before a call, and how many of them stop a call from running.'),
  'switch.recordLine': same('{flag} = {value} switches off {writer} from {caller} ({at})', 'A move into this record that the code holds but a constant stops from running.'),
  'count.unit.switches': same('{n} switches', 'Constants the code declares that a branch tests before making a call — each constant once.'),
  'count.unit.switchesOne': one('1 switch', 'count.unit.switches'),
  'count.part.switchesOff': same('{n} switched off', 'Switches whose value stops at least one call they guard from running.'),
  'count.part.switchCallsOff': same('{n} switched off', 'Calls under this constant that its value stops from running.'),
  'count.part.switchCallsOn': same('{n} run', 'Calls under this constant that its value lets run.'),
  'count.part.switchesOn': same('{n} on', 'Switches whose value lets every call they guard run.'),
  'lifecycle.alsoReached': same('also reached from {n}', 'Other actions whose live path runs the same code that makes this move. The action that calls that code most directly is named; the rest fold here.'),
  'lifecycle.switchedOffMover': same('switched off: {action} · {flag} = {value}', 'An action that holds a call to this move under a constant that switches it off. It does not make the move today.'),
  'lifecycle.biz.switchedOffMover': same('{action} — turned off for now', 'An action that holds this move in its code, switched off by a setting written into the code. It does not make the move today.'),
  'lifecycle.whenArm': same('when {when}', 'The code writes this status on one arm of a choice; this is the condition, as the code states it.'),
};
