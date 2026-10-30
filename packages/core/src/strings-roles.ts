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
    'Actions a role check stands in front of: each call to the service a person may make only when they hold one of the roles the code or configuration lists for it. Each action once.'),
  'count.unit.roleActionsOne': one('1 action behind a role check', 'count.unit.roleActions'),
  'count.part.rolesRead': same('{n} with the roles read from code or configuration',
    'Actions whose roles were read from a named list in the code or explicitly declared in configuration; each row names its source.'),
  'count.part.rolesUnread': same('{n} with the roles not read',
    'Actions the role check stands in front of whose list of roles is built some other way than a named list, so the table cannot print them. The check is still there.'),
  'count.unit.roles': same('{n} roles',
    'The distinct roles the code or configuration names in any action’s list. Who holds each role is data the code does not carry.'),
  'count.unit.rolesOne': one('1 role', 'count.unit.roles'),
  'count.unit.roleActionsPassed': same('{n} of {m} reached by a case whose last run passed',
    'Of the actions behind a role check, those a test case reaches whose own last run passed. Each case is read by its own run; whether the run also measured the code is the verdict beside it.'),

  // ── the page and the table ─────────────────────────────────────────────────
  'roles.title': { hud: 'Who may do what', professional: 'Who may do what',
    define: 'Every action a role check stands in front of, with the roles the code or configuration lists for it, where the list was read from, the journeys that reach it and the test that proves it.' },
  'roles.lead': same('Read from code or configuration: the roles each check requires for the action.',
    'The table combines roles read from checks in the code with explicit grants declared in configuration. Each row names the source; a declaration is not evidence of enforcement.'),
  'roles.listed': same('Roles named in code or configuration', 'Distinct roles from code lists and explicit configuration grants; attribution is printed beside each action.'),
  'roles.holders': same('Who holds each role is data the code does not carry, so this table cannot say.',
    'The code says which roles an action accepts. Which people hold those roles lives in the application’s own records or its directory, which Farsight does not read.'),
  'roles.col.action': same('Action', 'What a person asks the service to do, in the words its authors wrote.'),
  'roles.col.roles': same('Roles listed', 'Roles read from code or explicitly declared for this action. A configuration declaration does not prove enforcement.'),
  'roles.col.from': same('Read from', 'The code list or configuration declaration these roles came from.'),
  'roles.col.where': same('Where a person meets it', 'The journeys and screens whose walk reaches this action.'),
  'roles.col.proof': same('Proven by', 'The test that reaches this action, quoted by its own name, with its last run.'),
  'roles.cell.may': same('may', 'The code or configuration lists this role for this action.'),
  'roles.cell.not': same('not listed', 'Neither the code lists nor the configuration declarations name this role for the action.'),
  'roles.cell.unread': same('roles not read', 'A role check stands in front of this action, but its list of roles is not a named list the parser can read.'),
  'roles.anyOf': same('who may: {roles}', 'The roles the code or configuration lists for this action, in plain words. Each row names where its list came from.'),
  'roles.proof': same('proven by “{test}”', 'The name the team gave the test that reaches this action, quoted as written.'),
  'roles.proof.none': same('no test is known to reach it', 'No case reaches this action, as far as the graph knows. A floor: a test this build could not read is not counted.'),
  'roles.lastRun': same('{status} {date}', 'What the quoted test did on its last run, and the day of that run.'),
  'roles.filter.all': same('every role', 'Shows every action behind a role check.'),
  'roles.filter.role': same('Only actions open to', 'Narrows the table to the actions whose list includes this role.'),
  'roles.empty': same('No role check found in this graph.',
    'No named list of roles was read from code or explicitly declared in configuration. The application may check roles in a way this build cannot read.'),
  'roles.emptyLine': same('who may do what: no role check found — no named roles were read from code or configuration',
    'No named role list was read from the code or declared in configuration. This does not prove that the application has no role checks.'),
  'roles.loading': same('reading who may do what…', 'The role table is being folded from the graph.'),
  'roles.unavailable': same('The role table could not be read.', 'The server did not answer for the role table.'),
  'roles.door': same('who may do what', 'Opens the table of every action a role check stands in front of, with the roles the code or configuration lists for each.'),
  'roles.save.csv': same('Save as CSV', 'Saves the table as a spreadsheet: one row per action, its roles, where they were read from, the journeys and the first test.'),
  'roles.save.json': same('Save as JSON', 'Saves the table as the same rows the role tool answers, for a script.'),

  // ── on the gate card ───────────────────────────────────────────────────────
  'gate.sec.roles': same('Who may do what', 'The roles this check accepts for each action it stands in front of, read from code or explicitly declared in configuration.'),
  'gate.roles.here': same('here', 'The action this card was opened from.'),
  'gate.roles.also': same('also guards {n} actions', 'The other actions this same check stands in front of, each with its own list of roles.'),
  'gate.roles.alsoOne': one('also guards 1 action', 'gate.roles.also'),
  'gate.roles.all': same('see every action', 'Opens the table of every action a role check stands in front of.'),
};
