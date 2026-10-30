// What an agent gets (round 2026-10-10, proposal 9): the copy doors on every record (copy as MCP call · curl ·
// CLI), the commits made with an AI assistant on the commit spine, the owner's lessons for agents on the
// Settings page, and the empty states that say what a surface is for, why it is empty and what fills it.
// Spread into STRINGS in strings.ts like strings-doors.ts. Same rules as the rest of the catalog: both
// registers, a define on every word a reader may not know, defines in plain words (no backticks, no markdown,
// no catalog keys, no placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}
function two(hud: string, professional: string, define: string): StringEntry {
  return { hud, professional, define };
}

export const AGENT_STRINGS: Record<string, StringEntry> = {
  // ── the commit spine: commits made with an AI assistant ──
  'history.fact.agents': same('{n} of {m} commits made with an agent', 'Of the commits read into history, those whose message names an AI assistant as a co-author, the trailer Claude Code and other assistants write. Read from the commit message only; which session made a commit is never read.'),
  'history.fact.agentsOne': one('1 of {m} commits made with an agent', 'history.fact.agents'),
  'history.fact.agentNamed': same('{n} commits', 'The commits whose co-author trailer names this assistant, under the name the trailer gives it.'),
  'history.fact.agentNamedOne': one('1 commit', 'history.fact.agentNamed'),
  'history.agentMade': same('made with an agent · {name}', 'This commit names an AI assistant as a co-author in its message: it was made in a session with that assistant. The session itself is not recorded here.'),

  // ── copy as MCP call · curl · CLI ──
  'door.copy.group': same('copy as', 'The same record as a call another tool can make: the MCP call an agent makes, a curl against this server, or the command line. Each carries the full id, so what is pasted is exactly what is on screen.'),
  'door.copy.mcp': same('copy as MCP call', 'Copies the call an agent makes over MCP for this record, with its full id.'),
  'door.copy.mcpShort': same('MCP', 'Copies the call an agent makes over MCP for this number.'),
  'door.copy.mcpTip': same('the call an agent makes over MCP'),
  'door.copy.curl': same('copy as curl', 'Copies a curl command that asks this server for the same record.'),
  'door.copy.curlShort': same('curl', 'Copies a curl command that asks this server for the same number.'),
  'door.copy.curlTip': same('a curl against this server'),
  'door.copy.cli': same('copy as CLI', 'Copies the farsight command that prints the same record in a terminal.'),
  'door.copy.cliShort': same('CLI', 'Copies the farsight command that prints the same number in a terminal.'),
  'door.copy.cliTip': same('the farsight command line'),
  'door.copied': same('copied', 'The call is on the clipboard: paste it into an agent, a terminal or a note.'),
  'door.copyFailed': same('select and copy it:', 'The browser did not let the page write to the clipboard; the call is shown so it can be selected and copied by hand.'),

  // ── lessons for agents (Settings) ──
  'set.lessons.title': same('Lessons for agents', 'Notes the owner writes for every AI agent that opens this workspace. A pinned lesson is read at the start of every agent session, in the session-start context; an agent never writes one.'),
  'set.lessons.add': same('+ Add lesson'),

  // ── empty states: what the surface is for, why it is empty, what fills it ──
  'empty.work': two(
    'The bounty board shows the work your tracker holds and what each item changed. It is empty because no tracker is connected — ask whoever runs Farsight to add a work source.',
    'Work shows the items a tracker holds (Jira, Azure DevOps) and the code each changed. It is empty because no work source is configured: add one to .farsight/settings.json (type work), then run farsight work sync.',
    'Why the Work page has nothing to show, and what fills it.'),
  'empty.tests': two(
    'Tests shows which checks run over each journey and what their last run said. It is empty because no test was found in these sources — ask for the test folders to be read.',
    'Tests shows every test case, what it reaches and its own last run. It is empty because no test is indexed in scope: the sources have none, or their spec files are excluded. Drop the exclude, then run farsight ingest (or Sync), and attach a run with farsight tests import.',
    'Why the Tests page has nothing to show, and what fills it. It says what Farsight read, never that the application is untested.'),
  'empty.changes': two(
    'Changes shows what moved between two reads of the code, and the commits behind it. It is empty because the history has not been read yet — a sync reads it.',
    'Changes shows what moved between two syncs and the commits behind it. It is empty because no sync has been recorded for this source, or its git history was never read: run farsight ingest (or Sync), then farsight history.',
    'Why the Changes page has nothing to show, and the commands that fill it.'),
  'empty.apis': two(
    'APIs lists the calls the application answers and what each promises. It is empty because nothing in scope serves a call — widen the scope, or add the service that does.',
    'APIs lists every HTTP operation, its contract and who calls it. It is empty because no route is in scope: widen the scope, or add a source that serves routes or ships an OpenAPI document, then run farsight ingest.',
    'Why the APIs page has nothing to show, and what fills it.'),
  'empty.map': two(
    'The map draws every journey a design names, screen by screen. It is empty because no design names a journey yet — a screens manifest does.',
    'The Map draws every journey a design manifest declares, screen by screen. It is empty because no manifest declares one: add docs/design/screens.json (MCP design_guide says how), then Sync.',
    'Why the Map has nothing to draw, and the file that fills it.'),
  'empty.mapStorylines': two(
    'A questline chains journeys into one story. None is declared yet — a design manifest or a config file names them.',
    'A storyline chains journeys across features in order. None is declared in scope: add storylines to a screens manifest or to farsight.config.json (journeys block), then Sync.',
    'Why the storyline picker has nothing to offer, and where a storyline is declared.'),
  'map.storyline.none': two('none declared', 'none declared', 'No storyline is declared in scope; a storyline chains journeys in order and is declared in a screens manifest or a config file.'),
  'empty.lessons': two(
    'No lessons yet. A lesson is a note every agent reads when it starts — write the first one here.',
    'No lessons yet. A pinned lesson is read by every agent at session start; write one here and Save settings.',
    'Why the lessons list is empty, and how a lesson is added.'),
};
