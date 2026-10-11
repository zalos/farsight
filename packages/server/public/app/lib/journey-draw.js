// lib/journey-draw.js — the journey's drawing that the Map's stops reuse (lanes round 2026-10-10, proposal 1 steps
// 3–4: the journey page retired into the Map, and what it drew that the Map still draws moved here from
// surfaces/journeys.js). The pure folds are lib/journey-model.js; this module turns them into HTML and owns the
// selection that runs over it:
//
// - the **table** (the Sheet): `jrnSheetIndex` + `jrnSheetHtml` — every action across, every layer of the system down,
//   cells capped at two chips with `+n`, folds of helpers and parts inside (`jrnCellTree`, `jrnFoldHtml`);
// - a **marker's expansion**: the seam splice for a call (caller code around the fetch · the contract · the route and
//   what it continues into) or the Wallaby-style spliced code (`jrnExpHtml`, `jrnExpBodyHtml`), with ⑂ fork markers
//   and the forks drawer (`jrnForksPanelHtml`); opened under its layer (in place) or in the table's dock
//   (`jrnDock`, `jrnSetDock`, `jrnDockRender`), and in the action stop's CODE tab;
// - the **ladder** of one action (`jrnLadderCellHtml`), the action stop's `ladder` layout;
// - the shared words: gates and their tiers, absence words, test feet with their verdict and scope, counted numbers
//   with their tips, the cut list, impact rings;
// - **selection**: `jrnSelect` / `jrnNav` (j/k) / `jrnScrollTo`, inside `jrnHostEl()` — the Map's stop on screen —
//   and `S.JRN_ON_SELECT`, through which the stop keeps its address on the part selected.
//
// Everything from the server is untrusted display data → esc().

import { S, expose, esc, jsArg, repoOf, bizLabel, humanize, currentLens } from '../store.js';
import { t, def, evidenceWord, plainWords, proseHtml, unTick } from '../strings.js';
import { sym } from '../sym.js';
import { vsl, linkHtml, designThumbHtml } from './graph-render.js';
import { doorsFor, doorsHtml } from './detail-doors.js';
import { gateAttrs } from './gate-card.js';
import { registerTip, tipAttrs, numberTip, tableTip, tipSource } from './tooltip.js';
import { pathHtml } from './fold-row.js';
import { defAttrs, countKey } from './counted.js';
import { jrnDrillOrders, jrnDrillEnsureAction, jrnDrillSelected, jrnInspPanelHtml } from '../surfaces/journey-drill.js';
import { lifecycleStripHtml, headerLifecycles } from './lifecycle-strip.js';
import { freshLineHtml, freshSentence, freshShown } from './freshness.js';
import { momOrdinal, buildTree, cellTree, sheetModel, stopOf, ladderModel, LADDER } from './journey-model.js';
import { testChipHtml, distinctArgs } from './test-chip.js';

const JRN_REPO_COLORS = ['var(--cyan)', 'var(--ok)', 'var(--fn)', 'var(--tbl)', 'var(--auth)', 'var(--amber)'];
const JRN_CATS = ['access', 'guard', 'state', 'error', 'flag', 'branch'];

// ── journey helpers ─────────────────────────────────────────────
/**
 * Stable per-repo band colour: hash the repo name into the 6-colour token cycle.
 * @group Journey view
 */
function jrnRepoColor(repo) { let h = 0; const s = String(repo || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return JRN_REPO_COLORS[h % JRN_REPO_COLORS.length]; }
/** Business/humanized label for a journey node (server bizLabel, else humanize).
 * @group Journey view */
export function jrnLabel(n) { return (n && n.bizLabel) || humanize((n && n.name) || ''); }
/** Words somebody wrote, in the lens on screen: the business lens reads their plain
 * words (no document ids, paths or identifiers — `plainWords`), the others read them whole.
 * @group Journey view */
export function jrnWords(text) { return currentLens() === 'business' ? plainWords(text) : String(text || ''); }
/** An action's name in the lens on screen — the business lens reads its plain words,
 * then the sentence written for it, and says so where nobody wrote any.
 * @group Journey view */
export function jrnMoLabel(mo) {
  if (!mo) return '';
  if (currentLens() !== 'business') return unTick(mo.label);
  return plainWords(mo.label) || plainWords(mo.business) || t('journey.biz.noWords');
}
/** A design id beside a screen's name — outside the business lens, which reads the name alone.
 * @group Journey view */
export function jrnDesignIdHtml(sg) {
  return sg && sg.screen && sg.screen.designId && currentLens() !== 'business' ? '<span class="dsg-id">' + esc(sg.screen.designId) + '</span>' : '';
}
/**
 * Verb shown on a step's incoming arrow, keyed by edge kind.
 * @group Journey view
 */
function jrnVerb(s) {
  const n = s.node || {};
  switch (s.via) {
    case 'calls': return 'calls';
    case 'http': return (n.name && /^(GET|POST|PUT|PATCH|DELETE)\b/.test(n.name)) ? 'HTTP ' + n.name : 'HTTP call';
    case 'renders': return 'shows';
    case 'publishes': return 'emits';
    case 'consumes': return 'handles';
    case 'reads': return 'reads';
    case 'writes': return 'saves to';
    case 'planned': return t('journey.planned.' + ((s.planned || {}).kind || 'step'));
    default: return '';
  }
}
/**
 * A planned step that carries the REAL route node the design says the screen
 * calls (`planned.kind === 'calls'`): it renders as the route card everywhere,
 * dashed and marked, not as an abstract planned card.
 * @group Journey view
 */
function jrnIsPlannedCall(s) { return !!(s && s.planned && s.planned.kind === 'calls' && s.node); }

/**
 * Cross-boundary divider text for a step, or '' if it isn't a boundary.
 * Shown in the map and, in the code pane, at the step's splice point.
 * @group Journey view
 */
function jrnBannerHtml(s) {
  const n = s.node || {};
  let text = '', cls = 'jrn-banner', icon = '';
  if (s.via === 'http') text = '⇄ HTTP ' + (n.name || 'call') + ' → ' + (n.repo || '');
  else if (s.via === 'publishes') { icon = sym('bolt'); text = ' async via ' + (n.name || 'queue'); cls += ' async'; }
  else if (s.via === 'consumes') { icon = sym('bolt'); text = ' async → ' + (n.name || '') + ' (' + (n.repo || '') + ')'; cls += ' async'; }
  else if (s.crossRepo) text = '⇄ crosses into ' + (n.repo || '');
  else return '';
  return '<div class="' + cls + '">' + icon + esc(text) + '</div>';
}

/**
 * A repo-relative product doc as a ⧉ link into the editor, labelled by the
 * document's own H1 when ingest read one (`link.title`) and by its file name
 * when it did not — `0006 — Low-friction contractor flow` tells a reader
 * whether to open it; `0006-low-friction-contractor-flow.md` does not (R21).
 * The path is always on the hover. Takes either a link object from a node or
 * a bare path (a surface row that carries no title).
 * @group Journey view
 */
export function jrnDocLinkHtml(repo, link) {
  const path = link && typeof link === 'object' ? (link.ref || link.url) : link;
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return linkHtml(path);
  const title0 = link && typeof link === 'object' && link.title ? String(link.title) : '';
  const business = currentLens() === 'business';
  // a document's title is words somebody wrote, and its number (`0021 —`) is the
  // citation key a reader quotes it by — kept in every register (swarm 2026-10-05,
  // the business analyst: "the number is the citation key I need"); a bare file name
  // is how the repository files it, and the business lens does not read that
  const num = (title0.match(/^\s*(\d{2,5})\s*[—–-]\s*/) || [])[1] || '';
  const rest = plainWords(title0.replace(/^\s*\d{2,5}\s*[—–-]\s*/, ''));
  const title = business ? (rest ? (num ? num + ' — ' : '') + rest : '') : title0;
  if (business && !title) return '';
  const base = String(path).split('/').pop();
  // the hover keeps the path — and the whole title, since a narrow lane clips it
  return '<span class="dsg-doc" title="' + esc(title ? title + '\n' + path : path) + '"><span class="l">' + esc(title || base) + '</span>' + vsl(repo, path, 1) + '</span>';
}
// ── journey tree & splice (pure — no DOM, unit-testable) ────────
/**
 * Pure: build parent/children/roots from the DFS pre-order depth sequence
 * of journey steps (the wire order from /api/journey).
 * @group Journey view
 */
export function jrnBuildTree(steps) { return buildTree(steps); }
/**
 * Pure: split a code block spanning absolute lines
 * [startLine … startLine+lineCount-1] at child call sites. kids is
 * [{idx,line}] where line is the call-site line (null when the call site is
 * not inside this block). Returns ordered segment descriptors:
 * {kind:'code',from,to} (1-based, inclusive) interleaved with
 * {kind:'child',idx}; each splice cuts after the call line; children whose
 * call site is outside the block append at the end with detached:true.
 * @group Journey view
 */
function jrnSpliceSegments(startLine, lineCount, kids) {
  const endLine = startLine + lineCount - 1, segs = [];
  const inline = kids.filter((k) => k.line != null && lineCount > 0 && k.line >= startLine && k.line <= endLine)
    .sort((a, b) => a.line - b.line || a.idx - b.idx);
  const inSet = new Set(inline.map((k) => k.idx));
  let cur = startLine;
  if (lineCount > 0) {
    for (const k of inline) {
      if (k.line >= cur) { segs.push({ kind: 'code', from: cur, to: k.line }); cur = k.line + 1; }
      segs.push({ kind: 'child', idx: k.idx });
    }
    if (cur <= endLine) segs.push({ kind: 'code', from: cur, to: endLine });
  }
  kids.forEach((k) => { if (!inSet.has(k.idx)) segs.push({ kind: 'child', idx: k.idx, detached: true }); });
  return segs;
}
/** Children of step i as splice inputs: call-site line when it lands in the
 * parent's own file, else null (detached).
 * @group Journey view */
function jrnKidsOf(i) {
  const p = S.JOURNEY.steps[i] || {}, ppath = p.node && p.node.loc && p.node.loc.path;
  return S.JRN_TREE.children[i].map((ci) => {
    const cs = (S.JOURNEY.steps[ci] || {}).callSite;
    return { idx: ci, line: (cs && ppath && cs.path === ppath) ? cs.line : null };
  });
}
/** Accumulated path conditions (root-first along the step tree) that must
 * hold to reach step i — the "state needed to get here" recipe.
 * @group Journey view */
function jrnAccConditions(i) {
  const chain = [];
  for (let cur = i; cur != null && cur >= 0; cur = S.JRN_TREE.parent[cur]) chain.push(cur);
  const out = [];
  chain.reverse().forEach((si) => ((((S.JOURNEY.steps[si] || {}).conditions)) || []).forEach((c) => out.push(c)));
  return out;
}
/** Journey children of step i whose call-site line sits inside [from,to]
 * of step i's own file (used to link fork arms to steps).
 * @group Journey view */
function jrnCallsInSpan(i, from, to) {
  return jrnKidsOf(i).filter((k) => k.line != null && k.line >= from && k.line <= to).map((k) => k.idx);
}

// ── journey fork cards & panel ──────────────────────────────────
/** Outcome markup for one fork arm: step links when a tracked call sits in the
 * arm's span, an exit note for guard-clause arms, else "no tracked calls".
 * @group Journey view */
function jrnArmOutcome(i, bp, arm) {
  const hits = jrnCallsInSpan(i, arm.line || 0, arm.endLine || 0);
  // the arm names the part it reaches and the stop that part sits in — a walk
  // index (`step 38`) is not a position a reader can find anywhere else
  if (hits.length) return hits.map((ci) => '<span class="jrn-fk-step" onclick="event.stopPropagation();jrnScrollTo(' + ci + ')">'
    + esc(t('journey.fork.jump').replace('{name}', ((S.JOURNEY.steps[ci] || {}).node || {}).name || '')) + (jrnStopText(ci) ? ' · ' + esc(jrnStopText(ci)) : '') + '</span>').join(' ');
  if (arm.exits || (bp.exits && (bp.arms || []).length === 1)) return '<span class="jrn-fk-exit">' + esc(t('journey.fork.exits')) + '</span>';
  return '<span class="jrn-fk-none">' + esc(t('journey.fork.noCalls')) + (bp.exits ? ' · ' + esc(t('journey.fork.mayExit')) : '') + '</span>';
}
/** Inline fork card for branch point bi of step i, toggled from the fork gutter:
 * lens-aware condition (business label + raw), category chip, arms with
 * business label + requires + outcome. Both label and raw spans are emitted
 * (.fk-biz / .fk-req, container .has-biz); lens CSS decides which shows.
 * @group Journey view */
function jrnForkCardHtml(i, bi, bp) {
  const cat = bp.category || 'branch';
  const sn = ((S.JOURNEY.steps[i] || {}).node) || {};
  const arms = (bp.arms || []).map((a) => '<span class="jrn-fk-arm' + (a.business ? ' has-biz' : '') + '"><span class="jrn-fk-lbl">' + esc(a.label || '') + '</span>'
    + (a.business ? '<span class="fk-biz">' + esc(a.business) + '</span>' : '')
    + '<span class="jrn-fk-req fk-req">' + esc(a.requires || '') + '</span>' + jrnArmOutcome(i, bp, a) + '</span>').join('');
  return '<span class="jrn-fork-card" id="jrn-fc-' + i + '-' + bi + '" style="display:none" onclick="event.stopPropagation()">'
    + '<span class="jrn-fk-head' + (bp.business ? ' has-biz' : '') + '">' + sym('fork') + ' '
      + (bp.business ? '<span class="fk-biz">' + esc(bp.business) + '</span>' : '')
      + '<span class="fk-req">' + esc(bp.condition || '') + '</span>'
      + '<span class="jrn-fk-cat cat-' + esc(cat) + '">' + esc(cat) + '</span>'
      + (sn.loc ? vsl(sn.repo, sn.loc.path, bp.line || sn.loc.line) : '') + '</span>'
    + arms + '</span>';
}
/** Toggle an inline fork card open/closed from its gutter line.
 * @group Journey view */
function jrnToggleFork(id, ev) {
  if (ev) ev.stopPropagation();
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}
/** All unique forks along the journey as [{i,bi,bp}], deduped by node id so a
 * repeated step doesn't list its branches twice.
 * @group Journey view */
export function jrnCollectForks() {
  const out = [], seen = new Set();
  ((S.JOURNEY && S.JOURNEY.steps) || []).forEach((s, i) => {
    const n = s.node || {};
    if (!Array.isArray(n.branches) || !n.branches.length) return;
    const key = n.id || ('step' + i);
    if (seen.has(key)) return; seen.add(key);
    n.branches.forEach((bp, bi) => out.push({ i, bi, bp }));
  });
  return out;
}
/** One forks-panel entry: condition + location, arms with requires, outcome
 * step links and a copyable mock-state recipe (accumulated requires ∧ arm).
 * @group Journey view */
export function jrnForkEntryHtml(f) {
  const s = S.JOURNEY.steps[f.i] || {}, n = s.node || {};
  if (currentLens() === 'business') return jrnForkEntryBizHtml(f, n, 1);
  const loc = (n.loc ? n.loc.path : '') + ':' + (f.bp.line || '');
  const acc = jrnAccConditions(f.i).map((c) => c.requires).filter(Boolean);
  const arms = (f.bp.arms || []).map((a) => {
    // recipe stays raw code (reproduces state) in every lens — not lens-aware
    const recipe = acc.concat(a.requires ? [a.requires] : []).join(' && ');
    return '<div class="jrn-fkp-arm' + (a.business ? ' has-biz' : '') + '"><span class="jrn-fk-lbl">' + esc(a.label || '') + '</span>'
      + (a.business ? '<span class="fk-biz">' + esc(a.business) + '</span>' : '')
      + '<span class="jrn-fk-req fk-req">' + esc(a.requires || '') + '</span>' + jrnArmOutcome(f.i, f.bp, a)
      + (recipe ? '<button class="jrn-fk-copy" data-recipe="' + esc(recipe) + '" onclick="jrnCopyRecipe(this,event)" title="Copy mock-state recipe">' + sym('open') + '</button>' : '') + '</div>';
  }).join('');
  return '<div class="jrn-fkp-entry" onclick="jrnForkJump(' + f.i + ',' + f.bi + ')">'
    + '<div class="jrn-fkp-cond' + (f.bp.business ? ' has-biz' : '') + '">' + sym('fork') + ' '
      + (f.bp.business ? '<span class="fk-biz">' + esc(f.bp.business) + '</span>' : '')
      + '<span class="fk-req">' + esc(f.bp.condition || '') + '</span></div>'
    + '<div class="jrn-fkp-loc">' + esc(loc) + ' · ' + esc(n.name || '') + (n.loc ? vsl(n.repo, n.loc.path, f.bp.line || n.loc.line) : '') + '</div>' + arms + '</div>';
}
/** Step order → the segment marker the fold drew for it, so the drawer can
 * reach the words the fold already chose for that part (`SegmentMarker.title`
 * — an authored @business label, a verb-named handler's route summary, or the
 * first sentence a person wrote). Rebuilt per drawer render; an older server
 * with no summary simply yields nothing and every caller falls back.
 * @group Journey view */
let JRN_FORK_MARKS = null;
/** @group Journey view */
function jrnForkMarks() {
  if (JRN_FORK_MARKS) return JRN_FORK_MARKS;
  const m = new Map();
  const sum = (S.JOURNEY && S.JOURNEY.summary) || null;
  ((sum && sum.segments) || []).forEach((sg) => (sg.markers || []).forEach((mk) => {
    if (mk.stepOrder != null && !m.has(mk.stepOrder)) m.set(mk.stepOrder, mk);
  }));
  JRN_FORK_MARKS = m;
  return m;
}
/** The words a person wrote about the part step i sits in, or '' when nobody
 * wrote any. Never `humanize()`: an identifier bent into title case is a guess,
 * and the drawer's whole point in this register is that it does not guess.
 * @group Journey view */
function jrnForkPartWords(i, n) {
  const title = jrnMarkerTitle(jrnForkMarks().get(i));
  if (title) return title;
  const label = n && n.bizLabel && n.bizLabel !== n.name ? String(n.bizLabel) : '';
  return label;
}
/**
 * One forks-drawer entry in the business register. A branch carries a
 * plain-language label only where someone wrote a `// @business` directive on
 * it; on the journeys measured here none of them does. So this prints what the
 * graph does support — the sentence a person wrote about the part the branch
 * sits in — and then says, in the closed absence vocabulary, that the condition
 * itself was never written in plain language. The condition, its arms and what
 * each arm requires stay in the other two registers: they are code, and this is
 * the register that hides code.
 * @group Journey view
 * @business One place the journey can go more than one way, named by the part of the app it sits in.
 */
function jrnForkEntryBizHtml(f, n, count) {
  const head = plainWords(String(f.bp.business || '').trim() || jrnForkPartWords(f.i, n));
  const untr = '<span class="jrn-fkp-untr" title="' + esc(def('journey.biz.absent.notTranslated') || '') + '">'
    + sym('absent') + esc(t('journey.biz.absent.notTranslated')) + '</span>';
  // the same part, holding several of them: one card and ×n — the idiom the
  // gate checkpoints already fold with, so nothing new is spelled and the
  // group's count above still adds up to every branch, not to every card
  const many = count > 1
    ? '<span class="jrn-fkp-n" title="' + esc(def('journey.biz.untranslated') || '') + '">×' + count + '</span>' : '';
  return '<div class="jrn-fkp-entry biz" onclick="jrnForkJump(' + f.i + ',' + f.bi + ')">'
    + '<div class="jrn-fkp-biz">' + sym('fork')
    + (head ? '<b>' + esc(head) + '</b>' : untr) + many + '</div>'
    + (head && !f.bp.business ? '<div class="jrn-fkp-sub">' + untr + '</div>' : '') + '</div>';
}
/** One category's forks as cards. The business register folds the branches of
 * one part into a single card with ×n — ten identical sentences in a row is not
 * a list, and the group's count above still counts branches, not cards.
 * @group Journey view */
function jrnForkListHtml(list, biz) {
  if (!biz) return list.map(jrnForkEntryHtml).join('');
  let out = '';
  for (let k = 0; k < list.length;) {
    const id = (list[k].i) + '|' + (((S.JOURNEY.steps[list[k].i] || {}).node || {}).id || '');
    let j = k + 1;
    while (j < list.length && ((list[j].i) + '|' + (((S.JOURNEY.steps[list[j].i] || {}).node || {}).id || '')) === id) j++;
    out += jrnForkEntryBizHtml(list[k], ((S.JOURNEY.steps[list[k].i] || {}).node || {}), j - k);
    k = j;
  }
  return out;
}
/**
 * Forks-drawer markup: every fork grouped by category
 * (access → guard → state → error → flag → branch).
 * @group Journey view
 */
export function jrnForksPanelHtml(forks) {
  JRN_FORK_MARKS = null;
  const biz = currentLens() === 'business';
  // the same drawer, the same groups, the same counts in every register — only
  // the words change, so a reader who switches registers keeps their place
  const title = esc(t(biz ? 'journey.biz.forks.title' : 'journey.forks.title'));
  const tip = esc(def(biz ? 'journey.biz.forks.title' : 'journey.forks.title') || '');
  const head = '<div class="jrn-fkp-head"><span class="hud-label" title="' + tip + '">' + title + '</span>'
    + '<button class="x" onclick="jrnToggleForks()" aria-label="' + esc(t('journey.closeExpanded')) + '">✕</button></div>';
  if (!forks.length) return head + '<div class="jrn-fkp-empty">' + esc(t('journey.forks.empty'))
    + (biz ? '' : '<br>' + esc(t('journey.forks.reingest'))) + '</div>';
  const byCat = {};
  forks.forEach((f) => { const c = f.bp.category || 'branch'; (byCat[c] = byCat[c] || []).push(f); });
  const cats = JRN_CATS.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => !JRN_CATS.includes(c)));
  return head + cats.map((cat) => '<div class="jrn-fkp-cat">' + jrnForkCatChip(cat, biz)
      + '<span class="jrn-fkp-n">' + byCat[cat].length + '</span></div>'
      + jrnForkListHtml(byCat[cat], biz)).join('');
}
/**
 * The forks button of the table's head (the code register): every raw branch the walk met, as a count that opens the
 * drawer of them — the button the journey page's header carried.
 * @group Journey view
 */
export function jrnForksBtnHtml(data, forks) {
  const n = data && data.forkCount != null ? data.forkCount : (forks || []).length;
  if (!n || currentLens() !== 'code') return '';
  return '<button type="button" class="jrn-forksbtn" id="jrn-forksbtn" onclick="jrnToggleForks()">' + sym('fork') + ' '
    + esc(jrnCountWord('journey.forks.count', n)).replace(String(n), () => jrnNumHtml(n, 'journey.forks.count', 'journey.scopeAll', { num: true, noFocus: true })) + '</button>';
}
/** The chip naming how a branch was sorted. Two of the six kinds are read off
 * the branch's shape (a catch, a path that returns or throws) and are facts;
 * the other four are a word match on the condition text, which is why the
 * business register says "looks like" and every define names which it is.
 * @group Journey view */
