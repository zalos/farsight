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

import { S, esc, currentLens, bizName, repoOf } from '../store.js';
import { t, plainWords, evidenceWord } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, countedUnit, defAttrs, plainTip, unCode } from '../lib/counted.js';
import { tipAttrs } from '../lib/tooltip.js';
import { designThumbHtml, linkHtml } from '../lib/graph-render.js';
import { storyChipsHtml, screenStoryIds } from '../stories.js';
import { workSourcesConfigured, flowWork, stateHtml, sourceName } from '../work-chips.js';
import {
  jrnGateLabel, jrnGatesShown, jrnAbsentHtml, jrnWords, jrnRefAnchors,
  jrnFoldFacts, jrnEvChipHtml, jrnObsText, jrnRunLineHtml, jrnFootScopeHtml,
} from './journeys.js';
import { propertyModel } from '../lib/map-property-model.js';

/** The rail's tabs, in order. */
export const MAP_PROP_TABS = ['overview', 'gates', 'apis', 'ux', 'tests', 'route', 'work', 'changes'];
const TAB_KEY = (tab) => 'map.prop.tab.' + tab;
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
/** One row of a list: a label and a sub-line on the left, a short fact on the right; `card` makes it addressable by the explore card. */
function row(label, sub, right, card) {
  const attrs = card && card.id ? ' data-map-card="' + esc(card.kind) + '" data-id="' + esc(card.id) + '"' : '';
  return '<div class="mp-row' + (card && card.id ? ' card' : '') + '"' + attrs + '><div class="l"><span class="nm">' + label + '</span>'
    + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div>' + (right ? '<div class="r">' + right + '</div>' : '') + '</div>';
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
    + (s.business || pm.tabs.overview.business ? '<p class="say">' + esc(wordsOr(pm.tabs.overview.business)) + '</p>' : '')
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
    + (n ? storyChipsHtml(screenStoryIds(n, pm.hero.components.map((c) => c.id))) : '')
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
}

// ── tab bodies ──────────────────────────────────────────────────────────────

function serviceTag(c) {
  const svc = c.service;
  const cls = svc ? 'svc-' + svc.index : 'svc-none';
  const word = svc ? svc.label : t('map.prop.apis.noService');
  return '<span class="mp-svc ' + esc(cls) + '"' + (svc ? '' : defAttrs('map.prop.apis.noService')) + '>' + esc(word) + '</span>';
}
function evChip(ev) {
  const key = EV_KEY[ev];
  if (!key) return '';
  return '<span class="api-chip mp-evc ' + (ev === 'spec-backed' ? 'ok' : ev === 'implied' ? 'warn' : 'stub') + '" data-ev="' + esc(ev) + '"' + defAttrs(key) + '>' + esc(t(key)) + '</span>';
}
/** What a call is for, in the lens on screen. */
function callWords(c) {
  const mo = c.moment || {};
  if (biz()) return plainWords(c.summary) || plainWords(c.business) || plainWords(c.label) || plainWords(mo.business) || t('journey.biz.noWords');
  return String(c.summary || c.label || mo.label || c.operationId || '');
}
function dataWords(data) {
  const lower = (w) => (biz() ? w.replace(/^./, (ch) => ch.toLowerCase()) : w);
  const byMode = (mode) => data.filter((d) => d.mode === mode || d.mode === 'both').map((d) => lower(nameOf(S.BYID[d.nodeId], d.name)));
  const r = byMode('read'), w = byMode('write');
  return [r.length ? t('map.prop.apis.reads').replace('{list}', r.join(', ')) : '', w.length ? t('map.prop.apis.writes').replace('{list}', w.join(', ')) : ''].filter(Boolean).join(' · ');
}
function callRow(c, brief) {
  const verb = !biz() && (c.method || c.path) ? code([c.method, c.path].filter(Boolean).join(' ')) : '';
  const data = (c.data || []).length ? esc(dataWords(c.data)) : (c.evidence === 'not built' || c.evidence === 'declared' ? '' : '<span class="mp-dim"' + defAttrs('map.prop.apis.noData') + '>' + esc(t('map.prop.apis.noData')) + '</span>');
  const again = c.repeat ? ' <span class="mp-dim"' + defAttrs('map.prop.apis.repeat') + '>' + sym('sync') + esc(t('map.prop.apis.repeat')) + '</span>' : '';
  const sub = brief ? verb : [verb, data].filter(Boolean).join(' · ');
  return row(serviceTag(c) + esc(callWords(c)) + again, sub, evChip(c.evidence), { kind: 'call', id: c.nodeId });
}
function gateRow(g) {
  const label = jrnGateLabel(g);
  const kindKey = g.kind === 'guard' ? 'map.prop.kind.guard' : 'map.prop.kind.rule';
  const sub = '<span' + defAttrs(kindKey) + '>' + esc(t(kindKey)) + '</span>'
    + (g.planned ? ' · <span' + defAttrs('map.prop.planned') + '>' + esc(t('map.prop.planned')) + '</span>' : '');
  const times = g.count > 1 ? '<span class="mp-dim"' + plainTip(g.count, 'map.prop.times', 'journey.scopeHere', '/api/journey') + '>' + esc(t('map.prop.times').replace('{n}', g.count)) + '</span>' : '';
  return row(sym(g.kind === 'guard' ? 'gate' : 'warning') + esc(label), sub, times, { kind: 'gate', id: g.id });
}
function gateList(rows) {
  const shown = jrnGatesShown(rows);
  if (!shown.rows.length) return absentRow('noneIndexed');
  return shown.drawn.map(gateRow).join('')
    + (shown.mute ? '<div class="mp-row none"><span class="mp-note"' + plainTip(shown.mute, 'map.prop.gates.mute', 'journey.scopeHere', '/api/journey') + '>'
      + esc(t('map.prop.gates.mute').replace('{n}', shown.mute)) + '</span></div>' : '');
}

