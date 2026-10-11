// lib/tour.js — walk me through it (round 2026-10-10, proposal 8): the guided walk's panel on the Map.
//
// WALK in the Map's toolbar (and the `a` key — `w` is the lanes', `t` the tests') opens a panel beside the board:
// *stop n of m*, the stop's title, its sentences — each a catalog template the server filled from the graph (core
// `tourOf()`, `GET /api/tour`), with a chip on every cited part that frames it on the Map at the right stop — the
// REFERENCED parts, the dots, ‹ PREV · NEXT ›, the line *every sentence is read from the graph · nothing is inferred
// by a model*, and an ASK box under it. The Map moves with the stop: a screen stop frames that screen on its
// journey's street; a hand-off stop frames the call that makes the move (its explore card open), or — when the reader
// had the storyline's lanes on — stays on the lanes and marks the move's pill.
//
// The Map owns the board and the address; it hands this module `frame(stop, tour)` and `target()` (what to walk: the
// storyline drawn, else the journey on screen), `at()` (where the reader is, so the walk starts there) and
// `shown(open)`. The panel is one of the Map's dock panels (lib/map-dock.js, cleanup pass 2026-10-11): its stop line —
// *stop n of m* · ‹ PREV · NEXT › · ✕ — is pinned at its top, its sentences scroll under it, ASK is pinned at its foot.

import { esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';
import { countedAttrs, defAttrs } from './counted.js';
import { copyDoorsHtml } from './detail-doors.js';
import { clauseHtml, citeChipHtml, askBoxHtml, redrawAsk } from './ask.js';

const API = '/api/tour';
const biz = () => currentLens() === 'business';
const fill = (key, vars) => Object.entries(vars || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));

/** The walk on screen. */
export const TOUR = {
  open: false,
  /** `{ storyline?, flow?, repo? }` */
  target: null,
  data: null,
  /** 0-based */
  at: 0,
  loading: false,
  error: null,
  gen: 0,
  host: null,
  /** the Map's: `frame(stop, tour)` moves the board, `target()` names what to walk */
  api: null,
  /** the reader had the storyline's lanes on when the walk opened */
  lanes: false,
};

/** The toolbar's WALK control. */
export function walkToolHtml() {
  return '<button type="button" class="map-tb map-tb-walk' + (TOUR.open ? ' on' : '') + '" data-act="walk" aria-pressed="' + TOUR.open + '" aria-label="' + esc(t('tour.title')) + '"'
    + tipAttrs({ key: 'tour.tool', noFocus: true }) + '>' + sym('human') + esc(t('tour.tool')) + '</button>';
}

/** Bind the panel to the Map: its host, and how the board moves. */
export function bindWalk(host, api) {
  TOUR.host = host;
  TOUR.api = api;
  if (!host) return;
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKey);
}

export function walkOpen() { return TOUR.open; }

/**
 * Open the walk: on `target` (`{ storyline, repo }` or `{ flow }`), else what the Map names now. The Map's tree may
 * still be loading when a link opens the walk: the target is asked for again until it answers (10 s at most).
 */
export function openWalk(target, o = {}) {
  TOUR.open = true;
  TOUR.lanes = !!o.lanes;
  draw();
  const want = target || (TOUR.api && TOUR.api.target && TOUR.api.target());
  if (!want && (o.tries || 0) < 50) { setTimeout(() => { if (TOUR.open && !TOUR.target) openWalk(null, { ...o, tries: (o.tries || 0) + 1 }); }, 200); return; }
  if (!want) { TOUR.target = null; TOUR.data = null; draw(); return; }
  const same = TOUR.target && TOUR.data && JSON.stringify(TOUR.target) === JSON.stringify(want);
  TOUR.target = want;
  if (same) { draw(); return; }
  load(o.stop || 0);
}

/** Close the walk; the board stays where the last stop put it. */
export function closeWalk(o = {}) {
  if (!TOUR.open) return;
  TOUR.open = false;
  TOUR.gen++;
  if (TOUR.host) TOUR.host.innerHTML = '';
  if (TOUR.api && TOUR.api.shown) TOUR.api.shown(false);
  if (!o.quiet && TOUR.api && TOUR.api.closed) TOUR.api.closed();
}

