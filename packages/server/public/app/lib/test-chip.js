// lib/test-chip.js — one chip for a number of tests, wherever two of them can meet
// (round 2026-10-10, proposal 4: every test number carries its scope).
//
// The swarm met one screen as *323 cases · passed* on the Map, *no test reaches
// this part · 125 reach the action* in the drawer, *2 tests* on impact and *16* on
// the gate card — four true numbers over four scopes, none of them named. So a
// test number is never printed bare: it prints its count, the words of the scope it
// counts over (core `TestVerdict.scopeWord`, *over this screen*), the cell's one
// evidence word (core `testVerdict()`), and `· n skipped` / `· n failed` /
// `· n flaky` whenever they are not zero — a word never hides its skips. A
// designed, not-built screen has no verdict: the chip says so and names what the
// cases do reach, with that scope (core `CoverageFacts.notBuilt`).
//
// Nothing here counts: every number and word is the fold's. The scope words fall
// back to the scope key's own words against an older server.

import { esc, currentLens } from '../store.js';
import { t, def } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, countWords, defAttrs, plainTip } from './counted.js';
import { tipAttrs, registerTip, tableTip } from './tooltip.js';

// each opening tag written out whole: an attribute assembled from pieces reads as prose to the string lint
const CHIP_OPEN = '<span data-tchip class="tchip ';
const EV_OPEN = '<span class="tc-ev ev ';
const SCOPE_OPEN = '<span class="tc-scope" data-scope-word="';
const SEP = '<span class="tc-sep"> · </span>';

/** The catalog key a test count's chip prints for its scope: the verdict's own, else the scope key itself. */
export function testScopeWordKey(facts) {
  const f = facts || {};
  if (f.verdict && f.verdict.scopeWord) return f.verdict.scopeWord;
  const k = f.counted && f.counted.tests;
  return (k && k.scope) || '';
}

/** The scope words as a span with their define as the tip. */
export function scopeWordHtml(key) {
  if (!key) return '';
  return SCOPE_OPEN + esc(key) + '"' + defAttrs(key) + '>' + esc(t(key)) + '</span>';
}

/** `· 1 failed · 2 skipped · 1 flaky` — only the parts that are not zero, each with its define. */
export function runPartsHtml(verdict, api) {
  const v = verdict || {};
  const scope = (v.runs && v.runs.scope) || '';
  // each part is a number with its own tip: what it counts, over the scope the chip names, where from
  return ['failed', 'skipped', 'flaky'].filter((k) => v[k] > 0).map((k) => SEP
    + '<span data-run-part="' + k + '" class="tc-run ' + k + '"' + plainTip(v[k], 'count.part.' + k, scope, api || '/api/journey') + '>' + esc(countWords('count.part.' + k, v[k])) + '</span>').join('');
}

/**
 * A partly built journey's word: the build state before it and the scope after it (core `EvidenceWord.builtOnly`,
 * swarm round 3 finding 3) — *partly built · 3 of 4 · PASSED … · over the 3 built screens*. Build state wins, so it
 * is printed first and the word loses its pass colour (`.builtonly`). `{ before: '', after: '' }` for any other word.
 */
export function builtOnlyHtml(ev) {
  const b = ev && ev.builtOnly;
  const held = heldHtml(ev);
  if (!b) return { before: '', after: held, cls: held ? ' held' : '' };
  return {
    before: '<span class="tc-pb"' + defAttrs('tests.builtOnly.before', null, { n: b.built, m: b.of }) + '>' + sym('warning') + esc(countWords('tests.builtOnly.before', b.built, b.of)) + '</span>' + SEP,
    after: SEP + '<span class="tc-pba"' + defAttrs('tests.builtOnly.after', null, { n: b.built }) + '>' + esc(countWords('tests.builtOnly.after', b.built)) + '</span>' + held,
    cls: ' builtonly' + (held ? ' held' : ''),
  };
}

/**
 * The release brief's one line beside a pass-type word the brief holds (core `EvidenceWord.held`, made by
 * `ownCaseHold` — the rule `readiness()` reads): *held in the release brief: its own case was skipped*, the cases named in its tip. Said
 * after the word on every surface that prints it through here, so *PASSED* never stands alone beside *HOLD*
 * (outsider demo 2026-10-13). '' when the brief ships the journey.
 */
export function heldHtml(ev) {
  const h = ev && ev.held;
  if (!h) return '';
  const biz = currentLens() === 'business';
  // the line is the brief's reason; the tip names every case and where it skipped (an older server sends no `full`)
  return SEP + '<span class="tc-held" data-held' + tipAttrs({ text: (biz ? h.fullBiz : h.full) || (biz ? h.biz : h.text) }) + '>' + sym('warning')
    // the Map head's line 1 is a budget: it prints the short word (`readiness.held.short`), every other row the line
    + '<span class="tc-held-long">' + esc(biz ? h.biz : h.text) + '</span><span class="tc-held-short">' + esc(t('readiness.held.short')) + '</span></span>';
}

/**
 * The cases a project skipped while another passed them (core `TestVerdict.projectSplit`): *passed on desktop-1440 ·
 * skipped on mobile-390 (…)* — the sentence is core's, in the lens's register. '' when no case is split.
 */
