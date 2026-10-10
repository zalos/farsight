// impact.js — change impact: what uses this, by distance and never summed
// (docs/proposals/dependency-impact.md §4). One fold on the server
// (`/api/impact`), drawn here as the drawer (`b` from a card, a deep link, a
// row inside another answer) and, through the journey inspector's IMPACT tab,
// as a panel beside the step it belongs to.
//
// Three rules this module exists to keep:
//   - **no total**: the report carries none, and nothing here adds two hops;
//   - **reachability is not consequence**: every line keeps the edge's own
//     verb, and no word here says a change travels;
//   - **every count is a floor** while anything was cut, capped, unrecorded or
//     resolved at run time — and the bound reaches the business register too,
//     as a sentence rather than as a chip a stakeholder cannot read.

import { S, expose, esc, bizName, currentLens } from './store.js';
import { t, def } from './strings.js';
import { sym } from './sym.js';
import { vsl, kindWord } from './lib/graph-render.js';
import { tipAttrs } from './lib/tooltip.js';
import { defAttrs, plainTip, countKey } from './lib/counted.js';
import { scopeWordHtml } from './lib/test-chip.js';

/** A tip-bearing span for a catalog word (its define and its Grammar Book entry). @group Change impact */
function impTip(key) { return '<span class="imp-tip"' + (def(key) ? defAttrs(key) : '') + '>'; }

/** Default distance. Two is the question ("what uses it, and what uses those"); more is asked for. */
const IMP_HOPS = 2;
/** What the fold refuses past — printed, never silently clamped. */
const IMP_MAX_HOPS = 5;
/** Dependents drawn per hop before the rest fold behind a "+n" line. */
const IMP_PER_HOP = 14;

// attribute openers written out whole: an attribute assembled from pieces
// reads as prose to the string lint (RULE 1), as in surfaces/portfolio.js
const IMP_ROW = '<li class="imp-row"><a href="#" onclick="return impactGo(this)" data-node="';
const IMP_CUTROW = '<li class="imp-row cut"><a href="#" onclick="return impactGo(this)" data-node="';
const IMP_RINGLEG = '<li class="imp-leg-';

/**
 * Every answer this session has asked for, keyed by node + budget. An entry is
 * `{state, report}` with state `loading | ok | none | off | error`: `none`
 * means the fold answered and nothing uses it, `off` means this server has no
 * `/api/impact` at all. The distinction matters — one is a fact about the
 * code, the other about the build.
 * @group Change impact
 */
const IMP_CACHE = new Map();
const impKey = (id, o) => id + '|' + (o.hops || IMP_HOPS) + (o.flows ? '|f' : '');

/** The cached answer for a node at a budget, or null when none was asked for yet.
 * @group Change impact */
export function impactCached(id, opts) {
  return IMP_CACHE.get(impKey(id, opts || impactOpts())) || null;
}

/**
 * Whether a node has an impact answer with something in it. The IMPACT tab
 * appears only when this is true: a tab that opens on "nothing" teaches a
 * reader to stop opening it.
 * @group Change impact
 */
export function impactHasHops(id) {
  const e = impactCached(id);
  return !!(e && e.state === 'ok' && e.report.hops.length);
}

/**
 * The options the open register asks for. The business sentence is built from
 * journeys, and journeys cost one walk per flow — so only that register asks
 * for them, and no surface asks for them by default.
 * @group Change impact
 */
export function impactOpts(hops) {
  return { hops: hops || S.impactHops || IMP_HOPS, tests: true, flows: currentLens() === 'business' };
}

/**
 * Ask the server what uses a node. Cached per node and budget, deduplicated
 * while in flight, and fail-soft in the two ways that differ: a 404 before
 * anything has ever answered closes the door on this build (`off`), any other
 * failure is an error about this answer.
 * @group Change impact
 */
