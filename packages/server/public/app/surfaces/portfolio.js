// surfaces/portfolio.js — the flow status table: the front door (01 §5.2).
//
// One row per flow the design manifest names, answering the four questions a
// person asks before opening anything: what is built of it, what the contract
// declares, what proves it runs, and whether it reaches the ERP. Every cell is
// read from an endpoint and every absence is a word — a blank would be read as
// "nothing", and "nothing found" and "nothing there" are different facts.
//
// The design rows arrive first and the table renders immediately; the per-flow
// cells fill in as their journey and coverage come back, because a journey walk
// over a real application takes a second or two and a reader should not wait
// for ten of them to see the shape of the product.

import { S, esc, expose, currentLens } from '../store.js';
import { t, def, evidenceWord } from '../strings.js';
import { sym } from '../sym.js';
import { storiesCatalogueHtml } from '../stories.js';
import { countedHtml, countWords, defAttrs, plainTip, unCode } from '../lib/counted.js';
import { flowWork, flowChipHtml } from '../work-chips.js';

/** A catalog word's tip, or nothing when it has no define. */
function tipOf(key) { return key && def(key) ? defAttrs(key) : ''; }

/** The flow rows, keyed by node id, as the endpoints fill them in. */
let ROWS = new Map();
/** The design rows the table is drawn from, kept so a register flip redraws without re-asking. */
let FLOWS = [];
let PRODUCT_SURFACES = [];
/**
 * Which load the page is showing. Every scope change starts a new one, and the
 * walk loop of the one before it stops at its next await rather than filling
 * cells of a table that is no longer on screen — ten journey walks are in flight
 * for a second or two each, and a stale one landing in a fresh table would show
 * the previous scope's numbers under the new scope's rows.
 */
let GEN = 0;

/**
 * Mount the flow status table.
 * @group Portfolio
 * @business The front door: every flow the product names, and what is true of it today.
 */
export function mountPortfolio(route, el) {
  el.innerHTML = shellHtml();
  start();
}

/** The page around the table. Its heading and standfirst are catalog words too,
 * so a register flip has to redraw them — not only the rows. */
function shellHtml() {
  return '<div class="set-wrap pf-wrap"><h1>' + esc(t('nav.portfolio')) + '</h1>'
    + '<p class="sub">' + esc(t('portfolio.sub')) + '</p>'
    + '<div id="pf-body"><p class="set-note">' + esc(t('portfolio.loading')) + '</p></div>'
    // the components the product can show on their own, from the story files (ADR 9)
    + '<div id="pf-stories"></div></div>';
}

/**
 * Redraw after the scope or the register moved.
 *
 * A register or lens flip changes the words, not the facts, so it redraws from
 * the rows already in hand — re-walking ten journeys to re-word a table would be
 * a second of staring at *loading* for nothing. A scope change moves which
 * design sources answer and a sync replaces the graph, so both ask again from
 * the top under a new generation.
 * @group Portfolio
 */
export function portfolioRefresh(reason) {
  const el = document.getElementById('surface');
  const body = document.getElementById('pf-body');
  if (!el || !body) return;
  // words only: the rows are already in hand and every one of them is still
  // true. The whole page is rewritten, not just the table — the heading and the
  // standfirst are catalog words that live outside `#pf-body`, and redrawing
  // only the rows left one register's heading over the other's table.
  if (reason === 'lens' || reason === 'register') { el.innerHTML = shellHtml(); render(); fillStories(); return; }
  body.innerHTML = '<p class="set-note">' + esc(t('portfolio.loading')) + '</p>';
  start();                                  // the walk loop in flight stops at its next await
}

/** The stories catalogue under the table — its own container, so a flow row filling in does not redraw it. */
function fillStories() {
  const box = document.getElementById('pf-stories');
  if (box) box.innerHTML = storiesCatalogueHtml();
}

/** Load the design rows and then the per-flow facts, under one generation. */
function start() {
  const gen = ++GEN;
  fillStories();
  load(gen).catch(() => {
    if (gen !== GEN) return;
    const b = document.getElementById('pf-body');
    if (b) b.innerHTML = '<p class="set-note">' + esc(t('sys.designFailed')) + '</p>';
  });
}

