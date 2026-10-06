// surfaces/map-property.js — the map's property view (docs/proposals/map-view.md §1,
// §3, §3.2): one screen of a journey up close. The picture of the screen is the
// hero and owns most of the stage; a rail beside it carries eight tabs (Overview ·
// Gates · APIs · UX · Tests · Route · Work · Changes) with typed counts on them;
// a step bar below walks the journey — the screen before, where you are, the
// screen after, and the other journeys this screen is part of.
//
// Lane A's surface (surfaces/map.js) owns the stage, the keys ([ ] Esc) and the
// zoom-out gesture, and calls this module through one hook:
//
//   mountMapProperty(host, ctx) → { update(ctx), destroy() }
//   ctx = { data, model, screenIndex, flow, lens, onClose(), onStep(delta), onOpenScreen(index) }
//
// It renders from the `data` it is handed (the /api/journey answer) and never
// writes `S.JOURNEY`, which belongs to the journey overlay. The facts come from
// lib/map-property-model.js; every number is a core `Counted` with its tip, and
// a tab whose subject nothing types prints no number. The business lens prints
// words a person wrote or `humanize()` — never a route, a method, a file or an id.

import { S, esc, currentLens, bizName, repoOf, humanize } from '../store.js';
import { t, plainWords, evidenceWord } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, countedUnit, countedAttrs, defAttrs, plainTip, unCode } from '../lib/counted.js';
import { mapEvidenceChip } from '../lib/map-chips.js';
import { tipAttrs } from '../lib/tooltip.js';
import { designThumbHtml, linkHtml } from '../lib/graph-render.js';
import { storyChipsHtml, screenStoryIds } from '../stories.js';
import { workSourcesConfigured, flowWork, stateHtml, sourceName } from '../work-chips.js';
import {
  jrnGateLabel, jrnGateText, jrnGatesShown, jrnAbsentHtml, jrnWords, jrnRefAnchors,
  jrnFoldFacts, jrnEvChipHtml, jrnObsText, jrnRunLineHtml, jrnFootScopeHtml, jrnContractHtml,
} from './journeys.js';
import { doorsFor, doorsHtml, leadDoorHtml, codeSlotHtml, fillCode, storylineLineHtml } from '../lib/detail-doors.js';
import { journeyStepHash } from '../lib/route-url.js';
import { lifecycleStripHtml, lifecyclesFor } from '../lib/lifecycle-strip.js';
import { propertyModel } from '../lib/map-property-model.js';
import { affectedOn, affectedSpec, affectedTabHtml, affectedTabCount, journeyChipReach, pickAffected, affectedSummaryHtml } from './map-affected.js';

/** The rail's tabs, in order. */
export const MAP_PROP_TABS = ['overview', 'gates', 'apis', 'ux', 'tests', 'route', 'work', 'changes'];
const TAB_KEY = (tab) => (tab === 'affected' ? 'map.affected.tab' : 'map.prop.tab.' + tab);
/** The tabs on screen: the eight, and the Affected tab while the board is dimmed around something (lane I). */
function tabsNow() { return affectedOn() ? MAP_PROP_TABS.concat(['affected']) : MAP_PROP_TABS; }
/** A row's seed action: dim the board around this work item or commit (lane I). */
function affBtn(spec) {
  return '<button type="button" class="mp-affbtn' + (affectedSpec() === spec ? ' on' : '') + '" data-act="affected" data-seed="' + esc(spec) + '"' + defAttrs('map.affected.actionShort') + '>' + esc(t('map.affected.actionShort')) + '</button>';
}
const EV_KEY = { 'spec-backed': 'map.prop.ev.specBacked', implied: 'map.prop.ev.implied', declared: 'map.prop.ev.declared', 'not built': 'journey.absent.notBuilt' };

// one answer per screen per sync for the two lazy tabs, shared by every mount
const LAZY = new Map();
function syncKey() { return String((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''); }
function lazy(key, make) {
  const k = key + '@' + syncKey();
  if (!LAZY.has(k)) LAZY.set(k, make());
  return LAZY.get(k);
}

function biz() { return currentLens() === 'business'; }
function wordsOr(text) { return jrnWords(text) || t('journey.biz.noWords'); }
/** A node's name in the lens on screen: words in business, its own name elsewhere. */
function nameOf(n, fallback) {
  if (!n) return fallback || '';
  return biz() ? bizName(n).replace(/\.(?=\w)/g, ' ') : String(n.name || fallback || '');
}
function sec(headKey, body, extra) {
  return '<section class="mp-sec"' + (extra || '') + '><h3 class="hud-label"' + defAttrs(headKey) + '>' + esc(t(headKey)) + '</h3>' + body + '</section>';
}
function secHead(headKey, countHtml) {
  return '<h3 class="hud-label"><span' + defAttrs(headKey) + '>' + esc(t(headKey)) + '</span>' + (countHtml ? ' <span class="mp-hcount">' + countHtml + '</span>' : '') + '</h3>';
}
/**
 * The doors of a row's detail (round 2026-10-05 §3.2), from the one builder the journey uses. A row whose part
 * the graph names (a node by id) carries them in a fold under it — opened by a click, Enter opens the first, `o`
 * the editor; a row whose part the graph cannot name has none, and its words stay as they were.
 */
function rowDoors(card) {
  const n = card && card.id ? S.BYID[card.id] : null;
  if (!n) return '';
  const kind = card.kind === 'gate' ? n.kind : card.kind;
  return doorsHtml(doorsFor(kind, n, { flow: (VIEW.ctx && VIEW.ctx.flow) || null, handler: card.handler || null }));
}
/** One row of a list: a label and a sub-line on the left, a short fact on the right; `card` makes it addressable by the explore card. */
function row(label, sub, right, card) {
  const attrs = card && card.id ? ' data-map-card="' + esc(card.kind) + '" data-id="' + esc(card.id) + '"' : '';
  const doors = rowDoors(card);
  const det = doors ? ' tabindex="0" data-doors aria-expanded="false"' : '';
  return '<div class="mp-row' + (card && card.id ? ' card' : '') + (doors ? ' has-doors' : '') + '"' + attrs + det + '><div class="l"><span class="nm">' + label + '</span>'
    + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div>' + (right ? '<div class="r">' + right + '</div>' : '')
    + (doors ? '<div class="mp-exp" hidden>' + doors + '</div>' : '') + '</div>';
}
/** Open or fold a row's detail: its code (a gate's own lines, a call's contract) where the register reads code, and its doors. */
function toggleRowDetail(rowEl) {
  const exp = rowEl.querySelector(':scope > .mp-exp');
  if (!exp) return;
  const open = exp.hidden;
  exp.hidden = !open;
  rowEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open || exp.dataset.filled) return;
  exp.dataset.filled = '1';
  const kind = rowEl.dataset.mapCard, id = rowEl.dataset.id;
  const n = S.BYID[id];
  let pre = '';
  if (kind === 'gate') pre = codeSlotHtml(id);
  else if (kind === 'call' && n && !biz()) pre = jrnContractHtml(n);
  if (pre) exp.insertAdjacentHTML('beforeend', '<div class="mp-exp-code">' + pre + '</div>');
  fillCode(exp);
}
function absentRow(kind) { return '<div class="mp-row none">' + jrnAbsentHtml(kind) + '</div>'; }
function lineRow(key) { return '<div class="mp-row none"><span class="mp-note"' + defAttrs(key) + '>' + sym('absent') + esc(t(key)) + '</span></div>'; }
function code(s) { return '<code>' + esc(s) + '</code>'; }
/** A `Counted` as a number only — `''` where the lens does not print it (no business unit). */
function countNum(c, api) {
  if (!c || !countedUnit(c)) return '';
  return countedHtml(c, api || '/api/journey', { words: String(c.n), cls: 'n' });
}
function countWords(c, api) { return c ? countedHtml(c, api || '/api/journey', { cls: 'mp-chip' }) : ''; }

