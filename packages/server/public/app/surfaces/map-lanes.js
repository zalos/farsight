// surfaces/map-lanes.js — the storyline as swimlanes on the Map (round 2026-10-10 §2): the drawing of one
// `laneLayout()` answer (lib/map-lanes-model.js) placed by `laneGeometry()`.
//
// The Map owns the board, the canvas, the chrome, the link and the keys; this module only turns the model into the
// world's lanes layer: the board's header, a panel per lane and segment with the lane's head, a card per stage, a pill
// per move, the arrows between them, the lifecycle strip under the lanes (lib/lifecycle-strip.js — called, never
// copied), the legend and the footer. Every number is a `Counted` the model typed, printed with its tip; every word
// comes from the catalog; the business register prints words only — a status in words, a record in words, the code
// that writes it only in the tip.

import { esc, humanize, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, countWords } from '../lib/counted.js';
import { tipAttrs } from '../lib/tooltip.js';
import { mapTestsChips } from '../lib/map-chips.js';
import { lifecycleStripHtml } from '../lib/lifecycle-strip.js';
import { LANE_K } from '../lib/map-lanes-model.js';
import { storeShownName } from '../lib/map-model.js';

const biz = () => currentLens() === 'business';
const fill = (key, vars) => Object.entries(vars || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));
const API = '/api/journey';

/** A status as the register prints it: the code's constant in hybrid and code, words in business. */
function statusWords(s) { return biz() ? humanize(String(s || '')) : String(s || ''); }
/** A record's name: the table's name in hybrid and code, words in business. */
function recordWords(n) { return biz() ? humanize(String(n || '')) : String(n || ''); }

/** A note the model set aside, in words. */
export function laneNoteText(n) {
  const vars = { ...(n.vars || {}) };
  if (n.why) vars.why = fill(n.why.key, n.why.vars);
  return fill(n.key, vars);
}

/** One stage card: its place, name, sub-line, one status chip, the street's test chip, and a decision the code holds. */
function stageHtml(st, r, m, say) {
  const step = st.branch
    ? '<span class="map-step branch"' + tipAttrs({ text: fill('lanes.stage.branch', { when: st.branch.when }) + ' · ' + st.journeyName, noFocus: true }) + '>' + sym('fork') + '</span>'
    : '<span class="map-step"' + tipAttrs({ text: fill(biz() ? 'map.storyline.bizStep' : 'map.storyline.step', { n: st.step, m: m.stepsOf }) + ' · ' + st.journeyName, noFocus: true }) + '>' + st.step + '</span>';
  const status = st.state === 'planned'
    ? '<span class="map-chip k-warn"' + tipAttrs({ key: 'map.screen.planned', noFocus: true }) + '>' + sym('warning') + esc(t('map.screen.planned')) + '</span>'
    : '<span class="map-chip k-ok"' + tipAttrs({ key: 'lanes.stage.built', noFocus: true }) + '>' + esc(t('lanes.stage.built')) + '</span>';
  // the street's own test chip for this screen: the count with its scope and the one evidence word (lane V's chip)
  const tests = st.tests ? mapTestsChips(st.tests, st.evidence, { hideZero: biz() }) : '';
  const dec = st.decisions.length
    ? '<div class="dec"' + tipAttrs({ text: t('lanes.decision') + ' · ' + st.decisions.map(say).join(' · '), noFocus: true }) + '>' + sym('decision')
      + '<span class="w">' + esc(say(st.decisions[0])) + '</span>' + (st.decisions.length > 1 ? '<span class="more">' + esc(fill('lanes.decision.more', { n: st.decisions.length - 1 })) + '</span>' : '') + '</div>'
    : '';
  const label = t('lanes.stage.open') + ' · ' + st.name + ' · ' + st.journeyName;
  return '<div class="ln-stage' + (st.state === 'planned' ? ' planned' : '') + (st.branch ? ' branch' : '') + '" role="button" tabindex="0"'
    + ' data-key="' + esc(st.key) + '" data-flow="' + esc(st.flowId) + '" data-index="' + st.screenIndex + '" data-name="' + esc(st.name) + '"'
    + ' aria-label="' + esc(label) + '" style="left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px">'
    + '<div class="ttl">' + step + '<span class="nm"' + tipAttrs({ text: st.name + (st.words ? ' · ' + say(st.words) : ''), noFocus: true }) + '>' + esc(st.name) + '</span></div>'
    + (st.sub ? '<div class="sub">' + esc(say(st.sub)) + '</div>' : '')
    + '<div class="ln-chips">' + status + tests + '</div>' + dec + '</div>';
}