export function projectSplitHtml(verdict) {
  const p = verdict && verdict.projectSplit;
  if (!p || !p.words) return '';
  const biz = currentLens() === 'business';
  const key = biz ? (p.n === 1 ? 'tests.biz.projectSplit' : 'tests.biz.projectSplitMany') : (p.n === 1 ? 'tests.projectSplit' : 'tests.projectSplitMany');
  // the chip row names the projects; the tip fills the sentence with each project's quoted reason (an older server sends no `short`)
  const vars = { n: p.n, passed: (p.passedOn || []).join(', '), skipped: p.words.skipped || (p.skippedOn || []).map((k) => k.project).join(', ') };
  return SEP + '<span class="tc-split" data-project-split="' + esc(String(p.n)) + '"' + defAttrs(key, null, vars) + '>' + esc((biz ? p.words.shortBiz : p.words.short) || (biz ? p.words.biz : p.words.text)) + '</span>';
}

/** The evidence word as a chip, with the journey's evidence tip (registered by the journey surface). */
export function testEvidenceHtml(facts, opts = {}) {
  const f = facts || {};
  const ev = f.evidenceWord || (f.verdict && f.verdict.word) || null;
  if (!ev || !ev.key || ev.cls === 'none') return '';
  const glyph = ev.cls === 'observed' ? sym('live') : ev.cls === 'stale' ? sym('stale') : ev.cls === 'reached' ? sym('step') : '';
  const pb = builtOnlyHtml(ev);
  // a head that prints *n of m screens built* beside the chip keeps the scope after the word and drops the repeat before it
  if (opts.builtShown) pb.before = '';
  return pb.before + EV_OPEN + esc(ev.cls) + pb.cls + ' ' + esc(opts.evCls || '') + '"' + tipAttrs({ id: 'jrnEvidence', args: { ev, obs: f.observation || null, verdict: f.verdict ? { status: f.verdict.status } : null, fresh: f.freshness || null } }) + '>'
    + glyph + esc(t(ev.key)) + '</span>' + pb.after;
}

/**
 * What the word is a verdict over, when a declaration earned it: *by the 29 end-to-end cases that declare it* —
 * so *PASSED* never sits beside a bare *29 of them passed* that reads as 29 of the 401 (swarm round 3, finding 4).
 */
export function testBasisHtml(facts) {
  const o = facts && facts.observation;
  if (!o || o.by !== 'declaration' || !o.cases) return '';
  return SEP + '<span class="tc-basis"' + defAttrs(o.cases === 1 ? 'journey.obs.passedOne' : 'journey.obs.passed', null, { n: o.cases }) + '>' + esc(countWords('journey.obs.passed', o.cases)) + '</span>';
}

/**
 * The cases by their own last runs as one sentence after the count they break down: *401 test cases · … · 389 passed ·
 * 9 skipped · 3 with no run recorded*, the parts of the chip's own number (core `TestVerdict.runs`, a breakdown that sums), each with its tip.
 * Printed whenever a part is not *passed*, so a word never hides its skips or its unrun cases; '' when every case passed.
 */
export function runsSentenceHtml(verdict, api) {
  const v = verdict || {};
  const runs = v.runs;
  const parts = ((runs && runs.breakdown) || []).filter((p) => p.n > 0);
  if (!parts.length || parts.every((p) => p.key === 'count.part.passed')) return runPartsHtml(verdict, api);
  const scope = (runs && runs.scope) || '';
  return SEP + '<span class="tc-runs">'
    + parts.map((p) => {
      const k = p.key.replace('count.part.', '');
      return '<span data-run-part="' + esc(k) + '" class="tc-run ' + esc(k) + '"' + plainTip(p.n, p.key, scope, api || '/api/journey') + '>' + esc(countWords(p.key, p.n)) + '</span>';
    }).join('<span class="tc-sep"> · </span>') + '</span>';
}

/**
 * One test number with its scope: `5 test cases · over this screen · PASSED, BY
 * ITS OWN DECLARATION · 2 skipped`. `facts` is a coverage fold (a journey's, a
 * screen's, an action's, a part's, a gate's). `opts.api` names the endpoint the
 * count came from (its tip), `opts.distinct` marks a total printed beside
 * per-screen counts (its tip is `opts.distinct`, the per-screen table args),
 * `opts.word: false` leaves the evidence word out (a caller that prints it
 * itself), `opts.basis: false` leaves out the declaring cases beside the word (a card with no room; the word's tip names them), `opts.cls` adds a class, `opts.zero` prints a 0 with its scope. `''` when the fold has no cases and no
 * report — the caller prints its absence words, which carry their own scope.
 */
