// lib/state-of-play.js — the front door opens with the state of play (round 2026-10-10, proposal 5).
//
// Two cards replace *New here?*: READ THIS IF (the three steps and their two doors) and STATE OF PLAY (what it is
// as of — sources, sync, when, the code's commit, the build that drew it — then three columns: built and walkable ·
// validated by a run · still open). Under them, the words this application leans on, from its config glossary.
// Every number is a `Counted` from `GET /api/state` (core `stateOfPlay()`), printed with its tip by
// `countedHtml()`; every line ends with a *re-check* door that names the command printing the same number again
// and copies it. This module folds nothing: it prints what the server answered.
import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, defAttrs } from './counted.js';
import { tipAttrs, registerTip, tableTip, setTip, pinTip } from './tooltip.js';
import { freshSentence, freshAttrs } from './freshness.js';

const API = '/api/state';

/** The first card: three steps for someone new, and the two doors. Chrome — it says nothing about the product. */
export function readThisIfHtml() {
  return '<div class="set-sec jrn-start jrn-readthis"><h2' + defAttrs('journeys.readThisIf') + '>' + esc(t('journeys.readThisIf')) + '</h2>'
    + '<ol class="jrn-startlist"><li>' + esc(t('journeys.startStep1')) + '</li>'
    + '<li>' + esc(t('journeys.startStep2')) + '</li>'
    + '<li>' + esc(t('journeys.startStep3')) + '</li></ol>'
    + '<div class="jrn-startbtns">'
    + '<a class="rel" href="#/grammar">' + sym('open') + ' ' + esc(t('journeys.startGrammar')) + '</a>'
    + '<button class="rel" onclick="toggleKeymapPanel()">' + esc(t('journeys.startKeys')) + '</button>'
    + '</div></div>';
}

/** The whole front-door block, drawn empty first and filled when `/api/state` answers. */
export function stateOfPlayShellHtml() {
  return '<div class="sop-row">' + readThisIfHtml()
    + '<div class="set-sec sop-card" id="sop-card" aria-busy="true"><h2' + defAttrs('state.title') + '>' + esc(t('state.title')) + '</h2></div></div>'
    + '<div class="set-sec sop-gloss" id="sop-gloss" hidden></div>';
}

const business = () => currentLens() === 'business';

/** A re-check door: the command in its tip; a press copies it. '' in the business lens (it is code) or when there is none. */
function recheckHtml(c) {
  if (!c || !c.recheck || business()) return '';
  const tip = c.recheck.cli + (c.recheck.mcp ? ' · ' + t('state.recheckMcp').replace('{tool}', c.recheck.mcp) : '');
  return ' <button type="button" class="sop-re" data-cmd="' + esc(c.recheck.cli) + '"' + tipAttrs({ text: tip, noFocus: true }) + ' onclick="sopCopy(this)">'
    + esc(t('state.recheck')) + ' ›</button>';
}

/** The command printed under a column's first line, so a reader sees what *re-check* means without opening a tip. */
function cmdHtml(c) {
  return c && c.recheck && !business() ? '<code class="sop-cmd">' + esc(c.recheck.cli) + '</code>' : '';
}

/** One line: the count with its tip, words after it, the re-check door. '' when the lens does not print the count. */
function lineHtml(c, extra, first) {
  const n = countedHtml(c, API, { cls: 'sop-n' });
  if (!n) return '';
  return '<li>' + n + (extra || '') + (first ? cmdHtml(c) : '') + recheckHtml(c) + '</li>';
}

function provenanceHtml(p) {
  const bits = [];
  if (p.sources && p.sources.length) bits.push('<b>' + esc(p.sources.join(', ')) + '</b>');
  if (p.sync != null) bits.push('<span' + defAttrs('state.asOf') + '>' + esc(t('state.asOf').replace('{n}', p.sync)) + '</span>');
  if (p.generatedAt) bits.push('<span>' + esc(String(p.generatedAt).replace('T', ' ').slice(0, 16)) + '</span>');
  if (!business()) {
    bits.push(p.commit
      ? '<span' + defAttrs('state.codeAt') + '>' + esc(t('state.codeAt').replace('{c}', String(p.commit).slice(0, 7))) + '</span>'
      : '<span' + defAttrs('state.codeAtNone') + '>' + esc(t('state.codeAtNone')) + '</span>');
    if (p.farsight) bits.push('<span' + defAttrs('state.drawnBy') + '>' + esc(t('state.drawnBy').replace('{b}', p.farsight.version + (p.farsight.commit ? ' · ' + p.farsight.commit : ''))) + '</span>');
  }
  return '<p class="sop-prov">' + bits.join(' · ') + '</p>';
}

/** The history fact: one sentence, both halves, each number with its tip. */
function historyHtml(h) {
  if (!h) return '<li><span' + defAttrs('state.historyNone') + '>' + esc(t('state.historyNone')) + '</span></li>';
  return '<li class="sop-hist">' + [h.read, h.ingested, h.notYet].map((c) => countedHtml(c, API, { cls: 'sop-n' })).join(' · ') + recheckHtml(h.read) + '</li>';
}