export function impactFetch(id, opts, done) {
  const o = opts || impactOpts();
  const key = impKey(id, o);
  const hit = IMP_CACHE.get(key);
  if (hit) { if (hit.state !== 'loading' && done) done(hit); return hit; }
  const entry = { state: 'loading', report: null };
  IMP_CACHE.set(key, entry);
  const q = '?node=' + encodeURIComponent(id) + '&hops=' + (o.hops || IMP_HOPS)
    + (o.tests ? '&tests=1' : '') + (o.flows ? '&flows=1' : '');
  fetch('/api/impact' + q).then((r) => {
    if (r.status === 404 && !S.impactHasEndpoint) { entry.state = 'off'; return null; }
    if (!r.ok) { entry.state = 'error'; return null; }
    S.impactHasEndpoint = true;
    return r.json();
  }).then((rep) => {
    if (rep) { entry.report = rep; entry.state = rep.hops && rep.hops.length ? 'ok' : 'none'; }
    if (done) done(entry);
  }).catch(() => { entry.state = 'error'; if (done) done(entry); });
  return entry;
}

/**
 * The ring one hop past the budget, counted once as a set — a second walk, not
 * a sum of the cut points' `behind` counts, which overlap by design. The same
 * number the command line prints under the same words.
 * @group Change impact
 */
function impactRing(id, hops, done) {
  if (hops >= IMP_MAX_HOPS) return null;
  const key = 'ring|' + id + '|' + hops;
  const hit = IMP_CACHE.get(key);
  if (hit) return hit.n;
  IMP_CACHE.set(key, { n: null });
  fetch('/api/impact?node=' + encodeURIComponent(id) + '&hops=' + (hops + 1)).then((r) => r.ok ? r.json() : null).then((rep) => {
    const h = rep && rep.hops && rep.hops[hops];
    IMP_CACHE.set(key, { n: h ? h.found : null });
    if (done && h) done();
  }).catch(() => {});
  return null;
}

// ── what a row says ─────────────────────────────────────────────
/**
 * The edge's own provenance, then the path's silences. Never one ladder: an
 * unrecorded edge is not a weak one, it is an edge whose technique nobody
 * wrote down (§10.2).
 * @group Change impact
 */
function impHowHtml(n) {
  const r = n.via.resolution;
  const head = r ? esc(r.technique + ' ' + r.confidence) : esc(t('impact.notRecorded'));
  const parts = [impTip(r ? 'impact.strength' : 'impact.notRecorded') + head + '</span>'];
  if (n.hop > 1 && n.strength.unstamped) {
    parts.push(esc(t('impact.strength').replace('{tier}', n.strength.tier || t('impact.notRecorded')).replace('{n}', n.strength.unstamped)));
  }
  if (n.oneOf) {
    parts.push(impTip('impact.oneOf')
      + esc(t('impact.oneOf').replace('{chosen}', n.oneOf.chosen.split('::').pop()).replace('{n}', n.oneOf.alternatives.length)) + '</span>');
  }
  if (n.shared) parts.push(esc(t('impact.sharedHere')));
  if (n.declaredOnly) parts.push(esc(t('journey.absent.notBuilt')));
  if (n.via.kind === 'http' || n.kind === 'external') {
    parts.push(impTip('impact.external') + esc(t('impact.external')) + '</span>');
  }
  return parts.join(' · ');
}

/** One dependent: the edge's verb, the name, where it is (⧉ into the editor) and how it was resolved.
 * @group Change impact */
function impNodeHtml(n) {
  const loc = n.via.loc || n.loc;
  return IMP_ROW + esc(n.nodeId) + '">'
    + '<span class="k">' + esc(n.via.kind) + '</span>'
    + '<span class="nm">' + esc(n.name) + '</span>'
    + (loc ? '<span class="loc">' + esc(loc.path + ':' + loc.line) + '</span>' : '')
    + '</a>' + (loc ? vsl(n.repo, loc.path, loc.line) : '')
    + '<span class="how">' + impHowHtml(n) + '</span></li>';
}

