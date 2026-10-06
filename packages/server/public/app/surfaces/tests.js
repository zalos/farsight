// surfaces/tests.js — the Tests surface (03 §1, §4; boards 05 + 08).
//
// Routes: #/tests[?view=matrix|suites|orphans|freshness&level=unit|integration|e2e]
// and #/tests/<testId> — one test's own page, drawn by B3.4. A door from a
// journey keeps its scope: `?flow=<id>` (the journey), `&seg=n` (one screen),
// `&action=k` (one action in it) or `?node=<id>` (one part) opens the page on
// the cases of that cell, with the cell's own verdict (swarm 2026-10-05).
//
// Everything on this page is a fold `/api/tests` already computed, so the tab,
// the CLI and an agent quote the same number. The viewer groups, orders and
// folds what it is given; it never computes a count, a percentage or a
// denominator of its own. Four rules the reviews made non-negotiable:
//
//   1. a percentage never leaves its scope label, and a floor says what made
//      it a floor (`metric.uncertainty.note`);
//   2. an observed chip never stands beside a bare `0`. The fold separates
//      observed *cases* from *run reports*, and this page prints both — so
//      "verified by a run" can never be read as "a test was observed", and a
//      class carried only by run-level coverage says so in a sentence;
//   3. absence is one of the six words, and `reports`/`gaps` **missing** from
//      the payload (no repo in scope recorded any) reads differently from `[]`
//      (the pass ran and named nothing);
//   4. journeys overlap — they share routes, helpers and the tests that reach
//      them — so the matrix says its rows do not add up rather than inviting
//      a reader to add them.

import { S, expose, esc, currentLens, humanize, bizName } from '../store.js';
import { t, def, evidenceWord } from '../strings.js';
import { sym } from '../sym.js';
import { vsl, scopeLabel } from '../lib/graph-render.js';
import { tipAttrs } from '../lib/tooltip.js';
import { countedHtml, countWords, defAttrs, plainTip, unCode } from '../lib/counted.js';

/** True while the business lens is on: file names, runners, globs and hashes stay out.
 * @group Tests tab */
function biz() { return currentLens() === 'business'; }

/** The four lists the surface carries, in the order board 05 draws them. */
const VIEWS = ['matrix', 'suites', 'orphans', 'freshness'];
/** The level filter the server applies to `sources` and `suites`. */
const LEVELS = ['all', 'unit', 'integration', 'e2e'];
/** Blind spots in the order a reader needs them: a missing artefact first, a missing digest last. */
const GAP_RANK = ['missing-artefact', 'unreadable', 'empty', 'unresolved-claim', 'unjoined-each', 'digest-changed', 'no-digest', 'no-config'];
/** The catalog word for each gap kind, and the class that shapes its label. */
const GAP_WORD = {
  'missing-artefact': ['tests.bsKind.missingArtefact', 'missing'],
  unreadable: ['tests.bsKind.unreadable', 'unreadable'],
  empty: ['tests.bsKind.empty', 'empty'],
  'unresolved-claim': ['tests.bsKind.unresolvedClaim', 'claim'],
  'unjoined-each': ['tests.bsKind.unjoinedEach', 'each'],
  'no-digest': ['tests.bsKind.noDigest', 'dig'],
  'digest-changed': ['tests.bsKind.digestChanged', 'dig'],
  'no-config': ['tests.bsKind.noConfig', 'dig'],
};

// Each chip's class, and the one opener that gives it its tip: the word, its
// define and its Grammar Book entry (lib/counted.js defAttrs) — a tip a reader
// can open with a click or a key, where a `title` gave a hover-only bubble.
const EV_CLS = { observed: 'ev observed', stale: 'ev stale', reached: 'ev reached', declared: 'ev declared', none: 'ev absent' };
const ST_CLS = { passed: 'st passed', failed: 'st failed', skipped: 'st skipped', flaky: 'st flaky', unknown: 'st unknown', notrun: 'st notrun' };
const DG_CLS = { unchanged: 'tst-dg unchanged', changed: 'tst-dg changed', unknown: 'tst-dg missing' };

/** A chip's opening tag with its word's tip (none when the word has no define).
 * @group Tests tab */
function tagOpen(cls, key) {
  return '<span class="' + esc(cls) + '"' + tipOf(key) + '>';
}
/** The tip attributes for a catalog word, or nothing when it has no define.
 * @group Tests tab */
function tipOf(key) {
  return key && def(key) ? defAttrs(key) : '';
}
const CASES_OPEN = '<ul class="tst-cases" role="list">';

let DATA = null;          // the last payload — folds redraw from it, never refetch
let VIEW = 'matrix';
let LEVEL = 'all';
let DETAIL = null;        // #/tests/<id>
let SCOPED = null;        // { flow, seg, action, node } — the cell a journey's door was opened from
let SCOPED_DATA = null;   // its answer: the cell's coverage and its cases, each with its own word
const OPEN = new Set();   // which folds are open, by key

/** `?scope=` for /api/tests, from the viewer's multi-select scope.
 * @group Tests tab */
function scopeParam() {
  return S.scope === 'all' || !S.scope.length ? 'all' : S.scope.join(',');
}

/**
 * A sentence the fold wrote, with its backticked artefact names drawn as code —
 * the same treatment the APIs card gives a spec's description, so a reader never
 * sees a raw backtick. Escapes first: the text names files, not markup. The
 * business lens reads the same sentence with the file names said in words.
 * @group Tests tab
 */
function mdCode(text) {
  if (biz()) return esc(unCode(text));
  return esc(String(text || '')).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * A spec file as the business lens names it: the outermost `describe` its
 * author wrote, or the file's name in words — never the path.
 * @group Tests tab
 */
function suiteName(s) {
  const title = (s.cases || []).map((c) => (c.suite || [])[0]).find(Boolean);
  // a describe named after the function it tests is still an identifier
  if (title) return /^[\w.$]+$/.test(title) ? humanize(title) : unCode(title);
  const base = String(s.file || '').split('/').pop().replace(/\.(pw\.)?(spec|test)\.[tj]sx?$/, '').replace(/\.[tj]sx?$/, '');
  return humanize(base);
}

/** A link to this surface — every navigation here is a plain hash href.
 * @group Tests tab */
function tHref(view, level) {
  const q = [];
  if (view && view !== 'matrix') q.push('view=' + encodeURIComponent(view));
  if (level && level !== 'all') q.push('level=' + encodeURIComponent(level));
  return '#/tests' + (q.length ? '?' + q.join('&') : '');
}

/**
 * Mount the Tests surface for the current route: the strip first, so the page
 * says what it is while the catalogue is still in flight.
 * @group Tests tab
 * @business The proving grounds: every test the graph indexes, what each one reaches, and how much of each journey a test has touched.
 */
export function mountTests(route, el) {
  document.body.classList.remove('surface-graph');
  VIEW = VIEWS.includes(route && route.view) ? route.view : 'matrix';
  LEVEL = LEVELS.includes(route && route.level) ? route.level : 'all';
  DETAIL = route && route.param ? decodeURIComponent(route.param) : null;
  SCOPED = DETAIL ? null : scopedFromHash();
  SCOPED_DATA = null;
  DATA = null;
  OPEN.clear();
  el.innerHTML = '<div class="tst-wrap">' + stripHtml(null, !!DETAIL) + '<div id="tst-body"><p class="set-note">'
    + esc(t('tests.loading')) + '</p></div></div>';
  // #/tests/<id> asks for that one test; the catalogue is a different request
  // and the page must not imply the whole scope was measured to draw it
  (DETAIL ? loadDetail() : load()).catch(() => {
    const b = document.getElementById('tst-body');
    if (b) b.innerHTML = '<p class="set-note">' + esc(t('sys.testsFailed')) + '</p>';
  });
}

/**
 * The cell a door opened this page on, read from the address: `flow` (+ `seg`,
 * + `action`) or `node`. Null for the plain catalogue.
 * @group Tests tab
 */
function scopedFromHash() {
  const h = location.hash || '';
  const qi = h.indexOf('?');
  if (qi < 0) return null;
  const q = new URLSearchParams(h.slice(qi + 1));
  const flow = q.get('flow'), node = q.get('node');
  if (!flow && !node) return null;
  const num = (k) => (q.get(k) != null && /^\d+$/.test(q.get(k)) ? Number(q.get(k)) : null);
  return { flow, node, seg: num('seg'), action: num('action') };
}

/** The answer for a scoped cell: one node, one screen or action of a journey, or a whole journey.
 * @group Tests tab */
function scopedUrl(sc) {
  if (sc.node) return '/api/tests?node=' + encodeURIComponent(sc.node);
  const base = '/api/tests?flow=' + encodeURIComponent(sc.flow);
  return sc.seg != null ? base + '&seg=' + sc.seg + (sc.action != null ? '&action=' + sc.action : '') : base + '&lean=1&cases=1';
}

/** Fetch the catalogue for the current scope and level, then draw it.
 * @group Tests tab */
async function load() {
  if (SCOPED) {
    // the cell first: it is what the reader came for, and the catalogue under it is the context
    SCOPED_DATA = await fetch(scopedUrl(SCOPED)).then((r) => (r.ok ? r.json() : { error: String(r.status) })).catch(() => ({ error: 'fetch' }));
  }
  // lean: the page prints counts, so the per-node lists behind them stay on the server (folds.ts leanJourneyRow)
  const q = '?scope=' + encodeURIComponent(scopeParam()) + (LEVEL !== 'all' ? '&level=' + encodeURIComponent(LEVEL) : '') + '&lean=1';
  const r = await fetch('/api/tests' + q);
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) {
    const b = document.getElementById('tst-body');
    if (b) {
      b.innerHTML = '<p class="set-note">' + esc(t('sys.testsFailed')) + '</p>'
        + '<p class="set-note"><span class="mono">' + esc(String(r.status)) + '</span>'
        + (d && d.error ? ' <span class="mono">' + esc(d.error) + '</span>' : '') + '</p>'
        + '<p class="tst-gap"><button class="tst-showall" onclick="testsRetry()">' + esc(t('tests.retry')) + '</button></p>';
    }
    return;
  }
  DATA = d;
  const wrap = document.querySelector('.tst-wrap');
  if (wrap) wrap.innerHTML = stripHtml(d, false) + '<div id="tst-body"></div>';
  renderBody();
}

