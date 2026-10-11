// lib/lifecycle-strip.js — a record's status lifecycle as one strip, and the table of what each one means
// (swarm-fixes round 2026-10-05 finding 7; round 2026-10-10 §3 — one state machine, two views of it).
//
// The journey header and the Map property's Overview both draw it from `/api/journey`'s `lifecycles`
// (core `journeyLifecycles` + `lifecycleViews`): the statuses in declared order in the words of the
// persona the journey is for — business prints the word (the constant is in the tip), hybrid the word
// and the constant, code the constant — the counts the core computed, and a *what each one means*
// fold: one table of the word · the constant · what moves a record into it, the writer a door to the
// journey screen it runs from, then the overlays (conditions a person sees that are not a status).
// The folds are pure and tested (`lib/lifecycle-model.js`); the drawing goes through the catalog,
// `sym()` and route-url.js like every other detail.

import { S, esc, expose, currentLens, bizLabel, humanize } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';
import { countedHtml, defAttrs, plainTip } from './counted.js';
import { lifecycleStripModel, pickView, stripItems, stripCounts, tableRows, placedView } from './lifecycle-model.js';
import { mapStopHash } from './route-url.js';

export { lifecyclesFor, headerLifecycles, screenLifecycles } from './lifecycle-model.js';

/** The table for one view; `flow` is the journey the reader has open (its screens are *here*). */
function tableHtml(view, lens) {
  const persona = view && view.persona ? view.persona.name : '';
  // the writer's own part on the Map: the action that holds it, on the screen it is on
  const doorOf = (m) => mapStopHash(m.at.flowId, { screen: m.at.screen, part: m.by });
  const rows = tableRows(view, doorOf);
  const mover = (m) => {
    const label = lens === 'code' ? m.name : lens === 'hybrid' ? m.words + ' · ' + m.name : m.words;
    const place = m.at
      ? '<span class="lc-at">' + esc(t('lifecycle.table.on').replace('{journey}', m.at.flowName).replace('{n}', String(m.at.screen))) + '</span>'
      : '<span class="lc-at"' + defAttrs('lifecycle.table.offJourney') + '>' + esc(t('lifecycle.table.offJourney')) + '</span>';
    const name = m.door
      ? '<a class="lc-door" href="' + esc(m.door) + '"' + tipAttrs({ text: t('lifecycle.table.on').replace('{journey}', m.at.flowName).replace('{n}', String(m.at.screen)) + (m.at.screenName ? ' · ' + m.at.screenName : '') }) + '>' + esc(label) + '</a>'
      : '<span class="lc-door none">' + esc(label) + '</span>';
    // where the record comes from, as the code checks it (swarm round 3: the lifecycle never said *from*)
    const word = (s) => {
      const r = view && (view.rows || []).find((x) => x.status === s);
      return lens === 'code' || !r ? s : r.word;
    };
    const from = m.from && m.from.length
      ? ' <span class="lc-from"' + defAttrs('lifecycle.table.from') + '>' + esc(t('lifecycle.table.from').replace('{from}', m.from.map(word).join(t('lifecycle.table.fromOr')))) + '</span>' : '';
    return '<div class="lc-mover">' + name + from + ' ' + place + '</div>';
  };
  const body = rows.map((r) => {
    const word = '<td class="lc-tw' + (r.kind === 'status' && !r.declared ? ' undecl' : '') + '"'
      + (r.kind === 'status' ? tipAttrs({ text: t(r.declared ? 'lifecycle.word.declared' : 'lifecycle.word.undeclared').replace('{status}', r.code) }) : defAttrs('lifecycle.overlay.word'))
      + '>' + (r.kind === 'overlay' ? sym('fork', 'lc-ov') + ' ' : '') + esc(r.word) + '</td>';
    const code = r.kind === 'overlay'
      ? '<td class="lc-tc ov"' + defAttrs('lifecycle.overlay.code') + '>' + esc(t('lifecycle.overlay.code').replace('{when}', r.when))
        + (lens === 'business' ? '' : ' <span class="lc-tbl">' + esc(t('lifecycle.overlay.table').replace('{table}', r.code)) + '</span>') + '</td>'
      : '<td class="lc-tc"><code>' + esc(r.code) + '</code></td>';
    const moves = r.movers.length
      ? '<td class="lc-tm">' + r.movers.map(mover).join('') + '</td>'
      : '<td class="lc-tm nothing"' + defAttrs('lifecycle.table.nothing') + '>' + esc(t('lifecycle.table.nothing')) + '</td>';
    return '<tr class="lc-row ' + r.kind + (r.written ? '' : ' unwritten') + '" data-kind="' + r.kind + '">' + word + code + moves + '</tr>';
  }).join('');
  const head = persona
    ? '<th' + defAttrs('lifecycle.table.persona') + '>' + esc(t('lifecycle.table.persona').replace('{persona}', persona)) + '</th>'
    : '<th' + defAttrs('lifecycle.table.personaNone') + '>' + esc(t('lifecycle.table.personaNone')) + '</th>';
  const footKey = view && view.declared ? (lens === 'business' ? 'lifecycle.footer.namedBiz' : 'lifecycle.footer.named') : 'lifecycle.footer.plain';
  return '<table class="api-table lc-table"><thead><tr>' + head
    + '<th' + defAttrs('lifecycle.table.code') + '>' + esc(t('lifecycle.table.code')) + '</th>'
    + '<th' + defAttrs('lifecycle.table.moves') + '>' + esc(t('lifecycle.table.moves')) + '</th></tr></thead><tbody>' + body + '</tbody></table>'
    + '<p class="lc-foot"' + defAttrs(footKey) + '>' + esc(t(footKey)) + '</p>';
}