async function load(gen) {
  const design = await fetch('/api/design?scope=' + encodeURIComponent(scopeParam())).then((r) => r.json());
  if (gen !== GEN) return;
  const sources = design.designs || design.sources || (Array.isArray(design) ? design : []);
  const flows = [];
  const surfaces = [];
  for (const d of Array.isArray(sources) ? sources : []) {
    for (const f of d.flows || []) flows.push({ ...f, repo: d.repo });
    for (const s of d.surfaces || []) surfaces.push(s);
  }
  ROWS = new Map(flows.map((f) => [f.nodeId, { flow: f }]));
  FLOWS = flows; PRODUCT_SURFACES = surfaces;
  render();
  // the expensive per-flow facts, one flow at a time so the table fills in order
  for (const f of flows) {
    await fill(f, gen).catch(() => {});
    if (gen !== GEN) return;
    render();
  }
}

/** `?scope=` for /api/design, from the viewer's multi-select scope. */
function scopeParam() {
  return S.scope === 'all' || !S.scope.length ? 'all' : S.scope.join(',');
}

/** The tested word, the operations count and whether the flow reaches an ERP. */
async function fill(f, gen) {
  const row = ROWS.get(f.nodeId) || { flow: f };
  row.flow = f;
  const [tests, journey, work] = await Promise.all([
    fetch('/api/tests?flow=' + encodeURIComponent(f.nodeId)).then((r) => r.json()).catch(() => null),
    fetch('/api/journey?entry=' + encodeURIComponent(f.nodeId)).then((r) => r.json()).catch(() => null),
    // the trackers' items linked to this flow — asked only when a work source is configured
    flowWork(f.nodeId),
  ]);
  row.work = work;
  row.coverage = tests && tests.coverage ? tests.coverage : null;
  const systems = (journey && journey.summary && journey.summary.systems) || [];
  row.erp = systems.find((r) => r.externalKind === 'erp') || null;
  // an operation the spec declares that no code implements, named like an approval,
  // is the ERP hand-off a reader is looking for — said as declared, never as built
  const seg = (journey && journey.summary && journey.summary.segments) || [];
  row.declaredOnly = seg.reduce((a, s) => a.concat(s.declaredOnly || []), []);
  // What the flow's code calls, and what is only declared — split by the fold,
  // not counted here. Every action used to count as *called*, so a flow whose
  // every action is a contract-derived planned step printed `7 called` for seven
  // operations no code implements (swarm 2026-09-23, blocker 1). The two numbers
  // come from `summary.counts` so the HUD, MCP and the CLI cannot disagree; an
  // older server carries neither key, and the cell then says so.
  const cnt = (journey && journey.summary && journey.summary.counts) || {};
  row.called = cnt.called;
  row.declaredNotCalled = cnt.declaredNotCalled;
  // the same numbers typed (docs/COUNTS.md): their words, scope and source travel with them
  row.counted = (journey && journey.summary && journey.summary.counted) || null;
  if (gen !== GEN) return;                  // a walk that outlived its table writes nothing
  ROWS.set(f.nodeId, row);
}

/** Flows grouped by the persona the manifest names, or by their screen ids when it does not. */
function grouped(flows) {
  const byPersona = new Map();
  let derived = false;
  for (const f of flows) {
    let key = f.persona;
    if (!key) {
      // the screen ids of one product area share a prefix (SCR-07, SCR-14c)
      const prefixes = [...new Set((f.screens || []).map((s) => String(s).split('-')[0]).filter(Boolean))];
      key = prefixes.length === 1 ? prefixes[0] : '';
      if (key) derived = true;
    }
    const k = key || t('portfolio.noPersona');
    if (!byPersona.has(k)) byPersona.set(k, []);
    byPersona.get(k).push(f);
  }
  return { groups: [...byPersona.entries()], derived };
}