/**
 * Redraw after the scope or the register moved.
 *
 * The catalogue is *per scope* — `/api/tests` counts, folds and measures inside
 * the sources the scope names — so a scope change asks again, and so does a
 * sync. A register or lens flip changes only the words, and the payload in hand
 * already carries every fact, so it redraws from `DATA` and keeps the open
 * folds. A test detail page names one test by id and is not scoped at all, so
 * a scope change redraws it rather than re-asking.
 * @group Tests tab
 */
export function testsRefresh(reason) {
  const wrap = document.querySelector('.tst-wrap');
  if (!wrap) return;
  // words only, or a detail page that names one test by id and is not scoped
  if (DATA && (reason === 'lens' || reason === 'register' || (DETAIL && reason === 'scope'))) { redraw(); return; }
  const body = document.getElementById('tst-body');
  if (body) body.innerHTML = '<p class="set-note">' + esc(t('tests.loading')) + '</p>';
  DATA = null;
  OPEN.clear();
  (DETAIL ? loadDetail() : load()).catch(() => {
    const b = document.getElementById('tst-body');
    if (b) b.innerHTML = '<p class="set-note">' + esc(t('sys.testsFailed')) + '</p>';
  });
}

/** Draw the strip and the body again from the payload already fetched.
 * @group Tests tab */
function redraw() {
  const wrap = document.querySelector('.tst-wrap');
  if (!wrap || !DATA) return;
  if (DETAIL) { wrap.innerHTML = stripHtml(DATA, true) + '<div id="tst-body">' + detailHtml(DATA) + '</div>'; return; }
  wrap.innerHTML = stripHtml(DATA, false) + '<div id="tst-body"></div>';
  renderBody();
}

/** Ask again after a failure — the same request, no state kept from the error.
 * @group Tests tab */
export function testsRetry() {
  const b = document.getElementById('tst-body');
  if (b) b.innerHTML = '<p class="set-note">' + esc(t('tests.loading')) + '</p>';
  (DETAIL ? loadDetail() : load()).catch(() => {
    if (b) b.innerHTML = '<p class="set-note">' + esc(t('sys.testsFailed')) + '</p>';
  });
}

/** Redraw the body only — opening a fold must not refetch the catalogue.
 * @group Tests tab */
function renderBody() {
  const b = document.getElementById('tst-body');
  if (!b || !DATA) return;
  const d = DATA;
  // no test node in scope: say that and nothing else — an empty table would be
  // read as "nothing is tested", which is a different claim about the code
  if (!d.counts || !d.counts.cases) {
    b.innerHTML = '<div class="tst-sec"><p class="set-note">' + esc(t('tests.empty')) + '</p></div>' + blindSection(d);
    return;
  }
  b.innerHTML = scopedHtml() + kpisHtml(d) + sourcesHtml(d)
    + (VIEW === 'matrix' ? matrixHtml(d)
      : VIEW === 'suites' ? suitesHtml(d)
        : VIEW === 'orphans' ? orphansHtml(d)
          : freshnessHtml(d));
}

// ── the strip: what this page is, which graph it read, and the two filters ──

/**
 * The sticky header: title, the sentence, the graph's identity, the counts, the
 * two switches. One test's own page keeps the identity — every claim on it is
 * as of a named sync — and drops the counts and the filters, which belong to a
 * scope this page did not measure.
 * @group Tests tab
 */
function stripHtml(d, detail) {
  if (detail) {
    return '<div class="tst-strip"><h1>' + esc(t('nav.tests')) + '</h1>'
      + '<p class="sub">' + esc(t('tests.sub')) + '</p>'
      + (d ? identHtml(d) : '') + '</div>';
  }
  const views = VIEWS.map((v) => '<button class="' + (v === VIEW ? 'on' : '') + '"' + tipAttrs({ key: 'tests.view.' + v, noFocus: true })
    + ' onclick="testsGo(\'' + v + '\',\'' + LEVEL + '\')">'
    + esc(t('tests.view.' + v)) + (v === 'orphans' && d && d.counts ? ' · <span class="cnt">' + d.counts.orphans + '</span>' : '') + '</button>').join('');
  const levels = LEVELS.map((l) => '<button class="' + (l === LEVEL ? 'on' : '') + '"' + tipAttrs({ key: 'tests.level.' + l, noFocus: true })
    + ' onclick="testsGo(\'' + VIEW + '\',\'' + l + '\')">'
    + esc(t('tests.level.' + l)) + '</button>').join('');
  return '<div class="tst-strip"><h1>' + esc(t('nav.tests')) + '</h1>'
    + '<p class="sub">' + esc(t('tests.sub')) + '</p>'
    + (d ? identHtml(d) + countsLineHtml(d) : '')
    + '<div class="tst-views">' + views + '</div><div class="tst-views">' + levels + '</div></div>';
}

/** Which graph these numbers came from: source commit, build, sync, content digest.
 * @group Tests tab */
function identHtml(d) {
  const id = d.identity || {};
  const unknown = t('journey.absent.notIndexed');
  const build = (S.VERSION && S.VERSION.farsight && S.VERSION.farsight.commit) || unknown;
  const line = t('chrome.identity')
    .replace('{commit}', id.source_commit ? String(id.source_commit).slice(0, 7) : unknown)
    .replace('{build}', build)
    .replace('{n}', id.sync != null ? String(id.sync) : unknown);
  // the business lens reads which sync; the commit, the build and the digests are a developer's
  if (biz()) return '<span class="ident">' + esc(t('tip.sync').replace('{n}', id.sync != null ? String(id.sync) : unknown)) + '</span>';
  const dig = Object.entries(id.source_digest || {}).map(([repo, v]) => repo + ' ' + v).join(' · ');
  return '<span class="ident">' + esc(line) + '</span>'
    + (dig ? '<span class="ident"' + tipOf('tests.digestLine') + '>'
      + esc(t('tests.digestLine').replace('{list}', dig)) + '</span>' : '');
}

/**
 * What was read — cases, spec files, journeys, sources, reports — and the scope
 * it was read in. Every number is the fold's typed count for the sources **and
 * the level** selected (`counted`, docs/COUNTS.md §2 #8), so the E2E filter moves
 * this line too; under a level the unfiltered total rides beside it, named.
 * @group Tests tab
 */
function countsLineHtml(d) {
  const c = d.counts || {};
  const k = d.counted || {};
  const api = '/api/tests';
  const bits = [];
  bits.push(k.cases ? countedHtml(k.cases, api) : esc(countWords('count.unit.cases', c.cases || 0)));
  if (!biz()) bits.push(k.files ? countedHtml(k.files, api) : esc(countWords('count.unit.specFiles', c.files || 0)));
  const nj = (d.journeys || []).length;
  bits.push('<span' + plainTip(nj, 'surf.unit.journeys', 'count.scope.workspace', api) + '>' + esc(countWords('surf.unit.journeys', nj)) + '</span>');
  bits.push(k.sources ? countedHtml(k.sources, api) : esc(countWords('count.unit.sources', new Set((d.sources || []).map((s) => s.repo)).size)));
  if (d.reports && !biz()) {
    bits.push('<span' + plainTip(d.reports.length, 'tests.reportsRead', 'count.scope.workspace', api) + '>'
      + esc(t('tests.reportsRead').replace('{n}', String(d.reports.length))) + '</span>');
  }
  const all = d.countsAll && d.level && d.level !== 'all'
    ? '<span class="counts all"' + plainTip(d.countsAll.cases, 'surf.allLevels', 'count.scope.workspace', api) + '>'
      + esc(t('surf.allLevels').replace('{n}', String(d.countsAll.cases))) + '</span>' : '';
  return '<span class="counts">' + bits.join(' · ') + '</span>' + all
    + '<span class="counts"' + tipOf('tests.scope') + '>' + esc(t('tests.scope').replace('{label}', scopeLabel())) + '</span>';
}

/** Move to a view / level without losing the other.
 * @group Tests tab */
export function testsGo(view, level) {
  location.hash = tHref(view, level);
}

/** Open or close one fold and redraw the body.
 * @group Tests tab */
export function testsFold(key) {
  if (OPEN.has(key)) OPEN.delete(key); else OPEN.add(key);
  renderBody();
}

// ── the five header numbers (board 05) ─────────────────────────────────────

/** "≥ 51%" · "51%" · "nothing to measure" — one rendering for every metric on this page.
 * @group Tests tab */
function metricText(m) {
  if (!m || m.value == null) return t('tests.row.nothingToMeasure');
  const pct = Math.round(m.value * 100) + '%';
  return (m.bound === 'floor' ? t('tests.metric.floor') : t('tests.metric.exact')).replace('{pct}', pct);
}

/** Why a value is a floor, in the fold's own words — the `≥` never travels alone.
 * @group Tests tab */
function boundNote(m) {
  if (!m || m.value == null || m.bound !== 'floor') return '';
  const why = m.uncertainty && m.uncertainty.note;
  return why ? t('tests.metric.floorWhy').replace('{why}', why) : t('tests.metric.floorBare');
}

/** Cases, files and runners per level, folded from the source cards the server sent.
 * @group Tests tab */
function levelTotals(d) {
  const by = {};
  for (const s of d.sources || []) {
    const k = s.level;
    if (!by[k]) by[k] = { cases: 0, files: 0, runners: new Set(), lastRun: null };
    by[k].cases += s.cases || 0;
    by[k].files += s.files || 0;
    if (s.runner) by[k].runners.add(s.runner);
    if (s.lastRun && (!by[k].lastRun || s.lastRun.at > by[k].lastRun.at)) by[k].lastRun = s.lastRun;
  }
  return by;
}

/**
 * The five cards: the metric with its scope, what is indexed, the end-to-end
 * tally, the runs, the blind spots. Every number is the selection's — the
 * sources **and the level** picked — because the fold now counts under the
 * level (`counts`, `counted`); the only unfiltered number on a filtered page is
 * the one that says so (`countsAll`, *of n at every level*).
 * @group Tests tab
 */