export function testChipHtml(facts, opts = {}) {
  const f = facts || {};
  const k = f.counted && f.counted.tests;
  const scope = testScopeWordKey(f);
  if (f.notBuilt) return notBuiltChipHtml(f, opts);
  if (!k) return '';
  // nothing reaches it: the caller says so in words — or, asked for `zero`, the 0 with its scope
  if (!k.n && !(f.counted.runReports && f.counted.runReports.n)) {
    return opts.zero ? CHIP_OPEN + 'zero ' + esc(opts.cls || '') + '" data-scope="' + esc(k.scope || '') + '">'
      + countedHtml(k, opts.api || '/api/journey', { cls: 'cnt-n tc-n' }) + SEP + scopeWordHtml(scope) + '</span>' : '';
  }
  // the number's tip is its cases by their own last runs (`verdict.runs`, the same cases, a breakdown that sums) — the
  // chip's word and skips are about runs, and the level split is printed on its own line beside the chip
  const runs = f.verdict && f.verdict.runs && f.verdict.runs.n === k.n ? f.verdict.runs : k;
  const num = countedHtml(runs, opts.api || '/api/journey', { cls: 'cnt-n tc-n' });
  if (!num) return '';
  const distinct = opts.distinct
    ? SEP + '<span class="tc-distinct"' + tipAttrs({ id: 'tchipDistinct', args: opts.distinct }) + '>' + esc(t('tests.distinct')) + '</span>' : '';
  const word = opts.word === false ? '' : testEvidenceHtml(f, opts);
  return CHIP_OPEN + esc(opts.cls || '') + '" data-scope="' + esc(k.scope || '') + '">'
    + num + SEP + scopeWordHtml(scope) + distinct
    + (word ? SEP + word + (opts.basis === false ? '' : testBasisHtml(f)) : '')
    + (opts.runs === false ? runPartsHtml(f.verdict, opts.api) : runsSentenceHtml(f.verdict, opts.api))
    + (opts.runs === false ? '' : projectSplitHtml(f.verdict))
    + '</span>';
}

/**
 * A designed, not-built screen: no word and no status — *designed, not built ·
 * no test can reach a screen with no code* — and, when cases reach the routes it
 * will call, how many, with that scope. Never *passed* on a screen with no code.
 */
export function notBuiltChipHtml(facts, opts = {}) {
  const f = facts || {};
  const k = f.counted && f.counted.tests;
  const reach = k && k.n
    ? SEP + countedHtml(k, opts.api || '/api/journey', { cls: 'cnt-n tc-n' }) + SEP + scopeWordHtml(testScopeWordKey(f)) + runPartsHtml(f.verdict, opts.api)
    : '';
  return CHIP_OPEN + 'nb ' + esc(opts.cls || '') + '" data-not-built data-scope="' + esc((k && k.scope) || '') + '">'
    + '<span class="tc-nb"' + defAttrs('tests.notBuilt.word') + '>' + sym('warning') + esc(t('tests.notBuilt.word')) + '</span>'
    + SEP + '<span class="tc-nbs"' + defAttrs('tests.notBuilt.sentence') + '>' + esc(t('tests.notBuilt.sentence')) + '</span>'
    + reach + '</span>';
}

/**
 * The *distinct* tip's table for a journey: each screen's actions, gates & rules
 * and test cases, their sum, and the journey's distinct total — so a reader sees
 * why 4 + 5 + 0 is not 7. Read off the summary's per-screen counts and the
 * coverage fold; `null` when the journey has fewer than two screens.
 */
export function distinctArgs(sum) {
  const segs = (sum && sum.segments) || [];
  if (segs.length < 2) return null;
  const cov = (sum && sum.coverage) || {};
  const total = (sum && sum.counted) || {};
  const n = (c) => (c && typeof c.n === 'number' ? c.n : null);
  const row = (key, perSeg, all) => {
    const vals = segs.map(perSeg);
    if (vals.every((v) => v == null) || all == null) return null;
    return [key, ...vals.map((v) => (v == null ? 0 : v)), vals.reduce((a, v) => a + (v || 0), 0), all];
  };
  const rows = [
    row('tests.distinct.actions', (sg) => n(sg.counted && sg.counted.actions), n(total.actions)),
    row('tests.distinct.gates', (sg) => n(sg.counted && sg.counted.gates), n(total.gates)),
    // a not-built screen's cases are the route's, not the screen's: no case reaches a screen with no code
    row('tests.distinct.cases', (_, i) => (cov.segments && cov.segments[i] && cov.segments[i].notBuilt ? 0 : n(cov.segments && cov.segments[i] && cov.segments[i].counted && cov.segments[i].counted.tests)),
      n(cov.journey && cov.journey.counted && cov.journey.counted.tests)),
  ].filter(Boolean);
  if (!rows.length) return null;
  return { screens: segs.map((sg, i) => (sg.screen && sg.screen.name) || String(i + 1)), rows };
}

registerTip('tchipDistinct', (el, a) => {
  if (!a || !a.rows) return '';
  const columns = [''].concat(a.screens, ['tests.distinct.perScreen', 'tests.distinct.total']).map((c, i) => (i ? { label: c, num: true } : c));
  return '<div class="tip-h">' + esc(t('tests.distinct.head')) + '</div>'
    + '<p class="tip-p">' + esc(t('tests.distinct')) + ' — ' + esc(def('tests.distinct') || '') + '</p>'
    + tableTip({ columns, rows: a.rows });
});