function render() {
  const flows = FLOWS, surfaces = PRODUCT_SURFACES;
  const body = document.getElementById('pf-body');
  if (!body) return;
  // where a reader starts: of the flows nothing else requires, the one that covers
  // the most of the product — and never one with nothing built behind it, which
  // would open on a journey that cannot be walked
  const entries = flows.filter((f) => !(f.requires || []).length);
  const pinnedId = (entries.filter((f) => (f.built || 0) > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0))[0] || entries[0] || flows[0] || {}).nodeId;
  const { groups, derived } = grouped(flows);
  let html = '';
  if (derived) html += '<p class="set-note">' + esc(t('portfolio.personaDerived')) + '</p>';
  for (const [persona, rows] of groups) {
    html += '<div class="set-sec"><h2>' + esc(persona) + '</h2>'
      + '<table class="src-table pf-table"><thead><tr>'
      // every column header carries its own define, on this page: the operations
      // column's definition used to exist only on the grammar page, three clicks
      // away, and it is the one a reader puts in a deck (visual swarm 2026-09-24)
      + ['flow', 'screens', 'api', 'tested', 'erp', 'owner'].map((c) => '<th' + tipOf('portfolio.col.' + c) + '>' + esc(t('portfolio.col.' + c)) + '</th>').join('')
      + '</tr></thead><tbody>'
      + rows.slice().sort((a, b) => (a.nodeId === pinnedId ? -1 : b.nodeId === pinnedId ? 1 : a.name.localeCompare(b.name)))
        .map((f) => rowHtml(f, f.nodeId === pinnedId)).join('')
      + '</tbody></table></div>';
  }
  if (surfaces.length) {
    html += '<div class="set-sec"><h2>' + esc(t('portfolio.surfaces')) + '</h2><table class="src-table pf-table"><tbody>'
      + surfaces.map((s) => '<tr><td>' + esc(s.name || s.id) + '</td><td>' + esc(statusWord(s.status)) + '</td>'
        + '<td>' + esc(currentLens() === 'business' ? unCode(s.description || '') : (s.description || '')) + '</td></tr>').join('')
      + '</tbody></table></div>';
  }
  body.innerHTML = html;
}

/**
 * A surface's status as a word. A surface nobody has built is *not built* — the
 * absence word for "declared somewhere, no code behind it" — and never
 * "designed, not built", which would claim frames that may not exist. A surface
 * whose status the manifest does not declare says so rather than being guessed.
 */
function statusWord(status) {
  if (status === 'built') return t('journey.status.built');
  if (status === 'partly built') return t('journey.status.partly').replace(' · {n} of {m}', '');
  if (status === 'not started') return t('journey.absent.notBuilt');
  return t('portfolio.notDeclared');
}

function rowHtml(f, pinned) {
  const row = ROWS.get(f.nodeId) || {};
  const built = f.built != null ? f.built : 0;
  const total = f.total != null ? f.total : (f.screens || []).length;
  const key = total > 0 && built >= total ? 'journey.status.built'
    : built > 0 ? 'journey.status.partly' : 'journey.status.designedNotBuilt';
  const status = t(key).replace('{n}', built).replace('{m}', total);
  return '<tr' + (pinned ? ' class="pinned"' : '') + '>'
    + '<td><a href="#/journeys/' + encodeURIComponent(f.nodeId) + '">' + esc(f.name) + '</a>'
    + (pinned ? ' <span class="pf-pin">' + esc(t('portfolio.pinned')) + '</span>' : '') + flowChipHtml(row.work) + '</td>'
    + '<td>' + builtHtml(row, status, built, total) + '</td>'
    + '<td>' + opsCell(row) + '</td>'
    + '<td>' + testedCell(row) + '</td>'
    + '<td>' + erpCell(row) + '</td>'
    + '<td class="dim">' + esc(f.owner || t('portfolio.notDeclared')) + '</td>'
    + '</tr>';
}

/**
 * The screens cell: the status word, and a tip that says what the two numbers
 * count and over what — the journey's typed `built` once it has arrived (the
 * same number the journey header prints), the design rows' until then.
 */
