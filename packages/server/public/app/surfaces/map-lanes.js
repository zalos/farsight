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
import { countedHtml, countWords, countedTipArgs } from '../lib/counted.js';
import { tipAttrs } from '../lib/tooltip.js';
import { mapTestsChips } from '../lib/map-chips.js';
import { lifecycleStripHtml } from '../lib/lifecycle-strip.js';
import { pickView } from '../lib/lifecycle-model.js';
import { LANE_K } from '../lib/map-lanes-model.js';
import { storeShownName } from '../lib/map-model.js';
import { offPlatformStageHtml, partyLaneHeadHtml } from '../lib/parties.js';

const biz = () => currentLens() === 'business';
const fill = (key, vars) => Object.entries(vars || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));
const API = '/api/journey';

/** The persona's word for each status of each record the lanes draw (the strip's own view), by record id. */
let VIEWS = new Map();
/**
 * A status as the register prints it — the word the strip under the lanes prints for it (the persona's, from the
 * config's views, else the constant humanized) in business, the code's constant in hybrid and code.
 */
function statusWords(s, recordId) {
  if (!biz()) return String(s || '');
  const v = recordId ? VIEWS.get(recordId) : null;
  const row = v && (v.rows || []).find((r) => r.status === s);
  return row && row.word ? row.word : humanize(String(s || ''));
}
/** A record's name: the table's name in hybrid and code, words in business. */
function recordWords(n) { return biz() ? humanize(String(n || '')) : String(n || ''); }

/** A note the model set aside, in words. */
export function laneNoteText(n) {
  const vars = { ...(n.vars || {}) };
  if (n.why) vars.why = fill(n.why.key, n.why.vars);
  return fill(n.key, vars);
}

/**
 * One stage card at the street's density (cleanup pass 2026-10-11, lane S — the owner's *"the steps text is too large"*):
 * its place, its name on one line with the status chip beside it, its sub-line, the street's test chip (the count with
 * its scope on one row, the one verdict on the next, never folded), and a decision the code holds.
 */
function stageHtml(st, r, m, say) {
  // one journey's lanes: every stage is step 1 of 1 of its storyline, so the badge says the screen's place instead
  const nScreens = m.single ? m.stages.filter((x) => !x.branch).length : 0;
  const step = st.branch
    ? '<span class="map-step branch"' + tipAttrs({ text: fill('lanes.stage.branch', { when: st.branch.when }) + ' · ' + st.journeyName, noFocus: true }) + '>' + sym('fork') + '</span>'
    : m.single
      ? '<span class="map-step"' + tipAttrs({ text: fill('map.crumb.screen', { n: st.screenIndex + 1, m: nScreens }) + ' · ' + st.journeyName, noFocus: true }) + '>' + (st.screenIndex + 1) + '</span>'
      : '<span class="map-step"' + tipAttrs({ text: fill(biz() ? 'map.storyline.bizStep' : 'map.storyline.step', { n: st.step, m: m.stepsOf }) + ' · ' + st.journeyName, noFocus: true }) + '>' + st.step + '</span>';
  // the street's own test chip for this screen: the count with its scope and the one evidence word (lane V's chip);
  // for a screen with no code it is the not-built chip, which then is the card's one status word too. Only the runs
  // that are not *passed* ride beside the word (the count's tip has them all).
  const tests = st.tests ? mapTestsChips(st.tests, st.evidence, { hideZero: biz(), runs: false }) : '';
  const says = tests.includes('data-not-built');
  const status = st.state === 'planned'
    ? (says ? '' : '<span class="map-chip k-warn"' + tipAttrs({ key: 'map.screen.planned', noFocus: true }) + '>' + sym('warning') + esc(t('map.screen.planned')) + '</span>')
    : '<span class="map-chip k-ok"' + tipAttrs({ key: 'lanes.stage.built', noFocus: true }) + '>' + esc(t('lanes.stage.built')) + '</span>';
  const dec = st.decisions.length
    ? '<div class="dec"' + tipAttrs({ text: t('lanes.decision') + ' · ' + st.decisions.map(say).join(' · '), noFocus: true }) + '>' + sym('decision')
      + '<span class="w">' + esc(say(st.decisions[0])) + '</span>' + (st.decisions.length > 1 ? '<span class="more">' + esc(fill('lanes.decision.more', { n: st.decisions.length - 1 })) + '</span>' : '') + '</div>'
    : '';
  const label = t('lanes.stage.open') + ' · ' + st.name + ' · ' + st.journeyName;
  return '<div class="ln-stage' + (st.state === 'planned' ? ' planned' : '') + (st.branch ? ' branch' : '') + '" role="button" tabindex="0"'
    + ' data-key="' + esc(st.key) + '" data-flow="' + esc(st.flowId) + '" data-index="' + st.screenIndex + '" data-name="' + esc(st.name) + '"'
    + ' data-lane="' + esc(st.lane) + '" data-persona-from="' + esc(st.personaFrom || 'journey') + '"'
    + ' aria-label="' + esc(label) + '" style="left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px">'
    + '<div class="ttl">' + step + '<span class="nm"' + tipAttrs({ text: [st.name, st.sub ? say(st.sub) : '', st.words ? say(st.words) : '', st.personaFrom && st.personaFrom !== 'journey' ? t('journeys.personaFrom.' + st.personaFrom) : ''].filter((x, i, a) => x && a.indexOf(x) === i).join(' · '), noFocus: true }) + '>' + esc(st.name) + '</span>' + status + '</div>'
    + (st.sub && st.sub !== st.name ? '<div class="sub"' + tipAttrs({ text: say(st.sub), noFocus: true }) + '>' + esc(say(st.sub)) + '</div>' : '')
    + '<div class="ln-chips">' + tests + '</div>' + dec + '</div>';
}