/** WALK pressed, or the key. */
export function toggleWalk(o = {}) {
  if (TOUR.open) closeWalk();
  else { TOUR.target = null; openWalk(null, o); }
}

function load(at) {
  const gen = ++TOUR.gen;
  TOUR.loading = true;
  TOUR.error = null;
  TOUR.data = null;
  draw();
  const tg = TOUR.target;
  const q = tg.storyline ? 'storyline=' + encodeURIComponent(tg.storyline) : 'flow=' + encodeURIComponent(tg.flow);
  fetch(API + '?' + q + (tg.repo ? '&repo=' + encodeURIComponent(tg.repo) : '') + (tg.persona ? '&persona=' + encodeURIComponent(tg.persona) : ''))
    .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
    .then(({ ok, body }) => {
      if (gen !== TOUR.gen) return;
      TOUR.loading = false;
      if (!ok || !body || !body.tour) { TOUR.error = (body && body.error) || '?'; draw(); return; }
      TOUR.data = body.tour;
      // opened at a screen (an action, a table, a screen up close): the walk starts at that screen's stop, so the
      // Map stays where the reader is
      const here = !at && TOUR.api && TOUR.api.at ? TOUR.api.at() : null;
      const hi = here && here.screen ? body.tour.stops.findIndex((x) => x.kind !== 'handoff' && x.place && x.place.flowId === here.flowId && x.place.screen === here.screen) : -1;
      go(hi >= 0 ? hi : Math.min(at, Math.max(0, body.tour.stops.length - 1)));
    })
    .catch((err) => { if (gen !== TOUR.gen) return; TOUR.loading = false; TOUR.error = String(err && err.message || err); draw(); });
}

/** Go to stop `i` (0-based): the panel shows it and the Map moves with it. */
export function go(i) {
  const d = TOUR.data;
  if (!d || !d.stops.length) { draw(); return; }
  TOUR.at = Math.max(0, Math.min(d.stops.length - 1, i));
  draw();
  // a new stop reads from its top
  const body = TOUR.host && TOUR.host.querySelector('.tw-body');
  if (body) body.scrollTop = 0;
  const stop = d.stops[TOUR.at];
  if (TOUR.api && TOUR.api.frame) TOUR.api.frame(stop, d, { lanes: TOUR.lanes });
}

/** The place a stop's chips frame their parts at. */
function placeOf(stop, d) {
  return { flowId: stop.place.flowId, screen: stop.place.screen, ...(d.target.kind === 'storyline' ? { storyline: d.target.id } : {}) };
}

/** Redraw the panel (the lens or the register moved). */
export function drawWalk() { if (TOUR.open) draw(); }

