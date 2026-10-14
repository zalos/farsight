// lib/gate-card.js — a gate answers its click (swarm-fixes round 2026-10-05, finding 4).
//
// Clicking a gate anywhere — the journey's gate lists (timeline, Sheet, storyboard, ladder), the drill's gate box
// and its inspector, the Map property's Gates tab, the code map's gate badge and inspector rows — opens ONE card,
// the same card whichever surface opened it: what the gate allows (the words somebody wrote, else who should write
// them), where it stands (the calls a request goes through to meet it, the pages that meet it while they draw,
// the parts it sits on), its own code (wrapped, never cut at a column), the calls it guards (each a door to its
// contract and handler) and the tests that reach it (with the evidence word of the fold). The doors sit on the
// card's head, not behind a ▸. The business register keeps the sentence, the scope and the tests, and drops the
// doors into code (the doors rule).
//
// The card is a pinned rich tip (lib/tooltip.js `showTip`) — the layer every rich detail already opens in: portalled
// to <body>, Esc closes it before anything else and puts the focus back on the gate, Tab walks into it. The facts
// the page has by lookup are folded by `lib/gate-card-model.js`; the calls and the tests come from
// `GET /api/gate?node=` (core `gateCard()`), one answer per gate per sync.
//
// A surface makes a gate open the card with `gateAttrs(id, { step, config })` on the element that names it; the
// click, Enter and Space are answered here.

import { loadDecisions, decisionsOn, decisionChipHtml, decisionCardHtml } from './decisions.js';
import { S, esc, expose, currentLens } from '../store.js';
import { t, plainWords, refusalWords } from '../strings.js';
import { sym } from '../sym.js';
import { showTip, hideTip, tipAnchor, tipOpen, repositionTip } from './tooltip.js';
import { doorsFor, doorsHtml, fetchSource, copyDoorsHtml } from './detail-doors.js';
import { countedHtml, defAttrs } from './counted.js';
import { mapEvidenceChip } from './map-chips.js';
import { testChipHtml } from './test-chip.js';
import { gateCardModel } from './gate-card-model.js';
import { jrnGateInWords, jrnGateText, jrnRoleWords } from './journey-draw.js';

const API = '/api/gate';
/** How long the card waits for the service before it opens with *reading what reaches it…* instead. */
const WAIT_MS = 350;

// ── the service's answer, one per gate per sync ─────────────────────────────
const ANSWERS = new Map();
function syncKey() { return String((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''); }
/** `/api/gate?node=` for one gate: the answer, or false when it could not be read. */
export function fetchGate(id) {
  const k = id + '@' + syncKey();
  if (!ANSWERS.has(k)) {
    ANSWERS.set(k, fetch(API + '?node=' + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : false)).catch(() => false));
  }
  return ANSWERS.get(k);
}

/**
 * The attributes that make an element open the gate card: its id, a tab stop, and a button's role. `step` is
 * the walk order a journey met it at (the card offers *show it in the journey*); `config` is the journey's own
 * word that it is a config check.
 */
export function gateAttrs(id, opts = {}) {
  if (!id) return '';
  return ' data-gate-card="' + esc(id) + '" data-tip-anchor="' + esc('gate:' + id) + '"' + (opts.step != null ? ' data-gate-step="' + esc(String(opts.step)) + '"' : '')
    + (opts.config ? ' data-gate-config="1"' : '') + ' tabindex="0" role="button" aria-haspopup="dialog"'
    + ' onclick="openGateCard(this, event)"';
}

// ── the card ────────────────────────────────────────────────────────────────
function biz() { return currentLens() === 'business'; }
/** The gate's name in the register on screen: its words in business (never the identifier), its name elsewhere. */
function gateName(m) {
  const n = m.facts.node;
  // a precondition is named by its sentence everywhere but the code register, which prints its code form
  if (m.precondition && currentLens() !== 'code') return biz() ? plainWords(m.precondition.words) || m.precondition.words : m.precondition.words;
  if (currentLens() === 'code') return jrnGateText(n) || n.name;
  return gateWords(m) || (biz() ? t('gate.unnamed') : jrnGateText(n) || n.name);
}
/**
 * The words the app wrote for a gate, in the order a reader trusts them (outsider round 2026-10-13, F2): the
 * precondition's sentence, the `@business` sentence, the `@guard` label when it is words, else ''. Never the
 * identifier — the hybrid register prints the code form beside these words (`gateCodeForm`), not instead of them.
 */