/** One pill: the record (first in its row), the move in words, and — outside business — the code that makes it. */
function pillHtml(p, r, m) {
  const st = (k) => m.stages.find((s) => s.key === k);
  const makers = p.stages.map(st).filter(Boolean).map((s) => s.name);
  const move = p.kind === 'created' ? fill('lanes.pill.created', { status: statusWords(p.status) })
    : p.kind === 'move' ? fill('lanes.pill.move', { status: statusWords(p.status) }) : t('lanes.pill.written');
  const by = p.writers.length ? fill('lanes.pill.by', { name: p.writers.join(', ') }) : '';
  const tip = recordWords(p.record.name) + ' · ' + move + (by ? ' · ' + by : '') + (makers.length ? ' · ' + fill('lanes.pill.from', { names: makers.join(', ') }) : '');
  return '<div class="ln-pill ' + p.kind + '" data-key="' + esc(p.key) + '" data-record="' + esc(p.record.id) + '"' + (p.status != null ? ' data-status="' + esc(p.status) + '"' : '')
    + ' style="left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px"' + tipAttrs({ text: tip, noFocus: true }) + '>'
    + '<div class="mv">' + sym('record') + (p.first && !p.isStore ? '<span class="rec">' + esc(recordWords(p.record.name)) + '</span><span class="sep">·</span>' : '') + '<span class="w">' + esc(move) + '</span></div>'
    + (by && !biz() ? '<div class="by map-code">' + esc(by) + '</div>' : '') + '</div>';
}

const storeKindOf = (l) => (['sql', 'document', 'files', 'erp'].includes(l.store.kind) ? l.store.kind : 'other');

/** The lane's head: its word, its second line, what it is, and its count with the scope it counts over. */
function laneHeadHtml(l) {
  const glyph = l.kind === 'store' ? sym('record') : sym('human');
  const sub = l.kind === 'store'
    ? fill('lanes.store.sub', { kind: t('map.store.kind.' + storeKindOf(l)) })
    : l.description;
  const word = l.kind === 'store' ? (l.declaredName || storeShownName(l.store, biz()) || t('map.store.kind.' + storeKindOf(l))) : l.name || t('lanes.persona.none');
  return '<div class="ln-head"><div class="nm">' + glyph + '<span>' + esc(word) + '</span></div>'
    + (l.surface ? '<div class="surf">' + esc(l.surface) + '</div>' : '')
    + (sub ? '<div class="d">' + esc(sub) + '</div>' : '')
    + '<div class="n">' + countedHtml(l.count, API, { cls: 'ln-n' }) + ' <span class="sc">· ' + esc(t(l.count.scope)) + '</span></div>' + moreHtml(l) + '</div>';
}

/** The folded records of a store lane: one line in its head that names them in its tip. */
function moreHtml(l) {
  if (!l.folded || !l.folded.length) return '';
  return '<div class="more"' + tipAttrs({ text: l.folded.map((r) => recordWords(r.name)).join(' · '), noFocus: true }) + '>' + esc(fill('lanes.pill.more', { n: l.folded.length })) + '</div>';
}

const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
function head(x, y, dir) {
  // a small open arrowhead pointing `dir` ('down' | 'up' | 'right')
  if (dir === 'down') return 'M' + (x - 5) + ' ' + (y - 7) + ' L' + x + ' ' + y + ' L' + (x + 5) + ' ' + (y - 7);
  if (dir === 'up') return 'M' + (x - 5) + ' ' + (y + 7) + ' L' + x + ' ' + y + ' L' + (x + 5) + ' ' + (y + 7);
  return 'M' + (x - 7) + ' ' + (y - 5) + ' L' + x + ' ' + y + ' L' + (x - 7) + ' ' + (y + 5);
}