/**
 * One pill: the record and its move on one line (the record first in its row), the code that makes it small beneath
 * (outside business), and what the move needs as a chip — each whole, wrapping at words, never an ellipsis.
 */
function pillHtml(p, r, m, say) {
  const st = (k) => m.stages.find((s) => s.key === k);
  const makers = p.stages.map(st).filter(Boolean).map((s) => s.name);
  const move = p.kind === 'created' ? fill('lanes.pill.created', { status: statusWords(p.status, p.record.id) })
    : p.kind === 'move' ? fill('lanes.pill.move', { status: statusWords(p.status, p.record.id) }) : t('lanes.pill.written');
  const by = p.writers.length ? fill('lanes.pill.by', { name: p.writers.join(', ') }) : '';
  // the action that makes the move most directly is named; the other live actions fold; a switched-off one is said so
  const also = p.also && p.also.length ? ' · ' + fill('lifecycle.alsoReached', { n: p.also.length }) : '';
  const off = (p.switchedOff || []).map((o) => ' · ' + (biz() ? fill('lifecycle.biz.switchedOffMover', { action: say(o.label) }) : fill('lifecycle.switchedOffMover', { action: o.label, flag: o.flag, value: o.value }))).join('');
  const tip = recordWords(p.record.name) + ' · ' + move + (p.action ? ' · ' + say(p.action) : '') + (by ? ' · ' + by : '') + (makers.length ? ' · ' + fill('lanes.pill.from', { names: makers.join(', ') }) : '') + also + off;
  const rec = p.first && !p.isStore;
  const code = by && !biz() ? '<span class="by map-code">' + codeBreaks(fill('lanes.pill.by', { name: p.writers[0] })) + (p.writers.length > 1 ? ' <span class="more">' + esc(fill('fold.more', { n: p.writers.length - 1 })) + '</span>' : '') + '</span>' : '';
  const needs = needsHtml(p, say);
  return '<div class="ln-pill ' + p.kind + '" data-key="' + esc(p.key) + '" data-record="' + esc(p.record.id) + '"' + (p.status != null ? ' data-status="' + esc(p.status) + '"' : '')
    + ' style="left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px"' + tipAttrs({ text: tip, noFocus: true }) + '>'
    + '<div class="mv">' + sym('record') + '<span class="w">' + (rec ? '<span class="rec">' + esc(recordWords(p.record.name)) + '</span><span class="sep"> · </span>' : '') + esc(move) + '</span></div>'
    + (code || needs ? '<div class="by-row">' + code + needs + '</div>' : '') + '</div>';
}

/** A code name with a break chance after each dot and between the words of a camelCase name — never inside a word. */
function codeBreaks(text) {
  return esc(text).split('.').join('.<wbr>').replace(/([a-z0-9])([A-Z])/g, '$1<wbr>$2');
}

const storeKindOf = (l) => (['sql', 'document', 'files', 'erp'].includes(l.store.kind) ? l.store.kind : 'other');