/** The state of play card's body: provenance, then the three columns. */
export function stateOfPlayHtml(s) {
  const b = s.built; const v = s.validated; const o = s.open;
  const built = [
    lineHtml(b.journeys, '', true),
    lineHtml(b.screens),
    lineHtml(b.operations),
    b.storylines ? '<li>' + [countedHtml(b.storylines, API, { cls: 'sop-n' }), countedHtml(b.branches, API, { cls: 'sop-n' })].filter(Boolean).join(' · ') + recheckHtml(b.storylines) + '</li>' : '',
  ].join('');
  const words = (v.byVerdict || []).filter((x) => x.word && x.word.cls !== 'none');
  const fresh = v.lastE2e && v.lastE2e.fresh;
  const runLine = v.lastE2e
    ? '<li><span>' + esc(t('state.lastE2e').replace('{date}', String(v.lastE2e.at).slice(0, 10))) + '</span>'
      + (fresh && fresh.key ? ' · <span class="fresh fresh-' + esc(fresh.state) + '"' + freshAttrs(fresh, { noFocus: true }) + '>' + esc(freshSentence(fresh)) + '</span>' : '') + '</li>'
    : '<li><span' + defAttrs('state.noE2e') + '>' + esc(t('state.noE2e')) + '</span></li>';
  const parts = (v.cases && v.cases.breakdown || []).filter((p) => p.n && p.key !== 'count.part.passed');
  const casesLine = v.cases ? lineHtml(v.cases, parts.length ? ' · ' + parts.map((p) => '<span' + defAttrs(p.key) + '>' + esc(t(p.key).replace('{n}', p.n)) + '</span>').join(' · ') : '') : '';
  const validated = words.map((x, i) => lineHtml(x.journeys, ' <span class="sop-word ev-' + esc(x.word.cls) + '"' + defAttrs(x.word.key) + '>' + esc(t(x.word.key)) + '</span>', i === 0)).join('')
    + runLine + casesLine;
  const names = (o.notBuiltNames || []).length ? ' <span class="sop-names">(' + esc(o.notBuiltNames.join(', ')) + ')</span>' : '';
  const stillOpen = [
    lineHtml(o.screensNotBuilt, names, true),
    lineHtml(o.operationsNotImplemented),
    lineHtml(o.blindSpots),
    lineHtml(o.drift),
    historyHtml(o.history),
  ].join('');
  const col = (key, cls, body) => '<div class="sop-col ' + cls + '"><h3' + defAttrs(key) + '>' + esc(t(key)) + '</h3><ul>' + body + '</ul></div>';
  return '<h2' + defAttrs('state.title') + '>' + esc(t('state.title')) + '</h2>' + provenanceHtml(s.provenance || {})
    + '<div class="sop-cols">' + col('state.col.built', 'ok', built) + col('state.col.validated', 'run', validated) + col('state.col.open', 'open', stillOpen) + '</div>';
}

/** The glossary strip: four of the application's own words and a door to all of them; the absence said when there are none. */
export function glossaryHtml(s) {
  const g = s.glossary || [];
  const head = '<h2' + defAttrs('journeys.glossary.title') + '>' + esc(t('journeys.glossary.title')) + '</h2>';
  if (!g.length) {
    return head + '<p class="set-note sop-none"><span' + defAttrs('journey.absent.noneIndexed') + '>' + esc(t('journey.absent.noneIndexed')) + '</span> · '
      + esc(t('journeys.glossary.none')) + '</p>';
  }
  const chip = (e) => '<span class="sop-term"' + tipAttrs({ id: 'sopTerm', args: e, noFocus: false }) + '><b>' + esc(e.label) + '</b>'
    + (e.description ? '<span>' + esc(e.description) + '</span>' : '') + '</span>';
  return head + '<div class="sop-terms">' + g.slice(0, 4).map(chip).join('')
    + '<button type="button" class="rel sop-all"' + tipAttrs({ id: 'sopGlossary', args: { n: g.length }, noFocus: true }) + ' onclick="sopGlossary(this)">' + esc(t('journeys.glossary.all')) + ' ›</button></div>';
}

let LAST = null;
registerTip('sopTerm', (el, e) => '<div class="tip-h">' + esc(e.label) + '</div>'
  + (e.description ? '<p class="tip-p">' + esc(e.description) + '</p>' : '')
  + tableTip({ rows: [{ cells: ['journeys.glossary.term', e.key], code: true }, { cells: ['journeys.glossary.file', e.repo + ' · ' + e.file], code: true }] }));
registerTip('sopGlossary', () => {
  const g = (LAST && LAST.glossary) || [];
  return '<div class="tip-h">' + esc(t('journeys.glossary.title')) + '</div>'
    + tableTip({ rows: g.map((e) => [e.label, e.description || '']) });
});

/** Open the whole glossary (a press on *the glossary ›*). */
function sopGlossary(el) { pinTip(el); }
/** Copy a re-check command, and say so in the door's tip. */
function sopCopy(el) {
  const cmd = el && el.dataset.cmd;
  if (!cmd) return;
  const done = () => { setTip(el, { text: cmd + ' · ' + t('state.recheckCopied') }); pinTip(el); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(done, done);
    else done();
  } catch (e) { done(); }
}
window.sopCopy = sopCopy;
window.sopGlossary = sopGlossary;

const CACHE = new Map();
/** `/api/state` for a scope, once per scope and sync. */
function stateFor(scope) {
  const key = scope + '@' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || '');
  if (!CACHE.has(key)) {
    CACHE.clear();
    CACHE.set(key, fetch(API + '?scope=' + encodeURIComponent(scope)).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return CACHE.get(key);
}

/** Fill the two cards and the strip once the server answers; an older server without the route leaves READ THIS IF alone. */
export function mountStateOfPlay(scope) {
  return stateFor(scope).then((s) => {
    const card = document.getElementById('sop-card');
    const gloss = document.getElementById('sop-gloss');
    if (!card) return;
    card.removeAttribute('aria-busy');
    if (!s || s.error || !s.built) { card.hidden = true; return; }
    LAST = s;
    card.innerHTML = stateOfPlayHtml(s);
    if (gloss) { gloss.innerHTML = glossaryHtml(s); gloss.hidden = false; }
  });
}
