// sym.js — accessors over the inline SVG symbol sprite in viewer.html.
// One drawing per meaning; business symbols and status glyphs always render
// glyph + word; no emoji anywhere in the chrome (🔒 ⑂ ⧉ etc. are drawn).
// The /grammar page renders these tables directly — a glyph that isn't here
// cannot render, because there is no other source for it.

import { esc } from './store.js';
import { t, def } from './strings.js';

/**
 * The 12 business symbols (design-concepts §3 / Grammar Book v1.1).
 * `glyph` is the sprite id; HOTSPOT deliberately reuses the WARNING triangle —
 * one glyph, one meaning (attention), the mandatory word carries the specifics.
 * @group Grammar
 */
export const SYMBOLS = [
  { id: 'start',       glyph: 'start',       word: 'sym.start',       form: 'thin-ring circle + trigger phrase',      mapping: 'entry point — route, scheduled job, listener' },
  { id: 'step',        glyph: 'step',        word: 'sym.step',        form: 'rounded rectangle, verb-object label',   mapping: 'function / unit of work' },
  { id: 'decision',    glyph: 'decision',    word: 'sym.decision',    form: 'diamond, plain-English arm labels',      mapping: 'branch / fork, paired with rejoin' },
  { id: 'gate',        glyph: 'gate',        word: 'sym.gate',        form: 'padlock in rounded square — amber, always', mapping: 'guard / permission check' },
  { id: 'record',      glyph: 'record',      word: 'sym.record',      form: 'cylinder, SAVES TO / LOOKS UP',          mapping: 'database write / read' },
  { id: 'message',     glyph: 'message',     word: 'sym.message',     form: 'envelope leaving on dashed edge',        mapping: 'event, queue, email' },
  { id: 'external',    glyph: 'external',    word: 'sym.external',    form: 'dashed border, cloud-corner badge',      mapping: 'third-party API' },
  { id: 'screen',      glyph: 'screen',      word: 'sym.screen',      form: 'browser-frame silhouette',               mapping: 'page / component the user sees' },
  { id: 'human',       glyph: 'human',       word: 'sym.human',       form: 'person pictogram',                       mapping: 'manual action / approval' },
  { id: 'automation',  glyph: 'automation',  word: 'sym.automation',  form: 'clock with recurrence arrow',            mapping: 'scheduled / recurring trigger' },
  { id: 'interchange', glyph: 'interchange', word: 'sym.interchange', form: 'double-ring station circle',             mapping: 'node on ≥2 journeys' },
  { id: 'hotspot',     glyph: 'warning',     word: 'sym.hotspot',     form: 'warning triangle + word (UNDOCUMENTED / STALE)', mapping: 'low confidence, undocumented decision, stale' },
];

/**
 * Status glyphs — always glyph + word, never color alone. ⏚ SYNC FAILING is
 * its own glyph (the hexagon means VIOLATION only); an incomplete decision
 * arm gets the barred ring, distinct from both.
 * @group Grammar
 */
export const STATUS = [
  { id: 'live', glyph: 'live',       word: 'status.live',        note: 'the last sync is recent' },
  { id: 'stale', glyph: 'stale',      word: 'status.stale',       note: 'always clock + word — data valid, aging; never red, never dressed as fresh' },
  { id: 'syncfail', glyph: 'syncfail',   word: 'status.syncFailing', note: 'the pipeline is broken; the view keeps the last good snapshot' },
  { id: 'violation', glyph: 'violation',  word: 'status.violation',   note: 'a rule is broken — this hexagon never means anything else' },
  { id: 'warning', glyph: 'warning',    word: 'status.warning',     note: 'attention, not failure' },
  { id: 'trend', glyph: 'trend',      word: 'status.trend',       note: 'direction of a number over syncs' },
  { id: 'stopped', glyph: 'stopped',    word: 'status.incomplete',  note: 'barred-ring terminal for a decision arm that ends the flow' },
];