// ── what a real screen needs: long lists capped, long sentences clamped ──────
/** How many rows a list in the rail shows before *show all n*. */
export const MAP_PROP_CAP = 10;
/** The view state the list and text helpers read: which lists and texts the reader opened. */
let VIEW = { open: new Set() };

/**
 * One list of rows, capped at MAP_PROP_CAP with a *show all n* row that opens
 * it in place. The n is the list's own `Counted` when it counts exactly these
 * rows, else the rows on screen with a plain tip — never a number of its own.
 */
function capRows(key, rows, c, api) {
  if (rows.length <= MAP_PROP_CAP) return rows.join('');
  const open = VIEW.open.has(key);
  const n = c && c.n === rows.length && countedUnit(c)
    ? countedHtml(c, api || '/api/journey', { words: String(c.n), cls: 'n' })
    : '<span class="n"' + plainTip(rows.length, 'map.prop.listRows', 'journey.scopeHere', api || '/api/journey') + '>' + rows.length + '</span>';
  const ctl = '<button class="mp-row mp-all" data-act="all" data-list="' + esc(key) + '" aria-expanded="' + open + '">'
    + (open ? esc(t('map.prop.showFewer').replace('{n}', MAP_PROP_CAP))
      : esc(t('map.prop.showAll')).replace('{n}', () => n)) + '</button>';
  return (open ? rows : rows.slice(0, MAP_PROP_CAP)).join('') + ctl;
}

/** Sentences of a text, kept whole (a full stop inside `e.g.` or a number is not an end). */
function sentencesOf(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[a-z0-9)”"’'][.!?])\s+(?=[A-Z0-9“"‘(])/);
}
/**
 * A free text somebody wrote, in the lens's words, clamped to its first two
 * sentences (at most about 280 characters) with a *more* that opens the rest in
 * place — the journey view prints the first sentence as the step for the same
 * reason: a 200-word description must not be the whole rail.
 */
function clampHtml(key, text) {
  const full = wordsOr(text);
  let short = sentencesOf(full).slice(0, 2).join(' ');
  if (short.length > 280) short = short.slice(0, 277).replace(/\s+\S*$/, '') + '…';
  if (short.length >= full.length) return '<span class="mp-text">' + esc(full) + '</span>';
  const open = VIEW.open.has(key);
  return '<span class="mp-text mp-clamp' + (open ? ' open' : '') + '" data-clamp="' + esc(key) + '">'
    + '<span class="short">' + esc(short) + '</span><span class="full">' + esc(full) + '</span> '
    + '<button class="mp-more" data-act="more" data-key="' + esc(key) + '" aria-expanded="' + open + '"' + defAttrs(open ? 'map.prop.less' : 'map.prop.more') + '>'
    + esc(t(open ? 'map.prop.less' : 'map.prop.more')) + '</button></span>';
}

/** The parts of a screen that carry stories, each once, in the order the stories helper lists them. */
function storyParts(n, comps) {
  const seen = new Set();
  return screenStoryIds(n, comps.map((c) => c.id)).filter((id) => {
    const x = S.BYID[id];
    if (seen.has(id) || !x || !(x.stories || []).length) return false;
    seen.add(id);
    return true;
  });
}
/**
 * The story chips above the hero: one per part while there are three or fewer;
 * past three, one chip *n stories on m parts* that opens them in place. Both
 * numbers carry a tip, n with the per-part breakdown that adds up to it.
 */
function heroStoriesHtml(n, comps) {
  const ids = storyParts(n, comps);
  if (ids.length <= 3) return storyChipsHtml(ids);
  const open = VIEW.open.has('hero-stories');
  if (open) {
    return storyChipsHtml(ids) + '<button class="api-chip mp-fold" data-act="more" data-key="hero-stories" aria-expanded="true">' + esc(t('map.prop.storiesLess')) + '</button>';
  }
  const rows = ids.map((id) => [bizName(S.BYID[id]), S.BYID[id].stories.length]);
  const total = rows.reduce((a, r) => a + r[1], 0);
  const nHtml = '<span class="n"' + plainTip(total, 'map.prop.storiesN', 'journey.scopeHere', '/graph', rows) + '>' + total + '</span>';
  const mHtml = '<span class="n"' + plainTip(ids.length, 'map.prop.storyParts', 'journey.scopeHere', '/graph') + '>' + ids.length + '</span>';
  return '<button class="api-chip sb-chip mp-fold" data-act="more" data-key="hero-stories" aria-expanded="false">' + sym('story')
    + esc(t('map.prop.storiesFold')).replace('{n}', () => nHtml).replace('{m}', () => mHtml) + '</button>';
}
function loc(l) { return l && l.path ? l.path + (l.line != null ? ':' + l.line : '') : ''; }

// ── the hero ────────────────────────────────────────────────────────────────

/** The placeholder for a screen with no picture: the glyph, its name, route, sentence, status, parts and the absence word. */
function placeholderHtml(pm, why) {
  const s = pm.screen;
  const n = pm.node || {};
  const d = n.design || {};
  const parts = [pm.node && pm.hero.planned ? null : pm.node].concat(pm.hero.components).filter((x) => x && x.id);
  const absent = why === 'design.noImage'
    ? '<span class="jrn-mk none" data-absent="noImage"' + defAttrs('design.noImage') + '>' + sym('absent') + esc(t('design.noImage')) + '</span>'
    : jrnAbsentHtml('notIndexed');
  return '<div class="mp-ph" data-hero="placeholder">' + sym('design', 'mp-ph-glyph')
    + '<div class="t">' + esc(s.name || nameOf(n)) + '</div>'
    + (biz() || !(pm.tabs.route.route) ? '' : '<div class="route">' + code(pm.tabs.route.route) + '</div>')
    + (s.business || pm.tabs.overview.business ? '<p class="say">' + clampHtml('ph-say', pm.tabs.overview.business) + '</p>' : '')
    + '<div class="st">' + (pm.hero.planned ? '<span class="api-chip stub"' + defAttrs('design.status.designOnly') + '>' + sym('design') + esc(t('design.status.designOnly')) + '</span>' : '')
    + '<span class="hud-label"' + defAttrs('map.prop.ph.head') + '>' + esc(t('map.prop.ph.head')) + '</span>' + absent + '</div>'
    + '<div class="parts"><span class="hud-label"' + defAttrs('map.prop.ph.parts') + '>' + esc(t('map.prop.ph.parts')) + '</span>'
    + (parts.length ? parts.map((p) => '<span class="api-chip">' + esc(nameOf(p)) + '</span>').join('')
      : '<span class="mp-note"' + defAttrs('map.prop.ph.noParts') + '>' + sym('absent') + esc(t('map.prop.ph.noParts')) + '</span>')
    + '</div>'
    + (d.url ? '<div class="open">' + linkHtml(d.url, t('insp.designOpen')) + '</div>' : '')
    + '</div>';
}

function heroHtml(pm) {
  const n = pm.node;
  const d = (n && n.design) || null;
  const chips = '<div class="mp-hero-chips">'
    + (d && !pm.hero.planned ? '<span class="api-chip ' + (d.status === 'both' ? 'ok' : d.status === 'design-only' ? 'stub' : 'warn') + '"' + defAttrs(d.status === 'both' ? 'design.status.both' : d.status === 'design-only' ? 'design.status.designOnly' : 'design.status.codeOnly') + '>'
      + sym('design') + esc(t(d.status === 'both' ? 'design.status.both' : d.status === 'design-only' ? 'design.status.designOnly' : 'design.status.codeOnly')) + '</span>' : '')
    + (n ? heroStoriesHtml(n, pm.hero.components) : '')
    + '</div>';
  if (pm.hero.kind === 'none' || !n) return chips + '<div class="mp-frame ph">' + placeholderHtml(pm, 'none') + '</div>';
  return chips + '<div class="mp-frame img" data-hero="image">' + designThumbHtml(n, 'mp-shot') + '</div>'
    + '<div class="mp-frame ph" hidden>' + placeholderHtml(pm, 'design.noImage') + '</div>';
}