/** The arrows: moves (solid, record colour), seen (dashed, back up), then (inside a lane), branch (amber, dashed). */
function arrowsSvg(m, G, labels) {
  const R = G.rects;
  let out = '';
  // spread the arrows leaving one card so two moves from one screen are two lines
  const leaving = new Map();
  for (const a of m.arrows) {
    const f = R.get(a.from), to = R.get(a.to);
    if (!f || !to || f.segment !== to.segment) continue;
    if (a.kind === 'moves') {
      const n = leaving.get(a.from) || 0;
      leaving.set(a.from, n + 1);
      const x1 = f.x + f.w / 2 + (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 10;
      const x2 = to.x + to.w / 2;
      const y1 = f.y + f.h, y2 = to.y;
      const yb = y2 - 8;
      out += '<g class="ln-a moves' + (a.declared ? ' declared' : '') + '" data-from="' + esc(a.from) + '" data-to="' + esc(a.to) + '"><path class="ln" d="M' + x1 + ' ' + y1 + ' L' + x1 + ' ' + yb + ' L' + x2 + ' ' + yb + ' L' + x2 + ' ' + y2 + '"/><path class="hd" d="' + head(x2, y2, 'down') + '"/></g>';
      if (a.label) labels.push({ x: Math.min(x1, x2) + 6, y: yb - 18, text: a.label, cls: 'moves' });
    } else if (a.kind === 'seen') {
      const x1 = f.x + f.w * 0.75, y1 = f.y;
      const x2 = to.x + to.w * 0.75, y2 = to.y + to.h;
      const ya = y1 - 8;
      out += '<g class="ln-a seen" data-from="' + esc(a.from) + '" data-to="' + esc(a.to) + '"><path class="ln" d="M' + x1 + ' ' + y1 + ' L' + x1 + ' ' + ya + ' L' + x2 + ' ' + ya + ' L' + x2 + ' ' + y2 + '"/><path class="hd" d="' + head(x2, y2, 'up') + '"/></g>';
      labels.push({ x: Math.min(x1, x2) + 6, y: ya - 18, text: a.label || fill('lanes.arrow.seen', { status: statusWords(a.status) }), cls: 'seen' });
    } else if (a.kind === 'then') {
      const a1 = mid(f), b1 = mid(to);
      const x1 = f.x + f.w, x2 = to.x;
      if (x2 <= x1) continue;
      out += '<g class="ln-a then"><path class="ln" d="M' + x1 + ' ' + a1.y + ' L' + x2 + ' ' + b1.y + '"/><path class="hd" d="' + head(x2, b1.y, 'right') + '"/></g>';
    } else if (a.kind === 'branch') {
      const x1 = f.x + f.w * 0.62, y1 = f.y + f.h;
      const b1 = mid(to);
      const x2 = to.x;
      out += '<g class="ln-a branch"><path class="ln" d="M' + x1 + ' ' + y1 + ' L' + x1 + ' ' + b1.y + ' L' + x2 + ' ' + b1.y + '"/><path class="hd" d="' + head(x2, b1.y, 'right') + '"/></g>';
      // the condition sits left of the line, in the branch's lane under the step it leaves (that column is the branch's own)
      if (a.label) labels.push({ x: f.x + 4, y: to.y + 4, text: t('journeys.storyline.when').replace('{when}', a.label), cls: 'branch', max: Math.max(60, x1 - f.x - 12) });
    }
  }
  return out;
}

/** The legend: one row per mark the board draws. */
function legendHtml(m) {
  const row = (cls, key) => '<div class="lg"><span class="sw ' + cls + '"></span><span' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</span></div>';
  const has = (k) => m.arrows.some((a) => a.kind === k);
  return '<div class="ln-legend"><div class="hud-label"' + tipAttrs({ key: 'lanes.legend.title', noFocus: true }) + '>' + esc(t('lanes.legend.title')) + '</div>'
    + row('moves', 'lanes.legend.moves')
    + (has('seen') ? row('seen', 'lanes.legend.seen') : '')
    + (m.stages.some((s) => s.state === 'planned') ? row('planned', 'lanes.legend.notBuilt') : '')
    + (has('branch') ? row('branch', 'lanes.legend.branch') : '')
    + (m.needs ? row('needs', 'lanes.legend.needs') : '')
    + '</div>';
}

/** The footer: what the board holds, each a count with its scope, and what the lanes were built from. */
function footerHtml(m) {
  const c = m.counts;
  const parts = [
    countedHtml(c.journeys, '/api/journeys', { cls: 'ln-n' }),
    countedHtml(c.screens, API, { cls: 'ln-n' }),
    countedHtml(c.built, API, { cls: 'ln-n' }),
    countedHtml(c.branches, '/api/journeys', { cls: 'ln-n' }),
  ].filter(Boolean);
  const reading = m.ready ? '' : '<span class="rd"' + tipAttrs({ key: 'lanes.footer.reading', noFocus: true }) + '>' + esc(fill('lanes.footer.reading', { n: m.read, m: m.of })) + '</span>';
  const notes = m.notes.length
    ? '<span class="nt"' + tipAttrs({ text: t('lanes.notes').split('{n}').join(String(m.notes.length)) + ' · ' + m.notes.map(laneNoteText).join(' · '), noFocus: true }) + '>' + esc(countWords('lanes.notes', m.notes.length)) + '</span>'
    : '';
  return '<div class="ln-foot">' + parts.join('<span class="sep">·</span>') + '<span class="sep">·</span>'
    + '<span class="from"' + tipAttrs({ key: 'lanes.footer.from', noFocus: true }) + '>' + esc(t('lanes.footer.from')) + '</span>' + reading + notes + '</div>';
}

/**
 * The lifecycle under the lanes — the record whose moves the lanes draw first (the most moves), its strip as the
 * journey prints it, with the moves this storyline makes marked as made here.
 */
function lifeHtml(m) {
  const made = new Set(m.pills.flatMap((p) => p.moves.map((x) => p.record.id + '|' + x.by + '|' + p.status)));
  return m.lifecycles.slice(0, 1).map((lc) => {
    const here = lc.lifecycle.transitions.map((tr) => made.has(lc.nodeId + '|' + tr.by + '|' + tr.to));
    return '<div class="ln-life">' + lifecycleStripHtml({ ...lc, onJourney: here }, API) + '</div>';
  }).join('');
}

/**
 * The lanes layer's HTML and its size in world units. `m` is a `laneLayout()` answer, `G` its `laneGeometry()`;
 * `ctx.evidenceHtml` the storyline's evidence count (the chain board's own), `ctx.lanesCount` its lane count.
 * @group Map
 */
export function lanesHtml(m, G, ctx = {}) {
  const labels = [];
  let html = '';
  // the board's header: the storyline, the LANES tag, how many lanes, the evidence of its journeys, its sentence
  const nLanes = { n: m.lanes.length, unit: 'lanes.count.lanes', bizUnit: 'lanes.count.lanes', scope: 'count.scope.storyline', source: 'laneLayout → lanes',
    breakdown: [{ key: 'lanes.part.personaLanes', n: m.lanes.filter((l) => l.kind === 'persona').length }, { key: 'lanes.part.storeLanes', n: m.lanes.filter((l) => l.kind === 'store').length }] };
  html += '<div class="ln-top" style="left:' + G.geom.margin + 'px;top:' + (G.geom.margin / 2) + 'px;width:' + (G.size.w - G.geom.margin * 2) + 'px">'
    + '<span class="nm">' + esc(m.storyline.name) + '</span>'
    + '<span class="tag"' + tipAttrs({ key: 'lanes.tag', noFocus: true }) + '>' + esc(t('lanes.tag')) + '</span>'
    + countedHtml(nLanes, '/api/journeys', { cls: 'ln-n' })
    + (ctx.evidenceHtml ? '<span class="ev">' + ctx.evidenceHtml + '</span>' : '')
    + (m.storyline.description ? '<span class="d">' + esc(ctx.sentence ? ctx.sentence(m.storyline.description) : m.storyline.description) + '</span>' : '')
    + '</div>';
  // the lane panels, each segment's lanes again with their heads
  for (const lr of G.laneRects) {
    const l = m.lanes.find((x) => x.id === lr.lane);
    if (!l) continue;
    html += '<div class="ln-lane ' + l.kind + '" data-lane="' + esc(l.id) + '" data-segment="' + lr.segment + '" style="left:' + lr.x + 'px;top:' + lr.y + 'px;width:' + lr.w + 'px;height:' + lr.h + 'px">'
      + '<div class="ln-headbox" style="width:' + G.geom.head + 'px">' + laneHeadHtml(l) + '</div></div>';
  }
  html += '<svg class="ln-arrows" aria-hidden="true" width="' + G.size.w + '" height="' + G.size.h + '">' + arrowsSvg(m, G, labels) + '</svg>';
  const say = ctx.sentence || ((x) => x);
  for (const st of m.stages) { const r = G.rects.get(st.key); if (r) html += stageHtml(st, r, m, say); }
  for (const p of m.pills) { const r = G.rects.get(p.key); const l = m.lanes.find((x) => x.id === p.lane); if (r) html += pillHtml({ ...p, isStore: !!(l && l.name === p.record.name) }, r, m); }
  for (const lb of labels) {
    html += '<div class="ln-label ' + lb.cls + '" style="left:' + lb.x + 'px;top:' + lb.y + 'px' + (lb.max ? ';max-width:' + lb.max + 'px' : '') + '">' + esc(lb.text) + '</div>';
  }
  // under the lanes: the lifecycle strips, the legend beside them, the footer
  html += '<div class="ln-bottom" style="left:' + G.geom.margin + 'px;top:' + (G.lanesBottom + 12) + 'px;width:' + (G.size.w - G.geom.margin * 2) + 'px">'
    + '<div class="ln-lifes">' + lifeHtml(m) + footerHtml(m) + '</div>' + legendHtml(m) + '</div>';
  return html;
}

/** How many world units a board px is: the lanes layer is scaled by it (the stylesheet's sizes read at the fit). */
export const LANES_SCALE = LANE_K;
