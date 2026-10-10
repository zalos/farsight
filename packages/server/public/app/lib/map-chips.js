// lib/map-chips.js — the Map's chips: one number with its unit and scope, the
// evidence word beside every count of tests, and the owner and ERP reach a
// journey's cover carries (docs/proposals/map-pass-2026-10-03.md §2, lane N).
//
// Every number is a `Counted` the journey summary typed, printed with
// `countedHtml()` and its tip; every word is the one another surface already
// prints for the same fact — the evidence word is the Portfolio's (the fold's
// `evidenceWord`, *not built* where the fold reports shared evidence), the
// owner is the manifest's, the ERP reach is the Portfolio's rule over
// `summary.systems`. Nothing here counts anything itself.

import { esc } from '../store.js';
import { t, evidenceWord } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, defAttrs } from './counted.js';
import { tipAttrs } from './tooltip.js';
import { testChipHtml } from './test-chip.js';

const API = '/api/journey';

/** A typed count as a map chip, or '' when the lens does not print it. */
export function mapCountChip(c, cls) {
  return c ? countedHtml(c, API, { cls: 'map-chip ' + (cls || '') }) : '';
}

/**
 * The evidence word of one coverage fold (a journey's, a screen's) as a chip —
 * the word the Portfolio prints for the same fold, with the journey's evidence
 * tip. Where the fold reports shared evidence (the design names screens and the
 * code builds none) the word is the absence word *not built*, as on the
 * Portfolio. '' when the fold has no class (nothing reaches it).
 */
export function mapEvidenceChip(facts) {
  if (!facts) return '';
  if (facts.sharedEvidence) {
    return '<span class="map-chip k-ev k-absent"' + defAttrs('journey.absent.notBuilt') + '>' + esc(t('journey.absent.notBuilt')) + '</span>';
  }
  const ev = evidenceWord(facts);
  const cls = ev.cls;
  if (!cls || cls === 'none') return '';
  return '<span class="map-chip k-ev ev-' + esc(cls) + '"' + tipAttrs({ id: 'jrnEvidence', args: { ev, obs: facts.observation || null, verdict: facts.verdict ? { status: facts.verdict.status } : null, fresh: facts.freshness || null } }) + '>'
    + (cls === 'observed' ? sym('live') : cls === 'stale' ? sym('stale') : cls === 'reached' ? sym('step') : '')
    + esc(t(ev.key)) + '</span>';
}

/**
 * A count of tests and its evidence word, always together: never a number of
 * tests without its class. `tests` is the fold's `counted.tests`, `facts` the
 * fold. A count of 0 has no class and prints alone.
 */
export function mapTestsChips(tests, facts, opts = {}) {
  if (!tests) return '';
  if (opts.hideZero && !tests.n && !(facts && facts.notBuilt)) return '';
  // one chip with the count, the scope it counts over, the word and the skips (lib/test-chip.js, round 2026-10-10)
  if (facts && facts.counted && facts.counted.tests) {
    if (facts.sharedEvidence) return testChipHtml(facts, { cls: 'map-chip k-test', api: API, word: false, zero: true }) + mapEvidenceChip(facts);
    return testChipHtml(facts, { cls: 'map-chip k-test', api: API, zero: true, evCls: 'map-chip k-ev' });
  }
  const n = mapCountChip(tests, 'k-test');
  if (!n) return '';
  return n + (tests.n ? mapEvidenceChip(facts) : '');
}

/** The ERP an answer's walk reaches — the Portfolio's rule: a system row whose external kind is `erp`. */
export function erpReached(summary) {
  const systems = (summary && summary.systems) || [];
  return systems.find((r) => r && r.externalKind === 'erp') || null;
}

/**
 * The ERP hand-off a journey declares and has not built — the Portfolio's rule:
 * an operation a screen's design declares that no code calls, named like an
 * approval, a posting or a sync.
 */
export function erpDeclared(summary) {
  const segs = (summary && summary.segments) || [];
  return segs.some((s) => (s.declaredOnly || []).some((d) => /approve|post|sync/i.test(d.op || '')));
}

/** The owner chip: the name the manifest gives, the Portfolio's Owner column. '' when it names nobody. */
export function mapOwnerChip(owner) {
  if (!owner) return '';
  return '<span class="map-chip k-owner"' + defAttrs('map.cover.owner', undefined, { owner }) + '>' + esc(t('map.cover.owner').split('{owner}').join(owner)) + '</span>';
}

/** The ERP chip: reached (with the system's name), declared and not built, or nothing. */
export function mapErpChip(summary, built) {
  const erp = erpReached(summary);
  if (erp) return '<span class="map-chip k-erp"' + defAttrs('map.cover.erp') + '>' + esc(t('map.cover.erp').split('{via}').join(erp.label || erp.key || '')) + '</span>';
  // nothing built reaches nothing: the Portfolio prints *not built* there, and the cover's built chip already says it
  if (built === 0) return '';
  if (erpDeclared(summary)) return '<span class="map-chip k-erp k-warn"' + defAttrs('map.cover.erpDeclared') + '>' + esc(t('map.cover.erpDeclared')) + '</span>';
  return '';
}

/**
 * The screens chips of a journey: `14 screens` (its tip splits declared into
 * reached / not reached) and, when the walk reached fewer than the journey
 * names, `10 reached` beside it — so the street's and the footer's number is
 * never a different number with the same name.
 */
export function mapScreensChips(k) {
  if (!k || !k.screens) return '';
  const r = k.screensReached;
  return mapCountChip(k.screens, '') + (r && r.n < k.screens.n ? mapCountChip(r, 'k-warn') : '');
}
