// work-chips.js — the small pieces of work items every surface draws the same
// way: where an item stands (colour + the category word + the tracker's own
// state name), a source's freshness sentence, and the chips other surfaces
// carry — a Portfolio row and a journey header (`/api/work/flow/<id>`), and the
// inspector's *tracked by* (`/api/work/links?node=`).
//
// A workspace with no work source asks nothing: every chip checks the settings
// first, so a graph without trackers makes no request and draws nothing.

import { S, esc, currentLens } from './store.js';
import { t } from './strings.js';
import { sym } from './sym.js';
import { countedHtml, countWords, defAttrs } from './lib/counted.js';

/** The catalog word for each state category. @group Work */
export const CAT_KEY = { todo: 'work.state.todo', 'in-progress': 'work.state.inProgress', done: 'work.state.done', removed: 'work.state.removed' };
/** The categories in the order work moves through them. @group Work */
export const CATS = ['todo', 'in-progress', 'done', 'removed'];
const PROVIDER_KEY = { jira: 'work.hud.provider.jira', 'azure-devops': 'work.hud.provider.ado', fixture: 'work.hud.provider.fixture' };

/** True in the business lens: keys, ids, shas and files stay out. @group Work */
export function workBiz() { return currentLens() === 'business'; }

/** The tracker's name in words (`Jira`, `Azure DevOps`), or the provider id for one this build does not know. @group Work */
export function providerWord(p) { return PROVIDER_KEY[p] ? t(PROVIDER_KEY[p]) : String(p || ''); }

/** Whether the workspace settings name an enabled work source — no source, no request. @group Work */
export function workSourcesConfigured() {
  return ((S.SETTINGS && S.SETTINGS.sources) || []).some((s) => s && s.type === 'work' && s.enabled !== false);
}

/** A source's name as the workspace settings give it, else its id. @group Work */
export function sourceName(id) {
  const s = ((S.SETTINGS && S.SETTINGS.sources) || []).find((x) => x && x.id === id);
  return (s && s.name) || String(id || '');
}

/**
 * Where an item stands: a dot in the category's colour, the category word (its
 * tip says what the category means) and the tracker's own state name beside it
 * — never the colour alone, and never the name alone, since *Resolved* in one
 * tracker is not done.
 * @group Work
 */
export function stateHtml(state, plain) {
  const st = state || {};
  const cat = CAT_KEY[st.category] ? st.category : 'todo';
  const catWord = t(CAT_KEY[cat]);
  const name = st.name && st.name.toLowerCase() !== catWord.toLowerCase() ? '<span class="nm">' + esc(st.name) + '</span>' : '';
  return '<span class="wk-state ' + esc(cat) + '"><span class="dot"></span><span class="cat"' + (plain ? '' : defAttrs(CAT_KEY[cat])) + '>' + esc(catWord) + '</span>' + name + '</span>';
}

/** "3 minutes ago" from seconds, in the catalog's words. @group Work */
export function agoWords(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const pick = (key, n) => (n === 1 ? t(key + 'One') : t(key).replace('{n}', String(n)));
  if (s < 60) return t('work.ago.now');
  if (s < 3600) return pick('work.ago.minutes', Math.floor(s / 60));
  if (s < 86400) return pick('work.ago.hours', Math.floor(s / 3600));
  return pick('work.ago.days', Math.floor(s / 86400));
}

/** A time as a person reads it: `30 Sep, 09:14` — today's times as `09:14`. @group Work */
export function whenWords(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return today ? hm : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + hm;
}

/**
 * The freshness sentence, in the existing grammar and never a bare timestamp:
 * *synced 3 minutes ago* · *source unreachable since 09:14 — showing the cache* ·
 * *credential expired — showing the cache* · *never synced* (Lane A's `work.fresh.*`).
 * The tracker's own error rides in the tip, outside the business lens.
 * @group Work
 */
export function freshHtml(fr) {
  const f = fr || { state: 'never' };
  let key = 'work.fresh.never';
  let words = '';
  let glyph = 'absent';
  if (f.state === 'synced') {
    key = 'work.fresh.synced'; glyph = 'live';
    const ago = f.ago != null ? f.ago : (f.since ? (Date.now() - Date.parse(f.since)) / 1000 : null);
    words = t(key).replace('{ago}', ago != null ? agoWords(ago) : whenWords(f.since));
  } else if (f.state === 'unreachable') {
    key = 'work.fresh.unreachable'; glyph = 'syncfail';
    words = t(key).replace('{since}', whenWords(f.since));
  } else if (f.state === 'credential-expired') {
    key = 'work.fresh.credential'; glyph = 'warning';
    words = t(key);
  } else words = t(key);
  const err = f.error && !workBiz() ? ' <span class="wk-dim">(' + esc(f.error) + ')</span>' : '';
  return '<span class="wk-fresh ' + esc(f.state || 'never') + '">' + sym(glyph) + '<span' + defAttrs(key) + '>' + esc(words) + '</span>' + err + '</span>';
}

