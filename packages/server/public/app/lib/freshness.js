// lib/freshness.js — *stale* said once and only when true (swarm-fixes 2026-10-05, finding 2).
//
// The core decides the freshness fact (core `freshness.ts`: current · stale · no source digest · none, the
// run's side and the code's side, the catalog key of the one sentence). This module only prints it: the
// sentence filled from the fact's own vars, in the lens's register, and one rich tip — the word, the sentence,
// *against what* (the run · the code), *what changes it*, and the runs read split by what their reports
// recorded. Every surface that says *stale* (the evidence chip's tip, the journey header, the Portfolio row,
// the Tests cards, the Map's *at risk*) prints this, so two surfaces cannot word the same fact apart.

import { esc } from '../store.js';
import { t } from '../strings.js';
import { isBusiness, registerTip, tableTip, tipAttrs } from './tooltip.js';

/** The fact's placeholders — the same vars the core's `freshnessVars()` builds. */
export function freshVars(f) {
  const short = (s) => (s ? String(s).slice(0, 7) : '');
  const runs = (f && f.runs) || {};
  return {
    ranAt: String((f && f.ranAt) || '').slice(0, 10),
    ran: short(f && f.ranOn && f.ranOn.commit),
    code: short(f && f.codeAt && f.codeAt.commit),
    sync: f && f.codeAt && f.codeAt.sync != null ? String(f.codeAt.sync) : '',
    noDigest: String(runs.noDigest || 0),
    stale: String(runs.stale || 0),
  };
}

function fill(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** The fact's sentence, filled, in the lens's register: the business lens prints the core's business sentence. */
export function freshSentence(f, opts) {
  if (!f || !f.key) return '';
  const biz = opts && opts.business != null ? opts.business : isBusiness();
  return fill(t(biz && f.biz ? f.biz : f.key), freshVars(f));
}

/** True when the fact is worth a line of its own (anything but *no run recorded*). */
export function freshShown(f) { return !!(f && f.state && f.state !== 'none'); }

/** The tip: the word, its sentence, both sides, the recipe, and the runs read. */
export function freshTipHtml(f) {
  if (!f || !f.key) return '';
  const v = freshVars(f);
  const biz = isBusiness();
  const runs = f.runs || {};
  const sides = biz ? [] : [
    ['fresh.tip.ran', [v.ran, v.ranAt].filter(Boolean).join(' · ')],
    ['fresh.tip.code', v.code],
    ['fresh.tip.sync', v.sync],
  ].filter((r) => r[1]);
  const parts = [
    ['count.part.freshCurrent', runs.current || 0],
    ['count.part.freshStale', runs.stale || 0],
    ['count.part.freshNoDigest', runs.noDigest || 0],
  ].filter((p) => p[1]).map(([k, n]) => [fill(t(k), { n }).replace(String(n), '').trim(), n]);
  return '<div class="tip-h">' + esc(t(f.word || 'fresh.state.' + f.state)) + '</div>'
    + '<p class="tip-p">' + esc(freshSentence(f)) + '</p>'
    + (sides.length ? tableTip({ caption: 'fresh.tip.against', rows: sides }) : '')
    + (f.recipe && !(biz && f.recipe === 'fresh.recipe.stamp') ? '<p class="tip-p"><b>' + esc(t('fresh.tip.recipe')) + '</b> · ' + esc(t(f.recipe)) + '</p>' : '')
    + (parts.length > 1 || (parts.length && !biz) ? tableTip({ caption: 'fresh.tip.runs', rows: parts }) : '');
}
registerTip('fresh', (el, a) => freshTipHtml(a));

/** Trigger attributes for an element that carries a freshness fact. */
export function freshAttrs(f, opts) {
  return f && f.key ? tipAttrs(Object.assign({ id: 'fresh', args: f }, opts || {})) : '';
}

/**
 * The fact as a small inline line: the state's word as a mark, then its sentence. '' for *no run recorded*.
 * `cls` is the wrapper's class.
 */
export function freshLineHtml(f, cls) {
  if (!freshShown(f)) return '';
  return '<span class="fresh fresh-' + esc(f.state) + (cls ? ' ' + esc(cls) : '') + '"' + freshAttrs(f, { noFocus: true }) + '>'
    + esc(freshSentence(f)) + '</span>';
}