/**
 * The tests that reach everything listed from hop 1 up to `upto`, each test
 * once — the union of the covering sets. The browser's copy of core
 * `impactTestsReaching()` (packages/server/test/impact-view.test.ts holds the
 * two to one answer): it can only stay level or grow from one distance to the
 * next, which is what *so far* promises.
 *
 * It used to share one `seen` set across the hops it was called for, so each
 * hop printed only the tests new at that distance under a label that said
 * *everything listed so far* — 1 · 8 · 42 · 22 where the union is 1 · 9 · 51 ·
 * 73 (story swarm 2026-09-25: "a value so far cannot go down").
 * @group Change impact
 */
export function impTestsReaching(report, upto) {
  const seen = new Map();
  for (const h of report.hops) {
    if (h.hop > upto) break;
    for (const n of h.nodes) for (const x of (n.tests || [])) if (!seen.has(x.id)) seen.set(x.id, x);
  }
  const byLevel = {};
  for (const x of seen.values()) byLevel[x.level] = (byLevel[x.level] || 0) + 1;
  return { upto, total: seen.size, byLevel };
}

/**
 * The line under each hop: the tests reaching everything listed up to it, each
 * once — the same set under the same words as the command line and the agent
 * surface, because one reader meets all three.
 * @group Change impact
 */
function impTestsHtml(report, upto) {
  const r = impTestsReaching(report, upto);
  const levels = Object.keys(r.byLevel).sort();
  const list = levels.map((k) => r.byLevel[k] + ' ' + t('tests.level.' + k)).join(' · ');
  const key = upto === 1 ? 'impact.testsDirect' : 'impact.testsSoFar';
  const scope = upto === 1 ? 'surf.scope.hop1' : 'surf.scope.hopsSoFar';
  // a test number with its scope on the chip (round 2026-10-10): impact's *2 tests* beside a screen's *323 cases*
  // reads as two scopes — the tests among what uses it, never the screen's own
  return '<div class="imp-tests" data-tchip data-scope="' + esc(scope) + '"><span class="cnt-n"' + plainTip(r.total, 'surf.impact.tests', scope, '/api/impact',
    levels.map((k) => [t('tests.level.' + k), r.byLevel[k]]), key) + '>' + esc(t('surf.impact.tests').replace('{n}', String(r.total))) + '</span>'
    + '<span class="tc-sep"> · </span>' + scopeWordHtml(scope)
    + (list ? '<span class="tc-sep"> · </span>' + esc(list) : '') + '</div>';
}

/** One hop: its head with what it holds by kind, then its dependents.
 * @group Change impact */
function impHopHtml(report, h) {
  const head = h.hop === 1 ? t('impact.hop1') : h.hop === 2 ? t('impact.hop2') : t('impact.hopN').replace('{n}', h.hop - 1);
  const kinds = Object.keys(h.byKind).sort((a, b) => h.byKind[b] - h.byKind[a]).map((k) => h.byKind[k] + ' ' + k).join(' · ');
  const shown = h.nodes.slice(0, IMP_PER_HOP);
  const more = h.nodes.length > shown.length
    ? '<li class="more">' + esc(t('journey.moreChips').replace('{n}', h.nodes.length - shown.length)) + '</li>' : '';
  // found · listed · behind are three numbers; a capped hop prints all three
  const capped = h.found > h.nodes.length
    ? '<div class="imp-note">' + esc(t('impact.cut.cap').replace('{n}', h.found - h.nodes.length)) + '</div>' : '';
  return '<div class="imp-hop"><div class="imp-hophead"><span class="hud-label">' + esc(head) + '</span>'
    + '<span class="cnt"' + plainTip(h.found, 'surf.impact.found', 'surf.scope.hop', '/api/impact',
      Object.keys(h.byKind).sort((a, b) => h.byKind[b] - h.byKind[a]).map((k) => [k, h.byKind[k]])) + '>' + esc(h.found + (kinds ? ' · ' + kinds : '')) + '</span></div>'
    + '<ul class="imp-list" role="list">' + shown.map(impNodeHtml).join('') + more + '</ul>'
    + capped + impTestsHtml(report, h.hop) + '</div>';
}