function overviewHtml(pm, st) {
  const o = pm.tabs.overview;
  const glance = o.glance.map((c) => countWords(c)).filter(Boolean).join('')
    + (pm.hero.planned ? '<span class="api-chip stub"' + defAttrs('design.status.designOnly') + '>' + esc(t('design.status.designOnly')) + '</span>' : '');
  const calls = o.calls.length ? o.calls.map((c) => callRow(c, true)).join('') : (pm.tabs.apis.planned ? absentRow('notBuilt') : absentRow('noneIndexed'));
  return sec('map.prop.ov.what', '<div class="mp-biz">' + esc(wordsOr(o.business)) + '</div>')
    + (glance ? sec('map.prop.ov.glance', '<div class="mp-chips">' + glance + '</div>') : '')
    + sec('map.prop.ov.calls', calls)
    + sec('map.prop.ov.gates', gateList(o.gates))
    + sec('map.prop.ov.work', workRowsHtml(pm, st, true));
}

function gatesHtml(pm) {
  const g = pm.tabs.gates;
  const decs = biz() ? g.decisions.filter((d) => d.class === 'business') : g.decisions;
  const decRows = decs.map((d) => {
    const at = S.BYID[d.nodeId];
    const sub = biz() ? '' : esc([at ? at.name : '', currentLens() === 'code' && at && at.loc ? at.loc.path + ':' + d.line : ''].filter(Boolean).join(' · '));
    return row(sym('decision') + esc(wordsOr(d.label)), sub, '', { kind: 'decision', id: d.nodeId });
  }).join('');
  return '<section class="mp-sec">' + secHead('map.prop.gates.head', countNum(g.counted)) + gateList(g.rows) + '</section>'
    + '<section class="mp-sec">' + secHead('map.prop.gates.decisions', decs.length === g.decisions.length ? countNum(g.decisionsCounted) : '')
    + (decRows || absentRow('noneIndexed')) + '</section>';
}

function apisHtml(pm) {
  const a = pm.tabs.apis;
  const head = secHead('map.prop.apis.head', countNum(pm.counts.apis));
  const notBuilt = a.planned ? '<p class="mp-warn">' + sym('warning') + esc(t('map.prop.apis.notBuilt')) + '</p>' : '';
  const calls = a.calls.length ? a.calls.map((c) => callRow(c, false)).join('') : absentRow(a.planned ? 'notBuilt' : 'noneIndexed');
  const recs = a.records.length ? a.records.map((r) => {
    const n = S.BYID[r.nodeId];
    const kindKey = r.kind === 'message' ? 'sym.message' : r.kind === 'external' ? 'sym.external' : 'sym.record';
    const modes = r.modes.length > 1 ? t('map.prop.apis.readsWrites') : r.modes[0] === 'write' ? t('map.prop.apis.writes').replace('{list}', '').trim() : t('map.prop.apis.reads').replace('{list}', '').trim();
    return row(sym(r.kind === 'message' ? 'message' : r.kind === 'external' ? 'external' : 'record') + esc(nameOf(n, r.name)),
      '<span' + defAttrs(kindKey) + '>' + esc(t(kindKey)) + '</span> · ' + esc(modes), '', { kind: r.kind || 'record', id: r.nodeId });
  }).join('') : absentRow(a.planned ? 'notBuilt' : 'noneIndexed');
  return notBuilt + '<section class="mp-sec">' + head + calls + '</section>' + sec('map.prop.apis.records', recs);
}