/**
 * Utility glyphs replacing the chrome's former emoji/dingbats.
 * @group Grammar
 */
export const UTILITY = [
  { id: 'lock', glyph: 'lock',   replaces: '🔒', note: 'gate badge / checkpoint' },
  { id: 'fork', glyph: 'fork',   replaces: '⑂',  note: 'fork marker in code and fork chips' },
  { id: 'open', glyph: 'open',   replaces: '⧉',  note: 'open in editor (VS Code deep link)' },
  { id: 'shield', glyph: 'shield', replaces: '⛨',  note: 'validation-rule badge' },
  { id: 'gear', glyph: 'gear',   replaces: '⚙',  note: 'settings' },
  { id: 'sync', glyph: 'sync',   replaces: '⟳',  note: 're-ingest / sync action' },
  { id: 'bolt', glyph: 'bolt',   replaces: '⚡',  note: 'asynchronous hop (queue / event)' },
  { id: 'api', glyph: 'api',     replaces: '—',  note: 'API surface — an OpenAPI/Swagger contract, or the routes a source serves' },
  { id: 'design', glyph: 'design', replaces: '—', note: 'design reference — the screen as it was designed (Figma frame or image)' },
  { id: 'story', glyph: 'story', replaces: '—', note: 'a story — one component drawn on its own by the repo\u2019s Storybook' },
  { id: 'oneof', glyph: 'oneof', replaces: '—', note: 'one written call with several implementations behind it — exactly one of them runs, and which one is not in the code' },
  { id: 'work', glyph: 'work', replaces: '—', note: 'a work item — a story, task or bug a tracker holds, and the WORK surface that lists them' },
  { id: 'package', glyph: 'package', replaces: '—', note: 'a dependency — a package the code imports: copper, solid stripe for a library of this workspace, hatched for a third-party package' },
  { id: 'save', glyph: 'save', replaces: '—', note: 'save this view — a picture, a PDF or a spreadsheet of what is on screen, with where and when it was true written under it' },
  { id: 'absent', glyph: 'absent', replaces: '—', note: 'nothing here — the word beside it says which kind of nothing: none indexed, not built, not involved' },
];

/**
 * Inline SVG use of one sprite glyph. Purely visual — pair it with a word
 * (symWord) anywhere the glyph carries meaning on its own.
 * @group Grammar
 */
export function sym(id, cls) {
  return '<svg class="sym' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#sym-' + esc(id) + '"/></svg>';
}

/**
 * Glyph + word chip — the only sanctioned way to render a status or business
 * symbol (never color or glyph alone). `wordKey` is a catalog key.
 * @group Grammar
 */
export function symWord(id, wordKey, cls) {
  const d = def(wordKey);
  return '<span class="symword' + (cls ? ' ' + cls : '') + '"' + (d ? ' title="' + esc(d) + '"' : '') + '>'
    + sym(id) + '<span>' + esc(t(wordKey)) + '</span></span>';
}

/**
 * The Grammar Book fixture page: every sprite symbol, every status glyph and
 * every catalog string in both registers, rendered straight from the tables
 * above and the served catalog — no duplicated content, so the page cannot
 * drift from the product.
 * @group Grammar
 */