/** When the picture does not resolve (a Figma frame with no token, a missing file), the placeholder takes the frame. */
function wireHero(host) {
  const img = host.querySelector('.mp-frame.img img');
  if (!img) return;
  const fail = () => {
    const a = host.querySelector('.mp-frame.img');
    const b = host.querySelector('.mp-frame.ph');
    if (a) a.hidden = true;
    if (b) b.hidden = false;
  };
  img.addEventListener('error', fail, { once: true });
  if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail();
  // the frame takes the picture's own aspect, so a tall screenshot is shown whole, letterboxed, never cropped
  const box = img.closest('.mp-shot');
  const id = (box && box.closest('.mp') && box.closest('.mp').dataset.screen) || '';
  const fit = () => {
    if (!img.naturalWidth || !img.naturalHeight || !box) return;
    const ar = img.naturalWidth / img.naturalHeight;
    ASPECT.set(id, ar);
    box.style.setProperty('--ar', String(ar));
  };
  if (box && ASPECT.has(id)) box.style.setProperty('--ar', String(ASPECT.get(id)));
  if (img.complete) fit(); else img.addEventListener('load', fit, { once: true });
}
/** Each screen's picture aspect once it has loaded, so a redraw does not flash the default shape. */
const ASPECT = new Map();

// ── tab bodies ──────────────────────────────────────────────────────────────

function serviceTag(c) {
  const svc = c.service;
  const cls = svc ? 'svc-' + svc.index : 'svc-none';
  const word = svc ? svc.label : t('map.prop.apis.noService');
  return '<span class="mp-svc ' + esc(cls) + '"' + (svc ? '' : defAttrs('map.prop.apis.noService')) + '>' + esc(word) + '</span>';
}
function evChip(ev) {
  const key = EV_KEY[ev];
  // the business lens prints the absences (declared, never called · not built) and not the contract's classes
  if (!key || (biz() && (ev === 'spec-backed' || ev === 'implied'))) return '';
  return '<span class="api-chip mp-evc ' + (ev === 'spec-backed' ? 'ok' : ev === 'implied' ? 'warn' : 'stub') + '" data-ev="' + esc(ev) + '"' + defAttrs(key) + '>' + esc(t(key)) + '</span>';
}
/** What a call is for, in the lens on screen. */
function callWords(c) {
  const mo = c.moment || {};
  if (biz()) return plainWords(c.summary) || plainWords(c.business) || plainWords(c.label) || plainWords(mo.business) || t('journey.biz.noWords');
  return String(c.summary || c.label || mo.label || c.operationId || '');
}
/** A record's, message's or third party's name in the lens; a third party's product name (Example ERP) is said as written. */
function dataName(d) {
  const n = S.BYID[d.nodeId];
  if (d.kind === 'external' && !/[a-z][A-Z]|_|\/|\.[a-z]/.test(String(d.name || ''))) return String(d.name || '');
  return nameOf(n, d.name);
}
function dataWords(data) {
  const lower = (w) => (biz() ? w.replace(/^./, (ch) => ch.toLowerCase()) : w);
  const byMode = (mode) => data.filter((d) => d.mode === mode || (d.mode === 'both' && mode !== 'reached')).map((d) => (d.kind === 'external' ? dataName(d) : lower(dataName(d))));
  const r = byMode('read'), w = byMode('write'), u = byMode('reached');
  return [r.length ? t('map.prop.apis.reads').replace('{list}', r.join(', ')) : '', w.length ? t('map.prop.apis.writes').replace('{list}', w.join(', ')) : '',
    u.length ? t('map.prop.apis.reached').replace('{list}', u.join(', ')) : ''].filter(Boolean).join(' · ');
}
function callRow(c, brief) {
  const verb = !biz() && (c.method || c.path) ? code([c.method, c.path].filter(Boolean).join(' ')) : '';
  const data = (c.data || []).length ? esc(dataWords(c.data)) : (c.evidence === 'not built' || c.evidence === 'declared' ? '' : '<span class="mp-dim"' + defAttrs('map.prop.apis.noData') + '>' + esc(t('map.prop.apis.noData')) + '</span>');
  const again = c.repeat ? ' <span class="mp-dim"' + defAttrs('map.prop.apis.repeat') + '>' + sym('sync') + esc(t('map.prop.apis.repeat')) + '</span>' : '';
  const sub = brief ? verb : [verb, data].filter(Boolean).join(' · ');
  return row(serviceTag(c) + esc(callWords(c)) + again, sub, evChip(c.evidence), { kind: 'call', id: c.nodeId, handler: (c.marker && c.marker.handler) || null });
}
/**
 * A checkpoint's name in the lens: the business lens says the words somebody wrote, and a permission name
 * (`billing:read`) said as words (*Billing read*), never the code's spelling.
 */
function gateWords(g) {
  const label = jrnGateLabel(g);
  return biz() && /^[\w.-]+(?::[\w.-]+)+$/.test(label) ? humanize(label.replace(/[:.]/g, ' ')) : label;
}
function gateKindKey(g) {
  if (biz()) return g.kind === 'guard' ? 'map.biz.check' : 'map.biz.rule';
  return g.kind === 'guard' ? 'map.prop.kind.guard' : 'map.prop.kind.rule';
}
function gateRow(g) {
  const label = gateWords(g);
  const kindKey = gateKindKey(g);
  const sub = '<span' + defAttrs(kindKey) + '>' + esc(t(kindKey)) + '</span>'
    + (g.planned ? ' · <span' + defAttrs('map.prop.planned') + '>' + esc(t('map.prop.planned')) + '</span>' : '');
  const timesKey = g.merged > 1 ? 'map.prop.timesSame' : 'map.prop.times';
  const times = g.count > 1 ? '<span class="mp-dim"' + plainTip(g.count, timesKey, 'journey.scopeHere', '/api/journey', g.parts) + '>' + esc(t(timesKey).replace('{n}', g.count)) + '</span>' : '';
  return row(sym(g.kind === 'guard' ? 'gate' : 'warning') + esc(label), sub, times, { kind: 'gate', id: g.id });
}
/**
 * One row per checkpoint as the reader sees it: two gates the code names apart but the lens says in the same
 * words (and of the same kind) are one row, their times added, with the parts as the tip's breakdown.
 */
/** A merged row's part in its tip: the code's name outside the business lens, the words in it. */
function partName(g) { return biz() ? gateWords(g) : jrnGateText(g) || gateWords(g); }
function dedupeGates(list) {
  const out = [], at = new Map();
  for (const g of list) {
    const key = g.kind + '|' + (g.planned ? 'p' : '') + '|' + gateWords(g);
    const n = g.count || 1;
    if (!at.has(key)) {
      const row0 = { ...g, count: n, merged: 1, parts: [[partName(g), n]] };
      at.set(key, row0);
      out.push(row0);
    } else {
      const r = at.get(key);
      r.count += n;
      r.merged += 1;
      r.parts.push([partName(g), n]);
    }
  }
  for (const r of out) if (r.merged < 2) r.parts = null;
  return out;
}
let COUNTED_GATES = null;
function gateList(rows, key) {
  const shown = jrnGatesShown(rows);
  if (!shown.rows.length) return absentRow('noneIndexed');
  const drawn = dedupeGates(shown.drawn);
  return capRows(key || 'gates', drawn.map(gateRow), shown.mute ? null : shown.rows.length === drawn.length ? COUNTED_GATES : null)
    + (shown.mute ? '<div class="mp-row none"><span class="mp-note"' + plainTip(shown.mute, 'map.prop.gates.mute', 'journey.scopeHere', '/api/journey') + '>'
      + esc(t('map.prop.gates.mute').replace('{n}', shown.mute)) + '</span></div>' : '');
}

