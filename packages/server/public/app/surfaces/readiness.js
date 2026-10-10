// surfaces/readiness.js — the release readiness brief (round 2026-10-10, proposal 6).
//
// `#/readiness/<storyline>`: one storyline as a document a release decision is signed on — one row per step
// and per branch (built · its own verdict and the day of its newest run · skipped and never run · gates no
// test is known to reach · commits since its last green run · ship or hold with the reason), then the rules
// register (gate · in plain words · screens · tests · owner). Everything is read from `GET /api/readiness`
// (core `readiness()`); this page folds nothing. It draws in the **light theme** whatever the reader's
// theme is (restored on leaving), prints on A4 one storyline per page (the `@media print` rules in
// viewer.html), saves as a light PDF on one A4 page through lib/export.js, and as a CSV.

import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, defAttrs, plainTip } from '../lib/counted.js';
import { tipAttrs } from '../lib/tooltip.js';
import { exportToolHtml, registerExport } from '../lib/export.js';
import { footerFacts, footerLines } from '../lib/export-model.js';

const API = '/api/readiness?storyline=';
/** What the page holds: the storyline asked for, its answer, the theme it found. */
let RD = { id: null, data: null, theme: null, gen: 0 };

/** A catalog word with `{name}` placeholders filled. */
function fill(key, vars) {
  let s = t(key);
  for (const [k, v] of Object.entries(vars || {})) s = s.split('{' + k + '}').join(String(v));
  return s;
}
const day = (at) => (at ? String(at).slice(0, 10) : '');
const word = (key) => '<span' + defAttrs(key) + '>' + esc(t(key)) + '</span>';
const num = (n, key, scope) => '<span class="rd-n"' + plainTip(n, key, scope, '/api/readiness') + '>' + esc(String(n)) + '</span>';

/**
 * Mount the brief. The light theme is set on the document while the brief is on screen.
 * @group Readiness
 * @business The release readiness brief: for each step of a storyline, whether it is built and proven, and ship or hold with the reason.
 */
export function mountReadiness(route, el) {
  if (RD.theme == null) RD.theme = document.documentElement.dataset.theme || '';
  document.documentElement.dataset.theme = 'light';
  document.body.classList.add('rd-on');
  RD.id = route.param || '';
  RD.data = null;
  const gen = ++RD.gen;
  el.innerHTML = '<div class="rd-wrap"><div class="rd-sheet" id="rd-sheet"><p class="set-note">' + esc(t('readiness.loading')) + '</p></div></div>';
  fetch(API + encodeURIComponent(RD.id) + (route.repo ? '&repo=' + encodeURIComponent(route.repo) : '')).then(async (r) => ({ status: r.status, body: await r.json() })).then(({ status, body }) => {
    if (gen !== RD.gen) return;
    RD.data = status === 200 ? body : { error: body.error, known: body.known || [] };
    draw();
  }).catch(() => { if (gen === RD.gen) { RD.data = { error: 'unreachable', known: [] }; draw(); } });
}

/** Leaving the brief gives the reader their theme back. @group Readiness */
export function unmountReadiness() {
  if (RD.theme != null) {
    if (RD.theme) document.documentElement.dataset.theme = RD.theme; else delete document.documentElement.dataset.theme;
  }
  RD.theme = null;
  document.body.classList.remove('rd-on');
  RD.gen++;
}

/** The lens or the register moved: redraw from what was read. @group Readiness */
export function readinessRefresh() { if (RD.data) draw(); }

function draw() {
  const host = document.getElementById('rd-sheet');
  if (!host) return;
  const d = RD.data;
  if (!d || d.error) {
    host.innerHTML = '<p class="rd-unknown"' + defAttrs('readiness.unknown') + '>' + esc(fill('readiness.unknown', { id: RD.id })) + '</p>'
      + ((d && d.known && d.known.length) ? '<p class="rd-known"><span class="hud-label">' + esc(t('readiness.known')) + '</span> '
        + d.known.map((k) => '<a href="#/readiness/' + esc(encodeURIComponent(k.id)) + (k.repo ? '?repo=' + esc(encodeURIComponent(k.repo)) : '') + '">' + esc(k.name) + '</a>').join(' · ') + '</p>' : '');
    return;
  }
  host.innerHTML = sheetHtml(d);
}

/** The provenance line: the export footer's own facts (source · sync · commit · as of · lens · drawn by). */
function provenance(title) {
  const lines = footerLines(footerFacts({ meta: (S.GRAPH && S.GRAPH.meta) || {}, version: S.VERSION, lens: currentLens(), surface: 'readiness', title }), t);
  return lines.slice(1).join(' · ');
}

