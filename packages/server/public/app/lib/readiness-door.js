// lib/readiness-door.js — the one door into the release readiness brief (round 2026-10-10, proposal 6).
// Two call sites draw it: the Map's storyline band head (surfaces/map.js bandHeadHtml) and the front door's
// storyline card (surfaces/journeys.js, the card's ways in). One function, so the two cannot drift.

import { esc } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';

/**
 * The door: `#/readiness/<storyline id>`.
 * @param {string} id  the storyline's id
 * @param {string} [cls]  the host's own link class
 * @group Readiness
 */
export function readinessDoorHtml(id, cls) {
  return '<a class="rel rd-door ' + esc(cls || '') + '" href="#/readiness/' + esc(encodeURIComponent(id)) + '"'
    + tipAttrs({ key: 'readiness.door', noFocus: true }) + '>' + sym('open') + ' ' + esc(t('readiness.door')) + '</a>';
}
