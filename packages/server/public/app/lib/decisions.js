// lib/decisions.js — a decision the team made or left open, on the thing it bears on (the 2026-10-13 outsider round,
// F8): a chip *pending decision D7 · <title>* (or *decided D5 · …*) beside the gate, the screen, the walk stop and the
// lifecycle row a declared decision names, opening a small card — the state, the owner, the team's words quoted, the
// document it cites quoted (heading and first paragraph, verbatim) and a door to that document and to each code line
// that names the decision. A declaration printed as one: never an evidence class, never an absence word, and every
// word on the card is the team's or the catalog's — nothing here is generated.
//
// One fetch of `GET /api/decisions` per graph (the server folds it once per index); every lookup after is a Map get.

import { S, esc, currentLens, expose } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs, registerTip } from './tooltip.js';
import { editorHref } from './detail-links.js';

const API = '/api/decisions';
/** The answer for the graph on screen: `{ key, rows, byNode: Map<nodeId, row[]>, byId: Map<id, row> }`. */
const D = { key: '', rows: [], byNode: new Map(), byId: new Map(), pending: null };

const fill = (key, vars) => Object.entries(vars || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));
const biz = () => currentLens() === 'business';
const graphKey = () => String((S.GRAPH && S.GRAPH.meta && (S.GRAPH.meta.sync || S.GRAPH.meta.generatedAt)) || '');

/** Index an answer's rows by the nodes they bear on. Pure; exported for the tests. */
export function indexDecisions(rows) {
  const byNode = new Map();
  const byId = new Map();
  for (const r of rows || []) {
    byId.set(r.repo + '|' + r.id, r);
    for (const id of r.nodes || []) {
      if (!byNode.has(id)) byNode.set(id, []);
      if (!byNode.get(id).includes(r)) byNode.get(id).push(r);
    }
  }
  return { byNode, byId };
}

/** Read the decisions once per graph. Resolves to the rows; a server without the route answers none. */
export function loadDecisions() {
  const key = graphKey();
  if (D.key === key && (D.rows.length || !D.pending)) return Promise.resolve(D.rows);
  if (D.pending && D.key === key) return D.pending;
  D.key = key;
  D.pending = fetch(API).then((r) => (r.ok ? r.json() : { decisions: [] })).catch(() => ({ decisions: [] })).then((a) => {
    D.rows = a.decisions || [];
    const ix = indexDecisions(D.rows);
    D.byNode = ix.byNode; D.byId = ix.byId;
    D.pending = null;
    return D.rows;
  });
  return D.pending;
}