// Every `journey.biz.*` word sits beside the professional word it is the plain
// reading of — the book's own precedent (`journey.tx.*` beside `journey.biz.tx.*`),
// and the reason a register cannot drift: the two wordings of one fact are on
// one row of one page. Thirteen of them were on screen and in no group at all,
// which is the analyst's finding in another register (acceptance §7 item 1).
const JOURNEY_WORD_GROUPS = [
  { head: 'grammar.journeyWords.units', keys: ['journey.unit.action', 'journey.unit.beat', 'journey.unit.step', 'journey.biz.countSteps', 'journey.biz.countStepsOne'] },
  { head: 'grammar.journeyWords.checks', keys: ['journey.check.gate', 'journey.check.rule', 'journey.check.decision', 'journey.check.technical', 'journey.biz.untranslated'] },
  { head: 'grammar.journeyWords.forks', keys: ['journey.forks.title', 'journey.biz.forks.title', 'journey.forkCat.error', 'journey.biz.forkCat.error', 'journey.forkCat.guard', 'journey.biz.forkCat.guard', 'journey.forkCat.access', 'journey.biz.forkCat.access', 'journey.forkCat.flag', 'journey.biz.forkCat.flag', 'journey.forkCat.state', 'journey.biz.forkCat.state', 'journey.forkCat.branch', 'journey.biz.forkCat.branch'] },
  { head: 'grammar.journeyWords.cuts', keys: ['journey.cutPoints', 'journey.cutReason.depth', 'journey.cutReason.steps', 'journey.cutPoint.row', 'journey.truncated', 'journey.repeat', 'journey.countRepeats', 'journey.helpersFolded', 'journey.inside', 'journey.again', 'journey.againOne'] },
  { head: 'grammar.journeyWords.evidence', keys: ['journey.evidence.declared', 'journey.evidence.reached', 'journey.evidence.observed', 'journey.evidence.stale', 'journey.evidenceShared', 'journey.flowE2e.declared', 'journey.flowE2e.reached', 'journey.flowE2e.observed', 'journey.flowE2e.none', 'journey.biz.tests', 'journey.biz.testsRun.observed', 'journey.biz.testsRun.runOnly', 'journey.biz.testsRun.stale', 'journey.biz.testsRun.none'] },
  { head: 'grammar.journeyWords.status', keys: ['journey.status.built', 'journey.status.partly', 'journey.biz.partly', 'journey.status.designedNotBuilt', 'journey.status.planned', 'journey.status.notBuilt', 'journey.biz.notBuilt'] },
  // Every word that carries a number, with the scope it counts over — the two
  // scope words included, because the fault they answer was three totals on one
  // screen with nothing saying which was which (visual swarm 2026-09-24).
  { head: 'grammar.journeyWords.counts', keys: ['journey.countGates', 'journey.countChecks', 'journey.countActions', 'journey.countAgain', 'journey.countBuilt', 'journey.countDeclaredOnly', 'journey.countScreens', 'journey.countDecisions', 'journey.countSystems', 'journey.countSteps', 'journey.plannedCount', 'journey.scopeAll', 'journey.scopeHere', 'journey.biz.header', 'journey.drift.byKind', 'journey.identity', 'chrome.shownOf'] },
  { head: 'grammar.journeyWords.choice', keys: ['journey.oneOf', 'journey.biz.oneOf', 'journey.oneOf.through', 'journey.oneOf.candidates', 'journey.oneOf.setAside', 'journey.oneOf.how', 'journey.oneOf.unknown', 'journey.countChoices'] },
  { head: 'grammar.journeyWords.transaction', keys: ['journey.tx.lane', 'journey.tx.inside', 'journey.tx.after', 'journey.tx.straddles', 'journey.biz.tx.lane', 'journey.biz.tx.inside', 'journey.biz.tx.after', 'journey.biz.tx.straddles', 'journey.drill.txFallback', 'journey.biz.txFallback'] },
  { head: 'grammar.journeyWords.bizViews', keys: ['journey.bizTabs', 'journey.bizTab.words', 'journey.bizTab.gates', 'journey.bizTab.decisions', 'journey.bizGroup.gates', 'journey.bizGroup.rules', 'journey.bizGroup.words', 'journey.biz.notInWords', 'journey.biz.noneInWords', 'journey.sameWords'] },
  { head: 'grammar.journeyWords.absence', keys: ['journey.absent.noneIndexed', 'journey.biz.absent.noneIndexed', 'journey.absent.notInvolved', 'journey.biz.absent.notInvolved', 'journey.absent.notBuilt', 'journey.absent.notReached', 'journey.biz.absent.notReached', 'journey.absent.notIndexed', 'journey.biz.absent.notIndexed', 'journey.absent.notTranslated', 'journey.biz.absent.notTranslated'] },
];

