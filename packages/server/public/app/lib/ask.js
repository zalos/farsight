// lib/ask.js — Ask, with evidence (round 2026-10-10, proposal 8), and the clause the tour shares with it.
//
// A question in plain words goes to `GET /api/ask` (core `ask()`: a small grammar over the graph, never a model) and
// comes back as lines, each a catalog template filled with what the graph holds and the node ids it cites. This
// module draws the box and the answer card — the *derived · no model* chip, the lead lines, MUST BE TRUE FIRST,
// PROVEN BY with the verdict and its scope, PATH, the doors — and the clause both the card and the tour panel print:
// the template filled in, a number as its `Counted` with its tip, an evidence word as the one verdict's chip, and a
// chip per cited part that frames it on the Map at the right stop (a gate opens the gate card, a case the Tests page).
//
// The business register prints the business fills (core `codeFree()`: the code said in words); the identifiers stay
// in the chips' tips. Every word is the catalog's.

import { esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';
import { countedHtml, defAttrs } from './counted.js';
import { testEvidenceHtml } from './test-chip.js';
import { gateAttrs } from './gate-card.js';
import { copyDoorsHtml } from './detail-doors.js';
import { mapScreenHash, mapStopHash, withParams } from './route-url.js';

const API = '/api/ask';
const biz = () => currentLens() === 'business';
/** The kinds a chip frames on the Map's street as an explore card (the Map's `card=<kind>:<id>` grammar). */
const CARD_KIND = { route: 'call', table: 'record', external: 'external', queue: 'message', topic: 'message' };
const GLYPH = { need: 'gate', decision: 'decision', check: 'warning', verdict: 'live', technical: 'gear', data: 'step', move: 'record', who: 'human', words: 'step', refer: 'step', actions: 'bolt', needs: 'gate' };

/**
 * Where a cited part is read best: a gate's card (null — the chip carries the gate card's attributes instead), a
 * case's Tests detail, a journey's street, else the street at the place the clause is about — the screen framed,
 * a call or a record with its explore card open, any other part at the action that holds it — else the code map.
 * `place` is `{ flowId, screen, storyline? }` (a stop's, or an answer's map door). Pure.
 */
export function citeHref(id, ref, place) {
  const kind = ref && ref.kind;
  if (kind === 'guard' || kind === 'rule') return null;
  if (kind === 'test') return '#/tests?node=' + encodeURIComponent(id);
  if (kind === 'flow') return '#/map/' + encodeURIComponent(id);
  if (!place || !place.flowId) return '#/codemap?node=' + encodeURIComponent(id);
  const keep = (h) => (place.storyline ? withParams(h, { storyline: place.storyline }) : h);
  if (kind === 'page' || kind === 'component') return keep(mapScreenHash(place.flowId, place.screen));
  if (CARD_KIND[kind]) return keep(mapScreenHash(place.flowId, place.screen, { node: id, kind: CARD_KIND[kind] }));
  return keep(mapStopHash(place.flowId, { screen: place.screen, part: id }));
}

/** One cited part as a chip: its words (business) or its name, the identifier and the file and line in its tip. */
export function citeChipHtml(id, ref, place) {
  const r = ref || { kind: 'function', name: id, words: id };
  const label = biz() ? r.words : r.name;
  const tip = r.name + (r.loc ? ' · ' + r.loc : '') + ' · ' + t('tour.cite');
  const cls = 'tw-chip k-' + esc(r.kind);
  const href = citeHref(id, r, place);
  if (href == null) return '<span class="' + cls + '"' + gateAttrs(id) + ' data-cite="' + esc(id) + '">' + sym('gate') + esc(label) + '</span>';
  return '<a class="' + cls + '" href="' + esc(href) + '" data-cite="' + esc(id) + '"' + tipAttrs({ text: tip, noFocus: true }) + '>' + esc(label) + '</a>';
}

/** A precondition's evidence: the one verdict's chip, or *no test is known to reach it* when nothing does. */
function needEvidenceHtml(v) {
  if (!v) return '';
  if (v.word && v.word.cls === 'none' && !(v.runs && v.runs.n)) return '<span class="ev none"' + defAttrs('tour.noneKnown') + '>' + esc(t('tour.noneKnown')) + '</span>';
  return testEvidenceHtml({ verdict: v, evidenceWord: v.word });
}

/**
 * One clause: its template in the register's lens, filled — `{count}` as the clause's `Counted` with its tip, `{word}`
 * as the verdict's chip, the rest as text — then a chip per cited part (cases fold into the verdict, gates open their
 * card). `o.place` frames the chips; `o.nodes` names them; `o.chips: false` leaves the chips out.
 */
export function clauseHtml(c, o = {}) {
  const b = biz();
  const key = b ? (c.bizKey || c.key) : c.key;
  const vars = (b ? c.bizVars : c.vars) || c.vars || {};
  const api = o.api || API;
  const parts = String(t(key)).split(/(\{\w+\})/);
  let html = '';
  for (const p of parts) {
    const m = /^\{(\w+)\}$/.exec(p);
    if (!m) { html += esc(p); continue; }
    const name = m[1];
    if (name === 'count' && c.counted) html += countedHtml(c.counted, api, { words: vars.count });
    else if (name === 'word' && c.evidence) html += testEvidenceHtml({ verdict: c.evidence, evidenceWord: c.evidence.word }) || esc(vars.word || '');
    else html += esc(vars[name] != null ? vars[name] : '');
  }
  if (c.role === 'need' && c.evidence) html += ' ' + needEvidenceHtml(c.evidence);
  if (o.chips !== false) {
    const nodes = o.nodes || {};
    const shown = (c.cites || []).filter((id) => (nodes[id] || {}).kind !== 'test');
    const cases = (c.cites || []).length - shown.length;
    const chips = shown.slice(0, 3).map((id) => citeChipHtml(id, nodes[id], o.place)).join('');
    const more = shown.length > 3 ? '<span class="tw-more"' + tipAttrs({ text: shown.slice(3).map((id) => (nodes[id] || {}).name || id).join(' · '), noFocus: true }) + '>+' + (shown.length - 3) + '</span>' : '';
    const caseDoor = cases && c.cites.length ? '<a class="tw-chip k-test" href="' + esc('#/tests?node=' + encodeURIComponent(shown[0] || c.cites[0])) + '"' + defAttrs('ask.door.cases') + '>' + sym('live') + esc(t('ask.door.cases')) + '</a>' : '';
    if (chips || caseDoor) html += ' <span class="tw-cites">' + chips + more + caseDoor + '</span>';
  }
  return html;
}

// ── the box and the card ────────────────────────────────────────────────────────────────────────────

/** The question box: the input, the button, and where the answer lands. `o.id` names it for a redraw. */
/**
 * The box's example question, built from this graph's statuses (`GET /api/ask?example=1`, core `askExample`) — asked
 * once, then every box on screen takes it; the catalog's example stands in until it lands (swarm round 3: the fixed
 * example asked about a status the reference app does not have).
 */
let EXAMPLE = null;
let EXAMPLE_ASKED = false;
function askExampleNow() {
  if (EXAMPLE_ASKED || typeof fetch === 'undefined') return;
  EXAMPLE_ASKED = true;
  fetch(API + '?example=1').then((r) => (r.ok ? r.json() : null)).then((b) => {
    if (!b || !b.example) return;
    EXAMPLE = b.example;
    for (const q of document.querySelectorAll('.ask-q')) q.setAttribute('placeholder', EXAMPLE);
  }).catch(() => {});
}

export function askBoxHtml(o = {}) {
  askExampleNow();
  return '<div class="ask-wrap" data-ask="' + esc(o.id || 'ask') + '"' + (o.repo ? ' data-repo="' + esc(o.repo) + '"' : '') + '>'
    + '<div class="ask-title"><span class="hud-label"' + defAttrs('ask.title') + '>' + esc(t('ask.title')) + '</span>'
    + '<span class="ask-sub"' + defAttrs('ask.sub') + '>' + esc(t('ask.sub')) + '</span></div>'
    + '<form class="ask-box" role="search" onsubmit="return fsAsk(this, event)">'
    + '<input type="text" class="ask-q" name="q" autocomplete="off" spellcheck="false" aria-label="' + esc(t('ask.title')) + '" placeholder="' + esc(EXAMPLE || t('ask.placeholder')) + '"'
    + (o.q ? ' value="' + esc(o.q) + '"' : '') + '>'
    + '<button type="submit" class="map-tb ask-go"' + defAttrs('ask.go') + '>' + esc(t('ask.go')) + '</button></form>'
    + '<div class="ask-out" aria-live="polite"></div></div>';
}

/** The answers on screen, by box id: the question and the answer, so a lens change redraws without asking again. */
const LAST = new Map();

/** The answer as a card. */
export function askCardHtml(a, o = {}) {
  if (!a) return '';
  const nodes = a.nodes || {};
  const mapDoor = (a.doors || []).find((d) => d.kind === 'map');
  const place = mapDoor ? { flowId: mapDoor.flowId, screen: mapDoor.screen } : null;
  const line = (c) => clauseHtml(c, { nodes, place, api: API });
  let html = '<div class="ask-card" data-shape="' + esc(a.shape) + '">'
    + '<div class="ask-chips"><span class="ask-derived"' + defAttrs('ask.derived') + '>' + esc(t('ask.derived')) + '</span>'
    + (a.phrased ? '<span class="ask-phrased"' + defAttrs('ask.phrased') + '>' + esc(t('ask.phrased')) + '</span>' : '') + '</div>';
  for (const c of a.lead || []) html += '<p class="ask-lead r-' + esc(c.role) + (c.warn ? ' warn' : '') + '">' + line(c) + '</p>';
  // did you mean: the nearest shapes filled with the question's own nouns — a click asks it (swarm round 3)
  if (a.suggest && a.suggest.length) {
    html += '<div class="ask-suggest"><span class="hud-label"' + defAttrs('ask.didYouMean') + '>' + esc(t('ask.didYouMean')) + '</span>'
      + a.suggest.map((q) => '<button type="button" class="ask-sugg" data-q="' + esc(q) + '" onclick="fsAskSuggest(this)">' + esc(q) + '</button>').join('') + '</div>';
  }
  if (a.shapes) html += '<ul class="ask-shapes">' + a.shapes.map((k) => '<li' + defAttrs(k) + '>' + esc(t(k)) + '</li>').join('') + '</ul>';
  for (const s of a.sections || []) {
    html += '<div class="ask-sec"><span class="hud-label"' + defAttrs(s.key) + '>' + esc(t(s.key)) + '</span><ul>'
      + s.rows.map((c) => '<li class="ask-row r-' + esc(c.role) + (c.warn ? ' warn' : '') + (c.tier ? ' t-' + esc(c.tier) : '') + '">'
        + sym(GLYPH[c.role] || 'step') + '<span>' + line(c) + '</span></li>').join('')
      + '</ul></div>';
  }
  if (a.phrased) html += '<p class="ask-phrase"><span class="hud-label"' + defAttrs('ask.phrased') + '>' + esc(t('ask.phrased')) + '</span> ' + esc(a.phrased.text) + '</p>';
  const doors = [];
  for (const d of a.doors || []) {
    if (d.kind === 'gate' && d.node) doors.push('<span class="dd-door"' + gateAttrs(d.node) + '>' + esc(t('ask.door.gate')) + '</span>');
    if (d.kind === 'map' && d.flowId) doors.push('<a class="dd-door" href="' + esc(mapStopHash(d.flowId, { screen: d.screen, action: d.action })) + '"' + defAttrs('ask.door.map') + '>' + esc(t('ask.door.map')) + '</a>');
    if (d.kind === 'cases' && d.node) doors.push('<a class="dd-door" href="' + esc('#/tests?node=' + encodeURIComponent(d.node)) + '"' + defAttrs('ask.door.cases') + '>' + esc(t('ask.door.cases')) + '</a>');
  }
  const copy = copyDoorsHtml('ask', { id: a.question, ...(o.repo ? { repo: o.repo } : {}) }, { compact: true });
  if (doors.length || copy) html += '<div class="ask-doors">' + doors.join('') + copy + '</div>';
  return html + '</div>';
}

/** Draw the answer in hand (after a lens change), or nothing. */
export function redrawAsk(root) {
  for (const w of (root || document).querySelectorAll('.ask-wrap[data-ask]')) {
    const last = LAST.get(w.dataset.ask);
    const out = w.querySelector('.ask-out');
    if (!out || !last) continue;
    out.innerHTML = last.error ? '<p class="ask-err">' + esc(t('ask.failed').replace('{error}', last.error)) + '</p>' : askCardHtml(last.answer, { repo: w.dataset.repo });
    const q = w.querySelector('.ask-q');
    if (q && !q.value) q.value = last.q;
  }
}

/** Ask the box's question; the card lands under it. */
export function askNow(wrap, q) {
  const out = wrap && wrap.querySelector('.ask-out');
  const question = String(q || '').trim();
  if (!out || !question) return Promise.resolve(null);
  const id = wrap.dataset.ask || 'ask';
  const repo = wrap.dataset.repo || '';
  out.innerHTML = '<p class="ask-wait">' + esc(t('ask.asking')) + '</p>';
  return fetch(API + '?q=' + encodeURIComponent(question) + (repo ? '&repo=' + encodeURIComponent(repo) : ''))
    .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
    .then(({ ok, body }) => {
      if (!ok || !body || !body.answer) { LAST.set(id, { q: question, error: (body && body.error) || '?' }); redrawAsk(wrap.parentNode); return null; }
      LAST.set(id, { q: question, answer: body.answer });
      redrawAsk(wrap.parentNode);
      return body.answer;
    })
    .catch((err) => { LAST.set(id, { q: question, error: String(err && err.message || err) }); redrawAsk(wrap.parentNode); return null; });
}

/** The box's submit. */
function fsAsk(form, e) {
  if (e) e.preventDefault();
  const wrap = form.closest('.ask-wrap');
  const q = form.querySelector('.ask-q');
  askNow(wrap, q && q.value);
  return false;
}
if (typeof window !== 'undefined') window.fsAsk = fsAsk;

/** A *did you mean* question: put it in the box and ask it. */
function fsAskSuggest(btn) {
  const wrap = btn && btn.closest('.ask-wrap');
  const q = wrap && wrap.querySelector('.ask-q');
  if (!wrap || !q) return;
  q.value = btn.dataset.q || '';
  askNow(wrap, q.value);
}
if (typeof window !== 'undefined') window.fsAskSuggest = fsAskSuggest;
