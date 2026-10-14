// lib/parties.js — work done outside the code, and the parties that do it, on the storyline's lanes (the 2026-10-13
// outsider round, F8). A designed screen's step with `by` (person · partner · another system) is something somebody
// does on purpose outside the application — the W-9 request by email, the partner's payout, a bank check in the ERP.
// It is drawn **apart from a screen that is designed and not built**: a dotted card with *done by <who>*, never a
// gate, never a verdict, counted apart (`count.unit.offPlatform`). When `who` names a party external (an `externals[]`
// entry with `kind: 'party'`), the card goes in that party's own lane; otherwise it sits in the lane of the person
// whose screen declares it, under that screen.
//
// The lanes model (lib/map-lanes-model.js `laneLayout`) calls `offPlatformStages()` and `partyLanes()`; the lanes
// surface (surfaces/map-lanes.js) calls `offPlatformStageHtml()` and `partyLaneHeadHtml()`. Pure apart from the two
// HTML builders' catalog reads.

import { esc } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';
import { countedHtml } from './counted.js';
import { offWho } from './parties-model.js';

export { offPlatformStages, partyLanes, partyLaneCount, offPlatformCounted, offWho } from './parties-model.js';

const fill = (key, vars) => Object.entries(vars || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));

/** The head of a party lane: its name, its count, and that no code reaches it, with the team's words for its role in the tip. */
export function partyLaneHeadHtml(l) {
  return '<div class="ln-head"><div class="ln-hrow"><div class="nm">' + sym('external') + '<span class="w">' + esc(l.name) + '</span></div>'
    + '<span class="n">' + countedHtml(l.count, '/api/journey', { cls: 'ln-n' }) + '</span></div>'
    + '<div class="d"' + tipAttrs({ text: t('party.lane.sub') + (l.description ? ' · ' + l.description : ''), noFocus: true }) + '>' + esc(t('party.lane.sub')) + '</div></div>';
}

/**
 * One off-platform card: dotted, the step's name, *done by <who>* (or *done by a person*), where it happens, and
 * *no test can reach it* in place of a test chip — never a status chip, never a verdict.
 */
export function offPlatformStageHtml(st, r) {
  const who = offWho(st.decl);
  const by = who ? fill('offPlatform.byWho', { who }) : t('offPlatform.by.' + st.decl.by);
  const tip = [st.name, by, st.decl.where ? fill('offPlatform.where', { where: st.decl.where }) : '', t('offPlatform.declared')].filter(Boolean).join(' · ');
  return '<div class="ln-stage off" data-key="' + esc(st.key) + '" data-off="' + esc(st.decl.by) + '" data-flow="' + esc(st.flowId) + '" data-index="' + st.screenIndex + '"'
    + ' style="left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px"' + tipAttrs({ text: tip, noFocus: true }) + '>'
    + '<div class="ttl"><span class="map-step off">' + sym('human') + '</span><span class="nm">' + esc(st.name) + '</span>'
    + '</div>'
    + '<div class="sub">' + esc(by) + (st.decl.where ? ' · ' + esc(st.decl.where) : '') + '</div>'
    + '<div class="ln-chips"><span class="map-chip k-off"' + tipAttrs({ key: 'offPlatform.chip', noFocus: true }) + '>' + esc(t('offPlatform.chip')) + '</span><span class="map-chip k-none"' + tipAttrs({ key: 'offPlatform.noTest', noFocus: true }) + '>' + esc(t('offPlatform.noTest')) + '</span></div></div>';
}

/** The off-platform rows of a screen for a list (the Map property's Overview): name · done by · where. */
export function offPlatformListHtml(steps) {
  if (!steps || !steps.length) return '';
  return steps.map((s) => {
    const who = offWho(s);
    return '<div class="mp-row off" data-off="' + esc(s.by) + '"' + tipAttrs({ key: 'offPlatform.chip', noFocus: true }) + '>' + sym('human')
      + '<span class="mp-name">' + esc(s.name) + '</span> <span class="map-chip k-off">' + esc(who ? fill('offPlatform.byWho', { who }) : t('offPlatform.by.' + s.by)) + '</span>'
      + (s.where ? ' <span class="mp-note">' + esc(s.where) + '</span>' : '') + '</div>';
  }).join('');
}