function jrnForkCatChip(cat, biz) {
  const key = (biz ? 'journey.biz.forkCat.' : 'journey.forkCat.') + cat;
  const known = S.STRINGS && S.STRINGS[key];
  return '<span class="jrn-fk-cat cat-' + esc(cat) + (biz ? ' biz' : '') + '"'
    + (known && def(key) ? ' title="' + esc(def(key)) + '"' : '') + '>'
    + esc(known ? t(key) : cat) + '</span>';
}
/** Open/close the forks drawer (pass true/false to force a state).
 * @group Journey view */
export function jrnToggleForks(force) {
  S.jrnForksOpen = (force === true || force === false) ? force : !S.jrnForksOpen;
  const d = document.getElementById('jrn-forks');
  if (d) { d.classList.toggle('open', S.jrnForksOpen); jrnDrawerInert(d, S.jrnForksOpen); }
}
/**
 * A drawer parked off the right edge is out of reach, not only out of sight:
 * `inert` takes its stops out of the tab order and the accessibility tree. The
 * forks drawer holds a stop per branch — 311 on the POC — and a keyboard reader
 * walked into them off-screen, 343 of 400 stops with no ring in view (pass swarm
 * 2026-09-25, SDET blocker).
 * @group Journey view
 */
function jrnDrawerInert(d, open) {
  if (open) d.removeAttribute('inert'); else d.setAttribute('inert', '');
  d.setAttribute('aria-hidden', open ? 'false' : 'true');
}
/** Jump from a forks-panel entry to its step on the timeline: expand the step,
 * then scroll to and flash the fork line inside the expanded code.
 * @group Journey view */
function jrnForkJump(i, bi) {
  // the drawer sends a reader to a decision; the lane's view that draws it opens with them
  jrnRevealBizTab(i);
  jrnScrollTo(i);
  const line = document.getElementById('jrn-fl-' + i + '-' + bi);
  if (line && line.offsetParent) {
    line.scrollIntoView({ behavior: 'smooth', block: 'center' });
    line.classList.add('flash'); setTimeout(() => line.classList.remove('flash'), 1200);
  }
}
/** Copy a mock-state recipe (from data-recipe) to the clipboard.
 * @group Journey view */
function jrnCopyRecipe(btn, ev) {
  if (ev) ev.stopPropagation();
  navigator.clipboard.writeText(btn.dataset.recipe || '');
  btn.innerHTML = '✓'; setTimeout(() => { btn.innerHTML = sym('open'); }, 1200);
}

// ── journey rendering ───────────────────────────────────────────
/** Requires-chips for a step header: accumulated conditions to reach the step
 * (cap 3 shown, +n), amber-bordered like gate chips. Lens-aware: business label
 * (.fk-biz) beside the raw condition (.fk-req) — lens CSS shows the right one.
 * @group Journey view */
export function jrnReqChips(i) {
  // the business lens names only the conditions somebody wrote words for: a
  // condition in code (`canFile(accounts)`) is not a sentence
  const cs = jrnAccConditions(i).filter((c) => currentLens() !== 'business' || c.business);
  if (!cs.length) return '';
  const shown = cs.slice(0, 3).map((c) => '<span class="jrn-req' + (c.business ? ' has-biz' : '') + '" title="' + esc((c.name || '') + ' ' + (c.path || '') + ':' + (c.line || '')) + '">' + sym('fork') + ' '
    + (c.business ? '<span class="fk-biz">' + esc(c.business) + '</span>' : '')
    + '<span class="fk-req">' + esc(c.requires || '') + '</span></span>').join('');
  return '<span class="jrn-reqs">' + shown + (cs.length > 3 ? '<span class="jrn-req more">+' + (cs.length - 3) + '</span>' : '') + '</span>';
}
/**
 * The reference anchors for a node, unwrapped: the design deep link, `@see`
 * URLs, and the repo-relative product docs a flow points at (⧉ into the
 * editor). Returned as an array so callers choose their own container.
 * @group Journey view
 */
export function jrnRefAnchors(n) {
  const out = [];
  if (n.design && n.design.url) out.push(linkHtml(n.design.url, t('insp.designOpen')));
  (n.links || []).forEach((l) => {
    if (!l) return;
    if (l.kind === 'see' && l.url) out.push(linkHtml(l.url));
    else if (l.kind === 'doc') out.push(l.url ? linkHtml(l.url) : jrnDocLinkHtml(n.repo || repoOf(n), l));
  });
  return out.filter(Boolean);
}
// ── business flow map ───────────────────────────────────────────
/**
 * Business phrasing for a journey gate: guard/rule name minus code prefixes.
 * @group Journey view
 */
export function jrnGateText(g) { return String(g.name || '').replace(/^requireScope: /, 'scope '); }
/**
 * Decision block for step i in the business flow: a diamond with the fork's
 * business label (`@business` tag on the branch point/arm, else the raw
 * condition), the pathway taken (✓, continues below), and every other arm as
 * a labeled alternate pathway — linking to the step it leads to, or marked as
 * ending the flow. Built from the hop's path conditions plus the parent
 * node's branch data.
 * @group Journey view
 * @business Shows each decision as a diamond with the paths the process can take.
 */
function jrnFlowDecision(s, i) {
  // a step can sit under several forks; the diamond is the TRANSLATED one (business or guard
  // class) — a technical `catch` arm on the same hop is counted, never drawn. Older servers
  // carry no class: then every condition is a candidate, as before.
  const conds = (s.conditions || []).filter((c) => c && c.requires && (!c.class || c.class !== 'technical'));
  if (!conds.length) return '';
  const c0 = conds[0];
  const pi = S.JRN_TREE.parent[i];
  const pn = pi >= 0 ? (((S.JOURNEY.steps[pi] || {}).node) || {}) : {};
  const bp = (pn.branches || []).find((b) => b && b.line === c0.line);
  let alts = '';
  if (bp) {
    (bp.arms || []).forEach((a) => {
      if (a.label === c0.arm) return;
      const hits = pi >= 0 ? jrnCallsInSpan(pi, a.line || 0, a.endLine || 0) : [];
      const out = hits.length
        ? hits.map((ci) => '<span class="jrn-fl-goto" onclick="event.stopPropagation();jrnScrollTo(' + ci + ')">→ ' + esc(jrnLabel(((S.JOURNEY.steps[ci] || {}).node) || {})) + '</span>').join(' ')
        : (a.exits || bp.exits ? '<span class="jrn-fl-ends">' + sym('stopped') + ' flow ends here</span>' : '<span class="jrn-fl-ends">no tracked steps</span>');
      alts += '<div class="jrn-fl-arm"><span class="jrn-fl-armlbl">' + esc(a.label || 'else') + '</span>'
        + (a.business ? '<span class="jrn-fl-armtxt">' + esc(a.business) + '</span>' : '') + out + '</div>';
    });
  }
  return '<div class="jrn-fl-dec" title="' + esc(conds.map((c) => c.requires).join(' && ')) + '">'
    + '<div class="jrn-fl-diamond"><span class="jrn-fl-dq"><i>?</i></span>'
      + '<span class="jrn-fl-dtxt">' + esc(c0.business || c0.requires) + '</span>'
      + (conds.length > 1 ? '<span class="jrn-fl-more">+' + (conds.length - 1) + ' more</span>' : '') + '</div>'
    + '<div class="jrn-fl-taken">✓ ' + esc(c0.business ? c0.business : 'when ' + c0.requires) + ' — continues below</div>'
    + (alts ? '<div class="jrn-fl-alts">' + alts + '</div>' : '') + '</div>';
}
/**
 * One line-numbered code segment of step i covering absolute lines [from,to]:
 * true gutter via the CSS counter, ↳ highlight on child call lines, clickable
 * drawn fork markers on branch lines (from node.branches) with inline fork cards.
 * @group Journey view
 */
function jrnCodeSeg(s, i, from, to, lines, startLine, callLines) {
  const branches = (s.node && s.node.branches) || [];
  let out = '';
  for (let L = from; L <= to; L++) {
    const txt = lines[L - startLine] != null ? lines[L - startLine] : '';
    const bIdx = branches.findIndex((b) => b && b.line === L);
    const isCall = callLines.has(L);
    const mark = '<span class="lm">' + (bIdx >= 0 ? sym('fork') : isCall ? '↳' : '') + '</span>';
    out += '<span class="cl' + (isCall ? ' call' : '') + (bIdx >= 0 ? ' fork' : '') + '"'
      + (bIdx >= 0 ? ' id="jrn-fl-' + i + '-' + bIdx + '" onclick="jrnToggleFork(\'jrn-fc-' + i + '-' + bIdx + '\',event)" title="' + esc((branches[bIdx].business ? branches[bIdx].business + ' — ' : '') + (branches[bIdx].category || 'branch') + ' fork — click for arms') + '"' : '')
      + '>' + mark + (esc(txt) || ' ') + '</span>';
    if (bIdx >= 0) out += jrnForkCardHtml(i, bIdx, branches[bIdx]);
  }
  return '<pre class="jrn-pre" style="counter-reset:jrnln ' + (from - 1) + '">' + out + '</pre>';
}
/**
 * Body of step i: code segments split at child call sites, interleaved with
 * the children's own sections nested at their splice point (banner first);
 * detached children (call site not in this file) append after the last
 * segment; steps with no code render a compact event card.
 * @group Journey view
 */
function jrnSegmentsHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const lines = (s.code == null || s.code === '') ? [] : String(s.code).split('\n');
  const startLine = s.codeStartLine || (n.loc && n.loc.line) || 1;
  const kids = jrnKidsOf(i);
  const callLines = new Set(kids.map((k) => k.line).filter((l) => l != null));
  const segs = jrnSpliceSegments(startLine, lines.length, kids);
  let html = '';
  if (!lines.length) html += '<div class="jrn-event">' + esc(jrnVerb(s) || 'event') + (n.loc ? ' · ' + esc(n.loc.path) : '') + '</div>';
  segs.forEach((g) => {
    if (g.kind === 'code') html += jrnCodeSeg(s, i, g.from, g.to, lines, startLine, callLines);
    else {
      const c = S.JOURNEY.steps[g.idx] || {};
      html += '<div class="jrn-splice" style="border-left-color:' + jrnRepoColor(c.node && c.node.repo) + '">'
        + jrnBannerHtml(c) + jrnSectionHtml(g.idx) + '</div>';
    }
  });
  if (s.codeTruncated) html += '<div class="jrn-trunc-note">… code truncated</div>';
  return html;
}
/**
 * Recursive spliced code-timeline section for step i: sticky header (kind
 * chip, names, requires-chips), call-site note, then the spliced body.
 * Repeat/cycle steps collapse to a one-line row at their splice point with
 * an expand control.
 * @group Journey view
 */
function jrnSectionHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const color = jrnRepoColor(n.repo);
  const plannedCall = jrnIsPlannedCall(s);
  if (s.planned && !plannedCall) {
    const p = s.planned;
    return '<section class="jrn-sec jrn-sec-planned" id="jrn-sec-' + i + '" style="border-left-color:' + color + '">'
      + '<div class="jrn-sec-head" data-order="' + i + '">'
      + '<span class="jrn-stepno">' + (i + 1) + '</span>'
      + '<span class="jrn-cchip k-planned">' + esc(t('journey.planned')) + '</span>'
      + '<span class="jrn-biz">' + esc(t('journey.planned.' + (p.kind || 'step'))) + ' ' + esc(p.label || '') + '</span>'
      + (p.detail ? '<span class="jrn-code-name">' + esc(p.detail) + '</span>' : '')
      + (n.contract ? '<a class="jrn-contract" href="#/apis/' + encodeURIComponent(n.contract.apiId) + '?op=' + encodeURIComponent(n.routeId || '') + '">' + sym('api') + esc(t('apis.contractLink')) + '</a>' : '')
      + '</div><div class="jrn-event jrn-plan-note">' + esc(t('journey.plannedNote')) + '</div></section>';
  }
  if (s.repeat || s.cycle) {
    const canExpand = !!(s.repeat || s.code);
    const label = s.cycle ? '↺ recursion — traversal stopped' : '↻ already shown';
    return '<section class="jrn-sec jrn-collapsed" id="jrn-sec-' + i + '" style="border-left-color:' + color + '">'
      + '<div class="jrn-sec-head" data-order="' + i + '">'
      + '<span class="jrn-stepno">' + (i + 1) + '</span>'
      + '<span class="jrn-cchip k-' + esc(n.kind || '') + '">' + esc(n.kind || '') + '</span>'
      + '<span class="jrn-code-name">' + esc(n.name || '') + '</span>'
      + '<span class="jrn-collabel">' + label + '</span>'
      + (canExpand ? '<button class="jrn-expbtn" onclick="jrnExpandRepeat(this)">expand</button>' : '')
      + '</div>'
      + (canExpand ? '<div class="jrn-repeat-body" style="display:none">' + jrnSegmentsHtml(i) + '</div>' : '')
      + '</section>';
  }
  const gateBanners = (s.gates || []).map((g) => {
    const gn = S.BYID[g.id];
    return '<div class="jrn-gate-banner' + (g.kind === 'rule' ? ' rule' : '') + (g.planned ? ' planned' : '') + '"' + (gn ? gateAttrs(g.id, { step: s.order, config: g.config }) : '') + '>'
      + sym(g.kind === 'rule' ? 'shield' : 'lock') + ' requires ' + esc(String(g.name || '').replace(/^requireScope: /, ''))
      + (g.planned ? ' <i>' + esc(t('journey.plannedGate')) + '</i>' : '')
      + (gn && gn.loc ? vsl(repoOf(gn), gn.loc.path, gn.loc.line) : '') + '</div>';
  }).join('');
  const meta = [n.loc ? n.loc.path + ':' + n.loc.line : '', n.repo, n.group].filter(Boolean).join(' · ');
  const head = '<div class="jrn-sec-head" data-order="' + i + '">'
    + '<span class="jrn-stepno">' + (i + 1) + '</span>'
    + '<span class="jrn-cchip k-' + esc(n.kind || '') + '">' + esc(n.kind || '') + '</span>'
    + '<span class="jrn-biz">' + esc(jrnLabel(n)) + '</span>'
    + '<span class="jrn-code-name">' + esc(n.name || '') + '</span>'
    + jrnReqChips(i)
    + (n.contract ? '<a class="jrn-contract" href="#/apis/' + encodeURIComponent(n.contract.apiId) + '?op=' + encodeURIComponent(n.id) + '" title="' + esc(n.contract.summary || '') + '">' + sym('api') + esc(t('apis.contractLink')) + '</a>' : '')
    + '<span class="jrn-meta">' + esc(meta) + '</span>'
    + (n.loc ? vsl(n.repo, n.loc.path, n.loc.line) : '') + '</div>';
  const pi = S.JRN_TREE ? S.JRN_TREE.parent[i] : -1;
  const prepo = pi >= 0 ? (((S.JOURNEY.steps[pi] || {}).node || {}).repo || n.repo) : n.repo;
  const callsite = s.callSite ? '<div class="jrn-callsite">← from ' + esc(s.callSite.path) + ':' + s.callSite.line + vsl(prepo, s.callSite.path, s.callSite.line) + '</div>' : '';
  // a flow entry has no code of its own: what it does carry is the design's
  // description of the feature and the product docs that specify it
  const refs = n.kind === 'flow' ? jrnRefAnchors(n) : [];
  const flowNote = n.kind === 'flow'
    ? ((n.bizDescription || n.docs ? '<div class="jrn-event jrn-flow-note">' + esc(n.bizDescription || n.docs) + '</div>' : '')
      + (refs.length ? '<div class="jrn-refs">' + refs.join(' ') + '</div>' : ''))
    : '';
  return gateBanners
    + '<section class="jrn-sec' + (plannedCall ? ' jrn-sec-planned' : '') + '" id="jrn-sec-' + i + '" style="border-left-color:' + color + '">'
    + head + callsite + flowNote
    + (plannedCall ? '<div class="jrn-event jrn-plan-note">' + esc(t('design.plannedCall')) + '</div>' : '')
    + jrnSegmentsHtml(i) + '</section>';
}

// ── the system drawing the Map's stops reuse ──
// The journey page's blueprint timeline retired with the page (lanes round 2026-10-10, proposal 1); its columns live
// on as the Map's table (the Sheet below), its ladder as the action stop's `ladder` layout, and a marker's expansion
// (the seam splice, the spliced code) in the table's dock and the action stop's CODE tab.

const JRN_LADDER_LINES = 26;

/** The graph node behind a segment's screen — from the journey's `screens`
 * (full design reference), the loaded graph, or the summary row itself.
 * @group Journey view */
export function jrnScreenNode(sg) {
  const id = sg.screen && sg.screen.id;
  if (!id) return null;
  return (S.JOURNEY.screens || []).find((n) => n && n.id === id) || S.BYID[id] || { id, name: sg.screen.name, kind: sg.screen.kind, design: sg.screen.designStatus ? { status: sg.screen.designStatus, id: sg.screen.designId } : undefined };
}
/** First sentence of a business text (cut at ". "), capped so a flowchart step stays one box.
 * @group Journey view */
export function jrnFirstSentence(txt) {
  const str = String(txt || '').trim();
  const m = /^(.{12,}?)\.\s/.exec(str);
  let out = m ? m[1] : str;
  if (out.length > 160) out = out.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  return out;
}
/**
 * A gate's name split into the two things it holds: the identifier of the
 * function that declared it, and the requirement somebody wrote next to it
 * (`requireContractorSession: contractorSession required`). The parser builds
 * the name that way from the `@guard` tag; a rule carries no tag at all, so
 * its name is the schema's identifier and nothing else.
 * @group Journey view
 */
export function jrnGateParts(g) {
  const raw = String(g.name || '');
  const i = raw.indexOf(': ');
  if (i <= 0) return { ident: '', phrase: raw };
  return { ident: raw.slice(0, i), phrase: raw.slice(i + 2) };
}
/** A token only a developer would write: camelCase, snake_case, SHOUT_CASE, `a=b`. */
const JRN_DEV_TOKEN = /[a-z][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]|=/;
/** Labels of the checks every web application has, by the words their authors use — first match wins. */
const JRN_GATE_SHAPES = [
  ['returnPath', /\breturn.?to\b.*\bpath\b|\bredirect target\b/i],
  ['sameOrigin', /^same.?origin\b|\bcsrf\b/i],
  ['rateLimit', /\brate.?limit/i],
  ['idShape', /\bid shape\b/i],
];
/** A name that is one bare identifier and no prose at all (`uuid`, `problemSchema`). */
const JRN_BARE_IDENT = /^[A-Za-z0-9_$]+$/;
/**
 * The checkpoint as a person would say it, or `''` when nobody said it.
 *
 * The business lens may not print an identifier, and this project does not let
 * `humanize()` stand in for a name outside it — so the only words allowed here
 * are the ones a developer actually declared: the text after the colon in a
 * `@guard` tag. Where that text is itself a token out of the code
 * (`contractorSession required`, `BC_MODE=mock only`), or where there is no tag
 * at all — which is every validation rule, whose name is just its schema — this
 * returns nothing and the caller counts it into one honest line instead of
 * manufacturing a sentence for it.
 * @group Journey view
 */
export function jrnGateInWords(g) {
  // a precondition carries the sentence the parser read for it — the team's label, the refusal's
  // own message, or words from the names (gates lane 2026-10-10)
  const node = g && S.BYID && S.BYID[g.id];
  const pre = (g && g.words) || (node && node.precondition && node.precondition.words);
  if (pre) return pre;
  // a guard handed a role or scope here says the role (`requireOpsRole(p, ROLES.approve)` → *approver role*)
  if (g && g.requires) return t('pre.role').replace('{role}', jrnRoleWords(g.requires));
  const { phrase } = jrnGateParts(g);
  // a handful of checks every web application has, named the way a developer names
  // them (*same-origin on mutating routes*, *public-path rate limit*, *path id shape*):
  // the label is words a person wrote, and still a word a product owner would have to
  // look up (swarm 2026-10-05). The shape is read off that label — never guessed from
  // the code — and said with the catalog's sentence for it.
  const shape = phrase && JRN_GATE_SHAPES.find(([, re]) => re.test(phrase));
  if (shape) return t('journey.biz.gateShape.' + shape[0]);
  if (!phrase || JRN_BARE_IDENT.test(phrase) || JRN_DEV_TOKEN.test(phrase)) return '';
  return phrase;
}
/** `ops.reviewer, ops.approver` → *reviewer or approver*: the last part of each role, in words.
 * @group Journey view */
export function jrnRoleWords(requires) {
  const roles = String(requires || '').split(/,\s*/).filter(Boolean).map((r) => humanize(r.split(/[.:/]/).pop() || r).toLowerCase());
  return roles.length > 1 ? t('pre.or').replace('{a}', roles.slice(0, -1).join(', ')).replace('{b}', roles[roles.length - 1]) : (roles[0] || '');
}
/**
 * What to call a checkpoint, in the register the reader asked for — the ONE
 * decision, read by the timeline's list, the sheet, the storyboard and the
 * drill alike. Business gets the requirement somebody wrote and nothing else;
 * hybrid and code get the name the code carries. Before this, three of the four
 * views asked the question for themselves and answered it with the identifier,
 * so a reader who pressed `v` in the business register watched the tool start
 * speaking code at them.
 * @group Journey view
 */
export function jrnGateLabel(g) {
  return currentLens() === 'business' ? plainWords(jrnGateInWords(g)) : jrnGateText(g);
}
/**
 * One list of checkpoints split the one way every view reads it: `rows` in the
 * order the walk met them, `drawn` the ones this register can name, and `mute`
 * how many it cannot. The count a heading prints is `rows.length` — the whole
 * list — so the number beside a list and the rows inside it are never two
 * claims about different things.
 * @group Journey view
 */
export function jrnGatesShown(list) {
  const rows = (list || []).slice().sort((a, b) => a.stepOrder - b.stepOrder);
  const drawn = currentLens() === 'business' ? rows.filter((g) => jrnGateLabel(g)) : rows;
  return { rows, drawn, mute: rows.length - drawn.length };
}
/**
 * One checkpoint as a row of the list: kind glyph, what it requires, how many
 * times this screen met it, and the code behind it. A row, not a card, because
 * forty-seven cards of forty-seven widths in a wrapping flex is a cloud the eye
 * has to track rather than a list it can scan — the columns here line up, so a
 * reader runs down one edge and the ×n counts sit under one another.
 * @group Journey view
 */