/**
 * What the answer did not walk. Each line says how much stands behind *that*
 * stop; two stops routinely sit in front of the same things, so the numbers are
 * never added and this section never carries a sum. A shared helper prints both
 * of its numbers under their own words — how many use it, and how much is
 * behind it.
 * @group Change impact
 */
function impNotWalkedHtml(report, redraw) {
  const rows = [];
  const hopCuts = report.cutPoints.filter((c) => c.reason === 'hops');
  if (hopCuts.length) {
    const budget = report.hops.length;
    const ring = impactRing(report.seed.id, budget, redraw);
    rows.push('<li class="imp-row"><span class="nm">' + esc(ring != null
      ? t('impact.cut.hops').replace('{n}', ring).replace('{h}', budget).replace('{stops}', hopCuts.length)
      : t('impact.cut.hopsOnly').replace('{n}', hopCuts.length).replace('{max}', IMP_MAX_HOPS)) + '</span></li>');
  }
  for (const c of report.cutPoints.filter((x) => x.reason === 'shared')) {
    rows.push(IMP_CUTROW + esc(c.nodeId || '') + '"><span class="nm">'
      + esc(t('impact.cut.shared').replace('{name}', c.name || '').replace('{n}', c.direct)) + '</span>'
      + '<span class="loc">' + esc(t('impact.behind').replace('{n}', c.behind)) + '</span></a></li>');
  }
  for (const c of report.cutPoints.filter((x) => x.reason === 'cap')) {
    rows.push('<li class="imp-row"><span class="nm">' + esc(t('impact.cut.cap').replace('{n}', c.behind)) + '</span></li>');
  }
  for (const n of report.excluded.setup) {
    rows.push(IMP_CUTROW + esc(n.nodeId) + '"><span class="k">' + esc(t('impact.excluded.setup')) + '</span><span class="nm">' + esc(n.name) + '</span></a></li>');
  }
  for (const n of report.excluded.deferred) {
    rows.push(IMP_CUTROW + esc(n.nodeId) + '"><span class="k">' + esc(t('impact.excluded.deferred')) + '</span><span class="nm">' + esc(n.name) + '</span></a></li>');
  }
  if (!rows.length) return '';
  return '<div class="imp-hop imp-notwalked"><div class="imp-hophead"><span class="hud-label">' + esc(t('impact.notWalked'))
    + '</span>' + impTip('impact.notWalked') + sym('absent') + '</span></div>'
    + '<ul class="imp-list" role="list">' + rows.join('') + '</ul></div>';
}

/** The legend for the sheet's rings — shape, not colour, so it reads the same in grey.
 * @group Change impact */
function impRingsLegendHtml() {
  return '<ul class="imp-legend" role="list">'
    + IMP_RINGLEG + 'seed">' + esc(t('impact.seedRing')) + '</li>'
    + IMP_RINGLEG + '1">' + esc(t('impact.ring.direct')) + '</li>'
    + IMP_RINGLEG + 'n">' + esc(t('impact.ring.through')) + '</li>'
    + IMP_RINGLEG + 'cut">' + esc(t('impact.ring.behind')) + '</li>'
    + IMP_RINGLEG + 'stop">' + esc(t('impact.ring.stop')) + '</li></ul>';
}

// ── the business register: one sentence, its because, its bound ──
/** The journeys an answer's direct users appear in, and how many distinct actions inside them.
 * @group Change impact */
function impFlowFacts(report) {
  const flows = new Map();
  const actions = new Set();
  const first = report.hops[0];
  for (const n of (first ? first.nodes : [])) {
    for (const f of (n.flows || [])) {
      flows.set(f.flowId, f.name);
      for (const a of f.actions) actions.add(f.flowId + '|' + a.screen + '|' + a.rank);
    }
  }
  const total = ((S.GRAPH && S.GRAPH.nodes) || []).filter((n) => n.kind === 'flow').length;
  return { flows, actions: actions.size, total: total || flows.size };
}