/**
 * What a move needs (lane G's preconditions on the action that makes it), as one line in its pill: the count with its
 * scope (the action), and — in amber — *not checked by the code* when the move never compares the status it leaves.
 * The tip is the whole box: who may · the record must be · policy, each with its evidence word; + n technical checks.
 */
function needsHtml(p, say) {
  const n = p.needs;
  if (!n) return '';
  const ev = (x) => (x.evidence && x.evidence.word ? t(biz() && x.evidence.word.biz ? x.evidence.word.biz : x.evidence.word.key) : '');
  const line = (x) => {
    const w = x.role ? t('pre.role').replace('{role}', x.role) : say(x.words);
    return w + (ev(x) ? ' (' + ev(x) + ')' : '') + (!biz() && x.loc ? ' · ' + x.loc : '');
  };
  const items = n.shown.map(line);
  if (n.technical) items.push(countWords('gate.group.technical', n.technical));
  const nc = n.notChecked && n.notChecked.status
    ? t('pre.notChecked').replace('{record}', recordWords(n.notChecked.record)).replace('{status}', statusWords(n.notChecked.status, p.record.id))
    : '';
  const action = biz() ? '' : n.action.split('::').pop();
  const tip = t('handoff.needs').replace('{action}', action || t('lanes.pill.thisMove')).replace('{list}', items.join(' · ')) + (nc ? ' · ' + nc : '');
  // *needs N* lists the N (gap log S2): the number's tip is the count with its scope, then one row per precondition —
  // its words, its tier, its evidence — so the column adds up to N; business folds the technical ones into one row
  let num = '';
  if (n.counted) {
    const args = countedTipArgs(n.counted, API);
    const all = n.all || [];
    const tierWord = (x) => t('gate.tier.' + x.tier);
    const rows = biz()
      ? n.shown.map((x) => [line(x), 1]).concat(n.technical ? [[countWords('gate.group.technical', n.technical), n.technical]] : [])
      : all.map((x) => [line(x) + ' · ' + tierWord(x), 1]);
    if (rows.length) args.breakdown = { rows };
    num = '<span class="ln-n"' + tipAttrs({ number: args }) + '>' + esc(fill('lanes.pill.needs', { n: n.counted.n })) + '</span>';
  } else num = '<span>' + esc(fill('lanes.pill.needs', { n: n.shown.length + n.technical })) + '</span>';
  return '<span class="nd map-chip"' + tipAttrs({ text: tip, noFocus: true }) + '>' + sym('gate')
    + num
    + (nc ? '<span class="nc">' + sym('warning') + esc(t('lanes.pill.uncheckedShort')) + '</span>' : '') + '</span>';
}

/** The lane's head: its word and its count on one line, its second line clamped to one, what it folded. */
function laneHeadHtml(l, single) {
  const glyph = l.kind === 'store' ? sym('record') : sym('human');
  const sub = l.kind === 'store'
    ? fill(single ? 'lanes.store.subJourney' : 'lanes.store.sub', { kind: t('map.store.kind.' + storeKindOf(l)) })
    : l.description;
  const word = l.kind === 'store' ? (l.declaredName || storeShownName(l.store, biz()) || t('map.store.kind.' + storeKindOf(l))) : l.name || t('lanes.persona.none');
  return '<div class="ln-head"><div class="ln-hrow"><div class="nm">' + glyph + '<span class="w">' + esc(word) + '</span></div>'
    + '<span class="n">' + countedHtml(l.count, API, { cls: 'ln-n' }) + ' <span class="sc">· ' + esc(t(l.count.scope)) + '</span></span></div>'
    + (l.surface ? '<div class="surf">' + esc(l.surface) + '</div>' : '')
    + (sub ? '<div class="d"' + tipAttrs({ text: sub, noFocus: true }) + '>' + esc(sub) + '</div>' : '')
    + moreHtml(l) + '</div>';
}

/**
 * A persona lane with no screen in this row of the lanes says why, beside its head, instead of looking empty (round-3
 * swarm: the operator lane read as empty in the first row, though the operator verifies and approves — their screens
 * were in the next row). It names the rows that hold them.
 */