function jrnGateRowHtml(g, qualifier) {
  const gn = S.BYID[g.id];
  const words = jrnGateLabel(g);
  // a click (or Enter) opens the gate card; a planned gate is not in the graph, so it still walks to its step
  const opens = gn ? gateAttrs(g.id, { step: g.stepOrder, config: g.config })
    : ' onclick="jrnScrollTo(' + g.stepOrder + ')"';
  return '<div class="jrn-gl-row' + (g.kind === 'rule' ? ' rule' : '') + (g.config ? ' config' : '') + (g.planned ? ' planned' : '') + '"'
    + opens + ' title="' + esc(g.name || '') + '">'
    + sym(g.config ? 'gear' : g.kind === 'rule' ? 'shield' : 'lock')
    + '<span class="jrn-gl-w">' + esc(words) + (g.planned ? ' <i>' + esc(t('journey.plannedGate')) + '</i>' : '')
    // the tier beside the name outside the business register, which groups by it instead
    + (g.tier && currentLens() !== 'business' && !g.config ? ' <span class="gate-tier ' + esc(g.tier) + '"' + tipAttrs({ key: 'gate.tier.' + g.tier }) + '>' + esc(t('gate.tier.' + g.tier)) + '</span>' : '')
    // a real space, not only the margin: this row is read in a screenshot and
    // pasted into a ticket as often as it is clicked
    + (qualifier ? ' <i class="jrn-gl-same" title="' + esc(def('journey.sameWords') || '') + '">' + esc(qualifier) + '</i>' : '') + '</span>'
    // ×n is a number: its tip says what it counts — the times this list met the gate (finding 3.4)
    + '<span class="jrn-gl-x"' + (g.count > 1 ? ' aria-label="' + esc(t('journey.gateTimes').replace('{n}', g.count)) + '"' + tipAttrs({ key: 'journey.gateTimes', noFocus: true }) : '') + '>'
    + (g.count > 1 ? '×' + g.count : '') + '</span>'
    // the doors on the row itself, not behind a ▸ (the business register draws none: they open code)
    + '<span class="jrn-gl-go">' + (gn ? doorsHtml(doorsFor(g.kind === 'rule' ? 'rule' : 'gate', gn)) : '')
    + '</span></div>';
}
/**
 * One named list of checkpoints: a heading carrying THIS screen's count, then
 * the rows in the order the walk met them — which is what the lane's own
 * sub-line promises. In the business lens the ones nobody wrote words for are
 * not drawn with an identifier standing in for a sentence; they are counted
 * into one line at the foot of their own list, so the heading's number and the
 * rows a reader can see never disagree about what is here.
 * @group Journey view
 */
function jrnBizGroupHtml(key, total, body, mute, cls, scopeKey) {
  // A count with no rows under it is not an empty state a reader can act on: in
  // the business register every validation rule of a real application is a schema
  // identifier, so this section drew a heading, a count and an apology three
  // times and could never draw a row (visual swarm 2026-09-24). When nothing is
  // drawn the group says *none of these is written in plain language* — none, not
  // a number equal to the count, which reads as though some were shown — and
  // wears `empty` so it collapses to one line instead of reserving a list's room.
  const allMuted = total > 0 && mute >= total;
  return '<div class="jrn-gl-grp' + (cls ? ' ' + cls : '') + (allMuted ? ' empty' : '') + '">'
    + '<div class="jrn-gl-head"><span class="hud-label" title="' + esc(def(key) || '') + '">' + esc(t(key)) + '</span>'
    // which scope this number counts over, on the screen rather than in a
    // tooltip: the control above this cell counts the same word journey-wide
    + (scopeKey ? '<span class="jrn-gl-scope" title="' + esc(def(scopeKey) || '') + '">' + esc(t(scopeKey)) + '</span>' : '')
    + jrnNumHtml(total, key, scopeKey || 'count.scope.action', { num: true, noFocus: true, cls: 'n' }) + '</div>' + (allMuted ? '' : body)
    + (mute ? '<div class="jrn-gl-mute">' + sym('warning')
      + esc(allMuted ? t('journey.biz.noneInWords') : t('journey.biz.notInWords').replace('{n}', mute)) + '</div>' : '')
    + '</div>';
}
function jrnGateGroupHtml(list, key, scopeKey, cls) {
  if (!list.length) return '';
  const { rows, drawn, mute } = jrnGatesShown(list);
  // Two checkpoints whose developers wrote the same @guard phrase collapse to one
  // wording once the identifier is stripped, and two identical adjacent rows read
  // as a bug in the tool rather than as two places in the code (visual swarm
  // 2026-09-24: `invoice field edit gate` twice, `submit readiness`, `invoice
  // ownership`). Each keeps its own row, its own ×n and its own link, and says
  // which of the places sharing that name it is — a collision named, not folded.
  // Keyed on jrnGateLabel, which is what the row actually prints, so the
  // qualifier appears exactly when a reader would see two rows reading alike.
  const same = new Map();
  drawn.forEach((g) => { const w = jrnGateLabel(g); same.set(w, (same.get(w) || 0) + 1); });
  const seen = new Map();
  const html = drawn.map((g) => {
    const w = jrnGateLabel(g);
    const n = same.get(w) || 1;
    if (n < 2) return jrnGateRowHtml(g);
    const i = (seen.get(w) || 0) + 1;
    seen.set(w, i);
    return jrnGateRowHtml(g, t('journey.sameWords').replace('{i}', i).replace('{n}', n));
  }).join('');
  return jrnBizGroupHtml(key, rows.length, '<div class="jrn-gl-rows">' + html + '</div>',
    mute, cls || (key === 'journey.bizGroup.rules' ? 'rules' : ''), scopeKey);
}
/**
 * The gates and rules of one screen as two aligned lists rather than one cloud
 * of cards. They are different kinds — a gate says who may pass, a rule says
 * what the data must look like — and interleaving them by accident of walk
 * order was most of what made the old view unreadable.
 * @group Journey view
 * @business What has to be true before this part of the journey goes through.
 */
function jrnGateListHtml(gates, scopeKey, configChecks) {
  const cfg = (configChecks || []).map((g) => ({ ...g, kind: 'guard', config: true }));
  if ((!gates || !gates.length) && !cfg.length) return '';
  // the business register reads the checks by who they matter to (gates lane 2026-10-10)
  if (currentLens() === 'business' && (gates || []).some((g) => g.tier)) return jrnGateTiersHtml(gates, scopeKey, cfg, { legend: !!scopeKey });
  return '<div class="jrn-gatelist">'
    + jrnGateGroupHtml((gates || []).filter((g) => g.kind !== 'rule'), 'journey.bizGroup.gates', scopeKey)
    + jrnGateGroupHtml((gates || []).filter((g) => g.kind === 'rule'), 'journey.bizGroup.rules', scopeKey)
    // the config checks the screen's code meets on the way: listed apart, counted apart (swarm-fixes 2026-10-05, finding 4)
    + jrnGateGroupHtml(cfg, 'journey.bizGroup.configChecks', scopeKey, 'config')
    + '</div>';
}
/**
 * The checks split by tier, the business register's reading (gates lane 2026-10-10): *who may*
 * (identity and authorisation, a sign-in check met several times folded to one line per way it is
 * worded), *the record must be* (record state and completeness, the preconditions the code
 * enforces), *policy*, and the technical checks folded behind *+ n technical checks*, which opens
 * them. Pure over the list's own `tier` / `class` (core gate-class.ts) — nothing is re-derived here.
 * @group Journey view
 * @business What has to be true before this goes through, grouped by who it matters to.
 */
export function jrnGateTiersHtml(gates, scopeKey, cfg, o) {
  const opt = o || {};
  const { who, record, policy, technical } = jrnGateTiers(gates);
  const tech = technical.length
    ? '<details class="jrn-gl-tech"><summary' + tipAttrs({ key: 'gate.group.technical' }) + '>'
      + esc(jrnCountWord('gate.group.technical', technical.length)) + '</summary>'
      + jrnGateGroupHtml(technical, 'gate.tier.technical', scopeKey, 'technical') + '</details>'
    : '';
  // the tier counts and where a tier comes from, once per screen's list — not in every action's cell
  const legend = !opt.legend ? '' : '<div class="jrn-gl-legend">' + ['business', 'policy', 'technical'].map((k) => {
    const n = { business: who.length + record.length, policy: policy.length, technical: technical.length }[k];
    return '<span class="gate-tier ' + k + '"' + tipAttrs({ key: 'gate.tier.' + k }) + '>' + esc(t('gate.tier.' + k)) + ' ' + n + '</span>';
  }).join('') + '<span class="jrn-gl-legend-w"' + tipAttrs({ key: 'gate.tierFrom.class' }) + '>' + esc(t('gate.tierFrom.class')) + '</span></div>';
  return '<div class="jrn-gatelist tiers">'
    + jrnGateGroupHtml(who, 'gate.group.whoMay', scopeKey, 'who')
    + jrnGateGroupHtml(record, 'gate.group.record', scopeKey, 'record')
    + jrnGateGroupHtml(policy, 'gate.group.policy', scopeKey, 'policy')
    + tech
    + (cfg && cfg.length ? jrnGateGroupHtml(cfg, 'journey.bizGroup.configChecks', scopeKey, 'config') : '')
    + legend + '</div>';
}
/**
 * One list of gates split by tier: who may (sign-in checks folded, one row per wording with the
 * times summed), the record must be, policy, technical. A gate from an older server has no tier
 * and stays with who may — shown, never folded away unseen.
 * @group Journey view
 */
export function jrnGateTiers(gates) {
  const rows = (gates || []).slice().sort((a, b) => a.stepOrder - b.stepOrder);
  const technical = rows.filter((g) => g.tier === 'technical');
  const policy = rows.filter((g) => g.tier === 'policy');
  const biz = rows.filter((g) => g.tier !== 'technical' && g.tier !== 'policy');
  const record = biz.filter((g) => g.class === 'record-state' || g.class === 'completeness');
  const whoAll = biz.filter((g) => !record.includes(g));
  // sign-in checks say the same thing to a business reader: one row per wording, the times summed
  const who = [];
  const byWords = new Map();
  for (const g of whoAll) {
    if (g.class !== 'identity') { who.push(g); continue; }
    const w = jrnGateLabel(g) || t('gate.signedIn');
    const have = byWords.get(w);
    if (have) { have.count = (have.count || 1) + (g.count || 1); have.folded = (have.folded || 1) + 1; continue; }
    const row = { ...g, words: g.words || (jrnGateLabel(g) ? '' : t('gate.signedIn')) };
    if (!row.words) delete row.words;
    byWords.set(w, row);
    who.push(row);
  }
  return { who, record, policy, technical };
}
/**
 * The checks of one action — the ONE renderer the sheet's *Gates & business*
 * cell, the storyboard's *The checks* row and (in its own boxes) the drill all
 * read. It draws the gates as the two headed, counted lists the timeline draws,
 * then the decisions this register shows under a heading of their own, then
 * what the walk could not put into words. Three views used to answer these
 * questions for themselves, which is how the same checkpoint came to be called
 * `requirePathId: path id shape` on one keystroke and *path id shape* on the
 * next.
 *
 * The lane's control governs it: `gates` narrows to the checkpoints,
 * `decisions` to the forks, and `words` — where the lane opens — draws both as
 * the register words them. `words` is the wider setting here rather than the
 * narrower one it is in the timeline, because this cell is the only place these
 * three views draw a gate at all: narrowing it by default would have three of
 * the four views claim a journey has no checkpoints.
 * @group Journey view
 * @business What has to be true for this action to go through, and where it can go differently.
 */
export function jrnChecksHtml(sg, mo) {
  const tab = jrnBizTab();
  const gates = (sg.gates || []).filter((g) => g.stepOrder >= mo.from && g.stepOrder <= mo.to);
  const configs = (sg.configChecks || []).filter((g) => g.stepOrder >= mo.from && g.stepOrder <= mo.to);
  const inRange = jrnSegDecisions(sg).filter((d) => d.order >= mo.from && d.order <= mo.to);
  // business draws the decisions somebody wrote; a guard-class condition nobody
  // labelled is a predicate in code and is counted, not named
  const shown = currentLens() === 'business' ? inRange.filter((d) => d.cls !== 'guard') : inRange;
  // one number in every lens (docs/COUNTS.md §2 #2): the technical conditions of
  // this action plus the gate conditions nobody labelled — which hybrid and code
  // also draw as decisions, and still count here, because they are still not in
  // plain language
  const un = jrnMomentUntranslated(sg, mo) + inRange.filter((d) => d.cls === 'guard').length;
  const untr = un ? jrnUntranslatedHtml(un, 'count.scope.action', null, jrnActionUntrList(sg, mo)) : '';
  // the forks get the same headed, counted list the gates get — so a register
  // that can name none of them says *n of these are not written in plain
  // language* under a heading that says n, and never *none indexed* about
  // decisions the walk plainly found
  const decs = tab === 'gates' || !inRange.length ? ''
    : '<div class="jrn-gatelist">' + jrnBizGroupHtml('journey.decisions', inRange.length,
      shown.map(jrnSheetDecChipHtml).join(''), inRange.length - shown.length) + '</div>';
  const body = (tab === 'decisions' ? '' : jrnGateListHtml(gates, undefined, configs)) + decs;
  return body ? body + untr : (untr || jrnAbsentHtml('noneIndexed'));
}
/** What the walk could not put into words, said in the register's own voice — a
 * sentence in business, a chip beside the checks elsewhere. One line, every view.
 * @group Journey view */
export function jrnUntranslatedHtml(n, scope, c, list) {
  // the number is the same in every lens (`count.unit.notInWords`); only the words differ
  const biz = currentLens() === 'business';
  const key = biz ? 'journey.biz.untranslated' : 'count.unit.notInWords';
  // with no typed count (an action's cell), the same builder over a bare one, so the list rides along
  const cc = c || { n, unit: 'count.unit.notInWords', bizUnit: 'journey.biz.untranslated', scope: scope || 'journey.scopeHere' };
  const tip = tipAttrs({ id: 'jrnCounted', args: { c: cc, list: list || undefined } });
  return biz
    ? '<div class="jrn-untr sentence"' + tip + '>' + sym('warning') + esc(jrnCountWord(key, n)) + '</div>'
    : '<span class="jrn-untr"' + tip + '>' + sym('warning') + esc(jrnCountWord(key, n)) + '</span>';
}
/**
 * The three things the business lane can draw beneath its sentence. `words`
 * is the default everywhere: the lane opens on what a person wrote and on
 * nothing else. The gates and the branch structure are each one click away,
 * and their counts are on the control whether or not they are drawn — a
 * reader must always be able to tell "there are none" from "they are not
 * shown".
 * @group Journey view
 */
const JRN_BIZ_TABS = ['words', 'gates', 'decisions'];
/** The business lane's open tab — a `?biz=` deep link wins, else what this browser last chose.
 * @group Journey view */
export function jrnBizTab() {
  if (!S.jrnBiz) {
    let v = null;
    try { v = localStorage.getItem('fs-jrn-biz'); } catch (e) { v = null; }
    S.jrnBiz = JRN_BIZ_TABS.indexOf(v) >= 0 ? v : 'words';
  }
  return S.jrnBiz;
}
/**
 * Open one of the business lane's three views and redraw *only that lane* —
 * the system band keeps its selection, its folds and its scroll, and a jump
 * already in flight is never handed a stale marker.
 * @group Journey view
 * @business Chooses what the business lane shows: what happens in words, the checks, or where it can branch.
 */
export function jrnSetBizTab(v) {
  S.jrnBiz = JRN_BIZ_TABS.indexOf(v) >= 0 ? v : 'words';
  try { localStorage.setItem('fs-jrn-biz', S.jrnBiz); } catch (e) { /* private mode: the tab is just not remembered */ }
  // the stop on the Map draws the checks inside a grid whose columns are measured together, so it redraws whole —
  // the open screen, action and register are all state and survive it (surfaces/map-stops.js redrawStops)
  if (S.JOURNEY && S.JRN_REDRAW) S.JRN_REDRAW();
}
/**
 * One segment's decisions, split the one way every drawer of this lane reads
 * them so a count and a cell can never disagree: `inWords` = the ones someone
 * put in words (a guard-class condition with no `@business` label is a
 * predicate in code, not a decision anybody wrote), `shown` = what this lens
 * draws at all — business draws only the authored ones and folds the rest
 * into its "not translated" sentence, hybrid and code draw every one.
 * @group Journey view
 */
function jrnBizDecs(sg) {
  const all = jrnSegDecisions(sg);
  // an older server carries no class: then nothing is folded away, exactly as before
  const inWords = all.filter((d) => d.cls !== 'guard');
  const shown = currentLens() === 'business' ? inWords : all;
  return { all, inWords, shown, unlabelled: all.length - shown.length };
}
/**
 * What each of the lane's three views holds — the numbers on the control.
 *
 * One control sits above eleven cells, so its number has to say *which* count
 * it is. It is the journey's, counted the way the journey header counts it:
 * each checkpoint and each decision once, however many screens meet it. That
 * makes `gates` identical to the header's `24 gates` and `decisions` identical
 * to its `21 decisions` — before this, the control summed the per-screen lists
 * and printed `47` beside a header saying `24`, two bases for one word on one
 * screen. Each screen's own share is on the heading of its list, where it can
 * be read against the row it describes.
 *
 * `words` is the subset of those decisions somebody actually put into words.
 * On the reference app it is 0, and 0 is the answer: nothing in this flow's branches was
 * written in plain language. A control that said 42 while every cell under it
 * drew none was not being kinder, only less useful.
 * @group Journey view
 */
function jrnBizCounts(sum) {
  // the core counts what each view draws (docs/COUNTS.md §2 #7): `inWords` is the
  // lines the words view draws — one per screen, one per decision in words — so
  // the tab no longer reads `IN WORDS · 0` above eleven sentences
  if (sum.counted && sum.counted.inWords) {
    return { words: sum.counted.inWords, gates: sum.counted.gates, decisions: sum.counted.decisions };
  }
  const dec = (sum.business && sum.business.decisions) || [];
  const segs = sum.segments || [];
  const wrap = (n, unit) => ({ n, unit, scope: 'journey.scopeAll', source: 'journeySummary()' });
  return {
    words: wrap(segs.filter((sg) => sg.screen || segs.length === 1).length + dec.filter((d) => d.class !== 'guard').length, 'count.unit.inWords'),
    gates: wrap((sum.counts && sum.counts.gates) || 0, 'journey.countGates'),
    decisions: wrap((sum.counts && sum.counts.decisions) || 0, 'journey.countDecisions'),
  };
}
/**
 * The lane's view control: one for the whole band, in the sticky lane label.
 * Per segment it would be the clutter it exists to remove — eleven copies of
 * it on the reference app's POC flow, each to be set separately — so it sits once beside
 * the lane's name and every count is legible from there.
 * @group Journey view
 */
export function jrnBizTabsHtml(sum) {
  const at = jrnBizTab();
  const c = jrnBizCounts(sum);
  // the tab is a button, so the number inside it carries the tip (hover) and the
  // button keeps its own click: what it counts, over the whole journey, and how it splits
  const btn = (k, key, c) => '<button class="jrn-biztab' + (at === k ? ' on' : '') + '" role="tab" aria-selected="' + (at === k) + '"'
    + ' onclick="jrnSetBizTab(\'' + k + '\')">'
    + '<span class="l">' + esc(t(key)) + '</span><span class="n"' + tipAttrs({ id: 'jrnCounted', args: { c }, noFocus: true, tipKey: 'biztab-' + k }) + '>' + (c ? c.n : 0) + '</span></button>';
  // the control's numbers are journey-wide and each cell's heading is its
  // screen's: three totals used to sit on one screen with nothing saying the
  // scopes differed (visual swarm 2026-09-24), so each says which it is
  return '<div class="jrn-biztabs" role="tablist" aria-label="' + esc(t('journey.bizTabs')) + '">'
    + btn('words', 'journey.bizTab.words', c.words)
    + btn('gates', 'journey.bizTab.gates', c.gates)
    + btn('decisions', 'journey.bizTab.decisions', c.decisions)
    + '<span class="jrn-bizscope" title="' + esc(def('journey.scopeAll') || '') + '">' + esc(t('journey.scopeAll')) + '</span></div>';
}
/** The segment's decisions as one line of ⑂ chips that jump to their fork — the compact form.
 * @group Journey view */
function jrnDecChipsHtml(list) {
  return '<div class="jrn-decs">' + jrnNumHtml(list.length, 'journey.decisionsFolded', 'journey.scopeHere', { noFocus: true, cls: 'jrn-decn' })
    + list.map((d) => '<span class="jrn-dec-chip" onclick="jrnScrollTo(' + d.order + ')" title="' + esc(t('journey.decisionChip')) + '">'
      + sym('fork') + esc(d.label) + '</span>').join('') + '</div>';
}
/**
 * Lane 2 cell: what the business promises during one segment — ▶ start on the
 * first, the sentence the person is living through, then whichever of the
 * lane's three views is open (the decisions named in words · the gates and
 * rules met here · every decision as a diamond with its pathways), ■ end on
 * the last. Gates and decisions jump to their step. The sentence is the lane's
 * spine and stays in every view; what the walk could not put into words is
 * said in every view too — hiding it would make this the one lane that
 * implies the walk was complete.
 * @group Journey view
 * @business This part of the journey in words: what the person does, and — one click away — who is allowed in and where it can branch.
 */
function jrnBizCellHtml(sg, last) {
  const scr = sg.screen;
  // the flowchart step is the first sentence of the screen's business text — the
  // full description stays on the screen card above the line of visibility
  const full = (scr && scr.business) || (scr && scr.name) || (S.JOURNEY.entry && (S.JOURNEY.entry.bizDescription || S.JOURNEY.entry.docs)) || '';
  const business = currentLens() === 'business';
  // the business lens reads the sentence's plain words; where nothing plain is
  // left, the screen's name stands in — the line the tab's count promises is drawn
  const text = business ? (jrnFirstSentence(plainWords(full)) || (scr && scr.name) || '') : jrnFirstSentence(full);
  const d = jrnBizDecs(sg);
  const tab = jrnBizTab();
  let html = '<div class="jrn-cell jrn-bizcell tab-' + tab + (business ? '' : ' compact') + '"><div class="jrn-flowh">';
  if (sg.index === 0) html += '<span class="jrn-fl-start">▶ ' + esc(t('journey.start')) + '</span>';
  html += '<div class="jrn-flowcol">';
  if (text) {
    html += '<div class="jrn-fl-step" onclick="jrnSelectSegment(' + sg.index + ')"><span class="jrn-fl-verb">'
      + esc(sg.index === 0 ? t('journey.verb.first') : t('journey.verb.then')) + '</span>' + esc(text) + '</div>';
  }
  // exactly one of the three, and an empty cell always says which kind is absent
  // rather than leaving a reader to wonder whether it was merely not drawn
  let body = '';
  if (tab === 'gates') {
    body = jrnGateListHtml(sg.gates, 'journey.scopeHere', sg.configChecks);
  } else if (tab === 'decisions') {
    // the flowchart is not deleted, only moved behind the view that asks for it —
    // in every register, including code, which hid it only because it was always on.
    // The fold's decision list and a step's own conditions are two sources, and the
    // diamond is drawn from the second: a decision the first counts and the second
    // cannot picture is still NAMED, as a chip, so what this view draws is exactly
    // what its count claims. (Before the views, those decisions were counted by the
    // fold and drawn nowhere — 27 of the reference app's 42 on the submission flow.)
    const plain = [];
    const drawn = d.shown.map((x) => {
      const dia = jrnFlowDecision(S.JOURNEY.steps[x.order], x.order);
      if (!dia) plain.push(x);
      return dia;
    }).join('') + (plain.length ? jrnDecChipsHtml(plain) : '');
    body = d.all.length
      ? '<div class="jrn-gatelist">' + jrnBizGroupHtml('journey.decisions', d.all.length, drawn, d.all.length - d.shown.length, '', 'journey.scopeHere') + '</div>'
      : '';
  } else {
    // the words view draws the screen's sentence (above) and, under it, the
    // decisions somebody described in words — the lines the tab's number counts
    body = d.inWords.length
      ? '<div class="jrn-gatelist">' + jrnBizGroupHtml('journey.bizGroup.words', d.inWords.length, jrnDecChipsHtml(d.inWords), 0, '', 'journey.scopeHere') + '</div>'
      : '';
  }
  // the gates and decisions views exist to draw their kind, so an empty one names the
  // absence; the words view is the sentence, and only a segment with no sentence either
  // leaves a reader with a blank cell to interpret
  html += body || (tab === 'words' && text ? '' : jrnAbsentHtml('noneIndexed'));
  // what the fold could NOT translate is said, not drawn as a decision — one
  // number in every lens (`segments[i].counted.notInWords`): the technical
  // conditions plus the gate conditions nobody labelled, which hybrid and code
  // also draw as decisions and still count here
  const nw = sg.counted && sg.counted.notInWords;
  const un = nw ? nw.n : (sg.untranslated || 0) + jrnSegDecisions(sg).filter((x) => x.cls === 'guard').length;
  if (un) html += jrnUntranslatedHtml(un, 'journey.scopeHere', nw || null, { t: [sg.from, sg.to], g: [sg.from, sg.to] });
  html += '</div>' + (last ? '<span class="jrn-fl-end">■ ' + esc(t('journey.end')) + '</span>' : '<span class="jrn-fl-next">▶</span>') + '</div></div>';
  return html;
}
/**
 * The decisions of one segment, with the step each one gates. When the server
 * folds them (`decisions[]` with a `stepOrder`) those are used verbatim —
 * they are the TRANSLATED ones, business and guard classes only, and what was
 * not translated is counted separately rather than drawn as a diamond. An
 * older server has neither, so the walk's own path conditions are folded here
 * exactly as before (deduped by fork + arm).
 * @group Journey view
 */
