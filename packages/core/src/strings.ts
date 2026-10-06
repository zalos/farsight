/**
 * Two-register string catalog (V3 build plan §2.7).
 *
 * Every user-facing string in the viewer chrome lives here once, with a
 * `hud` register (game vocabulary) and a `professional` register (the words
 * that leave the building in exports and screenshots). Rules encoded, not
 * just documented:
 *
 *  - keys under `sys.*` are invariant — errors and permission/safety text use
 *    the same words in both registers (enforced at construction time);
 *  - export/print paths call `t(key, 'professional')` unconditionally;
 *  - `define` supplies the first-use tooltip for jargon terms and feeds the
 *    per-surface jargon budget in scripts/lint-strings.mjs;
 *  - placeholders like `{n}` are substituted by the caller (`t()` stays pure).
 *
 * Served to the viewer at /api/strings; rendered in full (both registers) on
 * the /grammar fixture page. A string that is not in this catalog cannot
 * render in the chrome — that is the lint's contract.
 */

import { WORK_HUD_STRINGS } from './strings-work-hud.js';
import { MAP_STRINGS } from './strings-map.js';
import { DEPS_STRINGS } from './strings-deps.js';
import { CONFIG_STRINGS } from './strings-config.js';
import { JOURNEYS_STRINGS } from './strings-journeys.js';
import { DOOR_STRINGS } from './strings-doors.js';
import { GATE_STRINGS } from './strings-gate.js';
import { LIFECYCLE_STRINGS } from './strings-lifecycle.js';
import { CHROME_STRINGS } from './strings-chrome.js';
import { EXPORT_STRINGS } from './strings-export.js';

export type Register = 'hud' | 'professional';

export interface StringEntry {
  hud: string;
  professional: string;
  /** first-use tooltip; also marks the entry as "defined jargon" for the lint budget */
  define?: string;
  /** same words in both registers — mandatory for sys.* (errors, permissions) */
  invariant?: true;
  /** the plural entry this is the singular of; its define is copied in at construction */
  singularOf?: string;
}

/** Shorthand: an entry whose words are identical in both registers. */
function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

/**
 * Shorthand: the singular of a counted entry. Its define is the plural's,
 * copied in after the catalog is built — a reader who opens the tip on
 * "1 screen" needs what a screen is, not the name of another catalog entry.
 */
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

/** Shorthand: a register-invariant system string (errors, permissions, safety). */
function sys(word: string): StringEntry {
  return { hud: word, professional: word, invariant: true };
}