/** Part words of a by-state breakdown, without the numbers' tips (the total carries them). @group Work */
function partsText(c) {
  return ((c && c.breakdown) || []).filter((p) => p.n).map((p) => countWords(p.key, p.n)).join(' · ');
}

/**
 * A journey's or a Portfolio row's work chip from `/api/work/flow/<id>`:
 * *3 work items · 1 in progress · 2 done*, the total a `Counted` whose tip
 * carries the breakdown. `''` when nothing is linked — a chip reading 0 would
 * say the journey has been checked against every tracker, which it has not.
 * @group Work
 */
export function flowChipHtml(resp) {
  const c = resp && resp.counts && (resp.counts.byState || resp.counts.items);
  const total = resp && resp.counts && resp.counts.items;
  if (!total || !total.n) return '';
  const parts = partsText(c);
  return '<span class="wk-chip" data-flow="' + esc(resp.flow || '') + '">' + sym('work') + countedHtml(total, '/api/work/flow')
    + (parts ? ' <a href="#/work?flow=' + encodeURIComponent(resp.flow || '') + '">· ' + esc(parts) + '</a>' : '') + '</span>';
}

const FLOW_CACHE = new Map();
/**
 * Ask for one flow's work, once per graph sync (a Portfolio redraw for a
 * register flip must not refetch ten flows). Resolves to the answer, or null
 * when there is no work source or the server has no work routes.
 * @group Work
 */
export function flowWork(flowId) {
  if (!flowId || !workSourcesConfigured()) return Promise.resolve(null);
  const key = flowId + '@' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || '');
  if (!FLOW_CACHE.has(key)) {
    FLOW_CACHE.set(key, fetch('/api/work/flow/' + encodeURIComponent(flowId))
      .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return FLOW_CACHE.get(key);
}
/** Forget every cached flow answer (a work sync moved them). @group Work */
export function forgetFlowWork() { FLOW_CACHE.clear(); }

/**
 * Fill the journey header's work chip for the journey on screen. A journey that
 * is not a flow, or a flow nothing tracks, leaves the slot empty.
 * @group Work
 */
export function fillJourneyWork(entry) {
  const el = document.getElementById('jrn-work');
  if (!el) return;
  el.innerHTML = '';
  if (!entry || entry.kind !== 'flow' || !entry.id) return;
  const id = entry.id;
  el.dataset.flow = id;
  flowWork(id).then((resp) => {
    if (el.dataset.flow !== id) return;
    el.innerHTML = flowChipHtml(resp);
  });
}

/**
 * The inspector's *Tracked work* section for a node: an empty placeholder now,
 * filled once `/api/work/links?node=` answers — and left empty when no item is
 * linked. Each row reads *tracked by KAN-3 (in progress, Farsight Test)*; the
 * business lens names the item by its title, never its key.
 * @group Work
 */
export function nodeWorkSecHtml(n) {
  if (!n || !n.id || !workSourcesConfigured()) return '';
  const id = n.id;
  setTimeout(() => {
    fetch('/api/work/links?node=' + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((resp) => {
      const el = document.getElementById('insp-work');
      if (!el || el.dataset.node !== id || !resp || !(resp.items || []).length) return;
      const biz = workBiz();
      el.innerHTML = '<span class="hud-label">' + esc(t('work.hud.insp.head')) + ' · ' + countedHtml(resp.counts && resp.counts.items, '/api/work/links', { words: String(resp.items.length) }) + '</span>'
        + resp.items.map((it) => '<a class="wk-tracked" href="#/work/' + encodeURIComponent(it.id) + '">' + sym('work')
          + '<span' + defAttrs('work.hud.chip.trackedBy') + '>' + esc(t('work.hud.chip.trackedBy')
            .replace('{item}', biz ? it.title : it.key + ' ' + it.title)
            .replace('{state}', t(CAT_KEY[it.state && it.state.category] || CAT_KEY.todo))
            .replace('{source}', sourceName(it.source))) + '</span></a>').join('');
      el.hidden = false;
    });
  }, 0);
  return '<div class="insp-sec" id="insp-work" data-node="' + esc(id) + '" hidden></div>';
}
