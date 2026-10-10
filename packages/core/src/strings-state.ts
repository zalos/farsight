// The front door's words (round 2026-10-10, lane H): *read this if*, the state of play's three columns and
// their units, the re-check door, the history sentence's three halves, the glossary strip, an address with
// nothing at it, and the read-only words a write control and the work pane carry. Spread into STRINGS in
// strings.ts like strings-doors.ts. Same rules as the rest of the catalog: both registers, a define on every
// word a reader may not know, defines in plain words (no backticks, no markdown, no catalog keys, no
// placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}
function sys(word: string): StringEntry {
  return { hud: word, professional: word, invariant: true };
}

export const STATE_STRINGS: Record<string, StringEntry> = {
  // ── read this if ──
  'journeys.readThisIf': same('Read this if', 'Three things to know when opening Farsight on this application for the first time: where to start, how to change the words, and where every word is defined.'),
  // ── the state of play ──
  'state.title': same('State of play', 'What is built, what a test run has checked, and what is still open in the sources in scope, as of the sync named beside it. Every number carries the command that prints it again.'),
  'state.asOf': same('as of sync {n}', 'The sync whose graph every number on this card was counted from.'),
  'state.codeAt': same('code at commit {c}', 'The commit the sources were at when that sync read them.'),
  'state.codeAtNone': same('no commit recorded', 'The sync recorded no commit for the code it read: the source is not a git repository, or git could not be asked.'),
  'state.drawnBy': same('drawn by farsight {b}', 'The build of Farsight that wrote this graph.'),
  'state.col.built': same('Built and walkable', 'What exists in code and can be walked screen by screen: journeys whose every screen is built, screens, operations with code behind them, and the storylines that chain the journeys.'),
  'state.col.validated': same('Validated by a run', 'What a recorded test run says: journeys by their one test verdict, the newest end-to-end run and whether the code moved since, and every test case by its own last run.'),
  'state.col.open': same('Still open', 'What is designed or declared and not yet in code, the gaps in the test evidence, where the design and the code disagree, and how much of the history no sync has ingested.'),
  'state.unit.screensBuilt': same('{n} of {m} screens built', 'Screens that exist in code, out of the screens the designs declare. A page the code has and no design names is not counted here.'),
  'state.unit.operations': same('{n} of {m} operations implemented', 'Operations with code behind them, out of every operation the API surfaces list, whether a contract declares it or only the code serves it.'),
  'state.unit.screensNotBuilt': same('{n} screens designed, not built', 'Screens a design declares that no code builds yet.'),
  'state.unit.screensNotBuiltOne': one('1 screen designed, not built', 'state.unit.screensNotBuilt'),
  'state.unit.operationsNotImplemented': same('{n} operations declared, not implemented', 'Operations a contract declares that no code serves. A source that holds only a contract has no code to compare with, so its operations are left out.'),
  'state.unit.operationsNotImplementedOne': one('1 operation declared, not implemented', 'state.unit.operationsNotImplemented'),
  'state.unit.blindSpots': same('{n} blind spots in the test evidence', 'Gaps in what the test reports could tell Farsight: a report a config names that was not found or could not be read, a claim that names nothing in the graph, a run with no source digest. Each is one sentence on the Tests page.'),
  'state.unit.blindSpotsOne': one('1 blind spot in the test evidence', 'state.unit.blindSpots'),
  'state.unit.drift': same('{n} differences between design and code', 'Places where a design manifest and the code disagree: a screen on another route, an operation the design names that nothing calls, a call the design does not name. Each one is listed on the design card below.'),
  'state.unit.driftOne': one('1 difference between design and code', 'state.unit.drift'),
  'state.lastE2e': same('last end-to-end run {date}', 'The newest run any end-to-end report recorded for the sources in scope.'),
  'state.noE2e': same('no end-to-end run recorded', 'No end-to-end report in scope recorded a run, so nothing here was walked by a browser test.'),
  'state.historyNone': same('history not indexed', 'No history store could be read for this workspace, so how many commits were read and ingested cannot be said.'),
  'state.recheck': same('re-check', 'The command that prints this number again, so a reader who doubts it can see for themselves. Click to copy it.'),
  'state.recheckCopied': same('copied', 'The command is on the clipboard.'),
  'state.recheckMcp': same('or ask an agent: {tool}', 'The tool an agent connected to Farsight calls to read the same number.'),
  // ── the history sentence, one wording on the front door, Settings and Changes (finding 2.1) ──
  'history.fact.read': same('{n} commits read into history', 'Commits Farsight has read from git for these sources, whether or not a sync ever built a graph from them.'),
  'history.fact.readOne': one('1 commit read into history', 'history.fact.read'),
  'history.fact.ingested': same('{n} ingested by a sync', 'Of the commits read, those a sync built a graph from: what each did to the graph is known.'),
  'history.fact.notYet': same('{n} not yet', 'Of the commits read, those no sync has built a graph from yet: Farsight can name the files they touched, not what they did to the graph.'),
  // ── the glossary strip ──
  'journeys.glossary.title': same('Words this app leans on', 'The application’s own words, from the glossary its Farsight config files give: what each name means in this business.'),
  'journeys.glossary.all': same('the glossary', 'Every word the glossary gives, with what it means and the file it comes from.'),
  'journeys.glossary.none': same('no farsight.config.json in scope gives a glossary', 'A glossary block in a Farsight config file names the application’s own words; until one does, this strip has nothing to show.'),
  'journeys.glossary.term': same('the name in the code'),
  'journeys.glossary.file': same('from'),
  // ── an address with nothing at it (finding 3.2) ──
  'shell.nowhere': same('There is nothing at this address', 'The link names a page this build of Farsight does not have. It may come from another version, or a word in it was mistyped.'),
  'shell.nowhereDoor': same('go to the front door'),
  // ── read-only: a write control says why and who to ask (finding 3.1) ──
  'sys.readonly.page': sys('Read-only session — every change on this page is greyed out, because the server refuses it. Ask whoever runs this server to sync or to change a tracker item.'),
  'sys.readonly.workPane': sys('This server is read-only: tracker writes are refused here, so the controls below are greyed out.'),
  'sys.readonly.themeHint': sys('previewing in this window only — this read-only server keeps no settings'),
};