function kpisHtml(d) {
  const m = d.metric;
  const k = d.counted || {};
  const api = '/api/tests';
  const by = levelTotals(d);
  const e2eTally = { reached: 0, observed: 0, declared: 0, none: 0 };
  (d.journeys || []).forEach((r) => { if (e2eTally[r.e2e] != null) e2eTally[r.e2e]++; });
  const withBody = e2eTally.reached + e2eTally.observed;
  const runners = [...new Set((d.sources || []).map((s) => s.runner).filter(Boolean))].join(' · ');
  const levels = Object.keys(by).sort();
  const newest = levels.map((l) => by[l].lastRun).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const filtered = LEVEL !== 'all';

  let html = '<div class="tst-kpis">';
  // 1 — the one denominator, never without its scope label or its bound. Under a
  //     level the fold's own part for that level is the number (`counted.reached`):
  //     the page never divides for itself.
  const reachedTip = m && m.denominator != null
    ? plainTip(m.numerator, 'count.unit.reached', 'count.scope.selection', api,
      [[t('tests.kpi.reached'), m.numerator], [t('surf.notReached'), m.denominator - m.numerator]], 'tests.kpi.reached', { m: m.denominator })
    : '';
  html += '<div class="tst-kpi"><span class="hud-label"' + tipOf('tests.kpi.reached') + '>'
    + esc(t('tests.kpi.reached')) + '</span>'
    + (filtered && k.reached
      ? '<span class="v">' + countedHtml(k.reached, api, { words: k.reached.n }) + ' <small>'
      + esc(countWords(k.reached.unit, k.reached.n, k.reached.of).replace(String(k.reached.n), '').trim()) + '</small></span>'
      : '<span class="v"><span class="cnt-n"' + reachedTip + '>' + esc(metricText(m)) + '</span>'
        + (m && m.scopeLabel ? ' <small>' + esc(m.scopeLabel) + '</small>' : '') + '</span>')
    + '<span class="s">' + (boundNote(m) ? '<span' + tipOf('tests.metric.floor') + '>' + esc(boundNote(m)) + '</span>' : '')
    + (m && m.excluded ? (boundNote(m) ? ' · ' : '') + '<span' + tipOf('tests.excluded') + '>' + esc(t('tests.excluded')
      .replace('{m}', String(m.excluded.manifestOnly || 0)).replace('{p}', String(m.excluded.plumbing || 0))
      .replace('{c}', String(m.excluded.presentational || 0)).replace('{d}', String(m.excluded.declaredOnly || 0))) + '</span>' : '')
    + '</span></div>';
  // 2 — what was read out of the spec files: the selection's cases, split by
  //     level; under a level, that level's and the unfiltered total named apart
  const cases = (d.counts && d.counts.cases) || 0;
  const perLevel = filtered
    ? esc(t('tests.level.' + LEVEL)) + (d.countsAll ? ' · <span' + plainTip(d.countsAll.cases, 'surf.allLevels', 'count.scope.workspace', api) + '>'
      + esc(t('surf.allLevels').replace('{n}', String(d.countsAll.cases))) + '</span>' : '')
    : esc(t('tests.kpi.indexedSub')
      .replace('{unit}', String((by.unit && by.unit.cases) || 0))
      .replace('{integration}', String((by.integration && by.integration.cases) || 0))
      .replace('{e2e}', String((by.e2e && by.e2e.cases) || 0)));
  const files = k.files ? countedHtml(k.files, api) : esc(countWords('count.unit.specFiles', (d.counts && d.counts.files) || 0));
  const repos = k.sources ? countedHtml(k.sources, api) : esc(countWords('count.unit.sources', new Set((d.sources || []).map((s) => s.repo)).size));
  html += '<div class="tst-kpi"><span class="hud-label"' + tipOf('tests.kpi.indexed') + '>'
    + esc(t('tests.kpi.indexed')) + '</span>'
    + '<span class="v">' + (k.cases ? countedHtml(k.cases, api, { words: cases }) : esc(String(cases))) + ' <small>' + perLevel + '</small></span>'
    + '<span class="s">' + (biz() ? repos : files + ' · ' + repos + ' · ' + esc(runners || t('journey.absent.notIndexed'))) + '</span></div>';
  // 3 — journeys an end-to-end test body actually reaches; a header claim is not one
  const tally = [['journey.flowE2e.reached', e2eTally.reached], ['journey.flowE2e.observed', e2eTally.observed]];
  html += '<div class="tst-kpi"><span class="hud-label"' + tipOf('tests.kpi.flowsE2e') + '>'
    + esc(t('tests.kpi.flowsE2e')) + '</span>'
    + '<span class="v"><span class="cnt-n"' + plainTip(withBody, 'surf.unit.journeys', 'count.scope.workspace', api, tally.map(([key, n]) => [t(key), n]), 'tests.kpi.flowsE2e') + '>'
    + esc(String(withBody)) + '</span> <small>' + esc(t('tests.kpi.flowsE2eSub')
      .replace('{reached}', String(e2eTally.reached)).replace('{observed}', String(e2eTally.observed))
      .replace('{declared}', String(e2eTally.declared)).replace('{none}', String(e2eTally.none))) + '</small></span>'
    + '<span class="s">' + esc(def('tests.kpi.flowsE2e') || '') + '</span></div>';
  // 4 — the runs per level: when, and whether the run still speaks for this code.
  //     The verdicts are on each source's card below (`sources[].runs`).
  html += '<div class="tst-kpi"><span class="hud-label"' + tipOf('tests.kpi.lastRuns') + '>'
    + esc(t('tests.kpi.lastRuns')) + '</span>'
    + '<span class="v">' + (newest ? esc(newest.at.slice(0, 10))
      : tagOpen(EV_CLS.none, 'journey.absent.notIndexed') + sym('absent') + esc(t('journey.absent.notIndexed')) + '</span>') + '</span>'
    + '<span class="s">' + levels.map((l) => esc(t('tests.level.' + l)) + ' · '
      + (by[l].lastRun ? esc(by[l].lastRun.at.slice(0, 10)) + ' ' + dgHtml(by[l].lastRun.freshness, by[l].lastRun.changedBy)
        : tagOpen(EV_CLS.none, 'journey.absent.notIndexed') + esc(t('journey.absent.notIndexed')) + '</span>')).join('<br>') + '</span></div>';
  // 5 — what could not be read, by kind: the artefacts first
  html += gapsKpiHtml(d);
  return html + '</div>';
}

/** The blind-spot card. `gaps` absent = no repo in scope recorded a list; `[]` = the pass named nothing.
 * @group Tests tab */
function gapsKpiHtml(d) {
  const open = '<div class="tst-kpi' + (d.gaps && d.gaps.length ? ' warn' : '') + '"><span class="hud-label"'
    + tipOf('tests.kpi.gaps') + '>' + esc(t('tests.kpi.gaps')) + '</span>';
  if (d.gaps && d.gaps.length) {
    // one entry per kind, in the order a reader needs them, with how many
    // artefacts carry it — never the same word twice
    const byKind = new Map();
    foldGaps(d.gaps).forEach((g) => byKind.set(g.kind, (byKind.get(g.kind) || 0) + g.n));
    const key = byKind.size === 1 && d.gaps.length === 1 ? 'tests.kpi.gapsOne'
      : byKind.size === 1 ? 'tests.kpi.gapsKindOne' : 'tests.kpi.gapsKinds';
    return open + '<span class="v">' + esc(t(key)
      .replace('{kinds}', String(byKind.size)).replace('{n}', String(d.gaps.length))) + '</span>'
      + '<span class="s">' + [...byKind.entries()].slice(0, 4).map(([kind, n]) => esc(t((GAP_WORD[kind] || GAP_WORD.unreadable)[0])
        + (n > 1 ? ' ×' + n : ''))).join(' · ') + '</span></div>';
  }
  if (d.gaps) {
    return open + '<span class="v">' + esc(t('tests.gapsNone')) + '</span>'
      + '<span class="s">' + esc(def('tests.gapsNone') || '') + '</span></div>';
  }
  const bs = d.blindSpots || [];
  return open + '<span class="v">' + (bs.length ? esc(t('tests.kpi.gapsFindings').replace('{n}', String(bs.length)))
    : '<span class="ev absent">' + sym('absent') + esc(t('journey.absent.noneIndexed')) + '</span>') + '</span>'
    + '<span class="s">' + esc(t('tests.gapsAbsent')) + '</span></div>';
}

// ── one card per source and level ─────────────────────────────────────────

/** The verdict word per bucket of `sources[].runs`, and the class that shapes it. */
const RUN_PARTS = [['passed', 'count.part.passed'], ['failed', 'count.part.failed'], ['flaky', 'count.part.flaky'],
  ['skipped', 'count.part.skipped'], ['unknown', 'tests.run.unknown'], ['noRun', 'count.part.noRun']];

/**
 * A source card's first line — did it pass, and is that still true of this
 * code: the verdicts of its cases' last recorded runs (`sources[].runs`, which
 * sum to its cases) and the run's freshness. The answer a reader came for, at
 * a glance (*37 passed · digest matches*), where it used to sit two clicks and
 * a scroll away in the suites (pass swarm 2026-09-25).
 * @group Tests tab
 */
function verdictLineHtml(c) {
  const runs = c.runs;
  if (!runs) return '';
  const api = '/api/tests';
  const parts = (c.counted && c.counted.cases && c.counted.cases.breakdown) || [];
  const rows = parts.map((p) => [countWords(p.key, p.n).replace(String(p.n), '').trim(), p.n]);
  const bits = RUN_PARTS.filter(([k]) => runs[k]).map(([k, key]) => {
    const cls = k === 'noRun' ? 'notrun' : k;
    const words = key === 'tests.run.unknown' ? runs[k] + ' ' + t(key) : countWords(key, runs[k]);
    return '<span class="' + ST_CLS[cls] + '"' + plainTip(runs[k], key === 'tests.run.unknown' ? 'count.unit.cases' : key, 'count.scope.source', api, rows, 'tests.run.' + (cls === 'notrun' ? 'notRun' : cls)) + '>'
      + esc(words) + '</span>';
  });
  if (!bits.length) return '';
  return '<div class="tst-verdict">' + bits.join(' · ') + (c.lastRun ? ' · ' + dgHtml(c.lastRun.freshness, c.lastRun.changedBy) : '') + '</div>'
    + declaredLineHtml(c);
}

