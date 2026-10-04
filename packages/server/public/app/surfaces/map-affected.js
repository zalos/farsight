// surfaces/map-affected.js — the Map's Affected mode (docs/proposals/map-pass-2026-10-03.md §4).
//
// Pick a thing — a screen, a call, a record, a dependency, a work item, a commit — and the
// whole board dims to what reaches it, at every altitude: districts at the neighbourhood,
// screens, calls and data on the street, an Affected tab in the property. One
// `/api/impact?node=&direction=upstream&hops=&tests=1&reach=1` per seed, kept per sync;
// several seeds (a commit touching three parts) are three answers drawn together, each
// kept apart — a place says which parts reach it and how, and nothing is added across
// them. The numbers are core `affectedReach()`'s Counteds; the distance words are the
// impact panel's; the business lens counts no links.
//
// surfaces/map.js owns the board and calls in here: `paintDistrict()` after it draws a
// district, `affectedBarHtml()` in its chrome, the seed actions on the explore card and
// the property, Esc, and the link (`?affected=<seed>&ahops=N`). The pure parts are
// lib/map-affected-model.js.

import { S, esc, currentLens, bizName, unCode } from '../store.js';
import { t, plainWords } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, countedUnit, defAttrs, plainTip } from '../lib/counted.js';
import { tipAttrs } from '../lib/tooltip.js';
import { withParams } from '../lib/route-url.js';
import {
  AFF_HOPS, AFF_MAX_HOPS, parseSeedSpec, hopsOf, pickSeeds, combineReaches, reachKey, hopGroups, testEvidenceKey,
} from '../lib/map-affected-model.js';