function emptyHtml(l, lr, m, G) {
  if (l.kind !== 'persona') return '';
  const rows = new Set();
  for (const st of m.stages) {
    if (st.lane !== l.id) continue;
    const r = G.rects.get(st.key);
    if (r) rows.add(r.segment);
  }
  if (rows.has(lr.segment)) return '';
  const words = rows.size
    ? fill('lanes.empty.elsewhere', { rows: [...rows].sort((a, b) => a - b).map((x) => x + 1).join(', ') })
    : t('lanes.empty.none');
  return '<div class="ln-empty" style="left:' + (G.geom.head + 12) + 'px"' + tipAttrs({ key: rows.size ? 'lanes.empty.elsewhere' : 'lanes.empty.none', noFocus: true }) + '>' + esc(words) + '</div>';
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
      labels.push({ x: Math.min(x1, x2) + 6, y: ya - 18, text: a.label || fill('lanes.arrow.seen', { status: statusWords(a.status, (m.pills.find((p) => p.key === a.from) || { record: {} }).record.id) }), cls: 'seen' });
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

/** The legend: one flat row of the marks the board draws, beside the footer's counts — never a stacked box. */
function legendHtml(m) {
  const row = (cls, key) => '<span class="lg"><span class="sw ' + cls + '"></span><span' + tipAttrs({ key, noFocus: true }) + '>' + esc(t(key)) + '</span></span>';
  const has = (k) => m.arrows.some((a) => a.kind === k);
  return '<div class="ln-legend"><span class="hud-label"' + tipAttrs({ key: 'lanes.legend.title', noFocus: true }) + '>' + esc(t('lanes.legend.title')) + '</span>'
    + row('moves', 'lanes.legend.moves')
    + (has('seen') ? row('seen', 'lanes.legend.seen') : '')
    + (m.stages.some((s) => s.state === 'planned') ? row('planned', 'lanes.legend.notBuilt') : '')
    + (has('branch') ? row('branch', 'lanes.legend.branch') : '')
    + (m.stages.some((s) => s.off) ? row('off', 'lanes.legend.offPlatform') : '')
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
    c.offPlatform ? countedHtml(c.offPlatform, API, { cls: 'ln-n' }) : '',
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
  // one journey's lanes sit under the journey's head, which already prints the record's strip: never twice
  if (m.single) return '';
  const made = new Set(m.pills.flatMap((p) => p.moves.map((x) => p.record.id + '|' + x.by + '|' + p.status)));
  return m.lifecycles.slice(0, 1).map((lc) => {
    const here = lc.lifecycle.transitions.map((tr) => made.has(lc.nodeId + '|' + tr.by + '|' + tr.to));
    return '<div class="ln-life">' + lifecycleStripHtml({ ...lc, onJourney: here }, API, { flow: m.firstFlow || '', compact: true }) + '</div>';
  }).join('');
}

/**
 * The lanes layer's HTML and its size in world units. `m` is a `laneLayout()` answer, `G` its `laneGeometry()`;
 * `ctx.evidenceHtml` the storyline's evidence count (the chain board's own), `ctx.lanesCount` its lane count.
 * @group Map
 */
export function lanesHtml(m, G, ctx = {}) {
  VIEWS = new Map(m.lifecycles.map((lc) => [lc.nodeId, pickView(lc)]));
  const labels = [];
  let html = '';
  // the board's header: the storyline, the LANES tag, how many lanes, the evidence of its journeys, its sentence
  const nLanes = { n: m.lanes.length, unit: 'lanes.count.lanes', bizUnit: 'lanes.count.lanes', scope: m.single ? 'journey.scopeAll' : 'count.scope.storyline', source: 'laneLayout → lanes',
    breakdown: [{ key: 'lanes.part.personaLanes', n: m.lanes.filter((l) => l.kind === 'persona').length },
      ...(m.lanes.some((l) => l.kind === 'party') ? [{ key: 'lanes.part.partyLanes', n: m.lanes.filter((l) => l.kind === 'party').length }] : []),
      { key: 'lanes.part.storeLanes', n: m.lanes.filter((l) => l.kind === 'store').length }] };
  html += '<div class="ln-top" style="left:' + G.geom.margin + 'px;top:' + (G.geom.margin / 2) + 'px;width:' + (G.size.w - G.geom.margin * 2) + 'px">'
    + '<span class="nm">' + esc(m.storyline.name) + '</span>'
    + '<span class="tag"' + tipAttrs({ key: 'lanes.tag', noFocus: true }) + '>' + esc(t('lanes.tag')) + '</span>'
    + countedHtml(nLanes, '/api/journeys', { cls: 'ln-n' })
    + (ctx.evidenceHtml ? '<span class="ev">' + ctx.evidenceHtml + '</span>' : '')
    // the storyline band's own doors (the release readiness brief) ride on the lanes' header too
    + (ctx.doorHtml || '')
    + (m.storyline.description ? '<span class="d">' + esc(ctx.sentence ? ctx.sentence(m.storyline.description) : m.storyline.description) + '</span>' : '')
    + '</div>';
  // the lane panels, each segment's lanes again with their heads
  for (const lr of G.laneRects) {
    const l = m.lanes.find((x) => x.id === lr.lane);
    if (!l) continue;
    html += '<div class="ln-lane ' + l.kind + '" data-lane="' + esc(l.id) + '" data-segment="' + lr.segment + '" style="left:' + lr.x + 'px;top:' + lr.y + 'px;width:' + lr.w + 'px;height:' + lr.h + 'px">'
      + '<div class="ln-headbox" style="width:' + G.geom.head + 'px">' + (l.kind === 'party' ? partyLaneHeadHtml(l) : laneHeadHtml(l, m.single)) + '</div>' + emptyHtml(l, lr, m, G) + '</div>';
  }
  html += '<svg class="ln-arrows" aria-hidden="true" width="' + G.size.w + '" height="' + G.size.h + '">' + arrowsSvg(m, G, labels) + '</svg>';
  const say = ctx.sentence || ((x) => x);
  for (const st of m.stages) { const r = G.rects.get(st.key); if (r) html += st.off ? offPlatformStageHtml(st, r) : stageHtml(st, r, m, say); }
  for (const p of m.pills) { const r = G.rects.get(p.key); const l = m.lanes.find((x) => x.id === p.lane); if (r) html += pillHtml({ ...p, isStore: !!(l && l.name === p.record.name) }, r, m, say); }
  for (const lb of labels) {
    html += '<div class="ln-label ' + lb.cls + '" style="left:' + lb.x + 'px;top:' + lb.y + 'px' + (lb.max ? ';max-width:' + lb.max + 'px' : '') + '">' + esc(lb.text) + '</div>';
  }
  // under the lanes: the lifecycle strips, the legend beside them, the footer
  // under the lanes: the record's lifecycle on one line (only where no journey head prints it), then the footer's
  // counts and the legend on one row
  html += '<div class="ln-bottom" style="left:' + G.geom.margin + 'px;top:' + (G.lanesBottom + 8) + 'px;width:' + (G.size.w - G.geom.margin * 2) + 'px">'
    + lifeHtml(m) + '<div class="ln-footrow">' + footerHtml(m) + legendHtml(m) + '</div></div>';
  return html;
}

/**
 * After the lanes are drawn: a screen name whose longest word is wider than its card steps its type down (never under
 * 11 px) rather than break inside the word, and the pills' own height is measured — returns how many board px the
 * tallest pill needs past the geometry's, so the caller lays the lanes out again with room for it (0 when it fits).
 * Measured in layout px (offset sizes), so the scale the layer is drawn at does not change the answer.
 * @group Map
 */
export function fitLaneText(el) {
  if (!el) return 0;
  const ctx = document.createElement('canvas').getContext('2d');
  for (const nm of el.querySelectorAll('.ln-stage .nm')) {
    nm.style.fontSize = '';
    const words = nm.textContent.split(/\s+/).filter(Boolean);
    const cs = getComputedStyle(nm);
    let size = parseFloat(cs.fontSize) || 16;
    const upper = cs.textTransform === 'uppercase';
    const widest = () => {
      ctx.font = cs.fontWeight + ' ' + size + 'px ' + cs.fontFamily;
      const ls = (parseFloat(cs.letterSpacing) || 0) * (size / (parseFloat(cs.fontSize) || size));
      return Math.max(0, ...words.map((w) => ctx.measureText(upper ? w.toUpperCase() : w).width + ls * w.length));
    };
    const room = nm.clientWidth;
    while (room > 0 && size > 11 && widest() > room) size -= 0.5;
    if (size !== parseFloat(cs.fontSize)) nm.style.fontSize = size + 'px';
  }
  let need = 0;
  for (const p of el.querySelectorAll('.ln-pill')) need = Math.max(need, p.scrollHeight - p.clientHeight);
  return need > 1 ? Math.ceil(need) : 0;
}

/** How many world units a board px is: the lanes layer is scaled by it (the stylesheet's sizes read at the fit). */
export const LANES_SCALE = LANE_K;