function overviewHtml(pm, st) {
  const o = pm.tabs.overview;
  const glance = o.glance.map((c) => countWords(c) + (c === pm.counts.tests ? mapEvidenceChip(o.evidence) : '')).filter(Boolean).join('')
    + (pm.hero.planned ? '<span class="api-chip stub"' + defAttrs('design.status.designOnly') + '>' + esc(t('design.status.designOnly')) + '</span>' : '');
  const calls = o.calls.length ? capRows('ov-calls', o.calls.map((c) => callRow(c, true))) : (pm.tabs.apis.planned ? absentRow('notBuilt') : absentRow('noneIndexed'));
  COUNTED_GATES = pm.counts.gates;
  return sec('map.prop.ov.what', '<div class="mp-biz">' + clampHtml('ov-what', o.business) + '</div>')
    + (glance ? sec('map.prop.ov.glance', '<div class="mp-chips">' + glance + '</div>') : '')
    + sec('map.prop.ov.calls', calls)
    + sec('map.prop.ov.gates', gateList(o.gates, 'ov-gates'))
    + propLifecycleHtml(pm, st)
    + sec('map.prop.ov.work', workRowsHtml(pm, st, true));
}

/**
 * The Overview's status lifecycle: one strip per record this screen's calls reach whose statuses
 * the code declares (the journey answer's `lifecycles`, kept to the screen's own data). `''` when
 * none does — the section is left out rather than drawn empty.
 * @group Map
 */
function propLifecycleHtml(pm, st) {
  const ids = ((pm.tabs.apis && pm.tabs.apis.records) || []).map((r) => r.nodeId);
  const list = lifecyclesFor(st.ctx && st.ctx.data && st.ctx.data.lifecycles, ids);
  if (!list.length) return '';
  return sec('lifecycle.word', list.map((lc) => lifecycleStripHtml(lc, '/api/journey')).join(''));
}

function gatesHtml(pm) {
  const g = pm.tabs.gates;
  const decs = biz() ? g.decisions.filter((d) => d.class === 'business') : g.decisions;
  COUNTED_GATES = g.counted;
  const decRows = capRows('decisions', decs.map((d, i) => {
    const at = S.BYID[d.nodeId];
    const sub = biz() ? '' : esc([at ? at.name : '', currentLens() === 'code' && at && at.loc ? at.loc.path + ':' + d.line : ''].filter(Boolean).join(' · '));
    return row(sym('decision') + clampHtml('dec-' + i, d.label), sub, '', { kind: 'decision', id: d.nodeId });
  }), decs.length === g.decisions.length ? g.decisionsCounted : null);
  return '<section class="mp-sec">' + secHead('map.prop.gates.head', countNum(g.counted)) + gateList(g.rows) + '</section>'
    + '<section class="mp-sec">' + secHead('map.prop.gates.decisions', decs.length === g.decisions.length ? countNum(g.decisionsCounted) : '')
    + (decRows || absentRow('noneIndexed')) + '</section>';
}

function apisHtml(pm) {
  const a = pm.tabs.apis;
  const head = secHead('map.prop.apis.head', countNum(pm.counts.apis));
  const notBuilt = a.planned ? '<p class="mp-warn">' + sym('warning') + esc(t('map.prop.apis.notBuilt')) + '</p>' : '';
  const calls = a.calls.length ? capRows('calls', a.calls.map((c) => callRow(c, false)), pm.counts.apis) : absentRow(a.planned ? 'notBuilt' : 'noneIndexed');
  const recs = a.records.length ? (a.groups || [{ store: null, kind: null, rows: a.records }]).map((g, gi) => storeGroupHtml(g, gi)).join('') : absentRow(a.planned ? 'notBuilt' : 'noneIndexed');
  return notBuilt + '<section class="mp-sec">' + head + calls + '</section>' + sec('map.prop.apis.records', recs);
}

/** How the calls on this screen use one record or store, in words. */
function modesWords(modes) {
  if (modes.includes('read') && modes.includes('write')) return { key: 'map.prop.apis.readsWrites', words: t('map.prop.apis.readsWrites') };
  if (modes.includes('write')) return { key: 'map.prop.apis.writes', words: t('map.prop.apis.writes').replace('{list}', '').trim() };
  if (modes.includes('read')) return { key: 'map.prop.apis.reads', words: t('map.prop.apis.reads').replace('{list}', '').trim() };
  return { key: 'map.mode.reached', words: t('map.mode.reached') };
}
const STORE_KINDS = ['sql', 'document', 'files', 'erp', 'other'];
/**
 * One store's part of *Data this screen reaches*: its name and kind as the heading (a store's name is words
 * somebody wrote, so every register prints it), then each record or outside system in it with its modes. What no
 * store names comes last, under its plain kind word.
 */
function storeGroupHtml(g, gi) {
  const sk = g.store ? (STORE_KINDS.includes(g.store.kind) ? g.store.kind : 'other') : '';
  const plainKey = g.kind === 'message' ? 'map.kind.message' : g.kind === 'external' ? 'map.kind.external' : 'map.kind.record';
  const head = g.store
    ? '<h4 class="mp-grp st-' + sk + '" data-store="' + esc(g.store.name) + '"><i></i><span>' + esc(g.store.name) + '</span> · <span' + defAttrs('map.store.kind.' + sk) + '>' + esc(t('map.store.kind.' + sk)) + '</span></h4>'
    : '<h4 class="mp-grp plain"><span' + defAttrs(plainKey) + '>' + esc(t(plainKey)) + '</span></h4>';
  const rows = g.rows.map((r) => {
    const sk2 = g.store ? sk : '';
    const kindKey = biz() ? (sk2 ? 'map.biz.kind.' + sk2 : r.kind === 'message' ? 'map.biz.kind.message' : r.kind === 'external' ? 'map.biz.kind.external' : 'map.biz.kind.record')
      : r.kind === 'message' ? 'sym.message' : r.kind === 'external' ? 'sym.external' : 'sym.record';
    const m = modesWords(r.modes);
    return row(sym(r.kind === 'message' ? 'message' : r.kind === 'external' ? 'external' : 'record') + esc(dataName(r)),
      '<span' + defAttrs(kindKey) + '>' + esc(t(kindKey)) + '</span> · <span class="mp-mode ' + esc(r.modes.length > 1 ? 'both' : r.modes[0] || '') + '"' + defAttrs(m.key) + '>' + esc(m.words) + '</span>', '', { kind: r.kind || 'record', id: r.nodeId });
  });
  return '<div class="mp-store">' + head + capRows('records-' + gi, rows) + '</div>';
}

function uxHtml(pm) {
  const u = pm.tabs.ux;
  const n = u.page;
  const page = n && u.built
    ? row(biz() ? esc(pm.screen.name || nameOf(n)) : code(n.name), biz() ? '' : esc(loc(n.loc || (pm.screen.segment.screen || {}).loc)),
      '<span' + defAttrs('map.prop.kind.page') + '>' + esc(t('map.prop.kind.page')) + '</span>', { kind: 'page', id: n.id })
    : lineRow('map.prop.ux.noPage');
  const comps = u.components.length ? capRows('components', u.components.map((c) => row(biz() ? esc(nameOf(c)) : code(c.name),
    biz() ? '' : esc(loc(c.loc)), '<span' + defAttrs('map.prop.kind.component') + '>' + esc(t('map.prop.kind.component')) + '</span>', { kind: 'component', id: c.id })))
    : absentRow(u.built ? 'noneIndexed' : 'notBuilt');
  const stories = n ? storyChipsHtml(storyParts(n, u.components)) : '';
  return sec('map.prop.ux.page', page) + sec('map.prop.ux.components', comps) + sec('map.prop.ux.stories', stories || absentRow('noneIndexed'));
}