/** The verdict cell: the evidence word in this lens's words, then the day of the newest run. */
function verdictHtml(row) {
  if (!row.verdict) return '<span class="rd-dash">—</span>';
  const w = row.verdict.word;
  const key = currentLens() === 'business' && w.biz ? w.biz : w.key;
  return '<span class="rd-ev ev-' + esc(w.cls) + '"' + defAttrs(key) + '>' + esc(t(key)) + '</span>'
    + '<span class="rd-sub">' + (row.lastRun ? esc(day(row.lastRun)) : esc(t('readiness.noRun'))) + '</span>';
}

function rowHtml(row) {
  const scope = 'journey.scopeAll';
  const screens = row.screens.map((s) => s.name).join(' · ');
  const built = row.built.all
    ? '<span class="rd-stamp ok"' + defAttrs('readiness.col.built') + '>' + esc(t('readiness.col.built')) + '</span>'
    : '<span class="rd-stamp warn"' + defAttrs('readiness.hold.notBuilt') + '>' + esc(t('readiness.hold.notBuilt')) + '</span>';
  // no number: either nothing in scope ever passed, or the history was not read for this source
  const why = !row.lastGreen ? 'readiness.noGreen' : 'readiness.noSpine';
  const commits = row.commitsSince != null ? num(row.commitsSince, 'readiness.col.commits', scope)
    : '<span class="rd-sub"' + defAttrs(why) + '>' + esc(t(why)) + '</span>';
  const decision = row.ship
    ? '<span class="rd-badge ship"' + defAttrs('readiness.ship') + '>' + esc(t('readiness.ship')) + '</span>'
    : '<span class="rd-badge hold"' + defAttrs('readiness.hold') + '>' + esc(t('readiness.hold')) + '</span><span class="rd-why">'
      + row.hold.map((h) => word('readiness.hold.' + h)).join(' · ') + '</span>';
  return '<tr class="rd-row' + (row.kind === 'branch' ? ' rd-branch' : '') + '" data-step="' + esc(row.label) + '" data-decision="' + (row.ship ? 'ship' : 'hold') + '">'
    + '<td class="rd-step">' + esc(row.label) + '</td>'
    + '<td><a class="rd-name" href="#/journeys/' + esc(encodeURIComponent(row.flowId)) + '">' + esc(row.name) + '</a>'
    + (row.branchOf ? '<span class="rd-sub"' + tipAttrs({ text: row.branchOf.when }) + '>' + esc(fill('readiness.branch', { name: row.branchOf.name })) + '</span>' : '')
    + (screens ? '<span class="rd-sub">' + esc(screens) + '</span>' : '') + '</td>'
    + '<td>' + built + '<span class="rd-sub"' + defAttrs('readiness.builtN') + '>' + esc(fill('readiness.builtN', { n: row.built.n, m: row.built.of })) + '</span></td>'
    + '<td>' + verdictHtml(row) + '</td>'
    + '<td>' + num(row.skipped, 'count.part.skipped', scope) + ' / ' + num(row.unrun, 'count.part.noRun', scope) + '</td>'
    + '<td>' + num(row.gates.unreached.length, 'readiness.col.unreached', scope) + ' <span class="rd-sub-i">/ ' + esc(String(row.gates.n)) + '</span>'
    + (row.gates.unreached.length ? '<span class="rd-sub rd-gates">' + row.gates.unreached.slice(0, 3).map((g) => esc(g.name)).join(' · ') + (row.gates.unreached.length > 3 ? ' · +' + (row.gates.unreached.length - 3) : '') + '</span>' : '') + '</td>'
    + '<td>' + commits + '</td>'
    + '<td>' + decision + '</td></tr>';
}

function rulesHtml(r) {
  if (!r.rules.length) return '';
  const head = ['readiness.col.gate', 'readiness.col.words', 'readiness.col.screens', 'readiness.col.tests', 'readiness.col.owner'];
  return '<h2 class="rd-h2"><span' + defAttrs('readiness.rules') + '>' + esc(t('readiness.rules')) + '</span> '
    + countedHtml(r.counted.rules, '/api/readiness', { cls: 'rd-hsub' }) + ' <span class="rd-hsub">' + esc(t('readiness.rulesSub')) + '</span></h2>'
    + '<table class="rd-table rd-rules"><thead><tr>' + head.map((k) => '<th' + defAttrs(k) + '>' + esc(t(k)) + '</th>').join('') + '</tr></thead><tbody>'
    + r.rules.map((g) => '<tr><td class="rd-gate">' + esc(currentLens() === 'business' && g.words ? g.words : g.name) + '</td>'
      + '<td>' + (g.words ? esc(g.words) : '<span class="rd-warn"' + defAttrs('readiness.noWords') + '>' + esc(t('readiness.noWords')) + '</span>') + '</td>'
      + '<td>' + num(g.screens, 'readiness.screensN', 'count.scope.gate') + '</td>'
      + '<td>' + num(g.tests, 'readiness.casesN', 'count.scope.gate') + '</td>'
      + '<td>' + (g.owners.length ? esc(g.owners.join(', ')) : '<span class="rd-warn"' + defAttrs('readiness.noOwner') + '>' + esc(t('readiness.noOwner')) + '</span>') + '</td></tr>').join('')
    + '</tbody></table>';
}