/**
 * The tests behind the sentence: how many reach the things that use this
 * directly, and how many only reach the things that use *those*. The nearest
 * evidence being one distance further out is the half a business reader can
 * act on, so it is the clause the sentence carries.
 * @group Change impact
 */
function impTestFacts(report) {
  const seen = new Set();
  let direct = 0, near = 0, e2e = 0;
  report.hops.forEach((h) => {
    for (const n of h.nodes) {
      for (const x of (n.tests || [])) {
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        if (h.hop === 1) direct++; else near++;
        if (x.level === 'e2e') e2e++;
      }
    }
  });
  return { direct, near, e2e };
}

/** A count's words in the register on screen, in agreement with the count: `{key}One` when it is one.
 * @group Change impact */
function bizCount(key, n, vars) {
  let s = t(countKey(key, n)).split('{n}').join(String(n));
  for (const [k, v] of Object.entries(vars || {})) s = s.split('{' + k + '}').join(String(v));
  return s;
}

/**
 * The business sentence's first half, built from parts that each agree with
 * their own count — *1 thing uses*, *1 action*, *1 of 10 journeys* — because a
 * plural beside a 1 invites doubt about every other number on the line (story
 * swarm 2026-09-25). `flows` is `{ flows: Map, actions, total }`, or null when
 * no journey reaches it.
 * @group Change impact
 * @business Says how many things use this and in how many of the product's journeys, in words that agree with the numbers.
 */
export function impactBizLine(direct, subject, flows) {
  const uses = bizCount('impact.biz.uses', direct, { subject });
  if (!flows) return t('impact.biz.lineNoFlow').split('{uses}').join(uses);
  const n = flows.flows.size;
  const journeys = flows.total === 1 && n === 1 ? t('impact.biz.journeysOnly')
    : bizCount('impact.biz.journeysOf', n, { m: flows.total });
  return t('impact.biz.line').split('{uses}').join(uses)
    .split('{actions}').join(bizCount('impact.biz.actions', flows.actions))
    .split('{journeys}').join(journeys);
}

/**
 * The business sentence: how many things use it, where that shows up for a
 * person, why the evidence is what it is, and that the number is the fewest it
 * could be rather than the whole.
 *
 * No identifier (the subject is the node's own label), no file, no arithmetic
 * in distances. Built from the same report the other registers read, so the
 * registers cannot disagree.
 * @group Change impact
 * @business Says in one sentence what uses this, where a person would see it, and what would catch a change.
 */
export function impactBizHtml(report) {
  const direct = report.hops[0] ? report.hops[0].found : 0;
  const node = S.BYID[report.seed.id];
  const subject = node ? bizName(node) : report.seed.name;
  const f = impFlowFacts(report);
  const tests = impTestFacts(report);
  const line = impactBizLine(direct, subject, f.flows.size ? f : null);
  const because = tests.direct ? bizCount('impact.biz.evidence.direct', tests.direct)
    : tests.near ? bizCount('impact.biz.evidence.near', tests.near)
    : t('impact.biz.evidence.none');
  const why = [];
  if (report.cutPoints.length) why.push(t('impact.biz.why.cut'));
  if (report.hops.some((h) => h.nodes.some((n) => n.oneOf))) why.push(t('impact.biz.why.runtime'));
  if (report.hops.some((h) => h.nodes.some((n) => !n.via.resolution || n.strength.unstamped))) why.push(t('impact.biz.why.unrecorded'));
  const floor = report.bound === 'floor' && why.length
    ? '<p class="imp-floor">' + esc(t('impact.biz.floor').replace('{why}', why.join('; '))) + '</p>' : '';
  const flows = f.flows.size
    ? '<div class="imp-hop"><div class="imp-hophead"><span class="hud-label">' + esc(t('impact.biz.journeys')) + '</span></div>'
      + '<ul class="imp-list biz" role="list">' + [...f.flows.entries()].map(([id, name]) =>
        IMP_ROW + esc(id) + '"><span class="nm">' + esc(name) + '</span></a></li>').join('') + '</ul></div>'
    : '<p class="imp-floor">' + esc(t('journey.absent.notInvolved')) + '</p>';
  // the sentence's numbers, each named with what it counts: a sentence cannot carry a tip per number
  const facts = tipAttrs({ id: 'table', args: { caption: 'surf.impact.facts', rows: [
    [t('surf.impact.direct').replace('{n}', '').trim(), direct],
    [t('surf.impact.journeys').replace('{n}', '').trim(), f.flows.size],
    [t('surf.impact.testsNear').replace('{n}', '').trim(), tests.direct],
    [t('surf.impact.testsFar').replace('{n}', '').trim(), tests.near],
  ] } });
  return '<p class="imp-biz"' + facts + '>' + esc(line) + ' ' + esc(because)
    + (tests.e2e ? '' : ' ' + esc(t('impact.biz.noE2e'))) + '</p>'
    + floor + flows
    + (impactRingsDrawn() ? '<p class="imp-floor">' + esc(t('impact.biz.rings')) + '</p>' : '');
}