export function jrnSegDecisions(sg) {
  // Probe the SUMMARY, not this one segment's array. The fold names each decision
  // once, on the first screen that meets it, so a later screen legitimately folds
  // to `[]` — and reading that empty array as "no fold here" sent the lane back to
  // the walk, which re-derived 49 conditions the fold had deliberately deduped and
  // classed them all as business. That is where the control's `42 in words` came
  // from on a flow whose fold says none of its decisions were written in words.
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const folds = sum && sum.business && Array.isArray(sum.business.decisions);
  if (folds || (Array.isArray(sg.decisions) && sg.decisions.length && sg.decisions[0].stepOrder != null)) {
    return (sg.decisions || []).map((d) => ({ order: d.stepOrder, label: d.label || d.arm || '', cls: d.class }));
  }
  const out = [], seen = new Set();
  for (let i = sg.from; i <= sg.to; i++) {
    const st = S.JOURNEY.steps[i];
    const conds = ((st && st.conditions) || []).filter((c) => c && c.requires);
    if (!conds.length) continue;
    const key = conds.map((c) => c.nodeId + ':' + c.line + ':' + c.arm).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ order: i, label: conds[0].business || conds[0].requires });
  }
  return out;
}
/** Glyph + colour class for a marker (a rendered component wears the screen glyph: a moment of its screen).
 * @group Journey view */
function jrnMarkGlyph(m, n) {
  if (m.kind === 'call') return { g: 'api', c: 'k-route' };
  if (m.kind === 'record') return { g: 'record', c: 'k-table' };
  if (m.kind === 'message') return { g: 'message', c: 'k-queue' };
  if (m.kind === 'external') return { g: 'external', c: 'k-external' };
  if (n && (n.kind === 'component' || n.kind === 'page')) return { g: 'screen', c: 'k-page' };
  return { g: 'step', c: 'k-function' };
}
/** The plain text a marker shows — one source for the drawn chip and for the column measurement.
 * @group Journey view */
export function jrnMarkerText(m) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const lens = currentLens();
  // one written call with several implementations behind it: the call as the source
  // writes it, and how many could run — never one implementation's name (blocker 3)
  if (m.choice) {
    const n2 = m.choice.candidates.length;
    return lens === 'business'
      ? m.choice.words + ' · ' + t('journey.biz.oneOf').replace('{n}', n2)
      : m.choice.label + ' · ' + t('journey.oneOf').replace('{n}', n2);
  }
  if (m.kind === 'call') {
    const opId = n.contract && n.contract.spec && n.contract.spec.operationId;
    // business: what the call is for, in words — never its verb, its operationId or its path
    if (lens === 'business') return jrnCallWords(m, n);
    return (m.method ? m.method + ' ' : '') + String(opId || m.path || m.name || '');
  }
  const name = String(n.name || m.name || '');
  if (lens === 'code') return name;
  // the words the fold already chose for this marker (`SegmentMarker.title`):
  // the authored @business label, else — for a handler named for its HTTP verb —
  // the summary its route's spec gives it, else the first sentence a person
  // wrote. Never a humanized guess, and the same words MCP prints, so the two
  // surfaces cannot name one marker differently.
  const title = jrnMarkerTitle(m);
  if (lens === 'business') return plainWords(title) || plainWords(n.bizLabel) || humanize(String(n.name || m.name || ''));
  // hybrid = the identifier, plus a NAME beside it — never a guess (§1.4), and
  // never a paragraph: a band column is one chip wide, so a sentence per chip
  // buys readable words with a row three times as tall. The fold says which of
  // the three kinds of words these are: a short authored name and the words a
  // verb-named handler borrows from its route stand beside the identifier; a
  // documentation sentence stays in the tooltip, the panel and the business
  // register, where it has room.
  const short = title && title !== name && (m.titleFrom === 'label' || m.titleFrom === 'route') ? title : '';
  const label = short || ((n.bizLabel && n.bizLabel !== name) ? n.bizLabel : '');
  return label ? name + ' · ' + unTick(label) : name;
}
/**
 * The words the core chose for this marker, or '' when it chose none. An older
 * server carries no `title`, so every caller falls back to what it printed
 * before rather than inventing one here — the rule lives in `journey()`, and a
 * second rule in the viewer is how two surfaces start disagreeing.
 * @group Journey view
 */
export function jrnMarkerTitle(m) { return String((m && m.title) || '').trim(); }
/** A call in the business lens's words: its authored label, else the summary its
 * contract gives it, else its route said the way humanize() says it — never the
 * verb, the operationId or the path.
 * @group Journey view */
export function jrnCallWords(m, n) {
  const c = (n && n.contract) || {};
  return plainWords(n && n.bizLabel) || plainWords(jrnMarkerTitle(m)) || plainWords(c.summary)
    || humanize(String((n && n.name) || m.name || ''));
}
/** Every candidate of a run-time choice, and the sentence that refuses to pick one — as tooltip text.
 * @group Journey view */
export function jrnChoiceTip(c) {
  return c.label + ' · ' + t('journey.oneOf').replace('{n}', c.candidates.length)
    + ' — ' + t('journey.oneOf.unknown') + '\n' + c.candidates.map((x) => x.name + (x.title ? ' — ' + x.title : '')).join('\n')
    + (c.setAside && c.setAside.length ? '\n' + t('journey.oneOf.setAside').replace('{list}', c.setAside.join(', ')) : '');
}
/**
 * The run-time choice behind one call, opened: where the call is written, the
 * implementations that could run it (each with the words its author gave it and
 * a ⧉ into the editor), what the resolution set aside, and how it was matched.
 * Nothing here says which one ran — the code at that line does not say.
 * @group Journey view
 * @business Shows a call that several parts of the system could answer, and names every one of them.
 */
export function jrnChoiceHtml(c) {
  if (!c) return '';
  // the business register reads the call and the candidates in words: no declared type, no
  // technique, no test doubles — the sentence that refuses to pick one stays in every register
  const biz = currentLens() === 'business';
  // each candidate kept its own step in the walk — that is where its source location is
  const row = (x) => {
    const n = (S.JOURNEY.steps[x.stepOrder] || {}).node || null;
    const loc = n && n.loc && !biz ? vsl(n.loc.repo || (n.id || '').split('::')[0], n.loc.path, n.loc.line) : '';
    const head = biz ? (x.title || x.words || x.name) : x.name;
    return '<li><b>' + esc(head) + '</b>' + loc + (x.title && !biz ? '<i>' + esc(x.title) + '</i>' : '') + '</li>';
  };
  const at = c.at && !biz ? '<span class="at">' + esc(c.at.name + ' · ' + c.at.path + ':' + c.at.line) + vsl((c.at.nodeId || '').split('::')[0], c.at.path, c.at.line) + '</span>' : '';
  return '<div class="jrn-oneof">'
    + '<span class="hd">' + sym('oneof') + '<b>' + esc(biz ? c.words : c.label) + '</b>'
    + '<span class="n" title="' + esc(def('journey.oneOf') || '') + '">'
    + esc(biz ? t('journey.biz.oneOf').replace('{n}', c.candidates.length) : t('journey.oneOf').replace('{n}', c.candidates.length)) + '</span>'
    + (c.iface && !biz ? '<span class="via" title="' + esc(def('journey.oneOf.through') || '') + '">' + esc(t('journey.oneOf.through').replace('{iface}', c.iface)) + '</span>' : '')
    + '</span>'
    + at
    + '<span class="why">' + esc(t('journey.oneOf.unknown')) + '</span>'
    + '<span class="hud-label">' + esc(t('journey.oneOf.candidates')) + '</span>'
    + '<ul>' + c.candidates.map(row).join('') + '</ul>'
    + (!biz && c.setAside && c.setAside.length ? '<span class="aside">' + esc(t('journey.oneOf.setAside').replace('{list}', c.setAside.join(', '))) + '</span>' : '')
    + (!biz && c.technique ? '<span class="how">' + esc(t('journey.oneOf.how').replace('{technique}', c.technique).replace('{confidence}', c.confidence || '')) + '</span>' : '')
    + '</div>';
}
/**
 * One marker on a system row: method + operationId for a call, the name for a
 * step/record/message, dashed when declared and not built, a ↺ ghost when the
 * walk already ran it, ▸-prefixed when it is a helper inside its handler.
 * Carries data-order so selection, j/k and the forks drawer address it by step.
 * @group Journey view
 */
export function jrnMarkerHtml(m) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const gk = jrnMarkGlyph(m, n);
  const lens = currentLens();
  let label;
  if (m.kind === 'call' && m.method && lens !== 'business') label = '<b>' + esc(m.method) + '</b> ' + esc(jrnMarkerText(m).slice(m.method.length + 1));
  else label = esc(jrnMarkerText(m));
  // which side of a transaction boundary this part is written on: the mark is quiet (a rule
  // down its edge) and the words are the catalog's, so a chip cannot say it in its own way
  const txKey = m.tx ? (lens === 'business' ? 'journey.biz.tx.' + m.tx : 'journey.tx.' + m.tx) : '';
  // the chip clips to its column, so the tooltip carries both halves in full:
  // the identifier it is, and the words it was given
  const tip = m.choice ? jrnChoiceTip(m.choice)
    : [m.name, jrnMarkerTitle(m) || m.business].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ');
  const title = tip + (m.path ? ' · ' + m.method + ' ' + m.path : '')
    + (m.planned ? ' · ' + t('journey.plannedNote') : '') + (m.repeat ? ' · ' + t('journey.repeated') : '')
    + (txKey ? ' · ' + t(txKey) : '');
  return '<span class="jrn-mk ' + (m.choice ? 'oneof ' : '') + gk.c + (m.tx ? ' tx-' + m.tx : '') + (m.planned ? ' planned' : '') + (m.repeat ? ' rep' : '') + (m.helper ? ' helper' : '')
    + '" data-order="' + m.stepOrder + '" tabindex="0" onclick="event.stopPropagation();jrnSelect(' + m.stepOrder + ')" title="' + esc(title) + '">'
    + sym(m.choice ? 'oneof' : gk.g) + '<span class="lb">' + label + '</span>' + (m.op ? '<i>' + esc(t('journey.op.' + m.op)) + '</i>' : '') + (m.repeat ? '<span class="rep">↺</span>' : '')
    + (m.cut ? '<span class="cut" title="' + esc(def('journey.cutPoints')) + '">▸ ' + esc(t('journey.notFollowed').replace('{n}', m.cut)) + '</span>' : '')
    + '</span>';
}
/**
 * The seam card: one call drawn as the line where the UX meets the API —
 * method, operationId (or path), the spec's own summary and its contract
 * status, then both ends with ⧉ into the editor: the fetch line the browser
 * made it from, and where the API starts. A declared operation with no code
 * behind it says so rather than inventing a handler.
 * @group Journey view
 * @business Shows each API call as the promise it is, with the screen that asks and the service that answers.
 */
export function jrnSeamCardHtml(m) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const c = n.contract || {};
  const lens = currentLens();
  const opId = c.spec && c.spec.operationId;
  const business = lens === 'business';
  const name = business ? jrnCallWords(m, n) : (opId || m.path || m.name);
  const summary0 = c.summary && c.summary !== name ? c.summary : (n.bizLabel && n.bizLabel !== name ? n.bizLabel : '');
  const summary = business ? (plainWords(summary0) !== name ? plainWords(summary0) : '') : summary0;
  const statusKey = c.status === 'both' ? 'apis.status.both' : c.status === 'spec-only' ? 'apis.status.specOnly'
    : c.status === 'declared' ? 'apis.status.declared' : c.status === 'code-only' ? 'apis.status.codeOnly' : 'apis.status.implemented';
  const statusCls = c.status === 'both' ? ' ok' : c.status === 'code-only' ? ' warn' : c.status === 'spec-only' ? ' stub' : '';
  const end = (e, cls, word) => e
    // the path keeps its two ends and breaks at `/`; its tip carries it whole (nothing clips at the column's edge)
    ? '<span class="' + cls + '">' + esc(word) + ' ' + pathHtml(e.path + ':' + e.line) + vsl(e.repo, e.path, e.line) + '</span>'
    : '<span class="' + cls + ' miss">' + esc(word) + ': ' + esc(t('journey.seam.notBuilt')) + '</span>';
  return '<span class="jrn-seam' + (m.planned ? ' planned' : '') + (m.repeat ? ' rep' : '') + '" data-order="' + m.stepOrder + '" tabindex="0"'
    + ' onclick="jrnSelect(' + m.stepOrder + ')" title="' + esc((m.method || '') + ' ' + (m.path || '')) + '">'
    + '<span class="l1">' + sym('api') + (m.method && !business ? '<b>' + esc(m.method) + '</b>' : '') + '<span class="nm">' + esc(name) + '</span>'
    // the code names no method and several endpoints share the address: the read one is shown, and says so
    + (m.methodAssumed ? '<span class="api-chip warn"' + tipAttrs({ key: 'journey.seam.methodAssumed', noFocus: true }) + '>' + esc(t('journey.seam.methodAssumed')) + '</span>' : '')
    + (summary ? '<span class="sum"' + tipAttrs({ text: summary, noFocus: true }) + '>' + proseHtml(summary) + '</span>' : '')
    // whether the spec and the code agree is a developer's question
    + (business ? '' : '<span class="api-chip' + statusCls + '">' + esc(t(statusKey)) + '</span>')
    + (m.repeat ? '<span class="rep">↺</span>' : '') + '</span>'
    + '<span class="l2">' + end(m.caller, 'ux', '← ' + t('journey.seam.from')) + end(m.handler, 'sv', '→ ' + t('journey.seam.handled')) + '</span></span>';
}
/** The component a moment's action lives in: a span header, or the continuation line when it stayed open.
 * @group Journey view */
function jrnCompSpanHtml(mo) {
  if (!mo.component) return '';
  const open = mo.component.stepOrder < mo.from;
  return '<span class="jrn-compspan' + (open ? ' cont' : '') + '" onclick="jrnScrollTo(' + mo.component.stepOrder + ')" title="' + esc(mo.component.name) + '">'
    + sym('screen') + '<span class="nm">' + esc(mo.component.label) + (open ? ' · ' + esc(t('journey.stillOpen')) : '') + '</span>'
    + jrnCompStoryHtml(mo.component.id) + '</span>';
}
/** A story glyph on a component span when the component can be seen on its own — opens the large story view.
 * @group Journey view */
function jrnCompStoryHtml(id) {
  const c = id && S.BYID[id];
  if (!c || !(c.stories || []).length) return '';
  return '<button class="sb-compspan" onclick="event.stopPropagation();openStoryLightbox(' + jsArg(id) + ')" title="' + esc(t('stories.openLarge') + ' · ' + t('stories.title')) + '" aria-label="' + esc(t('stories.openLarge') + ' · ' + t('stories.title')) + '">' + sym('story') + '</button>';
}
/** Label + sub-line for a system row by its kind — a repo row names the side of the seam it is.
 * @group Journey view */
export function jrnRowLabel(r) {
  if (r.kind === 'api') return { label: t('journey.row.api') + ' · ' + r.label, sub: r.planned ? t('journey.rowPlanned') : t('journey.rowSub.api') };
  if (r.kind === 'repo') {
    const side = r.side === 'ux' ? 'ux' : 'server';
    return { label: t('journey.row.' + side), sub: r.planned ? t('journey.rowPlanned') : r.label + ' · ' + t('journey.rowSub.' + side) };
  }
  if (r.kind === 'external') return { label: t('journey.row.external') + ' · ' + r.label, sub: t('journey.rowSub.external') };
  return { label: t('journey.row.' + r.kind), sub: t('journey.rowSub.' + r.kind) };
}
// ── the view axis: lens × view × band (journey-views-pass-2026-09 §2.1) ──

// ── the code pane's dock: in place · bottom · right (2026-09-15) ─────────
/**
 * Where a marker's contract / code opens — `inline` under its system row (the
 * board behaviour), or pinned as a pane at the `bottom` or the `right` of the
 * overlay so it never scrolls out of reach. A `?dock=` deep link wins (the
 * shell puts it on S.jrnDock), else what this browser last chose; `bottom`
 * when nothing was chosen yet.
 * @group Journey view
 */
export function jrnDock() {
  if (!S.jrnDock) {
    try { S.jrnDock = localStorage.getItem('fs-jrn-dock'); } catch (e) { S.jrnDock = null; }
    if (!/^(inline|bottom|right)$/.test(S.jrnDock || '')) S.jrnDock = 'bottom';
  }
  return S.jrnDock;
}
/**
 * Move the code pane — in place, bottom or right — and re-open the selected
 * marker there. Selection, lens, view and band survive; only the pane moves.
 * @group Journey view
 * @business Pins the code and contract pane where it can be read without scrolling away from the journey.
 */
export function jrnSetDock(v) {
  S.jrnDock = /^(inline|bottom|right)$/.test(v) ? v : 'bottom';
  try { localStorage.setItem('fs-jrn-dock', S.jrnDock); } catch (e) { /* private mode: the pane is just not remembered */ }
  jrnApplyDock();
  if (S.JOURNEY && S.JRN_MARK && !S.JRN_DRILL) jrnSelect(S.journeyActive, true);
}
/** Put the dock's class on the table's body and size the pane from what this browser last dragged it to.
 * @group Journey view */
export function jrnApplyDock() {
  const body = document.getElementById('jrn-body');
  const pane = document.getElementById('jrn-dock');
  if (!body || !pane) return;
  // the drill has its own inspector on the right: the pane stays out of the way there
  const d = S.JRN_DRILL ? 'inline' : jrnDock();
  body.classList.toggle('dock-bottom', d === 'bottom');
  body.classList.toggle('dock-right', d === 'right');
  pane.style.display = d === 'inline' ? 'none' : '';
  if (d === 'inline') pane.innerHTML = '';
  // whether the pane holds anything — and therefore how much room it takes — is
  // decided in jrnDockRender, the one place that knows what is selected
  if (d !== 'inline' && !pane.innerHTML) jrnDockRender(-1);
  jrnDockSize();
}
/**
 * Drag the pane's edge (its grip) to resize it; the size is remembered per
 * dock so the next journey opens the same way.
 * @group Journey view
 */
