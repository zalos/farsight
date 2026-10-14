// Who may do what — the role × action table's words (outsider round 2026-10-13, worklist F4): core roles.ts
// `roleTable()`, `GET /api/roles`, MCP `roles`, CLI `farsight roles`, the gate card's *who may do what* and the
// `#/roles` page. Spread into STRINGS in strings.ts like strings-doors.ts. Same rules as the rest of the catalog:
// both registers, a define on every word a reader may not know, defines in plain words (no backticks, no markdown,
// no dotted identifiers, no placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const ROLES_STRINGS: Record<string, StringEntry> = {
  // ── the numbers ────────────────────────────────────────────────────────────
  'count.unit.roleActions': same('{n} actions behind a role check',
    'Actions a role check stands in front of: each call to the service a person may make only when they hold one of the roles the code lists for it. Each action once.'),
  'count.unit.roleActionsOne': one('1 action behind a role check', 'count.unit.roleActions'),
  'count.part.rolesRead': same('{n} with the roles read from the code',
    'Actions whose list of roles the code hands the check as a named list, so the table can print them.'),
  'count.part.rolesUnread': same('{n} with the roles not read',
    'Actions the role check stands in front of whose list of roles is built some other way than a named list, so the table cannot print them. The check is still there.'),
  'count.unit.roles': same('{n} roles',
    'The distinct roles the code names in any action’s list. Who holds each role is data the code does not carry.'),
  'count.unit.rolesOne': one('1 role', 'count.unit.roles'),
  'count.unit.roleActionsPassed': same('{n} of {m} reached by a case whose last run passed',
    'Of the actions behind a role check, those a test case reaches whose own last run passed. Each case is read by its own run; whether the run also measured the code is the verdict beside it.'),

  // ── the page and the table ─────────────────────────────────────────────────
  'roles.title': { hud: 'Who may do what', professional: 'Who may do what',
    define: 'Every action a role check stands in front of, with the roles the code lists for it, where the list was read from, the journeys that reach it and the test that proves it.' },
  'roles.lead': same('Read from the code: the roles each check is handed where the action calls it.',
    'The table is folded from the role checks in the code and the named lists they are handed. Nothing in it was declared by hand.'),
  'roles.holders': same('Who holds each role is data the code does not carry, so this table cannot say.',
    'The code says which roles an action accepts. Which people hold those roles lives in the application’s own records or its directory, which Farsight does not read.'),
  'roles.col.action': same('Action', 'What a person asks the service to do, in the words its authors wrote.'),
  'roles.col.roles': same('Roles the code lists', 'The roles the code accepts for this action, as the check is handed them. Any one of them lets the action through.'),
  'roles.col.from': same('Read from', 'The named list in the code the roles were read from.'),
  'roles.col.where': same('Where a person meets it', 'The journeys and screens whose walk reaches this action.'),
  'roles.col.proof': same('Proven by', 'The test that reaches this action, quoted by its own name, with its last run.'),
  'roles.cell.may': same('may', 'The code lists this role for this action.'),
  'roles.cell.not': same('not listed', 'The code does not list this role for this action: a person holding only this role is refused.'),
  'roles.cell.unread': same('roles not read', 'A role check stands in front of this action, but its list of roles is not a named list the parser can read.'),
  'roles.anyOf': same('any of: {roles}', 'Any one of these roles lets the action through.'),
  'roles.biz.row': same('Who may {action}: {roles}',
    'The roles the code lists for this action, in plain words. Any one of them lets it through.'),
  'roles.proof': same('proven by “{test}”', 'The name the team gave the test that reaches this action, quoted as written.'),
  'roles.proof.none': same('no test is known to reach it', 'No case reaches this action, as far as the graph knows. A floor: a test this build could not read is not counted.'),
  'roles.lastRun': same('{status} {date}', 'What the quoted test did on its last run, and the day of that run.'),
  'roles.filter.all': same('every role', 'Shows every action behind a role check.'),
  'roles.filter.role': same('Only actions open to', 'Narrows the table to the actions whose list includes this role.'),
  'roles.empty': same('No role check found in this graph.',
    'No check in the code is handed a named list of roles. Either the application checks roles some other way, or it has none.'),
  'roles.loading': same('reading who may do what…', 'The role table is being folded from the graph.'),
  'roles.unavailable': same('The role table could not be read.', 'The server did not answer for the role table.'),
  'roles.door': same('who may do what', 'Opens the table of every action a role check stands in front of, with the roles the code lists for each.'),
  'roles.save.csv': same('Save as CSV', 'Saves the table as a spreadsheet: one row per action, its roles, where they were read from, the journeys and the first test.'),
  'roles.save.json': same('Save as JSON', 'Saves the table as the same rows the role tool answers, for a script.'),

  // ── on the gate card ───────────────────────────────────────────────────────
  'gate.sec.roles': same('Who may do what', 'The roles this check accepts for each action it stands in front of, read from the list the code hands it there.'),
  'gate.roles.here': same('here', 'The action this card was opened from.'),
  'gate.roles.also': same('also guards {n} actions', 'The other actions this same check stands in front of, each with its own list of roles.'),
  'gate.roles.alsoOne': one('also guards 1 action', 'gate.roles.also'),
  'gate.roles.all': same('see every action', 'Opens the table of every action a role check stands in front of.'),
};