export function gateWords(m) {
  if (m.precondition && m.precondition.words) return biz() ? plainWords(m.precondition.words) || m.precondition.words : m.precondition.words;
  const b = m.facts.business;
  if (b) return biz() ? plainWords(b) || b : b;
  const w = jrnGateInWords(m.facts.node);
  return w ? (biz() ? plainWords(w) || '' : w) : '';
}
/** The code form the hybrid register prints beside the words: the gate's own name, when the title is not it already. */
function gateCodeForm(m) {
  if (currentLens() !== 'hybrid' || m.precondition) return '';
  const code = jrnGateText(m.facts.node) || m.facts.node.name;
  return code && code !== gateName(m) ? '<code class="gc-codeform">' + esc(code) + '</code>' : '';
}
function kindKey(m) {
  if (m.precondition) return 'gate.kind.precondition';
  return m.kind === 'config' ? 'gate.kind.config' : m.kind === 'rule' ? 'gate.kind.rule' : 'gate.kind.guard';
}
/** Who it matters to and why (gates lane 2026-10-10): the tier chip, the class in words, the code form, where the tier came from. */
function tierHtml(m) {
  const l = m.tier;
  if (!l) return '';
  return '<section class="gc-sec" data-gc-sec="tier">' + secHead('gate.tier.head')
    + '<p class="gc-tier"><span class="gate-tier ' + esc(l.tier) + '"' + defAttrs(l.tierKey) + '>' + esc(t(l.tierKey)) + '</span> '
    + '<span' + defAttrs(l.classKey) + '>' + esc(t(l.classKey)) + '</span>'
    + (l.code ? ' <code>(' + esc(l.code) + ')</code>' : '') + '</p>'
    + '<p class="gc-dim"' + defAttrs(l.fromKey) + '>' + esc(t(l.fromKey)) + '</p></section>';
}
function secHead(key, extra) {
  return '<h4 class="gc-h"><span' + defAttrs(key) + '>' + esc(t(key)) + '</span>' + (extra ? ' ' + extra : '') + '</h4>';
}
function fill(s, vars) {
  let out = String(s);
  for (const [k, v] of Object.entries(vars || {})) out = out.split('{' + k + '}').join(String(v));
  return out;
}
/** The lines of the gate's own code, each wrapping under its own number — never cut at the card's edge. */
function codeHtml(src) {
  if (!src || src.code == null || src.code === '') return '<span class="dd-load">' + esc(t('door.codeNone')) + '</span>';
  const lines = String(src.code).split('\n');
  const cap = 80;
  const start = src.line || 1;
  return '<div class="gc-pre">' + lines.slice(0, cap).map((l, i) => '<span class="gc-l"><span class="ln">' + (start + i) + '</span>' + esc(l) + '</span>').join('') + '</div>'
    + (lines.length > cap || src.codeTruncated ? '<span class="dd-load">' + esc(t('door.codeMore')) + '</span>' : '');
}
function sentenceHtml(m) {
  const s = m.sentence;
  // a precondition says its own sentence, then what happens otherwise
  if (m.precondition) {
    const w = m.precondition.words || '';
    return '<p class="gc-says">' + esc(biz() ? plainWords(w) || w : w) + '</p>'
      + (m.precondition.else ? '<p class="gc-dim"' + defAttrs('gate.pre.else') + '>' + esc(fill(t('gate.pre.else'), { else: refusalWords(m.precondition.else, currentLens()) })) + '</p>' : '')
      + (m.precondition.via ? '<p class="gc-dim"' + defAttrs('gate.pre.via.' + m.precondition.via) + '>' + esc(t('gate.pre.via.' + m.precondition.via)) + '</p>' : '');
  }
  const says = s.says.source === 'business' ? (biz() ? plainWords(s.says.words) : s.says.words)
    : s.says.source === 'phrase' ? fill(t(s.says.key), { words: biz() ? plainWords(s.says.words) : s.says.words })
      : t(s.says.key);
  return '<p class="gc-says' + (s.says.source === 'none' ? ' none' : '') + '"' + (s.says.source === 'none' ? defAttrs('gate.says.none') : '') + '>' + esc(says) + '</p>'
    + (s.who ? '<p class="gc-who"' + defAttrs(s.who.key) + '>' + sym('warning') + esc(fill(t(s.who.key), s.who.vars)) + '</p>' : '')
    + (s.config ? '<p class="gc-config"' + defAttrs(s.config) + '>' + esc(t(s.config)) + '</p>' : '')
    + (s.docs ? '<p class="gc-docs">' + esc(s.docs) + '</p>' : '');
}
function whereHtml(m) {
  if (m.pending) return '<p class="dd-load">' + esc(t('gate.loading')) + '</p>';
  if (m.failed || !m.counted) return '<p class="dd-load"' + defAttrs('gate.unavailable') + '>' + esc(t('gate.unavailable')) + '</p>';
  const c = m.counted;
  const parts = [countedHtml(c.calls, API, { cls: 'gc-n' }), m.pages.total ? countedHtml(c.pages, API, { cls: 'gc-n' }) : ''].filter(Boolean);
  const on = biz() ? '' : '<div class="gc-on"><span class="gc-dim"' + defAttrs('gate.sec.sitsOn') + '>' + esc(t('gate.sec.sitsOn')) + '</span> '
    + m.sitsOn.slice(0, 6).map((p) => '<code>' + esc(p.name) + '</code>').join(' · ')
    + (m.sitsOn.length > 6 ? ' · ' + esc(fill(t('gate.more'), { n: m.sitsOn.length - 6 })) : '') + '</div>';
  return '<div class="gc-counts">' + parts.join('<span class="gc-dot">·</span>')
    + (m.truncated ? ' <span class="gc-dim"' + defAttrs('gate.floor') + '>' + esc(t('gate.floor')) + '</span>' : '') + '</div>' + on;
}
function callRowHtml(c) {
  const n = S.BYID[c.id] || c;
  const name = biz() ? (plainWords(c.summary) || plainWords(c.name)) : (c.method && c.path ? c.method + ' ' + c.path : c.name);
  const depth = c.depth ? fill(t(c.depth === 1 ? 'gate.depth.underOne' : 'gate.depth.under'), { n: c.depth }) : t('gate.depth.own');
  return '<div class="gc-row">'
    + '<span class="gc-rn">' + (biz() ? esc(name) : '<code>' + esc(name) + '</code>' + (c.summary ? ' <span class="gc-dim">' + esc(c.summary) + '</span>' : '')) + '</span>'
    + '<span class="gc-dim"' + defAttrs(c.depth ? 'gate.depth.under' : 'gate.depth.own') + '>' + esc(depth) + '</span>'
    + (!biz() && c.loc ? '<span class="gc-loc">' + esc(c.loc.path + ':' + c.loc.line) + '</span>' : '')
    + doorsHtml(doorsFor('call', n)) + '</div>';
}
function callsHtml(m) {
  if (m.pending || m.failed || !m.calls) return '';
  const head = secHead('gate.sec.calls', countedHtml(m.counted.calls, API, { cls: 'gc-n', words: String(m.calls.total) }));
  if (!m.calls.total) return '<section class="gc-sec">' + head + '<p class="gc-none"' + defAttrs('gate.calls.none') + '>' + sym('absent') + esc(t('gate.calls.none')) + '</p></section>';
  return '<section class="gc-sec" data-gc-sec="calls">' + head + m.calls.rows.map(callRowHtml).join('')
    + (m.calls.more ? '<p class="gc-more">' + esc(fill(t('gate.more'), { n: m.calls.more })) + '</p>' : '') + '</section>';
}
function testRowHtml(r, m) {
  const n = S.BYID[r.id] || { id: r.id, loc: r.loc };
  const reach = r.onGate ? t('gate.tests.onGate')
    : fill(t('gate.tests.viaCall'), { call: biz() ? (plainWords((S.BYID[r.reaches.nodeId] || {}).contract && S.BYID[r.reaches.nodeId].contract.summary) || plainWords(r.reaches.name)) : r.reaches.name });
  return '<div class="gc-row">'
    + '<span class="gc-lvl lvl-' + esc(r.level) + '"' + defAttrs('tests.level.' + r.level) + '>' + esc(t('tests.level.' + r.level)) + '</span>'
    + '<span class="gc-rn">' + esc(r.name) + '</span>'
    + '<span class="gc-dim"' + defAttrs(r.onGate ? 'gate.tests.onGate' : 'gate.tests.viaCall') + '>' + esc(reach) + '</span>'
    + (!biz() && r.loc ? '<span class="gc-loc">' + esc(r.loc.path + ':' + r.loc.line) + '</span>' : '')
    + doorsHtml(doorsFor('test', n, { flow: m.flow || null })) + '</div>';
}
function testsHtml(m) {
  if (m.pending || m.failed || !m.tests) return '';
  const c = m.counted.tests && m.counted.tests.tests;
  // one chip: the cases *over this gate*, the one word and the skips — the gate card's 16 never again reads as the screen's 323
  const chip = c && m.tests.total ? testChipHtml({ ...(m.evidence || {}), counted: m.counted.tests }, { api: API, cls: 'gc-tchip' }) : '';
  const head = secHead('gate.sec.tests', chip || (c ? countedHtml(c, API, { cls: 'gc-n', words: String(m.tests.total) }) : '')
    + (m.tests.total && !chip ? ' ' + mapEvidenceChip(m.evidence) : ''));
  if (!m.tests.total) return '<section class="gc-sec">' + head + '<p class="gc-none"' + defAttrs('gate.tests.none') + '>' + sym('absent') + esc(t('gate.tests.none')) + '</p></section>';
  return '<section class="gc-sec" data-gc-sec="tests">' + head + m.tests.rows.map((r) => testRowHtml(r, m)).join('')
    + (m.tests.more ? '<p class="gc-more">' + esc(fill(t('gate.more'), { n: m.tests.more })) + '</p>' : '') + '</section>';
}
// ── who may do what (outsider round 2026-10-13, F4) ─────────────────────────
/** One action a role guard stands in front of: its words, the roles the code lists, the test that proves it. */
function roleRowHtml(r, here) {
  const b = biz();
  const name = b ? (plainWords(r.words) || r.words) : (r.action.method && r.action.path ? r.action.method + ' ' + r.action.path : r.action.name);
  const roles = r.rolesRead ? (b ? jrnRoleWords(r.roles.join(', ')) : r.roles.join(', ')) : t('roles.cell.unread');
  const first = (r.tests || []).find((x) => !x.runLevel);
  const proof = first
    ? fill(t('roles.proof'), { test: first.name }) + (first.status ? ' · ' + fill(t('roles.lastRun'), { status: first.status, date: String(first.at || '').slice(0, 10) }) : '')
      + (!b && first.loc ? ' · ' + first.loc.path + ':' + first.loc.line : '')
    : t('roles.proof.none');
  return '<div class="gc-row gc-role' + (here ? ' here' : '') + '" data-role-action="' + esc(r.action.id) + '">'
    + (here ? '<span class="gc-here"' + defAttrs('gate.roles.here') + '>' + esc(t('gate.roles.here')) + '</span>' : '')
    + '<span class="gc-rn">' + (b ? esc(name) : '<code>' + esc(name) + '</code> <span class="gc-dim">' + esc(r.words) + '</span>') + '</span>'
    + '<span class="gc-roles' + (r.rolesRead ? '' : ' unread') + '"' + defAttrs(r.rolesRead ? 'roles.col.roles' : 'roles.cell.unread') + '>' + esc(roles)
      + (!b && r.requiresFrom ? ' <span class="gc-dim">(' + esc(r.requiresFrom) + ')</span>' : '') + '</span>'
    + '<span class="gc-dim gc-proof"' + defAttrs(first ? 'roles.proof' : 'roles.proof.none') + '>' + esc(proof) + '</span></div>';
}
function rolesHtml(m) {
  const r = m.roles;
  if (!r) return '';
  const head = secHead('gate.sec.roles', r.counted ? countedHtml(r.counted.actions, '/api/roles', { cls: 'gc-n' }) : '');
  const rest = r.others.map((x) => roleRowHtml(x, false)).join('') + (r.more ? '<p class="gc-more">' + esc(fill(t('gate.more'), { n: r.more })) + '</p>' : '');
  const also = r.here.length && r.alsoN
    ? '<details class="gc-also"><summary' + defAttrs('gate.roles.also') + '>' + esc(fill(t(r.alsoN === 1 ? 'gate.roles.alsoOne' : 'gate.roles.also'), { n: r.alsoN })) + '</summary>' + rest + '</details>'
    : rest;
  return '<section class="gc-sec" data-gc-sec="roles">' + head + r.here.map((x) => roleRowHtml(x, true)).join('') + also
    + '<p class="gc-dim gc-holders"' + defAttrs('roles.holders') + '>' + esc(t('roles.holders')) + '</p>'
    + '<a class="dd-door" href="#/roles?guard=' + esc(encodeURIComponent(m.id)) + '"' + defAttrs('gate.roles.all') + '>' + esc(t('gate.roles.all')) + ' ›</a></section>';
}