function jrnDockGrip(e) {
  const pane = document.getElementById('jrn-dock');
  const body = document.getElementById('jrn-body');
  if (!pane || !body || e.button) return;
  e.preventDefault();
  const d = jrnDock();
  const start = d === 'bottom' ? e.clientY : e.clientX;
  const from = d === 'bottom' ? pane.offsetHeight : pane.offsetWidth;
  const max = d === 'bottom' ? body.clientHeight - 120 : body.clientWidth - 320;
  let size = from;
  const move = (ev) => {
    size = Math.max(160, Math.min(max, from + (start - (d === 'bottom' ? ev.clientY : ev.clientX))));
    if (d === 'bottom') pane.style.height = size + 'px'; else pane.style.width = size + 'px';
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    try { localStorage.setItem('fs-jrn-dock-' + d, String(Math.round(size))); } catch (err) { /* not remembered */ }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
/** Fill the pinned pane with the selected marker's expansion, or with the hint when nothing is selected.
 * @group Journey view */
function jrnDockSize() {
  const pane = document.getElementById('jrn-dock');
  if (!pane) return;
  const d = S.JRN_DRILL ? 'inline' : jrnDock();
  const open = !pane.classList.contains('empty');
  let size = 0;
  try { size = +localStorage.getItem('fs-jrn-dock-' + d) || 0; } catch (e) { size = 0; }
  pane.style.height = d === 'bottom' && size && open ? size + 'px' : '';
  pane.style.width = d === 'right' && size && open ? size + 'px' : '';
}
/**
 * Render the docked pane: a chosen marker's contract or code, or the one-line
 * hint that says how to choose one.
 * @group Journey view
 */
function jrnDockRender(i) {
  const pane = document.getElementById('jrn-dock');
  if (!pane) return;
  const grip = '<div class="jrn-dock-grip" onpointerdown="jrnDockGrip(event)" title="' + esc(t('journey.dockResize')) + '"></div>';
  const open = i >= 0 && S.JRN_MARK && S.JRN_MARK[i];
  // an empty pane holds no code, so it takes no room: it collapses to its one-line
  // hint until a marker is chosen. Held open it cost the bottom 40% of the journey —
  // and with it the records, messages, third-party and Verified-by rows.
  pane.classList.toggle('empty', !open);
  pane.innerHTML = grip + '<div class="jrn-dock-body">'
    + (open ? jrnExpHtml(i) : '<div class="jrn-dock-hint">' + esc(t('journey.expandHint')) + '</div>') + '</div>';
  jrnDockSize();
}

// ── the ladder (board F): one segment on its side ───────────────
/** Short column label for a system in the ladder header.
 * @group Journey view */
function jrnLadderColLabel(r) { const lb = jrnRowLabel(r); return lb.label; }
// The ladder's widths. A column a screen uses is never narrower than twice the
// share it had when every system drew a full lane (172 px), and grows to what
// it holds; a column it skips between two it uses keeps its place, narrow; the
// columns after the last one it uses fold into one end column.
const { TIME: JRN_LAD_TIME, SKIP: JRN_LAD_SKIP, END: JRN_LAD_END } = LADDER;
/**
 * One segment's ladder before it is drawn: its lines (the time cell and the
 * cells by system key), which systems those lines use, and the columns that
 * follow from that — every system up to the last one used, each `used` or
 * `skip` (in its place, narrow), then the systems after it folded into one
 * `end` list. A screen whose ladder reaches the last system with no gap has no
 * end column and draws every column exactly as it always did.
 * @group Journey view
 * @business Works out which parts of the system one screen actually uses, so the ones it never reaches fold into one column that says so.
 */
function jrnLadderModel(sum, sg) {
  const lm = ladderModel(sum, sg, { steps: S.JOURNEY.steps, text: jrnMarkerText, word: (key) => jrnAbsentWord(sg, null, key) });
  // the model's cells are plain descriptors; the overlay draws them as it always has
  // a path keeps its two ends and its tip carries it whole; a name ellipsises inside its column (the marker's title)
  const cell = (c) => (c.type === 'caller' ? '<span class="go">' + pathHtml(c.at, { max: 34 }) + ' →</span>'
    : c.type === 'seam' ? jrnSeamCardHtml(c.m) + '<span class="go"> →</span>'
    : c.type === 'out' ? '<span class="go out">→</span>'
    : c.type === 'marker' ? jrnMarkerHtml(c.m)
    : '<span class="ind"></span>'.repeat(c.tier) + jrnMarkerHtml(c.m) + (c.loc ? '<span class="back">' + pathHtml(c.loc, { max: 34 }) + '</span>' : ''));
  lm.lines = lm.lines.map((l) => {
    const cells = {};
    Object.keys(l.cells).forEach((k) => { cells[k] = cell(l.cells[k]); });
    const time = l.time.mo ? '<span class="o">' + jrnMomOrdinal(sg, l.time.mo) + ' · ' + esc(jrnMoLabel(l.time.mo)) + '</span>' : String(l.time.n);
    return { m: l.m, time, cells };
  });
  return lm;
}
/** The grid template of one ladder: the time column, then one track per drawn column.
 * @group Journey view */
function jrnLadderTemplate(lm) {
  if (lm.full) return 'grid-template-columns:' + JRN_LAD_TIME + 'px repeat(' + lm.cols.length + ',minmax(0,1fr))';
  const n = Math.max(1, Math.min(lm.lines.length, JRN_LADDER_LINES));
  return 'grid-template-rows:repeat(' + (n + 1) + ',auto) minmax(0,1fr);grid-template-columns:' + JRN_LAD_TIME + 'px '
    + lm.cols.map((c, i) => (c.state === 'skip' ? JRN_LAD_SKIP + 'px' : 'minmax(0,' + lm.widths[i] + 'fr)')).join(' ')
    + (lm.end.length ? ' ' + JRN_LAD_END + 'px' : '');
}
/** The absence word for a system the ladder does not draw as a column, in the lens's words.
 * @group Journey view */
function jrnLadderAbsentWord(word) { return jrnAbsentText(word); }
/**
 * One ladder line: the time cell, then one cell per drawn column. A column the
 * screen does not use holds one cell that spans the lines on show — its words
 * run down it — so line `i` draws that cell on the first line, nothing while
 * the span covers it, and an empty filler past it (the lines behind *more*).
 * @group Journey view
 */
function jrnLadderLine(lm, time, cells, cls, i, span) {
  const spanned = (html) => (i === 0 ? html : i < span.n ? '' : span.pad);
  return '<div class="jrn-lline' + (cls ? ' ' + cls : '') + '"><div class="t">' + time + '</div>'
    + lm.cols.map((c) => (c.state === 'skip' ? spanned(span.skip[c.r.key]) : '<div class="lc">' + (cells[c.r.key] || '') + '</div>')).join('')
    + (lm.end.length ? spanned(span.end) : '') + '</div>';
}
/**
 * One segment as a ladder: the systems it uses as columns, time running down,
 * one line per marker in step order. A call crosses the seam left to right — the
 * fetch line in the browser column, the seam card in the API column; helpers
 * are indented under their handler; records and messages are drawn with an
 * arrow out of the service column. A system skipped before or between the ones
 * the screen uses keeps its place as a narrow dimmed column; the systems after
 * the last one it uses fold into one end column that names each with its
 * absence word. Long segments cap at a line budget.
 * @group Journey view
 * @business Reads one screen as a sequence — the stack trace with names, in the order it happens — and says where it stops.
 */
export function jrnLadderCellHtml(sum, sg) {
  const lm = jrnLadderModel(sum, sg);
  const biz = currentLens() === 'business';
  const endKey = biz ? 'journey.biz.ladder.end' : 'journey.ladder.end';
  const colTip = (key) => tipAttrs({ id: 'jrnLadderCol', args: { seg: sg.index, key } });
  const head = '<div class="jrn-lline jrn-lhead"><div class="t">' + esc(t('journey.ladder.time')) + ' ↓</div>'
    + lm.cols.map((c) => {
      const r = c.r, k = ' k-' + esc(r.kind) + (r.side ? ' side-' + esc(r.side) : '');
      if (c.state === 'skip') {
        return '<div class="lc skip' + k + '"' + colTip(r.key) + ' aria-label="' + esc(jrnLadderColLabel(r) + ' · ' + jrnLadderAbsentWord(lm.word(r.key))) + '">'
          + sym('absent') + '</div>';
      }
      return '<div class="lc' + k + '">' + esc(jrnLadderColLabel(r)) + '</div>';
    }).join('')
    + (lm.end.length ? '<div class="lc lend"' + colTip('end') + '>' + esc(t(endKey)) + '</div>' : '') + '</div>';
  const n = Math.max(1, Math.min(lm.lines.length, JRN_LADDER_LINES));
  // the spans reach one row further, into a filler row that is the grid's only
  // flexible one: an end list taller than the lines grows that row, never the lines
  const rows = ' style="grid-row:span ' + (n + 1) + '"';
  const skip = {};
  lm.cols.forEach((c) => {
    if (c.state === 'skip') skip[c.r.key] = '<div class="lc skip"' + rows + ' data-sys="' + esc(c.r.key) + '" data-absent="' + lm.word(c.r.key) + '"><span class="v">' + esc(jrnLadderColLabel(c.r) + ' · ' + jrnLadderAbsentWord(lm.word(c.r.key))) + '</span></div>';
  });
  const end = '<div class="lc lend-list"' + rows + '>'
    + lm.end.map((r) => '<span class="le" data-sys="' + esc(r.key) + '" data-absent="' + lm.word(r.key) + '">' + sym('absent') + '<span class="le-n">' + esc(jrnLadderColLabel(r)) + '</span>'
      + '<span class="le-w">' + esc(jrnLadderAbsentWord(lm.word(r.key))) + '</span></span>').join('') + '</div>';
  const span = { n, skip, end, pad: '<div class="lc lpad"></div>' };
  const lines = lm.lines.map((l, i) => jrnLadderLine(lm, l.time, l.cells, i >= JRN_LADDER_LINES ? 'over s' + sg.index : '', i, span));
  // a screen with no line at all still says where it stops
  if (!lines.length && !lm.full) lines.push(jrnLadderLine(lm, '', {}, '', 0, span));
  if (!lm.full) {
    lines.splice(n, 0, '<div class="jrn-lline lfill"><div class="t"></div>'
      + lm.cols.map((c) => (c.state === 'used' ? '<div class="lc"></div>' : '')).join('') + '</div>');
  }
  const hidden = Math.max(0, lm.lines.length - JRN_LADDER_LINES);
  return '<div class="jrn-cell jrn-laddercell' + (lm.full ? '' : ' folded') + '" data-seg="' + sg.index + '" data-used="' + lm.cols.filter((c) => c.state === 'used').length
    + '" data-end="' + lm.end.length + '"><div class="jrn-ladder" style="' + jrnLadderTemplate(lm) + '">' + head + lines.join('') + '</div>'
    + (hidden ? '<button class="jrn-lmore" onclick="jrnLadderMore(' + sg.index + ',this)">▾ ' + esc(t('journey.moreSteps').replace('{n}', hidden)) + '</button>' : '')
    + '</div>';
}
/**
 * The tip on a ladder column the screen does not use: the end column (what it
 * stands for, and every system folded into it with its absence word) or a
 * narrow skipped column (which system, and why it keeps its place).
 * @group Journey view
 */
function jrnLadderColTip(el, args) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const sg = sum && (sum.segments || []).find((x) => x.index === (args && args.seg));
  if (!sg) return '';
  const lm = jrnLadderModel(sum, sg);
  const biz = currentLens() === 'business';
  if (args.key === 'end') {
    const k = biz ? 'journey.biz.ladder.end' : 'journey.ladder.end';
    return '<div class="tip-h">' + esc(t(k)) + '</div><p class="tip-p">' + esc(def(k) || '') + '</p>'
      + tableTip({ caption: 'journey.ladder.folded', rows: lm.end.map((r) => [jrnLadderColLabel(r), jrnLadderAbsentWord(lm.word(r.key))]) });
  }
  const r = sum.systems.find((x) => x.key === args.key);
  if (!r) return '';
  const k = biz ? 'journey.biz.ladder.skip' : 'journey.ladder.skip';
  return '<div class="tip-h">' + esc(jrnLadderColLabel(r) + ' · ' + jrnLadderAbsentWord(lm.word(r.key))) + '</div>'
    + '<p class="tip-p">' + esc(def(k) || '') + '</p>';
}
registerTip('jrnLadderCol', jrnLadderColTip);
/** Reveal the lines past a ladder's budget.
 * @group Journey view */
function jrnLadderMore(si, btn) {
  jrnHostEl().querySelectorAll('.jrn-lline.over.s' + si).forEach((el) => el.classList.remove('over'));
  if (btn) btn.style.display = 'none';
}
/**
 * A segment's actions in the order its screen's manifest lists the operations,
 * with anything the manifest does not list after them in walk order. The fold
 * gives every action its `rank`; the array itself stays in walk order because
 * the marker rows index into it positionally, so the ordering is a display
 * choice made here and nowhere else.
 * @group Journey view
 */
export function jrnMomOrdinal(sg, mo) { return momOrdinal(sg, mo); }
/**
 * The drill tree of one cell (a system row × a moment): who hangs under whom,
 * from the core's `under`, and which markers are drawn by default — every root
 * of the cell, plus tiers 0–1 that are not plumbing: the handler and the parts
 * it calls, the action and the parts it calls. Everything deeper folds under
 * the part it belongs to and opens one level at a time; the spliced code view
 * still shows the whole subtree in order. A server built before tiers marks
 * only helpers: then, as before, only those fold.
 *
 * One more grouping on top of that: the **same node reached again inside the
 * same cell is one chip**, carrying how many more times the walk met it, with
 * the repeats folded under it. A cell then describes the parts that did the
 * work rather than listing one chip per visit — the numbers are untouched,
 * every repeat keeps its own step order, and the fold names how many there are.
 * @group Journey view
 * @business Groups a step's inner workings under it — the controller, then what it calls, then the details on demand.
 */
export function jrnCellTree(ms) { return cellTree(ms, jrnHelperTest()); }
/** Whether a marker folds as plumbing in the lens on screen: the core's `helper`, and in the business lens a part tagged `plumbing`.
 * @group Journey view */
export function jrnHelperTest() {
  const biz = currentLens() === 'business';
  const tagged = (m) => {
    const n = ((S.JOURNEY && S.JOURNEY.steps[m.stepOrder]) || {}).node;
    return !!(n && (n.tags || []).includes('plumbing'));
  };
  return (m) => !!m.helper || (biz && m.kind === 'step' && tagged(m));
}
/** A marker with its repeats and then its drill folded beneath it: the seam card for a call, the chip for anything else.
 * @group Journey view */
function jrnMarkerTreeHtml(m, tree, parentFold) {
  return (m.kind === 'call' ? jrnSeamCardHtml(m) : jrnMarkerHtml(m)) + jrnCellFoldsHtml(m, tree, parentFold);
}
/** The two folds every drawn marker carries: the same part reached again, then what it called.
 * @group Journey view */
export function jrnCellFoldsHtml(m, tree, parentFold) {
  const rep = tree.again ? tree.again(m.stepOrder) : [];
  return (rep.length ? jrnFoldHtml(rep, tree, parentFold, rep.length === 1 ? 'journey.againOne' : 'journey.again') : '')
    + jrnFoldHtml(tree.drill(m.stepOrder), tree, parentFold);
}
/** Forget every fold before a layout is drawn (they register while it draws).
 * @group Journey view */
export function jrnResetFolds() { S.JRN_FOLDS = []; S.JRN_FOLD_OF = {}; }
/**
 * The steps folded under a part: one `▸ n inside` chip (`▸ n helpers` when
 * all of them are plumbing) that opens them in place, each with its own fold
 * beneath — a drill-down one level at a time. Registered on S so j/k skips
 * what is folded away and opens it again when something inside is selected.
 * `word` names a fold that is not a drill-down — the repeats of one part —
 * so the button says which kind of hidden it is.
 * @group Journey view
 * @business Hides what a step did internally behind a count — open it to drill one level deeper.
 */
export function jrnFoldHtml(list, tree, parentFold, word) {
  if (!list || !list.length) return '';
  if (!S.JRN_FOLDS) jrnResetFolds();
  const id = 'jrn-fold-' + S.JRN_FOLDS.length;
  const f = { id, orders: list.map((m) => m.stepOrder), open: false, parent: parentFold || null };
  S.JRN_FOLDS.push(f);
  f.orders.forEach((o) => { S.JRN_FOLD_OF[o] = f; });
  const helper = jrnHelperTest();
  const key = word || (list.every(helper) ? (currentLens() === 'business' ? 'journey.biz.helpersFolded' : 'journey.helpersFolded') : 'journey.inside');
  // the button opens the fold; its number carries the tip (what is folded, and where)
  return '<button class="jrn-foldbtn" id="' + id + '-b" onclick="jrnToggleHelpers(\'' + id + '\')">'
    + '▸ ' + esc(jrnCountWord(key, list.length)).replace(String(list.length), () => jrnNumHtml(list.length, key, 'count.scope.node', { num: true, noFocus: true })) + '</button>'
    + '<span class="jrn-fold" id="' + id + '">' + list.map((m) => jrnMarkerTreeHtml(m, tree, id)).join('') + '</span>';
}
/** Open / close one fold and re-walk the j/k order around it.
 * @group Journey view */
function jrnToggleHelpers(id) {
  const el = document.getElementById(id), btn = document.getElementById(id + '-b'), f = (S.JRN_FOLDS || []).find((x) => x.id === id);
  if (!el) return;
  const open = !el.classList.contains('open');
  el.classList.toggle('open', open);
  if (btn) btn.classList.toggle('on', open);
  if (f) f.open = open;
  S.JRN_ORDERS = jrnOrdersNow();
}
/** Whether step order o is on screen: every fold above it is open.
 * @group Journey view */
function jrnUnfolded(o) {
  const byId = (id) => (S.JRN_FOLDS || []).find((x) => x.id === id);
  for (let f = (S.JRN_FOLD_OF || {})[o]; f; f = f.parent ? byId(f.parent) : null) if (!f.open) return false;
  return true;
}
/** The j/k walk: every marker the stop draws — down a column then on to the next action on the table, the action's
 * parts at the action stop — minus what is still folded away.
 * @group Journey view */
function jrnOrdersNow() {
  const all = S.JRN_SHEET ? jrnSheetOrders() : S.JRN_DRILL ? jrnDrillOrders() : Object.keys(S.JRN_MARK || {}).map(Number).sort((a, b) => a - b);
  return all.filter(jrnUnfolded);
}
/**
 * Open the business lane's view that holds step i, when one does and the open
 * one does not — so a reader sent to a decision from the forks drawer lands
 * on a lane that draws it. Deliberately NOT wired into `jrnSelect`: selecting
 * a marker in the system band is not a jump to the lane, and flipping the
 * lane's view under a j/k walk would be the tool moving without being asked.
 * Redrawing one row leaves the band's markers, folds and selection untouched,
 * so a jump already in flight keeps its node.
 * @group Journey view
 */
function jrnRevealBizTab(i) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum || !jrnHostEl().querySelector('.jrn-biztab')) return;
  const sg = (sum.segments || []).find((x) => i >= x.from && i <= x.to);
  if (!sg) return;
  const d = jrnBizDecs(sg);
  const has = {
    gates: (sg.gates || []).some((g) => g.stepOrder === i),
    words: d.inWords.some((x) => x.order === i),
    decisions: d.shown.some((x) => x.order === i),
  };
  const at = jrnBizTab();
  if (has[at]) return;
  const open = JRN_BIZ_TABS.find((k) => has[k]);
  if (open) jrnSetBizTab(open);
}
/** Open whatever hides step i — every closed fold above it, or a folded sheet
 * cell — so a jump from a chip, a gate or the forks drawer lands on something visible.
 * @group Journey view */
function jrnRevealFold(i) {
  const el = jrnHostEl().querySelector('[data-order="' + i + '"]');
  if (!el) return;
  for (let fold = el.closest('.jrn-fold'); fold; fold = fold.parentElement && fold.parentElement.closest('.jrn-fold')) {
    if (!fold.classList.contains('open')) jrnToggleHelpers(fold.id);
  }
  const cell = el.closest('.jrn-scell');
  if (cell && !cell.classList.contains('open')) {
    cell.classList.add('open');
    cell.querySelectorAll('.jrn-smore').forEach((b) => { b.style.display = 'none'; });
    S.JRN_ORDERS = jrnOrdersNow();
  }
}
/** A count cell's word for n: the catalog's singular where it pairs one
 * (`<key>One`), else the plural with {n} filled in. The pair exists because a
 * cell can hold exactly one thing and "1 things" is how a register loses a
 * reader's trust in the numbers beside it.
 * @group Journey view */
function jrnCountWord(key, n) {
  const one = key + 'One';
  if (n === 1 && S.STRINGS && S.STRINGS[one]) return t(one);
  return t(key).replace('{n}', n);
}
// ── typed counts (docs/COUNTS.md): the number, its words, its scope, its tip ──
/**
 * One of the journey's typed counts — `summary.counted[name]`, handed out by the
 * core with its words and its scope. A server built before the ledger carries
 * none: then the plain field it always had is dressed the same way, so the
 * header still prints a number and its tip still names what it counts.
 * @group Journey view
 */
function jrnC(sum, name) {
  const c = sum && sum.counted && sum.counted[name];
  if (c) return c;
  const cnt = (sum && sum.counts) || {};
  const old = {
    screens: [cnt.screens, 'journey.countScreens', 'journey.biz.countScreens'],
    actions: [cnt.called, 'journey.countActions', 'journey.biz.countActions'],
    gates: [cnt.gates, 'journey.countGates', 'journey.countGates'],
    checks: [cnt.checks, 'journey.countChecks', 'journey.countChecks'],
    decisions: [cnt.decisions, 'journey.countDecisions', 'journey.countDecisions'],
    steps: [cnt.steps, 'journey.countSteps', ''],
  }[name];
  if (!old || old[0] == null) return null;
  return { n: old[0], unit: old[1], bizUnit: old[2] || undefined, scope: 'journey.scopeAll', source: 'journeySummary().counts' };
}
/**
 * A typed count in the words of the lens on screen: its `bizUnit` in the
 * business lens — and nothing at all where it has none, because a count in a
 * developer's unit is not the business lens's to print — else its `unit`.
 * `unit` forces one key in every lens (the header's short form).
 * @group Journey view
 */
export function jrnCountedWords(c, unit) {
  if (!c) return '';
  const key = unit || (currentLens() === 'business' ? c.bizUnit : c.unit);
  if (!key) return '';
  return jrnCountWord(key, c.n).replace('{m}', c.of != null ? c.of : '');
}
/** A part of a breakdown in words, its number left to the column beside it.
 * @group Journey view */
function jrnPartWords(p) {
  const w = jrnCountWord(p.key, p.n).replace(String(p.n), '').replace(/\s{2,}/g, ' ').trim();
  return (p.label ? p.label + ' · ' : '') + w;
}
/**
 * The tip of a typed count: what it counts (the define of the words it is
 * printed with), the scope it counts over, where it came from — the answer and
 * the sync, and outside the business lens the core function that computed it —
 * then its breakdown as a table whose parts add up to it, then the numbers
 * printed *beside* it (never inside it), each under its own name.
 * @group Journey view
 */
function jrnCountedTip(el, a) {
  const c = a && a.c;
  if (!c) return '';
  const biz = currentLens() === 'business';
  const of = (biz && c.bizUnit) || c.unit;
  const src = tipSource(a.api || '/api/journey');
  if (!biz && c.source) src.note = c.source;
  const rows = (c.breakdown || []).map((p) => [jrnPartWords(p), p.n]);
  const rel = (a.rel || []).filter((r) => r && r.n).map((r) => {
    const w = jrnCountedWords(r);
    if (!w) return null;
    // every part, zeroes too: `80 e2e` travels with `0 seen in a run`
    const parts = (r.breakdown || []).map((p) => jrnCountWord(p.key, p.n)).join(' · ');
    return [w + (parts && (r.breakdown || []).length > 1 ? ' (' + parts + ')' : '')];
  }).filter(Boolean);
  return numberTip({ count: c.n, of, vars: { m: c.of != null ? c.of : '' }, scope: c.scope, source: src,
    breakdown: rows.length ? { rows } : null })
    + (a.list ? jrnUntrListTip(a.list, c.n) : '')
    + (rel.length ? tableTip({ caption: 'tip.journey.related', rows: rel }) : '');
}
registerTip('jrnCounted', jrnCountedTip);
/**
 * The conditions not in plain language, one row each — the list the sentence
 * says is behind it. `list` names the step ranges the count covered: `t` for the
 * technical conditions (the fold's `business.untranslated.items`), `g` for the
 * gate conditions nobody labelled (its guard-class decisions); `null` is none,
 * `true` is the whole journey. The business lens folds rows that share a place
 * and a kind into one with a count, never prints the condition (it is code), and
 * names the place in words somebody wrote — or says nobody did. Drawn only when
 * the rows add up to `n`, so the list can never disagree with the number.
 * @group Journey view
 */
function jrnUntrListTip(list, n) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const un = sum && sum.business && sum.business.untranslated;
  if (!un || !Array.isArray(un.items)) return '';
  const inR = (r, o) => r === true || (Array.isArray(r) && o >= r[0] && o <= r[1]);
  const biz = currentLens() === 'business';
  JRN_FORK_MARKS = null;
  const stepNode = (o) => ((S.JOURNEY.steps || [])[o] || {}).node || {};
  const where = (o, name) => {
    if (!biz) return name || '';
    return plainWords(jrnForkPartWords(o, stepNode(o))) || t('journey.biz.noWords');
  };
  const items = un.items.filter((u) => inR(list.t, u.stepOrder))
    .map((u) => ({ o: u.stepOrder, where: where(u.stepOrder, u.name), kind: (biz ? 'journey.biz.forkCat.' : 'journey.forkCat.') + (u.category || 'branch'), cond: u.requires || '' }))
    .concat((sum.business.decisions || []).filter((d) => d.class === 'guard' && inR(list.g, d.stepOrder))
      .map((d) => ({ o: d.stepOrder, where: where(d.stepOrder, (S.BYID[d.nodeId] && S.BYID[d.nodeId].name) || ''), kind: 'tip.untr.gate', cond: d.label || '' })))
    .sort((x, y) => x.o - y.o);
  if (!items.length || items.length !== n) return '';
  if (!biz) {
    return tableTip({ caption: 'tip.untr.caption', columns: ['tip.untr.col.where', 'tip.untr.col.kind', { label: 'tip.untr.col.cond', code: true }],
      rows: items.map((u) => [{ text: u.where, code: true }, u.kind, { text: u.cond, code: true }]) });
  }
  const groups = new Map();
  for (const u of items) {
    const k = u.where + '\u0000' + u.kind;
    const g = groups.get(k) || { where: u.where, kind: u.kind, n: 0 };
    g.n++; groups.set(k, g);
  }
  return tableTip({ caption: 'tip.untr.caption', columns: ['tip.untr.col.where', 'tip.untr.col.kind', { label: 'tip.untr.col.n', num: true }],
    rows: [...groups.values()].map((g) => [g.where, g.kind, g.n]) });
}
/**
 * A typed count drawn as words with its tip — the one way a journey prints a
 * number the core counted. `o.unit` forces the words, `o.rel` names the counts
 * printed beside it in the tip, `o.num` prints the number alone (inside a
 * sentence that already says what it is), `o.cls` adds a class.
 * @group Journey view
 */