function uxHtml(pm) {
  const u = pm.tabs.ux;
  const n = u.page;
  const page = n && u.built
    ? row(biz() ? esc(pm.screen.name || nameOf(n)) : code(n.name), biz() ? '' : esc(loc(n.loc || (pm.screen.segment.screen || {}).loc)),
      '<span' + defAttrs('map.prop.kind.page') + '>' + esc(t('map.prop.kind.page')) + '</span>', { kind: 'page', id: n.id })
    : lineRow('map.prop.ux.noPage');
  const comps = u.components.length ? u.components.map((c) => row(biz() ? esc(nameOf(c)) : code(c.name),
    biz() ? '' : esc(loc(c.loc)), '<span' + defAttrs('map.prop.kind.component') + '>' + esc(t('map.prop.kind.component')) + '</span>', { kind: 'component', id: c.id })).join('')
    : absentRow(u.built ? 'noneIndexed' : 'notBuilt');
  const stories = n ? storyChipsHtml(screenStoryIds(n, u.components.map((c) => c.id))) : '';
  return sec('map.prop.ux.page', page) + sec('map.prop.ux.components', comps) + sec('map.prop.ux.stories', stories || absentRow('noneIndexed'));
}

function caseRow(x) {
  const how = x.observedVia === 'declaration' && x.status === 'passed' ? 'map.prop.tests.byDeclaration'
    : x.evidence === 'observed' ? 'map.prop.tests.byRun' : 'map.prop.tests.reached';
  const name = biz() ? (/\/|[a-z][A-Z]|_|\.[a-z]{2,4}\b/.test(x.name || '') ? unCode(x.name) : String(x.name || '')) : String(x.name || '');
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
  const reportRow = (x) => row(esc(biz() ? unCode(x.name || '') : String(x.name || '')), biz() ? '' : esc([x.runner || '', currentLens() === 'code' ? loc(x.loc) : ''].filter(Boolean).join(' · ')),
    '<span class="mp-ev reached"' + defAttrs('tests.evidence.runSeen') + '>' + esc(t('tests.evidence.runSeen')) + '</span>', { kind: 'test', id: x.id });
  return '<section class="mp-sec"><h3 class="hud-label"' + defAttrs('map.prop.tests.head') + '>' + esc(t('map.prop.tests.head')) + '</h3><div class="jrn-tfoot mp-tfoot">' + foot + '</div></section>'
    + '<section class="mp-sec">' + secHead('map.prop.tests.cases', countNum(k.tests)) + (cases.length ? cases.map(caseRow).join('') : absentRow('noneIndexed')) + '</section>'
    + (reports.length ? '<section class="mp-sec">' + secHead('map.prop.tests.reports', countNum(k.runReports)) + reports.map(reportRow).join('') + '</section>' : '')
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
  const jl = [['requires', 'journey.requires'], ['leadsTo', 'journey.leadsTo'], ['partOf', 'journey.partOf']].flatMap(([k, key]) => (links[k] || []).map((x) => {
    const id = typeof x === 'string' ? x : x.id || x.nodeId;
    const nm = typeof x === 'string' ? (S.BYID[x] ? nameOf(S.BYID[x]) : x) : x.name || (S.BYID[id] ? nameOf(S.BYID[id]) : id);
    return row(esc(nm), '<span' + defAttrs(key) + '>' + esc(t(key)) + '</span>', '', null);
  })).join('');
  const ways = r.otherWays.map((w) => row(esc(nameOf(w.node, w.nodeId.split('::').pop())), biz() ? '' : esc(w.kind), '', { kind: (w.node && w.node.kind) || 'node', id: w.nodeId })).join('');
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
  return w.items.map((it) => row(sym('work') + (biz() ? '' : '<b class="mp-key">' + esc(it.key || '') + '</b> ') + esc(it.title || ''),
    brief ? '' : esc(sourceName(it.source)), stateHtml(it.state), null)).join('')
    + (brief ? '' : '<div class="mp-more"><a href="#/work">' + esc(t('nav.work')) + '</a></div>');
}