/** Strips drawn on the page, by their id: the view each draws, so the toggle can draw its table. */
const DRAWN = new Map();
let seq = 0;

/**
 * Open or close one strip's table. On first open it asks `/api/lifecycle` to place every writer on the
 * journey screen it runs from (this journey first); until it answers, the journey's own placements show.
 */
function lcToggle(btn) {
  const id = btn && btn.getAttribute('data-lc');
  const st = DRAWN.get(id);
  const box = document.getElementById(id + '-tbl');
  if (!st || !box) return;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  box.hidden = !open;
  if (!open) return;
  box.innerHTML = tableHtml(st.view, currentLens());
  if (st.asked) return;
  st.asked = true;
  const q = 'node=' + encodeURIComponent(st.nodeId) + (st.flow ? '&flow=' + encodeURIComponent(st.flow) : '');
  fetch('/api/lifecycle?' + q).then((r) => (r.ok ? r.json() : null)).then((answer) => {
    if (!answer) return;
    st.view = placedView(st.view, answer);
    const b = document.getElementById(id + '-tbl');
    if (b && !b.hidden) b.innerHTML = tableHtml(st.view, currentLens());
  }).catch(() => {});
}
expose({ lcToggle });

/**
 * Draw one strip's table into `box` — the Map's dock, where the journey head's *what each one means* opens (cleanup
 * pass 2026-10-11): the same table, the writers placed on their journey screens once `/api/lifecycle` answers.
 */
export function lifecycleTableInto(id, box) {
  const st = DRAWN.get(id);
  if (!st || !box) return;
  box.innerHTML = tableHtml(st.view, currentLens());
  const fill = () => { if (box.isConnected) box.innerHTML = tableHtml(st.view, currentLens()); };
  if (st.asked) return;
  st.asked = true;
  const q = 'node=' + encodeURIComponent(st.nodeId) + (st.flow ? '&flow=' + encodeURIComponent(st.flow) : '');
  fetch('/api/lifecycle?' + q).then((r) => (r.ok ? r.json() : null)).then((answer) => {
    if (!answer) return;
    st.view = placedView(st.view, answer);
    fill();
  }).catch(() => {});
}

/**
 * The strip for one record: *status lifecycle · Invoices* — the counts — the statuses in the persona's
 * words (a status no code moves to is dashed and says so) — the *what each one means* toggle and its
 * table (closed).
 * @param {object} lc   one entry of `/api/journey`'s `lifecycles`
 * @param {string} api  where the counts came from, for their tips
 * @param {{flow?: string, compact?: boolean}} [opts]  the journey the strip sits in, so its screens are placed first;
 *   `compact` draws *what each one means* as a glyph (one line, the Map's journey head)
 */