export function jrnCountedHtml(c, o) {
  const opt = o || {};
  const words = opt.num ? String(c ? c.n : '') : jrnCountedWords(c, opt.unit);
  if (!c || !words) return '';
  return '<span class="jrn-num' + (opt.cls ? ' ' + opt.cls : '') + '"'
    + tipAttrs({ id: 'jrnCounted', args: { c, rel: opt.rel || undefined, api: opt.api || undefined, list: opt.list || undefined }, tipKey: opt.tipKey, noFocus: opt.noFocus })
    + '>' + esc(words) + '</span>';
}
/**
 * A number the viewer counts itself — the markers in one cell, the chips a fold
 * hides — with the standard tip: what it counts, over what, from which answer.
 * No core fold carries these; the scope says how far they reach.
 * @group Journey view
 */
function jrnNumHtml(n, key, scope, o) {
  const opt = o || {};
  return '<span class="jrn-num' + (opt.cls ? ' ' + opt.cls : '') + '"'
    + tipAttrs({ number: { count: n, of: key, scope, source: tipSource('/api/journey') }, noFocus: opt.noFocus })
    + '>' + esc(opt.num ? String(n) : jrnCountWord(key, n)) + '</span>';
}
/**
 * The journey header's `N screens` tip: the count, what it counts, over what,
 * from `/api/journey` at this sync, and the screens themselves in order with
 * whether each is built. Read from the journey on screen when the tip opens,
 * so a redraw or a register flip never leaves it describing another journey.
 * @group Journey view
 */
function jrnScreensTip() {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return '';
  const cnt = sum.counts || {};
  const user = sum.user || [];
  const count = cnt.screens != null ? cnt.screens : user.length;
  const built = (u) => (u.designStatus ? u.designStatus === 'both' : !!u.loc);
  const nBuilt = user.filter(built).length;
  const biz = currentLens() === 'business';
  // the split is built / not built — it adds up to the count; the screens
  // themselves follow as a list, which is not a breakdown and is not captioned as one
  return numberTip({
    count, of: biz ? 'journey.biz.countScreens' : 'journey.countScreens', scope: 'tip.screens.scope', source: tipSource('/api/journey'),
    breakdown: user.length === count ? { rows: [['journey.status.built', nBuilt], ['journey.status.notBuilt', count - nBuilt]] } : null,
  }) + (user.length ? tableTip({
    caption: 'tip.journey.screensList',
    columns: ['tip.screens.col.n', 'tip.screens.col.screen', 'tip.screens.col.status'],
    rows: user.map((u, i) => [String(i + 1), u.name || '', built(u) ? 'journey.status.built' : 'journey.status.notBuilt']),
  }) : '');
}
registerTip('jrnScreens', jrnScreensTip);
/** How many conditions of this action the core could not translate into a
 * business decision. The count is reported per segment, so it shows once, on
 * the action the segment starts with; a server that does not report it yet
 * shows nothing rather than a zero.
 * @group Journey view */
/** The step ranges an action's not-in-plain-language count covers: its own gate
 * conditions, and the screen's technical ones on its first action only — the
 * same split `jrnMomentUntranslated` counts by.
 * @group Journey view */
export function jrnActionUntrList(sg, mo) {
  return { t: mo.index === 0 ? [sg.from, sg.to] : null, g: [mo.from, mo.to] };
}
function jrnMomentUntranslated(sg, mo) {
  if (!sg.untranslated) return 0;
  return mo.index === 0 ? sg.untranslated : 0;
}
/** How many subtrees the walk did not follow inside this action (the markers'
 * own cut points). Absent on a server built before cut points — then nothing
 * is claimed either way.
 * @group Journey view */
function jrnMomentCut(sg, mo) {
  return sg.markers.reduce((a, m) => a + (m.moment === mo.index && m.cut ? m.cut : 0), 0);
}

// ── the system sheet (the journey-timeline design reference 04-system-sheet) ──
// One grid. COLUMNS are the journey's actions in order — every moment of every
// segment, flattened (a moment is a CALL GROUP: one client-side action and
// everything it caused). ROWS are the layers of the system in request order,
// derived from the same `summary.systems` the timeline uses, plus the two
// layers that are always asked about: gates & business, and what verifies it.
// A cell holds at most two chips and folds the rest; an empty cell says which
// kind of empty it is. Every chip is a step of the walk — clicking one opens
// the same expansion the timeline opens, as a full-width row under its layer.

const JRN_SHEET_COL = 214, JRN_SHEET_LANE = 178;

/**
 * The sheet's model: the columns (every moment of every segment in journey
 * order) and the layers (the summary's systems in request order, with *what
 * the user sees* on top, *gates & business* after the code layers and
 * *verified by* at the foot). Nothing is invented — a system the journey never
 * touches has no row, and the always-present rows say so in words.
 * @group Journey view
 */
export function jrnSheetModel(sum) { return sheetModel(sum, { t, rowLabel: jrnRowLabel }); }
/** The markers one cell of the sheet draws: this layer's markers inside this
 * action, with their drill tree — the parts on top, what they called folded under them.
 * @group Journey view */
function jrnSheetCellMarkers(layer, col) {
  const { sg, mo } = col;
  if (!layer.row) return { ms: [], tree: jrnCellTree([]) };
  const ms = sg.markers.filter((m) => m.system === layer.key && m.moment === mo.index
    // the moment's component is the user layer's span header — never drawn twice
    && !(layer.cls === 'app' && mo.component && m.stepOrder === mo.component.stepOrder));
  return { ms, tree: jrnCellTree(ms) };
}
/** The call that gives an action its outcomes — the moment's own call step,
 * else the first call marker inside it.
 * @group Journey view */
function jrnSheetMomentCall(sg, mo) {
  const calls = sg.markers.filter((m) => m.kind === 'call' && m.moment === mo.index);
  return (mo.callStep != null && calls.find((m) => m.stepOrder === mo.callStep)) || calls[0] || null;
}
/**
 * The absence word for one empty (action, layer) cell — the core's, never a
 * view's own. `journeySummary()` decides it once per fact (`segment.absent`,
 * core `journeyAbsence`) and every view that prints the cell — rows, ladder,
 * sheet, drill, storyboard — asks here, so the same cell cannot wear two words
 * (story swarm 2026-09-25, finding 4). `mo` null asks for the whole screen (the
 * ladder's folded columns); `key` is a system row key or `user`. A server that
 * predates the fold falls back to the rows view's old rule.
 * @group Journey view
 */
export function jrnAbsentWord(sg, mo, key) {
  const a = sg && sg.absent;
  if (a) {
    const w = mo ? (a.moments[mo.index] || {})[key] : (a.screen || {})[key];
    if (w) return w;
  }
  const cut = mo ? (sg.cutPoints || []).some((c) => c.moment === mo.index) : (sg.cutPoints || []).length > 0;
  return cut ? 'notReached' : 'notInvolved';
}
/** The absence word for a layer kind (records · messages · external · afterwards) in one action — the core's. `mo` null asks for the whole journey.
 * @group Journey view */
export function jrnAbsentKindWord(sg, mo, kind) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const all = sum && sum.absentKinds && sum.absentKinds[kind];
  if (all) return all;
  if (!mo) return 'notInvolved';
  const a = sg && sg.absent;
  if (a && a.kinds) return (a.kinds[mo.index] || {})[kind] || 'notInvolved';
  return jrnAbsentWord(sg, mo, '');
}
/** An absence word in the lens's register: the business sibling where the catalog has one.
 * @group Journey view */
export function jrnAbsentText(kind) {
  const biz = 'journey.biz.absent.' + kind;
  return currentLens() === 'business' && S.STRINGS && S.STRINGS[biz] ? t(biz) : t('journey.absent.' + kind);
}
/**
 * An empty cell in the words of the fact: *none indexed* (we looked and found
 * nothing), *not built* (declared somewhere, no code behind it), *not
 * involved* (this layer takes no part in this action) or *not reached* (the
 * walk was cut before it). Never a bare dash, and in the business register its
 * business sibling — the same word the ladder prints.
 * @group Journey view
 * @business Says which kind of nothing an empty cell is — nothing found, nothing built yet, or nothing to do here.
 */
export function jrnAbsentHtml(kind, why) {
  // six words, six meanings: the reason line is the key's own sub-sentence, its
  // definition, or — when the fold knows why — the fact behind this one cell
  const subKey = 'journey.absentSub.' + kind;
  const sub = S.STRINGS && S.STRINGS[subKey] ? t(subKey) : '';
  const reason = why || sub || def('journey.absent.' + kind) || '';
  return '<span class="jrn-mk none ' + kind + '" data-absent="' + kind + '" title="' + esc(reason) + '">'
    + sym(kind === 'notBuilt' ? 'warning' : 'absent') + esc(jrnAbsentText(kind)) + '</span>';
}
/** `req → res` for a call, from the contract's request body and its first 2xx
 * response — schema names as plain chips, no tree.
 * @group Journey view */
export function jrnSchemaChipHtml(m) {
  const n = (S.JOURNEY.steps[m.stepOrder] || {}).node || {};
  const c = n.contract || {};
  const req = (c.requestBody && c.requestBody.schema) || '';
  const res = (c.responses || []).filter((r) => /^2/.test(String(r.status))).map((r) => r.schema).filter(Boolean)[0] || '';
  if (!req && !res) return '';
  const text = req ? t('journey.schemaChip').replace('{req}', req).replace('{res}', res) : t('journey.schemaOut').replace('{res}', res);
  return '<span class="jrn-mk schema" onclick="jrnSelect(' + m.stepOrder + ')" title="' + esc(text.trim()) + '"><span class="lb">' + esc(text.trim()) + '</span></span>';
}
/** One translated decision as a sheet chip — a fork the flow can take in this action.
 * @group Journey view */
function jrnSheetDecChipHtml(d) {
  // the condition is code and can be long: it ellipsises inside its cell, and the tip carries it whole
  return '<span class="jrn-mk dec" onclick="jrnScrollTo(' + d.order + ')" title="' + esc(d.label + ' · ' + t('journey.decisionChip')) + '">'
    + sym('fork') + '<span class="lb">' + esc(d.label) + '</span></span>';
}
/**
 * The chips of one cell under the fold rule: two are shown, the rest hide
 * behind `+n more`; each chip carries its own drill (`▸ n inside`) beneath it.
 * Both open the cell in place — the grid is never redrawn, so nothing else moves.
 * @group Journey view
 */
function jrnSheetChipsHtml(chips, li, ci) {
  const rest = chips.slice(2);
  // the `+n` names what it folds: its tip lists the rest, one name each, in the cell's order
  return chips.slice(0, 2).join('')
    + (rest.length ? '<span class="jrn-sx">' + rest.join('') + '</span>'
      + '<button class="jrn-smore" onclick="jrnSheetOpen(' + li + ',' + ci + ',\'open\',this)"' + tipAttrs({ text: rest.map(chipText).filter(Boolean).join(' · '), noFocus: true }) + '>' + esc(t('journey.moreChips')).replace('{n}', () => jrnNumHtml(rest.length, 'journey.moreChips', 'count.scope.action', { num: true, noFocus: true })) + '</button>' : '')
}
/** The words a chip's HTML reads as (its text, entities decoded) — what a `+n` tip lists. */
function chipText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.textContent.replace(/\s+/g, ' ').trim();
}
/** Open the rest of a cell's chips and re-walk the j/k order so the revealed steps join it.
 * @group Journey view */
function jrnSheetOpen(li, ci, what, btn) {
  const cell = jrnHostEl().querySelector('.jrn-scell[data-layer="' + li + '"][data-col="' + ci + '"]');
  if (!cell) return;
  cell.classList.add(what);
  if (btn) btn.style.display = 'none';
  S.JRN_ORDERS = jrnOrdersNow();
}
// ── what proves it runs: one fold, one foot (B4.2, board 07) ─────
// Each chip's opening tag is written out in full: a class attribute assembled
// from pieces reads as prose to the string lint (RULE 1).
const JRN_FOOT_EV = '<span class="ev ';
const JRN_FOOT_NONE = '<span class="ev none" title="';
/**
 * The facts a foot prints for a list of coverage refs the core did not fold —
 * only a table, which no test touches directly and which is reached through
 * its accessors. Cases per level and coverage reports counted apart. No
 * evidence word and no verdict: the core decides both, and for a table it gave
 * only its cases by their own runs (`coverageViaRuns`), which the caller adds
 * (docs/COUNTS.md §4 — the viewer's own copy of the rule is gone, and so is its
 * fold of a weakest run: swarm 2026-10-05, finding 1).
 * @group Journey view
 */
function jrnTestFacts(refs) {
  const by = new Map();
  (refs || []).forEach((x) => { if (x && x.id && !by.has(x.id)) by.set(x.id, x); });
  const all = [...by.values()];
  const cases = all.filter((x) => !x.runLevel);
  return {
    e2e: cases.filter((x) => x.level === 'e2e').length,
    unit: cases.filter((x) => x.level === 'unit').length,
    integration: cases.filter((x) => x.level === 'integration').length,
    observed: cases.filter((x) => x.evidence === 'observed').length,
    runLevel: all.length - cases.length,
    total: cases.length,
    run: null,
    verdict: null,
  };
}
/**
 * The facts of one scope as the core folded them — the counts, the evidence
 * word and its class, the run that earned that word (`observation`) and the
 * covering tests' own last run (`run`) — read, never recomputed. A scope is a
 * journey, a screen, an action (`coverage.moments`) or one step.
 * @group Journey view
 */
export function jrnFoldFacts(cov) {
  if (!cov) return null;
  const k = cov.counted || {};
  const c = (cov.counts && cov.counts.tests) || {};
  const n = (x, fb) => (x ? x.n : (fb || 0));
  const e2e = n(k.e2e, c.e2e), unit = n(k.unit, c.unit), integration = n(k.integration, c.integration);
  return {
    e2e, unit, integration, observed: n(k.observed, c.observed), runLevel: n(k.runReports, c.runLevel),
    total: k.tests ? k.tests.n : e2e + unit + integration,
    evidenceWord: cov.evidenceWord || null, counted: cov.counted || null, observation: cov.observation || null,
    // the cell's one verdict (core `testVerdict`): the word, its own run's status, every case by its run
    verdict: cov.verdict || null,
    chip: cov.chip || 'none', run: cov.run || null, note: cov.note, freshness: cov.freshness || null,
    // a designed, not-built screen: no verdict, the cases that reach the route it will call (core `segmentCoverage`)
    notBuilt: !!(cov.notBuilt || (cov.verdict && cov.verdict.notBuilt)),
  };
}
/** One step's facts: the core's own fold for it, or — for a table, which no test touches directly — what reaches its accessors.
 * @group Journey view */
export function jrnStepTestFacts(i) {
  const s = (S.JOURNEY && S.JOURNEY.steps[i]) || {};
  if (s.coverage && s.coverage.evidenceWord) return jrnFoldFacts(s.coverage);
  const direct = (s.coverage && s.coverage.tests) || [];
  const f = jrnTestFacts(direct.length ? direct : (Array.isArray(s.coverageVia) ? s.coverageVia : []));
  // a table's accessors' cases by their own runs, counted in core
  if (!direct.length && s.coverageViaRuns) f.verdict = { runs: s.coverageViaRuns };
  return f;
}
/** One action's facts: the core's slim entry for it (`coverage.moments[i][k]`), or — on an older server — every test reaching a step inside it.
 * @group Journey view */
function jrnActionTestFacts(sg, mo) {
  const cov = S.JOURNEY.summary && S.JOURNEY.summary.coverage;
  const k = (sg.moments || []).indexOf(mo);
  const slim = cov && cov.moments && cov.moments[sg.index] && cov.moments[sg.index][k >= 0 ? k : mo.index];
  if (slim) return jrnFoldFacts(slim);
  const refs = [];
  for (let i = mo.from; i <= mo.to; i++) {
    const c = S.JOURNEY.steps[i] && S.JOURNEY.steps[i].coverage;
    if (c) refs.push(...(c.tests || []));
  }
  return jrnTestFacts(refs);
}
/** The action a step of the walk belongs to — the segment and moment whose range holds it.
 * @group Journey view */
function jrnStepAction(i) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const sg = sum && (sum.segments || []).find((x) => i >= x.from && i <= x.to);
  const mo = sg && (sg.moments || []).find((x) => i >= x.from && i <= x.to);
  return sg && mo ? { sg, mo } : null;
}
/**
 * The facts of the action one step belongs to — the wider scope a step's own
 * foot names beside its own, so *no test reaches this part* and the action's
 * *72 tests* read as two scopes and never as one contradiction (story swarm
 * 2026-09-25, finding 4).
 * @group Journey view
 */
export function jrnStepActionFacts(i) {
  const at = jrnStepAction(i);
  return at ? jrnActionTestFacts(at.sg, at.mo) : null;
}
/** The scope a foot's numbers count over, as a label in front of them — the `Counted`'s own scope, never a guess.
 * @group Journey view */
export function jrnFootScopeHtml(facts) {
  const scope = facts && facts.counted && facts.counted.tests && facts.counted.tests.scope;
  if (!scope) return '';
  return '<div class="line"><span class="hud-label jrn-tscope" data-scope="' + esc(scope) + '"' + tipAttrs({ key: scope }) + '>' + esc(t(scope)) + '</span></div>';
}
/**
 * The wider scope beside an empty narrow one: a step no test reaches, inside an
 * action some tests do — the action's number, with its own scope, and the
 * sentence that says the two are not the same claim.
 * @group Journey view
 */
function jrnFootWiderHtml(wider) {
  const k = wider && wider.counted && wider.counted.tests;
  if (!k || !k.n) return '';
  return '<div class="line jrn-twider" data-scope="' + esc(k.scope) + '"' + tipAttrs({ key: 'journey.tests.widerScope' }) + '>'
    + esc(t('journey.tests.widerScope')).replace('{n}', () => jrnCountedHtml(k, { noFocus: true })) + '</div>';
}
/**
 * The covering tests' own last runs as a line of its own: how many cases, as a
 * number whose tip breaks them down by what each one's run said (core
 * `testVerdict().runs`, a breakdown that sums), and the runner projects. It is
 * **never** a verdict: the cell's one verdict is the evidence word beside it,
 * and printing the weakest run here put *skipped* under *passed, by its own
 * declaration* for one skipped case among 145 (swarm 2026-10-05, finding 1).
 * @group Journey view */
export function jrnRunLineHtml(facts, chipped) {
  const runs = facts && facts.verdict && facts.verdict.runs;
  if (!runs || !runs.n) return '';
  const run = facts.run;
  // under a test chip the cases are already printed with their scope and their skips (round 2026-10-10): the line keeps
  // only where they ran, so no second bare number of the same cases stands under the chip
  if (chipped) {
    return run && run.projects && run.projects.length ? '<div class="line jrn-runs"><span class="rl rl-proj"' + tipAttrs({ key: 'journey.tests.runProjects' }) + '>'
      + esc(t('journey.tests.runProjects').replace('{list}', run.projects.join(', '))) + '</span></div>' : '';
  }
  return '<div class="line jrn-runs"><span class="hud-label"' + tipAttrs({ key: 'journey.tests.theirRuns' }) + '>' + esc(t('journey.tests.theirRuns')) + '</span>'
    + jrnCountedHtml(runs, { noFocus: true, cls: 'rl' })
    // its own sentence: beside the freshness it read as one ungrammatical phrase (round 2)
    + (run && run.projects && run.projects.length ? '<span class="rl rl-proj"' + tipAttrs({ key: 'journey.tests.runProjects' }) + '>' + esc(t('journey.tests.runProjects').replace('{list}', run.projects.join(', '))) + '</span>' : '')
    + '</div>';
}
/** The foot's *open the list* door, scoped — '' where the foot has no scope to keep.
 * @group Journey view */
function jrnCasesDoorHtml(scope) {
  if (!scope) return '';
  return '<div class="line jrn-cases"><a href="' + esc(jrnCasesHref(scope)) + '" title="' + esc(def('journey.tests.open') || '') + '">' + esc(t('journey.tests.open')) + '</a></div>';
}
/**
 * The door from a foot to the cases it counts, keeping the foot's scope: the
 * journey's screen (`seg`), one action in it (`seg` + `action`), or one step
 * (`node`). The Tests page opens on exactly those cases, with the same verdict
 * (swarm 2026-10-05: *open the list* landed on every case of every journey).
 * @group Journey view
 */
export function jrnCasesHref(scope) {
  const sc = scope || {};
  const flow = S.JOURNEY && S.JOURNEY.entry && S.JOURNEY.entry.id;
  if (sc.node) return '#/tests?node=' + encodeURIComponent(sc.node);
  if (!flow) return '#/tests';
  return '#/tests?flow=' + encodeURIComponent(flow)
    + (sc.seg != null ? '&seg=' + sc.seg + (sc.action != null ? '&action=' + sc.action : '') : '');
}
/**
 * The run behind an evidence word, in words: who observed it — test cases a
 * results report named, or coverage reports that name none — and when. Printed
 * beside the word, so *seen by a coverage run · stale* never stands above a
 * `0 observed` it does not explain (pass swarm 2026-09-25). A scope whose word
 * no run earned says *nothing observed*.
 * @group Journey view
 */
export function jrnObsText(facts) {
  const o = facts && facts.observation;
  if (!o) return facts && facts.evidenceWord && facts.evidenceWord.cls !== 'none' ? t('journey.obs.none') : '';
  return [jrnObsWho(o), (o.at || '').slice(0, 10)].filter(Boolean).join(' · ');
}
/** Who observed a run: the cases a results report named, and the coverage reports that name none.
 * @group Journey view */
function jrnObsWho(o) {
  // a declaration's cases are known to have passed; a case coverage placed is known to have run
  return [o.cases ? jrnCountWord(o.by === 'declaration' ? 'journey.obs.passed' : 'journey.obs.cases', o.cases) : '', o.reports ? jrnCountWord('journey.obs.reports', o.reports) : ''].filter(Boolean).join(' · ');
}
/**
 * The evidence chip's tip: the word and what it means, then the run behind it
 * — who observed it, when, what that run said, whether the code moved since —
 * and in the business lens the sentence the core wrote for it.
 * @group Journey view
 */
function jrnEvidenceTip(el, a) {
  const ev = (a && a.ev) || {};
  if (!ev.key) return '';
  const o = a.obs;
  const rows = o ? [
    ['tip.journey.obs.by', jrnObsWho(o)],
    ['tip.journey.obs.when', (o.at || '').slice(0, 10)],
    // the cell's verdict (core `testVerdict().status`): none when a coverage report alone earned the word
    ['tip.journey.obs.verdict', a.verdict ? (a.verdict.status ? 'tests.run.' + a.verdict.status : '') : o.by === 'runs' ? '' : 'tests.run.' + (o.status || 'unknown')],
    ['tip.journey.obs.since', o.freshness === 'changed' && o.changedBy === 'working-tree' ? 'tests.freshness.changedTree' : 'tests.freshness.' + (o.freshness || 'unknown')],
  ].filter((r) => r[1]) : [['tip.journey.obs.by', 'journey.obs.none']];
  const biz = currentLens() === 'business';
  return '<div class="tip-h">' + esc(t(ev.key)) + '</div>'
    + (def(ev.key) ? '<p class="tip-p">' + esc(def(ev.key)) + '</p>' : '')
    + (biz && ev.biz ? '<p class="tip-p">' + esc(t(ev.biz)) + '</p>' : '')
    + tableTip({ caption: 'tip.journey.obs.head', rows })
    // *stale* as a comparison: the sentence that names the run's side and the code's (core freshness.ts)
    + (freshShown(a.fresh) ? '<p class="tip-p jrn-fresh-tip">' + esc(freshSentence(a.fresh)) + '</p>' : '');
}
registerTip('jrnEvidence', jrnEvidenceTip);
/** The evidence chip: the core's word, its class for the shape, and its tip.
 * @group Journey view */
