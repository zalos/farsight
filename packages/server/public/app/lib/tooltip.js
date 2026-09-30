// lib/tooltip.js — one tip primitive for every number and every detail.
//
// Jared's brief (2026-09-25): "every number or detail should have a hover tool
// tip — simple details of text, or complex details such as tables, links… Show
// on click or hover for more than say 2 seconds." The 2026-09-25 swarm's top
// complaint was the same fact from the other side: a count on screen with no
// scope printed. A tip is where a number says what it counts, what it counts
// over and where it came from, without the line that carries it growing.
//
// **Adopting it from a surface** (the whole recipe — docs/MAP-VIEWER.md#tooltips):
//
//   // a word from the catalog: its words + its define
//   '<span' + tipAttrs({ key: 'journey.countGates' }) + '>' + … + '</span>'
//   // any number: what it counts · the scope · the source · a breakdown · the book
//   '<b' + tipAttrs({ number: { count: n, of: 'journey.countGates', scope: 'journey.scopeAll',
//        source: tipSource('/api/journey'), breakdown: { rows: [['tip.x', 3]] } } }) + '>'
//   // anything richer: a builder, resolved when the tip opens (so it reads live state)
//   registerTip('myThing', (el, args) => tableTip({ … }));  … tipAttrs({ id: 'myThing', args })
//
// Strings passed to the builders that name a catalog key are translated when
// the tip opens, so a tip built before a register flip still speaks the
// register on screen when it is read.
//
// Triggers: a pointer resting on the trigger for TIP_HOVER_MS, a click (opens
// at once and pins), or the keyboard — focus the trigger and press `?`, or
// Enter / Space where the trigger is not itself a button. Esc closes the tip
// before anything else (keymap.js asks `tipKeydown` first). One tip is open at a
// time; it closes on an outside click, a scroll of what holds its trigger, a
// resize, or its trigger leaving the page — unless a redraw put an equivalent
// trigger back, in which case the tip moves onto it (surfaces re-render on
// every `refresh(reason)`).
//
// The layer is portalled to <body> (never clipped by an `overflow:hidden`
// panel) and is never one of focus-trap.js's BEHIND layers, so it works with a
// journey open, inside the inspector, the journey overlay and the ⌘K palette.

import { S, esc, expose, currentLens } from '../store.js';
import { t, def } from '../strings.js';

/** How long the pointer rests on a trigger before its tip opens. One constant,
 *  so it can be tuned — the e2e spec reads it from here rather than hardcoding it. */
export const TIP_HOVER_MS = 2000;
/** With a hover tip already open, the next trigger opens after only this — the
 *  reader has shown they are reading tips. */
export const TIP_WARM_MS = 200;
/** Grace between the pointer leaving a trigger and its tip closing, so the
 *  pointer can travel into a rich tip to click its links. */
export const TIP_LEAVE_MS = 280;

/** What makes an element a trigger. */
export const TIP_SELECTOR = '[data-tip],[data-tip-text],[data-tip-id]';
const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role="button"],[role="tab"],[role="link"],[contenteditable="true"]';
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// ── the pure part: words, builders and placement (node --test covers these) ──

/** A catalog key becomes its words in the active register; anything else is
 *  already words. Numbers print as numbers. */
export function word(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return S.STRINGS && S.STRINGS[s] ? t(s) : s;
}

/** True in the business lens, where a tip carries no code identifier. */
export function isBusiness() {
  try { return currentLens() === 'business'; } catch (err) { return false; }
}

/** Fill `{n}`-style placeholders. */
function fill(s, vars) {
  let out = String(s);
  for (const [k, v] of Object.entries(vars || {})) out = out.split('{' + k + '}').join(String(v));
  return out;
}