/** The decisions that bear on any of these nodes, each once, open first. Synchronous: empty until `loadDecisions()` has answered. */
export function decisionsOn(ids) {
  const out = [];
  for (const id of [].concat(ids || [])) for (const r of D.byNode.get(id) || []) if (!out.includes(r)) out.push(r);
  return out.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

/** The chip's words: the catalog's pattern with the team's id and title. Pure. */
export function decisionChipText(r) {
  const key = !r.declared || !r.state ? 'decision.chip.unknown' : r.state === 'open' ? 'decision.chip.open' : 'decision.chip.decided';
  return { key, text: fill(key, { id: r.id, title: r.title || '' }).replace(/\s·\s$/, '') };
}

/** One chip that opens the decision's card (a pinned rich tip). */
export function decisionChipHtml(r, opts = {}) {
  const w = decisionChipText(r);
  const state = !r.declared ? 'unknown' : r.state || 'unknown';
  // inside a card that already shows the decision's card: the chip is its heading, not a second door to it
  if (opts.static) return '<span class="dec-chip map-chip s-' + esc(state) + '"' + tipAttrs({ key: w.key, noFocus: true }) + '>' + sym('decision') + '<span class="w">' + esc(w.text) + '</span></span>';
  return '<button type="button" class="dec-chip map-chip s-' + esc(state) + (opts.cls ? ' ' + esc(opts.cls) : '') + '" data-decision="' + esc(r.repo + '|' + r.id) + '"'
    + tipAttrs({ id: 'decision', args: { key: r.repo + '|' + r.id }, noFocus: true }) + ' aria-label="' + esc(w.text) + '">'
    + sym('decision') + '<span class="w">' + esc(w.text) + '</span></button>';
}

/** Every chip for these nodes, in one row; '' when none bears on them. */
export function decisionChipsHtml(ids, opts = {}) {
  const rows = decisionsOn(ids);
  if (!rows.length) return '';
  return '<span class="dec-chips' + (opts.cls ? ' ' + esc(opts.cls) : '') + '">' + rows.map((r) => decisionChipHtml(r)).join('') + '</span>';
}

function stateWords(r) {
  if (!r.declared) return t('decision.state.codeOnly');
  if (r.state === 'open') return t('decision.state.open');
  return r.decided ? fill('decision.state.decided', { date: r.decided }) : t('decision.state.decidedNoDate');
}
const defAttrs = (key) => tipAttrs({ key, noFocus: true });

/** The card: state · owner · the team's words · the document quoted · where the code names it · what it bears on. */
export function decisionCardHtml(r) {
  if (!r) return '';
  const roots = S.ROOTS || {};
  const b = biz();
  const state = '<span class="dec-state s-' + esc(r.declared ? r.state || 'unknown' : 'unknown') + '"' + defAttrs(!r.declared ? 'decision.state.codeOnly' : r.state === 'open' ? 'decision.state.open' : 'decision.state.decidedNoDate') + '>' + esc(stateWords(r)) + '</span>';
  const owner = r.declared ? '<span class="dec-owner"' + defAttrs(r.owner ? 'decision.owner' : 'decision.ownerNone') + '>' + esc(r.owner ? fill('decision.owner', { owner: r.owner }) : t('decision.ownerNone')) + '</span>' : '';
  const said = r.summary ? '<section class="dec-sec"><span class="hud-label"' + defAttrs('decision.said') + '>' + esc(t('decision.said')) + '</span><blockquote class="dec-q">' + esc(r.summary) + '</blockquote></section>' : '';
  let doc = '';
  if (r.docRef) {
    const href = editorHref(roots, r.repo, r.docRef.path, null);
    doc = '<section class="dec-sec">'
      + (r.docRef.title ? '<b class="dec-doc-t">' + esc(r.docRef.title) + '</b>' : '')
      + (r.docRef.quote ? '<blockquote class="dec-q">' + esc(r.docRef.quote) + (r.docRef.cut ? ' <span class="dec-cut"' + defAttrs('doc.cut') + '>' + esc(t('doc.cut')) + '</span>' : '') + '</blockquote>' : '')
      + '<span class="dec-from"' + defAttrs('decision.quoted') + '>' + esc(fill('decision.quoted', { path: r.docRef.path + (r.docRef.anchor ? '#' + r.docRef.anchor : '') })) + '</span>'
      + (href ? ' <a class="dd-door" href="' + esc(href) + '"' + defAttrs('decision.openDoc') + '>' + esc(t('decision.openDoc')) + '</a>' : '')
      + '</section>';
  }
  // the code lines that name it: doors into code, so never in the business register
  const sites = !b && (r.sites || []).length
    ? '<section class="dec-sec"><span class="hud-label"' + defAttrs('decision.code') + '>' + esc(t('decision.code')) + '</span>'
      + r.sites.map((s) => {
        const href = editorHref(roots, r.repo, s.path, s.line);
        const on = s.nodeId ? ((r.names && r.names[s.nodeId]) || s.nodeId.split('::').pop()) : s.symbol ? fill('decision.above', { symbol: s.symbol }) : '';
        return '<div class="dec-site"><span class="map-code">' + esc(s.path + ':' + s.line) + '</span>' + (on ? ' · ' + esc(on) : '')
          + (s.text ? '<div class="dec-said">' + esc(s.text) + '</div>' : '')
          + (href ? ' <a class="dd-door" href="' + esc(href) + '"' + defAttrs('decision.openCode') + '>' + esc(t('decision.openCode')) + '</a>' : '') + '</div>';
      }).join('') + '</section>'
    : '';
  const bears = (r.nodes || []).filter((id) => !(r.sites || []).some((s) => s.nodeId === id));
  const affects = bears.length
    ? '<section class="dec-sec"><span class="hud-label"' + defAttrs('decision.affects') + '>' + esc(t('decision.affects')) + '</span> '
      + bears.map((id) => '<span class="dec-aff">' + esc((r.names && r.names[id]) || id.split('::').pop()) + '</span>').join(' · ') + '</section>'
    : '';
  const from = r.from ? '<p class="dec-from"' + defAttrs('decision.declaredIn') + '>' + esc(fill('decision.declaredIn', { path: r.from })) + '</p>' : '';
  return '<div class="dec-card" data-dec="' + esc(r.repo + '|' + r.id) + '">'
    + '<div class="dec-head">' + sym('decision') + '<span class="hud-label"' + defAttrs('decision.card.title') + '>' + esc(t('decision.card.title')) + ' ' + esc(r.id) + '</span></div>'
    + (r.title ? '<b class="tip-h dec-title">' + esc(r.title) + '</b>' : '')
    + '<div class="dec-meta">' + state + owner + '</div>'
    + said + doc + sites + affects + from + '</div>';
}

registerTip('decision', (el, args) => decisionCardHtml(D.byId.get((args && args.key) || '')));

expose({ loadDecisions });