/**
 * Why the source's passed cases are not the number a journey counts as
 * *passed, by its own declaration*: the passed end-to-end cases split by what
 * they declare (`counted.passedByDeclaration`). The reference app's card said *89 passed*
 * above flows that each said *0 seen in a run*, and nothing said why (story
 * swarm 2026-09-25, all eight reviewers).
 * @group Tests tab
 */
function declaredLineHtml(c) {
  const k = c.counted && c.counted.passedByDeclaration;
  if (!k || !k.n) return '';
  const api = '/api/tests';
  const rows = (k.breakdown || []).map((p) => [countWords(p.key, p.n).replace(String(p.n), '').trim(), p.n]);
  const parts = (k.breakdown || []).filter((p) => p.n).map((p) => '<span' + plainTip(p.n, p.key, 'count.scope.source', api, rows, p.key) + '>'
    + esc(countWords(p.key, p.n)) + '</span>');
  return '<div class="tst-decl">' + countedHtml(k, api) + (parts.length ? ' · ' + parts.join(' · ') : '') + '</div>';
}

/**
 * The source cards: what each source and level holds, whether its cases
 * passed, its run, and the blind spots that belong to it.
 * @group Tests tab
 */
function sourcesHtml(d) {
  const cards = d.sources || [];
  if (!cards.length) return '';
  const api = '/api/tests';
  const projectsOf = (repo, level) => [...new Set((d.suites || [])
    .filter((s) => s.repo === repo && s.level === level && s.project).map((s) => s.project))];
  return '<div class="tst-sec"><h2>' + esc(t('tests.sec.sources')) + '</h2></div><div class="tst-cards">'
    + cards.map((c) => {
      const projects = biz() ? [] : projectsOf(c.repo, c.level);
      const k = c.counted || {};
      const files = k.files ? countedHtml(k.files, api) : esc(countWords('count.unit.specFiles', c.files));
      const cases = k.cases ? countedHtml(k.cases, api) : esc(countWords('count.unit.cases', c.cases));
      const line = (biz() ? cases : files + ' · ' + cases)
        + (projects.length ? ' · ' + esc(projects.join(' · ')) : '');
      const gaps = (d.gaps || []).filter((g) => g.repo === c.repo && (!g.level || g.level === c.level));
      return '<div class="tst-card"><div class="t">' + esc(c.repo) + ' · ' + esc(t('tests.level.' + c.level))
        + (biz() ? '' : tagOpen('ev reached', 'tests.runner') + esc(c.runner) + '</span>') + '</div>'
        + verdictLineHtml(c)
        + '<div class="sub">' + line + '</div>'
        + '<div class="kv">' + (c.lastRun
          ? '<span>' + esc(c.lastRun.at.slice(0, 10)) + '</span>' + dgHtml(c.lastRun.freshness, c.lastRun.changedBy)
          : tagOpen(EV_CLS.none, 'journey.absent.notIndexed') + sym('absent') + esc(t('journey.absent.notIndexed')) + '</span>') + '</div>'
        // the fold's own sentence about this card's freshness, printed verbatim
        + '<p class="tst-gap">' + mdCode(c.freshness) + '</p>'
        // one line per finding's shape, with how many artefacts carry it: the unit
        // card used to repeat one sentence per coverage report
        + foldGaps(gaps).map((g) => '<p class="tst-gap bad">' + sym('warning') + ' ' + mdCode(g.text)
          + (g.n > 1 ? ' <b class="mono">×' + g.n + '</b>' : '') + '</p>').join('')
        + '</div>';
    }).join('') + '</div>';
}

// ── the journeys × tests matrix ───────────────────────────────────────────

/** The evidence chip: one of four classes, each a shape and a word, never colour alone.
 * @group Tests tab */
function evChipHtml(cls, wordKey) {
  const glyph = cls === 'observed' ? sym('live') : cls === 'stale' ? sym('stale') : cls === 'none' ? sym('absent') : '';
  return tagOpen(EV_CLS[cls], wordKey) + glyph + esc(t(wordKey)) + '</span>';
}

/** Whether a run still speaks for this code: glyph and word, from the report's own digest.
 * @group Tests tab */
function dgHtml(freshness, changedBy) {
  const f = DG_CLS[freshness] ? freshness : 'unknown';
  // a `changed` run on the commit it ran at: the working tree differs from HEAD —
  // never words that imply a commit the Changes spine will not show
  const key = f === 'changed' && changedBy === 'working-tree' ? 'tests.freshness.changedTree' : 'tests.freshness.' + f;
  return tagOpen(DG_CLS[f], key)
    + (f === 'unchanged' ? sym('live') : f === 'changed' ? sym('stale') : sym('warning'))
    + esc(t(key)) + '</span>';
}

/** How many screens of a journey have code behind them, as one word.
 * @group Tests tab */
function builtWord(row) {
  const built = row.built || 0;
  const total = row.screens || 0;
  const key = total > 0 && built >= total ? 'journey.status.built'
    : built > 0 ? 'journey.status.partly' : 'journey.status.designedNotBuilt';
  return t(key).replace('{n}', String(built)).replace('{m}', String(total));
}

/**
 * The node and the test that earned a journey's end-to-end word, and the other
 * journeys holding that node — the honest half of the claim, printed loud.
 * @group Tests tab
 */
function liftHtml(row) {
  const via = row.coverage && row.coverage.e2eVia;
  if (!via) return '';
  // a test id is `<repo>::test::<file>::<title>`, so the file is its third segment
  const parts = String(via.testId || '').split('::');
  const file = parts.length > 3 ? parts[2] : '';
  const repo = parts[0] || '';
  const shared = (via.sharedWith || []).map((f) => f.name).join(' · ');
  // the business lens names the node by its business name, never its route or identifier
  const node = biz() && S.BYID[via.nodeId] ? bizName(S.BYID[via.nodeId]) : (via.name || via.nodeId);
  return '<span class="tst-lift">' + esc(t('tests.via').replace('{node}', node))
    + (via.testName ? ' · <a href="#/tests/' + encodeURIComponent(via.testId) + '">' + esc(via.testName) + '</a>' : '')
    + (file ? '<span class="loc"> ' + esc(file) + (via.line ? ':' + via.line : '') + '</span>' + vsl(repo, file, via.line || 1) : '')
    + (shared ? '<span class="shared"> ' + esc(t('tests.sharedWith').replace('{flow}', shared)) + '</span>' : '')
    + '</span>';
}

/**
 * The strongest evidence class on a journey's scope, with the qualifiers that
 * keep it from over-claiming:
 *
 *  - an observed class carried only by run-level coverage reports prints the
 *    run-level sentence — the class is the edge's and is never downgraded, and
 *    the reader is told no single test was observed here (03 §2.3, Rafael 6);
 *  - a journey with no screen built says which nodes the evidence sits on, so
 *    a chip can never read as "this unbuilt feature passes";
 *  - the run is its own line with the weakest-verdict rule in its tooltip.
 * @group Tests tab
 */
function evidenceCellHtml(row) {
  const c = row.coverage || {};
  const chip = c.chip && c.chip !== 'none' ? c.chip : null;
  const cls = evidenceWord(c).cls;
  const tests = (c.counts && c.counts.tests) || null;
  // the run-level case: the class is the edge's and stays, the word says who
  // observed. "verified by a run" is reserved for evidence a results report
  // attributed to a case; coverage with no per-case attribution earns the
  // run's word instead — and the sentence under it carries the count.
  const runOnly = !!(chip && tests && !tests.observed && tests.runLevel);
  // the rule this tab settled in B3.3 now lives in the fold, so the four printers
  // of this word read one answer (visual swarm 2026-09-24). Nothing on this tab
  // changes: it is the other three that move to what this one already said.
  const word = evidenceWord(c).key;
  let html = evChipHtml(cls, word);
  if (runOnly) {
    html += '<span class="tst-lift">' + esc(t(tests.runLevel === 1 ? 'tests.runOnlyOne' : 'tests.runOnly').replace('{n}', String(tests.runLevel))) + '</span>';
  }
  if (chip && !(row.built || 0)) html += '<span class="tst-lift">' + esc(t('tests.row.noScreenBuilt')) + '</span>';
  html += runsLineHtml(c);
  return html;
}

/**
 * Beside the cell's one verdict: its cases by their own last runs, as a number
 * whose tip breaks them down (core `testVerdict().runs`, a breakdown that sums),
 * then when the run behind the word ran and whether the code moved since, and
 * the runner projects. Never a second verdict: the weakest run printed here
 * read *skipped* beside *passed, by its own declaration* on every row (swarm
 * 2026-10-05, finding 1).
 * @group Tests tab
 */
function runsLineHtml(c) {
  const runs = c.verdict && c.verdict.runs;
  const o = c.observation;
  const bits = [];
  if (runs && runs.n) bits.push('<span class="hud-label"' + tipOf('journey.tests.theirRuns') + '>' + esc(t('journey.tests.theirRuns')) + '</span> ' + countedHtml(runs, '/api/tests'));
  if (o && o.at) bits.push('<span class="mono">' + esc(o.at.slice(0, 10)) + ' </span>' + dgHtml(o.freshness, o.changedBy));
  if (c.run && c.run.projects && c.run.projects.length && !biz()) bits.push('<span class="mono">' + esc(c.run.projects.join(' · ')) + '</span>');
  return bits.length ? '<span class="tst-lift tst-runs">' + bits.join(' · ') + '</span>' : '';
}

/**
 * The cell a journey's door opened this page on: its name, the cell's verdict
 * (the same word, from the same fold, the journey prints), its cases by their
 * own runs, and every case with its own word and its own last run. A link back
 * to the journey and one to every journey.
 * @group Tests tab
 */