const TESTS_WORD_GROUPS = [
  { head: 'grammar.testsWords.levels', keys: ['tests.level.unit', 'tests.level.integration', 'tests.level.e2e'] },
  { head: 'grammar.testsWords.run', keys: ['tests.run.passed', 'tests.run.failed', 'tests.run.skipped', 'tests.run.flaky', 'tests.run.unknown', 'tests.run.notRun'] },
  { head: 'grammar.testsWords.freshness', keys: ['tests.freshness.unchanged', 'tests.freshness.changed', 'tests.freshness.unknown'] },
  // The tab's central decision has its own words, and the book did not carry them:
  // an observed class attributed to a run rather than to a case. A reviewer found
  // exactly this gap — words on screen that the grammar does not define.
  { head: 'grammar.testsWords.runSeen', keys: ['tests.evidence.runSeen', 'tests.runOnly', 'tests.runOnlyOne', 'tests.observedSplit'] },
  { head: 'grammar.testsWords.blind', keys: ['tests.blind.missing', 'tests.blind.unreadable', 'tests.blind.empty', 'tests.blind.claim', 'tests.blind.each', 'tests.blind.digest', 'tests.blind.config', 'tests.blind.fold'] },
];

/**
 * The changes words (chunk H6), grouped by the question each set answers. Same
 * shape as the journey words and rendered by the same function, so a word
 * cannot be on one page and not the other.
 *
 * `journey.absent.notIndexed` appears here **and** in the absence group above on
 * purpose: the six absence words are closed, so a commit no sync ingested takes
 * that word rather than a seventh. One key, one string, two questions it answers.
 */
const CHANGES_WORD_GROUPS = [
  { head: 'grammar.changesWords.units', keys: ['chrome.sync', 'changes.commit', 'changes.filesTouched', 'journey.absent.notIndexed'] },
  { head: 'grammar.changesWords.spine', keys: ['changes.repo', 'changes.spine', 'changes.col.when', 'changes.swept', 'changes.col.note', 'changes.reindexed', 'changes.servedHere', 'changes.asOf'] },
  { head: 'grammar.changesWords.placed', keys: ['changes.state.recorded', 'changes.state.notInHistory', 'changes.state.belowFloor', 'changes.state.historyUnread', 'changes.state.noCommit', 'changes.state.notInSync', 'changes.from.source', 'changes.from.workspace', 'changes.unverified'] },
  { head: 'grammar.changesWords.bounds', keys: ['changes.bound.floor', 'changes.bound.exact', 'changes.notASum', 'changes.noGitHere', 'changes.shallow', 'changes.detached'] },
  { head: 'grammar.changesWords.range', keys: ['changes.range.syncs', 'changes.range.releases', 'changes.range.commits', 'changes.partialRange', 'changes.rangeUnreadable', 'changes.measured', 'changes.nothingMeasured', 'changes.sev.breaking', 'changes.sev.notable', 'changes.sev.info', 'changes.listCut', 'changes.narrative', 'changes.sideBySide', 'changes.hiddenInBusiness'] },
  { head: 'grammar.changesWords.provenance', keys: ['changes.attribution', 'changes.fileLevel', 'changes.rename', 'changes.renameIdentical', 'changes.byWhom', 'changes.touchedFiles'] },
  { head: 'grammar.changesWords.releases', keys: ['changes.release', 'changes.tagProposed', 'changes.noReleases'] },
];

/**
 * The impact words (B5.4): how far away a dependent is, what a path does and
 * does not say, where the answer stopped, what is reported apart from it, how
 * sure the number is, how a ring is drawn on the sheet, and the same answer in
 * the words a business reader gets.
 *
 * `journey.absent.noneIndexed` and `journey.absent.notInvolved` are shared with
 * the journey words on purpose — the six absence words are closed, so an impact
 * answer with nothing in it takes one of those rather than a seventh.
 */
