// lib/detail-doors.js — the doors of a detail, drawn (round 2026-10-05 §3.2).
//
// lib/detail-links.js decides which doors a detail has (pure, tested); this
// module draws them in the register on screen, reads a gate's own lines from
// `/api/source` for its expansion, and answers the two keys every door row
// shares: Enter on a focused detail opens its first door, `o` opens the editor.
// The journey view and the Map both draw through here, so a gate reads the same
// in the band, the property and the explore card.

import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';
import { detailLinks, editorDoor } from './detail-links.js';
import { storylineOf } from './journeys-model.js';
import { defAttrs } from './counted.js';

/** The doors of one detail, with the viewer's own graph, roots, edge index and lens. */
export function doorsFor(kind, node, extra = {}) {
  return detailLinks(kind, node, {
    byId: S.BYID || {}, roots: S.ROOTS || {}, edgesOf: S.EDGES_OF, lens: currentLens(), ...extra,
  });
}

/** One door as a link: catalog words with their define as the tip; a web address opens in a new tab. */
function doorHtml(d) {
  const ext = d.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  return '<a class="dd-door' + (d.editor ? ' editor' : '') + (d.external ? ' ext' : '') + '" href="' + esc(d.href) + '"' + ext
    + (d.editor ? ' data-door-editor="1"' : '') + tipAttrs({ key: d.word, noFocus: true }) + ' onclick="event.stopPropagation()">'
    + (d.editor ? sym('open') : '') + esc(t(d.word)) + (d.external ? ' ↗' : '') + '</a>';
}

/**
 * The row of doors a detail opens on — `''` when the graph names none, so the
 * caller's absence word is what the reader still sees.
 * @param {Array<{word:string,href:string,external?:boolean,editor?:boolean}>} doors
 * @param {string} [lead]  a door drawn first that is not in the table (*open the journey here*)
 */
export function doorsHtml(doors, lead) {
  const list = (doors || []).map(doorHtml).join('');
  if (!list && !lead) return '';
  return '<span class="dd-doors" role="group" aria-label="' + esc(t('door.group')) + '">' + (lead || '') + list + '</span>';
}

/** The door to the journey (or the Map) a surface draws before the table's doors. */
export function leadDoorHtml(word, href) {
  if (!href) return '';
  return '<a class="dd-door lead" href="' + esc(href) + '"' + tipAttrs({ key: word, noFocus: true }) + ' onclick="event.stopPropagation()">' + esc(t(word)) + '</a>';
}

/**
 * *in storyline: <name> · step n of m* for a journey (lane S's storylines, `storylineOf` over the journeys tree):
 * the first storyline the journey is a step of, the rest named in the tip; `''` when it is in none.
 */
export function storylineLineHtml(tree, flowId) {
  const at = storylineOf(tree, flowId);
  if (!at.length) return '';
  const a = at[0];
  const stepKey = currentLens() === 'business' ? 'journeys.storyline.bizStepOf' : 'journeys.storyline.stepOf';
  const others = at.slice(1).map((x) => x.storyline.name + ' · ' + t(stepKey).replace('{n}', x.step).replace('{m}', x.of));
  // a branch is not a step: *branch of <journey> · when …* in place of *step n of m*
  const at0 = a.branch
    ? '<span' + defAttrs('journeys.storyline.branchOf') + '>' + esc(t('journeys.storyline.branchOf').replace('{name}', a.branch.branchOfName || '') + ' · ' + t('journeys.storyline.when').replace('{when}', a.branch.when)) + '</span>'
    : '<span' + defAttrs(stepKey) + '>' + esc(t(stepKey).replace('{n}', a.step).replace('{m}', a.of)) + '</span>';
  return '<span class="dd-story" data-storyline="' + esc(a.storyline.id) + '">'
    + '<span' + tipAttrs({ text: t('journeys.storyline.in').replace('{name}', a.storyline.name) + (others.length ? ' · ' + others.join(' · ') : ''), noFocus: true }) + '>'
    + esc(t('journeys.storyline.in').replace('{name}', a.storyline.name)) + '</span> · ' + at0 + '</span>';
}

// ── a gate's own lines ──────────────────────────────────────────────────────
const SOURCE = new Map();
function syncKey() { return String((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || ''); }
/** One `/api/source` answer per node per sync. */
export function fetchSource(id) {
  const k = id + '@' + syncKey();
  if (!SOURCE.has(k)) {
    SOURCE.set(k, fetch('/api/source?node=' + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return SOURCE.get(k);
}
/**
 * A placeholder for a node's code lines, filled by `fillCode(root)` once the
 * answer lands. The business register draws none: its gate is its words.
 */
export function codeSlotHtml(id) {
  if (!id || currentLens() === 'business') return '';
  return '<div class="dd-code" data-src="' + esc(id) + '"><span class="dd-load">' + esc(t('door.codeLoading')) + '</span></div>';
}
/** The lines themselves: numbered from the node's own line, at most `cap` of them, the rest said. */
export function codeLinesHtml(src, cap = 24) {
  if (!src || src.code == null || src.code === '') return '<span class="dd-load">' + esc(t('door.codeNone')) + '</span>';
  const lines = String(src.code).split('\n');
  const shown = lines.slice(0, cap);
  const start = src.line || 1;
  return '<pre class="dd-pre">' + shown.map((l, i) => '<span class="ln">' + (start + i) + '</span>' + esc(l)).join('\n') + '</pre>'
    + (lines.length > cap || src.codeTruncated ? '<span class="dd-load">' + esc(t('door.codeMore')) + '</span>' : '');
}
/** Fill every code slot under `root` that has not been filled. */
export function fillCode(root) {
  if (!root) return;
  root.querySelectorAll('.dd-code[data-src]:not([data-done])').forEach((el) => {
    el.dataset.done = '1';
    fetchSource(el.dataset.src).then((src) => { if (el.isConnected) el.innerHTML = codeLinesHtml(src); });
  });
}

// ── keys ────────────────────────────────────────────────────────────────────
/**
 * Enter on a focused detail (an element carrying `data-doors`) opens its first
 * door; `o` anywhere inside one — or with the Map's explore card open — opens
 * its door into the editor. Returns true when it used the key.
 * @param {KeyboardEvent} e
 */
export function doorKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const tgt = e.target && e.target.closest ? e.target : null;
  let host = tgt && tgt.closest('[data-doors]');
  if (e.key === 'o') {
    if (!host) host = document.querySelector('.map-xcard:not([hidden])');
    const a = host && host.querySelector('a.dd-door[data-door-editor]');
    if (!a) return false;
    a.click();
    return true;
  }
  if (e.key === 'Enter' && host && tgt === host) {
    const a = host.querySelector('a.dd-door');
    if (!a) return false;
    a.click();
    return true;
  }
  return false;
}

export { editorDoor };