function scopedHtml() {
  if (!SCOPED) return '';
  const d = SCOPED_DATA;
  const back = '<a href="#/tests">' + esc(t('tests.scoped.all')) + '</a>';
  if (!d || d.error) return '<div class="tst-sec tst-scoped"><p class="set-note">' + esc(t('sys.testsFailed')) + ' · ' + back + '</p></div>';
  const cov = d.coverage || null;
  const flow = d.flow || SCOPED.flow;
  const name = d.node ? (biz() ? bizName(d.node) : d.node.name)
    : d.label ? (d.flowName ? d.flowName + ' · ' : '') + d.label
      : (flow && S.BYID && S.BYID[flow] ? (biz() ? bizName(S.BYID[flow]) : S.BYID[flow].name) : flow || '');
  const cases = d.cases || [];
  const ew = cov ? evidenceWord(cov) : { cls: 'none', key: 'journey.absent.noneIndexed' };
  const head = '<h2 data-scope="' + esc(cov && cov.counted && cov.counted.tests ? cov.counted.tests.scope : '') + '">'
    + esc(t('tests.scoped.head').replace('{scope}', name)) + '</h2>';
  const verdict = '<div class="tst-gap tst-scoped-verdict">' + evChipHtml(ew.cls, ew.key)
    + (cov ? ' ' + runsLineHtml(cov) : '') + '</div>'
    + '<p class="tst-gap">' + (flow ? '<a href="#/journeys/' + encodeURIComponent(flow) + '">' + esc(t('tests.scoped.journey')) + '</a> · ' : '') + back + '</p>';
  const CAP = 200;
  const list = cases.length
    ? CASES_OPEN + cases.slice(0, CAP).map(scopedCaseHtml).join('') + '</ul>'
      + (cases.length > CAP ? '<p class="tst-gap">' + esc(t('journey.moreChips').replace('{n}', String(cases.length - CAP))) + '</p>' : '')
    : '<p class="set-note">' + esc(t('journey.absent.noneIndexed')) + '</p>';
  return '<div class="tst-sec tst-scoped">' + head + verdict + list + '</div>';
}

/** One case of a scoped cell: its name, its own word (core `caseWord`), its own last run, where it sits.
 * @group Tests tab */
function scopedCaseHtml(c) {
  const w = c.word || { cls: 'none', key: 'journey.absent.noneIndexed' };
  // a declaration word already says the run passed; any other word has the run beside it
  const implied = w.key === 'tests.evidence.declaredPassed' || w.key === 'tests.evidence.declaredPassedStale';
  const st = ST_CLS[c.status] ? c.status : c.status ? 'unknown' : 'notrun';
  const status = implied ? '' : ' ' + tagOpen(ST_CLS[st], 'tests.run.' + (st === 'notrun' ? 'notRun' : st)) + esc(t(st === 'notrun' ? 'tests.run.notRun' : 'tests.run.' + st)) + '</span>';
  const where = !biz() && c.loc && c.loc.path ? '<span class="loc"> ' + esc(c.loc.path) + (c.loc.line ? ':' + c.loc.line : '') + '</span>' : '';
  return '<li data-case="' + esc(c.id) + '"><a href="#/tests/' + encodeURIComponent(c.id) + '">' + esc(c.name) + '</a> '
    + '<span class="mono">' + esc(t('tests.level.' + c.level)) + '</span> '
    + evChipHtml(w.cls, w.key) + status + where + '</li>';
}

/** One journey row: what is built, what evidence exists, the metric with its scope, the counts, what is missing.
 * @group Tests tab */
function matrixRowHtml(row, business) {
  const c = row.coverage || {};
  const m = c.metric;
  const tests = (c.counts && c.counts.tests) || {};
  const e2eCls = row.e2e === 'observed' ? 'observed' : row.e2e === 'reached' ? 'reached'
    : row.e2e === 'declared' ? 'declared' : 'none';
  // a lean answer carries the lists' lengths, a full one the lists
  const declared = row.declaredCount != null ? row.declaredCount : (row.declared || []).length;
  const reached = row.inferredCount != null ? row.inferredCount : (row.inferred || []).length;
  const obs = tests.observed || 0;
  const runs = tests.runLevel || 0;
  const decl = tests.declaredPassed || 0;
  const zero = m && m.value == null;
  return '<tr' + (zero ? ' class="zero"' : '') + '>'
    + '<td><span class="t"><a href="#/journeys/' + encodeURIComponent(row.flowId) + '">' + esc(row.name) + '</a></span>'
    + (business ? '' : '<span class="tst-lift">' + esc(row.flowId) + '</span>') + '</td>'
    + '<td class="mono"><span' + plainTip(row.built || 0, 'journey.status.partly', 'journey.scopeAll', '/api/tests', null, 'tests.col.screens', { m: row.screens || 0 }) + '>'
    + esc(builtWord(row)) + '</span></td>'
    + '<td>' + evidenceCellHtml(row) + '</td>'
    + '<td>' + evChipHtml(e2eCls, 'journey.flowE2e.' + (row.e2e || 'none')) + liftHtml(row) + '</td>'
    + '<td><span class="tst-den"><b' + (m && m.denominator != null ? plainTip(m.numerator, 'count.unit.reached', 'journey.scopeAll', '/api/tests', null, 'tests.col.reached', { m: m.denominator }) : '') + '>'
    + esc(metricText(m)) + '</b> ' + esc((m && m.scopeLabel) || '') + '</span>'
    + (boundNote(m) ? '<span class="tst-lift"' + tipOf('tests.metric.floor') + '>' + esc(boundNote(m)) + '</span>' : '') + '</td>'
    + (business ? '' : '<td class="num"><b' + plainTip(declared, 'tests.col.declared', 'journey.scopeAll', '/api/tests') + '>' + declared + '</b></td>'
      + '<td class="num"><b' + plainTip(reached, 'tests.col.reachedTests', 'journey.scopeAll', '/api/tests') + '>' + reached + '</b></td>'
      + '<td class="num">' + (obs || runs
        ? (decl
          ? '<span' + tipOf('tests.observedSplitDecl') + '>'
            + esc(t('tests.observedSplitDecl').replace('{tests}', String(obs - decl)).replace('{decl}', String(decl)).replace('{runs}', String(runs))) + '</span>'
          : '<span' + tipOf('tests.observedSplit') + '>'
            + esc(t('tests.observedSplit').replace('{tests}', String(obs)).replace('{runs}', String(runs))) + '</span>')
        : '<span class="dim">' + esc(t('journey.absent.noneIndexed')) + '</span>') + '</td>')
    + '<td><div class="tst-gap' + (row.e2e === 'none' || row.e2e === 'declared' ? ' bad' : '') + '">'
    + esc(business ? unCode(row.gap || '') : (row.gap || '')) + '</div></td></tr>';
}

/** The matrix: one row per journey in scope, and the caveat that its rows do not add up.
 * @group Tests tab */
function matrixHtml(d) {
  const business = currentLens() === 'business';
  const cols = business
    ? ['journey', 'screens', 'evidence', 'e2e', 'reached', 'missing']
    : ['journey', 'screens', 'evidence', 'e2e', 'reached', 'declared', 'reachedTests', 'observed', 'missing'];
  const flow = SCOPED && SCOPED_DATA && !SCOPED_DATA.error ? (SCOPED_DATA.flow || SCOPED.flow) : null;
  const all = d.journeys || [];
  const rows = flow && all.some((r) => r.flowId === flow) ? all.filter((r) => r.flowId === flow) : all;
  // every word a row can wear, the run-seen pair included: a chip the legend
  // does not show is a chip a reader has to guess at
  const legend = ['declared', 'reached', 'observed', 'stale']
    .map((cls) => evChipHtml(cls, 'journey.evidence.' + cls)).join('')
    + evChipHtml('observed', 'tests.evidence.declaredPassed')
    + evChipHtml('observed', 'tests.evidence.runSeen') + evChipHtml('stale', 'tests.evidence.runSeenStale');
  return '<div class="tst-sec"><h2>' + esc(t('tests.view.matrix'))
    + '<span class="tst-legend">' + legend + '</span></h2>'
    + '<p class="tst-gap">' + esc(t('tests.matrixSub')) + ' · ' + esc(t('tests.noSum')) + '</p>'
    + (rows.length
      ? '<table class="tst-table"><thead><tr>' + cols.map((c) => '<th' + tipOf('tests.col.' + c) + '>'
        + esc(t('tests.col.' + c)) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => matrixRowHtml(r, business)).join('') + '</tbody></table>'
      : '<p class="set-note">' + esc(t('tests.noJourneys')) + '</p>')
    + '<p class="tst-gap"><a href="/api/tests/matrix?scope=' + encodeURIComponent(scopeParam())
    + '&amp;format=csv"' + tipAttrs({ key: 'tests.exportCsv', noFocus: true }) + '>' + esc(t('tests.exportCsv')) + '</a></p>'
    + '</div>';
}

// ── suites ────────────────────────────────────────────────────────────────

/** The verdict tallies of one spec file — a bucket only when it has cases in it.
 * @group Tests tab */
function verdictsHtml(counts) {
  if (!counts) return '';
  return ['passed', 'failed', 'skipped', 'flaky', 'unknown'].filter((k) => counts[k])
    .map((k) => '<span class="' + ST_CLS[k] + '"' + plainTip(counts[k], 'tests.run.' + k, 'surf.scope.file', '/api/tests', null, 'tests.run.' + k) + '>'
      + counts[k] + ' ' + esc(t('tests.run.' + k)) + '</span>')
    .join(' ');
}

/** One case row inside an opened spec file: its verdict, what it covers, what it claims.
 * @group Tests tab */
function caseRowHtml(s, c) {
  const st = ST_CLS[c.status] ? c.status : c.status ? 'unknown' : 'notrun';
  const word = st === 'notrun' ? t('tests.run.notRun') : t('tests.run.' + st);
  // the row above names the file; a case says which line of it
  if (biz()) {
    return '<li><a href="#/tests/' + encodeURIComponent(c.id) + '">' + esc(c.name) + '</a> '
      + tagOpen(ST_CLS[st], 'tests.run.' + (st === 'notrun' ? 'notRun' : st)) + esc(word) + '</span></li>';
  }
  return '<li><a href="#/tests/' + encodeURIComponent(c.id) + '">' + esc(c.name) + '</a>'
    + '<span class="loc">:' + c.line + '</span>' + vsl(s.repo, s.file, c.line)
    + ' ' + tagOpen(ST_CLS[st], 'tests.run.' + (st === 'notrun' ? 'notRun' : st)) + esc(word) + '</span>'
    + '<span class="mono"> ' + esc(t('tests.case.covers').replace('{n}', String(c.covers))) + '</span>'
    + (c.declares && c.declares.length ? '<span class="mono"> ' + esc(c.declares.join(' · ')) + '</span>' : '')
    + (c.unresolved && c.unresolved.length ? '<span class="tst-lift">' + sym('warning') + ' '
      + esc(t('tests.orphan.unresolved').replace('{v}', c.unresolved.join(' · '))) + '</span>' : '')
    + '</li>';
}