function workHtml(pm, st) {
  const w = st.work;
  const findings = w && w.findings && w.findings.length
    ? w.findings.map((f) => {
      let text = f.key && S.STRINGS && S.STRINGS[f.key] ? t(f.key) : f.text || '';
      Object.entries(f.vars || {}).forEach(([k, v]) => { text = text.split('{' + k + '}').join(String(v)); });
      return row(sym('warning') + esc(biz() ? plainWords(text) || t('journey.biz.noWords') : text), '', '', null);
    }).join('') : (w && w.items ? absentRow('noneIndexed') : '');
  return '<section class="mp-sec">' + secHead('map.prop.work.head', w && w.counted ? countNum(w.counted, '/api/work/links') : '') + workRowsHtml(pm, st, false) + '</section>'
    + (findings ? sec('map.prop.work.findings', findings) : '');
}

/** The changes the latest sync measured against the one before it, kept to this screen's parts. */
function loadChanges(pm) {
  const repo = pm.node ? repoOf(pm.node) : '';
  return lazy('changes|' + repo + '|' + pm.changeIds.join(','), async () => {
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
    if (!r) return { failed: true };
    if (r.status === 503) return { off: true };
    if (r.status === 400) return { noEarlier: true };
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || !body.diff) return { failed: true };
    const ids = new Set(pm.changeIds);
    const list = (body.diff.changes || []).filter((c) => c.subject && ids.has(c.subject.id));
    return { base: body.baseSync, head: body.headSync, list, sentences: body.sentences || {} };
  });
}

function changesHtml(pm, st) {
  const c = st.changes;
  let body;
  if (!c) body = '<div class="mp-row none mp-loading">' + esc(t('map.prop.loading')) + '</div>';
  else if (c.off) body = lineRow('map.prop.changes.noHistory');
  else if (c.failed) body = lineRow('map.prop.changes.failed');
  else if (c.noEarlier) body = lineRow('map.prop.changes.noEarlier');
  else if (!c.list.length) body = lineRow('map.prop.changes.none');
  else {
    body = c.list.map((x) => {
      const s = c.sentences[x.id] || x.kind;
      const sub = biz() ? '' : esc([x.kind, x.subject && x.subject.name, currentLens() === 'code' ? loc(x.loc) : ''].filter(Boolean).join(' · '));
      return row(esc(biz() ? unCode(s) : s), sub, '<span class="api-chip ' + (x.severity === 'breaking' ? 'warn' : '') + '"' + defAttrs('changes.sev.' + x.severity) + '>' + esc(t('changes.sev.' + x.severity)) + '</span>', { kind: (x.subject && x.subject.kind) || 'node', id: x.subject && x.subject.id });
    }).join('');
  }
  const range = c && c.base != null ? '<p class="mp-dim"' + defAttrs('map.prop.changes.range') + '>' + esc(t('map.prop.changes.range').replace('{base}', c.base).replace('{head}', c.head)) + '</p>' : '';
  return sec('map.prop.changes.head', range + body);
}

// ── the frame ───────────────────────────────────────────────────────────────

