// surfaces/stewardship.js — honest placeholder. The debt queue (ungated
// entries, unconfirmed names, unresolved edges, suspect answers — owner is
// always a group, never a person) ships in pass P8 on P3's metrics.

import { esc } from '../store.js';
import { t } from '../strings.js';

/**
 * Placeholder mount for the Stewardship surface (real surface: pass P8).
 * @group Stewardship
 */
export function mountStewardship(route, el) {
  el.innerHTML = '<div class="set-wrap"><h1>' + esc(t('nav.stewardship')) + '</h1>'
    + '<div class="set-sec ph-sec"><h2>' + esc(t('ph.stewardship.title')) + '</h2>'
    + '<p class="ph-body">' + esc(t('ph.stewardship.body')) + '</p></div></div>';
}