/** One row per spec file and, when opened, its cases with their claims and verdicts.
 * @group Tests tab */
function suitesHtml(d) {
  const suites = d.suites || [];
  if (!suites.length) {
    return '<div class="tst-sec"><h2>' + esc(t('tests.view.suites')) + '</h2>'
      + '<p class="set-note">' + esc(t('tests.empty')) + '</p></div>';
  }
  // a source column, and the rows grouped by it: Farsight's own end-to-end specs
  // used to sit between two client apps', told apart only by the shape
  // of a path (pass swarm 2026-09-25)
  const cols = ['source', 'suite', 'level', 'cases', 'verdicts', 'lastRun'];
  const order = suites.map((s, i) => ({ s, i })).sort((a, b) => a.s.repo.localeCompare(b.s.repo) || a.s.file.localeCompare(b.s.file));
  let html = '<div class="tst-sec"><h2>' + esc(t('tests.view.suites')) + '</h2>'
    + '<table class="tst-table tst-suites"><thead><tr>' + cols.map((c) => '<th' + tipOf('tests.col.' + c) + '>'
      + esc(t('tests.col.' + c)) + '</th>').join('') + '</tr></thead><tbody>';
  order.forEach(({ s, i }) => {
    const key = 'suite' + i;
    const open = OPEN.has(key);
    html += '<tr' + (open ? ' class="on"' : '') + '><td class="src">' + esc(s.repo) + '</td>'
      + '<td><button class="tst-showall" onclick="testsFold(\'' + key + '\')">'
      + esc(t(open ? 'tests.fold.hide' : 'tests.fold.cases').replace('{n}', String(s.cases.length))) + '</button>'
      + (biz() ? '<span class="nm"> ' + esc(suiteName(s)) + '</span>' : '<span class="loc"> ' + esc(s.file) + '</span>' + vsl(s.repo, s.file, 1)) + '</td>'
      + '<td class="mono">' + esc(t('tests.level.' + s.level)) + (biz() ? '' : ' · ' + esc(s.runner) + (s.project ? ' · ' + esc(s.project) : '')) + '</td>'
      + '<td class="num"><b' + plainTip(s.counts.cases, 'count.unit.cases', 'surf.scope.file', '/api/tests') + '>' + s.counts.cases + '</b></td>'
      + '<td>' + (verdictsHtml(s.counts) || tagOpen('dim', 'journey.absent.notIndexed') + esc(t('journey.absent.notIndexed')) + '</span>') + '</td>'
      + '<td>' + (s.lastRun ? '<span class="mono">' + esc(s.lastRun.at.slice(0, 10)) + ' </span>' + dgHtml(s.lastRun.freshness, s.lastRun.changedBy)
        : tagOpen('dim', 'journey.absent.notIndexed') + esc(t('journey.absent.notIndexed')) + '</span>') + '</td></tr>';
    if (open) {
      html += '<tr><td colspan="6">' + CASES_OPEN + s.cases.map((c) => caseRowHtml(s, c)).join('') + '</ul></td></tr>';
    }
  });
  return html + '</tbody></table></div>';
}

// ── orphans ───────────────────────────────────────────────────────────────

/** Tests whose claims and reaches land on nothing this build knows — not bad tests.
 * @group Tests tab */
