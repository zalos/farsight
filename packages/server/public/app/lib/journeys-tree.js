// lib/journeys-tree.js — where the viewer gets the journeys organised persona →
// group → journeys: `GET /api/journeys` first, and — when the server answers
// 404, or 400 from a server that reads the path as `/api/journey` (an older
// server, or an older global install serving this viewer) — the
// same `JourneyTree` folded on the page from `/api/design` by
// `treeFrom()` (lib/journeys-model.js). One answer per scope and sync, shared
// by the Journeys front door, the Portfolio, the Map and the open journey's
// header, so the four cannot disagree.

import { S } from '../store.js';
import { treeFrom } from './journeys-model.js';
import { t } from '../strings.js';
import { countedHtml } from './counted.js';

const CACHE = new Map();
/** graph object → flow node id → its position in the graph (the manifest's order) */
const ORDINALS = new WeakMap();

/** `?scope=` in the shape the API endpoints take. */
export function journeysScope() {
  return S.scope === 'all' || !S.scope || !S.scope.length ? 'all' : S.scope.join(',');
}

function ordinals() {
  const g = S.GRAPH;
  if (!g) return new Map();
  let m = ORDINALS.get(g);
  if (!m) {
    m = new Map();
    // one pass over the graph per graph object: flow nodes are written in manifest order
    let i = 0;
    for (const n of g.nodes || []) if (n.kind === 'flow') m.set(n.id, i++);
    ORDINALS.set(g, m);
  }
  return m;
}

/**
 * The tree for the scope on screen: `{ tree, live, designs? }` — `live` when the
 * server's route answered, `designs` when it was folded here (the caller may
 * reuse them). `designs` passed in saves the fallback a second fetch.
 * @group Journey view
 */
export function loadJourneyTree(designs) {
  const scope = journeysScope();
  const key = scope + '@' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || '');
  if (!CACHE.has(key)) {
    const p = fetch('/api/journeys?scope=' + encodeURIComponent(scope)).then(async (r) => {
      if (r.ok) {
        const j = await r.json();
        if (j && j.tree && Array.isArray(j.tree.personas)) return { tree: j.tree, live: true };
      }
      // anything else is an older server: it has no such route (404), or reads the path as
      // `/api/journey` and asks for an entry (400) — the same tree is folded here instead
      return fold(designs);
    });
    p.catch(() => CACHE.delete(key));
    CACHE.set(key, p);
  }
  return CACHE.get(key);
}

async function fold(designs) {
  let list = designs;
  if (!list) {
    const d = await fetch('/api/design?scope=' + encodeURIComponent(journeysScope())).then((r) => r.json());
    list = (d && (d.designs || d.sources)) || [];
  }
  const ord = ordinals();
  const metas = (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.journeys) || null;
  const tree = treeFrom(list, metas, { nodeOf: (id) => (S.BYID && S.BYID[id]) || null, ordinal: (id) => (ord.has(id) ? ord.get(id) : null) });
  return { tree, live: false, designs: list };
}

/** Forget every tree — a sync replaced the graph. */
export function clearJourneyTrees() { CACHE.clear(); }

// ── the words every surface prints for the tree ─────────────────
/** A persona's words: its declared name, else the catalog's word for the bucket of journeys for nobody named. */
export function jrnPersonaName(p) { return (p && p.name) || t('portfolio.noPersona'); }
/** A group's words: its declared name, else *Other journeys*. */
export function jrnGroupName(g) { return (g && g.name) || t('journeys.noGroup'); }
/**
 * A persona's or a group's two counts with their tips: `n journeys · m built`.
 * Every number is a `Counted` from the tree; its breakdown labels the trailing
 * bucket in words.
 * @group Journey view
 */
export function jrnOrgCountsHtml(counts) {
  if (!counts) return '';
  const fix = (c) => (c && c.breakdown ? { ...c, breakdown: c.breakdown.map((p) => ({ ...p, label: p.label || t('journeys.noGroup') })) } : c);
  return [counts.journeys, counts.built].filter(Boolean)
    .map((c) => countedHtml(fix(c), '/api/journeys', { cls: 'jrn-org-n' })).join('<span class="jrn-org-sep"> · </span>');
}