/** A test's name in the business lens: said as words, without the document references its authors cross-file it by. */
function caseWords(name) {
  const v = String(name || '');
  const said = /\/|[a-z][A-Z]|_|\.[a-z]{2,4}\b/.test(v) ? unCode(v) : v;
  // a path left in the words (a test named for the route it visits) is dropped, never printed
  return (plainWords(said) || said).replace(/(^|[\s(])\/[\w.:{}\-/]*/g, '$1').replace(/\s{2,}/g, ' ').trim() || unCode(v);
}
function caseRow(x) {
  const how = x.observedVia === 'declaration' && x.status === 'passed' ? 'map.prop.tests.byDeclaration'
    : x.evidence === 'observed' ? 'map.prop.tests.byRun' : 'map.prop.tests.reached';
  const name = biz() ? caseWords(x.name) : String(x.name || '');
  const sub = biz() ? '' : [x.level ? t('tests.level.' + x.level) : '', x.runner || '', currentLens() === 'code' ? loc(x.loc) : ''].filter(Boolean).map(esc).join(' · ');
  const status = x.status ? '<span class="st ' + esc(x.status) + '"' + defAttrs('tests.run.' + x.status) + '>' + esc(t('tests.run.' + x.status)) + '</span>' : '';
  return row(esc(name), sub, '<span class="mp-ev ' + esc(how.split('.').pop()) + '"' + defAttrs(how) + '>' + esc(t(how)) + '</span>' + status, { kind: 'test', id: x.id });
}

function testsHtml(pm) {
  const cov = pm.tabs.tests.facts;
  const facts = jrnFoldFacts(cov);
  if (!facts || (!facts.total && !facts.runLevel)) {
    return sec('map.prop.tests.head', '<div class="mp-row none">' + jrnAbsentHtml('noneIndexed', (facts && facts.note) || '') + '</div>')
      + sec('map.prop.tests.cases', absentRow('noneIndexed'));
  }
  const k = facts.counted || {};
  const num = (c, n) => (c ? countNum(c) || esc(String(n)) : esc(String(n)));
  let foot;
  if (biz()) {
    const ev = evidenceWord(facts);
    const runKey = ev.biz || (facts.chip === 'observed-stale' ? 'journey.biz.testsRun.stale' : 'journey.biz.testsRun.none');
    foot = '<div class="line">' + jrnEvChipHtml(facts) + '</div>' + jrnFootScopeHtml(facts)
      + '<div class="line biz">' + esc(t('journey.biz.tests')).replace('{n}', () => num(k.tests, facts.total)).replace('{e2e}', () => num(k.e2e, facts.e2e)) + ' ' + esc(t(runKey)) + '</div>';
  } else {
    const obs = jrnObsText(facts);
    foot = '<div class="line">' + jrnEvChipHtml(facts) + (obs ? '<span class="obs">' + esc(obs) + '</span>' : '') + '</div>' + jrnFootScopeHtml(facts)
      + '<div class="line"><span class="cnt">' + esc(t('journey.tests.foot')).replace('{e2e}', () => num(k.e2e, facts.e2e)).replace('{unit}', () => num(k.unit, facts.unit))
        .replace('{int}', () => num(k.integration, facts.integration)).replace('{obs}', () => num(k.observed, facts.observed)) + '</span></div>'
      + jrnRunLineHtml(facts.run);
  }
  const { cases, reports } = pm.tabs.tests;
  const reportRow = (x) => row(esc(biz() ? caseWords(x.name) : String(x.name || '')), biz() ? '' : esc([x.runner || '', currentLens() === 'code' ? loc(x.loc) : ''].filter(Boolean).join(' · ')),
    '<span class="mp-ev reached"' + defAttrs('tests.evidence.runSeen') + '>' + esc(t('tests.evidence.runSeen')) + '</span>', { kind: 'test', id: x.id });
  return '<section class="mp-sec"><h3 class="hud-label"' + defAttrs('map.prop.tests.head') + '>' + esc(t('map.prop.tests.head')) + '</h3><div class="jrn-tfoot mp-tfoot">' + foot + '</div></section>'
    + '<section class="mp-sec">' + secHead('map.prop.tests.cases', countNum(k.tests)) + (cases.length ? capRows('cases', cases.map(caseRow), k.tests) : absentRow('noneIndexed')) + '</section>'
    + (reports.length ? '<section class="mp-sec">' + secHead('map.prop.tests.reports', countNum(k.runReports)) + capRows('reports', reports.map(reportRow), k.runReports) + '</section>' : '')
    + '<p class="mp-note">' + esc(t('map.prop.tests.verifiedNote')) + '</p>';
}

function routeHtml(pm) {
  const r = pm.tabs.route;
  const statusKey = r.status === 'planned' ? 'design.status.designOnly' : (r.design && r.design.status === 'both' ? 'design.status.both' : r.design ? 'design.status.codeOnly' : '');
  const status = statusKey ? '<span class="api-chip ' + (r.status === 'planned' ? 'stub' : 'ok') + '"' + defAttrs(statusKey) + '>' + esc(t(statusKey)) + '</span>' : '';
  const where = [];
  if (r.declaredIn) {
    where.push(biz() ? esc(t('map.prop.route.declaredIn').replace('{file}', nameOf(S.BYID[r.declaredIn.id], r.declaredIn.name)))
      : esc(t('map.prop.route.declaredIn').replace('{file}', r.declaredIn.path || r.declaredIn.name)));
  }
  if (r.status === 'planned' || !r.codeAt) where.push('<span' + defAttrs('map.prop.route.noCode') + '>' + esc(t('map.prop.route.noCode')) + '</span>');
  else if (!biz()) where.push(esc(t('map.prop.route.codeAt').replace('{file}', loc(r.codeAt))));
  const address = row(biz() ? esc(pm.screen.name || '') : code(r.route), where.join(' · '), status, pm.node ? { kind: 'page', id: pm.node.id } : null);
  const links = r.journeyLinks || {};
  const jl = capRows('journey-links', [['requires', 'journey.requires'], ['leadsTo', 'journey.leadsTo'], ['partOf', 'journey.partOf']].flatMap(([k, key]) => (links[k] || []).map((x) => {
    const id = typeof x === 'string' ? x : x.id || x.nodeId;
    const nm = typeof x === 'string' ? (S.BYID[x] ? nameOf(S.BYID[x]) : x) : x.name || (S.BYID[id] ? nameOf(S.BYID[id]) : id);
    return row(esc(nm), '<span' + defAttrs(key) + '>' + esc(t(key)) + '</span>', '', null);
  })));
  const ways = capRows('ways', r.otherWays.map((w) => row(esc(nameOf(w.node, w.nodeId.split('::').pop())), biz() ? '' : esc(w.kind), '', { kind: (w.node && w.node.kind) || 'node', id: w.nodeId })));
  const refs = pm.node ? jrnRefAnchors(pm.node) : [];
  return sec('map.prop.route.head', address)
    + sec('map.prop.route.journeys', jl || absentRow('noneIndexed'))
    + sec('map.prop.route.ways', ways || absentRow('noneIndexed'))
    + (refs.length ? sec('map.prop.route.links', '<div class="mp-refs">' + refs.join('') + '</div>') : '');
}

// ── the lazy tabs ───────────────────────────────────────────────────────────

/** This screen's work: the items linked to its page, and the findings of the journey that are about those items. */
function loadWork(pm, flow) {
  const id = pm.node && pm.node.id;
  if (!id || !workSourcesConfigured()) return Promise.resolve({ off: true });
  return lazy('work|' + id + '|' + flow, () => Promise.all([
    fetch('/api/work/links?node=' + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    flowWork(flow),
  ]).then(([links, fw]) => {
    if (!links) return { failed: true };
    const ids = new Set((links.items || []).map((i) => i.id));
    return { items: links.items || [], counted: (links.counts && links.counts.items) || null, findings: ((fw && fw.findings) || []).filter((f) => ids.has(f.item)) };
  }));
}

function workRowsHtml(pm, st, brief) {
  if (!workSourcesConfigured()) return lineRow('map.prop.work.noSource');
  const w = st.work;
  if (!w) return '<div class="mp-row none mp-loading">' + esc(t('map.prop.loading')) + '</div>';
  if (w.failed) return lineRow('map.prop.work.failed');
  if (!w.items.length) return absentRow('noneIndexed');
  return capRows(brief ? 'ov-work' : 'work', w.items.map((it) => row(sym('work') + (biz() ? '' : '<b class="mp-key">' + esc(it.key || '') + '</b> ') + esc(it.title || ''),
    brief ? '' : esc(sourceName(it.source)), stateHtml(it.state) + (brief ? '' : affBtn('work:' + (it.key || it.id))), null)), w.counted, '/api/work/links')
    + (brief ? '' : '<div class="mp-more"><a href="#/work">' + esc(t('nav.work')) + '</a></div>');
}

function workHtml(pm, st) {
  const w = st.work;
  const findings = w && w.findings && w.findings.length
    ? capRows('findings', w.findings.map((f, i) => {
      let text = f.key && S.STRINGS && S.STRINGS[f.key] ? t(f.key) : f.text || '';
      Object.entries(f.vars || {}).forEach(([k, v]) => { text = text.split('{' + k + '}').join(String(v)); });
      return row(sym('warning') + clampHtml('finding-' + i, text), '', '', null);
    }), null, '/api/work/flow') : (w && w.items ? absentRow('noneIndexed') : '');
  return '<section class="mp-sec">' + secHead('map.prop.work.head', w && w.counted ? countNum(w.counted, '/api/work/links') : '') + workRowsHtml(pm, st, false) + '</section>'
    + (findings ? sec('map.prop.work.findings', findings) : '');
}

/** The changes the latest sync measured against the one before it, kept to this screen's parts — what the index changed. */
function loadIndexChanges(pm, repo) {
  return (async () => {
    const h = await fetch('/api/history?repo=' + encodeURIComponent(repo)).catch(() => null);
    if (!h) return { failed: true };
    if (h.status === 503) return { off: true };
    const spine = await h.json().catch(() => null);
    if (!h.ok || !spine || spine.error) return { failed: true };
    const rows = spine.spine || [];
    const head = rows[0] && rows[0].sync;
    const older = rows.find((x) => x.sync < head);
    if (head == null || !older) return { noEarlier: true };
    const r = await fetch('/api/changes?from=sync:' + older.sync + '&to=sync:' + head).catch(() => null);
    const body = r && r.ok ? await r.json().catch(() => null) : null;
    if (!body || !body.diff) return { failed: true };
    const ids = new Set(pm.changeIds);
    const list = (body.diff.changes || []).filter((c) => c.subject && ids.has(c.subject.id));
    // edge confidence is how sure the index is of a link — a fact about Farsight, not the application
    return { base: body.baseSync, head: body.headSync, list, sentences: body.sentences || {} };
  })();
}

/** The application's commits that changed this screen's parts, newest first (`/api/history/touching`). */
function loadCommits(pm, repo) {
  return fetch('/api/history/touching?repo=' + encodeURIComponent(repo) + '&nodes=' + encodeURIComponent(pm.changeIds.join(',')))
    .then(async (r) => {
      if (r.status === 503) return { off: true };
      const body = r.ok ? await r.json().catch(() => null) : null;
      if (!body || !Array.isArray(body.commits)) return { failed: true };
      return { read: body.read || 0, list: body.commits, counted: (body.counted && body.counted.commits) || null };
    })
    .catch(() => ({ failed: true }));
}

/** Both groups of the Changes tab: the commits first, the index's facts second. */
function loadChanges(pm) {
  const repo = pm.node ? repoOf(pm.node) : '';
  return lazy('changes|' + repo + '|' + pm.changeIds.join(','), () => Promise.all([loadCommits(pm, repo), loadIndexChanges(pm, repo)])
    .then(([commits, index]) => ({ commits, index })));
}

/** A commit's date as the reader reads dates: the day, not the time. */
function dayOf(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function commitRow(x) {
  const parts = (x.parts || []).map((p) => {
    const n = S.BYID[p.node];
    return { name: nameOf(n, String(p.node).split('::').pop()), how: p.how };
  });
  // the business register reads the sentence, not its conventional-commit type and scope
  const subject = biz() ? unCode(String(x.subject || '').replace(/^\w+(?:\([^)]*\))?!?:\s*/, '')) : String(x.subject || '');
  const sub = [
    esc(dayOf(x.at)),
    biz() ? '' : '<span' + defAttrs('map.prop.changes.by') + '>' + esc(t('map.prop.changes.by').split('{author}').join(x.author || '')) + '</span>',
    esc(parts.slice(0, 3).map((p) => p.name).join(', '))
      + (parts.length > 3 ? ' <span' + plainTip(parts.length - 3, 'map.prop.changes.partsMore', 'journey.scopeHere', '/api/history/touching') + '>'
        + esc(t('map.prop.changes.partsMore').split('{n}').join(String(parts.length - 3))) + '</span>' : ''),
    biz() ? '' : '<code>' + esc(String(x.sha || '').slice(0, 7)) + '</code>',
    biz() ? '' : (x.keys || []).map((k) => '<b class="mp-key">' + esc(k) + '</b>').join(' '),
  ].filter(Boolean).join(' · ');
  const how = parts.some((p) => p.how === 'lines') ? 'lines' : 'file';
  return row(clampHtml('commit-' + x.sha, subject), sub,
    '<span class="api-chip"' + defAttrs('map.prop.changes.how.' + how) + '>' + esc(t('map.prop.changes.how.' + how)) + '</span>' + (x.sha ? affBtn('commit:' + String(x.sha).slice(0, 12)) : ''),
    { kind: 'node', id: (x.parts && x.parts[0] && x.parts[0].node) || '' });
}

function commitsHtml(c) {
  if (!c) return '<div class="mp-row none mp-loading">' + esc(t('map.prop.loading')) + '</div>';
  if (c.off) return lineRow('map.prop.changes.noHistory');
  if (c.failed) return lineRow('map.prop.changes.commitsFailed');
  if (!c.read) return lineRow('map.prop.changes.notRead');
  if (!c.list.length) return lineRow('map.prop.changes.noCommit');
  return capRows('commits', c.list.map(commitRow), c.counted, '/api/history/touching');
}

/** The changes a lens prints: the business lens leaves out the index's own facts (how sure it is of a link). */
function changeRows(c) { return biz() ? c.list.filter((x) => x.kind !== 'edge_confidence_changed') : c.list; }
function indexChangesHtml(c) {
  if (!c) return '<div class="mp-row none mp-loading">' + esc(t('map.prop.loading')) + '</div>';
  if (c.off) return lineRow('map.prop.changes.noHistory');
  if (c.failed) return lineRow('map.prop.changes.failed');
  if (c.noEarlier) return lineRow('map.prop.changes.noEarlier');
  if (!changeRows(c).length) return lineRow('map.prop.changes.none');
  return capRows('changes', changeRows(c).map((x) => {
    const s = c.sentences[x.id] || x.kind;
    const sub = biz() ? '' : esc([x.kind, x.subject && x.subject.name, currentLens() === 'code' ? loc(x.loc) : ''].filter(Boolean).join(' · '));
    return row(clampHtml('change-' + x.id, biz() ? unCode(s) : s), sub, '<span class="api-chip ' + (x.severity === 'breaking' ? 'warn' : '') + '"' + defAttrs('changes.sev.' + x.severity) + '>' + esc(t('changes.sev.' + x.severity)) + '</span>', { kind: (x.subject && x.subject.kind) || 'node', id: x.subject && x.subject.id });
  }), null, '/api/changes');
}

function changesHtml(pm, st) {
  const c = st.changes || {};
  const commits = c.commits || (st.changes ? { failed: true } : null);
  const index = c.index || (st.changes ? { failed: true } : null);
  const range = index && index.base != null ? '<p class="mp-dim"' + defAttrs('map.prop.changes.range') + '>' + esc(t('map.prop.changes.range').replace('{base}', index.base).replace('{head}', index.head)) + '</p>' : '';
  const n = commits && commits.counted && commits.list && commits.list.length ? countNum(commits.counted, '/api/history/touching') : '';
  return '<section class="mp-sec mp-commits">' + secHead('map.prop.changes.commits', n) + commitsHtml(commits) + '</section>'
    + '<section class="mp-sec mp-indexed">' + secHead('map.prop.changes.head', '') + range + indexChangesHtml(index) + '</section>';
}

// ── the frame ───────────────────────────────────────────────────────────────

function tabsHtml(pm, st) {
  const count = (tab) => {
    const c = tab === 'work' ? (st.work && st.work.counted) || null : tab === 'affected' ? affectedTabCount() : pm.counts[tab];
    return c ? countNum(c, tab === 'work' ? '/api/work/links' : tab === 'affected' ? '/api/impact' : '/api/journey') : '';
  };
  return tabsNow().map((tab) => {
    const on = tab === st.tab;
    const n = count(tab);
    return '<button class="mp-tab' + (on ? ' on' : '') + '" role="tab" id="mp-tab-' + tab + '" data-tab="' + tab + '" aria-selected="' + on + '" aria-controls="mp-body" tabindex="' + (on ? '0' : '-1') + '"'
      + tipAttrs({ key: TAB_KEY(tab), noFocus: true }) + '>' + esc(t(TAB_KEY(tab))) + (n ? '<span class="mp-tabn">' + n + '</span>' : '') + '</button>';
  }).join('');
}

function bodyHtml(pm, st) {
  switch (st.tab) {
    case 'gates': return gatesHtml(pm);
    case 'apis': return apisHtml(pm);
    case 'ux': return uxHtml(pm);
    case 'tests': return testsHtml(pm);
    case 'route': return routeHtml(pm);
    case 'work': return workHtml(pm, st);
    case 'changes': return changesHtml(pm, st);
    case 'affected': return affectedTabHtml(st.ctx);
    default: return overviewHtml(pm, st);
  }
}

/** The other journeys this screen is in: three chips, then one that opens the rest in place, so the bar never outgrows the stage. */
function alsoChipsHtml(pm) {
  // while the board is dimmed around something, each journey says whether its path reaches it (lane I)
  const chip = (f) => '<a class="api-chip mp-alsochip" href="#/map/' + encodeURIComponent(f.id) + '?node=' + encodeURIComponent(pm.node.id) + (affectedOn() ? '&affected=' + encodeURIComponent(affectedSpec()) : '') + '">' + esc(biz() ? plainWords(f.name) || f.name : f.name) + journeyChipReach(f.id) + '</a>';
  const all = pm.alsoIn;
  if (all.length <= 3) return all.map(chip).join('');
  const open = VIEW.open.has('also');
  if (open) return all.map(chip).join('') + '<button class="api-chip mp-fold" data-act="more" data-key="also" aria-expanded="true">' + esc(t('map.prop.storiesLess')) + '</button>';
  const more = all.length - 3;
  return all.slice(0, 3).map(chip).join('') + '<button class="api-chip mp-fold" data-act="more" data-key="also" aria-expanded="false">'
    + esc(t('map.prop.alsoMore')).replace('{n}', () => '<span class="n"' + plainTip(more, 'map.prop.alsoN', 'journey.scopeHere', '/graph') + '>' + more + '</span>') + '</button>';
}
/**
 * Where the screen sits, in units (lane N): *screen 4 of 10 reached* — the 10 is the summary's
 * `counted.screensReached` with its tip (else the street's rows, with a plain tip) — and, when the
 * journey names more screens than the walk reached, a second line *14 declared, 4 not reached*
 * whose second number lists each screen with its absence word.
 */
function whereHtml(pm, j) {
  const p = pm.place || {};
  const m = p.reached
    ? '<span class="n"' + countedAttrs(p.reached, '/api/journey') + '>' + pm.total + '</span>'
    : '<span class="n"' + plainTip(pm.total, 'count.unit.screensReached', 'journey.scopeAll', '/api/journey') + '>' + pm.total + '</span>';
  const line = esc(t('map.prop.foot.step')).replace('{n}', String(pm.index + 1)).replace('{m}', () => m).replace('{journey}', () => esc(j.name || ''));
  let more = '';
  const miss = p.notReached || [];
  if (p.declared && miss.length) {
    const rows = miss.map((x) => [(biz() ? plainWords(x.name) || x.name : x.name) + ' · ' + t('journey.absent.' + x.word), 1]);
    const k = '<span class="n"' + plainTip(miss.length, 'count.part.screensNotReached', 'journey.scopeAll', '/api/journey', rows, 'journey.absent.notReached') + '>' + miss.length + '</span>';
    const n = '<span class="n"' + countedAttrs(p.declared, '/api/journey') + '>' + p.declared.n + '</span>';
    more = '<span class="mp-declared"' + defAttrs('map.prop.foot.declared') + '>' + esc(t('map.prop.foot.declared')).replace('{n}', () => n).replace('{k}', () => k) + '</span>';
  }
  return '<span class="hud-label mp-where"' + tipAttrs({ key: 'map.prop.foot.step' }) + '>' + line + '</span>' + more;
}
function footHtml(pm, ctx) {
  const j = (ctx.model && ctx.model.journey) || {};
  const step = (dir, s) => {
    const key = dir < 0 ? 'map.prop.foot.before' : 'map.prop.foot.after';
    const none = dir < 0 ? 'map.prop.foot.start' : 'map.prop.foot.end';
    return '<button class="mp-step ' + (dir < 0 ? 'prev' : 'next') + '" data-act="step" data-d="' + dir + '"' + (s ? '' : ' disabled') + '>'
      + '<span class="hud-label">' + esc(t(key)) + '</span><span class="nm">' + esc(s ? s.name : t(none)) + '</span></button>';
  };
  const dots = (ctx.model.screens || []).map((s, i) => '<button class="mp-dot' + (i === pm.index ? ' on' : '') + (s.state === 'planned' ? ' planned' : '') + '" data-act="go" data-i="' + i + '"'
    + ' aria-label="' + esc(s.name) + '" title="' + esc(s.name) + '"' + (i === pm.index ? ' aria-current="step"' : '') + '></button>').join('');
  const also = pm.alsoIn.length ? '<div class="mp-also"><span class="hud-label"' + defAttrs('map.prop.foot.alsoIn') + '>' + esc(t('map.prop.foot.alsoIn')) + '</span>'
    + alsoChipsHtml(pm) + '</div>' : '';
  return step(-1, pm.prev)
    + '<div class="mp-mid">' + whereHtml(pm, j) + '<div class="mp-dots">' + dots + '</div>' + also + '</div>'
    + step(1, pm.next);
}

function headHtml(pm, ctx) {
  const j = (ctx.model && ctx.model.journey) || {};
  return '<button class="btn mp-back" data-act="back"' + defAttrs('map.prop.back') + '>' + esc(t('map.prop.back')) + '</button>'
    + '<nav class="mp-crumb" aria-label="' + esc(t('map.prop.level')) + '"><span class="hud-label">' + esc(t('map.prop.crumb')) + '</span><span class="sep">›</span>'
    + '<span>' + esc(j.name || '') + '</span><span class="sep">›</span><b>' + esc(pm.screen.name || '') + '</b>'
    // this screen's numbers are its part of this journey's walk (round 2)
    + '<span class="mp-scope"' + defAttrs('map.screen.onJourney') + '>' + esc(t('map.screen.onJourney')) + '</span>'
    + (biz() || !pm.tabs.route.route ? '' : '<span class="sep">·</span>' + code(pm.tabs.route.route)) + '</nav>'
    // where this journey stands in a storyline (lane S)
    + (ctx.tree && ctx.flow ? storylineLineHtml(ctx.tree, ctx.flow).replace('class="dd-story"', 'class="dd-story mp-story"') : '')
    // the same screen in the journey's timeline (§3.1)
    + (pm.screen && pm.screen.segment && ctx.flow ? '<span class="mp-tojrn">' + leadDoorHtml('door.journey', journeyStepHash(ctx.flow, pm.screen.segment.index + 1, { lens: currentLens() })) + '</span>' : '')
    + (pm.node ? '<button type="button" class="btn mp-affact' + (affectedSpec() === pm.node.id ? ' on' : '') + '" data-act="affected" data-seed="' + esc(pm.node.id) + '"' + defAttrs('map.affected.action') + '>' + esc(t('map.affected.action')) + '</button>' : '')
    // while the board is dimmed around something, the head says around what and how much (round 2)
    + affectedSummaryHtml()
    + '<span class="hud-label mp-level"' + defAttrs('map.prop.level') + '>' + esc(t('map.prop.level')) + '</span>';
}

/**
 * Mount the property of one screen into `host` (lane A's full-stage overlay).
 * Returns `update(ctx)` — redraw in place for a new screen, lens or answer — and
 * `destroy()`.
 * @group Map
 */
export function mountMapProperty(host, ctx) {
  const st = { ctx, tab: 'overview', pm: null, work: null, changes: null, key: '', open: new Set() };
  host.classList.add('mp-host');

  function build() {
    const c = st.ctx;
    st.pm = propertyModel(c.data, c.screenIndex, S.BYID || {}, c.model, { edges: (S.GRAPH && S.GRAPH.edges) || [] });
    const key = (c.flow || '') + '|' + (st.pm && st.pm.node ? st.pm.node.id : c.screenIndex);
    if (key !== st.key) { st.key = key; st.work = null; st.changes = null; st.open = new Set(); }
  }
  function fetchLazy() {
    const pm = st.pm;
    if (!pm) return;
    const key = st.key;
    if (!st.work && workSourcesConfigured()) {
      loadWork(pm, st.ctx.flow).then((w) => { if (st.key !== key) return; st.work = w; drawTabs(); if (st.tab === 'work' || st.tab === 'overview') drawBody(); });
    }
    if (!st.changes && st.tab === 'changes') {
      loadChanges(pm).then((c) => { if (st.key !== key) return; st.changes = c; if (st.tab === 'changes') drawBody(); });
    }
  }
  function drawTabs() { VIEW = st; const el = host.querySelector('.mp-tabs'); if (el && st.pm) el.innerHTML = tabsHtml(st.pm, st); }
  function drawFoot() { VIEW = st; const el = host.querySelector('.mp-foot'); if (el && st.pm) el.innerHTML = footHtml(st.pm, st.ctx); }
  function drawHero() { VIEW = st; const el = host.querySelector('.mp-hero'); if (el && st.pm) { el.innerHTML = heroHtml(st.pm); wireHero(host); } }
  function drawBody() { VIEW = st; const el = host.querySelector('.mp-body'); if (el && st.pm) { el.innerHTML = bodyHtml(st.pm, st); el.setAttribute('aria-labelledby', 'mp-tab-' + st.tab); } }
  function render() {
    build();
    if (st.tab === 'affected' && !affectedOn()) st.tab = 'overview';
    VIEW = st;
    const pm = st.pm;
    if (!pm) { host.innerHTML = '<div class="mp mp-empty">' + absentRow('noneIndexed') + '</div>'; return; }
    host.innerHTML = '<div class="mp' + (pm.hero.planned ? ' planned' : '') + '" data-map-wheel="own" data-screen="' + esc(pm.node ? pm.node.id : '') + '">'
      + '<header class="mp-head">' + headHtml(pm, st.ctx) + '</header>'
      + '<div class="mp-hero">' + heroHtml(pm) + '</div>'
      + '<aside class="mp-side" data-tip-place="left"><div class="mp-tabs" role="tablist" aria-label="' + esc(t('map.prop.tabs')) + '">' + tabsHtml(pm, st) + '</div>'
      + '<div class="mp-body" id="mp-body" role="tabpanel" aria-labelledby="mp-tab-' + st.tab + '"></div></aside>'
      + '<footer class="mp-foot">' + footHtml(pm, st.ctx) + '</footer></div>';
    drawBody();
    wireHero(host);
    fetchLazy();
  }
  function setTab(tab, focus) {
    if (!tabsNow().includes(tab)) return;
    st.tab = tab;
    drawTabs();
    drawBody();
    fetchLazy();
    if (focus) { const b = host.querySelector('#mp-tab-' + tab); if (b) b.focus(); }
  }
  function onClick(e) {
    const tab = e.target.closest('.mp-tab');
    if (tab && host.contains(tab)) { setTab(tab.dataset.tab); return; }
    const act = e.target.closest('[data-act]');
    // a row whose part the graph names opens in place (its code, its doors); a door inside it is a link
    const det = !act && e.target.closest('.mp-row[data-doors]');
    if (det && host.contains(det) && !e.target.closest('a[href]')) { toggleRowDetail(det); return; }
    if (!act || !host.contains(act)) return;
    if (act.dataset.act === 'all' || act.dataset.act === 'more') {
      // a number inside the control opens its tip; the control itself opens or closes what it names
      if (e.target.closest('[data-tip-id]') && e.target.closest('[data-tip-id]') !== act) return;
      const k = act.dataset.list || act.dataset.key;
      if (st.open.has(k)) st.open.delete(k); else st.open.add(k);
      if (act.closest('.mp-hero')) drawHero(); else if (act.closest('.mp-foot')) drawFoot(); else drawBody();
      const again = host.querySelector('[data-act="' + act.dataset.act + '"][data-' + (act.dataset.list ? 'list' : 'key') + '="' + k + '"]');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    const c = st.ctx;
    // a seed picked here dims the board around it, and the tab that answers opens (lane I)
    // the same seed again changes nothing in the mode, so the tab is opened here, not only by the mode's redraw (round 2)
    if (act.dataset.act === 'affected' && c.onAffected) { st.tab = 'affected'; c.onAffected(act.dataset.seed); render(); return; }
    if (act.dataset.act === 'aff-pick') { pickAffected(Number(act.dataset.i)); return; }
    if (act.dataset.act === 'back' && c.onClose) c.onClose();
    else if (act.dataset.act === 'step' && c.onStep) c.onStep(Number(act.dataset.d));
    else if (act.dataset.act === 'go' && c.onOpenScreen) c.onOpenScreen(Number(act.dataset.i));
  }
  function onKey(e) {
    const tab = e.target.closest && e.target.closest('.mp-tab');
    if (!tab) return;
    const tabs = tabsNow();
    const i = tabs.indexOf(st.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next, true);
  }
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKey);
  render();
  // the property opens with the keyboard on its way out, as the prototype does; a redraw never moves focus
  const back = host.querySelector('.mp-back');
  if (back && !host.contains(document.activeElement)) back.focus({ preventScroll: true });
  return {
    update(next) { st.ctx = Object.assign({}, st.ctx, next || {}); render(); },
    /** The tab on screen, and a way to choose one (the e2e spec and lane A's deep links use it). */
    tab(name) { if (name) setTab(name); return st.tab; },
    destroy() {
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKey);
      host.classList.remove('mp-host');
      host.innerHTML = '';
    },
  };
}