const IMPACT_WORD_GROUPS = [
  { head: 'grammar.impactWords.distance', keys: ['impact.hop1', 'impact.hop2', 'impact.hopN', 'impact.clause.direct', 'impact.clause.through', 'impact.clause.far', 'impact.notASum'] },
  { head: 'grammar.impactWords.paths', keys: ['impact.strength', 'impact.notRecorded', 'impact.oneOf', 'impact.external'] },
  { head: 'grammar.impactWords.stops', keys: ['impact.notWalked', 'impact.cut.hops', 'impact.cut.hopsOnly', 'impact.cut.shared', 'impact.cut.cap'] },
  { head: 'grammar.impactWords.apart', keys: ['impact.excluded.setup', 'impact.excluded.deferred'] },
  { head: 'grammar.impactWords.bounds', keys: ['impact.bound.floor', 'impact.bound.exact', 'impact.none', 'journey.absent.noneIndexed', 'journey.absent.notInvolved'] },
  { head: 'grammar.impactWords.rings', keys: ['impact.ring.direct', 'impact.ring.through', 'impact.ring.behind', 'impact.ring.stop', 'impact.seedRing', 'impact.halo'] },
  { head: 'grammar.impactWords.plain', keys: ['impact.biz.line', 'impact.biz.uses', 'impact.biz.actions', 'impact.biz.journeysOf', 'impact.biz.evidence.none', 'impact.biz.evidence.near', 'impact.biz.evidence.direct', 'impact.biz.noE2e', 'impact.biz.floor', 'impact.biz.why.cut', 'impact.biz.why.runtime', 'impact.biz.why.unrecorded'] },
];

/**
 * One word book — a titled section of groups, each group a question and the
 * words that answer it. Both books on this page use it: the journey words (what
 * you are counting, what can stop or steer it, what the walk did not do, what
 * proves it runs, what is built, how a number names its scope, how an absence is
 * spelled) and the changes words.
 *
 * Rendered from the live catalog, so a word that changes here changes on the
 * page, and a key the catalog does not define simply does not appear. No worked
 * examples: an example would have to name one application's screens, and this
 * book ships with the tool, not with any codebase it reads.
 * @group Grammar
 */
function journeyWordsHtml(catalog) {
  return wordGroupsHtml(catalog, 'grammar.journeyWords', JOURNEY_WORD_GROUPS);
}

/**
 * The tests words: what kind of test it is, what a run said, whether that run
 * still speaks for this code, and what the tool could not read. The four
 * evidence classes and the six absence words are deliberately NOT repeated
 * here — they are the journey words, and the Tests surface prints those very
 * keys, so a word cannot mean two things on two pages.
 * @group Grammar
 */
function testsWordsHtml(catalog) {
  return wordGroupsHtml(catalog, 'grammar.testsWords', TESTS_WORD_GROUPS, 'grammar.testsWords.note');
}

/**
 * The changes words: the units a range is measured in, how the spine reads, where
 * a commit was placed, what bounds a number, and how a release is named.
 * `journey.absent.notIndexed` is shared with the journey words on purpose — the
 * six absence words are closed, so a commit no sync ingested takes that word.
 * @group Grammar
 */
function changesWordsHtml(catalog) {
  return wordGroupsHtml(catalog, 'grammar.changesWords', CHANGES_WORD_GROUPS);
}

/**
 * The impact words: the distances, what a path may claim, the stops, the two
 * asides, the bound, the ring shapes and the plain sentence. Rendered from the
 * live catalog like every other book on this page.
 * @group Grammar
 */
function impactWordsHtml(catalog) {
  return wordGroupsHtml(catalog, 'grammar.impactWords', IMPACT_WORD_GROUPS, 'grammar.impactWords.note');
}

/** One section of grouped catalog words, rendered from the live catalog; the
 * optional note closes the section with the sentence that ties it to another.
 * @group Grammar */