/** An href a tip may carry: an internal route, a VS Code deep link, or http(s). */
function safeHref(h) {
  const s = String(h || '');
  return /^(#\/|vscode:\/\/|https?:\/\/)/.test(s) ? s : '';
}

/**
 * The simple tip for one catalog entry: its words, then its define. Words that
 * carry a placeholder (`{n} screens`) are left out — the number beside the
 * trigger is the filled-in form, and the define says what it means.
 */
export function simpleTipHtml(key) {
  const w = word(key);
  const d = def(key);
  const head = w && w !== key && !/\{\w+\}/.test(w) ? '<b class="tip-w">' + esc(w) + '</b>' : '';
  if (!d) return head || esc(w);
  return head + (head ? ' ' : '') + '<span class="tip-d">' + esc(d) + '</span>';
}

/** Where a number came from: `{ api, sync }` — `tipSource('/api/journey')`. */
export function tipSource(api) {
  const meta = (S.GRAPH && S.GRAPH.meta) || {};
  return { api: api || '', sync: meta.sync != null ? meta.sync : null };
}

/** A source in words. The business lens names the sync and never the endpoint. */
export function sourceText(src) {
  if (!src) return '';
  if (typeof src === 'string') return word(src);
  const sync = src.sync != null ? t('tip.sync').replace('{n}', src.sync) : '';
  const parts = [isBusiness() ? '' : (src.api || ''), sync, src.note ? word(src.note) : ''].filter(Boolean);
  return parts.join(' · ');
}

/** One table cell: a word, a number, or `{ text, href, code }`. */
function cellHtml(c, tag) {
  const o = c && typeof c === 'object' ? c : { text: c };
  const txt = esc(word(o.text));
  const href = safeHref(o.href);
  const inner = href ? '<a href="' + esc(href) + '">' + txt + '</a>' : txt;
  const cls = [typeof o.text === 'number' ? 'n' : '', o.code ? 'tip-code' : ''].filter(Boolean).join(' ');
  return '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>' + inner + '</' + tag + '>';
}

/**
 * A table. `columns` (optional) are words or `{ label, code, num }`; `rows` are
 * arrays of cells, or `{ cells, code: true }` for a row the business lens drops.
 * A column marked `code` is dropped from the business lens whole. With no
 * columns the first cell of each row is its heading.
 */
export function tableTip({ columns, rows, caption } = {}) {
  const biz = isBusiness();
  const cols = (columns || []).map((c) => (c && typeof c === 'object' ? c : { label: c }));
  const keep = cols.map((c) => !(biz && c.code));
  const body = (rows || []).map((r) => (Array.isArray(r) ? { cells: r } : r))
    .filter((r) => r && !(biz && r.code))
    .map((r) => {
      const cells = r.cells.filter((_, i) => !cols.length || keep[i]);
      const html = cells.map((c, i) => cellHtml(c, !cols.length && i === 0 && cells.length > 1 ? 'th' : 'td')).join('');
      return '<tr' + (r.code ? ' class="tip-code"' : '') + '>' + html + '</tr>';
    }).join('');
  if (!body) return '';
  const head = cols.length ? '<thead><tr>' + cols.filter((_, i) => keep[i]).map((c) => '<th' + (c.num ? ' class="n"' : '') + '>' + esc(word(c.label)) + '</th>').join('') + '</tr></thead>' : '';
  return (caption ? '<div class="tip-cap">' + esc(word(caption)) + '</div>' : '')
    + '<table class="tip-tbl">' + head + '<tbody>' + body + '</tbody></table>';
}

/** Links: `[{ label, href, code, note }]`. `#/…` routes and `vscode://` links;
 *  a link marked `code` is dropped from the business lens. */
export function linksTip(links) {
  const biz = isBusiness();
  const items = (links || []).filter((l) => l && safeHref(l.href) && !(biz && l.code));
  if (!items.length) return '';
  return '<ul class="tip-links">' + items.map((l) => '<li' + (l.code ? ' class="tip-code"' : '') + '><a href="' + esc(safeHref(l.href)) + '">'
    + esc(word(l.label)) + '</a>' + (l.note ? ' <span class="tip-d">' + esc(word(l.note)) + '</span>' : '') + '</li>').join('') + '</ul>';
}

/** The route that opens the Grammar Book at one entry. */
export function grammarHref(key) { return '#/grammar?key=' + encodeURIComponent(key); }

/** A catalog word as a rich tip: heading, define, and the book's entry. */
export function defTip(key) {
  return '<div class="tip-h">' + esc(word(key)) + '</div>'
    + (def(key) ? '<p class="tip-p">' + esc(def(key)) + '</p>' : '')
    + linksTip([{ label: 'tip.grammar', href: grammarHref(key) }]);
}

/**
 * The standard tip for any number.
 *
 *  - `count` — the number, as printed;
 *  - `of` — the catalog key that prints it (`journey.countScreens`); its words
 *    head the tip with the count filled in, its define says what it counts;
 *  - `vars` — any other placeholders in those words (`{t}`, `{hidden}`);
 *  - `scope` — what it counts over (a key or words) — mandatory by the
 *    invariant *every number names the scope it counts over*;
 *  - `source` — `tipSource('/api/…')` or words;
 *  - `breakdown` — `tableTip` input; its parts should add up to `count`;
 *  - `grammarKey` — the book's entry to link (defaults to `of`).
 */
export function numberTip({ count, of, vars, scope, source, breakdown, grammarKey } = {}) {
  const known = of && S.STRINGS && S.STRINGS[of];
  const oneKey = of && count === 1 && S.STRINGS && S.STRINGS[of + 'One'] ? of + 'One' : of;
  const words = of ? fill(word(oneKey), Object.assign({ n: count }, vars || {})) : '';
  const head = words && /\d/.test(words) ? esc(words)
    : '<b class="tip-n">' + esc(count == null ? '' : String(count)) + '</b>' + (words ? ' ' + esc(words) : '');
  const rows = [
    ['tip.counts', known ? def(of) : ''],
    ['tip.scope', word(scope)],
    ['tip.source', sourceText(source)],
  ].filter((r) => r[1]);
  const book = grammarKey || (known ? of : '');
  return '<div class="tip-h">' + head + '</div>'
    + (rows.length ? '<dl class="tip-dl">' + rows.map((r) => '<dt>' + esc(word(r[0])) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>' : '')
    + (breakdown ? tableTip(Object.assign({ caption: 'tip.breakdown' }, breakdown)) : '')
    + (book ? linksTip([{ label: 'tip.grammar', href: grammarHref(book) }]) : '');
}

/**
 * Where the tip goes: below its trigger, flipped above when below does not
 * fit, kept inside the viewport by `margin`, the arrow pointing at the
 * trigger's centre. A tip taller than both sides takes the roomier one and a
 * `maxHeight` (its body scrolls).
 *
 * `a` — the trigger's rect ({left, top, right, bottom, width, height});
 * `s` — the tip's size ({width, height}); `vp` — the viewport ({width, height}).
 * Returns `{ left, top, side: 'bottom'|'top', arrow, maxHeight }` — `arrow` is
 * the arrow's x offset inside the tip.
 */
export function placeTip(a, s, vp, opts = {}) {
  const gap = opts.gap != null ? opts.gap : 8;
  const margin = opts.margin != null ? opts.margin : 8;
  const below = vp.height - a.bottom - gap - margin;
  const above = a.top - gap - margin;
  let side = opts.prefer === 'top' ? 'top' : 'bottom';
  if (side === 'bottom' && s.height > below && above > below) side = 'top';
  else if (side === 'top' && s.height > above && below > above) side = 'bottom';
  const room = side === 'bottom' ? below : above;
  const h = Math.min(s.height, Math.max(room, 0));
  const maxHeight = s.height > room ? Math.max(room, 0) : null;
  const w = Math.min(s.width, vp.width - 2 * margin);
  const cx = a.left + a.width / 2;
  let left = Math.round(cx - w / 2);
  left = Math.max(margin, Math.min(left, vp.width - margin - w));
  const top = Math.round(side === 'bottom' ? a.bottom + gap : a.top - gap - h);
  const arrow = Math.round(Math.max(12, Math.min(cx - left, w - 12)));
  return { left, top, side, arrow, maxHeight };
}

/**
 * The attributes that make an element a trigger, for surfaces that build HTML
 * as strings. One of:
 *  - `{ key }` — a simple tip from a catalog entry (words + define);
 *  - `{ text }` — a simple tip in words the caller already has;
 *  - `{ number }` — `numberTip(number)`;
 *  - `{ id, args }` — the builder registered as `id`, called with `args`.
 * `tipKey` (optional) names the trigger so a redraw can find it again.
 * Returns a leading-space attribute string, escaped.
 */
export function tipAttrs(o = {}) {
  let a = '';
  if (o.key) a += ' data-tip="' + esc(o.key) + '"';
  else if (o.text) a += ' data-tip-text="' + esc(o.text) + '"';
  else if (o.number) a += ' data-tip-id="number" data-tip-args="' + esc(JSON.stringify(o.number)) + '"';
  else if (o.id) a += ' data-tip-id="' + esc(o.id) + '"' + (o.args != null ? ' data-tip-args="' + esc(JSON.stringify(o.args)) + '"' : '');
  if (o.tipKey) a += ' data-tip-key="' + esc(o.tipKey) + '"';
  if (!o.noFocus) a += ' tabindex="0"';
  return a;
}

/** The same, onto an element that already exists (chrome drawn by hand). */
export function setTip(el, o = {}) {
  if (!el) return;
  ['tip', 'tipText', 'tipId', 'tipArgs', 'tipKey'].forEach((k) => { delete el.dataset[k]; });
  if (o.key) el.dataset.tip = o.key;
  else if (o.text) el.dataset.tipText = o.text;
  else if (o.number) { el.dataset.tipId = 'number'; el.dataset.tipArgs = JSON.stringify(o.number); }
  else if (o.id) { el.dataset.tipId = o.id; if (o.args != null) el.dataset.tipArgs = JSON.stringify(o.args); }
  if (o.tipKey) el.dataset.tipKey = o.tipKey;
  if (!el.matches(FOCUSABLE) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
}

// ── builders ─────────────────────────────────────────────────────────────

const BUILDERS = new Map();

/**
 * Register a rich tip: `builder(el, args)` returns an HTML string (the
 * viewer's idiom — escape what you interpolate) or a DOM Node, or nothing to
 * open no tip. It runs when the tip opens, so it reads live state.
 */
export function registerTip(name, builder) { BUILDERS.set(name, builder); }

registerTip('number', (el, args) => numberTip(args || {}));
registerTip('table', (el, args) => tableTip(args || {}));
registerTip('links', (el, args) => linksTip(args || []));
registerTip('def', (el, args) => defTip((args && args.key) || el.dataset.tipDef || ''));

/** What a trigger's tip holds: `{ rich, content }`, or null for none. */
export function tipContentFor(el) {
  if (!el || !el.dataset) return null;
  const d = el.dataset;
  if (d.tipId) {
    const fn = BUILDERS.get(d.tipId);
    if (!fn) return null;
    let args = null;
    try { args = d.tipArgs ? JSON.parse(d.tipArgs) : null; } catch (err) { args = null; }
    const content = fn(el, args);
    return content ? { rich: true, content } : null;
  }
  if (d.tip) return { rich: false, content: simpleTipHtml(d.tip) };
  if (d.tipText) return { rich: false, content: esc(d.tipText) };
  return null;
}

// ── the DOM layer ────────────────────────────────────────────────────────

let layer = null;
/** The open tip: its trigger, its kind, whether a click pinned it, how it opened. */
const st = { el: null, rich: false, pinned: false, via: '', sig: '', describedBy: null };
let hoverTimer = 0, leaveTimer = 0, pendingEl = null;
const lastPt = { x: -1, y: -1 };

/** A trigger's identity, so a redraw's copy of it can be found again. */
function sigOf(el) {
  const d = el.dataset || {};
  return [el.id || '', d.tipKey || '', d.tip || '', d.tipText || '', d.tipId || '', d.tipKey ? '' : (d.tipArgs || '')].join('|');
}
function isInteractive(el) { return !!(el && el.closest && el.closest(INTERACTIVE)); }
function visible(el) { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && !el.closest('[inert]'); }
function focusablesIn(el) { return [...el.querySelectorAll(FOCUSABLE)].filter((n) => visible(n)); }

function ensureLayer() {
  if (layer && document.body.contains(layer)) return layer;
  layer = document.createElement('div');
  layer.id = 'fs-tip';
  layer.className = 'fs-tip';
  layer.hidden = true;
  document.body.appendChild(layer);
  return layer;
}

/** True while a tip is open (the Escape ladder asks). */
export function tipOpen() { return !!st.el && !!layer && !layer.hidden; }
/** The open tip's trigger, or null. */
export function tipAnchor() { return tipOpen() ? st.el : null; }

function position() {
  if (!st.el || !layer) return;
  const body = layer.querySelector('.tip-body');
  if (body) body.style.maxHeight = '';
  layer.style.left = '0px'; layer.style.top = '0px';
  const r = st.el.getBoundingClientRect();
  const s = { width: layer.offsetWidth, height: layer.offsetHeight };
  const p = placeTip(r, s, { width: window.innerWidth, height: window.innerHeight });
  if (p.maxHeight != null && body) body.style.maxHeight = Math.max(60, p.maxHeight - 20) + 'px';
  layer.style.left = p.left + 'px';
  layer.style.top = (p.side === 'top' ? r.top - 8 - layer.offsetHeight : p.top) + 'px';
  layer.dataset.side = p.side;
  layer.style.setProperty('--tip-arrow', p.arrow + 'px');
}

function fillLayer(content, rich, label) {
  layer.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'tip-body';
  if (typeof content === 'string') body.innerHTML = content;
  else if (content && content.nodeType) body.appendChild(content);
  const arrow = document.createElement('span');
  arrow.className = 'tip-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  layer.appendChild(arrow);
  if (rich) {
    const x = document.createElement('button');
    x.className = 'tip-x';
    x.type = 'button';
    x.setAttribute('aria-label', t('tip.close'));
    x.textContent = '✕';
    layer.appendChild(x);
  }
  layer.appendChild(body);
  if (rich) {
    layer.setAttribute('role', 'dialog');
    const h = body.querySelector('.tip-h,.tip-cap');
    layer.setAttribute('aria-label', label || (h && h.textContent.trim()) || t('tip.label'));
  } else {
    layer.setAttribute('role', 'tooltip');
    layer.removeAttribute('aria-label');
  }
}

/**
 * Open a tip on `el` with `content` — an HTML string or a Node. For dynamic
 * cases a declarative trigger cannot express. `opts.rich` (default true) makes
 * it an interactive dialog with a close button; `opts.pinned` keeps it open
 * until Esc, the close button or an outside click; `opts.label` names it.
 */
export function showTip(el, content, opts = {}) {
  if (!el || content == null || content === '') return;
  ensureLayer();
  clearTimeout(leaveTimer); clearTimeout(hoverTimer);
  if (st.el && st.el !== el) hideTip();
  const rich = opts.rich !== false;
  if (st.el === el && st.describedBy !== null) restoreDescribedBy();
  st.el = el; st.rich = rich; st.pinned = !!opts.pinned; st.via = opts.via || 'api'; st.sig = sigOf(el);
  fillLayer(content, rich, opts.label);
  layer.className = 'fs-tip ' + (rich ? 'rich' : 'simple') + (st.pinned ? ' pinned' : '');
  if (!rich) {
    st.describedBy = el.getAttribute('aria-describedby') || '';
    el.setAttribute('aria-describedby', ((st.describedBy ? st.describedBy + ' ' : '') + 'fs-tip').trim());
  }
  el.classList.add('tip-on');
  el.classList.remove('tip-pending');
  layer.hidden = false;
  position();
}

function restoreDescribedBy() {
  if (!st.el) return;
  if (st.describedBy) st.el.setAttribute('aria-describedby', st.describedBy);
  else st.el.removeAttribute('aria-describedby');
  st.describedBy = null;
}

/** Close the open tip. `{ focusTrigger: true }` puts the focus back on its trigger. */
export function hideTip(opts = {}) {
  clearTimeout(leaveTimer);
  const el = st.el;
  if (el) { restoreDescribedBy(); el.classList.remove('tip-on'); }
  st.el = null; st.pinned = false; st.via = ''; st.sig = '';
  if (layer) { layer.hidden = true; layer.innerHTML = ''; }
  if (opts.focusTrigger && el && el.isConnected) { try { el.focus({ preventScroll: true }); } catch (err) { /* nothing to focus */ } }
}

/** Open the tip a trigger declares. Returns true when one opened. */
function openFor(el, opts = {}) {
  const c = tipContentFor(el);
  if (!c) return false;
  showTip(el, c.content, { rich: c.rich, pinned: opts.pinned, via: opts.via });
  return true;
}

function scheduleLeave() {
  clearTimeout(leaveTimer);
  if (st.pinned) return;
  leaveTimer = setTimeout(() => { if (!st.pinned) hideTip(); }, TIP_LEAVE_MS);
}

function cancelPending() {
  clearTimeout(hoverTimer);
  if (pendingEl) pendingEl.classList.remove('tip-pending');
  pendingEl = null;
}

function onPointerOver(e) {
  lastPt.x = e.clientX; lastPt.y = e.clientY;
  if (layer && layer.contains(e.target)) { clearTimeout(leaveTimer); return; }
  const trg = e.target.closest && e.target.closest(TIP_SELECTOR);
  if (!trg) return;
  if (trg === st.el) { clearTimeout(leaveTimer); return; }
  if (trg === pendingEl) return;
  if (e.pointerType === 'touch') return;
  // a trigger that has opened its own menu has a better thing on screen
  if (trg.getAttribute('aria-expanded') === 'true') return;
  cancelPending();
  // a pinned tip is the reader's choice; resting on another trigger does not take it away
  if (st.el && st.pinned) return;
  pendingEl = trg;
  trg.classList.add('tip-pending');
  const warm = st.el && !st.pinned;
  hoverTimer = setTimeout(() => {
    let el = pendingEl;
    cancelPending();
    // the trigger may have been redrawn while the pointer rested on it
    if (el && !el.isConnected) {
      const under = document.elementFromPoint(lastPt.x, lastPt.y);
      const again = under && under.closest && under.closest(TIP_SELECTOR);
      el = again && sigOf(again) === sigOf(el) ? again : null;
    }
    if (el && el.getAttribute('aria-expanded') !== 'true') openFor(el, { via: 'hover' });
  }, warm ? TIP_WARM_MS : TIP_HOVER_MS);
}

function onPointerOut(e) {
  const to = e.relatedTarget;
  if (pendingEl && pendingEl.contains(e.target) && !(to && pendingEl.contains(to))) cancelPending();
  if (!st.el || st.pinned) return;
  const inTip = (n) => !!(n && layer && layer.contains(n));
  const inTrg = (n) => !!(n && st.el.contains(n));
  if ((inTrg(e.target) || inTip(e.target)) && !inTrg(to) && !inTip(to)) {
    // a simple tip is not interactive: leaving its trigger closes it straight away
    if (!st.rich) hideTip(); else scheduleLeave();
  }
}

function onClick(e) {
  const tgt = e.target;
  if (layer && layer.contains(tgt)) {
    if (tgt.closest('.tip-x')) { hideTip({ focusTrigger: true }); return; }
    if (tgt.closest('a[href]')) setTimeout(() => hideTip(), 0);
    else if (st.el) { st.pinned = true; layer.classList.add('pinned'); }
    return;
  }
  const trg = tgt.closest && tgt.closest(TIP_SELECTOR);
  if (trg && !isInteractive(trg)) {
    cancelPending();
    if (st.el === trg && st.pinned) hideTip();
    else openFor(trg, { pinned: true, via: 'click' });
    return;
  }
  if (st.el) hideTip();
}

function onScroll(e) {
  if (!st.el) return;
  const tgt = e.target;
  if (layer && (tgt === layer || (tgt.nodeType === 1 && layer.contains(tgt)))) return;
  if (tgt === document || tgt === document.documentElement || (tgt.contains && tgt.contains(st.el))) hideTip();
}

function onFocusIn(e) {
  if (!st.el || st.via !== 'key') return;
  const tgt = e.target;
  if ((layer && layer.contains(tgt)) || st.el === tgt || st.el.contains(tgt)) return;
  hideTip();
}

/**
 * The tip's keys, asked **first** by keymap.js's one listener: Esc closes a
 * tip before anything else closes; `?` (and Enter / Space on a trigger that is
 * not a button) opens the focused trigger's tip; Tab walks from a trigger into
 * its rich tip's links and back out. Returns true when it handled the key.
 */
export function tipKeydown(e) {
  if (e.key === 'Escape' && tipOpen()) {
    const inTip = layer.contains(document.activeElement);
    e.preventDefault();
    hideTip({ focusTrigger: inTip || st.via === 'key' });
    return true;
  }
  const a = document.activeElement;
  if (a && a.matches && a.matches(TIP_SELECTOR) && !(layer && layer.contains(a))) {
    const enter = (e.key === 'Enter' || e.key === ' ') && !isInteractive(a);
    if (e.key === '?' || enter) {
      e.preventDefault();
      if (st.el === a) hideTip();
      else openFor(a, { pinned: true, via: 'key' });
      return true;
    }
  }
  if (e.key === 'Tab' && tipOpen() && st.rich) {
    const f = focusablesIn(layer).filter((n) => !n.classList.contains('tip-x'));
    const x = layer.querySelector('.tip-x');
    const stops = x ? [...f, x] : f;
    if (!e.shiftKey && a === st.el && stops.length) { e.preventDefault(); stops[0].focus(); return true; }
    if (layer.contains(a)) {
      const i = stops.indexOf(a);
      if (e.shiftKey && i <= 0) { e.preventDefault(); st.el.focus(); return true; }
      if (!e.shiftKey && i === stops.length - 1) {
        // leave through the trigger: focus it and let the browser take the next stop after it
        const el = st.el; hideTip(); el.focus({ preventScroll: true });
        return true;
      }
    }
  }
  return false;
}

/** Give every non-focusable trigger a tab stop, so the keyboard reaches its tip. */
function stopTriggers(root) {
  (root || document).querySelectorAll(TIP_SELECTOR).forEach((n) => {
    if (!n.hasAttribute('tabindex') && !n.matches(FOCUSABLE)) n.setAttribute('tabindex', '0');
  });
}

let raf = 0;
/** After any redraw: tab stops for new triggers, and the open tip follows its trigger. */
function onMutate() {
  raf = 0;
  stopTriggers();
  if (!st.el || st.el.isConnected) return;
  const sig = st.sig, old = st.el;
  let again = null;
  if (old.id) {
    const byId = document.getElementById(old.id);
    if (byId && byId.matches(TIP_SELECTOR) && (byId.dataset.tipId || '') === (old.dataset.tipId || '')) again = byId;
  }
  if (!again) again = [...document.querySelectorAll(TIP_SELECTOR)].find((n) => sigOf(n) === sig && visible(n)) || null;
  if (!again) { hideTip(); return; }
  const keep = { pinned: st.pinned, via: st.via };
  st.el = null; st.describedBy = null;
  if (!openFor(again, keep)) hideTip();
}

let started = false;
/** Wire the tip layer once (the shell's boot calls it). */
export function initTips() {
  if (started) return;
  started = true;
  ensureLayer();
  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('resize', () => { if (st.el) hideTip(); });
  stopTriggers();
  new MutationObserver((list) => {
    if (list.every((m) => layer && layer.contains(m.target))) return;
    if (!raf) raf = requestAnimationFrame(onMutate);
  }).observe(document.body, { childList: true, subtree: true });
}

expose({ showTip, hideTip });