function builtHtml(row, status, built, total) {
  const c = row.counted && row.counted.built;
  const attrs = c ? countedHtml(c, '/api/journey', { words: status })
    : '<span' + plainTip(built, 'journey.biz.countBuilt', 'journey.scopeAll', '/api/design', null, 'journey.status.partly', { m: total }) + '>' + esc(status) + '</span>';
  return attrs;
}

/**
 * What the flow's code calls, and what is declared and not called. Read from the
 * journey fold, because a manifest's flow-level `operations` list is empty on
 * most flows and would answer with a confident nothing.
 *
 * *Called* means code performs the call. An action whose call step is the
 * contract-derived continuation of a declared route performs nothing, and joins
 * the operations a screen's manifest lists that no action made at all — both are
 * *declared, not called*. When nothing is called and something is declared, the
 * cell says **not built**: the absence word for "declared somewhere, no code
 * behind it". Only when neither is true is there nothing indexed to speak of.
 */
function opsCell(row) {
  if (row.called == null) return '<span class="dim">' + esc(t('portfolio.loading')) + '</span>';
  const only = row.declaredNotCalled != null ? row.declaredNotCalled : (row.declaredOnly || []).length;
  // one number, one wording: the journey header prints this same count under
  // this same key, so a reader moving between the two surfaces cannot meet two
  // words for one fact (the retired `portfolio.opsDeclaredOnly` was the second)
  // the typed counts carry the words the journey header prints for the same numbers
  const k = row.counted || {};
  const sub = only ? '<span class="pf-sub">' + (k.declaredNotCalled ? countedHtml(k.declaredNotCalled, '/api/journey')
    : '<span' + plainTip(only, 'journey.countDeclaredOnly', 'journey.scopeAll', '/api/journey') + '>'
      + esc(t('journey.countDeclaredOnly').replace('{n}', String(only))) + '</span>') + '</span>' : '';
  if (!row.called) {
    const word = only ? 'journey.absent.notBuilt' : 'journey.absent.noneIndexed';
    return '<span class="dim"' + tipOf(word) + '>' + esc(t(word)) + '</span>' + sub;
  }
  return (k.actions ? countedHtml(k.actions, '/api/journey')
    : '<span' + plainTip(row.called, 'portfolio.opsCalled', 'journey.scopeAll', '/api/journey') + '>'
      + esc(t('portfolio.opsCalled').replace('{n}', String(row.called))) + '</span>') + sub;
}

// the chip's class per evidence class; its tip is the word's define (tipOf)
const EV_CLS = {
  observed: 'jrn-mk cov ev-observed', // str:ok — class names
  stale: 'jrn-mk cov ev-stale', // str:ok — class names
  reached: 'jrn-mk cov ev-reached', // str:ok — class names
  declared: 'jrn-mk cov ev-declared', // str:ok — class names
};

/**
 * What proves the flow runs. One chip, from the strongest evidence class the
 * fold found — and never a claim the flow cannot earn: where the fold reports
 * `sharedEvidence` (the design declares screens and code implements none of
 * them) every covering test reached code this flow shares with others, so the
 * cell prints the absence word **not built** and says whose evidence it is
 * (swarm 2026-09-23, blocker 2). A chip a flow *has* earned is never weakened.
 *
 * The counts underneath name each level separately — folding integration cases
 * into "unit" is the fault that put `270 unit` under `252 unit` (blocker 5).
 */
function testedCell(row) {
  if (!row.coverage) return '<span class="dim">' + esc(t('portfolio.loading')) + '</span>';
  const c = row.coverage;
  const counts = c.counts && c.counts.tests ? c.counts.tests : null;
  const levels = testCountsHtml(c, counts);
  const chip = c.chip && c.chip !== 'none' ? c.chip : null;
  if (!chip) return '<span class="dim"' + tipOf('journey.absent.noneIndexed') + '>' + esc(t('journey.absent.noneIndexed')) + '</span>';
  if (c.sharedEvidence) {
    return '<span class="dim"' + tipOf('journey.absent.notBuilt') + '>' + esc(t('journey.absent.notBuilt')) + '</span>'
      + '<span class="pf-sub"' + tipOf('journey.evidenceShared') + '>' + esc(t('journey.evidenceShared')) + '</span>'
      + levels;
  }
  // the word comes from the fold, not from this cell: an observed class carried
  // only by coverage reports says *seen by a coverage run*, which is what the
  // Tests tab has always said and what this cell used to contradict on eight of
  // ten flows (visual swarm 2026-09-24, and the acceptance's ranked item 3)
  const ev = evidenceWord(c);
  const cls = ev.cls;
  return '<span class="' + EV_CLS[cls] + '"' + tipOf(ev.key) + '>'
    + (cls === 'observed' ? sym('live') : cls === 'stale' ? sym('stale') : '') + esc(t(ev.key)) + '</span>'
    + levels;
}