function tabsHtml(pm, st) {
  const count = (tab) => {
    const c = tab === 'work' ? (st.work && st.work.counted) || null : pm.counts[tab];
    return c ? countNum(c, tab === 'work' ? '/api/work/links' : '/api/journey') : '';
  };
  return MAP_PROP_TABS.map((tab) => {
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
    default: return overviewHtml(pm, st);
  }
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
    + pm.alsoIn.map((f) => '<a class="api-chip mp-alsochip" href="#/map/' + encodeURIComponent(f.id) + '?node=' + encodeURIComponent(pm.node.id) + '">' + esc(biz() ? plainWords(f.name) || f.name : f.name) + '</a>').join('') + '</div>' : '';
  const where = t('map.prop.foot.step').replace('{n}', pm.index + 1).replace('{m}', pm.total).replace('{journey}', j.name || '');
  return step(-1, pm.prev)
    + '<div class="mp-mid"><span class="hud-label mp-where"' + tipAttrs({ key: 'map.prop.foot.step' }) + '>' + esc(where) + '</span><div class="mp-dots">' + dots + '</div>' + also + '</div>'
    + step(1, pm.next);
}

function headHtml(pm, ctx) {
  const j = (ctx.model && ctx.model.journey) || {};
  return '<button class="btn mp-back" data-act="back"' + defAttrs('map.prop.back') + '>' + esc(t('map.prop.back')) + '</button>'
    + '<nav class="mp-crumb" aria-label="' + esc(t('map.prop.level')) + '"><span class="hud-label">' + esc(t('map.prop.crumb')) + '</span><span class="sep">›</span>'
    + '<span>' + esc(j.name || '') + '</span><span class="sep">›</span><b>' + esc(pm.screen.name || '') + '</b>'
    + (biz() || !pm.tabs.route.route ? '' : '<span class="sep">·</span>' + code(pm.tabs.route.route)) + '</nav>'
    + '<span class="hud-label mp-level"' + defAttrs('map.prop.level') + '>' + esc(t('map.prop.level')) + '</span>';
}

/**
 * Mount the property of one screen into `host` (lane A's full-stage overlay).
 * Returns `update(ctx)` — redraw in place for a new screen, lens or answer — and
 * `destroy()`.
 * @group Map
 */
export function mountMapProperty(host, ctx) {
  const st = { ctx, tab: 'overview', pm: null, work: null, changes: null, key: '' };
  host.classList.add('mp-host');

  function build() {
    const c = st.ctx;
    st.pm = propertyModel(c.data, c.screenIndex, S.BYID || {}, c.model, { edges: (S.GRAPH && S.GRAPH.edges) || [] });
    const key = (c.flow || '') + '|' + (st.pm && st.pm.node ? st.pm.node.id : c.screenIndex);
    if (key !== st.key) { st.key = key; st.work = null; st.changes = null; }
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
  function drawTabs() { const el = host.querySelector('.mp-tabs'); if (el && st.pm) el.innerHTML = tabsHtml(st.pm, st); }
  function drawBody() { const el = host.querySelector('.mp-body'); if (el && st.pm) { el.innerHTML = bodyHtml(st.pm, st); el.setAttribute('aria-labelledby', 'mp-tab-' + st.tab); } }
  function render() {
    build();
    const pm = st.pm;
    if (!pm) { host.innerHTML = '<div class="mp mp-empty">' + absentRow('noneIndexed') + '</div>'; return; }
    host.innerHTML = '<div class="mp' + (pm.hero.planned ? ' planned' : '') + '" data-map-wheel="own" data-screen="' + esc(pm.node ? pm.node.id : '') + '">'
      + '<header class="mp-head">' + headHtml(pm, st.ctx) + '</header>'
      + '<div class="mp-hero">' + heroHtml(pm) + '</div>'
      + '<aside class="mp-side"><div class="mp-tabs" role="tablist" aria-label="' + esc(t('map.prop.tabs')) + '">' + tabsHtml(pm, st) + '</div>'
      + '<div class="mp-body" id="mp-body" role="tabpanel" aria-labelledby="mp-tab-' + st.tab + '"></div></aside>'
      + '<footer class="mp-foot">' + footHtml(pm, st.ctx) + '</footer></div>';
    drawBody();
    wireHero(host);
    fetchLazy();
  }
  function setTab(tab, focus) {
    if (!MAP_PROP_TABS.includes(tab)) return;
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
    if (!act || !host.contains(act)) return;
    const c = st.ctx;
    if (act.dataset.act === 'back' && c.onClose) c.onClose();
    else if (act.dataset.act === 'step' && c.onStep) c.onStep(Number(act.dataset.d));
    else if (act.dataset.act === 'go' && c.onOpenScreen) c.onOpenScreen(Number(act.dataset.i));
  }
  function onKey(e) {
    const tab = e.target.closest && e.target.closest('.mp-tab');
    if (!tab) return;
    const i = MAP_PROP_TABS.indexOf(st.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = MAP_PROP_TABS[(i + 1) % MAP_PROP_TABS.length];
    else if (e.key === 'ArrowLeft') next = MAP_PROP_TABS[(i - 1 + MAP_PROP_TABS.length) % MAP_PROP_TABS.length];
    else if (e.key === 'Home') next = MAP_PROP_TABS[0];
    else if (e.key === 'End') next = MAP_PROP_TABS[MAP_PROP_TABS.length - 1];
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