export function jrnEvChipHtml(facts) {
  const ev = evidenceWord(facts);
  const cls = ev.cls;
  if (cls === 'none') return '';
  return JRN_FOOT_EV + esc(cls) + '"' + tipAttrs({ id: 'jrnEvidence', args: { ev, obs: facts.observation || null, verdict: facts.verdict ? { status: facts.verdict.status } : null, fresh: facts.freshness || null } }) + '>'
    + (cls === 'observed' ? sym('live') : cls === 'stale' ? sym('stale') : cls === 'reached' ? sym('step') : '')
    + esc(t(ev.key)) + '</span>';
}
// written out whole: an attribute assembled from pieces reads as prose to the lint
const JRN_IMPDOOR = '<div class="line imp-door"><a href="#" onclick="return impactGo(this)" data-node="';
/**
 * The foot's door to impact (B4.6): from *what proves this runs* to *what else
 * uses this*, on the node the foot is about. Shown only once this server has
 * answered `/api/impact` at least once — the panel asks for the open step as
 * soon as it draws, so the door appears a moment after the first selection and
 * never at all on a build whose endpoint 404s. A door onto an error is worse
 * than no door.
 * @group Journey view
 * @business Opens what else uses this step.
 */
function jrnImpactDoorHtml(id) {
  if (!id || !S.impactHasEndpoint) return '';
  return JRN_IMPDOOR + esc(id) + '" title="' + esc(def('impact.door') || '') + '">' + esc(t('impact.door')) + '</a></div>';
}
/**
 * The tests foot: one evidence chip — the core's word, never the viewer's — with
 * the run that earned it printed beside it, the counts as its caption (cases per
 * level, every number with its tip), and the covering tests' own last run on a
 * line of its own, labelled as theirs. Never a percentage — the metric with its
 * bound lives on the Tests surface.
 *
 * The business register prints the same facts as two sentences: how many tests
 * reach this and how many of them end to end, then the sentence the core wrote
 * for the evidence (`evidenceWord.biz`) — so a coverage report alone reads *a
 * coverage run reached this code … it does not say which test did*, and never
 * *a run reached this code* above a Tests page that says no e2e run was seen.
 * @group Journey view
 * @business What proves this runs: how many tests reach it, and whether any of them has actually been run.
 */
export function jrnTestsFootHtml(facts, opts) {
  const o = opts || {};
  const business = currentLens() === 'business';
  if (!(S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.coverage)) {
    return '<div class="jrn-tfoot"><div class="line">' + JRN_FOOT_NONE + esc(t('journey.noTestsSub')) + '">'
      + sym('absent') + esc(t('journey.noTests')) + '</span></div></div>';
  }
  if (facts && facts.notBuilt) {
    // no code, no verdict: what the cases do reach, with that scope — never *passed* on a screen with no code
    return '<div class="jrn-tfoot"><div class="line">' + testChipHtml(facts) + '</div>' + jrnCasesDoorHtml(o.cases) + '</div>';
  }
  if (!facts || (!facts.total && !facts.runLevel)) {
    return '<div class="jrn-tfoot"><div class="line">' + JRN_FOOT_NONE + esc((facts && facts.note) || def('journey.absent.notReached') || '') + '">'
      + sym('absent') + esc(t(o.absent || 'journey.noTestReaches')) + '</span></div>' + jrnFootWiderHtml(o.wider) + jrnImpactDoorHtml(o.impact) + '</div>';
  }
  // one chip: the count, the scope it counts over, the cell's one word, and the skips beside it (round 2026-10-10)
  // — a table's accessors carry no typed count, so their foot keeps the plain evidence chip
  const chip = testChipHtml(facts) || jrnEvChipHtml(facts);
  const k = facts.counted || {};
  // a number the core typed carries its own tip; one it did not (a table's
  // accessors) prints as the plain number it is
  const num = (c, n) => (c ? jrnCountedHtml(c, { num: true, noFocus: true }) : esc(String(n)));
  if (business) {
    const ev = evidenceWord(facts);
    const runKey = ev.biz || (facts.chip === 'observed-stale' ? 'journey.biz.testsRun.stale' : 'journey.biz.testsRun.none');
    return '<div class="jrn-tfoot"><div class="line">' + chip + '</div>'
      + '<div class="line biz">' + esc(t(runKey)) + '</div>' + jrnCasesDoorHtml(o.cases) + jrnImpactDoorHtml(o.impact) + '</div>';
  }
  const obs = jrnObsText(facts);
  return '<div class="jrn-tfoot">'
    + '<div class="line">' + chip + (obs ? '<span class="obs">' + esc(obs) + '</span>' : '') + '</div>'
    + (chip.indexOf('data-tchip') >= 0 ? '' : jrnFootScopeHtml(facts)) + '<div class="line"><span class="cnt">'
    + esc(t('journey.tests.foot')).replace('{e2e}', () => num(k.e2e, facts.e2e)).replace('{unit}', () => num(k.unit, facts.unit))
      .replace('{int}', () => num(k.integration, facts.integration)).replace('{obs}', () => num(k.observed, facts.observed)) + '</span></div>'
    + jrnRunLineHtml(facts, chip.indexOf('data-tchip') >= 0)
    + jrnCasesDoorHtml(o.cases)
    + jrnImpactDoorHtml(o.impact) + '</div>';
}
/**
 * The *Verified by* cell of one action: the foot over the core's own fold for
 * that action (`coverage.moments`) — one chip for the class the action's own
 * tests carry, the run behind it, the counts as its caption. One chip per cell,
 * and it describes that cell (board 07, §4.4).
 * @group Journey view
 * @business Which tests prove this action — and when nothing does, it says so.
 */
function jrnSheetVerifiedHtml(sg, mo) {
  const cov = S.JOURNEY.summary && S.JOURNEY.summary.coverage;
  if (!cov) return '<span class="jrn-mk none" title="' + esc(t('journey.noTestsSub')) + '">' + sym('absent') + esc(t('journey.noTests')) + '</span>';
  const k = (sg.moments || []).indexOf(mo);
  return jrnTestsFootHtml(jrnActionTestFacts(sg, mo), { cases: { seg: sg.index, action: k >= 0 ? k : mo.index } });
}
/**
 * One cell: the layer's part in one action. The user layer draws the moment's
 * component (and the screen where a segment starts), the API layer the seam
 * card with its schemas, the gates layer the checkpoints and translated
 * decisions of that action, the code layers their step chips.
 * @group Journey view
 * @business What one layer of the system does during one action of the journey.
 */
function jrnSheetCellHtml(layer, li, col) {
  const { sg, mo } = col;
  const business = currentLens() === 'business';
  let inner = '';
  if (layer.kind === 'user') {
    // the screen itself is what the user sees when the action has no component of its own
    const scr = col.first || !mo.component ? jrnScreenNode(sg) : null;
    inner = (mo.component ? jrnCompSpanHtml(mo) : '')
      + (scr ? '<span class="jrn-mk ui" onclick="jrnSelectSegment(' + sg.index + ')">' + sym('screen') + esc((sg.screen && sg.screen.name) || scr.name || '') + '</span>' : '');
    if (!inner) inner = jrnAbsentHtml(jrnAbsentWord(sg, mo, 'user'));
  } else if (layer.kind === 'gates') {
    // one renderer for the checks, shared with the storyboard and the timeline's
    // lane: the gates as two headed lists in this register's words, the decisions
    // it shows, and what it could not word. The chip cloud this cell used to draw
    // named every checkpoint by its identifier in every register.
    inner = jrnChecksHtml(sg, mo);
  } else if (layer.kind === 'verified') {
    inner = jrnSheetVerifiedHtml(sg, mo);
  } else {
    const mk = jrnSheetCellMarkers(layer, col);
    // a part, then its repeats and what it called folded under it (the seam card keeps its schema chip first)
    const draw = (m) => (m.kind === 'call' ? jrnSeamCardHtml(m) + (business ? '' : jrnSchemaChipHtml(m)) : jrnMarkerHtml(m))
      + jrnCellFoldsHtml(m, mk.tree, null);
    inner = mk.tree.top.length
      ? jrnSheetChipsHtml(mk.tree.top.map(draw), li, col.index)
      : jrnAbsentHtml(jrnAbsentWord(sg, mo, layer.key));
  }
  return '<div class="jrn-scell ' + esc(layer.cls || '') + '" data-layer="' + li + '" data-col="' + col.index + '" data-sys="' + esc(layer.key) + '" data-seg="' + sg.index + '" data-mo="' + mo.index + '">' + inner + '</div>';
}
/**
 * One column head — the action stop: its ordinal, its name, a person glyph
 * when a screen made the call or a system glyph when nothing client-side did,
 * the contract statuses it can answer with (they come from the spec, so they
 * are tagged as such), ↺ when the walk already ran it.
 * @group Journey view
 * @business One action of the journey: what the person (or the system) does, and what the contract says can come back.
 */
function jrnSheetHeadHtml(col) {
  const mo = col.mo, sg = col.sg;
  const call = jrnSheetMomentCall(sg, mo);
  const n = call ? ((S.JOURNEY.steps[call.stepOrder] || {}).node || {}) : {};
  const outs = ((n.contract && n.contract.responses) || []).map((r) => {
    const cls = /^2/.test(String(r.status)) ? ' ok' : /^4/.test(String(r.status)) ? ' warn' : '';
    return '<span class="api-chip st' + cls + '" title="' + esc(t('journey.fromSpec') + ' · ' + (r.description || '')) + '">' + esc(String(r.status)) + '</span>';
  }).join('');
  const cut = jrnMomentCut(sg, mo);
  return '<div class="jrn-sbh' + (mo.repeat ? ' rep' : '') + '" data-col="' + col.index + '"'
    + ' onclick="jrnScrollTo(' + (mo.callStep != null ? mo.callStep : mo.actionStep) + ')" title="' + esc([jrnMoLabel(mo), mo.business || mo.label].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ')) + '">'
    // the name clamps to two lines inside its column; the title carries it whole
    + '<span class="t"><span class="ord">' + (col.index + 1) + '</span>' + sym(mo.component ? 'human' : 'automation') + '<span class="tx">' + esc(jrnMoLabel(mo)) + '</span></span>'
    + '<span class="out">' + outs
      + (mo.repeat ? '<span class="api-chip rep">' + esc(t('journey.repeated')) + '</span>' : '')
      + (cut ? '<span class="api-chip warn">' + esc(t('journey.countCut').replace('{n}', cut)) + '</span>' : '')
    + '</span></div>';
}
/** The screen a run of columns belongs to, spanning them — name, route,
 * design id and (outside the code lens) the thumbnail it was designed as.
 * @group Journey view */
function jrnSheetScreenHtml(sg, from, span) {
  const n = jrnScreenNode(sg);
  const name = (sg.screen && sg.screen.name) || (n && n.name) || t('journey.beforeFirstScreen');
  // the route is code: the business lens reads the screen's name alone
  const sub = n && n.name !== name && currentLens() !== 'business' ? n.name : '';
  return '<div class="jrn-sscr' + (sg.screen ? '' : ' entry') + '" style="grid-column:' + (from + 2) + ' / span ' + span + '" onclick="jrnSelectSegment(' + sg.index + ')">'
    + (n ? designThumbHtml(n, 'sheet') : '')
    + '<span class="tx"><span class="t">' + jrnDesignIdHtml(sg) + esc(name) + '</span>'
    + (sub ? '<span class="s">' + esc(sub) + '</span>' : '') + '</span></div>';
}
/** j/k order in the sheet: down a column, then on to the next action — the way
 * the sheet is read. Folded plumbing joins the walk when its fold is opened.
 * @group Journey view */
function jrnSheetOrders() {
  const sh = S.JRN_SHEET;
  if (!sh) return [];
  const out = [];
  sh.cols.forEach((col) => sh.layers.forEach((layer) => {
    jrnSheetCellMarkers(layer, col).ms.forEach((m) => out.push(m.stepOrder));
  }));
  return out;
}
/**
 * Index the sheet before it is drawn: the model on S (the cell functions and
 * j/k read it), every marker's layer row (so the expansion slot opens under
 * its own layer) and the j/k walk order.
 * @group Journey view
 */
export function jrnSheetIndex(sum) {
  S.JRN_SHEET = jrnSheetModel(sum);
  const byKey = {};
  S.JRN_SHEET.layers.forEach((l, li) => { if (l.key) byKey[l.key] = li; });
  S.JRN_MARK = {};
  sum.segments.forEach((sg) => sg.markers.forEach((m) => {
    S.JRN_MARK[m.stepOrder] = { seg: sg.index, row: byKey[m.system] != null ? byKey[m.system] : 0 };
  }));
  S.JRN_ORDERS = jrnSheetOrders();
}
/**
 * The whole sheet: the screens spanning their actions, the action stops, then
 * one row per layer with its expansion slot beneath. It scrolls inside the
 * journey frame — the page itself never scrolls sideways.
 * @group Journey view
 * @business The whole journey on one sheet: every action across, every layer of the system down.
 */
export function jrnSheetHtml(sum) {
  const sh = S.JRN_SHEET;
  const cols = sh.cols;
  const style = 'grid-template-columns:' + JRN_SHEET_LANE + 'px repeat(' + cols.length + ',minmax(' + JRN_SHEET_COL + 'px,1fr));'
    + 'min-width:' + (JRN_SHEET_LANE + cols.length * JRN_SHEET_COL) + 'px';
  let html = '<div class="jrn-sheet" style="' + style + '">';
  html += '<div class="jrn-slane scrlane"></div>';
  let at = 0;
  sum.segments.forEach((sg) => {
    const span = (sg.moments || []).length;
    if (!span) return;
    html += jrnSheetScreenHtml(sg, at, span);
    at += span;
  });
  // the corner names what a column is — a stop — and counts them with the core's
  // own number (`counted.actionStops`, the drill's `stop n of t`), so the columns
  // and the number above them are one count, not the header's actions
  const stops = sum.counted && sum.counted.actionStops;
  const cornerKey = currentLens() === 'business' ? 'journey.biz.sheetCorner' : 'journey.sheetCorner';
  html += '<div class="jrn-slane corner"><span class="hud-label"' + tipAttrs({ key: cornerKey, noFocus: true }) + '>' + esc(t(cornerKey)) + '</span>'
    + (stops && stops.n === cols.length ? '<span class="sub">' + jrnCountedHtml(stops, { num: false, noFocus: true }) + '</span>' : '') + '</div>'
    + cols.map(jrnSheetHeadHtml).join('');
  sh.layers.forEach((layer, li) => {
    html += '<div class="jrn-slane ' + esc(layer.cls || '') + '"><span class="hud-label">' + esc(layer.label) + '</span>'
      + (layer.sub ? '<span class="sub">' + esc(layer.sub) + '</span>' : '')
      // the checks lane carries the same control the timeline's lane carries, in
      // the same state: a reader who narrowed to the gates and pressed `v` is
      // still looking at the gates
      + (layer.kind === 'gates' ? jrnBizTabsHtml(sum) : '') + '</div>'
      + cols.map((col) => jrnSheetCellHtml(layer, li, col)).join('')
      + '<div class="jrn-exp jrn-sexp" id="jrn-exp-' + li + '" style="display:none"></div>';
  });
  return html + '</div>';
}

/**
 * The journey header's status lifecycle: one strip per record whose statuses the code declares and
 * that this journey moves (at most two, the rest counted) (`/api/journey` → `lifecycles`, core `journeyLifecycles`) — the statuses in declared
 * order, each move some code makes as a door to its writer, the moves this journey makes lit.
 * `''` when no record the journey reaches declares its statuses.
 * @group Journey view
 * @business Shows the statuses a record goes through and which part of the system moves it to each one.
 */
export function jrnLifecycleHtml(data) {
  const { shown, more } = headerLifecycles(data && data.lifecycles);
  const flow = data && data.entry && data.entry.kind === 'flow' ? data.entry.id : '';
  return shown.map((lc) => lifecycleStripHtml(lc, '/api/journey', { flow })).join('')
    + (more ? '<span class="lc-more"' + defAttrs('lifecycle.more') + '>' + esc(t('lifecycle.more').replace('{n}', more)) + '</span>' : '');
}
/**
 * The header count line: five named groups instead of a run of fourteen counts
 * (pass swarm 2026-09-25 — the staff engineer's *"a run-on of 14 counts"*, and
 * every reviewer's *"none of them names its scope"*). Each group prints one
 * number in its own words — screens (with how many are built), actions, gates &
 * rules, the conditions nobody put in plain language, and the tests with the
 * evidence word and the run behind it — and the rest of the journey's counts
 * sit in the tips of the group they belong to, each under its own name. The code
 * lens adds a sixth, the walk itself, in its developer units.
 *
 * Every number is a typed count the core handed out (`summary.counted`,
 * docs/COUNTS.md) and carries its tip: what it counts, the scope it counts over,
 * where it came from, its breakdown, and the numbers printed beside it. The
 * separators are real text, so the line pastes into a ticket as it reads.
 * @group Journey view
 * @business Says how big the journey is — screens, things to do, checks, what is not in plain words, and what proves it — each number with what it counts on hover or click.
 */
export function jrnHeaderHtml(data, sum, cnt, lens) {
  const business = lens === 'business';
  const C = (name) => jrnC(sum, name);
  const cov = (sum && sum.coverage && sum.coverage.journey) || null;
  // the actions the header counts are the fold's split (`cnt.called`, and beside
  // it `cnt.again` and `cnt.declaredNotCalled`), never the occurrences the band
  // draws — those are the rail's stops, named as stops in the tip
  const actions = C('actions') || (cnt.called != null ? jrnC({ counts: cnt }, 'actions') : null);
  const groups = [];
  const g = (cls, items) => { const html = items.filter(Boolean).join(' · '); if (html) groups.push('<span class="jrn-hg ' + cls + '">' + html + '</span>'); };
  // screens: the list is the tip — the screens in order, built or not
  const screens = C('screens');
  g('g-screens', [
    screens ? '<span class="jrn-num jrn-screens"' + tipAttrs({ id: 'jrnScreens' }) + '>' + esc(jrnCountedWords(screens)) + '</span>' : '',
    jrnCountedHtml(C('built'), { cls: 'jrn-built' }),
  ]);
  // what a person can do; again, declared-not-called and the rail's stops are
  // other numbers about the same calls, so they are named in its tip, never summed into it
  const touches = ((sum && sum.systems) || []).filter((r) => r.kind === 'records' || r.kind === 'messages' || r.kind === 'external').map((r) => r.label);
  g('g-actions', [
    jrnCountedHtml(actions, { cls: 'jrn-actions', rel: [C('again'), C('declaredNotCalled'), C('actionStops'), C('planned'), C('setup'), C('deferred'), C('choices'), C('systems')] }),
    business && touches.length ? '<span class="jrn-touches">' + esc(t('journey.biz.touches').replace('{systems}', touches.join(' · '))) + '</span>' : '',
  ]);
  // the gates split by who they matter to (gates lane 2026-10-10): two numbers that partition the
  // gates & rules — the whole sits in their tips, so the header never prints three claims about one list
  if (C('gatesBusiness')) {
    g('g-gates', [
      jrnCountedHtml(C('gatesBusiness'), { cls: 'jrn-gates-biz', rel: [C('gates'), C('checks'), C('decisions')] }),
      jrnCountedHtml(C('gatesTechnical'), { cls: 'jrn-gates-tech', rel: [C('gates')] }),
    ]);
  } else g('g-gates', [jrnCountedHtml(C('gates'), { rel: [C('checks'), C('decisions')] })]);
  // the whole — technical conditions plus gate conditions nobody labelled — in
  // every lens: one concept, one number. The header uses the short words; the
  // tip heads with the business sentence in the business lens.
  g('g-words', [jrnCountedHtml(C('notInWords'), { unit: 'count.unit.notInWords', cls: 'jrn-untrn', rel: [C('decisions'), C('inWords')], list: { t: true, g: true } })]);
  // the tests: how many reach the journey, the evidence word, and the run behind
  // it beside the word — so *seen by a coverage run* never stands alone above a
  // `0 observed` it does not explain. The e2e rung is in the tests' tip.
  const ev = cov ? evidenceWord(cov) : { cls: 'none', key: '' };
  const facts = cov ? jrnFoldFacts(cov) : null;
  const tk = (cov && cov.counted) || {};
  const chipCls = ev.cls === 'none' ? '' : ev.cls;
  // the shared-evidence case says it in a sentence: nothing of this flow is
  // built, so no word about it is a claim this flow can earn (blocker 2)
  const evHtml = cov && cov.sharedEvidence
    ? '<span class="jrn-e2e shared"' + tipAttrs({ key: 'journey.evidenceShared' }) + '>' + esc(t('journey.evidenceShared')) + '</span>'
    : chipCls ? '<span class="jrn-e2e ' + esc(chipCls) + '"' + tipAttrs({ id: 'jrnEvidence', args: { ev, obs: (cov && cov.observation) || null, verdict: cov && cov.verdict ? { status: cov.verdict.status } : null, fresh: (cov && cov.freshness) || null } }) + '>' + esc(t(ev.key)) + '</span>' : '';
  const obs = !business && facts && !(cov && cov.sharedEvidence) ? jrnObsText(facts) : '';
  g('g-tests', [
    // one chip: the cases, *over this journey*, *distinct* beside per-screen counts (its tip is the per-screen
    // table), the one word and the skips — the shared-evidence case keeps its sentence instead of the word
    cov && cov.counted && cov.counted.tests && cov.counted.tests.n
      ? testChipHtml(facts, { distinct: distinctArgs(sum), word: !cov.sharedEvidence, cls: 'jrn-htests', evCls: 'jrn-e2e' }) + (cov.sharedEvidence ? ' ' + evHtml : '')
      : jrnCountedHtml(tk.tests, { rel: [tk.e2e, tk.unit, tk.integration, tk.runReports] }) + evHtml,
    obs ? '<span class="jrn-obs">' + esc(obs) + '</span>' : '',
    // the freshness sentence beside the word: *stale* with both sides, or *current as of sync N* (finding 2)
    cov && !cov.sharedEvidence ? freshLineHtml(cov.freshness, 'jrn-fresh') : '',
  ]);
  // the walk, in the code lens only: its units are a developer's
  if (lens === 'code') {
    g('g-walk', [jrnCountedHtml(C('steps'), { rel: [C('repeats'), C('planned'), C('cutPoints'), C('systems')] })]);
  }
  return groups.join('<span class="jrn-hsep"> · </span>');
}
/** A window of step i's own code around one line — the caller/handler slices of a seam splice.
 * @group Journey view */
function jrnCodeWindow(i, around, span) {
  const s = S.JOURNEY.steps[i];
  if (!s || s.code == null || s.code === '') return '';
  const lines = String(s.code).split('\n');
  const start = s.codeStartLine || (s.node && s.node.loc && s.node.loc.line) || 1;
  const at = around || start;
  const from = Math.max(start, at - span), to = Math.min(start + lines.length - 1, at + span);
  return jrnCodeSeg(s, i, from, to, lines, start, new Set(around ? [around] : []));
}
/** The contract block of a call: what the operation does, requires, returns and how it stands against the code.
 * @group Journey view */
export function jrnContractHtml(n) {
  const c = n.contract;
  if (!c) return '';
  const row = (k, v) => '<span class="k">' + esc(k) + '</span><span>' + v + '</span>';
  const statusKey = c.status === 'both' ? 'apis.status.both' : c.status === 'spec-only' ? 'apis.status.specOnly'
    : c.status === 'declared' ? 'apis.status.declared' : c.status === 'code-only' ? 'apis.status.codeOnly' : 'apis.status.implemented';
  let out = '<div class="jrn-contract-card"><span class="hd">' + sym('api') + esc(t('journey.contractHead')) + '</span>';
  if (c.summary || c.description) out += row(t('journey.contract.does'), proseHtml(c.description || c.summary));
  if ((c.security || []).length) out += row(t('journey.contract.requires'), (c.security || []).map((x) => sym('lock') + esc(x)).join(' '));
  const ret = (c.responses || []).filter((r) => /^2/.test(String(r.status)));
  if (ret.length) out += row(t('journey.contract.returns'), ret.map((r) => '<code>' + esc(r.status + (r.schema ? ' ' + r.schema : '')) + '</code>').join(' '));
  out += row(t('journey.contract.status'), esc(t(statusKey)));
  (c.drift || []).forEach((d) => { out += row('', '<span class="drift">' + esc(t('apis.drift.' + d.kind)) + '</span>'); });
  return out + '</div>';
}
/**
 * The selected marker's panel, rendered into its system row's expansion slot
 * or into the docked code pane: the same five tabs the drill's inspector draws
 * — docs · request/response · code · forks · tests — and the same head, so one
 * step answers the same questions in the same order wherever it is opened
 * (B4.1). It opens on **DOCS** outside the code register: what the people who
 * wrote this said it is for, before the code that implements it. The CODE tab
 * is what this slot used to be: the seam splice for a call, the Wallaby-style
 * spliced timeline for everything else.
 * @group Journey view
 * @business Opens one part of the journey: what it is for, what it promises, what it does, and what proves it runs.
 */
function jrnExpHtml(i) {
  return '<div class="jrn-insp">' + jrnInspPanelHtml(i) + '</div>';
}
/**
 * One step's own side of a transaction boundary, in the register the lens asks
 * for. Drawn wherever a step opens — the rows and sheet expansions and the
 * drill's inspector — so the fact is not reachable only by hovering a chip, and
 * so the drill flag being off cannot hide it.
 *
 * Silence is a claim-free answer: this step is not written inside a transaction
 * its caller opened. When the graph records no boundary anywhere, the fallback
 * sentence stands in its place, because absent is not a side.
 * @group Journey view
 */
export function jrnTxLineHtml(mk) {
  const biz = currentLens() === 'business';
  if (S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.txKnown === false) {
    return '<div class="jrn-insp-tx none">' + esc(t(biz ? 'journey.biz.txFallback' : 'journey.drill.txFallback')) + '</div>';
  }
  if (!mk || !mk.tx) return '';
  const key = (biz ? 'journey.biz.tx.' : 'journey.tx.') + mk.tx;
  return '<div class="jrn-insp-tx ' + mk.tx + '" title="' + esc(def(key)) + '">' + esc(t(key)) + '</div>';
}
/** The body of a step's expansion without its head — the seam splice for a call, the spliced code for anything else (the drill's CODE tab draws this alone).
 * @group Journey view */
export function jrnExpBodyHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const mk = jrnMarkerAt(i);
  // a call with several implementations opens with all of them, then the code
  const oneof = mk && mk.choice ? jrnChoiceHtml(mk.choice) : '';
  if (oneof) return oneof + '<div class="jrn-code">' + jrnSectionHtml(i) + '</div>';
  if (mk && mk.kind === 'call') {
    const where = (e, label) => e
      ? '<span class="from">' + esc(label + ' ' + e.path + ':' + e.line) + vsl(e.repo, e.path, e.line) + '</span>'
      : '<span class="from miss">' + esc(label + ' ' + t('journey.seam.notBuilt')) + '</span>';
    const caller = mk.caller ? '<span class="from">' + esc(mk.caller.name + ' · ' + mk.caller.path) + vsl(mk.caller.repo, mk.caller.path, mk.caller.line) + '</span>' : '';
    const route = n.loc ? '<span class="from">' + esc((n.name || '') + ' · ' + n.loc.path + ':' + n.loc.line) + vsl(n.repo, n.loc.path, n.loc.line) + '</span>' : '';
    // the caller's fetch line, then the route's own registration, then what it continues into
    const callerCode = mk.caller ? jrnCodeWindow(i - 1, mk.caller.line, 2) : '';
    const routeCode = mk.handler ? jrnCodeWindow(i, mk.handler.line, 1) : '';
    const next = S.JOURNEY.steps[i + 1];
    const cont = next && next.node && next.node.loc && next.depth === s.depth + 1;
    return '<div class="jrn-splice3">'
      + '<div class="side ux"><span class="hud-label">← ' + esc(t('journey.seam.uxSide')) + '</span>' + caller + where(mk.caller, '←' + ' ' + t('journey.seam.from')) + callerCode + '</div>'
      + '<div class="side ct">' + jrnContractHtml(n) + jrnReqChips(i) + '</div>'
      + '<div class="side sv"><span class="hud-label">→ ' + esc(t('journey.seam.apiSide')) + '</span>' + route + where(mk.handler, '→ ' + t('journey.seam.handled')) + routeCode
      + (cont ? '<span class="from">' + esc(t('journey.seam.continues')) + ' ▸ ' + esc(jrnLabel(next.node) + ' · ' + next.node.loc.path + ':' + next.node.loc.line) + vsl(next.node.repo, next.node.loc.path, next.node.loc.line) + '</span>' + jrnCodeWindow(i + 1, null, 2) : '')
      + '</div></div>';
  }
  return '<div class="jrn-code">' + jrnSectionHtml(i) + '</div>';
}
/** The summary marker for a step order (the fold's facts, not the walk's).
 * @group Journey view */