/**
 * The tests under the chip, from the fold's typed counts: every level named
 * apart (integration is never folded into unit), each with its tip — its scope
 * is *across this journey*, and its breakdown is the three evidence classes, so
 * `80 e2e` travels with how many of them were seen in a run. The business lens
 * prints the counts that have business words: the tests, and the end-to-end ones.
 */
function testCountsHtml(c, counts) {
  const k = c.counted;
  const api = '/api/tests';
  if (k && k.e2e) {
    const biz = currentLens() === 'business';
    const parts = (biz ? [k.tests, k.e2e] : [k.e2e, k.unit, k.integration]).filter(Boolean).map((x) => countedHtml(x, api)).filter(Boolean);
    const rows = (k.e2e.breakdown || []).map((p) => [countWords(p.key, p.n).replace(String(p.n), '').trim(), p.n]);
    const seen = k.e2e.breakdown && k.e2e.breakdown.find((p) => p.key === 'count.part.observed');
    // an end-to-end case the report says passed, which declares something on this
    // journey: observed by its own declaration, said as that — `0 seen in a run`
    // alone read as a contradiction of the Tests card's `89 passed` (story swarm 2026-09-25)
    const decl = k.e2e.breakdown && k.e2e.breakdown.find((p) => p.key === 'count.part.declaredPassed');
    const declHtml = decl && decl.n ? '<span class="pf-sub"' + plainTip(decl.n, 'surf.e2ePassedDeclared', 'journey.scopeAll', api, rows, 'count.part.declaredPassed') + '>'
      + esc(countWords('surf.e2ePassedDeclared', decl.n)) + '</span>' : '';
    const seenHtml = seen && (seen.n || !declHtml) ? '<span class="pf-sub"' + plainTip(seen.n, 'surf.e2eSeen', 'journey.scopeAll', api,
      rows, 'count.part.observed') + '>'
      + esc(countWords('surf.e2eSeen', seen.n)) + '</span>' : '';
    return '<span class="pf-sub">' + parts.join(' · ') + '</span>' + declHtml + seenHtml;
  }
  return counts ? '<span class="pf-sub">' + esc(t('journey.testsE2e').replace('{n}', counts.e2e || 0)) + ' · '
    + esc(t('journey.testsUnit').replace('{n}', counts.unit || 0)) + ' · '
    + esc(t('journey.testsIntegration').replace('{n}', counts.integration || 0)) + '</span>' : '';
}

function erpCell(row) {
  if (row.erp === undefined) return '<span class="dim">' + esc(t('portfolio.loading')) + '</span>';
  if (row.erp) return esc(t('portfolio.erpYes').replace('{via}', row.erp.label));
  // nothing is built, so the walk reaches nothing: that is "not built", not a
  // statement that the design has no hand-off
  if (row.flow && !(row.flow.built || 0)) return '<span class="dim"' + tipOf('journey.status.notBuilt') + '>' + esc(t('journey.status.notBuilt')) + '</span>';
  // the spec declares an approval the code has not built: that is the hand-off, unbuilt
  const approval = (row.declaredOnly || []).find((d) => /approve|post|sync/i.test(d.op || ''));
  if (approval) return '<span class="warn">' + esc(t('portfolio.erpDeclared')) + '</span>';
  return '<span class="dim"' + tipOf('journey.absent.notInvolved') + '>' + esc(t('journey.absent.notInvolved')) + '</span>';
}

expose({ mountPortfolio });