function wordGroupsHtml(catalog, head, groups, note) {
  if (!catalog) return '';
  let html = '<div class="set-sec"><h2>' + esc(t(head)) + '</h2>';
  for (const g of groups) {
    const rows = g.keys.filter((k) => catalog[k]);
    if (!rows.length) continue;
    html += '<h3 class="gb-group hud-label">' + esc(t(g.head)) + '</h3>'
      + '<table class="src-table gb-strings"><thead><tr><th>' + esc(t('grammar.colHud')) + '</th><th>' + esc(t('grammar.colPro'))
      + '</th><th>' + esc(t('grammar.colDefine')) + '</th></tr></thead><tbody>'
      + rows.map((k) => {
        const e = catalog[k];
        return '<tr><td><b>' + esc(e.hud) + '</b></td><td>' + esc(e.professional) + '</td>'
          + '<td class="gb-def">' + esc(e.define || '') + '<span class="gb-key mono">' + esc(k) + '</span></td></tr>';
      }).join('')
      + '</tbody></table>';
  }
  if (note) html += '<p class="set-note">' + esc(t(note)) + '</p>';
  return html + '</div>';
}

export function grammarHtml(catalog) {
  let html = '<div class="gb-wrap"><h1>' + esc(t('grammar.title')) + '</h1><p class="sub">' + esc(t('grammar.sub')) + '</p>';

  html += '<div class="set-sec"><h2>' + esc(t('grammar.symbols')) + '</h2><div class="gb-grid">';
  SYMBOLS.forEach((s) => {
    html += '<div class="gb-cell">' + sym(s.glyph, 'gb-glyph') + '<div class="gb-word hud-label">' + esc(t(s.word)) + '</div>'
      + '<div class="gb-form">' + esc(s.form) + '</div><div class="gb-map">' + esc(s.mapping) + '</div></div>';
  });
  html += '</div></div>';

  html += '<div class="set-sec"><h2>' + esc(t('grammar.status')) + '</h2><div class="gb-grid">';
  STATUS.forEach((s) => {
    html += '<div class="gb-cell st-' + esc(s.id) + '">' + symWord(s.glyph, s.word, 'gb-chip') + '<div class="gb-map">' + esc(s.note) + '</div></div>';
  });
  html += '</div><p class="set-note">' + esc(t('grammar.amberRule')) + '</p></div>';

  html += '<div class="set-sec"><h2>' + esc(t('grammar.utility')) + '</h2><div class="gb-grid">';
  UTILITY.forEach((u) => {
    html += '<div class="gb-cell">' + sym(u.glyph, 'gb-glyph') + '<div class="gb-form">replaces ' + esc(u.replaces) + '</div><div class="gb-map">' + esc(u.note) + '</div></div>';
  });
  html += '</div></div>';

  html += journeyWordsHtml(catalog);
  html += testsWordsHtml(catalog);
  html += changesWordsHtml(catalog);
  html += impactWordsHtml(catalog);

  html += '<div class="set-sec"><h2>' + esc(t('grammar.strings')) + '</h2>';
  if (!catalog) {
    html += '<p class="set-note">' + esc(t('sys.stringsFailed')) + '</p>';
  } else {
    html += '<table class="src-table gb-strings"><thead><tr><th>key</th><th>' + esc(t('grammar.colHud')) + '</th><th>' + esc(t('grammar.colPro')) + '</th><th>' + esc(t('grammar.colDefine')) + '</th></tr></thead><tbody>';
    Object.keys(catalog).sort().forEach((k) => {
      const e = catalog[k];
      html += '<tr id="gb-k-' + esc(k) + '"><td class="mono">' + esc(k) + (e.invariant ? ' <span class="gb-inv hud-label">' + esc(t('grammar.invariant')) + '</span>' : '') + '</td>'
        + '<td>' + esc(e.hud) + '</td><td>' + esc(e.professional) + '</td><td class="gb-def">' + esc(e.define || '') + '</td></tr>';
    });
    html += '</tbody></table>';
  }
  html += '</div></div>';
  return html;
}