function orphansHtml(d) {
  const rows = (d.orphans || []).slice()
    .sort((a, b) => a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
  let html = '<div class="tst-sec"><h2>' + esc(t('tests.view.orphans')) + '</h2>'
    + '<p class="tst-gap">' + esc(t('tests.orphansNote')) + '</p>';
  if (!rows.length) return html + '<p class="set-note">' + esc(t('tests.noOrphans')) + '</p></div>';
  // what a test declares is written as code (`@covers` values): not the business lens's column
  const cols = biz() ? ['test', 'reason'] : ['test', 'reason', 'claim'];
  html += '<table class="tst-table"><thead><tr>' + cols.map((c) => '<th' + tipOf('tests.col.' + c) + '>'
    + esc(t('tests.col.' + c)) + '</th>').join('') + '</tr></thead><tbody>';
  for (const o of rows) {
    const repo = String(o.testId || '').split('::')[0] || '';
    html += '<tr><td><a href="#/tests/' + encodeURIComponent(o.testId) + '">' + esc(o.name) + '</a>'
      + (biz() ? '' : '<span class="loc"> ' + esc(o.file) + (o.line ? ':' + o.line : '') + '</span>' + vsl(repo, o.file, o.line || 1)) + '</td>'
      + '<td>' + esc(t(o.reason === 'unresolved-claim' ? 'tests.orphan.unresolvedReason' : 'tests.orphan.coversNothing')) + '</td>'
      + (biz() ? '' : '<td class="mono">' + (o.declares && o.declares.length ? esc(o.declares.join(' · '))
        : '<span class="dim">' + esc(t('journey.absent.noneIndexed')) + '</span>') + '</td>') + '</tr>';
  }
  return html + '</tbody></table></div>';
}

// ── freshness and blind spots (board 08) ──────────────────────────────────

/** What one report added to the graph, in its own numbers — never a blank cell.
 * @group Tests tab */
function addsHtml(r) {
  const bits = [];
  if (r.joined != null) bits.push(t('tests.rep.joined').replace('{n}', String(r.joined)));
  if (r.edges != null) bits.push(t('tests.rep.edges').replace('{n}', String(r.edges)));
  if (r.eachJoined || r.eachUnjoined) {
    bits.push(t('tests.rep.each').replace('{j}', String(r.eachJoined || 0))
      .replace('{t}', String((r.eachJoined || 0) + (r.eachUnjoined || 0))));
  }
  if (r.unjoined) bits.push(t('tests.rep.unjoined').replace('{n}', String(r.unjoined)));
  if (!bits.length) bits.push(t('tests.rep.nothing'));
  return esc(bits.join(' · '));
}

/** The reason a report is not plain `ok`, in the blind-spot vocabulary.
 * @group Tests tab */
function reasonHtml(r) {
  if (!r.reason || r.reason === 'ok') return '';
  const key = r.reason === 'no-match' ? 'tests.blind.missing'
    : r.reason === 'empty' ? 'tests.blind.empty'
      : r.reason === 'no-digest' ? 'tests.blind.digest'
        : r.reason === 'digest-changed' ? (r.changedBy === 'working-tree' ? 'tests.freshness.changedTree' : 'tests.freshness.changed') : 'tests.blind.unreadable';
  return '<span class="tst-lift">' + sym('warning') + ' ' + esc(t(key)) + '</span>';
}

/** How many files a glob matched — one file is one file.
 * @group Tests tab */
function matchedWord(n) {
  return n === 1 ? t('tests.rep.matchedOne') : t('tests.rep.matched').replace('{n}', String(n));
}

/** One row per configured glob, its matched files folded under it, the odd ones out always visible.
 * @group Tests tab */
function reportsHtml(d) {
  if (!d.reports) return '<p class="set-note">' + esc(t('tests.reportsAbsent')) + '</p>';
  if (!d.reports.length) return '<p class="set-note">' + esc(t('tests.reportsNone')) + '</p>';
  const groups = new Map();
  for (const r of d.reports) {
    const key = [r.repo, r.level, r.kind, r.glob].join(' · ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // the report kind, its runner, the glob and what each file added are a
  // developer's facts; the business lens keeps which level, how many matched,
  // when, and whether the run still speaks for this code
  const b = biz();
  const cols = b ? ['level', 'matched', 'lastRun', 'digest'] : ['level', 'kind', 'glob', 'matched', 'lastRun', 'digest', 'adds'];
  let html = '<table class="tst-table"><thead><tr>' + cols.map((c) => '<th' + tipOf('tests.col.' + c) + '>'
    + esc(t('tests.col.' + c)) + '</th>').join('') + '</tr></thead><tbody>';
  let gi = 0;
  for (const [, list] of groups) {
    const head = list[0];
    const key = 'rep' + (gi++);
    const open = OPEN.has(key);
    // the group's freshness, folded: one word per value with how many carry it
    const fresh = {};
    list.forEach((r) => { fresh[r.freshness || 'unknown'] = (fresh[r.freshness || 'unknown'] || 0) + 1; });
    const odd = list.filter((r) => r.reason && r.reason !== 'ok');
    const ok = list.filter((r) => !r.reason || r.reason === 'ok');
    html += '<tr class="on"><td class="mono">' + esc(t('tests.level.' + head.level)) + '</td>'
      + (b ? '' : '<td class="mono">' + esc(head.kind) + ' · ' + esc(head.runner) + '</td>'
        + '<td class="mono">' + esc(head.glob || '') + '</td>')
      + '<td class="num"><b>' + esc(matchedWord(head.matched != null ? head.matched : list.length)) + '</b> '
      + (ok.length > 1 && !b
        ? '<button class="tst-showall" onclick="testsFold(\'' + key + '\')">'
          + esc(t(open ? 'tests.fold.hide' : 'tests.blind.fold').replace('{n}', String(ok.length))) + '</button>'
        : '') + '</td>'
      + '<td class="mono">' + esc((list.map((r) => r.mtime).filter(Boolean).sort().pop() || '').slice(0, 10)) + '</td>'
      + '<td>' + Object.keys(fresh).map((f) => dgHtml(f)
        + (fresh[f] > 1 ? '<span class="mono"> ×' + fresh[f] + '</span>' : '')).join(' ') + '</td>'
      + (b ? '' : '<td class="mono"></td>') + '</tr>';
    if (b) continue;
    // a report that could not be read is never folded away
    for (const r of odd) html += reportRowHtml(r);
    if (open) for (const r of ok) html += reportRowHtml(r);
  }
  return html + '</tbody></table>';
}

/** One matched report file: where it is, its run id, when it ran, whether its digest still matches, what it added.
 * @group Tests tab */
function reportRowHtml(r) {
  return '<tr><td></td><td></td><td class="mono"><span class="loc">' + esc(r.path || '') + '</span>'
    + (r.path ? vsl(r.repo, r.path, 1) : '') + reasonHtml(r) + '</td>'
    + '<td class="mono">' + esc(r.runId || '') + '</td>'
    + '<td class="mono">' + esc((r.mtime || '').slice(0, 10)) + '</td>'
    + '<td>' + dgHtml(r.freshness, r.changedBy) + '</td>'
    + '<td class="mono">' + addsHtml(r) + '</td></tr>';
}

/** Blind spots folded by shape: the same finding on n artefacts is one row with its list.
 * @group Tests tab */
function foldGaps(gaps) {
  const by = new Map();
  for (const g of gaps) {
    const shape = String(g.text || '').replace(/`[^`]*`/g, '`…`');
    const key = [g.kind, g.level || '', g.reportKind || '', g.glob || '', shape].join(' · ');
    if (!by.has(key)) {
      by.set(key, { kind: g.kind, level: g.level, reportKind: g.reportKind, glob: g.glob, text: g.text, paths: [], n: 0 });
    }
    const e = by.get(key);
    e.n++;
    (g.paths || []).forEach((p) => e.paths.push(p));
  }
  return [...by.values()].sort((a, b) => {
    const ra = GAP_RANK.indexOf(a.kind);
    const rb = GAP_RANK.indexOf(b.kind);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || b.n - a.n;
  });
}

/** The blind spots, artefacts first, identical lines folded, every path reachable.
 * @group Tests tab */
function blindSection(d) {
  let html = '<div class="tst-sec"><h2>' + esc(t('tests.kpi.gaps')) + '</h2>';
  if (!d.gaps) {
    return html + '<p class="set-note">' + esc(t('tests.gapsAbsent')) + '</p>'
      + (d.blindSpots || []).map((s) => '<div class="tst-bs"><span class="k">' + esc(t('tests.bsKind.recorded'))
        + '</span><span class="v">' + mdCode(s) + '</span><span class="n"></span></div>').join('')
      + '</div>';
  }
  if (!d.gaps.length) return html + '<p class="set-note">' + esc(t('tests.gapsNone')) + '</p></div>';
  foldGaps(d.gaps).forEach((g, i) => {
    const key = 'gap' + i;
    const open = OPEN.has(key);
    const word = GAP_WORD[g.kind] || GAP_WORD.unreadable;
    html += '<div class="tst-bs' + (g.n > 1 && !open ? ' folded' : '') + '">'
      + tagOpen('k ' + word[1], word[0]) + esc(t(word[0])) + '</span>'
      + '<span class="v">' + mdCode(g.text)
      + (g.paths.length && (open || g.n === 1) && !biz() ? '<br><span class="mono">' + esc(g.paths.join(' · ')) + '</span>' : '')
      + (g.n > 1 ? '<br><button class="tst-showall" onclick="testsFold(\'' + key + '\')">'
        + esc(t(open ? 'tests.fold.hide' : 'tests.blind.fold').replace('{n}', String(g.n))) + '</button>' : '')
      + '</span>'
      + '<span class="n">' + esc([g.level ? t('tests.level.' + g.level) : '', biz() ? '' : g.reportKind || ''].filter(Boolean).join(' · ')
        + (g.n > 1 ? ' ×' + g.n : '')) + '</span></div>';
  });
  return html + '</div>';
}

/** The freshness view: the reports, the blind spots, and the recipe that makes a run provable.
 * @group Tests tab */
function freshnessHtml(d) {
  const repos = [...new Set((d.sources || []).map((s) => s.repo))];
  if (!repos.length) repos.push(...Object.keys((d.identity || {}).source_digest || {}));
  const lines = [];
  for (const repo of repos) {
    lines.push(t('tests.digest.cmd').replace('{repo}', repo));
    for (const level of [...new Set((d.sources || []).filter((s) => s.repo === repo).map((s) => s.level))]) {
      lines.push(t('tests.import.cmd').split('{repo}').join(repo).replace('{level}', level));
    }
  }
  return '<div class="tst-sec"><h2>' + esc(t('tests.view.freshness')) + '</h2>'
    + '<p class="tst-gap">' + esc(def('tests.view.freshness') || '') + '</p>'
    + reportsHtml(d) + '</div>'
    + blindSection(d)
    + '<div class="tst-sec"><h2>' + esc(t('tests.sec.recipe')) + '</h2>'
    + '<pre class="tst-cmd">' + esc(lines.join('\n')) + '</pre></div>';
}

// ── one test's own page: #/tests/<id> (03 §4.2, board 06) ─────────────────
//
// Three groups, never a fourth, and two facts kept apart that every review saw
// blended: the **class** of a covers edge (declared · reached · observed) and
// the **verdict** of a run. So:
//
//   * each row carries its own technique and confidence tier. A declared edge
//     can be HIGH and a reached one LOW; the group head says only how that
//     class is found, never how strong a member of it is;
//   * `route-literal` at LOW prints its tier beside its word, so it can never
//     read like a run;
//   * a skipped or inactive case shows no observed edge — and the page says
//     which of the two reasons applies rather than leaving an empty group;
//   * the runs are one card per project. The case's own verdict is the weakest
//     of them, and that is said in words whenever the projects disagree;
//   * `twin` and `alternatives` name what a resolution set aside. Their absence
//     is silence, not a claim that there was nothing to set aside.

/** A glyph per covered kind — the node's shape, so a reader sorts the list by eye. */
const KIND_SYM = {
  page: 'screen', component: 'screen', flow: 'start', route: 'api', api: 'api',
  table: 'record', queue: 'message', external: 'external', guard: 'gate', rule: 'shield',
};
const NOTE_OPEN_PLAIN = '<span class="tst-d-note">';

/** The three groups in the order the board draws them, with their edge class. */
const DETAIL_GROUPS = [
  { cls: 'declared', edge: 'declared' },
  { cls: 'reached', edge: 'static' },
  { cls: 'observed', edge: 'observed' },
];

/** Fetch one test and draw its page — a 404 says so and offers the catalogue.
 * @group Tests tab */
async function loadDetail() {
  const r = await fetch('/api/tests/' + encodeURIComponent(DETAIL));
  const d = await r.json().catch(() => null);
  const wrap = document.querySelector('.tst-wrap');
  if (!r.ok || !d || d.error || !d.covers) {
    if (wrap) {
      wrap.innerHTML = stripHtml(null, true)
        + '<div id="tst-body"><div class="tst-sec"><p class="set-note">'
        + esc(t(r.status === 404 ? 'tests.detail.notFound' : 'sys.testsFailed')) + '</p>'
        + '<p class="tst-lift mono">' + esc(DETAIL) + '</p>'
        + '<p class="tst-gap"><a href="' + tHref('matrix', 'all') + '">← ' + esc(t('tests.detail.back')) + '</a></p></div></div>';
    }
    return;
  }
  DATA = d;
  if (wrap) wrap.innerHTML = stripHtml(d, true) + '<div id="tst-body">' + detailHtml(d) + '</div>';
}

/** Where this test lives, what kind it is, and — for a report — that it is not a case.
 * @group Tests tab */
function dtlHeadHtml(d) {
  const tr = d.test || {};
  const loc = d.loc || {};
  const projects = [...new Set((tr.runs || []).map((r) => r.project).filter(Boolean))];
  const bits = [];
  bits.push('<span class="mono">' + esc(t('tests.detail.ident')
    .replace('{level}', t('tests.level.' + tr.level)).replace('{runner}', tr.runner || '')) + '</span>');
  if ((tr.suite || []).length) {
    bits.push('<span class="mono">' + esc(t('tests.detail.suite').replace('{path}', tr.suite.join(' › '))) + '</span>');
  }
  if (projects.length) {
    bits.push(tagOpen('pj', 'tests.detail.projects')
      + esc(t('tests.detail.projects').replace('{list}', projects.join(' · '))) + '</span>');
  }
  return '<div class="tst-sec tst-d-head">'
    + '<p class="tst-gap"><a href="' + tHref('matrix', 'all') + '">← ' + esc(t('tests.detail.back')) + '</a></p>'
    + '<h2>' + esc(d.name) + '</h2>'
    + '<div class="tst-d-path">'
    + (tr.file ? '<span class="loc">' + esc(tr.file) + (loc.line ? ':' + loc.line : '') + '</span>'
      + vsl(d.repo, tr.file, loc.line || 1) : '')
    + bits.join('')
    + (tr.runLevel ? tagOpen(EV_CLS.declared, 'tests.detail.runLevel')
      + esc(t('tests.detail.runLevel')) + '</span>' : '')
    + (tr.inactive ? tagOpen(EV_CLS.none, 'tests.detail.inactive') + sym('absent')
      + esc(t('tests.detail.inactive')) + '</span>' : '')
    + '</div>'
    + (tr.runLevel && (tr.files || []).length
      ? '<p class="tst-gap">' + esc(t('tests.detail.runLevelFiles').replace('{n}', String(tr.files.length))) + '</p>' : '')
    + '<p class="tst-lift mono">' + esc(d.id) + '</p>'
    + (d.docs ? '<p class="tst-gap">' + mdCode(d.docs) + '</p>' : '')
    + '</div>';
}

/** The @covers values exactly as the source writes them — resolved or not.
 * @group Tests tab */
function dtlClaimsHtml(d) {
  const tr = d.test || {};
  if (tr.runLevel) return '';
  const declares = tr.declares || [];
  const unresolved = new Set(tr.unresolved || []);
  // nothing claimed and nothing orphaned: the Declared group already says so in
  // its own words, and the same absence printed twice reads as two facts
  if (!declares.length && !d.orphan) return '';
  let html = '<div class="tst-sec tst-d-claimsec"><h2>' + esc(t('tests.detail.asWritten')) + '</h2>';
  if (!declares.length) {
    html += '<p class="tst-gap">' + tagOpen(EV_CLS.none, 'tests.detail.none.declared')
      + sym('absent') + esc(t('journey.absent.noneIndexed')) + '</span> '
      + esc(t('tests.detail.none.declared')) + '</p>';
  } else {
    html += '<div class="tst-d-claims">' + declares.map((v) => '<span class="tst-d-claim'
      + (unresolved.has(v) ? ' bad' : '') + '">' + (unresolved.has(v) ? sym('warning') + ' ' : '')
      + esc(v) + '</span>').join('') + '</div>';
  }
  if (unresolved.size) {
    html += '<p class="tst-gap bad">' + esc(t('tests.orphan.unresolved')
      .replace('{v}', [...unresolved].join(' · '))) + '</p>';
  }
  if (d.orphan && d.orphan.reason === 'covers-nothing') {
    html += '<p class="tst-gap bad">' + esc(t('tests.orphan.coversNothing')) + '</p>'
      + '<p class="tst-gap">' + esc(t('tests.orphansNote')) + '</p>';
  }
  return html + '</div>';
}

/** One covered node: what it is, how this edge was found, how strong it is, what it set aside.
 * @group Tests tab */
function dtlCoverRowHtml(c, d) {
  const glyph = KIND_SYM[c.kind] ? sym(KIND_SYM[c.kind]) : sym('step');
  const repo = String(c.nodeId || '').split('::')[0] || d.repo;
  const tier = c.confidence ? '<b>' + esc(c.confidence) + '</b>' : '';
  const how = [c.technique ? esc(c.technique) : '', tier].filter(Boolean).join(' · ');
  const run = (d.test || {}).run;
  // the class is the edge's and is never downgraded; `stale` is the same
  // observed class said with the code having moved under it since the run
  const stale = c.evidence === 'observed' && run && run.freshness === 'changed';
  const chipCls = c.evidence === 'observed' ? (stale ? 'stale' : 'observed')
    : c.evidence === 'static' ? 'reached' : 'declared';
  return '<div class="tst-d-row">'
    + '<span class="sym">' + glyph + '</span>'
    + '<span class="nm"><span class="t">' + esc(c.name) + '</span>'
    + '<span class="cn">' + esc(c.nodeId) + '</span></span>'
    + '<span class="via">' + how
    + (c.note ? NOTE_OPEN_PLAIN + esc(c.note) + '</span>' : '')
    + (c.match ? '<span class="tst-lift">' + esc(t('tests.detail.match').replace('{how}', c.match)) + '</span>' : '')
    + (c.twin ? tagOpen('tst-d-twin', 'tests.detail.twin')
      + esc(t('tests.detail.twin').replace('{note}', c.twin.note)) + '</span>' : '')
    + (c.alternatives && c.alternatives.length
      ? tagOpen('tst-d-twin', 'tests.detail.alternatives')
        + esc(t('tests.detail.alternatives').replace('{list}', c.alternatives.join(' · '))) + '</span>' : '')
    + '</span>'
    + '<span class="ch">' + evChipHtml(chipCls, 'journey.evidence.' + chipCls)
    + (c.inactive ? '<span class="tst-lift">' + esc(t('tests.detail.inactive')) + '</span>' : '') + '</span>'
    + '<span class="lk">' + (c.loc && c.loc.path
      ? '<span class="loc">' + esc(c.loc.path) + (c.loc.line ? ':' + c.loc.line : '') + '</span>'
        + vsl(repo, c.loc.path, (c.loc.line || 1))
      : '') + '</span>'
    + '</div>';
}

/** What a report saw of the nodes this case reaches, when no report named the case itself.
 * @group Tests tab */
function dtlAlsoHtml(d) {
  const also = d.alsoObserved || [];
  if (!also.length) return '';
  return '<p class="tst-gap">' + esc(t(also.length === 1 ? 'tests.runOnlyOne' : 'tests.runOnly').replace('{n}', String(also.length))) + '</p>'
    + '<ul class="tst-cases" role="list">' + also.map((o) => '<li>'
      + '<a href="#/tests/' + encodeURIComponent(o.id) + '">' + esc(o.name) + '</a>'
      + (o.runLevel ? ' ' + tagOpen(EV_CLS.declared, 'tests.detail.runLevel')
        + esc(t('tests.detail.runLevel')) + '</span>' : '')
      + '<span class="mono"> ' + esc(t('tests.level.' + o.level)) + ' · '
      + esc(t('tests.detail.byRun').replace('{n}', String(o.nodes))) + '</span></li>').join('') + '</ul>';
}

/** One evidence group: its rows, or the absence word with the reason it is empty.
 * @group Tests tab */
function dtlGroupHtml(d, g) {
  const rows = (d.covers || []).filter((c) => c.evidence === g.edge)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const techniques = [...new Set(rows.map((c) => c.technique).filter(Boolean))];
  const run = (d.test || {}).run;
  let body;
  if (rows.length) {
    body = rows.map((c) => dtlCoverRowHtml(c, d)).join('');
  } else {
    // the row's own check: a skipped case shows no observed edge, and the page
    // says which of the two silences this is — no run at all, or a run that
    // read the case and did not execute it
    const skipped = g.cls === 'observed' && !!run && run.status === 'skipped';
    // a report is not a case: it has no author to declare and no body to reach,
    // so the two silences above the observed group are one fact, said once
    const key = 'tests.detail.none.'
      + ((d.test || {}).runLevel && g.cls !== 'observed' ? 'runLevel' : g.cls);
    body = '<div class="tst-d-empty">' + tagOpen(EV_CLS.none, key)
      + sym('absent') + esc(t('journey.absent.noneIndexed')) + '</span> '
      + esc(t(key))
      + (skipped ? '<p class="tst-gap bad">' + esc(t('tests.detail.skippedNoObserved')) + '</p>' : '')
      + (g.cls === 'observed' ? dtlAlsoHtml(d) : '') + '</div>';
  }
  return '<div class="tst-d-grp' + (rows.length ? '' : ' dashed') + '">'
    + '<div class="gh"><span class="hud-label">' + esc(t('tests.detail.' + g.cls)) + '</span>'
    + '<span class="n">' + esc(t('tests.detail.edges').replace('{n}', String(rows.length))) + '</span>'
    + tagOpen('how', 'tests.detail.how.' + g.cls) + esc(t('tests.detail.how.' + g.cls))
    + (techniques.length ? ' — ' + esc(techniques.join(' · ')) : '') + '</span></div>'
    + body + '</div>';
}

/** One run: which project, what it said, when, against which code, out of which report.
 * @group Tests tab */
function dtlRunCardHtml(r) {
  const st = ST_CLS[r.status] ? r.status : 'unknown';
  const secs = r.durationMs != null ? (r.durationMs / 1000).toFixed(1) : null;
  return '<div class="tst-d-run' + (st === 'failed' ? ' failed' : '') + '">'
    + (r.project ? '<span class="pj">' + esc(r.project) + '</span>' : '')
    + '<span class="ln">' + tagOpen(ST_CLS[st], 'tests.run.' + st)
    + esc(t('tests.run.' + st)) + '</span>'
    + '<span class="mono">' + esc((r.at || '').slice(0, 16).replace('T', ' ')) + '</span>'
    + (secs ? '<span class="mono">' + esc(t('tests.detail.duration').replace('{s}', secs)) + '</span>' : '')
    + (r.retries ? '<span class="mono">' + esc(t('tests.detail.retries').replace('{n}', String(r.retries))) + '</span>' : '')
    + '</span>'
    + '<span class="ln">' + dgHtml(r.freshness, r.changedBy)
    + (r.join === 'each-template'
      ? '<span class="mono">' + esc(t('tests.detail.joinEach').replace('{n}', String(r.rows || 0))) + '</span>'
      : r.join === 'exact' ? '<span class="mono">' + esc(t('tests.detail.join')) + '</span>' : '')
    + '</span>'
    + (r.report ? '<span class="ln"><span class="loc">'
      + esc(t('tests.detail.report').replace('{path}', r.report)) + '</span></span>' : '')
    + '</div>';
}

/** The runs, one card per project, and the rule that turns several into one verdict.
 * @group Tests tab */
function dtlRunsHtml(d) {
  const tr = d.test || {};
  const runs = (tr.runs && tr.runs.length ? tr.runs : tr.run ? [tr.run] : []).slice()
    .sort((a, b) => String(a.project || '').localeCompare(String(b.project || '')));
  let html = '<div class="tst-sec"><h2>' + esc(t('tests.detail.runs')) + '</h2>';
  if (!runs.length) {
    return html + '<p class="tst-gap">' + tagOpen(ST_CLS.notrun, 'tests.run.notRun')
      + esc(t('tests.run.notRun')) + '</span></p></div>';
  }
  html += '<div class="tst-d-runs">' + runs.map((r) => dtlRunCardHtml(r)).join('') + '</div>';
  if (runs.length > 1) {
    const statuses = [...new Set(runs.map((r) => r.status))];
    const fold = tr.run ? tr.run.status : statuses[0];
    const word = t('tests.run.' + (ST_CLS[fold] ? fold : 'unknown'));
    html += '<p class="tst-gap' + (statuses.length > 1 ? ' bad' : '') + '">'
      + esc(statuses.length > 1
        ? t('tests.detail.weakest').split('{status}').join(word).replace('{status2}', word)
        : t('tests.detail.agree').replace('{n}', String(runs.length))) + '</p>';
  }
  return html + '</div>';
}

/** The journeys whose scope holds something this test reaches.
 * @group Tests tab */
function dtlJourneysHtml(d) {
  const js = d.journeys || [];
  return '<div class="tst-sec"><h2>' + esc(t('tests.detail.journeys')) + '</h2>'
    + (js.length
      ? '<ul class="tst-cases" role="list">' + js.map((j) => '<li><a href="#/journeys/'
        + encodeURIComponent(j.id) + '">' + esc(j.name) + '</a>'
        + '<span class="tst-lift mono">' + esc(j.id) + '</span></li>').join('') + '</ul>'
      : '<p class="tst-gap">' + tagOpen(EV_CLS.none, 'tests.detail.journeysNone')
        + sym('absent') + esc(t('journey.absent.noneIndexed')) + '</span> '
        + esc(t('tests.detail.journeysNone')) + '</p>')
    + '</div>';
}

/** One test's page: what it is, what it claims, what it reaches, what ran.
 * @group Tests tab */
function detailHtml(d) {
  return dtlHeadHtml(d) + dtlClaimsHtml(d)
    + '<div class="tst-d-grps">' + DETAIL_GROUPS.map((g) => dtlGroupHtml(d, g)).join('') + '</div>'
    + dtlRunsHtml(d) + dtlJourneysHtml(d);
}

expose({ mountTests, testsGo, testsFold, testsRetry });