export function lifecycleStripHtml(lc, api, opts = {}) {
  const m = lifecycleStripModel(lc);
  if (!m) return '';
  const lens = currentLens();
  const view = pickView(lc);
  const node = (S.BYID || {})[m.nodeId];
  const where = m.provenance.map((p) => (p.name ? p.name + ' · ' : '') + p.path + ':' + p.line).join(' · ');
  const rec = lens === 'business'
    ? '<span class="lc-rec">' + esc(t('lifecycle.biz.ofRecord').replace('{name}', node ? bizLabel(node) : humanize(m.name))) + '</span>'
    : '<span class="lc-rec"' + (where ? tipAttrs({ text: t('lifecycle.declaredBy').replace('{where}', where) }) : '') + '>'
      + esc(t('lifecycle.ofRecord').replace('{name}', m.name).replace('{field}', m.field)) + '</span>';
  const items = view ? stripItems(view, lens) : m.statuses.map((x, i) => ({ status: x.s, word: x.s, declared: false, written: x.written, sep: i ? '·' : '', main: x.s, constant: '' }));
  const statuses = items.map((x) => {
    const tipKey = x.declared ? 'lifecycle.word.declared' : 'lifecycle.word.undeclared';
    const tip = lens === 'code' ? '' : tipAttrs({ text: t(tipKey).replace('{status}', x.status) + (x.written ? '' : ' · ' + t('lifecycle.unmovedYet')) });
    return (x.sep ? '<span class="lc-sep" aria-hidden="true">' + esc(x.sep) + '</span>' : '')
      + '<span class="lc-status' + (x.written ? '' : ' unwritten') + (lens === 'code' ? '' : ' words') + '" role="listitem" data-status="' + esc(x.status) + '"'
      + (lens === 'code' && !x.written ? defAttrs('lifecycle.unwritten') : tip) + '>'
      + '<span class="lc-w">' + esc(x.main) + '</span>'
      + (x.constant ? ' <code class="lc-c">' + esc(x.constant) + '</code>' : '')
      + (!x.written && lens !== 'code' ? '<span class="lc-yet">' + esc(t('lifecycle.unmovedYet')) + '</span>' : '')
      + '</span>';
  }).join('');
  const counts = stripCounts(lc, view, lens).map((x) => countedHtml(x, api, { cls: 'lc-n' })).filter(Boolean).join(' · ');
  const id = 'lc-' + (++seq);
  if (view) DRAWN.set(id, { view, nodeId: m.nodeId, flow: opts.flow || '', asked: false });
  // a strip redrawn on every render: keep only the recent ones (the page holds a handful)
  if (DRAWN.size > 64) DRAWN.delete(DRAWN.keys().next().value);
  return '<div class="lc-strip" data-record="' + esc(m.nodeId) + '">'
    + '<div class="lc-head"><span class="lc-word"' + defAttrs('lifecycle.word') + '>' + esc(t('lifecycle.word')) + '</span> '
    + rec + ' <span class="lc-counts">' + counts + '</span></div>'
    + '<div class="lc-statuses" role="list" aria-label="' + esc(t('lifecycle.word')) + '">' + statuses + '</div>'
    + (view ? '<button type="button" class="lc-toggle' + (opts.compact ? ' lc-glyph' : '') + '" data-lc="' + id + '" aria-expanded="false" aria-controls="' + id + '-tbl" onclick="event.stopPropagation();lcToggle(this)"'
      // one line (the Map's journey head): the toggle is a small glyph, its words its name and its tip
      + (opts.compact ? ' aria-label="' + esc(t('lifecycle.toggle')) + '"' : '')
      + defAttrs('lifecycle.toggle') + '>' + (opts.compact ? sym('legend') : esc(t('lifecycle.toggle')) + ' <span class="lc-chev" aria-hidden="true">▾</span>') + '</button>' : '')
    + (view ? '<div class="lc-tblbox" id="' + id + '-tbl" hidden></div>' : '')
    + '</div>';
}

/**
 * A strip drawn on one line (the journey head) folds its last statuses into one `+n` whose tip lists them, by
 * measurement — never cut off at the edge with nothing to say so (round-3 swarm: at 1280 the invoice's strip stopped at
 * *Compiled →*, and *Scheduled*, *Paid*, *Denied* and *Cancelled* were gone with no mark). Safe to call again: it
 * unfolds first. The first status never folds.
 * @param {Element} root  the element holding one or more strips
 */
export function foldLifecycleStrips(root) {
  if (!root) return;
  for (const box of root.querySelectorAll('.lc-statuses')) {
    const strip = box.closest('.lc-strip');
    if (strip) strip.classList.remove('lc-tight');
    foldOne(box);
    // a line with no room even for its first status gives up its counts (they are in the table and its tip) first
    if (strip && box.scrollWidth > box.clientWidth + 1) { strip.classList.add('lc-tight'); foldOne(box); }
  }
}
/** Fold one line's statuses, the last first, until it fits (the first never folds). */
function foldOne(box) {
  box.querySelectorAll(':scope > [data-fold-more]').forEach((x) => x.remove());
  const kids = [...box.children];
  kids.forEach((k) => { if (k.dataset.folded) { k.hidden = false; delete k.dataset.folded; } });
  const over = () => box.scrollWidth > box.clientWidth + 1;
  if (!box.clientWidth || !over()) return;
  const statuses = kids.filter((k) => k.classList.contains('lc-status'));
  const hidden = [];
  for (let i = statuses.length - 1; i > 0; i--) {
    const st = statuses[i];
    st.hidden = true; st.dataset.folded = '1';
    const sep = st.previousElementSibling;
    if (sep && sep.classList.contains('lc-sep')) { sep.hidden = true; sep.dataset.folded = '1'; }
    hidden.unshift(st);
    box.querySelectorAll(':scope > [data-fold-more]').forEach((x) => x.remove());
    const rows = hidden.map((h) => [h.querySelector('.lc-w') ? h.querySelector('.lc-w').textContent.trim() : h.textContent.trim(), 1]);
    box.insertAdjacentHTML('beforeend', '<span class="lc-sep" aria-hidden="true" data-fold-more="1">·</span><span class="lc-foldmore fold-more" data-fold-more="1"'
      + plainTip(hidden.length, 'fold.statusesOf', 'fold.scopeLifecycle', '/api/journey', rows).replace(' tabindex="0"', '') + '>'
      + esc(t('fold.more').replace('{n}', String(hidden.length))) + '</span>');
    if (!over()) break;
  }
}