function draw() {
  const host = TOUR.host;
  if (!host) return;
  if (TOUR.api && TOUR.api.shown) TOUR.api.shown(TOUR.open);
  if (!TOUR.open) return;
  const head = '<div class="tw-head"><span class="hud-label tw-title"' + defAttrs('tour.title') + '>' + sym('human') + esc(t('tour.title')) + '</span>'
    + '<span class="tw-of"></span><button type="button" class="tw-x" data-tw="close" aria-label="' + esc(t('tour.close')) + '"' + tipAttrs({ key: 'tour.close', noFocus: true }) + '>✕</button></div>';
  const ask = '<div class="tw-ask">' + askBoxHtml({ id: 'walk', repo: (TOUR.data && TOUR.data.target.repo) || (TOUR.target && TOUR.target.repo) || '' }) + '</div>';
  if (TOUR.loading || (!TOUR.data && !TOUR.error && TOUR.target)) { host.innerHTML = head + '<p class="tw-wait">' + esc(t('tour.loading')) + '</p>' + ask; redrawAsk(host); return; }
  if (TOUR.error) { host.innerHTML = head + '<p class="tw-err">' + esc(fill('tour.failed', { error: TOUR.error })) + '</p>' + ask; redrawAsk(host); return; }
  const d = TOUR.data;
  if (!d || !d.stops.length) { host.innerHTML = head + '<p class="tw-empty"' + defAttrs('tour.empty') + '>' + esc(t('tour.empty')) + '</p>' + ask; redrawAsk(host); return; }
  const stop = d.stops[TOUR.at];
  const b = biz();
  const place = placeOf(stop, d);
  // stop n of m: m is the walk's stops, a Counted with its tip (screens · hand-offs)
  const of = '<span class="tw-n"' + countedAttrs(d.counted.stops, API) + '>'
    + esc(fill('tour.stopOf', { n: stop.n, m: d.stops.length })) + '</span>';
  const kind = '<span class="tw-kind k-' + esc(stop.kind) + '"' + defAttrs('tour.kind.' + stop.kind) + '>' + esc(t('tour.kind.' + stop.kind)) + '</span>';
  const branch = stop.journey.branch ? '<p class="tw-branch"' + defAttrs('tour.branch') + '>' + esc(fill('tour.branch', { name: stop.journey.branch.ofName, when: stop.journey.branch.when })) + '</p>' : '';
  const clauses = stop.clauses.map((c) => '<p class="tw-cl r-' + esc(c.role) + (c.warn ? ' warn' : '') + (c.tier ? ' t-' + esc(c.tier) : '') + '" data-role="' + esc(c.role) + '">'
    + (c.warn ? sym('warning') : c.role === 'need' ? sym('gate') : c.role === 'decision' ? sym('decision') : '')
    + (c.role === 'words' ? wordsHtml(c, { nodes: d.nodes, place, api: API }) : clauseHtml(c, { nodes: d.nodes, place, api: API })) + '</p>').join('');
  const needsAt = stop.clauses.findIndex((c) => c.role === 'need');
  const body = needsAt >= 0
    ? clauses.replace('<p class="tw-cl r-need', '<p class="tw-needs hud-label"' + defAttrs('tour.handoff.needsHead') + '>' + esc(t('tour.handoff.needsHead')) + '</p><p class="tw-cl r-need')
    : clauses;
  const refs = stop.referenced.filter((id) => (d.nodes[id] || {}).kind !== 'test');
  const referenced = refs.length ? '<div class="tw-refs"><span class="hud-label"' + defAttrs('tour.referenced') + '>' + esc(t('tour.referenced')) + '</span>'
    + refs.slice(0, 12).map((id) => citeChipHtml(id, d.nodes[id], place)).join('') + (refs.length > 12 ? '<span class="tw-more">+' + (refs.length - 12) + '</span>' : '') + '</div>' : '';
  const dots = '<div class="tw-dots" role="group" aria-label="' + esc(t('tour.dots')) + '"' + tipAttrs({ key: 'tour.dots', noFocus: true }) + '>'
    + d.stops.map((s, i) => '<button type="button" class="tw-dot k-' + esc(s.kind) + (i === TOUR.at ? ' on' : '') + '" data-tw="stop" data-i="' + i + '" aria-label="' + esc(fill('tour.stopOf', { n: s.n, m: d.stops.length }) + ' · ' + (b ? s.title.biz : s.title.text)) + '"' + (i === TOUR.at ? ' aria-current="step"' : '') + '></button>').join('') + '</div>';
  const nav = '<div class="tw-nav">'
    + '<button type="button" class="map-tb tw-prev" data-tw="prev"' + (TOUR.at <= 0 ? ' disabled' : '') + tipAttrs({ key: 'tour.prev', noFocus: true }) + '>' + esc(t('tour.prev')) + '</button>'
    + dots
    + '<button type="button" class="map-tb tw-next" data-tw="next"' + (TOUR.at >= d.stops.length - 1 ? ' disabled' : '') + tipAttrs({ key: 'tour.next', noFocus: true }) + '>' + esc(t('tour.next')) + '</button></div>';
  const copy = copyDoorsHtml('tour', { id: d.target.id, ...(d.target.kind === 'storyline' ? { storyline: true } : {}), repo: d.target.repo }, { compact: true });
  // pinned: the stop line and its ‹ PREV · NEXT ›; scrolling: the stop's sentences; pinned at the foot: ASK
  host.innerHTML = '<div class="tw-pin">' + head.replace('<span class="tw-of"></span>', '<span class="tw-of">' + of + kind + '</span>') + nav + '</div>'
    + '<div class="tw-body" tabindex="-1">'
    + '<h3 class="tw-stop-title">' + esc(b ? stop.title.biz : stop.title.text) + '</h3>'
    + '<p class="tw-sub">' + esc(b ? stop.sub.biz : stop.sub.text) + '</p>' + branch
    + '<div class="tw-text">' + body + '</div>'
    + referenced
    + '<p class="tw-derived"' + defAttrs('tour.derived') + '>' + esc(t('tour.derived')) + '</p>'
    + (copy ? '<div class="tw-copy">' + copy + '</div>' : '') + '</div>'
    + ask;
  redrawAsk(host);
}