/**
 * A decision the team made or left open that bears on this gate (lib/decisions.js): its chip, and — since the gate
 * card is itself the open card — the decision's own card in place under it. '' when none does.
 */
function decisionsSecHtml(m) {
  const rows = decisionsOn([m.id]);
  if (!rows.length) return '';
  return '<section class="gc-sec" data-gc-sec="decisions">' + rows.map((r) => '<div class="gc-dec">' + decisionChipHtml(r, { static: true }) + decisionCardHtml(r, { noHead: true }) + '</div>').join('') + '</section>';
}
/** The whole card for one model. `step` (a journey's walk order) adds *show it in the journey*. */
export function gateCardHtml(m, opts = {}) {
  const n = m.facts.node;
  const kind = '<span class="gc-kind k-' + esc(m.kind) + '"' + defAttrs(kindKey(m)) + '>'
    + sym(m.kind === 'rule' ? 'shield' : m.kind === 'config' ? 'gear' : 'lock') + esc(t(kindKey(m))) + '</span>'
    + (m.declared ? ' <span class="gc-kind"' + defAttrs('gate.kind.declared') + '>' + esc(t('gate.kind.declared')) + '</span>' : '');
  const at = !biz() && m.facts.loc ? '<span class="gc-loc">' + esc(m.facts.loc.path + ':' + m.facts.loc.line) + '</span>' : '';
  // the part on the Map: selected at the table or the action, else that action opened (surfaces/map-stops.js mapShowPart)
  const lead = opts.step != null && typeof window !== 'undefined' && window.mapShowPart && S.JOURNEY
    ? '<button type="button" class="dd-door lead" data-gc-step="' + esc(String(opts.step)) + '"' + defAttrs('gate.atStep') + '>' + esc(t('gate.atStep')) + '</button>' : '';
  const doors = doorsHtml(doorsFor(m.gateKind === 'rule' ? 'rule' : 'gate', n), lead);
  return '<div class="gc" data-gc="' + esc(m.id) + '">'
    + '<div class="gc-head">' + kind + '<b class="tip-h gc-name">' + esc(gateName(m)) + '</b>' + gateCodeForm(m) + at + '</div>'
    + (doors ? '<div class="gc-doors">' + doors + '</div>' : '')
    // copy as MCP call · curl · CLI with the full id (round 2026-10-10, proposal 9) — every register
    + (n && n.id ? '<div class="gc-copy">' + copyDoorsHtml(m.gateKind === 'rule' ? 'rule' : 'gate', n) + '</div>' : '')
    + tierHtml(m)
    + decisionsSecHtml(m)
    + '<section class="gc-sec">' + secHead('gate.sec.allows') + sentenceHtml(m) + '</section>'
    + rolesHtml(m)
    + '<section class="gc-sec" data-gc-sec="where">' + secHead('gate.sec.where') + whereHtml(m) + '</section>'
    + (biz() ? '' : '<section class="gc-sec">' + secHead('gate.sec.code') + '<div class="gc-code" data-gc-src="' + esc(m.id) + '"><span class="dd-load">' + esc(t('door.codeLoading')) + '</span></div></section>')
    + callsHtml(m) + testsHtml(m)
    + '</div>';
}