export const STRINGS: Record<string, StringEntry> = {
  // ── navigation (the four tabs) ──────────────────────────────────────────
  'nav.portfolio': {
    hud: 'Command Deck',
    professional: 'Portfolio',
    define: 'The landing overview: every indexed source, its freshness and coverage, at one glance.',
  },
  'nav.journeys': {
    hud: 'Journeys',
    professional: 'Journeys',
    define: 'End-to-end walks of what the code does for one trigger — every screen, call, gate and decision in order.',
  },
  'nav.codemap': {
    hud: 'World Map',
    professional: 'Code map',
    define: 'The repo-altitude map of the indexed systems and how they connect.',
  },
  'nav.changes': {
    hud: 'Patch Notes',
    professional: 'Changes',
    define: 'What changed between two syncs of the graph.',
  },
  'nav.apis': {
    hud: 'Trade Routes',
    professional: 'APIs',
    define: 'Every HTTP API in scope — what each one declares (its OpenAPI spec), what the code implements, who calls it, and where the two disagree.',
  },
  'nav.tests': {
    hud: 'Proving grounds',
    professional: 'Tests',
    define: 'Every test the graph indexes, what each one reaches, and how much of each journey a test has touched.',
  },
  // the WORK surface's words live in strings-work-hud.ts (nav.work, sys.workFailed, work.hud.*)
  ...WORK_HUD_STRINGS,
  // the MAP surface's words live in strings-map.ts (nav.map, map.*, set.flagMap, key.map*)
  ...MAP_STRINGS,
  // the dependencies pass's words live in strings-deps.ts (surf.kind.package, count.unit.packages, importers, journeys reached)
  ...DEPS_STRINGS,
  // the config files pass's words live in strings-config.ts (count.unit.configFiles and its parts)
  ...CONFIG_STRINGS,
  // the journey organisation's words live in strings-journeys.ts (journeys.noGroup, personas, groups, their counts)
  ...JOURNEYS_STRINGS,
  // the doors' words live in strings-doors.ts (door.*, the Map's stale and not-built marks, the board's reading floor)
  ...DOOR_STRINGS,
  // the gate card's words live in strings-gate.ts (gate.*, the gate and config-check counts)
  ...GATE_STRINGS,
  // the status lifecycle's words live in strings-lifecycle.ts (lifecycle.*, its counts and their parts)
  ...LIFECYCLE_STRINGS,
  // the chrome's words live in strings-chrome.ts (the read-only session, the legend's key, Esc on a journey)
  ...CHROME_STRINGS,
  // export's words live in strings-export.ts (export.*, the saved picture's footer, the pinned link and its note)
  ...EXPORT_STRINGS,
  'nav.stewardship': same('Stewardship', 'The debt queue: ungated entries, unconfirmed names and unresolved edges, with owners and age.'),
  'nav.grammar': same('Grammar Book', 'The canonical symbol and string catalog — every glyph and every word this product may use.'),

  // ── chrome ──────────────────────────────────────────────────────────────
  'chrome.search': { hud: 'fast travel…', professional: 'search…' },
  'chrome.searchAria': same('Open search'),
  'chrome.exitFocus': same('exit focus'),
  'chrome.focusPrefix': same('focus:'),
  'chrome.scopePrefix': same('scope:'),
  'set.surfaceByRegister': same('by register — this one opens on {s}'),

  // ── the flow status table (the front door, 01 §5.2) ────────────────────
  'portfolio.sub': same('Every flow the design manifest names, what is built of it, what the contract says, and what proves it runs.'),
  'portfolio.col.flow': same('Flow'),
  'portfolio.col.screens': same('Screens'),
  'portfolio.col.api': same('Operations',
    'The operations of this flow, counted once each: how many its code calls, and how many its contract or design declares that nothing calls. Not how many times they are called — an operation two screens use is one operation.'),
  'portfolio.col.tested': same('Tested'),
  'portfolio.col.erp': same('Reaches the ERP'),
  'portfolio.col.owner': same('Owner'),
  'portfolio.opsCalled': same('{n} called', 'Operations this flow\'s code actually calls, counted once each across the whole flow — an operation two screens call is one operation. A declared operation no code implements is never counted here; those are counted beside it, as declared only. Each operation is counted once, not once per screen that calls it.'),
  'portfolio.erpYes': same('yes — {via} on the path'),
  'portfolio.erpDeclared': same('declared in the spec, not built'),
  'portfolio.personaDerived': same('grouped by screen ids — the manifest does not say'),
  'portfolio.noPersona': same('Not grouped'),
  'portfolio.surfaces': same('Product surfaces'),
  'portfolio.notDeclared': same('not declared'),
  'portfolio.loading': same('reading…'),
  'portfolio.pinned': same('start here'),

  // ── the Journeys front door (01 §5.2) ──────────────────────────────────
  'journeys.startHere': same('New here?'),
  'journeys.startStep1': same('Open the flow marked start here — it runs the product end to end.'),
  'journeys.startStep2': same('Switch the register (top right) to read it as a person, as both, or as code.'),
  'journeys.startStep3': same('Every word on the screen is defined in the grammar.'),
  'journeys.startGrammar': same('Read the grammar'),
  'journeys.startKeys': same('Keyboard shortcuts'),
  'journeys.entryPoints': same('Other ways in'),
  'journeys.entryPointsSub': same('Screens, routes and anything marked as an entry point — a journey can start at any of them.'),
  'chrome.share': same('Share'),
  'chrome.keymapAria': same('Keyboard shortcuts'),
  'chrome.settingsAria': same('Settings'),
  'chrome.modelHub': same('Model Hub'),
  'chrome.sync': same('SYNC', 'One complete re-read of the sources: Farsight parsed the code and wrote a snapshot. Every number on every surface is as of a sync, and the Changes surface counts in them.'),
  'chrome.synced': same('synced'),
  'chrome.syncNever': same('no graph yet'),
  'chrome.more': {
    hud: 'Stowed',
    professional: 'More',
    define: 'The chrome controls this window is too narrow to show in the bar. They are folded in here, not removed — the same buttons, with the same words.',
  },
  'chrome.registerToHud': same('Professional terms · switch to HUD'),
  'chrome.registerToPro': same('HUD terms · switch to professional'),
  'chrome.lens': same('Lens', 'A rendering register for the same nodes: business hides code, code hides business names, hybrid shows both.'),
  'chrome.lensBusiness': same('Business'),
  'chrome.lensHybrid': same('Hybrid'),
  'chrome.lensCode': same('Code'),

  // ── system strings (register-invariant: errors, permissions, safety) ────
  'sys.readonly': sys('READ-ONLY'),
  'sys.readonlySub': sys('viewing changes nothing — click freely'),
  'sys.journeyFailed': sys('Could not run journey.'),
  'sys.httpStatus': sys('HTTP {status}'),
  'chrome.build': same('running build', 'The Farsight build this server process runs — loaded when it started; a later install does not change it until the process restarts.'),
  'chrome.buildInstalled': same('installed build', 'The Farsight build on disk now — what a restarted server would run. When it is a different build from the running one, the chip says RESTART.'),
  'chrome.restartNeeded': same('RESTART', 'A different Farsight build is installed than this server runs — compared build to build (the same code commit with no uncommitted changes, or the same build stamp), never by file dates. Stop the Farsight server and start it again.'),
  'chrome.built': same('built'),
  'chrome.graphIngestedBy': same('graph ingested by'),
  'sys.journeyOldServer': sys('This graph server predates the blueprint timeline — rebuild and restart it.'),
  'sys.noGraph': sys('no graph yet — sync sources in settings or run farsight ingest'),
  'sys.truncated': sys('truncated'),
  'sys.stringsFailed': sys('string catalog unavailable — showing raw keys'),

  // ── status words (always rendered glyph + word, never color alone) ──────
  'status.live': same('LIVE'),
  'status.stale': same('STALE', 'Data valid, aging — the last sync is old, not broken.'),
  'status.syncFailing': same('SYNC FAILING', 'The last sync failed; the view shows the last good snapshot. Distinct from STALE.'),
  'status.violation': same('VIOLATION', 'A rule is broken — for example, a guard bypassed. Never reused for pipeline failures.'),
  'status.warning': same('WARNING'),
  'status.trend': same('TREND'),
  'status.incomplete': same('INCOMPLETE', 'A decision arm that stops the flow — the user is told why. Its terminal is the barred ring, never the violation hexagon.'),

  // ── the 12 business symbols (words; drawings live in the SVG sprite) ────
  'sym.start': same('START'),
  'sym.step': same('FUNCTION'),
  'sym.decision': same('DECISION'),
  'sym.gate': same('GATE', 'A permission or validation check that must pass before the work behind it runs. Amber padlock, always.'),
  'sym.record': same('RECORD'),
  'sym.message': same('MESSAGE'),
  'sym.external': same('EXTERNAL'),
  'sym.screen': same('SCREEN'),
  'sym.human': same('HUMAN TASK'),
  'sym.automation': same('AUTOMATION'),
  'sym.interchange': same('INTERCHANGE', 'A screen or call shared with at least one other journey.'),
  'sym.hotspot': same('HOTSPOT'),

  // ── keymap (published panel; keys bound centrally in app/keymap.js) ─────
  'key.b': {
    hud: 'Blast radius for the selected item',
    professional: 'Change impact — what uses this?',
    define: 'Opens what uses the selected thing, by distance. Inside a journey it opens the answer for the open part. A path is not a claim that a change travels along it, so the question is "what uses this", never "what does this break".',
  },
  'key.jk': same('Next / previous part of the open journey'),
  'key.f': same('Focus the selected item (again to clear)'),
  'key.cmdk': { hud: 'Fast travel', professional: 'Search' },
  'key.y': same('Copy a link to this view'),
  'key.help': same('Show this keymap'),
  'key.tip': same('Details of a dotted-underlined number or word',
    'Click it, rest the pointer on it, or focus it and press Enter. A number’s details say what it counts, what it counts over and where it came from. Esc closes them first.'),
  'key.esc': same('Close the top panel'),
  'key.l': same('Rows / ladder in the journey band'),
  'key.v': same('Timeline / sheet / drill — the journey view'),
  'key.brackets': same('Previous / next action in the journey drill'),
  'key.d': same('Code pane in place / bottom / right'),
  'key.t': same('Tests — the Tests surface, or the tests list of the open part of a journey', 'Outside a journey it opens the Tests surface; with a journey open it opens the open part’s tests list. One key, one question: what proves this runs?'),
  'keymap.title': same('Keymap'),
  'keymap.sub': same('Every shortcut also has a visible button — keys are the fast path, never the only path.'),

  // ── jargon terms (HUD → professional, with first-use definitions) ───────
  'term.fog': {
    hud: 'fog of war',
    professional: 'not yet indexed',
    define: 'Parts of the codebase Farsight has not indexed. Fog means absence of data — never zero, never "no".',
  },
  'term.blastRadius': {
    hud: 'blast radius',
    professional: 'change impact',
    define: 'Everything a change to one item can reach: callers, records, messages, gates, journeys.',
  },
  'term.unresolved': same('unresolved', 'A call the graph could not follow to any indexed source — the "?" stub. Absence of evidence, never "no".'),
  'term.fastTravel': {
    hud: 'fast travel',
    professional: 'search',
    define: 'Jump straight to any node by name (⌘K).',
  },
  'term.quest': {
    hud: 'guided review quest',
    professional: 'guided review',
    define: 'A checklist walk through part of the system. Creates a checklist for you — does not touch code, no one is notified.',
  },

  // ── share menu (placeholder until P5 ships export) ──────────────────────
  'share.title': same('Share'),
  'share.liveLink': same('Copy live link'),
  'share.liveLinkSub': same('this URL, always showing the latest sync'),
  'share.copied': same('copied'),
  'share.pinned': same('Pinned link'),
  'share.export': same('PNG / PDF export'),
  'share.notYet': same('Pinned links need snapshot history (pass P1); pinned links, PNG/PDF export and the embed card ship with the share pass (P5). Nothing here is disabled for effect — it does not exist yet.'),

  // ── change impact (B5.4 · docs/proposals/dependency-impact.md §4) ───────
  // What uses a node, by distance and never summed. Every word here is the one
  // the CLI printer and the MCP tool already use — one reader meets all three,
  // and a third vocabulary for one fold is the drift this phase exists to end.
  'impact.title': {
    hud: 'Blast radius',
    professional: 'Change impact',
    define: 'What uses this, by distance — what uses it directly first, then what reaches it through those. The numbers are read one at a time and never added together.',
  },
  'impact.scope': same('on what uses this part', 'What every number in this panel counts over: the parts that use this one — directly, then through those — and the tests that reach them. Not the tests of this part itself (the foot counts those, for this part alone) and not those of the action it belongs to (in this action), so the three can differ and none of them contradicts another.'),
  'impact.of': same('what uses {name}', 'The question this panel answers: which indexed things reach this one, and how far away each of them is.'),
  'impact.clause.direct': same('{n} use it directly', 'One edge from this node: something reads, writes, calls, guards or renders it.'),
  'impact.clause.through': same('{n} more reach it through those', 'A path of two edges or more. A path, not a prediction: it does not say a change travels along it.'),
  'impact.clause.far': same('{n} more at {h} hops', 'Further out again. Past four hops "reaches it through three others" describes the application, not a dependency.'),
  'impact.notASum': same('read one at a time; they are never added together', 'These counts answer different questions and overlap by design. One number over all of them is the haystack this fold replaced.'),
  'impact.hop1': same('uses it directly', 'The first ring: one edge from the seed, with that edge’s own verb.'),
  'impact.hop2': same('reaches it through those', 'The second ring: two edges out, through something in the first.'),
  'impact.hopN': same('reaches it through {n} others', 'Further rings: the number of things standing between this one and the seed.'),
  'impact.strength': {
    hud: 'how we know: {tier} · {n} record nothing',
    professional: 'resolution on this path: {tier}, with {n} edge(s) recording none',
    define: 'The weakest technique recorded anywhere on the path, and how many edges on it recorded none. A path is only as well known as its weakest edge.',
  },
  'impact.notRecorded': {
    hud: 'how we know: not recorded',
    professional: 'the adapter recorded no technique for this edge',
    define: 'Not a confidence level, and not an absence of the edge — an absence of provenance about it. It ranges from a certain same-file call to a guard inferred from a shape.',
  },
  'impact.oneOf': {
    hud: 'one of several — chosen at run time',
    professional: 'one of several implementations; the call site resolves to {chosen} and sets aside {n}',
    define: 'The code picks at run time. Counting them all would overstate, counting one would understate, so both facts are kept.',
  },
  'impact.external': {
    hud: 'on the path · what travels is not indexed',
    professional: 'on the path; which fields travel is not indexed',
    define: 'Farsight follows calls, not data. That a call happens is not a claim about what is carried over it.',
  },
  'impact.sharedHere': same('shared — listed, not opened', 'A helper used all over the code is listed where it is met and not expanded: opening it would report the application rather than this dependency.'),
  'impact.behind': same('{n} behind it', 'Everything upstream of a stop that this answer does not already list — a different number from how many use the stop itself, and never added to it.'),
  'impact.notWalked': same('not walked', 'Where this answer stopped, and how much stands behind each stop. Two stops often sit in front of the same things, so these counts are never added.'),
  'impact.cut.hops': {
    hud: '{n} more behind the {h}-hop edge',
    professional: '{n} more node(s) one hop further out, behind {stops} stop(s)',
    define: 'The budget, drawn. What you have not seen is part of the answer.',
  },
  'impact.cut.hopsOnly': same('{n} stop(s) — {max} hops is as far as this answer goes', 'The budget ran out and the ring beyond it was not counted, because five hops is where this question stops meaning anything.'),
  'impact.cut.shared': {
    hud: '{name} is shared by {n} — not opened',
    professional: '{name} is used by {n} things; opening it would report the application',
    define: 'Plumbing and rendered primitives are stopped by the same rule that keeps them out of the coverage denominator.',
  },
  'impact.cut.cap': {
    hud: '{n} at this distance — grouped',
    professional: '{n} dependent(s) found at this hop and not listed',
    define: 'Too many to list is a fact, not a reason to truncate silently: found, listed and behind are three numbers and all three are printed.',
  },
  'impact.excluded.setup': {
    hud: 'start-up, once',
    professional: 'reached only through container construction',
    define: 'The boot is not a dependent. Listed apart, never summed into a hop.',
  },
  'impact.excluded.deferred': {
    hud: 'afterwards',
    professional: 'registered here, run later by something else',
    define: 'Deferred work, reported apart from the request-time answer.',
  },
  'impact.bound.floor': same('≥ a floor: {why}', 'A floor whenever anything was cut, capped, unrecorded or resolved at run time — which on today’s graphs is always. The reason is printed with the number.'),
  'impact.bound.exact': same('exact: nothing was cut and every path records how it was resolved', 'The only state in which a count here is the whole answer.'),
  'impact.none': same('none indexed — nothing here uses it', 'Nothing in the indexed code reaches this. Code in a source this workspace does not index is not visible, so this is a statement about the index, not about the world.'),
  'impact.reading': same('reading what uses this…', 'The fold runs per request; nothing is cached between graphs.'),
  'impact.unavailable': same('This build of the server does not answer what-uses-this yet.', 'The panel asks /api/impact; an older server has no such endpoint and the door stays shut rather than showing an empty answer.'),
  'impact.door': {
    hud: 'Blast radius',
    professional: 'What else uses this',
    define: 'Opens the change-impact panel on this node: what uses it directly, what reaches it through those, and what was not walked.',
  },
  'impact.testsDirect': same('tests reaching what uses it directly: {list}', 'The tests that cover the things one edge away. The same set under the same words as the command line and the agent surface.'),
  'impact.testsSoFar': same('tests reaching hops 1–{h}, each test once: {list}', 'The union, not a sum: every test that reaches anything listed from the first distance up to this one, counted once however many of those things it reaches. It can stay level or grow from one distance to the next and never goes down. The command line and the agent tool print the same set under the same words.'),
  'impact.hops.label': {
    hud: 'range',
    professional: 'how far',
    define: 'How many links out from the part asked about this answer walks. One is what uses it directly; each link further adds what uses those. Five is as far as it goes: past that, "reaches it through others" describes the whole application.',
  },
  'impact.hops.button': same('walk {n} links out', 'Asks the same question again, this many links out. The choice rides in the link, so a copied link opens on the same answer.'),
  'impact.hops.buttonOne': one('walk 1 link out', 'impact.hops.button'),
  'impact.ring.direct': same('solid ring — uses it directly', 'On the sheet: a solid ring marks the first distance, one edge from the thing you asked about.'),
  'impact.ring.through': same('dashed ring — reaches it through others', 'On the sheet: a dashed ring marks two edges or more. Shape, not colour, so it survives a greyscale print.'),
  'impact.ring.stop': same('⋯ after a name — the answer stopped here', 'The walk did not go past this one, so more stands behind it. A second fact about a thing that also has a distance, so it is a second mark and not a different ring.'),
  'impact.ring.behind': same('dotted ring — a stop, reported apart', 'On the sheet: a dotted ring marks something the answer names but does not count as a dependent — start-up work, work that runs later, or a shared helper it would not open.'),
  'impact.halo': same('{d} direct · {t} through others · {c} behind what was not walked', 'Three answers to three questions. They overlap and are never added.'),
  'impact.seedRing': same('double ring — the thing you asked about', 'On the sheet: a double ring marks the seed of this answer, wherever the journey draws it.'),
  // the business register: one sentence, its evidence clause, and its bound.
  // No identifier, no file, no arithmetic in distances (lint RULE 5).
  // The sentence is assembled from parts that each agree in number with their own
  // count (story swarm 2026-09-25: *1 things use*, *1 tests reach them*): the
  // viewer picks `<key>One` when the count is one, as every other count does.
  'impact.biz.line': {
    hud: '{uses} directly, in {actions} across {journeys}.',
    professional: '{uses} directly, in {actions} across {journeys}.',
    define: 'The business sentence: how many things use it, where that shows up for a person, and what evidence stands behind a change to it.',
  },
  'impact.biz.uses': same('{n} things use {subject}', 'How many parts of the system use this one directly — one connection away, each counted once.'),
  'impact.biz.usesOne': one('1 thing uses {subject}', 'impact.biz.uses'),
  'impact.biz.actions': same('{n} actions', 'The distinct things a person does, inside the journeys below, that reach something using this.'),
  'impact.biz.actionsOne': one('1 action', 'impact.biz.actions'),
  'impact.biz.journeysOf': same('{n} of {m} journeys', 'How many of the workspace\'s journeys reach something that uses this, out of every journey the workspace holds.'),
  'impact.biz.journeysOfOne': one('1 of {m} journeys', 'impact.biz.journeysOf'),
  'impact.biz.journeysOnly': same('the one journey in this workspace', 'The workspace holds a single journey, and it reaches something that uses this.'),
  'impact.biz.lineNoFlow': same('{uses} directly. No journey in this workspace reaches it.', 'Nothing a person walks through reaches this, so the sentence says so rather than leaving the reader to infer it.'),
  'impact.biz.evidence.none': same('Because no test reaches anything that uses it, a change here would be caught by nothing this workspace can see.', 'The evidence clause is always the because clause: it is the half a business reader can act on.'),
  'impact.biz.evidence.direct': same('Because {n} tests reach what uses it directly, a change here would be caught by those tests and no others.', 'Tests that cover the things using it directly.'),
  'impact.biz.evidence.directOne': one('Because 1 test reaches what uses it directly, a change here would be caught by that test and no other.', 'impact.biz.evidence.direct'),
  'impact.biz.evidence.near': same('Because nothing that uses it directly has a test of its own, a change here would be caught only by the {n} tests that reach what uses those.', 'The nearest evidence is one distance further out — worth saying, because it is weaker than it looks.'),
  'impact.biz.evidence.nearOne': one('Because nothing that uses it directly has a test of its own, a change here would be caught only by the 1 test that reaches what uses those.', 'impact.biz.evidence.near'),
  'impact.biz.noE2e': same('No end-to-end test touches anything that uses it.', 'No test that drives the product from the outside reaches this, whatever the unit tests do.'),
  'impact.biz.floor': same('This is the fewest it could be, not the whole: {why}.', 'Every count here is a floor while anything was left unwalked, unrecorded or decided while the program runs.'),
  'impact.biz.why.cut': same('some paths were not followed to the end', 'The answer stopped at a set distance, so more stands behind it.'),
  'impact.biz.why.runtime': same('some calls are decided while the program runs', 'Where the code chooses between several implementations, which one is used is not fixed in the code.'),
  'impact.biz.why.unrecorded': same('how some of these connections were found was not written down', 'The tool knows the connection exists and not how it proved it.'),
  'impact.biz.journeys': same('where this shows up', 'The journeys a person walks that reach this, and how many actions inside them.'),
  'impact.biz.rings': same('On the sheet, a ring marks everything that uses this.', 'The rings are drawn by shape — solid, dashed, dotted — so they read the same in colour and in grey.'),

  'impact.nothingSelected': same('Select an item first — click any card, then press b.'),

  // ── surface placeholders (honest states: say what ships when) ───────────
  // `ph.changes.*` retired by chunk H6: the Changes words are in the catalog
  // under `changes.*` and the surface renders them (change-history-2026-09 §7).
  'ph.portfolio.title': same('Portfolio ships in pass P3'),
  'ph.portfolio.body': same('This surface will carry the KPI row (sources · indexed · journeys · guard coverage · described), each number with a provenance popover — formula, scope, as-of, origin, uncertainty and a clickable evidence list — plus the per-source table and freshness legend. It needs the scope and metrics engine (core/scope.ts, core/metrics.ts) that pass P3 builds. No number renders here until it can carry its provenance.'),
  'ph.stewardship.title': same('Stewardship ships in pass P8'),
  'ph.stewardship.body': same('This surface will carry the debt queue: ungated route entries, machine-named unconfirmed items, unresolved edges and suspect answers — each with age, a suggested owner (always a group, never a person) and a verb-consequence action.'),
  'ph.codemap.note': same('Interim view: this is today’s graph, serving as the Code map until the repo-altitude view (group cards, supply view, per-edge confidence) ships in pass P4.'),
  'ph.supply.title': same('The supply view ships in pass P4'),
  'ph.supply.body': same('This toggle will show per-edge resolution — REACHABLE (resolved) / heuristic with a confidence tier / UNRESOLVED with a "?" stub — once every edge is stamped with how it was found (pass P4). Until then the map toggle shows the interim graph.'),
  'journeys.pickerTitle': same('Journeys'),
  'journeys.pickerSub': same('Pick an entry point — a flow the design declares, a screen, a route, or anything marked as an entry point. Every journey reads as one blueprint: what the user sees, what the business promises, and what the system does.'),
  'journey.planned': same('planned'),
  'journey.plannedNote': same('declared in the spec — not yet built'),
  'journey.plannedGate': same('required by the spec — not yet enforced'),
  'journey.planned.receives': same('receives'),
  'journey.planned.step': same('does'),
  'journey.planned.returns': same('returns'),
  'journey.plannedCount': same('{n} planned',
    'Parts walked from the contract rather than from code: the spec declares the operation and nothing implements it. Counted apart from the parts that exist.'),
  'journeys.pickerEmpty': same('No entry points in the current scope — routes, pages and @entrypoint-tagged functions appear here.'),

  // ── model hub panel ─────────────────────────────────────────────────────
  'mh.unavailable': sys('model hub state unavailable'),
  'mh.ollamaEmpty': same('not reachable / no models installed'),
  'mh.noCategories': same('no registry categories'),
  'mh.noTools': same('no tools'),
  'mh.noChains': same('no chains'),
  'mh.noAgents': same('no agent sessions observed yet'),

  // ── APIs surface (docs/proposals/openapi-surface.md) ────────────────────
  'apis.sub': same('One card per API: spec-backed surfaces come from an OpenAPI/Swagger document; implied surfaces are the routes a source serves with no spec on file. Counts name their definition on hover and are limited to the current scope.'),
  'apis.loading': same('loading API surfaces…'),
  'apis.empty': same('No HTTP routes in the current scope — nothing to list. Widen the scope, or ingest a source that serves routes or ships an OpenAPI document.'),
  'apis.kindSpec': same('spec on file'),
  'apis.kindImplied': same('no spec on file — implied from the code'),
  'apis.open': same('Open'),
  'apis.back': same('All APIs'),
  'apis.scopeLabel': same('scope'),
  'apis.count.operations': same('operations'),
  'apis.count.implemented': same('implemented'),
  'apis.count.notImplemented': same('not implemented'),
  'apis.count.declared': same('declared'),
  'apis.def.declared': same('operations the spec names — implemented or not'),
  'apis.specSource': same('spec-only source — no code in it to compare against, so "not implemented" is not a gap here'),
  'apis.count.undocumented': same('undocumented'),
  'apis.count.consumers': same('consumers'),
  'apis.count.drift': same('drift'),
  'apis.count.gated': same('gated'),
  'apis.def.operations': same('route nodes on this surface, in scope — declared in the spec, implemented in the code, or both'),
  'apis.def.implemented': same('operations with a source location in the indexed code'),
  'apis.def.notImplemented': same('operations the spec declares that no indexed code implements'),
  'apis.def.undocumented': same('implemented routes the spec does not declare (only counted when the source has a spec)'),
  'apis.def.consumers': same('inbound HTTP call edges from indexed code — a client function calling this operation'),
  'apis.def.drift': same('facts where the spec and the code disagree, summed over operations'),
  'apis.def.gated': same('operations with at least one permission gate enforced in the code'),
  'apis.tab.ops': same('Operations'),
  'apis.tab.spec': same('Spec file'),
  'apis.tab.compare': same('Compare a proposed spec'),
  'apis.col.operation': same('Operation'),
  'apis.col.summary': same('What it does'),
  'apis.col.gates': same('Gates'),
  'apis.col.consumers': same('Consumers'),
  'apis.col.status': same('Status'),
  'apis.untagged': same('untagged'),
  'apis.status.both': same('declared + implemented'),
  'apis.status.specOnly': same('not implemented'),
  'apis.status.codeOnly': same('undocumented'),
  'apis.status.implemented': same('implemented — no spec'),
  'apis.status.declared': same('declared — spec-only source'),
  'apis.drift.spec-only': same('not implemented'),
  'apis.drift.code-only': same('undocumented'),
  'apis.drift.security-missing-in-code': same('security not enforced in code'),
  'apis.drift.security-missing-in-spec': same('gate not declared in spec'),
  'apis.drift.security-mismatch': same('security mismatch'),
  'apis.drift.deprecated-in-spec-only': same('deprecated in spec only'),
  'apis.drift.body-undeclared': same('request body not declared'),
  'apis.drift.body-unvalidated': same('request body not validated'),
  'apis.drift.security-declared-only': same('gate declared in config, not detected in code'),
  // the drift count is a button into the per-kind sentences, never a defect score
  'apis.drift.count': same('what differs · {n}'),
  'apis.drift.securityNote': same('the spec cannot declare same-origin and rate-limit checks as security schemes, so a gate the code enforces can be missing from it without either being wrong'),
  'insp.links': same('References'),
  'insp.design': same('Design'),
  'insp.designOpen': same('Open design'),
  'design.status.both': same('designed + built'),
  'design.status.designOnly': same('designed, not built'),
  'design.status.codeOnly': same('built, not designed'),
  'design.phase': same('phase'),
  'design.modified': same('design modified'),
  'design.freshFigma': same('from Figma'),
  'design.freshManifest': same('from the manifest'),
  'design.uses': same('uses'),
  'design.drift.design-only': same('designed, not built'),
  'design.drift.code-only': same('built, not designed'),
  'design.drift.operation-not-in-spec': same('operation not in the spec'),
  'design.drift.operation-unreached': same('operation never reached from this screen'),
  'design.drift.operation-undeclared': same('screen calls an operation the design does not list'),
  'design.drift.screen-unknown': same('flow names a screen the manifest does not define'),
  'design.drift.flow-unknown': same('flow names another flow the manifest does not define'),
  'design.scope.manifest': same('across this design manifest', 'What the number counts over: every screen and flow this one manifest names, matched against the indexed code of its source.'),
  'design.scope.screen': same('on this screen', 'What the number counts over: this one screen of the manifest and the page that builds it.'),

  // ── design (Pass C) ─────────────────────────────────────────────────────
  // The screen band on a journey, the Designs front door on the Journeys
  // surface, and the words a planned call from the design uses.
  'journey.screens': same('Screens'),
  'journey.screensSub': same('The screens this journey runs through, as they were designed.'),
  'journey.planned.calls': same('calls (planned)'),
  'design.plannedCall': same('planned call · from the design'),
  'design.title': same('Designs'),
  'design.sub': same('Screens a design manifest declares, matched against the pages the code really has.'),
  'design.count.screens': same('screens', 'Every screen this design source touches: rows in the manifest plus pages the code has that the manifest does not describe.'),
  'design.count.designed': same('designed', 'Screens the manifest declares.'),
  'design.count.built': same('built', 'Declared screens that resolved to a page or component in the indexed code.'),
  'design.count.designOnly': same('not built', 'Declared screens with no page or component in the indexed code yet.'),
  'design.count.codeOnly': same('not designed', 'Pages in the code that no screen in the manifest describes.'),
  'design.count.drift': same('drift', 'Disagreements between the manifest and the code, one per difference found, counted across every screen and flow the manifest names. A screen not built yet is one of them, so drift is not a count of defects: the breakdown says which kind each is.'),
  'design.notBuilt': same('Designed, not built'),
  'design.built': same('Built'),
  'design.openFigma': same('Open in Figma'),
  'design.noImage': same('no render — open the design'),
  'design.lightboxClose': same('Close'),
  'design.manifest': same('manifest'),
  'design.flows': same('Flows'),
  'design.count.flows': same('flows', 'Named journeys the design declares — an ordered set of screens a person moves through.'),
  'design.runJourney': same('Run journey'),
  'journey.openJourney': same('Open journey'),
  'design.screensBuilt': same('{b} of {n} screens built'),
  'design.docs': same('Documentation'),
  'design.flowScreens': same('Screens in order'),

  // ── the three-band blueprint (journey overlay) ──────────────────────────
  // Band 1 is what a person sees, band 2 what the business promises, band 3
  // what the system actually does — one feature read top to bottom.
  'journey.bandUser': same('What the user sees'),
  'journey.lineOfVisibility': same('Line of visibility', 'The line a service blueprint draws between what a person experiences and the work that happens behind it.'),
  'journey.bandBusiness': same('The business'),
  'journey.bandSystem': same('What the system does'),
  'journey.bandData': same('Records & messages'),
  'journey.gates': same('Gates'),
  'journey.rules': same('Rules'),
  'journey.decisions': same('Decisions'),
  'journey.components': same('Components'),
  'journey.countSteps': same('{n} visits',
    'Every time the walk through the code arrived at a part — a function, a component, a call, a gate — a second arrival at the same part counted again. The walk’s own unit, not a count of anything a person does, and not a position: a part has no number of its own. On a cell it is that cell’s; on the header it is the journey’s.'),
  'journey.countStepsOne': one('1 visit', 'journey.countSteps'),
  // The same cell in the business register, which does not count in steps:
  // RULE 5 bans the word from `journey.biz.*` in both registers, so the lint
  // guards this pair where it could not guard `journey.countSteps` itself.
  // Nothing about the number changes — only what the number is called.
  'journey.biz.countSteps': same('{n} things happen here',
    'How many parts of that system took part in this action. The other registers list them by name; the business register counts them.'),
  'journey.biz.countStepsOne': same('1 thing happens here',
    'One part of that system took part in this action. The catalog pairs a singular with its plural wherever a count can be 1.'),
  // Gates and validation rules together: the header's number always counted
  // both, and printed the one word, beside a lane tab titled *Gates & rules*
  // with the same 34 on it (pass swarm 2026-09-25). One concept, one name.
  'journey.countGates': same('{n} gates & rules',
    'Distinct checkpoints this journey meets — gates (who is allowed in) and validation rules (what the data must match) — counted once each by name, however many screens meet them. The same number the lane\u2019s Gates & rules tab carries. How many times they were met is counted separately as checks, which is the larger number.'),
  'journey.countGatesOne': one('1 gate or rule', 'journey.countGates'),
  'journey.countDecisions': same('{n} decisions',
    'Places this journey can go differently that are drawn as a decision, counted once each across the journey. The business register draws only the ones somebody put in words and folds the rest into its not-written-in-plain-language sentence.'),
  'journey.countDecisionsOne': one('1 decision', 'journey.countDecisions'),
  'journey.kind.screen': same('screen'),
  'journey.kind.step': same('part'),
  'journey.kind.call': same('call'),
  'journey.kind.gate': same('gate'),
  'journey.kind.rule': same('rule'),
  'journey.kind.decision': same('decision'),
  'journey.kind.record': same('record'),
  'journey.kind.message': same('message'),
  'journey.kind.external': same('external'),
  'journey.kind.planned': same('planned'),
  'journey.op.reads': same('reads'),
  'journey.op.writes': same('writes'),
  // the blueprint timeline (docs/proposals/blueprint-timeline.md · option C)
  'journey.countScreens': same('{n} screens',
    'How many screens this journey names, in the order a person meets them: the screens its design declares, or the ones the walk found when there is no design. A screen met twice is one screen. The split says how many of them the walk through the code reached.'),
  'journey.countScreensOne': one('1 screen', 'journey.countScreens'),
  'journey.countCalls': same('{n} calls',
    'Calls across the seam in this one cell — this screen, or this action of it. A cell’s number is its own; the journey’s is on the header.'),
  'journey.countRecords': same('{n} records',
    'Tables read or written in this one cell. The journey’s own total is on the header, where each table is counted once.'),
  'journey.countMessages': same('{n} messages',
    'Queues, events and outbox writes in this one cell.'),
  // The singular halves of the three cell counts a business reader actually
  // sees. A cell can hold exactly one, and "1 records" beside a number is how
  // a register loses a reader's trust in the numbers next to it. The catalog's
  // own precedent for pairing is `journey.againOne` / `tests.runOnlyOne`.
  'journey.countCallsOne': one('1 call', 'journey.countCalls'),
  'journey.countRecordsOne': one('1 record', 'journey.countRecords'),
  'journey.countMessagesOne': one('1 message', 'journey.countMessages'),
  'journey.countSystems': same('{n} systems',
    'How many rows the journey’s system band has: the browser, each API, the service, the records, the messages, each third party. One row per system, journey-wide.'),
  'journey.countSystemsOne': one('1 system', 'journey.countSystems'),
  'journey.countStores': same('{n} data stores',
    'The places this journey keeps or fetches its data, each counted once by name: the database its records live in, and each outside system it reads from or writes to as a store. A store is named only when the code or the project settings say which one; records whose store nobody named are not counted. A count of stores, not of tables: many tables live in one database, so two stores can hold a dozen tables.'),
  'journey.countStoresOne': one('1 data store', 'journey.countStores'),
  'journey.start': same('start'),
  'journey.end': same('end of tracked flow'),
  'journey.verb.first': same('the user'),
  'journey.verb.then': same('then'),
  'journey.beforeFirstScreen': same('before the first screen'),
  'journey.startsAt': same('starts at'),
  'journey.bizSub': same('Gates, rules and decisions in words, in the order they are met.'),
  // the business lane's three views. One control for the whole lane, and every
  // count is on it whether or not that view is open — a reader must always be
  // able to tell "there are none here" from "they are not shown here".
  'journey.bizTabs': same('What the business lane draws',
    'The business lane always says what happens in words. This chooses what it draws underneath: nothing more, the gates and rules it met, or every decision with the paths it can take.'),
  'journey.bizTab.words': same('In words',
    'What a person wrote for this part of the journey: the sentence for each screen, and every decision someone described in words, named once each. Where the lane opens. The number is the lines the view draws across the whole journey, so it never reads 0 above words.'),
  'journey.bizTab.gates': same('Gates & rules',
    'What has to be true before this part of the journey goes through: every gate and validation rule the walk met, once each, with how many times it was met. The number counts them across the whole journey, each one once — the same basis the journey header prints. A checkpoint met on three screens is one gate here and appears in all three screens’ lists.'),
  'journey.bizTab.decisions': same('Decisions',
    'Every place the journey can go differently, drawn in full: the condition, the path it took, and each path it did not — including the ones only the code names, which the business lens folds into its not-written-in-plain-language sentence instead. The number counts them across the whole journey, each one once — the same basis the journey header prints.'),
  // the gates & rules view: two lists, not one cloud of cards. The heading on
  // each list carries THIS screen's count; the control above carries the
  // journey's. Two bases, both named, neither guessed at.
  'journey.bizGroup.gates': {
    hud: 'Who is allowed in',
    professional: 'Gates',
    define: 'Checkpoints that have to pass before this part of the journey goes through — who is signed in, who owns the thing, what the rate limit allows. Listed in the order the walk met them.',
  },
  'journey.bizGroup.rules': {
    hud: 'What the data must match',
    professional: 'Validation rules',
    define: 'Declared shapes the data has to match before it is accepted. Listed in the order the walk met them.',
  },
  'journey.bizGroup.words': {
    hud: 'Written in words',
    professional: 'Decisions written in words',
    define: 'The places this part of the journey can go differently that somebody described in words, rather than leaving the condition to speak for itself.',
  },
  'journey.sameWords': same('{i} of {n} places with this name',
    'Two or more checkpoints here carry the same declared phrase, and this register does not print the identifier that would tell them apart. They are different places in the code, each with its own link — not one row drawn twice.'),
  'journey.scopeAll': same('across this journey',
    'What the number beside it counts over: the whole journey, each thing counted once however many screens meet it.'),
  'journey.scopeHere': same('on this screen',
    'What the number beside it counts over: this screen only. A thing met on three screens is counted on each of them, so these numbers do not add up to the journey’s.'),
  'journey.gateTimes': same('met {n} times',
    'How many times this one checkpoint was met on this screen. It is one checkpoint either way — the journey header counts checkpoints, and counts the meetings separately.'),
  'journey.biz.noneInWords': same('none of these is written in plain language',
    'Every one of them is a name out of the code and nobody declared words for any of them, so this list has a count and no rows. Said as “none” rather than as a number equal to the count, which reads as though some of them were shown.'),
  'journey.biz.notInWords': same('{n} of these are not written in plain language',
    'This tool prints the words a developer declared for a checkpoint. Where none were declared, or where what was declared is a name out of the code, it says so rather than inventing a sentence. Switch to the hybrid or code lens to read them as the code names them.'),
  'journey.bizDocs': same('{n} documents',
    'The product documents this journey points at. Opened here so the lane’s height is set by what it is showing, not by how many documents a flow happens to name.'),
  'journey.rowsSub': same('One row per system this journey touches.'),
  'journey.row.api': same('API'),
  'journey.row.records': same('Records'),
  'journey.row.messages': same('Messages'),
  'journey.row.external': same('Third party'),
  'journey.rowSub.api': same('declared operations'),
  'journey.rowSub.repo': same('the functions and components that run'),
  'journey.rowSub.records': same('tables read / written'),
  'journey.rowSub.messages': same('queues, events, outbox'),
  'journey.rowSub.external': same('called over the network'),
  // deferred work reached inside an action — a hook or callback that runs later, on its own (never walked)
  'journey.row.afterwards': same('Afterwards'),
  'journey.rowSub.afterwards': same('runs later, on its own — hooks and callbacks the action registered'),
  'journey.rowPlanned': same('declared, not built'),
  'journey.row.ux': same('The screen asks'),
  'journey.row.server': same('The service does'),
  'journey.rowSub.ux': same('browser'),
  'journey.rowSub.server': same('server'),
  'journey.actionsSub': same('One row per system · one column per action of the screen.'),
  'journey.stillOpen': same('still open'),
  'journey.seam.from': same('from'),
  'journey.seam.handled': same('handled'),
  'journey.seam.notBuilt': same('not built yet'),
  'journey.seam.methodAssumed': same('method assumed',
    'The code that makes this call does not name its HTTP method, and more than one endpoint answers at this address. The read (GET) endpoint is shown because that is what a request sends when no method is given; the others are kept as candidates.'),
  'journey.seam.uxSide': same('where the UX makes the call'),
  'journey.seam.apiSide': same('where the API starts'),
  'journey.seam.continues': same('continues'),
  'journey.contractHead': same('Contract'),
  'journey.contract.does': same('does'),
  'journey.contract.requires': same('requires'),
  'journey.contract.returns': same('returns'),
  'journey.contract.status': same('status'),
  'journey.helperInside': same('{n} inside'),
  'journey.repeated': same('already run earlier'),
  'journey.decisionsFolded': same('{n} decisions',
    'Decisions on this screen that could not be drawn as a diagram — named as chips instead, so what this view draws is what its count claims.'),
  'journey.decisionsFoldedOne': one('1 decision', 'journey.decisionsFolded'),
  'journey.decisionChip': same('the flow can branch here'),
  'journey.view.rows': same('Rows'),
  'journey.view.ladder': same('Ladder', 'One screen turned on its side: systems as columns, time running down, one line per part the walk visited — the sequence diagram behind the same walk.'),
  'journey.moreSteps': same('{n} more', 'More parts the walk visited on this screen, below the ones shown. Open them to read the rest of the ladder.'),
  'journey.ladder.time': same('time'),
  // A screen's ladder draws the systems it uses; the ones after the last it uses
  // fold into one end column, named with the existing absence words (never a seventh).
  'journey.ladder.end': same('Stops here',
    'This screen\u2019s ladder goes no further to the right. Every system after the last one it used is folded into this one column instead of drawn as an empty lane, and each is named with its absence word \u2014 the same word the rows and the sheet print: not involved when the walk ran to its end, not reached when it was cut on this screen before that system.'),
  'journey.ladder.skip': same('Kept in its place',
    'A system this screen did not use, lying before or between systems it did. It keeps its place, drawn narrow, so the columns still read left to right in the order a request travels.'),
  'journey.ladder.folded': same('Folded into this column',
    'The systems this screen never reaches, each with its absence word. Their lanes are not drawn for this screen.'),
  'journey.noRowsYet': same('No records, messages or third parties known yet — they appear when handlers are built.'),
  'journey.expandHint': same('click a marker for its contract or code'),
  'journey.closeExpanded': same('Close'),
  'journey.requires': same('requires'),
  'journey.leadsTo': same('leads to'),
  'journey.partOf': same('part of'),
  'journey.linkHow.declared': same('declared in the manifest'),
  'journey.linkHow.derived': same('derived from a longer flow'),

  // ── the view axis: lens × view × band (journey-views-pass-2026-09 §2.1) ──
  'journey.layout.storyboard': same('Storyboard', 'The journey as its screens in order, the actions a person can take on each, and — for the selected action — what the system checks, records, sends and hands off, in plain words.'),
  'journey.layout.timeline': same('Timeline', 'The journey read left to right: one column per screen, the business above the line of visibility, one row per system below it.'),
  'journey.layout.sheet': same('Sheet', 'The whole journey on one grid: one column per action in journey order, one row per layer of the system in request order.'),
  // the visible label of the segmented control, and its accessible name: one
  // key, so the group cannot announce itself one way and read another
  'journey.layoutSwitch': same('View', 'Which drawing of the journey you are reading. The same walk and the same numbers — only the shape changes, and the view travels in a shared link.'),
  // a quiet mark on the button the current register opens in, so a reader who
  // lands somewhere unfamiliar can tell a default from a disappearance
  'journey.layoutDefault': same('Opens here in this register', 'Where a journey opens for the way you are reading: the storyboard for plain words, the sheet for both names, the timeline for code. Your own last choice is remembered and wins over that, and a shared link wins over both — every view stays one click away.'),
  'journey.layout.drill': same('Drill', 'One action opened into its beats: the layers of the system down the side, an arrow from each beat to the next, and a panel that explains the selected part. An experiment — switched on per workspace in Settings.'),
  // ── the action drill (the journey-timeline design reference 02-action-drill · behind the journeyDrill flag) ──
  'journey.beat.screen': same('the screen'),
  'journey.beat.browser': same('the browser'),
  'journey.beat.seam': same('the seam'),
  'journey.beat.server': same('the server'),
  'journey.beat.answer': same('the answer'),
  'journey.drill.beats': same('beats in request order'),
  // The drill's rail is the whole journey, the storyboard's ledger is one screen.
  // Same word, two populations — on the reference app's submission flow the first action is
  // `1 of 19` here and `1 of 9` there, which is two right answers to two
  // questions and read as one number changing under a keystroke. Each says whose
  // list it is counting; neither number moved.
  // `31` here and `13 actions` on the header were one noun over two populations
  // (pass swarm 2026-09-25, all six reviewers): the header counts what a person
  // can do, once each; this rail has a stop for every time the journey does
  // something, planned calls and screens with nothing to call included. Two
  // numbers, so two names — see `count.unit.actionStops`.
  'journey.drill.actionOf': same('stop {n} of {t} on this journey',
    'Where the open stop sits on the journey\u2019s rail: one stop each time the journey does something, in the order the walk met them \u2014 a call the code makes (a second visit is a second stop), a call only the contract or the design declares, and a screen with nothing to call. Not the header\u2019s actions, which count each thing a person can do once; the tip on the stops count has the split.'),
  'journey.drill.countBeats': same('{n} beats'),
  'journey.drill.also': same('also'),
  'journey.drill.answerSub': same('what the contract declares comes back — no payload was captured'),
  // ── the transaction boundary (blocker 8) ────────────────────────────────
  // One fact, two registers. Every string here is about where a call is
  // *written*, never about what a run did: the parser stamps `meta.tx` on a
  // call written inside a transaction callback, and that is the whole of the
  // evidence. Nothing below counts transactions, says one committed, or makes
  // the work after a boundary a failure.
  'journey.tx.lane': same('Transaction',
    'Which side of a transaction boundary each part of this action is written on. The tool reads where a call sits in the code, not what happened when it ran.'),
  'journey.tx.inside': same('in a transaction',
    'This call is written inside a transaction callback (withOps · withTenant · withTx · transaction · $transaction). Recorded per call site, not per transaction — two neighbours here may sit in different ones — and nothing here says a run committed.'),
  'journey.tx.after': same('not in it \u2014 written after',
    'The same caller opened a transaction earlier and this call is written outside it. Not a failure and not a rollback: it simply does not share the transaction above it.'),
  'journey.tx.straddles': same('part of this is written outside the transaction',
    'Some of the work under this is written inside a transaction and some after it, so it is not one unit. Open it to see which parts: each one says its own side.'),
  'journey.biz.tx.straddles': same('not all of this is saved together',
    'The code saves some of this work as one piece and does the rest separately afterwards. Open it to see which is which.'),
  'journey.drill.txFallback': same('Nothing here records a transaction boundary \u2014 either this code opens none, or this graph was written before Farsight recorded them.',
    'The honest third answer. A graph with no transaction flag at all cannot tell "there is no transaction" from "we did not look", so it says neither.'),
  'journey.biz.tx.lane': same('Saved together',
    'Which parts of this action the code saves as one piece of work, and which it does separately afterwards.'),
  'journey.biz.tx.inside': same('saved together \u2014 all of it or none',
    'The code wraps this work as one unit: it is written to be kept or dropped together. Whether a particular run finished is not something this tool watched.'),
  'journey.biz.tx.after': same('separately, after that',
    'The code does this outside the work above it, so it is not kept or dropped with it. That is what the code says, not a fault.'),
  'journey.biz.txFallback': same('We cannot tell what is saved together here.',
    'Nothing in this graph records where one piece of work starts and ends, so the view says nothing rather than guessing.'),
  'journey.drill.legend.call': same('call / return'),
  'journey.drill.legend.cond': same('conditional · after the answer'),
  'journey.drill.legend.gates': same('gates'),
  'journey.drill.legend.records': same('records'),
  'journey.drill.legend.third': same('third party'),
  'journey.drill.legend.messages': same('messages'),
  'journey.drill.legend.shapes': same('told apart by the line, not the colour'),
  'journey.via.calls': same('called'),
  'journey.via.renders': same('rendered'),
  'journey.via.publishes': same('published'),
  'journey.via.consumes': same('consumed'),
  'journey.via.reads': same('read'),
  'journey.via.writes': same('written'),
  'journey.insp.title': same('Inspector'),
  'journey.insp.docs': same('Docs'),
  'journey.insp.req': same('Request / response'),
  'journey.insp.code': same('Code'),
  'journey.insp.forks': same('Forks'),
  'journey.insp.tests': same('Tests'),
  'journey.insp.beat': same('beat {n}'),
  'journey.insp.hint': same('click a box for its docs, contract, code, forks and tests'),
  'journey.insp.noDocs': same('No authored description on this part — the code is the only source.'),
  'journey.insp.noForks': same('No branch points recorded on this part.'),
  'journey.insp.noContract': same('Not an API call — there is no contract here.'),
  'journey.insp.specNote': same('Expected shape, from the spec. No payload was captured; an observed response would be labelled as such.'),
  'journey.insp.params': same('parameters'),
  'journey.insp.request': same('request'),
  'journey.insp.required': same('required'),
  'journey.insp.responses': same('responses'),
  'journey.insp.security': same('requires'),
  'journey.insp.gatesHere': same('gates on this part'),
  'journey.insp.toGetHere': same('to get here'),
  'journey.insp.noTestStep': same('no test reaches this part'),
  // The drawer's head names where the open part sits: the stop (the Sheet's column, the
  // drill's rail), never the walk's own index — `STEP 232` was a number no other surface
  // printed, beside a storyline header whose *step 2 of 6* meant something else.
  'journey.insp.stopOf': same('stop {n} of {t}',
    'The stop this part sits in: one stop each time the journey does something, numbered across the whole journey in the order the Sheet draws its columns and the drill walks its rail. The part itself has no number — it is one of the things that happen in that stop.'),
  'journey.fork.jump': same('→ {name}', 'A part this path of the branch goes on to call. Click to open it on the journey.'),
  'journey.fork.exits': same('exits (return or throw)', 'This path of the branch leaves the function: it returns or throws before calling anything the walk tracks.'),
  'journey.fork.noCalls': same('no tracked calls', 'Nothing this path of the branch calls is a part the walk follows.'),
  'journey.fork.mayExit': same('may exit', 'Somewhere in this branch the code can return or throw; which path does is not recorded.'),
  'journey.countActions': same('{n} actions',
    'Distinct things a person can do across this journey, counted once each. An action is one call to the API and the work behind it, so the call names the action: the same call reached again on a later screen is the same thing a person can do. It is counted here once and drawn there with ↺; how many of those second visits there are is counted beside it, as the actions that run again later.'),
  'journey.countActionsOne': one('1 action', 'journey.countActions'),
  'journey.countAgain': same('{n} of them run again later',
    'How many of this journey’s actions happen a second time, on a later screen — the same call, the same work behind it. Counted apart from the actions rather than added to them: adding them would count one thing a person can do twice. The actions plus this number is how many times an action is performed.'),
  'journey.countAgainOne': one('1 of them runs again later', 'journey.countAgain'),
  'journey.sheetCorner': same('layer ↓ · stop →', 'Each column is one stop: one time the journey does something, in order — the same stops the drill walks and numbers. The header counts actions, each thing a person can do once, so a second visit or a call only the design declares is a stop and not another action.'),
  'journey.biz.sheetCorner': same('part of the system ↓ · stop →', 'Each column is one stop: one time the journey does something, in order. Down the side, the parts of the system that take part in it.'),
  // ── the code pane's dock: in place · bottom · right ──
  'journey.dockSwitch': same('Code pane'),
  'journey.dock.inline': same('In place', 'The contract or code opens under the row that owns the marker, inside the timeline.'),
  'journey.dock.bottom': same('Bottom', 'The contract or code opens in a pane pinned along the bottom of the journey — always in view while the timeline scrolls.'),
  'journey.dock.right': same('Right', 'The contract or code opens in a pane pinned to the right of the journey — the timeline on the left, the code beside it.'),
  'journey.dockResize': same('drag to resize'),
  'journey.layer.user': same('What the user sees'),
  'journey.layer.app': same('App parts'),
  'journey.layer.api': same('The API call'),
  'journey.layer.server': same('Server parts'),
  'journey.layer.gates': same('Gates & business'),
  'journey.layer.verified': same('Verified by'),
  'journey.layerSub.user': same('pages · components · events'),
  'journey.layerSub.gates': same('guards · rules · decisions'),
  'journey.layerSub.verified': same('tests reaching this action'),
  'journey.noTests': same('no tests indexed'),
  'journey.noTestReaches': same('no test reaches this action'),
  'journey.testsE2e': same('{n} e2e',
    'Distinct end-to-end test cases that reach this scope, by any of the three kinds of evidence — declared, reached or observed. A case reaching three screens is counted once on the journey and once on each screen. Cases in a source that reach nothing here are not counted: that total is on the Tests page, scoped to its source.'),
  'journey.testsUnit': same('{n} unit',
    'Distinct unit test cases that reach this scope, by any of the three kinds of evidence. Integration cases and coverage reports are counted apart.'),
  'journey.testsIntegration': same('{n} integration', 'Integration cases, counted apart from unit cases: metric v2 stopped folding them together, and a sentence that adds them up is the same fault twice.'),
  'journey.testsObserved': same('{n} observed',
    'Test cases a results report named running over this scope. A coverage report that saw the code run without naming a case is not a case, and is counted apart as a report.'),
  'journey.moreChips': same('+{n} more'),
  'journey.helpersFolded': {
    hud: '{n} helpers',
    professional: '{n} plumbing',
    define: 'Same side of the seam, no business sentence, reaches no record, message or external. Folded under the part that used it.',
  },
  'journey.again': same('{n} more times', 'The same part, reached again inside this action. It is drawn once and the other visits fold under it; each keeps its own place in the walk, and folding them changes no count.'),
  // one is not "{n} more times": the catalog pairs a singular with its plural
  // wherever a count can be 1 (the precedent is `tests.runOnlyOne`)
  'journey.againOne': same('once more', 'The same part, reached one more time inside this action. It is drawn once and the second visit folds under it.'),
  // ── one written call, several implementations (swarm 2026-09-23, blocker 3) ──
  // A call through a declared type that several classes implement is drawn ONCE,
  // with its candidates named. Which of them runs is a run-time fact: this tool
  // reads code, not runs, so no candidate is ever presented as the one that ran.
  'journey.oneOf': same('one of {n}', 'One call, written once, with several implementations behind it — the declared type has more than one. Exactly one of them runs each time; which one is settled when the app runs, and this tool reads code, not runs, so it names them all and picks none.'),
  'journey.oneOf.through': same('through {iface}', 'The declared type the call is written against — at that line, the only name the source itself contains.'),
  'journey.oneOf.candidates': same('could run here', 'Every implementation this one call could reach, in the order the walk met them. One of them runs.'),
  'journey.oneOf.setAside': same('set aside: {list}', 'Implementations the resolution knew of and did not draw — the in-memory and mock twins only tests use.'),
  'journey.oneOf.how': same('matched by {technique} · {confidence} confidence', 'How the parser tied this one call to these implementations, and how sure it is. A guess is never drawn as a fact.'),
  'journey.oneOf.unknown': same('which one runs is not in the code — it is chosen as the app runs', 'Farsight reads source, never a run. Nothing in the code at this line says which implementation is wired in, so none is shown as the one that ran.'),
  'journey.countChoicesOne': one('1 place where one of several runs', 'journey.countChoices'),
  'journey.countChoices': same('{n} places where one of several runs', 'Call sites with more than one implementation behind them. Each is drawn once; the visits count every candidate, as they count every re-visit.'),
  'journey.biz.oneOf': same('one of {n} ways this can run', 'Several pieces of the system can do this job, and one of them does it each time. Which one is not something this tool can tell from the code.'),

  'journey.inside': same('{n} inside', 'The parts this part called, folded under it — open to drill down one level at a time. The spliced code view shows all of them in order.'),
  'journey.schemaChip': same('{req} → {res}'),
  'journey.schemaOut': same('→ {res}'),
  'journey.fromSpec': same('spec', 'Declared in the contract — a status the code may still never return.'),
  // One word per fact (story swarm 2026-09-25, finding 4): an empty journey cell's word is
  // decided once, in core `journeyAbsence()`, and every view prints that word. The defines say the rule.
  'journey.absent.noneIndexed': same('none indexed', 'Nothing of this kind anywhere the journey\u2019s walk reached: Farsight looked through all of it and found none. On a journey\u2019s cell it is said of a whole kind of layer — records, messages, a third party — never of one action that simply did not use a layer the journey has.'),
  'journey.absent.notBuilt': same('not built'),
  'journey.absent.notInvolved': same('not involved', 'The journey has this layer, the walk of this action ran to its end, and this action has nothing on it. Every view prints this same word for the same cell.'),
  'journey.absent.notReached': same('not reached', 'The graph has it; the walk did not get there — a cut point, or a guard-kind node this build did not enter.'),
  // Extended by chunk H6: the word now also carries a commit no sync ever
  // ingested — inside a Farsight source, outside what Farsight has read of it.
  // The six absence words are closed, so history takes this one rather than a seventh.
  'journey.absent.notIndexed': same('not indexed', 'Outside what Farsight reads: an owner, a run against an external sandbox, a design comment — or a commit no sync ever ingested, whose files can be named but whose effect on the graph cannot.'),
  'journey.absent.notTranslated': same('not translated'),
  'journey.absentWhy.queueNoProducer': same('the portal never enqueues {queue}; the worker\'s only producer is {producer}'),
  'journey.absentWhy.deferred': same('runs later, on its own — registered here, run by something else'),
  'journey.absentWhy.interface': same('reached through {param} — an interface-typed call this build cannot follow'),
  'journey.absentWhy.noExternal': same('no external node in this build — proposed from the SDK/host table'),
  'journey.absentSub.noneIndexed': same('nothing of this kind was found anywhere this journey reaches'),
  'journey.absentSub.notBuilt': same('declared somewhere — no code behind it yet'),
  'journey.absentSub.notInvolved': same('this layer takes no part in this action'),
  'journey.noTestsSub': same('No tests are indexed yet — this says nothing about whether the action is tested.'),

  // ── what the overlay says while it has nothing to draw (R32) ──────────
  'journey.loading': same('walking the journey…'),
  'journey.retry': same('Try again'),

  // ── honest chrome (journey-views-pass-2026-09 §2.2) ────────────────────
  'journey.cutPoints': same('{n} cut points', 'Subtrees the walk did not enter — the depth or visit budget ran out there. The rest still walked. Click for the list.'),
  'journey.cutPointsOne': one('1 cut point', 'journey.cutPoints'),
  // The list behind the chip (B4.3). One row per cut, grouped by the budget
  // that ran out; the row says where the walk was standing when it stopped, so
  // a reader can go there. Re-visits are not in it — they were walked once and
  // are counted apart, which is why the chip's define names two budgets, not three.
  'journey.cutPoint.row': same('under {parent} · stop {a} of {screen}',
    'Where the walk stopped short: the part it was following, and which stop of which screen that was. Opens that part on the journey.'),
  'journey.truncated': same('truncated at {cap}', 'The whole walk stopped at the visit cap. Only then — never for a depth cut.'),
  'journey.repeat': same('↺ already walked', 'A part walked earlier on this journey, drawn again as a ghost, not re-walked.'),
  'journey.cutReason.depth': same('depth ×{n}'),
  'journey.cutReason.repeat': same('repeat ×{n}'),
  'journey.cutReason.steps': same('visit budget ×{n}'),
  'journey.countCut': same('{n} cut',
    'Subtrees the walk did not follow, in this cell or on this screen. The header’s chip counts them for the whole journey and opens the list.'),
  'journey.countRepeats': same('{n} repeats', 'Parts the walk had already visited: shown once, not walked again.'),
  'journey.countRepeatsOne': one('1 repeat', 'journey.countRepeats'),
  'journey.notFollowed': same('{n} not followed'),
  'journey.untranslated': same('{n} technical conditions not translated',
    'Branch points nobody labelled that are never drawn as a decision: environment, schema and error checks, and any other condition with no plain-language label. Counted once each. One of the two parts of the conditions not in plain language \u2014 the other is the conditions on a gate nobody labelled, which the hybrid and code lenses draw as decisions. The whole is the number every register prints.'),
  'journey.untranslatedSub': same('Environment, schema and error checks, and in the business lens any check in code without a plain-language label — shown in the forks drawer, never drawn as a decision.'),

  // ── the forks drawer: the list behind "{n} technical conditions not
  //    translated". A reader who clicks that sentence in the business register
  //    used to land on a thousand identifiers, in the register whose one rule
  //    is that it hides code. The drawer keeps its shape and its counts in
  //    every register; what changes is what an entry says. The professional
  //    register reads the condition, its arms and what each arm requires — the
  //    code is the point there. The business register reads what the graph
  //    actually supports: the sentence a person wrote about the part the branch
  //    sits in, the kind the parser sorted it into, and — for the condition
  //    itself, which nobody labelled — the absence word, never a humanized
  //    identifier dressed up as a sentence.
  'journey.forks.title': same('Forks along this journey',
    'Every branch point the walk met: an if, a ternary, a switch, a logical operator or a catch, each with the paths it can take.'),
  'journey.biz.forks.title': same('Where this journey can go more than one way',
    'Every place the code chooses between paths. Each one names the part of the app it sits in; the condition itself is code, and is shown in the other registers.'),
  'journey.forks.empty': same('No forks recorded along this journey.'),
  'journey.forks.reingest': same('Re-ingest with the latest parser to extract branch points.'),
  // The business sibling of `journey.absent.notTranslated` — the sixth of the
  // six closed absence words, in the words the business register spells it
  // with, and the same tail as `journey.biz.untranslated` so one concept has
  // one wording on both surfaces.
  'journey.biz.absent.notTranslated': same('not written in plain language',
    'The condition is in the code and nobody wrote what it means: no @business comment labels this branch. The drawer names the part of the app it sits in rather than guessing at the check.'),
  // How a branch was sorted. Two of the six are read off the branch's shape and
  // are facts; four are read off words in the condition text and are a sorting,
  // not something anyone wrote — so the business register says "looks like".
  'journey.forkCat.error': same('error',
    'A catch block: this branch is the code’s own error path. Read off the branch’s shape, not from its words.'),
  'journey.forkCat.guard': same('guard',
    'One of its paths ends the work — a return or a throw. Read off the branch’s shape, not from its words.'),
  'journey.forkCat.access': same('access',
    'The condition mentions auth, a session, a role, a scope, a permission, a token, an admin or a tenant. A word match on the condition text, not a declaration.'),
  'journey.forkCat.flag': same('flag',
    'The condition mentions a flag, a feature or a toggle. A word match on the condition text, not a declaration.'),
  'journey.forkCat.state': same('state',
    'A switch, or a condition mentioning a status, a state, a kind, a type, a mode or a phase. A word match on the condition text, not a declaration.'),
  'journey.forkCat.branch': same('branch',
    'None of the other five matched. The catch-all, and the largest group in most journeys.'),
  'journey.biz.forkCat.error': same('when something goes wrong',
    'The code’s own error path — read off the shape of the branch, so this one is a fact, not a guess.'),
  'journey.biz.forkCat.guard': same('can stop the journey here',
    'One of the paths ends the work rather than carrying on — read off the shape of the branch, so this one is a fact, not a guess.'),
  'journey.biz.forkCat.access': same('looks like a sign-in or permission check',
    'Sorted here because the condition mentions signing in, a role or a permission. A word match on code nobody labelled — which is why it says "looks like".'),
  'journey.biz.forkCat.flag': same('looks like a switch that can be turned on or off',
    'Sorted here because the condition mentions a flag, a feature or a toggle. A word match on code nobody labelled — which is why it says "looks like".'),
  'journey.biz.forkCat.state': same('looks like a check on what state something is in',
    'Sorted here because the condition mentions a status, a state, a kind or a mode. A word match on code nobody labelled — which is why it says "looks like".'),
  'journey.biz.forkCat.branch': same('everything else',
    'None of the other five kinds matched this condition. No claim is made about what it decides.'),

  // ── the journey words (the clarity pass §3.1, §3.5) ─────────
  // The unit a reader counts in. `moment` is retired as a printed word — it
  // survives only as the internal name of an action's column in the fold.
  'journey.unit.action': same('action', 'One thing the user does on a screen and everything it caused — one call to the API and the work behind it.'),
  'journey.unit.beat': same('beat', 'One hop inside an action, in request order: the person, the browser, the seam, the server, the transaction, the hand-offs, the answer.'),
  'journey.unit.step': same('visit', 'One arrival of the walk at a part of the code, re-visits included. A developer’s unit the business register never prints; the parts themselves are counted there too, as “things happen here” — the same number, under words a reader of that register can use. A visit is never a position: a journey’s place in a storyline has its own word, and a part sits in a stop.'),
  // What can stop or steer a journey — four kinds, never interchangeable.
  'journey.check.gate': { hud: 'gate', professional: 'guard', define: 'Who may pass — a function marked @guard, declared in config, or detected as an auth check. Its label is policy.' },
  'journey.check.rule': { hud: 'rule', professional: 'validation', define: 'What the data must look like — a schema on a route or a function. Environment schemas are not rules of a journey.' },
  'journey.check.decision': same('decision', 'What can go differently, in plain words — a branch with a @business label or one on a gate. The only branches business draws.'),
  'journey.check.technical': { hud: 'technical condition', professional: 'untranslated condition', define: 'An if or catch in the code with no plain-language label. Counted once per journey; listed in Forks; never a decision.' },
  // Gates are distinct, checks are occurrences: "18 gates · 54 checks".
  'journey.countChecks': same('{n} checks',
    'How many times this journey met a checkpoint, counting every screen that meets it. The checkpoints themselves are counted once each as gates & rules.'),
  'journey.countChecksOne': one('1 check', 'journey.countChecks'),
  'journey.countBuilt': same('{n} of {m} built',
    'How many of the screens this journey’s design names exist in code, of how many it names.'),
  'journey.countDeclaredOnly': same('{n} declared, not called',
    'Operations this journey’s contract or design names that no code in it calls: either the action is a contract-derived planned call, or a screen’s manifest lists an operation no action made. Counted once each across the journey, and never added to the actions — declared is not built. The flow status table prints this number under these words too, from the same fold.'),
  'journey.countSetup': same('{n} start-up',
    'Parts that belong to the process starting up, not to this journey’s request — named once and never walked into an action.'),
  'journey.countAfterwards': same('{n} afterwards',
    'Work this journey registers that runs later, on its own: hooks and callbacks. Named, never walked, and never counted as part of the request.'),
  'journey.kind.action': same('action'),
  'journey.kind.setup': same('start-up'),
  'journey.kind.deferred': same('afterwards'),
  'journey.setup': same('start-up, once', 'The process boot, printed once per journey and never walked into an action — every request would otherwise appear to build the container.'),
  // Evidence: one chip per cell, and the loud one is the honest one.
  'journey.evidence.declared': same('declared only', 'A test author says it covers this (@covers). Nothing imported, nothing ran.'),
  'journey.evidence.reached': same('reached by tests', 'A test body imports, renders or requests this — static evidence. A floor.'),
  // *Verified* has one meaning (pass swarm 2026-09-25, staff engineer's blocker):
  // a results report named a test case that ran over this code. A coverage
  // report that saw the code run without naming a case says *seen by a
  // coverage run* — stale or not — and never *verified*.
  'journey.evidence.observed': same('verified by a run', 'A results report named a test case that ran over this code. The run line beside it says whether the report recorded a source digest, and so whether the code is proven unchanged since.'),
  'journey.evidence.stale': same('verified · stale', 'A results report named a test case that ran over this code, and the code has changed since \u2014 the report is older than the graph. A coverage report alone never earns this word: it reads “seen by a coverage run · stale”.'),
  'journey.flowE2e.declared': same('e2e declared', 'An end-to-end test says in its header that it covers this flow, and its body reaches nothing in it. A claim, not evidence.'),
  'journey.flowE2e.reached': same('e2e reached', 'An end-to-end test body imports, renders or requests something inside this flow’s scope. Static evidence: a floor, not a run.'),
  'journey.flowE2e.observed': same('e2e observed', 'A run saw an end-to-end test reach something inside this flow’s scope — the only rung that means a run happened.'),
  'journey.flowE2e.none': same('no e2e', 'No end-to-end test reaches anything in this flow’s scope, by any of the three kinds of evidence.'),
  'journey.evidenceShared': same('no screen built — the tests reach shared code', 'Every test that reaches this flow reached code the flow shares with others. Nothing of the flow itself is built, so no run can have exercised it: the evidence is real and it belongs to that shared code, not to this flow.'),
  // ── what proves this runs: the foot, the list, the business sentence ─────
  // (B4.1 + B4.2; tests-pages plan §2.10 and §4.3.) The foot counts **cases**,
  // one clause per level, because folding integration into unit is how one
  // answer came to print 252 and then 270 three lines apart (swarm
  // 2026-09-23, blocker 5). A coverage report is not a case: it has its own
  // clause, and the words for "a run saw this and no case did" are the Tests
  // tab's own (`tests.runOnly`, `tests.evidence.runSeen`) — one fact, one
  // wording, on every surface that prints it (blocker 7).
  'journey.tests.foot': same(
    'tests: {e2e} e2e · {unit} unit · {int} integration · {obs} observed',
    'Distinct test cases that reach this, counted per level. Integration is its own level and is never folded into unit; a coverage report is not a case and is counted on its own line.',
  ),
  'journey.tests.open': same('open the list', 'Opens the Tests surface on the cases this cell counts — the same scope, the same evidence word — each case with its own last run.'),
  'journey.tests.listHint': same('↑↓ walk · ↵ opens the test'),
  'journey.tests.noneScreen': same('no test reaches this screen'),
  // One step, two scopes (story swarm 2026-09-25, finding 4): the action's Verified-by
  // number counts every test reaching any part of the action; a step's own foot counts
  // the tests reaching that part alone. Printed together, each with its scope.
  'journey.tests.widerScope': same('{n} reach the action it belongs to \u2014 none of them reaches this part itself',
    'Two scopes, two numbers. The action\u2019s number counts every test that reaches any part of the action — the screen, the call, the handler, the helpers under it. This part\u2019s own number counts only the tests that reach this one part, and here it is none. Neither contradicts the other.'),
  'journey.tests.throughAccessors': same(
    'reached by {n} tests through its accessors',
    'Nothing tests a table directly. These tests reach the functions that read and write it, so the evidence is theirs — named here rather than left to read as an absence.',
  ),
  // The same foot in the business register: counted in tests, never in levels,
  // and the run said as a clause rather than a status chip.
  'journey.biz.tests': same('Checked by tests — {n} tests reach this, {e2e} of them from end to end.',
    'How many tests touch this part of the journey, and how many of those drive it the way a person would. A floor: it counts what this build could see, and a test it could not read is not counted against it.'),
  'journey.biz.testsRun.none': same('None of them has been run in a way this tool can see, so this is what the tests say, not what a run proved.',
    'The tests exist and no report of them running has reached Farsight. The sentence says what is written, and refuses to present it as what happened.'),
  'journey.biz.testsRun.observed': same('A recorded run reached this code.',
    'A results or coverage report from a run of these tests named this code, and that report was produced from the same code this graph read.'),
  'journey.biz.testsRun.runOnly': same('A recorded run reached this code; the report does not say which test reached it.',
    'The run is real and the report is file-level: it proves the code ran, and cannot name the test that ran it.'),
  'journey.biz.testsRun.runOnlyStale': same('A coverage run reached this code before its latest change, and it does not say which test did \u2014 evidence of the past, not of now.',
    'The only record of a run here is a coverage report: it proves an older version of this code ran under some test, not which one, and not that anything ran since it changed. No test is claimed to have passed over this code.'),
  'journey.biz.testsRun.declaredPassed': same('An end-to-end test that says it covers this passed in its latest recorded run; nothing measured which parts it ran.',
    'The run is real and passed; that it went through this part is the test author\u2019s own statement, not a measurement.'),
  'journey.biz.testsRun.declaredPassedStale': same('An end-to-end test that says it covers this passed, but before this part last changed \u2014 evidence of the past, not of now.',
    'The test passed against an older version of this part. It still says something, just not about today.'),
  'journey.biz.testsRun.stale': same('A recorded run of these tests reached this code, and the code has changed since — evidence of the past, not of now.',
    'The report was produced from an older version of this code. It is kept and labelled rather than thrown away, because it still says something \u2014 just not about today.'),
  // What is built, and what is only promised.
  'journey.status.planned': same('planned', 'Declared in the contract and not built; walked from the contract as ⋯ parts.'),
  'journey.status.notBuilt': same('not built', 'Said of the screen or route that lacks code — never of a whole flow.'),
  'journey.status.built': same('built', 'Every screen this flow’s design names exists in code.'),
  'journey.status.partly': same('partly built · {n} of {m}', 'Some of the screens this flow’s design names exist in code and some do not; the two numbers say how many of each.'),
  'journey.status.designedNotBuilt': same('designed, not built · 0 of {m}', 'The design names screens for this flow and none of them exists in code yet.'),
  'journey.drift.byKind': same('what differs · {n}', 'Every difference between the spec, the design and the code, one sentence per kind. Never a defect count.'),
  'journey.header.business': same('{screens} screens · {built} built · {actions} things the user can do · touches {systems}'),
  'journey.rail.declaredOnly': same('declared for this screen — no call found in its code'),
  'journey.identity': same('source {commit} · farsight {build} · sync {n}',
    'Which reading of the product every number on this screen comes from: the commit of the source, the build of Farsight that read it, and the sync that wrote the graph. Two numbers can only be compared when these agree.'),
  'journey.external.kind.erp': same('the ERP'),
  'journey.external.kind.ocr': same('document extraction'),
  'journey.external.kind.files': same('file storage'),
  'journey.external.kind.email': same('email'),
  'journey.external.kind.queue': same('a queue'),
  'journey.external.kind.db': same('a database'),
  'journey.external.kind.http': same('an HTTP service'),

  // ── the storyboard (02-design-changes §3: screens strip · action rail · ledger) ──
  // The screens in order, the actions on the selected screen, and — for the
  // selected action — the seven ledger rows in request order. Every word here
  // is printed in all three registers, so none of them may carry a
  // developer's unit (the lint's RULE 5 list) even though the key is shared.
  'journey.story.ownWords': same('the flow\'s own words'),
  'journey.story.screens': same('The screens in order'),
  'journey.linked': same('Linked journeys'),
  'journey.scene.actions': same('stops {from}–{to}', 'The stops on this screen, numbered from the first: one each time the journey does something here. The same stops the Sheet draws as columns.'),
  'journey.scene.again': same('stops {from}–{to} again', 'Every action on this screen was already run on an earlier one — the same calls, the same work, reached a second time.'),
  'journey.scene.newHere': same('new on this screen'),
  'journey.rail.screenOf': same('screen {n} of {t} · {name}'),
  'journey.rail.prevScreen': same('previous screen'),
  'journey.rail.nextScreen': same('next screen'),
  'journey.rail.unlisted': same('called by the screen — not in the design\'s list'),
  'journey.ledger.actionOf': same('stop {n} of {t} on this screen · {name}',
    'Where the open stop sits among the stops of THIS screen. The drill and the Sheet number the stops of the whole journey instead, and say so.'),
  'journey.ledger.checks': same('The checks'),
  'journey.ledgerSub.checks': same('what has to be true · what stops the action'),
  'journey.ledger.recorded': same('What is recorded'),
  'journey.ledgerSub.recorded': same('one transaction · then the hand-offs'),
  'journey.ledgerSub.messages': same('email · queues'),
  'journey.ledgerSub.external': same('outside the code'),
  'journey.sees.does': same('{action} on {screen}'),
  'journey.sees.answers': same('the screen answers'),
  'journey.sees.thenShows': same('then shows {screen}'),
  'journey.record.by': same('{op} by {accessor}'),
  'journey.external.via': same('through {via}'),

  // ── the business register's own words (lint RULE 5 polices these) ──────
  // Every string the business lens prints lives here, and none of them may
  // carry a developer's unit: step · cut · seam · beat · moment · truncated ·
  // helper. The shared keys above stay as they are for hybrid and code.
  'journey.biz.header': same('{screens} screens · {built} built · {actions} things the user can do · touches {systems}',
    'The one-line reading of a journey: how many screens it runs through, how many of them exist, how many things a person can do across them, and which systems it reaches. Each number on it is handed out once by the core with the scope it counts over (docs/COUNTS.md). The conditions nobody put in plain language are printed here as the whole: the technical conditions plus the conditions on a gate nobody labelled. Where another lens prints the technical conditions alone, it is printing the first of those two parts, under that part\u2019s own name.'),
  // `checks` is the header's word for meetings of a gate (`journey.countChecks`),
  // so this sentence says *conditions*: one word, one concept (pass swarm
  // 2026-09-25, business analyst: "I can't tell which of these sets contains which").
  'journey.biz.untranslatedOne': one('1 condition in the code was not written in plain language', 'journey.biz.untranslated'),
  'journey.biz.untranslated': same('{n} conditions in the code were not written in plain language',
    'Places where the code decides something and nobody wrote what the decision means. They are counted here, listed behind this sentence by the part of the app each one sits in, and never drawn as a decision of the business \u2014 because nobody said they were one. Two parts sit in this one number: the technical conditions, and the conditions on a gate nobody labelled, which the hybrid and code lenses also draw as decisions. It is the same number every register prints for this journey; only the words differ.'),
  // The checks every web application has, said for a product owner. Each is read off
  // the label the team wrote on the gate (`jrnGateInWords`), never off the code: a gate
  // whose label says *same-origin* reads the first sentence, whatever its code does.
  'journey.biz.gateShape.sameOrigin': same('only the app’s own pages can make a change here',
    'Said for a check the team labelled same-origin: a request that changes something is refused unless it comes from the application’s own pages, so another website cannot make the change on a signed-in person’s behalf. The words are read off the label the team wrote; the code view shows the check itself.'),
  'journey.biz.gateShape.rateLimit': same('a limit on how often anyone can ask',
    'Said for a check the team labelled a rate limit: too many requests in a short time are refused, which keeps the service up and slows down abuse. The words are read off the label the team wrote; the code view shows the check itself.'),
  'journey.biz.gateShape.idShape': same('the record asked for must be named correctly',
    'Said for a check the team labelled an id shape: the record the address names must look like a real record number before anything reads it. The words are read off the label the team wrote; the code view shows the check itself.'),
  'journey.biz.gateShape.returnPath': same('after signing in, people are only sent back inside the app',
    'Said for a check the team wrote about where a person returns to after signing in: only an address inside the application is accepted, so a link cannot send someone on to another website. The words are read off the label the team wrote; the code view shows the check itself.'),
  'journey.biz.notBuilt': same('not built yet',
    'Someone designed or declared this and no code answers it yet. A statement about the product, not about a gap in the tool.'),
  'journey.biz.partly': same('partly built · {n} of {m}',
    'Some of the screens this journey needs exist and some do not; the two numbers say how many of each.'),
  // The business readings of four of the six closed absence words. The six are
  // closed: these are the same six spelled for a reader who does not read code,
  // never a seventh kind of nothing. Each carries its own define now — they are
  // printed all over the business register and were in no word group at all.
  'journey.biz.absent.noneIndexed': same('nothing of this kind was found here',
    'Farsight looked and found none. It is not a claim that none exists — only that nothing of this kind is in the code this build read.'),
  'journey.biz.absent.notInvolved': same('takes no part in this',
    'This part of the system was not used at all in this part of the journey. Different from having nothing found: there was nothing to find here.'),
  'journey.biz.absent.notReached': same('the walk did not get there',
    'The code exists and this reading of the journey stopped before it. What is behind it is unknown, not empty.'),
  'journey.biz.absent.notIndexed': same('outside what this tool reads',
    'It exists somewhere Farsight does not look — a person, a run against someone else\u2019s system, a comment on a design. Nothing can be said about it here.'),
  'journey.biz.ladder.end': same('Goes no further',
    'This screen does not reach the parts of the system named here. Rather than an empty column for each, they are named once, in this column: \u201ctakes no part in this\u201d when nothing on this screen used them, \u201cthe walk did not get there\u201d when this reading stopped before it could tell.'),
  'journey.biz.ladder.skip': same('Kept in its place',
    'A part of the system this screen did not use, lying before or between parts it did. It keeps its place, drawn narrow, so the columns still read left to right in the order a request travels.'),

  // ── identity and counts in the chrome ──────────────────────────────────
  'chrome.identity': same('source {commit} · farsight {build} · sync {n}'),
  'chrome.shownOf': same('{n} shown of {t} · {hidden} hidden',
    'Cards the code map draws, out of every thing the graph holds in all its sources. A collapsed group is one card however many things it holds, so the hidden number is everything not drawn as its own card — its tip splits it by reason, and the reasons add up to it.'),

  // ── tips: the detail behind a number or a word (lib/tooltip.js) ─────────
  // A tip opens on a click, or after the pointer rests on its trigger; a dotted
  // underline marks what has one. Every number's tip says what it counts, the
  // scope it counts over and where the number came from — the three facts a
  // reader needs before they can cite it.
  'tip.label': same('Details', 'The name a screen reader hears for a tip that carries links or a table.'),
  'tip.close': same('Close'),
  'tip.marker': same('dotted underline — has details',
    'Anything underlined with dots carries a tip: click it, or rest the pointer on it for a moment. With the keyboard, focus it and press ? (or Enter where it is not a button). Esc closes the tip before anything else.'),
  'tip.counts': same('Counts', 'What the number is a count of, in the words of the catalog entry that prints it.'),
  'tip.scope': same('Over', 'The scope the number counts over — the same number over a different scope is a different number.'),
  'tip.source': same('From', 'Where the number came from: the answer that carried it and the sync of the graph it was read from.'),
  'tip.sync': same('sync {n}'),
  'tip.breakdown': same('How it splits', 'The number broken into its parts. The parts add up to it; a part that does not is named as not a sum.'),
  'tip.grammar': same('In the Grammar Book', 'Opens the Grammar Book at this word — its words in both registers and its definition.'),
  'tip.syncChip.head': same('This graph', 'Which graph this window reads: the workspace, the sync that wrote it, when, and the build that serves it.'),
  'tip.syncChip.sync': same('sync', 'The graph’s sync number — every number on every surface is as of this sync.'),
  'tip.syncChip.when': same('synced'),
  'tip.syncChip.commit': same('source commit'),
  'tip.syncChip.attention': same('needs attention'),
  'tip.stats.scope': same('the code map, in the current scope, lens and focus',
    'The status bar counts what the code map would draw, on every surface — it is the map’s count, not the count of the surface on screen.'),
  'tip.stats.shown': same('drawn as a card'),
  'tip.stats.grouped': same('folded into a group card', 'Things drawn inside a group: the group is one card, so all but one of its members count as not drawn on their own.'),
  'tip.stats.guards': same('checks drawn as badges', 'Checks are drawn as a badge on what they protect, never as a card of their own.'),
  'tip.stats.outOfScope': same('outside the scope', 'Things in a source the scope picker has left out.'),
  'tip.stats.outOfFocus': same('outside the focus', 'Things the focus on one item leaves out. Esc or f clears it.'),
  'tip.stats.noLane': same('of a kind the map has no lane for'),
  'tip.stats.total': same('everything the graph holds'),
  'tip.more.of': same('{n} controls folded into this menu',
    'How many of the top bar’s controls did not fit this window and moved into the menu. They are the same controls, with the same words; a wider window brings them back.'),
  'tip.more.scope': same('the top bar, at this window’s width'),
  'tip.more.source': same('measured in this window'),
  'tip.more.nav': same('the surface tabs'),
  'tip.screens.scope': same('this journey, in the order a person meets its screens'),
  'tip.screens.col.n': same('#'),
  'tip.screens.col.screen': same('screen'),
  'tip.screens.col.status': same('built'),
  // the list the "not in plain language" sentence says is behind it
  'tip.untr.caption': same('The conditions, and where each one sits',
    'Every condition the number above counts, one row each: where it sits and how it was sorted. The business lens names the part of the app each one sits in and leaves out the condition itself, which is code.'),
  'tip.untr.col.where': same('where', 'The part of the app the condition sits in: the words somebody wrote for it, or the name of the code where nobody did.'),
  'tip.untr.col.kind': same('kind', 'How the condition was sorted — a fact where it was read off the shape of the code, a word match where it says "looks like".'),
  'tip.untr.col.cond': same('condition', 'The condition as the code writes it. Printed in the hybrid and code lenses only.'),
  'tip.untr.col.n': same('how many', 'How many conditions share this place and this kind. The rows add up to the number above.'),
  'tip.untr.gate': same('a condition on a gate nobody labelled',
    'A check on who may go on, whose condition nobody wrote a label for. The hybrid and code lenses also draw it as a decision.'),

  // ── the grammar page's journey-words section ───────────────────────────
  'grammar.journeyWords': same('The journey words'),
  'grammar.journeyWords.units': same('What you are counting'),
  'grammar.journeyWords.checks': same('What can stop or steer it'),
  'grammar.journeyWords.cuts': same('What the walk did not do'),
  'grammar.journeyWords.evidence': same('What proves it runs'),
  'grammar.journeyWords.status': same('What is built'),
  'grammar.journeyWords.counts': same('How a number names its scope'),
  'grammar.journeyWords.bizViews': same('What the business lane can show'),
  'grammar.journeyWords.absence': same('How an absence is spelled'),
  'grammar.journeyWords.transaction': same('what is saved together, and what is not'),
  'grammar.journeyWords.choice': same('When one call has several implementations'),
  'grammar.journeyWords.forks': same('How a branch in the code is named'),

  // ── the impact words (B5.4) — the seventh group of the word book ────────
  'grammar.impactWords': same('The impact words'),
  'grammar.impactWords.distance': same('How far away something is'),
  'grammar.impactWords.paths': same('What a path does and does not say'),
  'grammar.impactWords.stops': same('Where the answer stopped'),
  'grammar.impactWords.apart': same('What is reported apart'),
  'grammar.impactWords.bounds': same('How sure the number is'),
  'grammar.impactWords.rings': same('How a ring is drawn'),
  'grammar.impactWords.plain': same('The same answer in plain words'),
  'grammar.impactWords.note': same('The impact words never promise consequence: every line keeps the edge’s own verb, and “affected” is a grouping label for two hops and more, never a prediction. The six absence words are closed — impact borrows three of them and invents none.'),

  'chrome.workspace': same('workspace'),
  'chrome.graphFile': same('graph file'),
  'apis.chip.deprecated': same('deprecated'),
  'apis.op.title': same('Operation'),
  'apis.op.all': same('all operations'),
  'apis.op.params': same('Parameters'),
  'apis.op.body': same('Request body'),
  'apis.op.responses': same('Responses'),
  'apis.op.security': same('Security'),
  'apis.op.consumers': same('Consumers'),
  'apis.op.consumersEmpty': same('No indexed code calls this operation. A caller in an un-indexed source is not visible here.'),
  'apis.op.reachedFrom': same('reached from'),
  'apis.op.callSite': same('call site'),
  'apis.op.otherSource': same('other source'),
  'apis.op.drift': same('Drift'),
  'apis.op.noDrift': same('The spec and the code agree on this operation.'),
  'apis.op.source': same('Source'),
  'apis.op.noSource': same('declared in the spec — no implementation found in the indexed code'),
  'apis.op.inSpec': same('In the spec'),
  'apis.op.journey': same('Journey'),
  'apis.op.codemap': same('Code map'),
  'apis.op.required': same('required'),
  'apis.op.fields': same('fields'),
  'apis.contractLink': same('Contract'),
  'apis.spec.hidden': same('The spec file is code. Switch to the hybrid or code lens to read it; the Operations tab carries the same facts in plain words.'),
  'apis.spec.url': same('This document is fetched from a URL each time — the text below is the latest fetch.'),
  'apis.spec.none': same('No spec on file for this API. Farsight can generate one from the implemented routes — every field the parser could not see is marked x-farsight-inferred, and every operation links back to its source line.'),
  'apis.spec.generate': same('Generate OpenAPI (YAML)'),
  'apis.spec.generateSub': same('opens a document built from the code in a new tab · nothing is written to the repo'),
  'apis.spec.loading': same('loading the spec file…'),
  'apis.compare.sub': same('Paste an OpenAPI/Swagger document or give its URL. It is reconciled against the code in this graph with the same rule ingest uses — nothing is stored, nothing is modified.'),
  'apis.compare.url': same('URL of the document'),
  'apis.compare.paste': same('…or paste the document text here'),
  'apis.compare.run': same('Compare'),
  'apis.compare.running': same('comparing…'),
  'apis.compare.consequence': same('reads the graph · stores nothing · notifies no one'),
  'apis.compare.declared': same('declared, not implemented'),
  'apis.compare.implemented': same('implemented, not declared'),
  'apis.compare.mismatched': same('matched with differences'),
  'apis.compare.agree': same('No drift — the document and the code agree.'),
  'apis.compare.viaBase': same('matched via server base path'),
  'apis.compare.summary': same('declared {d} · implemented {i} · matched {m} · not implemented {s} · undocumented {c} · mismatched {x}'),
  'sys.apisFailed': sys('Could not load the API surface.'),
  'sys.designFailed': sys('Could not load the design surface.'),
  'sys.historyFailed': sys('Could not load the change history.'),
  'sys.impactFailed': sys('Could not read what uses this.'),
  'sys.compareFailed': sys('Could not compare the document.'),

  // ── settings page ───────────────────────────────────────────────────────
  'set.saved': same('saved ✓'),
  'set.saveFailed': sys('save failed'),
  'set.syncing': same('syncing…'),
  'set.syncFailedPrefix': sys('sync failed:'),
  'set.syncedStats': same('synced: {n} nodes, {e} edges'),
  'set.noSources': same('no sources yet'),
  'set.noCollections': same('no collections yet'),
  'set.groupPrompt': same('Group name (saved as a collection):'),
  'set.landing': same('Landing surface'),
  'set.flags': same('Experiments'),
  'set.flagDrill': same('Journey drill view'),
  'set.flagDrillSub': same('adds DRILL to the journey view switch — one action opened into its beats with an inspector; off by default, per workspace'),
  'set.flagShots': same('Keep a design shot per sync'),
  'set.flagShotsSub': same('copies each screen\u2019s design image into .farsight/cache/shots at every sync, so a past sync can be looked at rather than described \u2014 one file per distinct image, whatever the number of syncs. It keeps designs, never a picture of the running app. Off by default, per workspace, because it writes files.'),
  'set.landingSub': same('where this browser lands on open — a default, never a cage: deep links always win'),
  'set.syncConsequence': same('re-parses sources on disk · rewrites graph.json · never modifies your code'),
  'set.saveConsequence': same('writes .farsight/settings.json in the workspace · nothing is re-ingested'),

  // ── scope picker ────────────────────────────────────────────────────────
  'scope.all': same('All sources'),
  'scope.allShort': same('all'),
  'scope.ungrouped': same('Ungrouped'),
  'scope.sources': same('Sources'),
  'scope.newGroup': same('＋ group from selection'),
  'scope.newGroupTitle': same('Save the current selection as a named group (collection)'),
  'scope.label': same('scope:'),

  // ── search palette ──────────────────────────────────────────────────────
  'palette.placeholder': same('Search functions, routes, components, tables… Enter to focus'),
  'palette.hint': same('type to search {n} nodes…'),

  // ── grammar book page ───────────────────────────────────────────────────
  'grammar.title': same('Grammar Book'),
  'grammar.sub': same('One symbol · one meaning · one word. Everything the product may draw or say, rendered from the same sprite and catalog the surfaces use — a symbol or string not on this page cannot render.'),
  'grammar.symbols': same('The business symbols'),
  'grammar.status': same('Status glyphs — glyph + word, never color alone'),
  'grammar.utility': same('Utility glyphs — drawn, no emoji in chrome'),
  'grammar.strings': same('The string catalog — both registers'),
  'grammar.colHud': same('HUD register'),
  'grammar.colPro': same('professional register'),
  'grammar.colDefine': same('first-use definition'),
  'grammar.invariant': same('invariant'),
  'grammar.amberRule': same('Amber policy: amber is the business-lens tint and the attention family (gates, STALE, WARNING) — nothing else. STALE is always clock + word; an incomplete decision arm terminates in the barred ring, never the violation hexagon.'),

  // ── the Changes words (chunk H6, change-history-2026-09 §7) ─────────────
  // One appended block, so the vocabulary H7 draws with is reviewable in one
  // place. The division of labour with `core/history.ts` is deliberate, and it
  // is why this block holds words and not sentences: every sentence that
  // carries a number, a sha or a count of rows is computed **once** in
  // `spineSentences()` / `spineRowNote()` / `INCOMPLETE_SENTENCE` /
  // `GIT_ABSENT_WORD`, and `farsight history` and `/api/history` return the same
  // one — so the command and the HUD cannot word a fact two ways. What lives
  // here is what a table cell, a chip or a heading holds: the short word for
  // each value those folds switch on, with the `define` that says what the word
  // may and may not claim. A second copy of a computed sentence in this catalog
  // would be a second chance for two surfaces to disagree about one fact, which
  // is the failure this phase exists to stop.
  //
  // Four rules this block keeps:
  //  - the six absence words stay closed. A commit no sync ingested is
  //    `journey.absent.notIndexed`, whose define is extended above rather than a
  //    seventh word minted here;
  //  - no evidence chip. Evidence says whether something runs; attribution says
  //    who touched a file. `journey.evidence.*` stays reserved for tests;
  //  - action · beat · step are untouched — a history has no beats;
  //  - nothing here implies a field on `farsight-diff v1`. `changes.attribution`
  //    describes the one optional field H4 added; the rest describe `/api/history`.

  'changes.sub': same(
    'Every sync of this graph beside the commits of the repositories it read — what Farsight measured, what git recorded, and which of the two a number came from.',
    'The Changes surface. A measured difference between two graphs and a repository log answer different questions; both are drawn here and neither is merged into the other.',
  ),

  // A · what a history is made of
  'changes.commit': same(
    'commit',
    'One recorded change to a repository: its author, time, subject, parents and the files it touched. What it did to the graph is knowable only if some sync read the code at it. A commit is never a node — it is a fact about the repository, not something the parser found in the code.',
  ),
  'changes.filesTouched': same(
    '{n} files touched',
    'The files a commit added, changed, deleted or moved, with git added and deleted line counts. A binary file carries no counts and none are invented for it.',
  ),

  // B · the spine: every sync, and the commits it read
  'changes.spine': {
    hud: 'Patch log',
    professional: 'Sync history',
    define:
      'Every sync of this graph, newest first, each with the commits its code contained that the sync before it did not. One row per sync, always — a sync with nothing to add is labelled, never dropped.',
  },
  'changes.col.when': same(
    'When',
    'When the sync ran. Commits are ordered newest first by author time for display only: which commits fall in a range is decided by ancestry, because consecutive commits share a second often enough that a clock would misplace them.',
  ),
  'changes.swept': {
    hud: 'read here',
    professional: 'commits read',
    define:
      'The commits this sync read that the previous sync had not — its own and everything between. Empty on a re-index; absent, never zero, when this sync\'s commit cannot be placed in the history.',
  },
  'changes.col.note': same(
    'What this row says',
    'One sentence per row: the subject of the newest commit it read, or the reason it has none. Computed once in the core, so this column and the CLI column are the same sentence.',
  ),
  'changes.reindexed': {
    hud: 're-indexed · no new commits',
    professional: 're-indexed on a newer build — no new commits',
    define:
      'This sync recorded the same commit as the one before it, and nothing says its files differ: the graph changed because the tool did, not because the software did. A sync whose files differ on the same commit says so on its own row (the working tree differs from HEAD); a sync from before content digests were recorded per source cannot tell the two apart.',
  },
  'changes.treeChanged': {
    hud: 'same commit · working tree differs',
    professional: 'same commit — the working tree differs from HEAD',
    define:
      'This sync recorded the same commit as the one before it, and the files it read differ from that sync\u2019s: uncommitted edits were indexed. The software changed here without a commit, which is why a test run can be older than this code while the commit column stands still.',
  },
  'changes.asOf': {
    hud: 'see it as it was',
    professional: 'open the graph as of this sync',
    define:
      'Re-renders the surfaces from the snapshot this sync wrote. A query against retained history, not a stored picture — so it can be searched, walked and compared like any other view.',
  },

  // C · what is known about a sync\'s commit — one word per state the core switches on
  'changes.state.recorded': same(
    'commit recorded',
    'This sync recorded a commit for this repository, and this repository\'s history contains it. The ordinary case, and the only one where what the sync read can be counted.',
  ),
  'changes.state.notInHistory': same(
    'not in this history',
    'The history was read and does not contain the sha this sync recorded — rewritten, pruned, or on a branch nothing here can see. The row is kept and labelled; a sync is never dropped for being unexplainable.',
  ),
  'changes.state.belowFloor': same(
    'older than the history read',
    'The commit is older than the oldest commit read here, so the miss is the read window and not the repository: read further back before calling it missing. A shallow clone cannot go further.',
  ),
  'changes.state.historyUnread': same(
    'history not read',
    'No commits have been read for this repository, so whether this sync\'s commit is in its history cannot be asked. Every number that would come from placing it is absent rather than zero.',
  ),
  'changes.state.noCommit': same(
    'no commit recorded',
    'The sync read this repository and stamped no commit for it. An existing row cannot be filled in afterwards: the commit that sync saw is not recoverable. Re-sync to record it from now on.',
  ),
  'changes.state.notInSync': same(
    'not in this sync',
    'The sync did not read this repository at all, so it never had a commit to stamp. Not a failure to record one — a different fact, kept apart from it and counted apart from it.',
  ),
  'changes.from.source': same(
    'stamped for this source',
    'The sync recorded this commit for this repository itself — the strongest provenance a row can have.',
  ),
  'changes.from.workspace': same(
    'the workspace commit',
    'The sync stamped only the workspace root commit. It counts as this repository\'s commit because this repository\'s own history contains that sha, which identifies one commit globally — never a sha borrowed from a repository that does not have it.',
  ),
  'changes.unverified': same(
    'unverified commit',
    'The workspace root\'s sha, neither taken as this repository\'s commit nor ruled out: no history has been read to check it against. Shown rather than hidden, because hiding it would report the sync as having stamped nothing.',
  ),

  // D · how far the history was read — the bound every count carries
  'changes.bound.floor': same(
    'a floor — at least this',
    'Every count on this page is at least this and possibly more: commits this history has not read could only raise it. Reading the history for this repository is what makes it exact.',
  ),
  'changes.bound.exact': same(
    'exact',
    'Every count here rests on a history that was read for this repository, so the numbers are the numbers — not a floor.',
  ),
  'changes.notASum': same(
    'these counts overlap: they do not add up',
    'Syncs, distinct commits, re-indexes and rows with no commit are four questions about the same rows, and one row can answer several. Nothing on this line is a total.',
  ),
  'changes.noGitHere': same(
    'no history to read',
    'git could not be run for this repository — no binary, not a repository, no commits yet, or git refused. The syncs still stand; every commit they cannot name reads not indexed.',
  ),
  'changes.shallow': same(
    'shallow clone — a floor',
    'The oldest commit read is where the clone was cut, not the first commit that exists. First seen in is therefore at or before it, in the same sense a coverage floor is at least.',
  ),
  'changes.detached': same(
    'detached HEAD',
    'HEAD points at no branch, so the history read is the single ancestry reachable from that commit. Other branches exist in the repository and were not walked.',
  ),

  // E · comparing two points — and what each kind of range can answer
  'changes.range.syncs': same(
    'sync {base} → sync {head}',
    'Two syncs of the graph. Farsight built a graph at both ends, so the difference between them is measured rather than inferred.',
  ),
  'changes.range.releases': same(
    'release {base} → release {head}',
    'Two declared releases, resolved to the commits they name. Measured only where a sync read the code at each of those commits.',
  ),
  'changes.range.commits': same(
    'commit {base} → commit {head}',
    'Two commits. No sync bracketed them, so this range can show what git recorded and no measured difference — the honest limit of a commit range.',
  ),
  'changes.partialRange': same(
    'this range cannot be closed at both ends',
    'One end is a sync that recorded no commit, or a commit this history does not contain. What follows is everything reachable from the other end, which is a ceiling on the question asked and not an answer to it.',
  ),
  'changes.rangeUnreadable': same(
    'this link does not name two points that can be compared',
    'What follows #/changes is not a range this grammar can read: two syncs, two declared releases or two commits. Nothing is drawn for it — not even the nearest thing it resembles — because rendering one comparison under another one\'s link is how a shared link comes to show something else.',
  ),
  'changes.measured': same(
    'What changed',
    'The difference Farsight measured between the two graphs: the frozen diff document, one entry per change, with the severity and confidence it carries.',
  ),
  'changes.narrative': {
    hud: 'Who and when',
    professional: 'Commits in this range',
    define:
      'What git recorded in this range: who committed, when, and which files. A narrative of the repository, never a measurement of the graph.',
  },
  'changes.sev.breaking': same(
    'breaking',
    'A change that can break something that depended on it: a route, record, message topic or gate that is gone. Severity is a fact of the change contract, fixed per kind — not a judgement made about this diff.',
  ),
  'changes.sev.notable': same(
    'notable',
    'A change worth reading before a release: a route or test added, a journey whose path is not what it was, a record whose columns moved, a surface that lost its last test. Fixed per kind by the change contract.',
  ),
  'changes.sev.info': same(
    'for information',
    'A change recorded so the account is complete: something added, a rule or a test appearing, a confidence or a name that moved. Fixed per kind by the change contract, and never a judgement that it is unimportant here.',
  ),
  'changes.sideBySide': same(
    'drawn side by side, never merged',
    'The measured difference and the repository log answer different questions, and a commit no sync read has no measured half at all. Merging them would let one borrow the other\'s authority.',
  ),
  'changes.hiddenInBusiness': same(
    'some kinds are left out here',
    'Confidence changes and renames are facts about how Farsight read the code, not about the software, so the business register leaves them out. The hybrid and code registers show every kind.',
  ),

  // F · who touched a file — attribution, and the line it must not cross
  'changes.attribution': {
    hud: 'who touched the file',
    professional: 'attribution',
    define:
      'The commits in this range that touched the file this change\'s subject lives in — file level, and not proof that any of them changed this route, table or function. A change with no file gets none, and a repository with no history read gets none rather than an empty list.',
  },
  'changes.fileLevel': same(
    'file level',
    'The granularity of every provenance claim here. The commits that touched a file are not the commits that changed a function inside it, and only the first is knowable from a repository log.',
  ),
  'changes.rename': same(
    '{n} renamed',
    'git matched these paths as one file that moved. Node ids carry the path, so the measured difference reports the old ones removed and the new ones added — a large count of removals that deleted nothing.',
  ),
  'changes.renameIdentical': same(
    '{n} of them byte-identical',
    'git scored the content the same on both sides of the move: nothing in the file changed but where it lives.',
  ),
  // label form, not a sentence: `{commits} commits by {people} since {date}` read
  // "1 commits by 1 since 2026-09-06" the first time real data went through it, and
  // a count of people with no noun beside it is not a number a reader can use
  'changes.byWhom': same(
    'commits: {commits} · authors: {people} · since {date}',
    'Who committed in this range and over what period. A count of commits and of the people who authored them — not a measure of how much changed.',
  ),
  'changes.touchedFiles': same(
    '{n} touched a file this page names',
    'Of the commits in this range, how many touched a file one of the changes above lives in. File level, so it says these commits and these changes met in a file — not that one caused the other.',
  ),

  // G · what a release is — declared, never discovered
  'changes.release': same(
    'release',
    'A named point a person declared in Farsight\u2019s settings file for the workspace. Farsight never promotes a tag to a release on its own and never invents one from the last few commits.',
  ),
  'changes.tagProposed': {
    hud: 'proposed tag',
    professional: 'tag found — proposed, not a release',
    define:
      'A tag read from the repository and offered for a person to accept. Repositories carry several naming schemes at once and two spellings can name one commit, which is why a tag is a proposal and a release is a declaration.',
  },
  'changes.noReleases': same(
    'no releases declared — grouped by sync',
    'Nothing has been declared as a release for this workspace, so this surface groups by sync. A repository with no tags is not a repository with no releases, and a repository with tags does not thereby have releases.',
  ),

  // H · what this page is reading, and what it could not draw (chunk H7)
  'changes.repo': same(
    'repository',
    "Whose history this page is reading. The sync history and the commit narrative are per repository, because a commit belongs to one: a sync of a multi-source workspace records a commit for each source it walked, and folding them together would hand one repository another's commits.",
  ),
  'changes.servedHere': {
    hud: 'the graph on screen',
    professional: 'the sync the other surfaces are showing',
    define:
      'This sync wrote the snapshot the rest of this viewer is rendering. Marked because every number in the product is as of one sync, and this says which one. Reading an older sync is chosen when the server is started, not with a link here.',
  },
  'changes.listCut': same(
    'the list of changes was cut — the counts above are complete',
    'More changes were measured than are listed: the list stops at the limit it was asked for while the counts are always whole. Raise the limit to see the rest, and never read the short list as the whole difference.',
  ),
  'changes.nothingMeasured': {
    hud: 'nothing the contract reports changed',
    professional: 'both graphs were built and compared, and differ in nothing this contract reports',
    define:
      'A measurement, not an absence: a graph exists at both ends and no change of a kind farsight-diff v1 carries was found — routes, records, columns, gates, journeys, messages, rules, tests, coverage. A changed function body, a comment, a moved line are real edits this contract deliberately does not report, so this is not a claim that nothing was edited.',
  },

  // the grammar page group, by the question each set of words answers
  'grammar.changesWords': same('The changes words', 'Every word the Changes surface may print, grouped by the question it answers, rendered from the live catalog with its key.'),
  'grammar.changesWords.units': same('What a history is made of', 'The two things this surface counts: syncs of the graph, and commits of the repositories those syncs read.'),
  'grammar.changesWords.spine': same('What each sync read', 'The columns of the sync history, and the words for a sync that read nothing new.'),
  'grammar.changesWords.placed': same('What is known about a sync\'s commit', 'Six states, because there are six different reasons a sync\'s commit can or cannot be placed in a repository\'s history — and drawing them as one would hide five of them.'),
  'grammar.changesWords.bounds': same('How far the history was read', 'Whether the counts here are exact or a floor, and the four repository conditions that make them a floor.'),
  'grammar.changesWords.range': same('What two points can be compared', 'The three kinds of range, and which of them can carry a measured difference rather than only a repository log.'),
  'grammar.changesWords.provenance': same('Who touched a file', 'File-level attribution and the claims it may not make. Not evidence: evidence says whether something runs.'),
  'grammar.changesWords.releases': same('What a release is', 'Declared by a person, never discovered by the tool — and what a tag is instead.'),

  // ── the Tests surface (03 §2.10) ────────────────────────────────────────
  // The evidence classes and the absence words are NOT redefined here: the
  // tab prints journey.evidence.* and journey.absent.* — one vocabulary for
  // one fact, or the two pages drift apart. The identity line is
  // chrome.identity, the same one the sync chip prints.
  'tests.sub': same(
    'One card per source and level; one row per journey. Evidence is a class on an edge; a run is a fact about a test. Nothing here is computed in the viewer.',
    'The Tests surface reads /api/tests, and every number on it is a fold the server computed — so the same number prints in the CLI and to an agent.',
  ),
  'tests.loading': same(
    'loading tests…',
    'The surface has asked the server for the catalogue and has no answer yet — this is not an empty result.',
  ),
  'sys.testsFailed': {
    hud: 'Could not load the tests surface.',
    professional: 'Could not load the tests surface.',
    invariant: true,
    define: 'The request did not return a catalogue. Nothing on this page is measured, and no absence shown here is a fact about the code.',
  },
  'tests.empty': same(
    'No tests are indexed in this graph — either the sources have none, or their spec files were excluded from ingest.',
    'Zero test nodes in scope. It says what Farsight read, never that the application is untested.',
  ),

  // views (the tab's four lists) and the level filter
  'tests.view.matrix': same('Matrix', 'One row per journey: its end-to-end evidence, the share of its coverable nodes a test reaches, and what is missing.'),
  'tests.view.suites': same('Suites', 'The indexed spec files grouped by source and level, each with its cases and its last run.'),
  'tests.view.orphans': same('Orphans', 'Tests whose claims land on nothing the graph knows — a @covers nobody matches, or a rendered component that resolved to no node.'),
  'tests.view.freshness': same('Freshness', 'One row per configured report: what matched, when it ran, whether its digest still matches the code.'),
  'tests.level.all': same('all', 'Every level together.'),
  'tests.level.unit': same('unit', 'A test of one part with its neighbours stood in for.'),
  'tests.level.integration': same('integration', 'A test that crosses more than one part in one process — counted as its own level, never folded into unit.'),
  'tests.level.e2e': same('e2e', 'A test that drives the built product through its own doors — a browser page, or an HTTP request against a running server.'),

  // the header numbers
  'tests.kpi.reached': same(
    'coverable nodes reached by any test',
    'The share of the nodes a test could reach that at least one test reaches — always printed with the scope it was measured in.',
  ),
  'tests.kpi.indexed': same('tests indexed', 'Cases this build read out of the spec files in scope — not cases a runner executed. A coverage report is not a case and is not counted here; the code map’s test tag counts the parts tagged test, reports included, so it can be larger by the number of reports.'),
  'tests.kpi.flowsE2e': same('journeys with an end-to-end test body', 'Journeys where a test body actually opens a page or calls a route on the flow — a header claim alone does not count.'),
  'tests.kpi.lastRuns': same('last runs', 'The newest report read per level, with what it said and whether its digest still matches the code.'),
  'tests.kpi.gaps': same('blind spots', 'Places the tool could not read evidence: a report that matched no file, one it cannot parse, a claim that resolves to nothing, a run with no digest.'),
  'tests.excluded': same(
    'excluded: manifest-only {m} · plumbing {p} · presentational {c} · declared-only routes {d}',
    'What the denominator leaves out, and how many of each — a node with no code behind it, a plumbing helper, a rendered UI primitive, a route only the spec declares.',
  ),

  // the journeys × tests matrix
  'tests.col.journey': same('Journey', 'One row per journey in scope, named as the design manifest names it.'),
  'tests.col.screens': same('Screens built', 'How many of the journey’s declared screens have code behind them.'),
  'tests.col.e2e': same('End-to-end evidence', 'The strongest end-to-end word this journey has earned, and the node whose test body earned it.'),
  'tests.col.reached': same('Coverable nodes reached', 'The journey’s own metric with its scope label — the same denominator the journey header prints.'),
  'tests.col.declared': same('Declared', 'Tests whose author says they cover something here (@covers) — a claim, not a reach.'),
  'tests.col.reachedTests': same('Reached', 'Tests whose body imports, renders or requests something here.'),
  'tests.col.observed': same('Observed', 'Tests a run report actually saw here, on code whose digest still matches.'),
  'tests.col.missing': same('What is missing', 'What this row does not prove, said as a sentence — never a blank cell.'),
  'tests.row.nothingToMeasure': same(
    'nothing to measure',
    'Zero coverable nodes in this scope — every screen is manifest-only, or everything in it is plumbing. A percentage here would be a number about nothing.',
  ),
  'tests.card.line': same('{files} spec files · {cases} cases · {projects} projects', 'What this source and level holds: the spec files read, the cases found in them, and the runner projects that ran them.'),

  // what a run said, and whether it still speaks for this code
  'tests.run.passed': same('passed', 'The run finished and the case met its expectations.'),
  'tests.run.failed': same('failed', 'The run finished and the case did not meet its expectations. One failing project fails the case.'),
  'tests.run.skipped': same('skipped', 'The runner did not execute it — it proves nothing, and it never counts as evidence.'),
  'tests.run.flaky': same('flaky', 'The reporter retried it and it then passed — its own status, never passed.'),
  'tests.run.unknown': same('unknown', 'A row exists but the report does not say what happened.'),
  'tests.run.notRun': same('no row in the report', 'The case is indexed and the report read; this case is not in it.'),
  'tests.run.line': same('{status} · {at} · {freshness}', 'One run, as three facts: what it said, when it said it, and whether the code has changed since.'),
  'tests.freshness.unchanged': same('digest matches', 'The run recorded a digest of the code it ran against, and that digest is still the code’s.'),
  'tests.freshness.changed': same('code changed since the run', 'The report’s digest differs from the code’s — evidence of the past, not of now.'),
  'tests.freshness.changedTree': same('working tree differs from HEAD', 'The report\u2019s digest differs from the code\u2019s, and no commit has been made since the run: the files that differ are uncommitted edits, so the Changes page shows the same commit. Evidence of the past, not of now.'),
  'tests.freshness.unknown': same('no source digest', 'The report records no digest, so unchanged-since-the-run cannot be proven. A file’s timestamp is not evidence.'),

  // blind spots — what the tool could not read, named artefact by artefact
  'tests.blind.missing': same('matched 0 files', 'A configured report glob matched nothing on disk: the run never happened, or it wrote somewhere else.'),
  'tests.blind.unreadable': same('not a report this build reads', 'The file exists and this build does not recognise its shape — it contributes nothing.'),
  'tests.blind.empty': same('empty report', 'The file is a report and records nothing — a run that observed no test.'),
  'tests.blind.claim': same('declares {v}, which nothing in the graph matches', 'A @covers names something the graph has no node for — a renamed target, or a step id the manifest never declared.'),
  'tests.blind.each': same('{n} parametrised cases could not be joined', 'The report prints expanded rows and the spec writes a template; these rows matched no template, so their runs are unattributed.'),
  'tests.blind.digest': same('records no source digest', 'The run left no digest, so the tool cannot say the code is unchanged since — the run stays evidence, exactness does not.'),
  'tests.blind.config': same('no tests block in farsight.config.json', 'No reports are configured for this source, so run evidence is impossible here — declared and reached only.'),
  'tests.blind.fold': same('×{n} · show all', 'The same finding on several artefacts, folded to one line. The list under it names every one; the JSON is never folded.'),

  // orphans
  'tests.orphan.coversNothing': same('covers nothing the graph knows', 'The case was read and none of its claims or reaches landed on a node — it measures nothing here.'),
  'tests.orphan.unresolved': same('declares {v}, which nothing in the graph matches', 'The claim was read verbatim and kept; no node answers to it.'),
  'tests.orphan.whyRender': same('the rendered component did not resolve to a node', 'The body renders something this build could not tie to a component — the reach is real, the target is unknown.'),
  'tests.orphan.whySteps': same('the manifest has no steps[] for {screen}', 'The claim names a step of a screen whose manifest declares no steps — the screen resolves, the step cannot.'),

  // one test's own page
  'tests.detail.declared': same('Declared', 'What this test’s author says it covers.'),
  'tests.detail.reached': same('Reached', 'What this test’s body imports, renders or requests.'),
  'tests.detail.observed': same('Observed', 'What a run report saw this test touch.'),
  'tests.detail.runs': same('Runs', 'One card per runner project — a case run in two projects has two verdicts.'),
  'tests.detail.journeys': same('Journeys', 'The journeys whose scope this test reaches into.'),
  'tests.detail.asWritten': same('@covers as written', 'The claim exactly as the source writes it, resolved or not — the tool never rewrites an author’s words.'),
  'tests.detail.weakest': same(
    'the case is {status} because one project {status2} — never a majority',
    'A case run in several projects takes the weakest verdict of them. One failure is a failure.',
  ),
  'tests.digest.cmd': same('farsight digest --repo {repo}', 'The command that prints the content digest a run should stamp, so a later import can prove the code has not changed.'),
  'tests.import.cmd': same(
    'farsight tests import --repo {repo} --level {level} --results <glob> --coverage <glob> --stamp $(farsight digest --repo {repo}) --strict',
    'The import that attaches a run to this graph. The stamp is refused unless it is the checkout’s own digest, and --strict fails on a glob that matched nothing, a report this build cannot read, or a report that joined no case.',
  ),

  // ── the tab itself (B3.3: boards 05 + 08) ───────────────────────────────
  // What is drawn where: the strip's identity and counts, the five header
  // numbers, the source cards, the matrix, the suites, the orphans, the
  // reports. Two rules have their own words here because the reviews found
  // them broken elsewhere: a percentage never leaves its bound (`metric.*`),
  // and an observed class carried only by run-level coverage says so
  // (`tests.runOnly`, `tests.observedSplit`) instead of implying a test was
  // watched. No new evidence class and no seventh absence word.
  'tests.counts': same('{cases} cases · {files} spec files · {journeys} journeys · {sources} sources'),
  'tests.scope': same('scope {label}', 'Which sources these numbers were measured in. Every number on the page is scoped to it, and the scope travels with each one.'),
  'tests.reportsRead': same('{n} reports read', 'Report files this build read for the sources in scope — one entry per matched file, plus one per configured glob that matched nothing.'),
  'tests.digestLine': same('content digest {list}', 'The digest of the code this graph was built from, per source. A run stamped with the same digest is evidence about this code; any other digest is evidence about other code.'),
  'tests.retry': same('ask again', 'Repeat the same request. Nothing on the page is kept from the failure — an error is not a measurement.'),
  'tests.metric.floor': same('≥ {pct}', 'At least this much — the evidence proves no less, and something in the scope could not be proven either way.'),
  'tests.metric.exact': same('{pct}', 'Exactly this much: every coverable node in the scope sits in a fresh report’s file set.'),
  'tests.metric.floorWhy': same('a floor — {why}', 'Why the number is a floor rather than an exact share, in the fold’s own words.'),
  'tests.metric.floorBare': same('a floor', 'The exact rule could not be proven on this scope, and the fold recorded no reason.'),
  'tests.kpi.indexedSub': same('{unit} unit · {integration} integration · {e2e} e2e', 'Cases per level. Integration is its own level and is never folded into unit.'),
  'tests.kpi.indexedFiles': same('{files} spec files in {sources} sources · {runners}'),
  'tests.kpi.flowsE2eSub': same('{reached} reached · {observed} observed · {declared} declared only · {none} none'),
  'tests.kpi.gapsKinds': same('{kinds} kinds · {n} findings', 'How many distinct kinds of unreadable evidence, and how many artefacts carry them.'),
  'tests.kpi.gapsKindOne': same('1 kind · {n} findings'),
  'tests.kpi.gapsOne': same('1 kind · 1 finding'),
  'tests.kpi.gapsFindings': same('{n} findings'),
  'tests.gapsNone': same('nothing was unreadable', 'The tests pass ran for every source in scope and found no missing artefact, no unreadable report and no unresolved claim.'),
  'tests.gapsAbsent': same(
    'this graph records no list of blind spots',
    'Different from an empty list: no source in scope recorded what it could not read, so this page cannot say whether anything was unreadable.',
  ),
  'tests.reportsAbsent': same(
    'this graph records no reports',
    'No source in scope recorded a report list — the graph was written before reports were tracked, or no run evidence was ever configured. It is not a statement that no report exists.',
  ),
  'tests.reportsNone': same('no report is configured for any source in scope', 'The tests pass ran and matched no configured report: declared and reached evidence only.'),
  'tests.sec.sources': same('Sources and levels'),
  'tests.sec.recipe': same('How a run becomes provable', 'The two commands that make a run’s evidence checkable: the digest of the code before the run, and the import that refuses a stamp which is not that digest.'),
  'tests.card.lineNoProjects': same('{files} spec files · {cases} cases'),
  'tests.runner': same('runner', 'The tool that runs these cases and wrote the report this build read.'),
  'tests.col.evidence': same('Strongest evidence', 'The strongest class of evidence on this journey’s scope — a class of an edge, never a verdict of a run.'),
  'tests.col.suite': same('Spec file'),
  'tests.col.level': same('Level'),
  'tests.col.cases': same('Cases'),
  'tests.col.verdicts': same('What the run said'),
  'tests.col.lastRun': same('Last run'),
  'tests.col.test': same('Test'),
  'tests.col.reason': same('Why it lands on nothing'),
  'tests.col.claim': same('Declares'),
  'tests.col.kind': same('Report'),
  'tests.col.glob': same('Configured glob'),
  'tests.col.matched': same('Matched'),
  'tests.col.digest': same('Digest'),
  'tests.col.adds': same('What it adds'),
  'tests.matrixSub': same('one row per journey in scope · every denominator is its journey’s own scope, counted once',
    'One row per journey, and each row’s denominator is the scope that journey walks — the same number the journey itself reports, from the same fold. The journey overlay prints the evidence word and the counts rather than the percentage, so this is where a denominator is read.'),
  'tests.noSum': same(
    'journeys share screens, routes and the tests that reach them: these rows do not add up',
    'The same test reaches several journeys, so adding a column down the table counts it more than once. Each row is measured on its own scope.',
  ),
  'tests.noJourneys': same('no journey is declared in this scope', 'No design manifest names a flow here, so there is nothing to measure a journey against.'),
  'tests.exportCsv': same('the matrix as CSV', 'Every (journey, node, test, edge) row with its evidence class, technique, confidence, run and digest — the farsight-tests-matrix v1 document, uncapped.'),
  'tests.via': same('via {node}', 'The node whose test body earned the end-to-end word for this journey.'),
  'tests.sharedWith': same('shared with {flow}', 'Other journeys whose scope holds that same node — the word was earned on code this journey shares, not on something unique to it.'),
  'tests.evidence.runSeen': same(
    'seen by a coverage run',
    'The observed class, said precisely: a coverage report shows a run reached this code, and it does not say which case reached it. Not a fourth class — the same observed evidence, attributed to the run instead of to a test, because “verified by a run” is reserved for evidence a results report tied to a case.',
  ),
  'tests.evidence.runSeenStale': same(
    'seen by a coverage run · stale',
    'A coverage report shows a run reached this code, the code has changed since, and the report does not say which case reached it. The same observed class as “verified · stale”, attributed to the run instead of a test \u2014 so it never wears the word “verified”.',
  ),
  'tests.evidence.declaredPassed': same(
    'passed, by its own declaration',
    'The observed class, earned the one way an end-to-end run can earn it without coverage: a results report says the case passed, and the case itself declares (@covers) that it covers this. No measurement shows which lines it ran, so it is the author\u2019s claim, confirmed by a pass \u2014 not a fourth class, and never worded as a run seen reaching the code. A failed, flaky, skipped or unrun case stays declared only.',
  ),
  'tests.evidence.declaredPassedStale': same(
    'passed, by its own declaration · stale',
    'A results report says an end-to-end case that declares this code passed, and the code has changed since that run \u2014 evidence of the past, not of now.',
  ),
  'tests.observedSplitDecl': same('{tests} tests · {decl} passed, by their own declaration · {runs} run reports',
    'Observed evidence, split by how it was earned: cases a run\u2019s coverage placed on this code, end-to-end cases that passed and declare this code, and run-level coverage reports with no per-case attribution.'),
  'tests.runOnly': same(
    'no single test was observed here — {n} run reports were',
    'The observed evidence comes from coverage reports, which say what a run reached without saying which case reached it. The class is real; the attribution to one test does not exist.',
  ),
  'tests.runOnlyOne': same(
    'no single test was observed here — one run report was',
    'The observed evidence comes from one coverage report, which says what a run reached without saying which case reached it. The class is real; the attribution to one test does not exist.',
  ),
  'tests.observedSplit': same('{tests} tests · {runs} run reports', 'Observed evidence, split by who observed it: cases a results report named, and run-level coverage reports with no per-case attribution.'),
  'tests.row.noScreenBuilt': same(
    'no screen of this journey is built — what reaches it reaches its routes and the code behind them',
    'The evidence is real and it is not on this journey’s screens, because none of them has code yet.',
  ),
  'tests.run.weakest': same('the weakest verdict of every test that reaches it', 'A scope takes the weakest verdict among the tests covering it: one skipped or failing case is not covered by a hundred passing ones.'),
  'tests.fold.cases': same('{n} cases'),
  'tests.fold.hide': same('hide'),
  'tests.case.covers': same('covers {n}'),
  'tests.orphan.unresolvedReason': same('declares something the graph does not have'),
  'tests.orphansNote': same(
    'an orphan is not a bad test: it is a test this build could not tie to a node',
    'The case was read and neither its claims nor its reaches landed on a node. That is a fact about what the tool resolved, not a judgement of the test.',
  ),
  'tests.noOrphans': same('every indexed test lands on something the graph knows'),
  'tests.bsKind.missingArtefact': same('missing artefact', 'A configured report matched no file: the run never happened, or it wrote somewhere else.'),
  'tests.bsKind.unreadable': same('unreadable', 'The file exists and this build does not recognise its shape.'),
  'tests.bsKind.empty': same('empty report', 'A report that records nothing — a run that observed no test.'),
  'tests.bsKind.unresolvedClaim': same('unresolved claim', 'A @covers names something the graph has no node for; the claim is kept verbatim and resolves nothing.'),
  'tests.bsKind.unjoinedEach': same('unjoined rows', 'The report prints expanded parametrised rows the spec writes as a template, and they matched no case.'),
  'tests.bsKind.noDigest': same('no digest', 'The run left no digest of the code it ran against, so unchanged-since-the-run cannot be proven.'),
  'tests.bsKind.digestChanged': same('digest changed', 'The report’s digest is not this code’s: evidence of the past, not of now.'),
  'tests.bsKind.noConfig': same('not configured', 'No reports are configured for this source, so run evidence is impossible here — declared and reached only.'),
  'tests.bsKind.recorded': same('recorded', 'A blind spot this graph recorded as a sentence, before the kinds were kept as data.'),
  'tests.rep.matched': same('{n} files'),
  'tests.rep.matchedOne': same('1 file'),
  'tests.rep.joined': same('{n} cases joined', 'Rows of the report that were matched to a case this build indexed.'),
  'tests.rep.edges': same('{n} observed edges', 'Nodes this report showed a run reaching — the observed evidence it added.'),
  'tests.rep.each': same('{j} of {t} parametrised joined'),
  'tests.rep.unjoined': same('{n} rows joined no case'),
  'tests.rep.nothing': same('nothing — this report added no evidence'),

  // ── one test's own page (B3.4: board 06) ────────────────────────
  // The page prints three groups and no fourth, and it keeps two facts apart
  // that every review saw blended: the **class** of an edge (declared · reached
  // · observed) and the **verdict** of a run. A confidence tier belongs to the
  // edge, never to the class — a declared edge can be HIGH and a reached one
  // LOW — so each row prints its own technique and tier, and the group head
  // says only how that class is found.
  'tests.detail.back': same('all tests', 'Back to the catalogue this test was opened from.'),
  'tests.detail.notFound': same(
    'no test in this graph has that id',
    'The link names a test id this build did not index. The test may have been renamed, or its spec file may be excluded from ingest.',
  ),
  'tests.detail.suite': same('suite {path}', 'The describe path this case sits under, outermost first — what a report row must match to join it.'),
  'tests.detail.ident': same('{level} · {runner}'),
  'tests.detail.projects': same('projects {list}', 'The runner projects that executed this case. Each one is its own run with its own verdict.'),
  'journey.tests.runProjects': same('Run in the runner projects {list}.', 'The runner projects that executed this run (a Playwright project, say). Each one is its own run with its own verdict.'),
  'tests.detail.runLevel': same(
    'a run report, not a test case',
    'A coverage report with no per-case attribution is indexed as one node so its observations have somewhere to hang. It is never counted as a test, and it has no author and no claims.',
  ),
  'tests.detail.runLevelFiles': same('the report covered {n} files', 'Every file the coverage report contained, hit or not — the file set the exactness rule reads.'),
  'tests.detail.edges': same('{n} edges'),
  'tests.detail.how.declared': same(
    'the author says so — @covers, in the file header or on the case',
    'A claim read out of the source. It is the author’s word about intent; nothing was imported and nothing ran.',
  ),
  'tests.detail.how.reached': same(
    'the test body imports, renders or requests it',
    'Static evidence: the case’s own code names this node, or a URL literal in it matches a route. It is a floor — it does not say the code ran.',
  ),
  'tests.detail.how.observed': same(
    'a run report saw it execute',
    'A results or coverage report recorded this node running. Only this class can say a run happened.',
  ),
  'tests.detail.none.declared': same('this case declares nothing', 'No @covers on the case or its file header. A claim is optional; its absence says nothing about what the test reaches.'),
  'tests.detail.none.reached': same('nothing in this case’s body resolved to a node', 'The body was read and neither its imports, its renders nor its URL literals landed on something the graph has.'),
  'tests.detail.none.observed': same(
    'no run report named this case',
    'No report attributed an observation to this case. A results report can do that; a coverage report cannot — its observations belong to the run.',
  ),
  'tests.detail.none.runLevel': same(
    'a report has no author and no body — it carries only what the run saw',
    'A run-level node is a coverage report, not a case. It declares nothing and reaches nothing; its only evidence is the observed class below.',
  ),
  'tests.detail.skippedNoObserved': same(
    'the run did not execute this case, so it observed nothing',
    'A skipped case has a row in the report and no result. Nothing it claims or reaches was seen to run by it.',
  ),
  'tests.detail.inactive': same(
    'inactive — .skip or .todo, it lifts nothing',
    'The case exists in the source and is switched off. It is listed so it is not mistaken for absent, and it raises no chip and no end-to-end word.',
  ),
  'tests.detail.match': same('matched by {how}', 'How the coverage row met the node: by name and line, by name after the line drifted, or by line ±1 with a different name — the weakest of the three.'),
  'tests.detail.twin': same(
    'one of these — {note}',
    'The resolution had more than one candidate and picked this one by name. The others are set aside, not ruled out: read this row as evidence about one of the named shapes.',
  ),
  'tests.detail.alternatives': same('set aside: {list}', 'The candidates this resolution did not take. They are printed because a choice nobody sees is a guess nobody can check.'),
  'tests.detail.agree': same('{n} projects, the same verdict', 'Every project that ran this case said the same thing, so the case’s verdict is not a fold over disagreement.'),
  'tests.detail.duration': same('{s} s'),
  'tests.detail.retries': same('retries {n}', 'How many times the runner re-ran it before recording this verdict. A retry that then passed is flaky, never passed.'),
  'tests.detail.report': same('from {path}', 'The report file this run was read out of.'),
  'tests.detail.join': same('joined by an exact name', 'The report row carried the same full name as this case, so the join is unambiguous.'),
  'tests.detail.joinEach': same('joined {n} parametrised rows', 'The case is a template that runs once per row of a table, and the report prints expanded titles; this run folds the rows the template matched.'),
  'tests.detail.byRun': same('saw {n} of them run', 'How many of the nodes this case reaches that run report observed. It is evidence about the run, not about this case.'),
  'tests.detail.journeysNone': same('no journey holds a node this test reaches', 'The test is real and no declared flow’s scope contains what it covers — often a library nothing on a journey calls yet.'),

  // the grammar book's tests group
  'grammar.testsWords': same('The tests words'),
  'grammar.testsWords.note': same('The four evidence classes and the six absence words are the journey words above — the Tests surface prints those same keys, so a word means the same thing on both pages.'),
  'grammar.testsWords.levels': same('What kind of test it is'),
  'grammar.testsWords.run': same('What a run said'),
  'grammar.testsWords.freshness': same('Whether the run still speaks for this code'),
  'grammar.testsWords.runSeen': same(
    'when a run saw it and no test claims it',
    'The words the Tests pages use when coverage from a run is the evidence and no single case can be named as the one that reached the code.',
  ),
  'grammar.testsWords.blind': same('What the tool could not read'),

  // ── work items: the Jira Cloud provider (packages/work-jira) ──────────
  // Words the provider hands to every consumer: its declared capabilities, the
  // tracker's own verdict (§7.3 verdict 2), the credential probe and the write
  // errors. Placeholders are filled by the provider before the words leave it.
  'work.jira.cap.comments': same('comments in Atlassian Document Format', 'Jira keeps comment and description text as a structured document, not plain text; Farsight converts it to and from markdown.'),
  'work.jira.cap.transitions': same('transitions asked per item', 'Jira does not publish a workflow map to an ordinary account, so Farsight asks each item which status changes it allows right now.'),
  'work.jira.cap.concurrency': same('conflicts found by comparing the last update', 'Jira has no version check on a write. Before every write Farsight re-reads the item’s last-updated time; if it moved since the copy was read, the write is a conflict and is not sent.'),
  'work.jira.cap.deletes': same('deletions seen only by a reconcile scan', 'A deleted Jira item never matches a search for recent changes, so deletions and moves are found by a periodic scan of every key in scope.'),
  'work.jira.cap.noDryRun': same('no preview', 'Jira cannot try a write without making it, so there is no preview button for a Jira source.'),
  'work.jira.field.found': same('found on the site', 'The provider read this field mapping from the Jira site itself: the Sprint field by its type, the estimate field from the board settings.'),
  'work.jira.field.declared': same('declared by you', 'This field mapping was pinned in the source settings and overrides what the site says.'),
  'work.jira.credential.project': same('{project}: {list}', 'What this Jira account may do in one project in scope, as Jira answered when the source connected.'),
  'work.jira.perm.browse': same('browse', 'Jira’s Browse Projects permission: the account can see the project’s items.'),
  'work.jira.perm.edit': same('edit issues', 'Jira’s Edit Issues permission: the account can change an item’s title, description, labels and other fields.'),
  'work.jira.perm.comment': same('add comments', 'Jira’s Add Comments permission.'),
  'work.jira.perm.assign': same('assign issues', 'Jira’s Assign Issues permission: the account can set who an item is assigned to.'),
  'work.jira.perm.transition': same('transition issues', 'Jira’s Transition Issues permission: the account can move an item to another status.'),
  'work.jira.perm.link': same('link issues', 'Jira’s Link Issues permission: the account can say one item blocks, duplicates or relates to another.'),
  'work.jira.perm.none': same('nothing', 'Jira granted this account none of the permissions Farsight asks about in this project.'),
  'work.jira.says.yes': same('Jira says: yes', 'Jira’s own answer for this item and this account: the change is allowed. Farsight’s own policy and the credential are asked separately.'),
  'work.jira.says.lacks': same('Jira says: no — this account may not {permission} on {key}', 'Jira’s own answer: the account lacks the permission this change needs on this item.'),
  'work.jira.says.noTransition': same('Jira says: no transition from {state}', 'Jira offers this account no status change from the item’s current status.'),
  'work.jira.says.noTransitionTo': same('Jira says: no transition from {from} to {to}', 'None of the status changes Jira offers from the current status leads where the request asked to go.'),
  'work.jira.says.notEditable': same('Jira says: {field} is not editable on {key}', 'The field is not on the item’s edit screen for this account, so Jira would refuse the change.'),
  'work.jira.says.notVisible': same('Jira says: {key} is not visible to this account', 'Jira answered as if the item did not exist: it was deleted, moved, or this account may not see it.'),
  'work.jira.says.cannot': same('this source cannot {action} yet', 'The Jira provider does not perform this kind of change, so nothing is asked of Jira.'),
  'work.jira.conflict': same('{key} changed on Jira since it was read', 'The item’s last-updated time on Jira no longer matches the copy the request was made against. Nothing was written; re-read the item and decide again.'),
  'work.jira.conflict409': same('Jira refused a conflicting update to {key}: {reason}', 'Jira itself reported that another change collided with this one. Nothing was written.'),
  'work.jira.error.refused': same('Jira refused the write ({status}): {reason}', 'Jira answered the write with an error; its own words follow the status.'),
  'work.jira.error.emptyLabels': same('no labels to add or remove', 'A label change named no label to add and none to remove.'),
  'work.jira.error.unknownField': same('cannot edit {field}: it is not mapped to a Jira field', 'The provider edits the title, description, labels and estimate, plus any field pinned in the source settings; this one is none of those.'),
  'work.jira.error.transitionNeeds': same('the status change needs {fields}, which the request does not give', 'Jira shows a form for this status change with required fields that have no default.'),
  'work.jira.error.noTarget': same('a link needs a target item', 'A link change named no item to link to.'),
  'work.jira.error.linkKind': same('no Jira link type for {kind}; name one', 'Jira has no built-in link type for this kind of link; the request must name the site’s link type.'),
  'work.jira.error.noSite': same('Jira source {source} names no site address', 'A Jira source needs its site address in the settings: the address people open Jira at in a browser.'),
  'work.jira.error.noUser': same('Jira source {source} names no account email', 'A Jira API token signs in together with the email of the account it belongs to.'),
  'work.jira.error.noSecret': same('Jira source {source} names no API token in the keychain', 'The source settings name where the token is kept, never the token itself.'),

  // ── stories: a component shown on its own (ADR 9) ──────────────────────
  // The graph reads each story from its *.stories file; a running Storybook
  // draws it. "not reached" and "none indexed" are borrowed absence words —
  // a Storybook that is not running is not a seventh kind of nothing.
  'stories.title': {
    hud: 'Showcase',
    professional: 'Stories',
    define: 'A story renders one component on its own, in one state its author set up. The list is read from the component\u2019s story file; the picture is drawn live by the repo\u2019s Storybook when it runs.',
  },
  'stories.count': same('{n} stories', 'Stories that render this component, read from its story file.'),
  'stories.countOne': one('1 story', 'stories.count'),
  'stories.docs': same('Docs page', 'The page Storybook writes for the component from its stories and its props — listed by the running Storybook, not by the story file.'),
  'stories.running': same('Storybook running', 'The Storybook answered just now and its list of stories was read. Farsight did not start it and never does.'),
  'stories.checking': same('checking whether Storybook is running…'),
  'stories.notRunning': same('Storybook is not running at {url}. Start it with {command} and check again \u2014 Farsight shows it, it never starts it.',
    'The stories are in the graph, read from their files; only the live picture needs the Storybook. The command is the one the repo\u2019s own scripts use.'),
  'stories.notRunningNoCmd': same('Storybook is not running at {url}. Start the repo\u2019s Storybook and check again \u2014 Farsight shows it, it never starts it.',
    'The stories are in the graph, read from their files; only the live picture needs the Storybook. The repo\u2019s scripts name no command to start it.'),
  'stories.noUrl': same('No address is recorded for this Storybook. Add storybook.url to the repo\u2019s farsight.config.json, or to the source in Settings.',
    'Farsight only frames a Storybook address the repo declares or its scripts name; it does not guess one.'),
  'stories.notListed': same('not listed by the running Storybook',
    'The story file has this story and the Storybook that is running does not list it. A Storybook reads new story files and globs when it starts \u2014 restart it to draw this one.'),
  'stories.none': same('No story renders this component.', 'Nothing in the repo\u2019s story files names this component as the one it renders.'),
  'stories.retry': same('Check again', 'Ask the Storybook for its list of stories again, now.'),
  'stories.openLarge': same('Open large', 'Draw the story at the size of the window, with every story of the component beside it.'),
  'stories.openInStorybook': same('Open in Storybook', 'The same story in Storybook\u2019s own window, with its controls.'),
  'stories.close': same('Close'),
  'stories.shows': same('What it shows', 'The sentence the story\u2019s author wrote above it.'),
  'stories.frameTitle': same('Story {name} of {component}'),
  'stories.catalogue.title': {
    hud: 'Armory',
    professional: 'Components on show',
    define: 'Every component a story renders on its own, from the repos\u2019 story files, grouped the way their authors title them. Each opens drawn live when its Storybook runs.',
  },
  'stories.catalogue.sub': same('Every part of the product that can be seen on its own. The list comes from the code; the pictures come from each repo\u2019s Storybook while it runs.'),
  // `379 of 379 listed stories` on the reference app was 320 stories and 59 docs pages: the
  // number counted both and the words named one (pass swarm 2026-09-25).
  'stories.catalogue.matched': same('{n} of {m} stories and docs pages matched a component',
    'Of every story and docs page the running Storybook lists, how many Farsight placed on a component node \u2014 by the story id the story file gives it, else by the component file the entry names, else by its title. Docs pages are counted here because the index lists them; they are never counted as stories anywhere else.'),
  'stories.catalogue.unresolved': same('{n} matched nothing',
    'Stories the running Storybook lists that Farsight could not place on any component. Named in farsight stories and on MCP, never guessed \u2014 usually a component name or title that differs from the code.'),
  'stories.catalogue.notListed': same('{n} in the code, not listed', 'Stories the story files hold that the running Storybook does not list yet \u2014 it reads new files and globs when it starts.'),
  'stories.catalogue.ungrouped': same('Untitled', 'Stories whose title has no group before its last part.'),

  // surfaces lane — the words the Portfolio, APIs, Tests, Changes, code map,
  // inspector, ⌘K and the chrome needed to give every number its scope and
  // every detail its tip (docs/COUNTS.md §4, pass swarm 2026-09-25). One block,
  // so a lane editing the journey's words never meets these in a merge.
  'surf.unit.journeys': same('{n} journeys', 'Journeys in scope: the flows the design manifest names in the sources the scope filter lets through. Journeys overlap, so their numbers never add up.'),
  'surf.unit.journeysOne': one('1 journey', 'surf.unit.journeys'),
  'surf.allLevels': same('of {n} at every level',
    'The same count with the level filter off: every unit, integration and end-to-end case in the sources selected. Printed beside a filtered number so the two are never mistaken for each other.'),
  'surf.notReached': same('not reached by any test', 'Parts of the code that can carry a test and that no test reaches by any of the three kinds of evidence.'),
  'surf.scope.file': same('in this spec file', 'What the number beside it counts over: the cases one spec file holds, and what its last recorded run said about each.'),
  'surf.e2eSeen': same('{n} of the end-to-end tests seen in a run',
    'Of the end-to-end tests that reach this journey, how many a results report named running over it. The rest are declared or reached — a claim or a static link, not a run.'),
  'surf.e2ePassedDeclared': same('{n} of the end-to-end tests passed, by their own declaration',
    'Of the end-to-end tests that reach this journey, how many a results report says passed while declaring (@covers) something on it. Fewer than the source\u2019s passed cases whenever a case declares another journey, something nothing matches, or nothing at all \u2014 the Tests page\u2019s source card splits that total.'),
  'surf.e2ePassedDeclaredOne': one('1 of the end-to-end tests passed, by its own declaration', 'surf.e2ePassedDeclared'),
  'surf.e2eSeenOne': one('1 of the end-to-end tests seen in a run', 'surf.e2eSeen'),
  'tests.col.source': same('Source', 'The indexed codebase the spec file belongs to. The rows are grouped by it, so one source’s specs read together.'),
  // scopes the surfaces' own numbers count over
  'surf.scope.api': same('in this API', 'What the number beside it counts over: one API — the operations its spec declares and the routes the indexed code implements, in the sources the scope filter lets through.'),
  'surf.scope.operation': same('for this operation', 'What the number beside it counts over: one operation of one API.'),
  'surf.scope.spine': same('in this repository’s sync history', 'What the number beside it counts over: every sync of this graph recorded for the repository picked above.'),
  'surf.scope.sync': same('in this sync', 'What the number beside it counts over: the commits one sync swept in since the sync before it.'),
  'surf.scope.range': same('between the two syncs compared', 'What the number beside it counts over: the range this page compares — from the older sync to the newer one.'),
  'surf.scope.group': same('in this group', 'What the number beside it counts over: the things one group card stands for on the code map — one folder, one file, or the parts one component embeds.'),
  'surf.scope.storyGroup': same('in this group of the catalogue', 'What the number beside it counts over: the components whose stories share this title group.'),
  // units the surfaces print that had no words of their own
  'surf.changes.reindexRun': same('{n} more syncs ({a}–{b}) re-indexed the same commit on a newer build',
    'Syncs that read no new commit: the same code, read again by a newer build of Farsight. Folded into one line so the syncs that swept something in are not buried; opening it lists them.'),
  'surf.changes.kindCount': same('{n} changes of kind {kind}', 'Measured changes of one kind between the two syncs compared, from the frozen difference document. The kinds overlap with nothing and add up to the list below.'),
  'surf.members': same('{n} members', 'The things one group card stands for: every function, component or part it folds, each counted once. Opening the group draws each as a card of its own.'),
  'surf.membersOne': one('1 member', 'surf.members'),
  'surf.gatesRules': same('{n} gates & rules', 'The gates that guard this part and the validation rules its data must match, each counted once.'),
  'surf.tagCount': same('{n} parts tagged {tag}', 'Things in the graph that carry this tag, in the sources the scope filter lets through. Choosing the chip fades everything else on the map. Tests are tagged as parts, so the test tag counts the coverage reports beside the cases; the Tests page counts cases only.'),
  'surf.stories.components': same('{n} components', 'Components with stories of their own in this group of the catalogue, each counted once.'),
  'surf.theme.preview': same('previewing in this window — Save settings keeps it for everyone',
    'A theme chosen here shows at once, for this window only. It is written to the workspace’s shared settings only when you save.'),
  // the top bar
  'surf.chrome.register': same('The words, not the facts', 'Switches the product’s words between the HUD’s game vocabulary and plain professional terms. Every number and every fact stays the same; print and export always use professional terms.'),
  'surf.chrome.settings': same('Settings', 'The sources this workspace reads, their groups, the theme, where each register lands, and the experiments. A theme chosen there is previewed at once; nothing is written until Save settings.'),
  // the impact drawer
  'surf.scope.hop': same('at this distance from the part asked about', 'What the number beside it counts over: the things that depend on the part asked about through exactly this many links.'),
  'surf.scope.hop1': same('among what uses it directly', 'What the number beside it counts over: the tests that reach the things using this part directly.'),
  'surf.scope.hopsSoFar': same('among everything listed up to this distance', 'What the number beside it counts over: the tests that reach anything listed from the first distance up to this one — a union, each test once, never a sum of the lines above.'),
  'surf.impact.found': same('{n} found at this distance', 'Things that depend on the part asked about through exactly this many links, each counted once — the list may show fewer when it is capped.'),
  'surf.impact.tests': same('{n} tests', 'Distinct tests that reach what is listed, split by level. The same set the command line and the agent tool print.'),
  'surf.impact.facts': same('The numbers in this sentence', 'Each number the sentence carries, named with what it counts.'),
  'surf.impact.direct': same('{n} things that use it directly', 'Parts of the product that use the one asked about with nothing in between.'),
  'surf.impact.journeys': same('{n} journeys it shows up in', 'Journeys whose screens reach something that uses the part asked about directly.'),
  'surf.impact.testsNear': same('{n} tests on what uses it directly', 'Tests that reach the things using this part with nothing in between.'),
  'surf.impact.testsFar': same('{n} tests only one link further out', 'Tests that reach only the things further out — they would catch a change here only indirectly.'),
  // the code map and the inspector
  'surf.group.expand': same('Open the group', 'Draw every member of this group as a card of its own, inside the group.'),
  'surf.group.collapse': same('Close the group', 'Fold the group’s members back into one card.'),
  'surf.insp.summary': same('Business summary', 'What this part does, in the words its author wrote for a reader who does not read code.'),
  'surf.insp.docs': same('Docs', 'The comment written above this part in the code, as its author wrote it.'),
  'surf.insp.gates': same('Rules & gates', 'The checks that guard this part and the shapes its data must match.'),
  'surf.insp.data': same('Data access', 'The records this part reads or writes.'),
  'surf.insp.dataCount': same('{n} reads and writes', 'Reads and writes between this part and a record, each counted once per record and direction.'),
  'surf.insp.tags': same('Tags', 'The labels the code or its configuration attach to this part.'),
  'surf.insp.connections': same('Connections', 'Everything this part uses or is used by, other than its gates, rules and records.'),
  'surf.insp.connCount': same('{n} connections', 'Links between this part and another, each counted once per other part and kind — what it uses, and what uses it.'),
  'surf.insp.impactBtn': same('Impact', 'Open what depends on this part — the answer to what else a change here reaches.'),
  'surf.insp.impact': same('What does changing this affect?', 'Opens the panel that lists what uses this part, by distance, with the tests that reach it.'),
  'surf.rel.uses': same('uses', 'This part uses the one named: it calls it, renders it or imports it.'),
  'surf.rel.usedBy': same('used by', 'The part named uses this one.'),
  'surf.rel.reads': same('reads', 'This part reads the record named.'),
  'surf.rel.readBy': same('read by', 'The part named reads this record.'),
  'surf.rel.writes': same('writes', 'This part writes the record named.'),
  'surf.rel.writtenBy': same('written by', 'The part named writes this record.'),
  'surf.rel.guards': same('protects', 'This gate is checked before the part named runs: it guards it, and it is drawn as a badge on that card rather than as a card of its own.'),
  // a node's kind in the business lens — what the thing is for a person
  'surf.kind.page': same('screen', 'A page a person opens: what they see at one address.'),
  'surf.kind.component': same('screen part', 'A piece of a screen: a card, a form, a list — drawn inside one or more screens.'),
  'surf.kind.route': same('request', 'A request the product answers: what happens when a screen asks the system for something.'),
  'surf.kind.api': same('API', 'A set of requests one system offers to others, written down as a contract.'),
  'surf.kind.function': same('logic', 'A piece of the product’s logic: something the code does on the way to an answer.'),
  'surf.kind.rule': same('validation rule', 'A shape the data has to match before it is accepted.'),
  'surf.kind.guard': same('gate', 'A checkpoint about who may go on: signed in, owns the thing, within the limit.'),
  'surf.kind.table': same('record', 'Data the product keeps: a table in its database.'),
  'surf.kind.queue': same('message', 'A message the product sends for later work, so a screen need not wait for it.'),
  'surf.kind.external': same('outside system', 'A system beyond this product that it talks to — an ERP, a document reader.'),
  'surf.kind.flow': same('journey', 'A journey a person takes through the product, as its design names it.'),
  'surf.kind.test': same('test', 'A test case: something that checks the product does what it should.'),
  'surf.kind.group': same('group', 'Several parts drawn as one card: a folder, a file, or the pieces one component embeds.'),
  'surf.kind.unknown': same('unresolved', 'Something the code refers to that the graph could not follow to any indexed source.'),

  // ── work items in the graph (core/work-graph.ts, docs/proposals/work-items-sync.md §9) ──
  // The state words, item counts and state parts are @farsight/work's (work.state.*,
  // count.unit.workItems, count.part.work*); these are the graph side's: how a link is
  // known, what a commit changed, and where the tracker and the code disagree.
  'surf.kind.work': same('work item', 'A piece of planned work from a tracker such as Jira or Azure DevOps: a story, a task, a bug.'),
  'work.via.declared': same('declared', 'Somebody wrote the link down: a work entry on a flow or screen in the design manifest, or a work tag in a comment in the code.'),
  'work.via.commit': same('named in a commit', 'A commit message names this work item, and the commit changed this part of the system.'),
  'work.via.branch': same('on its branch', 'The commit that changed this part sits on a branch whose name carries this work item.'),
  'work.via.url': same('by its link', 'A commit message carries the tracker link to this work item, and the commit changed this part of the system.'),
  'work.commitVia.subject': same('named in a commit', 'The commit message names the work item.'),
  'work.commitVia.branch': same('on its branch', 'A branch whose name carries the work item reaches this commit.'),
  'work.commitVia.mergeSubject': same('merged from its branch', 'A merge commit whose message names a branch that carries the work item.'),
  'work.commitVia.url': same('by its link', 'The commit message carries the tracker link to the work item.'),
  'work.count.type.epic': same('{n} epics', 'Work items the tracker treats as the largest kind: a body of work that holds others.'),
  'work.count.type.epicOne': one('1 epic', 'work.count.type.epic'),
  'work.count.type.feature': same('{n} features', 'Work items the tracker treats as a feature: a capability that holds stories.'),
  'work.count.type.featureOne': one('1 feature', 'work.count.type.feature'),
  'work.count.type.story': same('{n} stories', 'Work items the tracker treats as a story: something a person will be able to do.'),
  'work.count.type.storyOne': one('1 story', 'work.count.type.story'),
  'work.count.type.task': same('{n} tasks', 'Work items the tracker treats as a task: a piece of work with no story of its own.'),
  'work.count.type.taskOne': one('1 task', 'work.count.type.task'),
  'work.count.type.bug': same('{n} bugs', 'Work items the tracker treats as a bug: something that does not behave as it should.'),
  'work.count.type.bugOne': one('1 bug', 'work.count.type.bug'),
  'work.count.type.other': same('{n} other items', 'Work items of a kind the tracker does not file as an epic, feature, story, task or bug.'),
  'work.count.type.otherOne': one('1 other item', 'work.count.type.other'),
  'work.count.sources': same('{n} tracker sources', 'Trackers this workspace reads work items from, each with its own site or organization and projects.'),
  'work.count.sourcesOne': one('1 tracker source', 'work.count.sources'),
  'work.count.via.declared': same('{n} declared', 'Links somebody wrote down, in the design manifest or in a comment in the code.'),
  'work.count.via.commit': same('{n} named in a commit', 'Links found because a commit message names the work item and the commit changed that part.'),
  'work.count.via.branch': same('{n} on its branch', 'Links found because the commit that changed that part sits on a branch named for the work item.'),
  'work.count.via.url': same('{n} by its link', 'Links found because a commit message carries the tracker link to the work item.'),
  'work.count.commits': same('{n} commits name it', 'Commits in the indexed history that name this work item, by message, branch or tracker link, each counted once.'),
  'work.count.commitsOne': one('1 commit names it', 'work.count.commits'),
  'work.count.touched': same('{n} parts its commits changed',
    'Parts of the system the commits naming this work item changed, each counted once across all of them. Read from the lines each commit changed, credited to the part those lines sit in.'),
  'work.count.touchedOne': one('1 part its commits changed', 'work.count.touched'),
  'work.count.touchedKind': same('{n} changed', 'Parts of this kind the commits changed, each counted once.'),
  'work.finding.doneNotBuilt': same('{key} is done; its screen {screen} is not built',
    'The tracker says this work is finished, and the design manifest names a screen for it that no code builds yet. Both are shown; neither wins.'),
  'work.finding.todoButCommitted': same('{key} is to do; {n} commits name it',
    'The tracker says this work has not started, and commits in the indexed history already name it. Both are shown; neither wins.'),
  'work.finding.todoButCommittedOne': same('{key} is to do; 1 commit names it',
    'The tracker says this work has not started, and a commit in the indexed history already names it. Both are shown; neither wins.'),
  'work.cache.unavailable': sys('work cache unavailable'),
  'work.history.notIndexed': same('history not indexed',
    'The sync could not read this source’s commits, so no work item can be linked to its code through them. The reason is printed beside it.'),

  // ── typed counts (core/counts.ts, docs/COUNTS.md) ───────────────────────
  // Every number the product prints arrives as a `Counted`: the number, the
  // key it is printed with, the scope it counts over and the field it came
  // from. These are the words for the ones that had none, the scopes, and the
  // parts of each breakdown. RULE 5 polices every `count.*` key: a scope or a
  // part may be printed in any lens, so none of them counts in a developer's unit.
  // scopes — what a number counts over (the journey's two are `journey.scopeAll` / `journey.scopeHere`)
  'count.scope.action': same('in this action',
    'What the number beside it counts over: one action of one screen — the call a person makes and everything it caused. An action reached again later is counted again there.'),
  'count.scope.node': same('for this part alone',
    'What the number beside it counts over: this one part of the code, not the journey or the screen it sits in.'),
  'count.scope.source': same('in this source',
    'What the number beside it counts over: everything one source holds, whether or not it reaches any journey — for tests, at one test level. A journey’s own number counts only the cases that reach it, so it is smaller.'),
  'count.scope.selection': same('in the sources and level selected',
    'What the number beside it counts over: the sources the scope filter selects, at the test level the page is filtered to. Change either filter and every number on the page follows.'),
  'count.scope.workspace': same('across every source in scope',
    'What the number beside it counts over: every source this workspace indexes that the scope filter lets through.'),
  'count.scope.component': same('this component’s own',
    'What the number beside it counts over: the stories and pages that render this component itself — not the parts it renders, which are counted apart.'),
  'count.scope.parts': same('on the parts it renders',
    'What the number beside it counts over: the parts this screen or component renders, up to two levels down, that have stories of their own. Their stories are theirs, not this one’s.'),
  'count.scope.storybook': same('in this Storybook',
    'What the number beside it counts over: every entry one running Storybook lists in its index right now \u2014 its stories and its docs pages.'),
  'count.scope.project': same('in this project',
    'What the number beside it counts over: one project of the workspace (an NX project, a workspace package, or a whole source when it declares none) — the code under its folder, and the projects it depends on through what that code imports or what the project declares.'),
  // units — the words for numbers that had none
  'count.unit.notInWords': same('{n} conditions not in plain language',
    'Places this journey’s code decides something that nobody put in plain language, counted once each: the technical conditions that are never drawn as a decision, plus the conditions on a gate nobody labelled, which the hybrid and code lenses draw as decisions. The same number in every register — the business register says it as conditions in the code that were not written in plain language.'),
  'count.unit.notInWordsOne': one('1 condition not in plain language', 'count.unit.notInWords'),
  'count.unit.inWords': same('{n} lines in words',
    'What the business lane draws in its In words view: one line for each screen (the sentence written for it, or its name where nobody wrote one) and one for each decision somebody described in words. The count is the lines drawn, so the tab never reads 0 above words.'),
  'count.unit.inWordsOne': one('1 line in words', 'count.unit.inWords'),
  'count.unit.actionStops': same('{n} stops',
    'Every time the journey does something, in the order the walk met it: each call the code makes (a second visit is a second stop), each call only the contract or the design declares, and each screen with nothing to call. The rail the drill walks has one stop per item. The header’s actions count each thing a person can do once, so they are fewer.'),
  'count.unit.actionStopsOne': one('1 stop', 'count.unit.actionStops'),
  'count.unit.cases': same('{n} test cases',
    'Distinct test cases, every level together — unit, integration and end to end. A coverage report is not a case and is never counted here.'),
  'count.unit.casesOne': one('1 test case', 'count.unit.cases'),
  'count.unit.specFiles': same('{n} spec files', 'Files a test runner reads cases from, counted once each.'),
  'count.unit.specFilesOne': one('1 spec file', 'count.unit.specFiles'),
  'count.unit.sources': same('{n} sources', 'Indexed codebases, each counted once.'),
  'count.unit.sourcesOne': one('1 source', 'count.unit.sources'),
  'count.unit.runReports': same('{n} coverage reports',
    'Coverage reports that saw this code run. A report says a run reached the code and does not say which test did, so it is never counted as a case.'),
  'count.unit.runReportsOne': one('1 coverage report', 'count.unit.runReports'),
  'count.unit.reached': same('{n} of {m} reached by tests',
    'Parts of the code that can carry a test, and how many of them any test reaches by any of the three kinds of evidence. A floor where no run proves the rest.'),
  'count.unit.docsPages': same('{n} docs pages',
    'Pages the running Storybook writes for a component from its stories and props. Listed beside the stories as tabs, and never counted as a story.'),
  'count.unit.docsPagesOne': one('1 docs page', 'count.unit.docsPages'),
  'count.unit.indexEntries': same('{n} of {m} stories and docs pages matched a component',
    'Entries of a running Storybook\u2019s index Farsight placed on a component, of every entry it lists. A docs page is an entry and not a story: the breakdown says how many of each.'),
  'count.unit.partStories': same('{n} stories on its parts',
    'Stories of the parts this screen or component renders, added up. They render those parts, not this one — the parts’ own chips open them.'),
  'count.unit.partStoriesOne': one('1 story on its parts', 'count.unit.partStories'),
  'count.unit.projects': same('{n} projects',
    'Projects the workspace declares, each counted once: an NX project (its own project settings file, or a package manifest with an NX entry), a package the workspace lists, or the whole source when it declares none.'),
  'count.unit.projectsOne': one('1 project', 'count.unit.projects'),
  'count.unit.parts': same('{n} parts of the code',
    'Parts of the code the graph holds for this project, each counted once: its screens, components, logic, records, endpoints, checks and tests, read from the files under the project’s folder.'),
  'count.unit.partsOne': one('1 part of the code', 'count.unit.parts'),
  'count.unit.projectDeps': same('{n} project dependencies',
    'Pairs of projects where one depends on the other, each pair once: the first project’s files import the second’s, the first declares the second as a dependency in its project settings, or NX’s own project graph file records it.'),
  'count.unit.projectDepsOne': one('1 project dependency', 'count.unit.projectDeps'),
  'count.unit.importStatements': same('{n} import statements',
    'Import lines in this project’s files that name a file of the other project, counted once each, read from the source at ingest.'),
  'count.unit.importStatementsOne': one('1 import statement', 'count.unit.importStatements'),
  'count.unit.projectsDependedOn': same('{n} projects it depends on',
    'Projects this one depends on, directly or through another project, each counted once. The project itself is not among them.'),
  'count.unit.projectsDependedOnOne': one('1 project it depends on', 'count.unit.projectsDependedOn'),
  // parts — the pieces a breakdown splits a number into (always summing to it)
  'count.part.ofKind': same('{n} of this kind', 'Parts of the code of the kind named beside the number, each counted once.'),
  'count.part.projectsApp': same('{n} applications', 'Projects the workspace declares as applications: something a person runs or opens.'),
  'count.part.projectsAppOne': one('1 application', 'count.part.projectsApp'),
  'count.part.projectsLib': same('{n} libraries', 'Projects the workspace declares as libraries: code other projects use.'),
  'count.part.projectsLibOne': one('1 library', 'count.part.projectsLib'),
  'count.part.projectsE2e': same('{n} end-to-end test projects', 'Projects that test another project end to end, named so by their project name or their tags.'),
  'count.part.projectsE2eOne': one('1 end-to-end test project', 'count.part.projectsE2e'),
  'count.part.projectsUntyped': same('{n} without a project type', 'Projects whose settings name no project type and whose folder does not say one either.'),
  'count.part.projectsUntypedOne': one('1 without a project type', 'count.part.projectsUntyped'),
  'count.part.depsImported': same('{n} read from imports', 'Project dependencies the code shows: a file of one project imports a file of the other.'),
  'count.part.depsImportedOne': one('1 read from imports', 'count.part.depsImported'),
  'count.part.depsDeclared': same('{n} only declared', 'Project dependencies a project’s settings declare that no import in its files shows.'),
  'count.part.depsDeclaredOne': one('1 only declared', 'count.part.depsDeclared'),
  'count.part.depsNxGraph': same('{n} only in NX’s project graph', 'Project dependencies that NX’s own project graph file records and that neither an import in the files nor a project’s settings show. Farsight reads that file; it never runs NX to make one.'),
  'count.part.depsNxGraphOne': one('1 only in NX’s project graph', 'count.part.depsNxGraph'),
  'count.part.withTag': same('{n} tagged so', 'Projects carrying the tag value named beside the number in this dimension.'),
  'count.part.noTag': same('{n} with no tag here', 'Projects that carry no tag in this dimension.'),
  'count.part.noTagOne': one('1 with no tag here', 'count.part.noTag'),
  'count.part.storesOfRecords': same('{n} holding records', 'Data stores that this journey’s records live in: a database the code or the project settings name.'),
  'count.part.storesOfRecordsOne': one('1 holding records', 'count.part.storesOfRecords'),
  'count.part.storesOutside': same('{n} outside systems', 'Outside systems this journey uses as a data store, reading from them or writing to them the way it does its own records: an ERP, a file store.'),
  'count.part.storesOutsideOne': one('1 outside system', 'count.part.storesOutside'),
  'count.part.guards': same('{n} gates', 'Checkpoints about who may go on: signed in, owns the thing, within the rate limit. Counted once each by name.'),
  'count.part.guardsOne': one('1 gate', 'count.part.guards'),
  'count.part.rules': same('{n} validation rules', 'Declared shapes the data has to match before it is accepted. Counted once each by name.'),
  'count.part.rulesOne': one('1 validation rule', 'count.part.rules'),
  'count.part.gateConditions': same('{n} gate conditions nobody labelled',
    'Conditions on a gate that nobody wrote a label for. The hybrid and code lenses draw them as decisions, with the condition as the code writes it; the business lens counts them among what was not put in plain language. One population, in both numbers.'),
  'count.part.gateConditionsOne': one('1 gate condition nobody labelled', 'count.part.gateConditions'),
  'count.part.decisionsInWords': same('{n} decisions written in words',
    'Places the journey can go differently that somebody described in words. The only decisions the business lens draws.'),
  'count.part.decisionsInWordsOne': one('1 decision written in words', 'count.part.decisionsInWords'),
  'count.part.sentences': same('{n} screens described in words', 'Screens whose design or code carries a sentence somebody wrote about them.'),
  'count.part.sentencesOne': one('1 screen described in words', 'count.part.sentences'),
  'count.part.namesOnly': same('{n} screens named only', 'Screens nobody wrote a sentence for: the lane prints their name instead.'),
  'count.part.namesOnlyOne': one('1 screen named only', 'count.part.namesOnly'),
  'count.part.stopsCalled': same('{n} calls the code makes',
    'Calls real code makes, each time it makes them — the header’s actions plus the ones made again on a later screen.'),
  'count.part.stopsCalledOne': one('1 call the code makes', 'count.part.stopsCalled'),
  'count.part.stopsDeclared': same('{n} calls only declared',
    'Calls a screen’s design or the contract names where no code makes them yet — each time the journey reaches one.'),
  'count.part.stopsDeclaredOne': one('1 call only declared', 'count.part.stopsDeclared'),
  'count.part.stopsNoCall': same('{n} screens with nothing to call', 'Screens the journey passes through that make no call at all. The rail still stops there.'),
  'count.part.stopsNoCallOne': one('1 screen with nothing to call', 'count.part.stopsNoCall'),
  'count.part.declared': same('{n} declared only', 'Cases whose author says they cover this, where nothing they import, open or run reaches it.'),
  'count.part.reached': same('{n} reached by tests', 'Cases whose body imports, renders or requests this — static evidence, a floor, not a run.'),
  'count.part.observed': same('{n} seen in a run', 'Cases a results report named running, placed on this code by that run\u2019s coverage. With the passes by declaration beside it, the only evidence of a run.'),
  'count.part.declaredPassed': same('{n} passed, by their own declaration',
    'End-to-end cases a results report says passed, which declare (@covers) this code. Observed evidence earned by the case\u2019s own claim: no coverage measured the lines it ran.'),
  'count.part.declaredPassedOne': one('1 passed, by its own declaration', 'count.part.declaredPassed'),
  'count.unit.passedInReport': same('{n} passed in the report',
    'Cases in this source whose last recorded run passed, read from the results report. How many of them count on a journey depends on what each declares: that split is beside it.'),
  'count.unit.passedInReportOne': one('1 passed in the report', 'count.unit.passedInReport'),
  'count.part.declaresKnown': same('{n} declare something this workspace knows',
    'Passed cases whose @covers names a screen, route or flow the graph holds: each counts as passed, by its own declaration on what it names, and on every journey that holds it.'),
  'count.part.declaresKnownOne': one('1 declares something this workspace knows', 'count.part.declaresKnown'),
  'count.part.declaresUnmatched': same('{n} declare only what nothing here matches',
    'Passed cases whose every @covers value matched nothing in the graph: they are listed as orphans and count on no journey.'),
  'count.part.declaresUnmatchedOne': one('1 declares only what nothing here matches', 'count.part.declaresUnmatched'),
  'count.part.declaresNothing': same('{n} declare nothing',
    'Passed cases with no @covers claim: they count on a journey only where their body reaches something on it, and never as observed.'),
  'count.part.declaresNothingOne': one('1 declares nothing', 'count.part.declaresNothing'),
  'count.part.passed': same('{n} passed', 'Cases whose last recorded run passed.'),
  'count.part.failed': same('{n} failed', 'Cases whose last recorded run failed.'),
  'count.part.skipped': same('{n} skipped', 'Cases the runner did not execute last time. Skipped proves nothing.'),
  'count.part.flaky': same('{n} flaky', 'Cases that failed and then passed on a retry. Never counted as passed.'),
  'count.part.noRun': same('{n} with no run recorded', 'Cases no results report has named: they exist and nothing says they ran.'),
  // the business lens's own words for counts that had none there (RULE 5 applies)
  'journey.biz.countScreens': same('{n} screens', 'How many screens this journey names, in order. A screen met twice is one screen. The split says how many of them were reached when the journey was traced through the code.'),
  'journey.biz.countScreensOne': one('1 screen', 'journey.biz.countScreens'),
  'journey.biz.countBuilt': same('{n} of {m} built',
    'How many of the screens this journey’s design names exist in code, of how many it names. The same number, in the same form, as the other registers print.'),
  'journey.biz.countActions': same('{n} things the user can do',
    'Distinct things a person can do across this journey, each counted once: one thing per call to the system, however many screens make it. The same number as the other registers’ actions.'),
  'journey.biz.countActionsOne': one('1 thing the user can do', 'journey.biz.countActions'),
  'journey.biz.countTests': same('{n} tests', 'Distinct tests that check this, every kind together.'),
  'journey.biz.countTestsOne': one('1 test', 'journey.biz.countTests'),
  'journey.biz.countE2e': same('{n} end-to-end tests', 'Tests that drive this the way a person would, through the screens. Counted once each.'),
  'journey.biz.countE2eOne': one('1 end-to-end test', 'journey.biz.countE2e'),
  // journey lane (fix/journey-numbers-and-words, 2026-09-25) — the journey's
  // own words for what the pass swarm of 2026-09-25 found missing: the run
  // behind an evidence word, the related numbers a tip names beside the one it
  // explains, the business lens's words for the drill and the folds, and the
  // way from an open journey back to the top bar.
  'journey.skipToChrome': same('Skip to the top bar',
    'The journey is a panel over the page, not a wall. This link is its first stop: it takes the keyboard to the top bar — the surfaces, search, the register and the lens — which Tab otherwise reaches only by walking backwards out of the journey.'),
  'journey.obs.reports': same('{n} coverage reports, no test named',
    'The run behind the evidence word is known only from coverage reports: each says which code a run reached and none says which test reached it. Counted once each.'),
  'journey.obs.reportsOne': one('1 coverage report, no test named', 'journey.obs.reports'),
  'journey.obs.cases': same('{n} tests named by a run',
    'The run behind the evidence word: test cases a results report named running over this code. The only kind of evidence that names a test.'),
  'journey.obs.casesOne': one('1 test named by a run', 'journey.obs.cases'),
  'journey.obs.none': same('nothing observed',
    'No run of any kind reached this code: the evidence word beside it is a claim or a reading of the test bodies, and no run stands behind it.'),
  'journey.tests.theirRun': same('their own last run',
    'What the covering tests’ own last recorded runs said, case by case. Not the run behind the evidence word: that one is printed in the word’s tip, and the word is the verdict.'),
  'journey.biz.helpersFolded': same('{n} small parts',
    'Parts this one uses that do not change what the journey does — formatting, wiring, look-ups. They are folded under it; open it to see them.'),
  'journey.biz.helpersFoldedOne': one('1 small part', 'journey.biz.helpersFolded'),
  'journey.biz.kind.part': same('part of the system', 'Something the system does on the way. Its name is the words somebody wrote for it.'),
  'journey.biz.kind.onScreen': same('on the screen', 'A part of the screen the person is looking at.'),
  'journey.biz.drill.order': same('in the order they happen',
    'The parts of one action, left to right in the order the system does them: the screen, the request, what the service does, and what comes back.'),
  'journey.biz.drill.answer': same('the answer', 'What the service promises to send back, in the words its contract gives.'),
  'journey.biz.beat.request': same('the request', 'The screen asking the service to do something.'),
  'journey.biz.beat.service': same('the service', 'What the service does when it is asked.'),
  'journey.biz.noWords': same('nobody wrote words for this',
    'The code has this part and nobody described it in plain language. The business lens does not stand a name from the code in for a sentence.'),
  'journey.biz.touches': same('touches {systems}',
    'The systems outside the screens this journey reaches: what it records, what it sends, and who else it calls. Named, not counted.'),
  'journey.forks.count': same('{n} forks',
    'Branch points the walk met, every class together — an access check, a guard, a state test, an error path, a flag, a plain branch — each counted where the walk met it. Not the decisions (the branches somebody named) and not the conditions not in plain language (the ones nobody did).'),
  'journey.forks.countOne': one('1 fork', 'journey.forks.count'),
  'tip.journey.related': same('Beside it',
    'Other numbers about the same things, each with its own name and scope. They are not parts of the number above and do not add up to it.'),
  'tip.journey.screensList': same('The screens, in order', 'Every screen of this journey in the order a person meets it, and whether its design reconciled to code.'),
  'tip.journey.obs.head': same('The run behind the word',
    'What earned the evidence word: which run reached this code, what it said, when, and whether the code has changed since.'),
  'tip.journey.obs.by': same('observed by'),
  'tip.journey.obs.when': same('when'),
  'tip.journey.obs.verdict': same('verdict'),
  'tip.journey.obs.since': same('since then'),
  // ── work items: Azure DevOps (packages/work-azdo) ─────────────────────────
  'work.azdo.says.yes': same('Azure DevOps says: yes',
    'Azure DevOps was asked before the change and answered that this account may make it on this item. The change itself can still be refused; that answer is final.'),
  'work.azdo.says.notOnArea': same('Azure DevOps says: not on this area ({area})',
    'Azure DevOps answered that this account may not change work items in this area of the project. Areas carry their own permissions in Azure DevOps.'),
  'work.azdo.says.noMove': same('Azure DevOps says: {type} items cannot move from {state}',
    'The item type in Azure DevOps lists which states each state can move to. None is listed from the state this item is in.'),
  'work.azdo.says.stateUndefined': same('Azure DevOps says: no change until the state is fixed \u2014 {type} items have no state {state}',
    'The item is in a state its type no longer defines, usually left behind when the process was changed. Azure DevOps refuses every change to it until someone moves it to a state the type has.'),
  'work.azdo.says.cannotCreate': same('this source cannot create items',
    'Creating work items from Farsight is not built for Azure DevOps. Every other change is.'),
  'work.azdo.says.existingTagsOnly': same('Azure DevOps says: yes, with tags that already exist',
    'Azure DevOps lets this account put existing tags on items, but not create new tags. A change that needs a new tag will be refused.'),
  'work.azdo.says.unasked': same('Azure DevOps could not be asked ({why}) \u2014 the change itself will answer',
    'The permission check before a change is a courtesy. When Azure DevOps cannot answer it, the change is still checked by Azure DevOps when it is made.'),
  'work.azdo.cred.canWrite': same('can change work items \u2014 a dry run on {key} was accepted',
    'Checked when the source connects: Azure DevOps was asked to check a change to one item without saving it, and accepted it. Nothing was changed.'),
  'work.azdo.cred.readOnly': same('reads only \u2014 a dry run on {key} was refused',
    'Checked when the source connects: Azure DevOps refused to check a change to one item. The account or its token may read work items but not change them.'),
  'work.azdo.cred.notChecked': same('changes not checked \u2014 the source is read-only',
    'The source is set to read-only, so Farsight did not ask whether the account could change work items.'),
  'work.azdo.cred.unknown': same('changes unknown \u2014 no item could be checked',
    'Farsight could not find an item Azure DevOps would check a change on, so it cannot say whether the account can change work items. Changes are refused until it can.'),
  'work.azdo.conflict': same('changed in Azure DevOps since it was read (version {base}, now {now})',
    'Someone changed the item after Farsight last read it. The change was not made; the item is read again so a person can decide.'),
  'work.azdo.dryRun.comment': same('Azure DevOps cannot check a comment without posting it \u2014 only the version was checked',
    'Azure DevOps offers a check-without-saving for field changes but not for comments. The dry run checked that the item has not changed since it was read.'),
  'work.azdo.state.undefined': same('not a state its type has',
    'The item is in a state its type no longer defines. Azure DevOps refuses every change to it until someone moves it to a state the type has.'),

  // ── work items (packages/work — docs/proposals/work-items-sync.md) ──────────
  // the tracker's own status category, printed beside the tracker's status name
  'work.state.todo': same('to do', 'The tracker files this item as not started yet, by its own status category — not by the name of the status.'),
  'work.state.inProgress': same('in progress', 'The tracker files this item as started and not finished, by its own status category. Azure DevOps puts Resolved here.'),
  'work.state.done': same('done', 'The tracker files this item as finished, by its own status category.'),
  'work.state.undefinedByType': same('not a state its type defines',
    'The tracker shows a status that this item\u2019s type does not list among its own, so the tracker gives no category for it. Farsight files it as to do until the tracker says otherwise; the status name beside it is the tracker\u2019s.'),
  'work.preview.ok': same('dry run: ok', 'The tracker checked this change without saving it and would accept it.'),
  'work.preview.refused': same('dry run: {reason}', 'The tracker checked this change without saving it and would refuse it, for the reason given. Nothing was written.'),
  // what a source declares it can do (capabilities, printed on the source card and by farsight work status)
  'work.cap.comments': same('comments in {format}', 'The format the tracker keeps comment text in; Farsight converts to and from it.'),
  'work.cap.commentsReadOnly': same('comments read only', 'Farsight can read this tracker\u2019s comments and cannot write them.'),
  'work.cap.transitionsGraph': same('status changes from the type\u2019s map', 'The tracker publishes which status can follow which for each type, so a move is checked before it is sent.'),
  'work.cap.transitionsPerItem': same('status changes asked per item', 'The tracker only says which status changes an item allows when asked about that item.'),
  'work.cap.concurrencyRevision': same('conflicts found by revision', 'Every write names the version it was based on; the tracker refuses it when the item has moved on since.'),
  'work.cap.concurrencyUpdated': same('conflicts found by comparing the last update', 'Before a write Farsight re-reads the item\u2019s last-updated time; if it moved since the copy was read, the write is a conflict and is not sent.'),
  'work.cap.deletesVisible': same('deletions seen', 'The tracker\u2019s change feed reports deleted items, so they leave the local copy on the next sync.'),
  'work.cap.deletesReconcile': same('deletions found by a periodic scan', 'The change feed does not report deletions; every few syncs Farsight asks which of its items still exist.'),
  'work.cap.dryRun': same('dry run before a write', 'The tracker can check a write without saving it; Farsight does so before every write and records the answer.'),
  // the three verdicts and the outcome of a write (farsight work comment|assign|move|edit|link)
  'work.verdict.policy': same('your policy', 'Verdict one: the permissions in this source\u2019s settings, checked on this machine before anything is sent.'),
  'work.verdict.tracker': same('the tracker', 'Verdict two: what the tracker itself says this account may do to this item.'),
  'work.verdict.credential': same('the credential', 'Verdict three: what the stored credential is allowed to do at all.'),
  'work.verdict.yes': same('yes'),
  'work.verdict.no': same('no'),
  'work.outcome.confirmed': same('written, and the tracker\u2019s copy read back', 'The tracker accepted the write; the local copy now holds what the tracker says after it.'),
  'work.outcome.denied': same('not written', 'At least one of the three verdicts, or the tracker\u2019s dry run, said no. Nothing was sent to change the item.'),
  'work.outcome.pending': same('waiting for a person to confirm: run it again with --confirm', 'The policy asks a person to approve this write before it is sent. It is kept in the outbox until then.'),
  'work.outcome.conflict': same('not written: the item changed on the tracker since it was read — the local copy is refreshed; look, then try again',
    'The tracker holds a newer version than the one the write was based on. Nothing was written over it.'),
  'work.outcome.failed': same('not written: {reason}', 'The tracker refused the write, or it could not be sent.'),
  'work.status.lastSync': same('last sync {n}', 'The number of the last sync of this source that worked; syncs are numbered across every work source.'),
  'sys.work.usage.write': sys('usage: farsight work comment <key> <text> | assign <key> <person|none> | move <key> <todo|in-progress|done|removed> [--name <status>] | edit <key> <field>=<value>... | link <key> <kind> <other-key> [--source id] [--confirm]'),
  'work.state.removed': same('removed', 'The tracker keeps this item but files it as cut from the work.'),
  // when the local copy last agreed with the tracker — never a bare timestamp
  'work.fresh.synced': same('synced {ago}',
    'When the local copy last agreed with the tracker. Everything shown for this source is what the tracker said then.'),
  'work.fresh.unreachable': same('source unreachable since {since} — showing the cache',
    'The last attempts to reach the tracker failed. What is shown is the local copy from the last sync that worked.'),
  'work.fresh.credential': same('credential expired — showing the cache',
    'The tracker refused the stored credential, or it could not be read from the keychain. What is shown is the local copy from the last sync that worked.'),
  'work.fresh.never': same('never synced', 'This source is configured and nothing has been copied from its tracker yet.'),
  'work.ago.now': same('just now'),
  'work.ago.minutes': same('{n} minutes ago'),
  'work.ago.minutesOne': same('1 minute ago'),
  'work.ago.hours': same('{n} hours ago'),
  'work.ago.hoursOne': same('1 hour ago'),
  'work.ago.days': same('{n} days ago'),
  'work.ago.daysOne': same('1 day ago'),
  'work.mode.readOnly': same('read-only', 'Farsight reads this tracker and never writes to it.'),
  'work.mode.edit': same('edit', 'Farsight may write to this tracker, and only the actions the source’s permissions grant, each checked by the tracker too.'),
  'work.label.assignee': same('assigned to'),
  'work.label.unassigned': same('nobody assigned'),
  'work.label.parent': same('part of'),
  'work.label.reporter': same('reported by'),
  'work.label.updated': same('updated'),
  'work.label.labels': same('labels'),
  'work.label.area': same('area'),
  'work.label.iteration': same('iteration'),
  'work.label.estimate': same('estimate'),
  'work.label.comments': same('comments'),
  'work.label.history': same('history'),
  'work.label.links': same('linked items'),
  'work.none': same('no work items match', 'The local copy holds no item that fits what was asked. Sync first if the source has never been read.'),
  'work.noLinks': same('nothing in the graph is joined to this item yet', 'No screen, flow, commit or code in the graph names this item.'),
  'sys.work.noSources': sys('no work source is configured: add a source with type work to .farsight/settings.json'),
  'sys.work.unknownSource': sys('no work source {source} in .farsight/settings.json'),
  'sys.work.unknownProvider': sys('no provider {provider} is registered for work source {source}'),
  'sys.work.notFound': sys('no work item {key} in the local copy: run farsight work sync first'),
  'sys.work.ambiguous': sys('{key} is in more than one work source: pass --source'),
  'sys.work.syncFailed': sys('sync of {source} failed: {error}'),
  // counts (docs/COUNTS.md § Work items)
  'count.scope.workSource': same('in this work source',
    'What the number beside it counts over: the items one tracker source holds, as of its last sync.'),
  'count.scope.workSources': same('across the work sources listed',
    'What the number beside it counts over: every tracker source the command read, each item counted once.'),
  'count.scope.workSync': same('in this sync', 'What the number beside it counts over: one sync of one tracker source.'),
  'count.scope.workItem': same('on this item', 'What the number beside it counts over: one work item, as the last sync copied it.'),
  'count.unit.workItems': same('{n} work items',
    'Items in a tracker — epics, features, stories, tasks, bugs — as the last sync copied them. Each counted once; items the tracker deleted are not.'),
  'count.unit.workItemsOne': one('1 work item', 'count.unit.workItems'),
  'count.unit.workPulled': same('{n} items the tracker sent',
    'Items this sync received from the tracker, each counted once, whether anything in it changed or not.'),
  'count.unit.workPulledOne': one('1 item the tracker sent', 'count.unit.workPulled'),
  'count.unit.workChanged': same('{n} items changed',
    'Items whose copy now differs from the one kept before this sync, new items included.'),
  'count.unit.workChangedOne': one('1 item changed', 'count.unit.workChanged'),
  'count.unit.workGone': same('{n} items gone from the tracker',
    'Items the tracker said were deleted. The local copy keeps their history and no longer lists them.'),
  'count.unit.workGoneOne': one('1 item gone from the tracker', 'count.unit.workGone'),
  'count.unit.workComments': same('{n} comments', 'Comments on the item, as the last sync copied them.'),
  'count.unit.workCommentsOne': one('1 comment', 'count.unit.workComments'),
  'count.unit.workChanges': same('{n} field changes', 'Changes to the item’s fields that the tracker recorded, oldest first.'),
  'count.unit.workChangesOne': one('1 field change', 'count.unit.workChanges'),
  'count.unit.workLinks': same('{n} links to the graph',
    'Places in the graph this item is joined to — a flow, a screen, a commit, code — each with how the link was found.'),
  'count.unit.workLinksOne': one('1 link to the graph', 'count.unit.workLinks'),
  'count.unit.workQueued': same('{n} writes waiting for a person', 'Writes asked for and kept in the outbox until a person confirms them. None of them has reached the tracker.'),
  'count.unit.workQueuedOne': one('1 write waiting for a person', 'count.unit.workQueued'),
  'count.unit.workConflicts': same('{n} writes in conflict', 'Writes not sent because the item had changed on the tracker since it was read. They wait for a person to look again.'),
  'count.unit.workConflictsOne': one('1 write in conflict', 'count.unit.workConflicts'),
  'count.part.workTodo': same('{n} to do', 'Items the tracker files as not started, by its own status category.'),
  'count.part.workInProgress': same('{n} in progress', 'Items the tracker files as started and not finished, by its own status category.'),
  'count.part.workDone': same('{n} done', 'Items the tracker files as finished, by its own status category.'),
  'count.part.workRemoved': same('{n} removed', 'Items the tracker keeps but files as cut from the work.'),
  // ── freshness: *stale* said once and only when true (swarm-fixes 2026-10-05, finding 2; core freshness.ts) ──
  // A comparison, so every word below is printed with the sentence that names both sides.
  'fresh.state.current': same('current', 'A comparison that came out equal: a run recorded a digest of the code it ran on, and that digest is still the code’s. Said with the sync it holds for.'),
  'fresh.state.stale': same('stale', 'A comparison, never a mood: every run that observed this recorded a digest of the code, and the code has changed since. Always printed with its sentence — the commit the run saw and the commit the code is at now.'),
  'fresh.state.noDigest': same('no source digest', 'The run recorded no digest of the code it ran on, so it cannot be compared with the code now. Not stale and not current: no answer. Stamping the report right after the run makes it comparable.'),
  'fresh.state.none': same('no run recorded', 'No results report named a run of these tests, so there is nothing to compare with the code.'),
  'fresh.sentence.current': same('current as of sync {sync} — the tests ran on the code as it is now', 'A run recorded a digest of the code it ran on, and the code this sync read has the same digest.'),
  'fresh.sentence.currentNoSync': same('current — the tests ran on the code as it is now', 'A run recorded a digest of the code it ran on, and the code read now has the same digest.'),
  'fresh.sentence.staleCommit': same('stale — the tests ran on commit {ran} ({ranAt}); the code is at commit {code} now', 'Both sides of the comparison: the commit the run’s report was stamped with, and the commit the code was read at. The commits between them are on the Changes page.'),
  'fresh.sentence.staleCode': same('stale — the tests ran on {ranAt}, before the code at commit {code}; the run recorded no commit of its own', 'The run’s digest differs from the code’s, and the report named no commit, so only its date can stand for its side.'),
  'fresh.sentence.staleBare': same('stale — the tests ran on {ranAt}, and the code has changed since', 'The run’s digest differs from the code’s. Neither side named a commit this graph can print.'),
  'fresh.sentence.staleTree': same('stale — the tests ran on {ranAt} on the commit the code is still at, and the working tree changed after the run', 'Same commit, different files: uncommitted edits made after the run. No commit list shows them, so the Changes page shows the same commit.'),
  'fresh.sentence.noDigest': same('no source digest was recorded — the tests ran on {ranAt}, and whether the code changed since cannot be told', 'The report carries no digest of the code it ran on. A file’s timestamp is not evidence, so this is neither stale nor current.'),
  'fresh.sentence.noDigestSome': same('no source digest was recorded for {noDigest} of these runs (the newest {ranAt}); the other {stale} ran before the code last changed', 'Some runs carry no digest, so the scope as a whole cannot be called stale or current; the runs that do carry one are older than the code.'),
  'fresh.sentence.none': same('no run of these tests is recorded', 'No results report named a run of these tests.'),
  'fresh.recipe.rerun': same('to make it current: run these tests again on this commit, then sync', 'A run on the code as it is, stamped, and read by the next sync, compares equal — and the word becomes current.'),
  'fresh.recipe.stamp': same('to make it comparable: stamp the report right after the run (farsight tests import --results <report> --stamp)', 'The stamp writes the code’s digest and commit into the report. Never stamp an old run with today’s digest — that would be false evidence.'),
  'fresh.tip.against': same('against what', 'The two sides of the comparison: the run, and the code it is compared with.'),
  'fresh.risk.against': same('against the code at commit {code} (sync {sync}) — every one of these runs is from {ranAt} or before', 'What every stale journey on the board is compared with: one commit of the code, and the newest of the runs that observed them. Each journey’s own mark names its own run.'),
  'fresh.tip.ran': same('the run', 'The run’s side: the commit its report was stamped with, and the day it ran.'),
  'fresh.tip.code': same('the code', 'The code’s side: the commit the code was read at.'),
  'fresh.tip.sync': same('read by sync', 'The sync that read the code this is compared with.'),
  'fresh.tip.recipe': same('what changes it', 'What would make this answer current, when something would.'),
  'fresh.tip.runs': same('runs read', 'The runs this answer is computed over, split by what their reports recorded.'),
  'journey.biz.fresh.current': same('Up to date: the tests last ran on the software as it is now.', 'The record of the last test run matches the software as it is today.'),
  'journey.biz.fresh.stale': same('Out of date: the tests last ran on {ranAt}, and the software has changed since.', 'The tests are older than the software they checked. Running them again brings this up to date.'),
  'journey.biz.fresh.staleTree': same('Out of date: the tests last ran on {ranAt}, and files were edited afterwards without being saved as a new version.', 'Edits made after the test run that nobody has saved as a version yet.'),
  'journey.biz.fresh.noDigest': same('Unknown: the tests last ran on {ranAt}, but that run did not record which version of the software it checked.', 'Without that record nobody can say whether the run still applies.'),
  'journey.biz.fresh.riskAgainst': same('The tests behind these journeys last ran on {ranAt} or before; the software has changed since.', 'Every journey counted here was last tested before the software’s current version.'),
  'journey.biz.fresh.none': same('No recorded run of these tests.', 'Nothing says these tests have been run.'),
  'count.part.freshCurrent': same('{n} current', 'Runs whose recorded digest is still the code’s.'),
  'count.part.freshStale': same('{n} older than the code', 'Runs whose recorded digest differs from the code’s.'),
  'count.part.freshNoDigest': same('{n} with no source digest', 'Runs whose report recorded no digest, so they cannot be compared.'),
  // ── one test verdict per cell (swarm 2026-10-05, finding 1) ─────────────
  // The cell's verdict is the evidence word (core `testVerdict`); the cases'
  // own runs are a count beside it whose tip says what each run said.
  'journey.tests.theirRuns': same('their own last runs',
    'Every test case counted here, by what its own last recorded run said: passed, failed, skipped, flaky, or no run recorded. The parts add up to the cases. It is a count, not a verdict: the verdict of this cell is the evidence word above it, and the run behind that word is in the word’s tip.'),
  'tests.scoped.head': same('Cases that reach {scope}',
    'The test cases behind one cell of a journey — the journey, one of its screens, one action, or one part — each with its own evidence and its own last run. The word at the top is the same word the cell prints.'),
  'tests.scoped.all': same('every journey', 'Drops this scope and lists every journey’s tests again.'),
  'tests.scoped.journey': same('open the journey', 'Back to the journey this scope belongs to.'),
};