/** The sentences of a text, split where a sentence ends (a full stop, ? or ! before a space and a capital or digit). */
function sentencesOf(text) {
  const out = [];
  const src = String(text || '');
  const re = /[.!?]+\s+(?=[A-Z0-9(])/g;
  let from = 0, m;
  while ((m = re.exec(src))) { out.push(src.slice(from, m.index + m[0].length)); from = m.index + m[0].length; }
  if (from < src.length) out.push(src.slice(from));
  return out;
}
/**
 * The words somebody wrote for a screen, at most two sentences — a screen's whole description dumped into the walk
 * pushed everything else off the panel (the sweep's 1440 walk) — with *more ›* opening the rest in place.
 */
function wordsHtml(c, o) {
  const b = biz();
  const vars = (b ? c.bizVars : c.vars) || c.vars || {};
  const all = String(vars.words || '');
  const parts = sentencesOf(all);
  if (parts.length <= 2) return clauseHtml(c, o);
  const short = parts.slice(0, 2).join('').trim();
  const cut = { ...c, vars: { ...(c.vars || {}), words: short }, bizVars: c.bizVars ? { ...c.bizVars, words: short } : c.bizVars };
  return '<span class="tw-words short">' + clauseHtml(cut, o) + ' <button type="button" class="tw-more-btn" data-tw="more"' + tipAttrs({ key: 'tour.more', noFocus: true }) + '>' + esc(t('tour.more')) + '</button></span>'
    + '<span class="tw-words long" hidden>' + clauseHtml(c, o) + ' <button type="button" class="tw-more-btn" data-tw="less"' + tipAttrs({ key: 'tour.less', noFocus: true }) + '>' + esc(t('tour.less')) + '</button></span>';
}

function onClick(e) {
  const b = e.target.closest('[data-tw]');
  if (!b) return;
  e.preventDefault();
  const act = b.dataset.tw;
  if (act === 'close') closeWalk();
  else if (act === 'prev') go(TOUR.at - 1);
  else if (act === 'next') go(TOUR.at + 1);
  else if (act === 'stop') go(+b.dataset.i);
  else if (act === 'more' || act === 'less') {
    const p = b.closest('.tw-cl');
    if (p) { p.querySelector('.tw-words.short').hidden = act === 'more'; p.querySelector('.tw-words.long').hidden = act === 'less'; }
  }
}

/** Inside the panel: ← → walk the stops, Esc closes the walk. The box's own typing is its own. */
function onKey(e) {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(TOUR.at + (e.key === 'ArrowRight' ? 1 : -1)); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeWalk(); }
}

/** A door that opens the walk on the Map: a storyline's (`{ storyline }`) or a journey's (`{ flow }`). */
export function walkDoorHtml(o, cls) {
  const href = o.storyline ? '#/map?storyline=' + encodeURIComponent(o.storyline) + '&walk=1' : '#/map/' + encodeURIComponent(o.flow) + '?walk=1';
  return '<a class="rel ' + esc(cls || '') + '" href="' + esc(href) + '"' + defAttrs('tour.open') + '>' + sym('human') + ' ' + esc(t('tour.open')) + '</a>';
}