// ── opening it ──────────────────────────────────────────────────────────────
function modelFor(el, answer) {
  const id = el.getAttribute('data-gate-card');
  const n = S.BYID[id];
  const m = gateCardModel(id, { byId: S.BYID || {}, edgesOf: S.EDGES_OF }, {
    answer, lens: currentLens(), config: el.getAttribute('data-gate-config') === '1',
    inWords: n ? jrnGateInWords(n) : '',
    plain: plainWords,
    here: hereIds(el),
  });
  if (m) m.flow = (S.JOURNEY && S.JOURNEY.entry && S.JOURNEY.entry.id) || null;
  return m;
}
/**
 * The action a gate was opened from, as node ids: the step it was drawn on and the call of the action that step
 * belongs to (the route a request goes through). Empty outside a journey.
 */
function hereIds(el) {
  const step = el.getAttribute('data-gate-step');
  const J = S.JOURNEY;
  if (step == null || !J || !J.steps) return [];
  const at = +step;
  const out = [];
  const nodeOf = (i) => { const st = J.steps[i]; return st ? (st.nodeId || (st.node && st.node.id)) : null; };
  const own = nodeOf(at);
  if (own) out.push(own);
  const sg = ((J.summary && J.summary.segments) || []).find((x) => at >= x.from && at <= x.to);
  const mo = sg && (sg.moments || []).find((x) => at >= x.from && at <= x.to);
  if (mo && mo.callStep != null) { const c = nodeOf(mo.callStep); if (c) out.push(c); }
  return out;
}
function fillCodeIn(layerRoot, id) {
  const slot = layerRoot && layerRoot.querySelector('.gc-code[data-gc-src]');
  if (!slot) return;
  fetchSource(id).then((src) => { if (slot.isConnected) { slot.innerHTML = codeHtml(src); repositionTip(); } });
}
function show(el, m, via) {
  const step = el.getAttribute('data-gate-step');
  showTip(el, gateCardHtml(m, { step: step != null ? +step : null }), { rich: true, pinned: true, via, label: t('gate.card') + ' · ' + gateName(m) });
  const root = document.querySelector('.fs-tip .gc[data-gc="' + CSS.escape(m.id) + '"]');
  if (root) {
    root.closest('.fs-tip').classList.add('gc-tip');
    // the card is wider than a tip: place it again at its own width, or a card opened from the rightmost column
    // keeps the narrow tip's left edge and runs off the window (G7 — the business register fetches no code, so
    // nothing else placed it again)
    repositionTip();
    fillCodeIn(root, m.id);
    const go = root.querySelector('[data-gc-step]');
    if (go) go.addEventListener('click', () => { const s = +go.getAttribute('data-gc-step'); hideTip(); window.mapShowPart(s); });
  }
  return root;
}