// ── the distance control ─────────────────────────────────────────
/** The redraw of whichever surface drew the body last — the drawer or the journey's IMPACT tab. */
let IMP_REDRAW = null;

/**
 * How far the answer walks, 1 to `IMP_MAX_HOPS`, as a row of buttons with the
 * current one pressed. The choice lives in `S.impactHops` and rides in the link
 * (`?impact=<id>&hops=N`), so a copied link opens on the same answer; before
 * this the only way to see four hops was to edit the URL (story swarm
 * 2026-09-25). The business register has no control: it counts no distances.
 * @group Change impact
 */
function impHopCtlHtml(seedId) {
  const cur = S.impactHops || IMP_HOPS;
  let html = '<div class="imp-hopctl" role="group" aria-label="' + esc(t('impact.hops.label')) + '">'
    + '<span class="hud-label"' + defAttrs('impact.hops.label') + '>' + esc(t('impact.hops.label')) + '</span>';
  for (let h = 1; h <= IMP_MAX_HOPS; h++) {
    html += '<button type="button" data-hops="' + h + '" data-node="' + esc(seedId) + '" aria-pressed="' + (h === cur) + '"'
      + ' aria-label="' + esc(t(countKey('impact.hops.button', h)).replace('{n}', h)) + '" onclick="return impactSetHops(this)">' + h + '</button>';
  }
  return html + '</div>';
}

/**
 * Ask again at another distance: the choice is remembered, written into the
 * link, and the surface that drew the panel redraws once the answer lands — not
 * before, so the journey's IMPACT tab does not blink away while it loads.
 * @group Change impact
 * @business Changes how far out the "what uses this" answer looks.
 */
export function impactSetHops(el) {
  const h = el && el.dataset ? Number(el.dataset.hops) : NaN;
  const id = el && el.dataset ? el.dataset.node : '';
  if (!id || !Number.isInteger(h) || h < 1 || h > IMP_MAX_HOPS) return false;
  S.impactHops = h;
  impactHash(id);
  const redraw = IMP_REDRAW;
  impactFetch(id, impactOpts(), (e) => {
    if ((S.impactHops || IMP_HOPS) !== h) return;
    impactRings(e);
    if (redraw) redraw();
  });
  return false;
}

// ── the panel ───────────────────────────────────────────────────
/**
 * The whole answer for one node, in the register the reader chose. Business
 * gets the sentence, its because clause, its floor and the journeys — no
 * identifiers, no files, no distances counted out loud. The other registers get
 * the clauses, the bound with its reason, every hop with its evidence and the
 * list of what was not walked.
 * @group Change impact
 */