/** The mode's state. `state`: idle · loading · ok · failed · unknown · noParts. */
const AFF = {
  spec: null, hops: AFF_HOPS, state: 'idle', gen: 0,
  /** the parts asked about: `{ id, name, node }` */
  seeds: [],
  /** parts the change touched beyond the ones asked about */
  more: 0,
  /** the seed's own words — a node's name, a work item's key and title, a commit's subject */
  label: '',
  /** where it was picked from: `{ flow }` rings that journey's district */
  origin: null,
  /** one answer per seed, in the seeds' order: `{ seed, report }` */
  entries: [],
  combined: null,
  /** the seed whose answer the Affected tab reads */
  pick: 0,
};
const LISTENERS = new Set();
const biz = () => currentLens() === 'business';
function syncKey() { return String((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''); }
function notify() { for (const fn of LISTENERS) { try { fn(); } catch { /* a listener that throws does not stop the others */ } } }

/** Tell the map when the mode moves (a seed, a distance, an answer, clear). Returns the way to stop listening. @group Map */
export function onAffectedChange(fn) { LISTENERS.add(fn); return () => LISTENERS.delete(fn); }
/** Whether the board is dimmed around something (or about to be). @group Map */
export function affectedOn() { return !!AFF.spec; }
/** Whether the answer is in and the board is drawn dimmed. @group Map */
export function affectedReady() { return AFF.state === 'ok' && !!AFF.combined; }
/** The seed as the link writes it, or null. @group Map */
export function affectedSpec() { return AFF.spec; }
/** The distance the mode asks at. @group Map */
export function affectedHops() { return AFF.hops; }

// ── the answers, one per seed and distance, kept per sync ─────────────────
const CACHE = new Map();
function impactOf(id, hops) {
  const key = id + '|' + hops + '@' + syncKey();
  if (!CACHE.has(key)) {
    CACHE.set(key, fetch('/api/impact?node=' + encodeURIComponent(id) + '&direction=upstream&hops=' + hops + '&tests=1&reach=1')
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return CACHE.get(key);
}
const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const nodeSeed = (id) => { const n = S.BYID && S.BYID[id]; return n ? { id, name: n.name, node: n } : null; };

/** What a seed in the link names: the parts to ask about and the seed's own words. */
async function resolveSeeds(p) {
  if (p.type === 'node' || p.type === 'package') {
    const s = nodeSeed(p.id);
    return s ? { seeds: [s], more: 0, label: biz() ? bizName(s.node) : s.node.name } : { unknown: true };
  }
  if (p.type === 'work') {
    let id = p.id.includes('::') ? p.id : null;
    let label = p.id;
    if (!id) {
      const list = await json('/api/work?q=' + encodeURIComponent(p.id));
      const hit = list && (list.items || []).find((i) => String(i.key).toUpperCase() === p.id.toUpperCase() || i.id === p.id);
      if (!hit) return { unknown: true };
      id = hit.id;
    }
    const ans = await json('/api/work/item/' + encodeURIComponent(id));
    if (!ans || !ans.item) return { unknown: true };
    label = biz() ? (ans.item.title || ans.item.key) : [ans.item.key, ans.item.title].filter(Boolean).join(' · ');
    // the parts its commits touched; else the parts the item is linked to
    let ids = (ans.commits || []).flatMap((c) => c.nodes || []);
    if (!ids.length) ids = (ans.links || []).map((l) => l.id || l.nodeId).filter(Boolean);
    const picked = pickSeeds(ids.map(nodeSeed).filter(Boolean).map((s) => ({ ...s, kind: s.node.kind })));
    return picked.seeds.length ? { seeds: picked.seeds, more: picked.more, label } : { noParts: true, label };
  }
  // a commit: the parts its lines (else its files) touched
  const c = await json('/api/history/commit?sha=' + encodeURIComponent(p.id));
  if (!c) return { unknown: true };
  const subject = String(c.subject || '');
  const label = (biz() ? unCode(subject.replace(/^\w+(?:\([^)]*\))?!?:\s*/, '')) : String(c.sha || '').slice(0, 7) + ' · ' + subject);
  const picked = pickSeeds((c.parts || []).map((x) => nodeSeed(x.node)).filter(Boolean).map((s) => ({ ...s, kind: s.node.kind })));
  return picked.seeds.length ? { seeds: picked.seeds, more: picked.more, label } : { noParts: true, label };
}

/**
 * Dim the board around a seed (`<nodeId>` · `package:<id>` · `work:<KEY>` · `commit:<sha>`), at a distance.
 * The same seed again only changes the distance; `origin.flow` rings the journey it was picked on.
 * @group Map
 * @business Dims the whole map to what reaches the thing picked — the journeys, screens and calls that use it.
 */
export async function setAffected(spec, opts = {}) {
  const p = parseSeedSpec(spec);
  if (!p) { clearAffected(); return; }
  const hops = hopsOf(opts.hops != null ? opts.hops : AFF.spec === p.spec ? AFF.hops : AFF_HOPS);
  if (AFF.spec === p.spec && AFF.hops === hops && AFF.state !== 'failed') return;
  const same = AFF.spec === p.spec && AFF.seeds.length;
  const gen = ++AFF.gen;
  Object.assign(AFF, { spec: p.spec, hops, state: 'loading' });
  if (opts.origin !== undefined) AFF.origin = opts.origin;
  if (!same) Object.assign(AFF, { seeds: [], more: 0, label: '', entries: [], combined: null, pick: 0 });
  notify();
  if (!same) {
    const r = await resolveSeeds(p);
    if (gen !== AFF.gen) return;
    if (r.unknown || r.noParts) { Object.assign(AFF, { state: r.unknown ? 'unknown' : 'noParts', label: r.label || p.id }); notify(); return; }
    Object.assign(AFF, { seeds: r.seeds, more: r.more, label: r.label });
  }
  const reports = await Promise.all(AFF.seeds.map((s) => impactOf(s.id, hops)));
  if (gen !== AFF.gen) return;
  if (reports.some((x) => !x || !x.reach)) { AFF.state = 'failed'; notify(); return; }
  AFF.entries = AFF.seeds.map((s, i) => ({ seed: s.id, report: reports[i] }));
  AFF.combined = combineReaches(AFF.entries.map((e) => ({ seed: e.seed, reach: e.report.reach })));
  AFF.pick = Math.min(AFF.pick, AFF.entries.length - 1);
  AFF.state = 'ok';
  notify();
}
/** Ask again at another distance (the bar's stepper). @group Map */
export function setAffectedHops(h) { if (AFF.spec) setAffected(AFF.spec, { hops: h }); }
/** Leave the mode: the board is lit again. @group Map */
export function clearAffected() {
  if (!AFF.spec && AFF.state === 'idle') return;
  AFF.gen++;
  Object.assign(AFF, { spec: null, hops: AFF_HOPS, state: 'idle', seeds: [], more: 0, label: '', origin: null, entries: [], combined: null, pick: 0 });
  notify();
}
/** Forget the mode without telling anyone — the map is going away. @group Map */
export function resetAffected() {
  AFF.gen++;
  Object.assign(AFF, { spec: null, hops: AFF_HOPS, state: 'idle', seeds: [], more: 0, label: '', origin: null, entries: [], combined: null, pick: 0 });
  LISTENERS.clear();
}
/** Which seed the tab reads. @group Map */
export function pickAffected(i) { if (AFF.entries[i]) { AFF.pick = i; notify(); } }

/** The link parameters for the mode, or nulls that take them out. @group Map */
export function affectedParams() {
  return { affected: AFF.spec || null, ahops: AFF.spec && AFF.hops !== AFF_HOPS ? String(AFF.hops) : null };
}
/** A hash with the mode carried, for links that open another screen or journey in the mode. */
function carry(hash) { return withParams(hash, affectedParams()); }

// ── how a place is reached ────────────────────────────────────────────────
/** A journey's reach, or null. @group Map */
export function journeyReach(flow) { return affectedReady() ? AFF.combined.journeys.get(flow) || null : null; }
/** A screen's reach in one journey, or null. @group Map */
export function screenReach(flow, screenId) { return affectedReady() ? AFF.combined.screens.get(flow + '|' + screenId) || null : null; }
/** A call's or a data node's reach, or null. @group Map */
export function nodeReach(nodeId) { return affectedReady() ? AFF.combined.nodes.get(nodeId) || null : null; }
/** Whether this node is one of the parts asked about. @group Map */
export function isSeed(nodeId) { return AFF.seeds.some((s) => s.id === nodeId); }

function seedName(id) {
  const s = AFF.seeds.find((x) => x.id === id);
  const n = s && s.node;
  return n ? (biz() ? bizName(n) : n.name) : String(id).split('::').pop();
}
/** The words for a distance in the lens on screen. */
function reachWords(hop) {
  return t(reachKey(hop, biz())).replace('{n}', String(hop));
}
/**
 * A badge saying how a place is reached, with a tip: the word's define and, when several parts were asked
 * about, each one and how it reaches here — never a number across them.
 */
export function reachBadgeHtml(r, cls) {
  if (!r) return '';
  const key = reachKey(r.hop, biz());
  const tip = AFF.seeds.length > 1
    ? tipAttrs({ id: 'table', noFocus: true, args: { caption: 'map.affected.bySeeds', rows: r.by.map((b) => [seedName(b.seed), reachWords(b.hop)]) } })
    : tipAttrs({ key, noFocus: true });
  return '<span class="map-affb ' + (cls || '') + (r.hop === 0 ? ' self' : '') + '" data-hop="' + r.hop + '"' + tip + '>' + esc(reachWords(r.hop)) + '</span>';
}
function seedBadgeHtml() {
  return '<span class="map-affb seed"' + tipAttrs({ key: 'map.affected.seed', noFocus: true }) + '>' + esc(t('map.affected.seed')) + '</span>';
}

/**
 * Paint one district for the mode: dimmed unless its journey is reached, badged with how, the journey the
 * thing was picked on ringed; on its street every screen, call and data node likewise. Classes and badges
 * only — nothing is hidden, and with the mode off everything this added is taken away.
 * @group Map
 */
export function paintDistrict(el, flow, model) {
  if (!el) return;
  el.querySelectorAll('.map-affb').forEach((b) => b.remove());
  const marks = el.querySelectorAll('.aff-hit,.aff-dim,.aff-seed');
  marks.forEach((m) => m.classList.remove('aff-hit', 'aff-dim', 'aff-seed'));
  el.classList.remove('aff-hit', 'aff-dim', 'aff-seed');
  if (!affectedReady()) return;
  const jr = journeyReach(flow);
  const screens = (model && model.screens) || [];
  const seedHere = screens.some((s) => isSeed(s.id)) || (AFF.origin && AFF.origin.flow === flow);
  el.classList.add(jr ? 'aff-hit' : 'aff-dim');
  if (seedHere) el.classList.add('aff-seed');
  const jb = jr ? reachBadgeHtml(jr, 'j') : '<span class="map-affb not"' + tipAttrs({ key: 'map.affected.not', noFocus: true }) + '>' + esc(t('map.affected.not')) + '</span>';
  el.querySelectorAll('.map-dhead .agg, .map-dcover-in .agg').forEach((a) => a.insertAdjacentHTML('afterbegin', jb));
  el.querySelectorAll('.map-scr').forEach((sc) => {
    const id = sc.dataset.node;
    const r = screenReach(flow, id);
    sc.classList.add(r ? 'aff-hit' : 'aff-dim');
    if (isSeed(id)) sc.classList.add('aff-seed');
    const ttl = sc.querySelector('.body .ttl');
    if (ttl) ttl.insertAdjacentHTML('afterend', isSeed(id) ? seedBadgeHtml() : r ? reachBadgeHtml(r, 's') : '');
  });
  el.querySelectorAll('.map-pl,.map-pd').forEach((x) => {
    const s = screens[+x.dataset.si];
    const c = s && s.calls[+x.dataset.ci];
    const nodeId = c ? (x.classList.contains('map-pl') ? c.nodeId : (c.data[+x.dataset.di] || {}).nodeId) : null;
    if (!nodeId) { x.classList.add('aff-dim'); return; }
    const seed = isSeed(nodeId);
    const r = nodeReach(nodeId);
    x.classList.add(seed || r ? 'aff-hit' : 'aff-dim');
    if (seed) x.classList.add('aff-seed');
    const html = seed ? seedBadgeHtml() : r ? reachBadgeHtml(r, 'n') : '';
    if (!html) return;
    const at = x.classList.contains('map-pl') ? x.querySelector('.k') : x;
    if (at) at.insertAdjacentHTML('beforeend', html);
  });
}

// ── the mode bar, under the toolbar ───────────────────────────────────────
/**
 * The bar the chrome draws while the mode is on: what the board is dimmed around (in the lens's words), the
 * parts not asked about, the distance stepper (1–5, the current one pressed), the state, and *clear*.
 * @group Map
 */
export function affectedBarHtml() {
  if (!AFF.spec) return '';
  const name = AFF.label || (AFF.seeds[0] ? seedName(AFF.seeds[0].id) : '');
  let state = '';
  if (AFF.state === 'loading') state = '<span class="map-affst"' + defAttrs('map.affected.reading') + '>' + esc(t('map.affected.reading')) + '</span>';
  else if (AFF.state === 'failed') state = '<span class="map-affst warn"' + defAttrs('map.affected.failed') + '>' + esc(t('map.affected.failed')) + '</span>';
  else if (AFF.state === 'unknown') state = '<span class="map-affst warn"' + defAttrs('map.affected.unknown') + '>' + esc(t('map.affected.unknown')) + '</span>';
  else if (AFF.state === 'noParts') state = '<span class="map-affst warn"' + defAttrs('map.affected.noParts') + '>' + esc(t('map.affected.noParts')) + '</span>';
  const more = AFF.more
    ? '<span class="map-affst"><span class="n"' + plainTip(AFF.more, 'map.affected.partsMore', 'map.affected.partsScope', '/api/impact').replace(' tabindex="0"', '') + '>' + AFF.more + '</span> '
      + esc(t('map.affected.partsMore').split('{n}').slice(1).join(String(AFF.more)).trim()) + '</span>' : '';
  let step = '<span class="map-affhops" role="group" aria-label="' + esc(t('impact.hops.label')) + '"><span class="hud-label"' + defAttrs('impact.hops.label') + '>' + esc(t('impact.hops.label')) + '</span>';
  for (let h = 1; h <= AFF_MAX_HOPS; h++) {
    const label = t(h === 1 ? 'impact.hops.buttonOne' : 'impact.hops.button').replace('{n}', String(h));
    step += '<button type="button" data-act="aff-hops" data-h="' + h + '" aria-pressed="' + (h === AFF.hops) + '" aria-label="' + esc(label) + '">' + h + '</button>';
  }
  step += '</span>';
  return '<div class="map-affbar" role="region" aria-label="' + esc(t('map.affected.title')) + '">'
    + '<span class="hud-label ttl"' + defAttrs('map.affected.title') + '>' + esc(t('map.affected.title')) + '</span>'
    + '<span class="on"><span class="hud-label"' + defAttrs('map.affected.on') + '>' + esc(t('map.affected.on')) + '</span> <b class="map-affname">' + esc(name) + '</b></span>'
    + barCounts() + more + step + state
    + '<button type="button" class="map-tb" data-act="aff-clear"' + tipAttrs({ key: 'map.affected.clear', noFocus: true }) + '>' + esc(t('map.affected.clear')) + '</button></div>';
}

/** One seed's journeys and screens — core's own Counteds; several seeds print none here (never a sum across them). */
function barCounts() {
  if (AFF.state !== 'ok' || AFF.entries.length !== 1) return '';
  const k = AFF.entries[0].report.reach.counted;
  return '<span class="map-affn">' + [k.journeys, k.screens].map((c) => countedHtml(c, '/api/impact', { cls: 'map-chip' })).join('') + '</span>';
}

// ── the explore card and the property speak the mode's words ──────────────
/** A chip's words with how its screen is reached, for the card's *on* row while the mode is on. @group Map */
export function screenChipReach(flow, screenId) {
  if (!affectedReady()) return '';
  return reachBadgeHtml(screenReach(flow, screenId), 'c') || '<span class="map-affb not"' + tipAttrs({ key: 'map.affected.not', noFocus: true }) + '>' + esc(t('map.affected.not')) + '</span>';
}
/** How another journey is reached, for the property's *also in* chips while the mode is on. @group Map */
export function journeyChipReach(flow) {
  if (!affectedReady()) return '';
  return reachBadgeHtml(journeyReach(flow), 'c') || '<span class="map-affb not"' + tipAttrs({ key: 'map.affected.not', noFocus: true }) + '>' + esc(t('map.affected.not')) + '</span>';
}

// ── the Affected tab ──────────────────────────────────────────────────────
/** The number on the tab: the picked answer's screens, core's own Counted — or null. @group Map */
export function affectedTabCount() {
  const e = affectedReady() && AFF.entries[AFF.pick];
  return e ? e.report.reach.counted.screens : null;
}
function rowHtml(label, sub, right, href) {
  const open = href ? '<a class="mp-row card" href="' + esc(href) + '">' : '<div class="mp-row">';
  return open + '<div class="l"><span class="nm">' + label + '</span>' + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div>'
    + (right ? '<div class="r">' + right + '</div>' : '') + (href ? '</a>' : '</div>');
}
function groupHead(hop) {
  const key = hop === 0 ? 'map.affected.self' : hop === 1 ? 'impact.hop1' : hop === 2 ? 'impact.hop2' : 'impact.hopN';
  return '<h4 class="hud-label mp-affhop"' + defAttrs(key) + '>' + esc(t(key).replace('{n}', String(hop - 1))) + '</h4>';
}
function flowName(id, fallback) {
  const d = S.BYID && S.BYID[id];
  const name = (d && d.name) || fallback || id;
  return biz() ? plainWords(name) || name : name;
}
function callName(id, fallback) {
  const n = S.BYID && S.BYID[id];
  if (!n) return fallback || id;
  return biz() ? bizName(n) : n.name;
}
function testsHtml(tests) {
  if (!tests.length) return '';
  if (biz()) {
    const levels = {};
    for (const x of tests) levels[x.level] = (levels[x.level] || 0) + 1;
    const rows = Object.keys(levels).sort().map((k) => [t('tests.level.' + k), levels[k]]);
    return '<div class="mp-row none"><span class="mp-note"' + plainTip(tests.length, 'map.affected.testsBiz', 'count.scope.affected', '/api/impact', rows) + '>'
      + esc(t('map.affected.testsBiz').replace('{n}', String(tests.length))) + '</span></div>';
  }
  return '<div class="mp-affsub hud-label"' + defAttrs('map.affected.tests') + '>' + esc(t('map.affected.tests')) + '</div>'
    + tests.map((x) => rowHtml(esc(x.name), esc(t('tests.level.' + x.level)), '<span class="api-chip"' + defAttrs(testEvidenceKey(x)) + '>' + esc(t(testEvidenceKey(x))) + '</span>')).join('');
}
function boundHtml(r) {
  if (r.bound !== 'floor') return '<p class="mp-dim mp-affbound"' + defAttrs('impact.bound.exact') + '>' + esc(t('impact.bound.exact')) + '</p>';
  if (!biz()) return '<p class="mp-dim mp-affbound"' + defAttrs('impact.bound.floor') + '>' + esc(t('impact.bound.floor').replace('{why}', (r.uncertainty && r.uncertainty.note) || '')) + '</p>';
  const why = [];
  if (r.cutPoints.length) why.push(t('impact.biz.why.cut'));
  if (r.hops.some((h) => h.nodes.some((n) => n.oneOf))) why.push(t('impact.biz.why.runtime'));
  if (r.hops.some((h) => h.nodes.some((n) => !n.via.resolution || n.strength.unstamped))) why.push(t('impact.biz.why.unrecorded'));
  return '<p class="mp-dim mp-affbound"' + defAttrs('impact.biz.floor') + '>' + esc(t('impact.biz.floor').replace('{why}', why.join('; '))) + '</p>';
}
function stopsHtml(r) {
  const stops = r.cutPoints.filter((c) => c.nodeId);
  if (!stops.length) return '';
  const rows = stops.map((c) => {
    const n = S.BYID && S.BYID[c.nodeId];
    const name = n ? (biz() ? bizName(n) : n.name) : c.name || '';
    if (biz()) return rowHtml(esc(t('map.affected.stop').replace('{name}', name)), '', '');
    const why = c.reason === 'shared' ? t('impact.sharedHere') : c.reason === 'setup' ? t('impact.excluded.setup') : c.reason === 'deferred' ? t('impact.excluded.deferred') : t('impact.notWalked');
    return rowHtml(esc(name), esc(why), '<span' + plainTip(c.behind, 'impact.behind', 'count.scope.affected', '/api/impact') + '>' + esc(t('impact.behind').replace('{n}', String(c.behind))) + '</span>');
  });
  return '<section class="mp-sec mp-affstops"><h3 class="hud-label"' + defAttrs('impact.notWalked') + '>' + esc(t('impact.notWalked')) + '</h3>' + rows.join('') + '</section>';
}

/**
 * The property's Affected tab: what reaches the seed — journeys, screens, calls and tests — one distance at a
 * time, with the answer's four Counteds, the floor line and where it stopped. `ctx` is the property's
 * (its journey and street model, so a screen of the same journey opens in place).
 * @group Map
 */
export function affectedTabHtml(ctx) {
  if (!AFF.spec) return '<div class="mp-row none"><span class="mp-note"' + defAttrs('map.affected.tabOff') + '>' + sym('absent') + esc(t('map.affected.tabOff')) + '</span></div>';
  if (AFF.state !== 'ok') return '<div class="mp-row none mp-loading">' + affectedBarState() + '</div>';
  const e = AFF.entries[AFF.pick];
  const r = e.report;
  const reach = r.reach;
  const k = reach.counted;
  const pick = AFF.entries.length > 1
    ? '<div class="mp-affpick"><span class="hud-label"' + defAttrs('map.affected.seedFor') + '>' + esc(t('map.affected.seedFor')) + '</span>'
      + AFF.entries.map((x, i) => '<button type="button" class="api-chip' + (i === AFF.pick ? ' on' : '') + '" data-act="aff-pick" data-i="' + i + '" aria-pressed="' + (i === AFF.pick) + '">' + esc(seedName(x.seed)) + '</button>').join('') + '</div>' : '';
  const counts = [k.journeys, k.screens, k.calls, k.tests].filter((c) => countedUnit(c))
    .map((c) => countedHtml(c, '/api/impact', { cls: 'mp-chip' })).join('');
  const scope = '<div class="mp-affscope"><span class="hud-label"' + defAttrs('count.scope.affected') + '>' + esc(t('count.scope.affected')) + '</span> <b>' + esc(seedName(e.seed)) + '</b></div>';
  const groups = hopGroups(r).map((g) => {
    const j = g.journeys.map((x) => rowHtml(esc(flowName(x.flowId, x.name)), '', '', carry('#/map/' + encodeURIComponent(x.flowId))));
    const s = g.screens.map((x) => rowHtml(esc(x.name), esc(flowName(x.flowId)), '', carry('#/map/' + encodeURIComponent(x.flowId) + '?node=' + encodeURIComponent(x.screenId))));
    const c = g.calls.map((x) => rowHtml(esc(callName(x.nodeId, x.name)), biz() ? '' : '<code>' + esc(x.name) + '</code>', isSeed(x.nodeId) ? '<span class="api-chip">' + esc(t('map.affected.seed')) + '</span>' : ''));
    const sub = (key, rows) => (rows.length ? '<div class="mp-affsub hud-label"' + defAttrs(key) + '>' + esc(t(key)) + '</div>' + rows.join('') : '');
    return '<section class="mp-sec mp-affgroup" data-hop="' + g.hop + '">' + groupHead(g.hop)
      + sub('map.affected.journeys', j) + sub('map.affected.screens', s) + sub('map.affected.calls', c) + testsHtml(g.tests) + '</section>';
  }).join('');
  return '<section class="mp-sec mp-aff">' + pick + scope + '<div class="mp-chips">' + counts + '</div>' + boundHtml(r) + '</section>'
    + (groups || '<div class="mp-row none">' + esc(t('impact.none')) + '</div>') + stopsHtml(r);
}
function affectedBarState() {
  const key = AFF.state === 'loading' ? 'map.affected.reading' : AFF.state === 'unknown' ? 'map.affected.unknown' : AFF.state === 'noParts' ? 'map.affected.noParts' : 'map.affected.failed';
  return '<span class="mp-note"' + defAttrs(key) + '>' + esc(t(key)) + '</span>';
}
