// lib/lifecycle-strip.js — a record's status lifecycle as one strip (swarm-fixes round 2026-10-05, finding 7).
//
// The journey header and the Map property's Overview both draw it from `/api/journey`'s
// `lifecycles` (core `journeyLifecycles`): the statuses in declared order, each move some code
// makes as an arrow chip that is a door to its writer, the statuses no code moves to marked, and
// the three `Counted`s the core computed. `lifecycleStripModel` is pure (tested); the drawing
// goes through the catalog, `sym()` and the doors table like every other detail.

import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { tipAttrs } from './tooltip.js';
import { countedHtml, defAttrs } from './counted.js';
import { doorsFor } from './detail-doors.js';
import { lifecycleStripModel } from './lifecycle-model.js';

export { lifecyclesFor } from './lifecycle-model.js';

function moveWords(m) {
  return m.from != null
    ? t('lifecycle.move').replace('{from}', m.from).replace('{to}', m.to)
    : t('lifecycle.moveInto').replace('{to}', m.to);
}

/** One move: the arrow chip, its writer's name, and the writer's doors (editor, code map) — none in business. */
function moveHtml(m) {
  const node = (S.BYID || {})[m.by];
  const doors = node ? doorsFor('function', node) : [];
  const href = doors.length ? doors[0].href : '';
  const tip = moveWords(m) + ' · ' + t('lifecycle.by').replace('{name}', m.byName) + ' · ' + t('lifecycle.via.' + m.via);
  const body = '<span class="lc-arrow">' + esc(moveWords(m)) + '</span>'
    + (currentLens() === 'business' ? '' : ' <span class="lc-by">' + esc(t('lifecycle.by').replace('{name}', m.byName)) + '</span>');
  const cls = 'lc-move' + (m.here ? ' here' : '');
  return href
    ? '<a class="' + cls + '" href="' + esc(href) + '"' + (doors[0].external ? ' target="_blank" rel="noopener noreferrer"' : '') + tipAttrs({ text: tip }) + ' onclick="event.stopPropagation()">' + body + '</a>'
    : '<span class="' + cls + '"' + tipAttrs({ text: tip }) + '>' + body + '</span>';
}

/**
 * The strip for one record: *status lifecycle · invoices · status* — the counts — the statuses in
 * order (a status no code moves to is dashed and says so) — the moves.
 * @param {object} lc   one entry of `/api/journey`'s `lifecycles`
 * @param {string} api  where the counts came from, for their tips
 */
export function lifecycleStripHtml(lc, api) {
  const m = lifecycleStripModel(lc);
  if (!m) return '';
  const c = lc.counts || {};
  const statuses = m.statuses.map((x) => '<span class="lc-status' + (x.written ? '' : ' unwritten') + '"'
    + (x.written ? '' : defAttrs('lifecycle.unwritten')) + '>' + esc(x.s) + '</span>').join('<span class="lc-sep" aria-hidden="true">·</span>');
  const where = m.provenance.map((p) => (p.name ? p.name + ' · ' : '') + p.path + ':' + p.line).join(' · ');
  return '<div class="lc-strip" data-record="' + esc(m.nodeId) + '">'
    + '<div class="lc-head"><span class="lc-word"' + defAttrs('lifecycle.word') + '>' + esc(t('lifecycle.word')) + '</span> '
    + '<span class="lc-rec"' + (where && currentLens() !== 'business' ? tipAttrs({ text: t('lifecycle.declaredBy').replace('{where}', where) }) : '') + '>'
    + esc(t('lifecycle.ofRecord').replace('{name}', m.name).replace('{field}', m.field)) + '</span>'
    + ' <span class="lc-counts">' + [c.statuses, c.transitions, c.unwritten].map((x) => countedHtml(x, api, { cls: 'lc-n' })).filter(Boolean).join(' · ') + '</span></div>'
    + '<div class="lc-statuses" role="list" aria-label="' + esc(t('lifecycle.word')) + '">' + statuses + '</div>'
    + (m.moves.length ? '<div class="lc-moves">' + m.moves.map(moveHtml).join('') + '</div>' : '')
    + '</div>';
}