export function impactBodyHtml(entry, redraw) {
  IMP_REDRAW = redraw || null;
  if (!entry || entry.state === 'loading') return '<p class="ph-body">' + esc(t('impact.reading')) + '</p>';
  if (entry.state === 'off') return '<p class="ph-body">' + esc(t('impact.unavailable')) + '</p>';
  if (entry.state === 'error') return '<p class="ph-body">' + esc(t("sys.impactFailed")) + '</p>';
  if (entry.state === 'none') return '<p class="ph-body">' + esc(t('impact.none')) + '</p>';
  const r = entry.report;
  // the scope first, as the journey's tests feet print theirs: three numbers on one
  // step (verified-by, the foot, this panel) are three scopes, each named
  const scope = impScopeHtml();
  if (currentLens() === 'business') return scope + impactBizHtml(r);
  const clauses = r.hops.map((h) => h.hop === 1 ? t('impact.clause.direct').replace('{n}', h.found)
    : h.hop === 2 ? t('impact.clause.through').replace('{n}', h.found)
    : t('impact.clause.far').replace('{n}', h.found).replace('{h}', h.hop));
  const asOf = [r.asOf.sync != null ? t('chrome.sync') + ' ' + r.asOf.sync : null, r.asOf.commit ? r.asOf.commit.slice(0, 7) : null].filter(Boolean).join(' · ');
  return scope + '<div class="imp-head-line">' + impTip('impact.notASum') + esc(clauses.join(' · ')) + '</span>'
    + '<span class="sub">' + esc(t('impact.notASum')) + '</span></div>'
    + '<p class="imp-bound">' + esc(r.bound === 'floor'
      ? t('impact.bound.floor').replace('{why}', (r.uncertainty && r.uncertainty.note) || '')
      : t('impact.bound.exact')) + '</p>'
    + (asOf ? '<p class="imp-asof">' + esc(asOf) + '</p>' : '')
    + impHopCtlHtml(r.seed.id)
    + r.hops.map((h) => impHopHtml(r, h)).join('')
    + impNotWalkedHtml(r, redraw)
    + (impactRingsDrawn() ? impRingsLegendHtml() : '');
}

/**
 * The label naming what this panel's numbers count over, in front of them —
 * the same manner as a journey tests foot's `IN THIS ACTION` / `FOR THIS PART
 * ALONE` (`jrnFootScopeHtml`), with the define as its tip.
 * @group Change impact
 */
function impScopeHtml() {
  return '<div class="imp-scope"><span class="hud-label" data-scope="impact.scope"' + defAttrs('impact.scope') + '>' + esc(t('impact.scope')) + '</span></div>';
}

/** The panel's head: the node the question was asked on, and the question itself.
 * @group Change impact */
function impHeadHtml(node, id) {
  // the business lens names the part by its business name and its kind in words
  const name = node ? (currentLens() === 'code' ? node.name : bizName(node)) : id;
  return '<div class="imp-node">' + (node ? '<span class="kind k-' + esc(node.kind) + '">' + esc(kindWord(node.kind)) + '</span> ' : '')
    + esc(name) + '</div>'
    + '<p class="imp-q">' + esc(t('impact.of').replace('{name}', name)) + '</p>';
}

/**
 * Open the change-impact drawer on a node — the panel `b` opens from a card,
 * that a deep link names (`?impact=<id>&hops=N`), and that a row inside another
 * answer walks outward into. Asks the server, draws what comes back, and rings
 * the journey's sheet while it is open.
 * @group Change impact
 * @business Opens the panel that says what uses the selected thing.
 */
export function openImpact(id) {
  const panel = document.getElementById('impact');
  if (!panel) return;
  const node = id && S.BYID[id];
  const draw = (entry) => {
    panel.innerHTML = '<div class="imp-head"><span class="hud-label">' + esc(t('impact.title'))
      + '</span><button class="x" onclick="closeImpact()" aria-label="Close">✕</button></div>'
      + (id ? impHeadHtml(node, id) : '')
      + (id ? impactBodyHtml(entry, () => openImpact(id)) : '<p class="ph-body">' + esc(t('impact.nothingSelected')) + '</p>');
  };
  panel.classList.add('open');
  if (!id) { draw(null); return; }
  S.impactSeed = id;
  impactHash(id);
  const entry = impactFetch(id, impactOpts(), (e) => { if (S.impactSeed === id) { impactRings(e); draw(e); } });
  impactRings(entry);
  draw(entry);
}