/**
 * Resolve a catalog string. `sys.*` and `invariant` entries return the same
 * words in either register; unknown keys return the key itself (fail-soft,
 * and the lint catches it at build time).
 */
export function t(key: string, register: Register): string {
  const e = STRINGS[key];
  if (!e) return key;
  if (e.invariant) return e.professional;
  return register === 'hud' ? e.hud : e.professional;
}

/** First-use tooltip for a term, or undefined when the entry defines none. */
export function define(key: string): string | undefined {
  return STRINGS[key]?.define;
}

// Construction-time: a singular carries its plural's define, word for word.
for (const [key, entry] of Object.entries(STRINGS)) {
  if (!entry.singularOf) continue;
  const plural = STRINGS[entry.singularOf];
  if (!plural?.define) throw new Error(`strings: ${key} is the singular of ${entry.singularOf}, which has no define`);
  entry.define = plural.define;
}

// Construction-time guard: sys.* must be invariant with identical words —
// error/permission text never varies by register.
for (const [key, entry] of Object.entries(STRINGS)) {
  if (key.startsWith('sys.') && (!entry.invariant || entry.hud !== entry.professional)) {
    throw new Error(`strings: ${key} must be invariant with identical registers`);
  }
  if (entry.invariant && entry.hud !== entry.professional) {
    throw new Error(`strings: ${key} is marked invariant but registers differ`);
  }
}