export function jrnMarkerAt(i) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return null;
  for (const sg of sum.segments) { const m = sg.markers.find((x) => x.stepOrder === i); if (m) return m; }
  return null;
}
/**
 * Select a marker by step order: ring it, open its contract / code in the
 * expansion slot under its system row (or in the pinned pane when the dock is
 * bottom / right), fill the progress bars. -1 closes the expansion. Called by markers, gates, chips, the forks drawer and j/k.
 * @group Journey view
 */
export function jrnSelect(i, noScroll) {
  if (!S.JOURNEY) return;
  if (i >= 0 && S.JRN_DRILL) jrnDrillEnsureAction(i);
  if (i >= 0) jrnRevealFold(i);
  S.journeyActive = i;
  jrnHostEl().querySelectorAll('.jrn-mk, .jrn-seam, .jrn-bx').forEach((el) => el.classList.toggle('on', +el.dataset.order === i));
  jrnHostEl().querySelectorAll('.jrn-exp').forEach((el) => { el.style.display = 'none'; el.innerHTML = ''; });
  const mk = S.JRN_MARK[i];
  if (S.JRN_DRILL) jrnDrillSelected(mk && mk.row >= 0 ? i : -1);
  else if (jrnDock() !== 'inline') jrnDockRender(mk && mk.row >= 0 ? i : -1);
  else if (mk && mk.row >= 0) {
    const slot = document.getElementById('jrn-exp-' + mk.row);
    if (slot) { slot.innerHTML = jrnExpHtml(i); slot.style.display = ''; }
  }
  if (!noScroll) {
    const el = jrnHostEl().querySelector('.jrn-mk[data-order="' + i + '"], .jrn-seam[data-order="' + i + '"], .jrn-bx[data-order="' + i + '"]');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  jrnImpactRings();
  // the stop on the Map keeps its address on the part selected (surfaces/map-stops.js)
  if (S.JRN_ON_SELECT) S.JRN_ON_SELECT(i);
}
/** Select a segment (its header or business step): its first marker, else just highlight it.
 * @group Journey view */
export function jrnSelectSegment(si) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const sg = sum && sum.segments[si];
  if (!sg) return;
  if (sg.markers.length) jrnSelect(sg.markers[0].stepOrder);
  else { S.journeyActive = sg.from; jrnSelect(-1, true); S.journeyActive = sg.from; }
}
/**
 * Jump to step i from a chip, a gate or the forks drawer: the step's own
 * marker when it has one, else the nearest marker that owns it (a planned
 * receives/does/returns row belongs to its call; a screen row to its
 * segment's first marker).
 * @group Journey view
 */
export function jrnScrollTo(i) {
  if (!S.JOURNEY || !S.JRN_MARK) return;
  let cur = i;
  while (cur != null && cur >= 0 && !S.JRN_MARK[cur]) cur = S.JRN_TREE.parent[cur];
  if (cur != null && cur >= 0 && S.JRN_MARK[cur]) { jrnSelect(cur); return; }
  const sum = S.JOURNEY.summary;
  const sg = sum && sum.segments.find((x) => i >= x.from && i <= x.to);
  if (sg) jrnSelectSegment(sg.index);
}
/** Step to the next/previous marker on the timeline (j/k keys).
 * @group Journey view */
export function jrnNav(d) {
  const orders = S.JRN_ORDERS || [];
  if (!orders.length) return;
  const at = orders.indexOf(S.journeyActive);
  const next = at < 0 ? (d > 0 ? 0 : orders.length - 1) : Math.max(0, Math.min(orders.length - 1, at + d));
  jrnSelect(orders[next]);
}
/** Expand a collapsed repeat/cycle row in place, revealing its spliced body.
 * @group Journey view */
function jrnExpandRepeat(btn) {
  if (window.event) window.event.stopPropagation();
  const sec = btn.closest('.jrn-sec');
  const body = sec && sec.querySelector('.jrn-repeat-body');
  if (body) { body.style.display = ''; btn.style.display = 'none'; sec.classList.remove('jrn-collapsed'); }
}

/**
 * Where the journey's drawing lives: the Map's stage at a stop below the street (`S.JRN_HOST`, set by
 * surfaces/map-stops.js) — the table or the action's beats. Selection, folds and rings look inside it.
 * @group Journey view
 */
export function jrnHostEl() {
  const h = S.JRN_HOST;
  return h && h.isConnected ? h : document.body;
}
/** Whether the forks drawer is open (Esc routing).
 * @group Journey view */
export function forksOpen() { return S.jrnForksOpen; }
/** Whether a marker's contract / code is expanded (Esc closes it before the stop).
 * @group Journey view */
export function expandedOpen() { return !!(S.JOURNEY && S.JRN_MARK && S.journeyActive >= 0 && S.JRN_MARK[S.journeyActive]); }
/** Close the expanded marker (Esc routing).
 * @group Journey view */
export function closeExpanded() { jrnSelect(-1, true); }

// ── the cut list: where the walk stopped short (the Map's table carries it) ──
/**
 * The header's cut-points chip: how many subtrees the walk did not follow, and
 * why, by reason. A walk that never hit a budget says nothing at all — and
 * TRUNCATED stays reserved for the one thing it means, the step budget.
 *
 * The chip is a button: its number is the length of a list, and a count a
 * reader cannot open is the thing this phase exists to remove. Both the
 * tooltip's breakdown and the list behind it are built from the same filter the
 * core counts with — `reason !== 'repeat'` — so neither can disagree with the
 * number on the chip. Re-visits were walked once and drawn once; they are named
 * at the foot of the list, never added to it.
 * @group Journey view
 * @business Says how much of the journey was left unwalked, and why — instead of implying the whole thing is complete. Click it for the list.
 */
export function jrnCutChip(data, cnt) {
  const el = document.getElementById('jrn-cuts');
  if (!el) return;
  const n = cnt.cutPoints || 0;
  jrnToggleCuts(false);
  el.style.display = n ? '' : 'none';
  if (!n) { el.innerHTML = ''; jrnCutListFill(null, cnt); return; }
  // the same cuts the number counts: a re-visit hides nothing, so it is not one
  const cuts = (data.cutPoints || []).filter((c) => c.reason !== 'repeat');
  const by = {};
  cuts.forEach((c) => { by[c.reason] = (by[c.reason] || 0) + 1; });
  // the chip is a button (it opens the list); its number carries the tip — what a
  // cut point is, over the journey, split by the budget that ran out
  const c = sum0Cut(data, n, by);
  el.innerHTML = sym('warning') + esc(t(countKey('journey.cutPoints', n))).replace('{n}', () => '<span class="jrn-num"' + tipAttrs({ number: c, noFocus: true }) + '>' + n + '</span>');
  el.removeAttribute('title');
  jrnCutListFill(data.summary, cnt);
}
/** The cut chip's number tip: the count, over the journey, split by reason (the parts add up to it). */
function sum0Cut(data, n, by) {
  const rows = jrnCutReasons(by).map((k) => [t('journey.cutReason.' + k).replace('{n}', '').trim(), by[k]]);
  return { count: n, of: 'journey.cutPoints', scope: 'journey.scopeAll', source: tipSource('/api/journey'), breakdown: rows.length ? { rows } : undefined };
}
/** The reasons a cut can have, the known ones first — an unknown one from a newer core still lists, last.
 * @group Journey view */
function jrnCutReasons(by) {
  const known = ['depth', 'steps'].filter((r) => by[r]);
  return known.concat(Object.keys(by).filter((r) => !known.includes(r)));
}
/**
 * Every cut point of this journey as one flat list in walk order, each row
 * carrying where it happened: the marker the core hung it on (the call site
 * that owns the fold, never a step no surface draws), the screen, and which
 * action of that screen. Read from `summary.segments[].cutPoints`, which the
 * core fills from the same filtered array `counts.cutPoints` counts — so the
 * list is the chip's number, itemised, and not a second count of the same thing.
 * @group Journey view
 */
function jrnCutRows(sum) {
  const entry = (S.JOURNEY && S.JOURNEY.entry) || {};
  const entryName = (entry.design && entry.design.name) || jrnLabel(entry);
  return (sum.segments || []).flatMap((sg) => (sg.cutPoints || []).map((c) => {
    const mo = (sg.moments || []).find((m) => m.index === c.moment);
    const mk = (sg.markers || []).find((m) => m.stepOrder === c.parentStep);
    return {
      reason: c.reason,
      name: c.name || c.nodeId,
      seg: sg.index,
      moment: c.moment,
      parentStep: c.parentStep,
      parent: (mk && mk.name) || '',
      action: mo ? jrnMomOrdinal(sg, mo) : c.moment + 1,
      screen: (sg.screen && sg.screen.name) || entryName,
    };
  }));
}
/** One row of the cut list: what the walk did not enter, and where it was standing when it stopped.
 * @group Journey view */
function jrnCutRowHtml(r) {
  const where = t('journey.cutPoint.row').replace('{parent}', r.parent).replace('{a}', r.action).replace('{screen}', r.screen);
  return '<button class="jrn-cut-entry" onclick="jrnCutJump(' + r.seg + ',' + r.moment + ',' + r.parentStep + ')" title="' + esc(def('journey.cutPoint.row') || '') + '">'
    + '<span class="jrn-cut-what">' + esc(r.name) + '</span>'
    + '<span class="jrn-cut-where">' + esc(where) + '</span></button>';
}
/**
 * Draw the drawer behind the chip: the chip's own number as the head, the
 * sentence that defines it, then one group per budget that ran out with its
 * count — the groups add up to the head, which is the whole point of opening
 * it. Re-visits close the panel as a separate fact, outside the sum, because
 * the walk did see them.
 * @group Journey view
 * @business Lists every place the walk stopped short, so the number in the header can be checked and walked.
 */
function jrnCutListFill(sum, cnt) {
  const d = document.getElementById('jrn-cutlist');
  if (!d) return;
  const n = cnt.cutPoints || 0;
  if (!sum || !Array.isArray(sum.segments) || !n) { d.innerHTML = ''; return; }
  const rows = jrnCutRows(sum);
  const by = {};
  rows.forEach((r) => { (by[r.reason] = by[r.reason] || []).push(r); });
  const head = t(countKey('journey.cutPoints', n)).replace('{n}', n);
  d.setAttribute('aria-label', head);
  d.innerHTML = '<div class="jrn-fkp-head"><span class="hud-label">' + sym('warning') + ' ' + esc(head) + '</span>'
    + '<button class="x" onclick="jrnToggleCuts(false)" aria-label="Close">✕</button></div>'
    + '<p class="jrn-cut-sub">' + esc(def('journey.cutPoints') || '') + '</p>'
    + jrnCutReasons(by).map((r) => '<div class="jrn-fkp-cat"><span class="jrn-cut-reason">'
      + esc(t('journey.cutReason.' + r).replace('{n}', by[r].length)) + '</span></div>'
      + by[r].map(jrnCutRowHtml).join('')).join('')
    + (cnt.repeats ? '<div class="jrn-cut-foot" title="' + esc(def('journey.countRepeats') || '') + '">'
      + esc(t('journey.countRepeats').replace('{n}', cnt.repeats)) + '</div>' : '');
}
/** Open / close the cut list (pass true/false to force a state).
 * @group Journey view */
export function jrnToggleCuts(force) {
  S.jrnCutsOpen = (force === true || force === false) ? force : !S.jrnCutsOpen;
  const d = document.getElementById('jrn-cutlist');
  if (d) { d.classList.toggle('open', S.jrnCutsOpen); jrnDrawerInert(d, S.jrnCutsOpen); }
  const chip = document.getElementById('jrn-cuts');
  if (chip) chip.setAttribute('aria-expanded', S.jrnCutsOpen ? 'true' : 'false');
}
/**
 * Go to a cut point: the usual jump opens every fold above the step (and the
 * table's cell) and selects it. The drawer closes
 * on the way, because a marker behind the drawer is not one the reader can see.
 * @group Journey view
 * @business Takes you to the step the walk was on when it stopped, and opens whatever was hiding it.
 */
function jrnCutJump(si, mi, order) {
  jrnToggleCuts(false);
  jrnScrollTo(order);
}
/** Whether the cut list is open (Esc routing).
 * @group Journey view */
export function cutsOpen() { return !!S.jrnCutsOpen; }

// ── impact rings on the sheet (B5.4 · dependency-impact §4.3) ────
/**
 * The stop a part of the walk sits in — its column on the Sheet, its stop on the
 * drill's rail: `{ n, t }` (1-based, of the journey's stops), or null when the part
 * belongs to no stop (start-up work, a part before the first screen). A part the
 * band does not draw takes the stop of the nearest drawn part above it.
 *
 * One position, one word (swarm 2026-10-05, finding 3): the drawer used to print
 * the walk's own index (`STEP 232`), a number no other surface shows; the stop is
 * the number the Sheet's column, the drill's rail and the storyboard all print.
 * @group Journey view
 */
export function jrnStopOf(order) {
  return stopOf(S.JOURNEY && S.JOURNEY.summary, order, S.JRN_TREE && S.JRN_TREE.parent);
}
/** `stop n of t` for a part of the walk, or `''` when it sits in no stop. @group Journey view */
export function jrnStopText(order) {
  const st = jrnStopOf(order);
  return st ? t('journey.insp.stopOf').replace('{n}', st.n).replace('{t}', st.t) : '';
}
/**
 * The step a node is drawn at, so an impact row can jump to it instead of
 * re-seeding the panel. The first step that stands on the node wins — a node
 * the walk met several times is one thing, and the earliest place it was met
 * is where a reader starts reading.
 * @group Journey view
 */
export function jrnStepOf(id) {
  if (!S.JOURNEY || !id) return -1;
  const steps = S.JOURNEY.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const n = steps[i] && steps[i].node;
    if (n && n.id === id) return i;
  }
  return -1;
}

/**
 * Ring the cells an open impact answer names. **Shape, not colour**: a solid
 * ring is what uses the seed directly, a dashed ring what reaches it through
 * something else, a dotted ring a place the walk stopped — so the rings read
 * the same in a greyscale print and to a reader who cannot separate the amber
 * from the cyan. The seed itself wears a double ring and the three counts.
 *
 * Drawn over the markers already in the DOM rather than into them, so the same
 * answer rings the rows, the sheet, the ladder and the drill without any of
 * them knowing about impact. Called after every journey render and selection;
 * with no answer open it takes every ring off again.
 * @group Journey view
 * @business Outlines everything that uses the thing you asked about, by how far away it is.
 */
export function jrnImpactRings() {
  const tl = jrnHostEl();
  if (!tl) return;
  const m = S.IMPACT_RINGS;
  const steps = (S.JOURNEY && S.JOURNEY.steps) || [];
  // how many rings this view actually drew: the storyboard has no markers to
  // ring and the drill draws one action at a time, so the panel may not claim
  // rings the reader cannot see
  if (m) m.drawn = 0;
  tl.querySelectorAll('.imp-halo, .imp-more').forEach((el) => el.remove());
  tl.querySelectorAll('[data-order]').forEach((el) => {
    el.classList.remove('imp-1', 'imp-n', 'imp-cut', 'imp-seed');
    if (!m) return;
    const st = steps[+el.dataset.order];
    const id = st && st.node && st.node.id;
    if (!id) return;
    if (id === m.seed) {
      el.classList.add('imp-seed');
      m.drawn++;
      el.insertAdjacentHTML('beforeend', jrnImpactHaloHtml(m));
      return;
    }
    // distance is the outline; being a stop is a second fact and gets a second
    // mark rather than replacing the first — a listed node that the walk also
    // stopped at is both, and neither half may eat the other
    if (m.hop[id] === 1) { el.classList.add('imp-1'); m.drawn++; }
    else if (m.hop[id] > 1) { el.classList.add('imp-n'); m.drawn++; }
    else if (m.cut.has(id)) { el.classList.add('imp-cut'); m.drawn++; }
    if (m.cut.has(id) && m.hop[id]) el.insertAdjacentHTML('beforeend', jrnImpactStopHtml());
  });
}
// written out whole: an attribute assembled from pieces reads as prose to the lint
const JRN_HALO = '<span class="imp-halo" title="';
const JRN_STOPMARK = '<span class="imp-more" title="';
/** The mark on a listed node the walk also stopped at: more stands behind it.
 * @group Journey view */
function jrnImpactStopHtml() {
  return JRN_STOPMARK + esc(def('impact.ring.stop') || '') + '">' + esc('\u22ef') + '</span>';
}
/** The seed's halo: three answers to three questions, which overlap and are never added.
 * @group Journey view */
function jrnImpactHaloHtml(m) {
  const tip = t('impact.halo').replace('{d}', m.direct).replace('{t}', m.through).replace('{c}', m.behind);
  return JRN_HALO + esc(tip) + '">' + esc('\u2191' + m.direct + ' \u223c' + m.through + ' \u22ef' + m.behind) + '</span>';
}

expose({ jrnScrollTo, jrnSelect, jrnSelectSegment, jrnToggleFork, jrnToggleForks, jrnForkJump, jrnCopyRecipe, jrnExpandRepeat, jrnNav, jrnSetBizTab, jrnSetDock, jrnDockGrip, jrnSheetOpen, jrnToggleHelpers, jrnLadderMore, jrnToggleCuts, jrnCutJump, jrnImpactRings, jrnStepOf });