/** Close the change-impact panel, clear the rings and take the seed out of the URL.
 * @group Change impact */
export function closeImpact() {
  const panel = document.getElementById('impact');
  if (panel) panel.classList.remove('open');
  S.impactSeed = null;
  S.IMPACT_RINGS = null;
  if (window.jrnImpactRings) window.jrnImpactRings();
  impactHash(null);
}

/** Whether the impact panel is open (Esc routing).
 * @group Change impact */
export function impactOpen() {
  const panel = document.getElementById('impact');
  return !!panel && panel.classList.contains('open');
}

/**
 * Follow a row: inside a journey, a dependent that is on the walk is selected
 * there (its folds opening above it); anything else re-seeds this panel on the
 * node that was clicked, so walking outward is the same gesture every time.
 * @group Change impact
 */
export function impactGo(el) {
  const id = el && el.dataset ? el.dataset.node : null;
  if (!id) return false;
  if (window.jrnStepOf && window.jrnScrollTo) {
    const order = window.jrnStepOf(id);
    if (order != null && order >= 0) { window.jrnScrollTo(order); return false; }
  }
  openImpact(id);
  return false;
}

// ── the rings on the sheet ──────────────────────────────────────
/** Whether the journey on screen actually drew rings — the storyboard has no
 * markers to ring and the drill draws one action at a time, so neither the
 * legend nor the business sentence may promise them.
 * @group Change impact */
export function impactRingsDrawn() {
  return !!(S.IMPACT_RINGS && S.IMPACT_RINGS.drawn);
}

/**
 * Hand the journey what it needs to ring its cells: the seed, each listed
 * node's distance, and the nodes the walk stopped at. Shape carries the meaning
 * (solid · dashed · dotted), so the rings survive a greyscale print.
 * @group Change impact
 */
export function impactRings(entry) {
  if (!entry || entry.state !== 'ok') S.IMPACT_RINGS = null;
  else {
    const hop = {};
    entry.report.hops.forEach((h) => h.nodes.forEach((n) => { if (hop[n.nodeId] == null) hop[n.nodeId] = h.hop; }));
    const cut = new Set();
    entry.report.cutPoints.forEach((c) => { if (c.nodeId) cut.add(c.nodeId); });
    entry.report.excluded.setup.concat(entry.report.excluded.deferred).forEach((n) => cut.add(n.nodeId));
    const first = entry.report.hops[0];
    S.IMPACT_RINGS = {
      seed: entry.report.seed.id,
      hop,
      cut,
      direct: first ? first.found : 0,
      through: entry.report.hops[1] ? entry.report.hops[1].found : 0,
      behind: entry.report.cutPoints.length,
    };
  }
  if (window.jrnImpactRings) window.jrnImpactRings();
}

// ── the URL ─────────────────────────────────────────────────────
/**
 * Write the open seed into the hash (`?impact=<id>&hops=N`) so `y` copies a
 * link that opens on the same answer, and take it out again when the panel
 * closes. `replaceState` — re-routing would remount the surface under the
 * reader.
 * @group Change impact
 */
export function impactHash(id) {
  const h = location.hash || '';
  if (!h.startsWith('#/')) return;
  const qi = h.indexOf('?');
  const base = qi >= 0 ? h.slice(0, qi) : h;
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  if (id) { q.set('impact', id); q.set('hops', String(S.impactHops || IMP_HOPS)); }
  else { q.delete('impact'); q.delete('hops'); }
  const qs = q.toString();
  history.replaceState(null, '', base + (qs ? '?' + qs : ''));
}

/** Open the panel a shared link names (`?impact=<id>&hops=N`), once the graph is loaded.
 * @group Change impact */
export function impactFromRoute(route) {
  if (!route || !route.impact) return;
  const hops = route.hops && route.hops >= 1 && route.hops <= IMP_MAX_HOPS ? route.hops : IMP_HOPS;
  S.impactHops = hops;
  openImpact(route.impact);
}

expose({ openImpact, closeImpact, impactGo, impactSetHops });