/**
 * Open the gate card on the element that names a gate (`data-gate-card`). The answer from the service is awaited
 * briefly so the card opens whole; a slow answer opens it with *reading what reaches it…* and fills it in place.
 * @param {Element} el
 * @param {Event} [e]
 */
export async function openGateCard(el, e) {
  if (e) { e.stopPropagation(); if (e.preventDefault && e.type === 'click' && el.tagName === 'A') e.preventDefault(); }
  let host = el && el.closest ? el.closest('[data-gate-card]') : null;
  if (!host) return;
  // a second click on the gate whose card is open closes it
  if (tipOpen() && tipAnchor() === host && host.dataset.gcOpen === '1') { hideTip(); host.dataset.gcOpen = ''; return; }
  const id = host.getAttribute('data-gate-card');
  const via = e && e.type === 'keydown' ? 'key' : 'click';
  const pending = Promise.all([fetchGate(id), loadDecisions()]).then(([a]) => a);
  const first = await Promise.race([pending, new Promise((r) => setTimeout(() => r(undefined), WAIT_MS))]);
  // the surface may have redrawn while the answer was on its way (the code map's inspector draws again on a select):
  // open on the element that names the same gate now
  if (!host.isConnected) host = gateElement(id);
  if (!host) return;
  const m = modelFor(host, first === undefined ? null : first);
  if (!m) return;
  document.querySelectorAll('[data-gc-open="1"]').forEach((x) => { x.dataset.gcOpen = ''; });
  host.dataset.gcOpen = '1';
  show(host, m, via);
  if (first !== undefined) return;
  const answer = await pending;
  // the card is still open on this gate (a redraw may have moved it onto a new element): draw it again whole, keeping the reader's place
  const now = tipOpen() ? tipAnchor() : null;
  if (!now || now.getAttribute('data-gate-card') !== id) return;
  host = now;
  const had = document.activeElement && document.activeElement.closest && document.activeElement.closest('.fs-tip');
  const root = show(host, modelFor(host, answer), via);
  if (had && root) { const f = root.querySelector('a[href],button'); if (f) f.focus({ preventScroll: true }); }
}

/** The element on screen that names this gate now, or null. */
function gateElement(id) {
  return [...document.querySelectorAll('[data-gate-card]')].find((n) => n.getAttribute('data-gate-card') === id && n.getClientRects().length) || null;
}

/** Enter or Space on a focused gate opens its card (keymap.js asks this before the doors' keys). */
export function gateKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== 'Enter' && e.key !== ' ') return false;
  const el = e.target;
  if (!el || !el.matches || !el.matches('[data-gate-card]')) return false;
  e.preventDefault();
  openGateCard(el, e);
  return true;
}

expose({ openGateCard });