function sheetHtml(d) {
  const r = d.readiness;
  const c = r.counted;
  const cols = ['readiness.col.step', 'readiness.col.journey', 'readiness.col.built', 'readiness.col.verdict', 'readiness.col.skipped', 'readiness.col.unreached', 'readiness.col.commits', 'readiness.col.decision'];
  const tile = (counted) => '<div class="rd-tile">' + countedHtml(counted, '/api/readiness', { cls: 'rd-tile-n' }) + '</div>';
  return '<header class="rd-head"><div class="rd-headl">'
    + '<div class="rd-brand hud-label"' + defAttrs('readiness.brand') + '>' + esc(t('readiness.brand')) + '</div>'
    + '<h1 class="rd-title"><span' + defAttrs('readiness.title') + '>' + esc(t('readiness.title')) + '</span> · <span class="rd-story">' + esc(r.storyline.name) + '</span></h1>'
    + '<div class="rd-prov">' + esc(provenance(r.storyline.name)) + '</div></div>'
    + '<div class="rd-headr" data-export-skip-print>'
    + '<div class="rd-tools" data-export-skip>' + exportToolHtml('readiness', 'jrn-viewbtn rd-export')
    + '<button type="button" class="jrn-viewbtn rd-print" onclick="window.print()"' + tipAttrs({ key: 'readiness.print', noFocus: true }) + '>' + sym('open') + ' ' + esc(t('readiness.print')) + '</button></div>'
    + '<div class="rd-sign"><span' + defAttrs('readiness.signoff') + '>' + esc(t('readiness.signoff')) + '</span> <span class="rd-line"></span> '
    + '<span' + defAttrs('readiness.date') + '>' + esc(t('readiness.date')) + '</span> <span class="rd-line short"></span></div></div></header>'
    + (r.storyline.description ? '<p class="rd-desc">' + esc(r.storyline.description) + '</p>' : '')
    + '<div class="rd-tiles">' + tile(c.steps) + tile(c.ship) + tile(c.hold) + tile(c.skipped) + tile(c.unreached) + '</div>'
    + '<table class="rd-table rd-steps"><thead><tr>' + cols.map((k) => '<th' + defAttrs(k) + '>' + esc(t(k)) + '</th>').join('') + '</tr></thead><tbody>'
    + r.rows.map((row) => rowHtml(row)).join('') + '</tbody></table>'
    + rulesHtml(r)
    + '<footer class="rd-foot"><span>' + esc(t('readiness.foot')) + '</span></footer>';
}

registerExport('readiness', () => {
  const el = document.getElementById('rd-sheet');
  const r = RD.data && RD.data.readiness;
  return el && r ? { el, title: r.storyline.name, subject: r.storyline.id, a4: true } : null;
}, {
  csv: () => {
    const r = RD.data && RD.data.readiness;
    if (!r) return { header: [], rows: [] };
    const header = ['step', 'journey', 'kind', 'branch_of', 'when', 'built', 'screens_built', 'screens', 'verdict', 'last_run', 'skipped', 'failed', 'never_run', 'gates', 'gates_no_test', 'commits_since_green', 'decision', 'reasons', 'owner'];
    const rows = r.rows.map((x) => [x.label, x.name, x.kind, x.branchOf ? x.branchOf.name : '', x.branchOf ? x.branchOf.when : '',
      x.built.all ? 'yes' : 'no', String(x.built.n), String(x.built.of), x.verdict ? t(x.verdict.word.key) : '', x.lastRun || '',
      String(x.skipped), String(x.failed), String(x.unrun), String(x.gates.n), String(x.gates.unreached.length),
      x.commitsSince == null ? '' : String(x.commitsSince), x.ship ? t('readiness.ship') : t('readiness.hold'),
      x.hold.map((h) => t('readiness.hold.' + h)).join(' · '), x.owner || '']);
    return { header, rows };
  },
});

