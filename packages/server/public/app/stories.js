// stories.js — a component shown on its own (docs/ARCHITECTURE.md ADR 9).
//
// The graph carries each component's stories (read from its *.stories file at
// ingest). A running Storybook only draws them: /api/stories says which
// Storybooks answered, maps their index onto nodes, and gives each live story
// the iframe page to frame. This module is the one place the viewer draws a
// story — the inspector's Stories section, the large story view, the chips
// the journey puts on a screen, and the catalogue on the front door — so a
// story reads the same wherever it appears.
//
// Farsight never starts a Storybook. When one is not reached the section says
// so, with the command the repo's own scripts use to start it.

import { S, esc, jsArg, expose, repoOf, bizLabel, currentLens } from './store.js';
import { t, def } from './strings.js';
import { sym } from './sym.js';
import { vsl } from './lib/graph-render.js';
import { tipAttrs } from './lib/tooltip.js';
import { defAttrs, plainTip, countWords } from './lib/counted.js';

/** The last /api/stories answer, when it was asked, and the request in flight. */
const LIVE = { answer: null, at: 0, pending: null, scope: null };
/** How long an answer is reused before the next inspector click asks again. */
const LIVE_TTL_MS = 15000;
/** The story each node shows, once a reader picked one. */
const PICKED = {};

/**
 * Ask the server for the Storybooks and their stories (fresh = re-read the
 * running index rather than the server's few-second cache). Fail-soft: a
 * failed request answers null and every caller falls back to the graph's own
 * stories with no live picture.
 * @group Stories
 */
export function loadStories(fresh) {
  const now = Date.now();
  if (!fresh && LIVE.answer && now - LIVE.at < LIVE_TTL_MS) return Promise.resolve(LIVE.answer);
  if (!fresh && LIVE.pending) return LIVE.pending;
  LIVE.pending = fetch('/api/stories' + (fresh ? '?refresh=1' : ''))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((a) => { LIVE.answer = a; LIVE.at = Date.now(); LIVE.pending = null; return a; });
  return LIVE.pending;
}

/** The Storybooks the graph recorded for a repo (no request needed). @group Stories */
export function storybooksOfRepo(repo) {
  const m = S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.stories;
  return (m && m[repo] && m[repo].storybooks) || [];
}

/**
 * A node's stories: the live answer's merged list when there is one, else the
 * graph's own StoryRefs (named, not drawable).
 * @group Stories
 */
export function storiesOf(n) {
  if (!n) return [];
  const live = LIVE.answer && LIVE.answer.byNode && LIVE.answer.byNode[n.id];
  if (live) return live;
  return (n.stories || []).map((s) => ({ id: s.id, name: s.name, title: s.title, type: 'story', repo: repoOf(n), storybook: s.storybook, docs: s.docs, file: s.file, line: s.line, inGraph: true, live: false }));
}

/** The live status of the Storybook a story belongs to (or the repo's first). @group Stories */
function bookStatus(repo, configDir) {
  const books = (LIVE.answer && LIVE.answer.storybooks) || [];
  return books.find((b) => b.repo === repo && (!configDir || b.configDir === configDir)) || books.find((b) => b.repo === repo) || null;
}

/** The author's sentence: text, with its `code` spans drawn as code rather than as backticks. @group Stories */
function storyDocHtml(text) { return esc(String(text || '')).replace(/`([^`]+)`/g, '<code>$1</code>'); }

/** What a reader calls a story: its name, and "Docs" for a docs page. @group Stories */
function storyWord(s) { return s.type === 'docs' ? t('stories.docs') : s.name; }

/** The storybook URL a story opens at in Storybook's own manager UI. @group Stories */
function managerUrl(book, s) {
  if (!book || !book.url) return '';
  return book.url.replace(/\/+$/, '') + '/?path=/' + (s.type === 'docs' ? 'docs' : 'story') + '/' + encodeURIComponent(s.id);
}

/**
 * The sentence for a Storybook that was not reached: where it was looked for
 * and the command that starts it. "not reached" is the absence word — the
 * graph has the stories; the viewer could not get to the thing that draws them.
 * @group Stories
 */
function notReachedHtml(book, repo) {
  const refs = storybooksOfRepo(repo);
  const ref = book || refs[0] || {};
  const url = ref.url || '';
  const sentence = !url ? t('stories.noUrl')
    : ref.command ? t('stories.notRunning').replace('{url}', url).replace('{command}', ref.command)
      : t('stories.notRunningNoCmd').replace('{url}', url);
  return '<div class="sb-absent"><span class="api-chip warn">' + sym('absent') + esc(t('journey.absent.notReached')) + '</span>'
    + '<p>' + esc(sentence) + '</p>'
    + '<button class="btn sb-retry" onclick="storiesRetry()">' + sym('sync') + ' ' + esc(t('stories.retry')) + '</button></div>';
}

/**
 * The inspector's Stories section for a component: its stories by name, the
 * picked one drawn live in a frame (the large view one click away), what the
 * author says it shows, and — outside the business register — the file line.
 * Drawn from the graph at once and redrawn when the live answer arrives.
 * Nothing at all for a node in a repo with no Storybook and no stories.
 * @group Stories
 * @business Shows the component on its own, in each state its author set up, drawn live by the team's Storybook.
 */
export function storiesSecHtml(n) {
  if (!n || !['component', 'page'].includes(n.kind)) return '';
  const repo = repoOf(n);
  if (!(n.stories || []).length && !storybooksOfRepo(repo).length) return '';
  // draw what the graph knows now; fill the live picture when it comes
  loadStories(false).then(() => {
    const el = document.getElementById('insp-stories');
    if (el && el.dataset.node === n.id) el.innerHTML = storiesBodyHtml(n);
  });
  return '<div class="insp-sec sb-sec" id="insp-stories" data-node="' + esc(n.id) + '">' + storiesBodyHtml(n) + '</div>';
}

/**
 * The parts a component or screen renders that have stories of their own —
 * the rule `storyParts()` in the core counts by (two levels of *renders*, never
 * a `plumbing` part, never the node itself), so the number here and the one
 * `farsight stories --node` prints are one number.
 * @group Stories
 */
function partIdsOf(n) {
  return [...new Set(screenStoryIds(n))].filter((id) => id !== n.id);
}

/**
 * The section's head and the two named lists it holds: **this component's own**
 * stories (and docs pages — tabs, never counted as stories), then **the stories
 * on the parts it renders**. A page with none of its own used to say *none
 * indexed · no story renders this component* above twelve unlabelled chips of
 * its parts', and `3 stories` sat over four tabs (pass swarm 2026-09-25).
 * @group Stories
 */
function storiesHeadHtml(list, partIds) {
  const own = list.filter((s) => s.type === 'story').length;
  const docs = list.filter((s) => s.type === 'docs').length;
  const api = '/api/stories';
  return '<span class="hud-label"' + defAttrs('stories.title') + '>' + sym('story') + ' ' + esc(t('stories.title')) + '</span>'
    + '<div class="sb-own"><span class="hud-label">' + esc(t('count.scope.component')) + '</span> '
    + '<span class="cnt"' + plainTip(own, 'stories.count', 'count.scope.component', api) + '>' + esc(countWords(own === 1 ? 'stories.countOne' : 'stories.count', own)) + '</span>'
    + (docs ? ' · <span class="cnt"' + plainTip(docs, 'count.unit.docsPages', 'count.scope.component', api) + '>' + esc(countWords('count.unit.docsPages', docs)) + '</span>' : '')
    + '</div>';
}

/** The parts' stories, under their own heading, each part a chip that opens its large view. @group Stories */
function storiesPartsHtml(partIds) {
  if (!partIds.length) return '';
  const rows = partIds.map((id) => { const x = S.BYID[id]; return [x ? bizLabel(x) : id, storiesOf(x).filter((s) => s.type === 'story').length || (x && x.stories ? x.stories.length : 0)]; });
  const sum = rows.reduce((a, r) => a + r[1], 0);
  return '<div class="sb-parts"><span class="hud-label">' + esc(t('count.scope.parts')) + ' · '
    + '<span class="cnt"' + plainTip(sum, 'count.unit.partStories', 'count.scope.parts', '/api/stories', rows) + '>' + esc(countWords('count.unit.partStories', sum)) + '</span></span>'
    + storyChipsHtml(partIds) + '</div>';
}

/** The section's inside, from whatever is known right now. @group Stories */
function storiesBodyHtml(n) {
  const list = storiesOf(n);
  const repo = repoOf(n);
  const lens = currentLens();
  const partIds = partIdsOf(n);
  const head = storiesHeadHtml(list, partIds);
  if (!list.length) {
    // nothing of its own: say so under its own heading, then the parts' stories under theirs
    // the absence word is for a true absence: with parts' stories below, the
    // count above already says *0* of its own and the sentence says why
    const none = lens === 'business' ? 'journey.biz.absent.noneIndexed' : 'journey.absent.noneIndexed';
    return head + '<p class="sb-none">' + (partIds.length ? '' : '<span class="api-chip"' + defAttrs(none) + '>'
      + sym('absent') + esc(t(none)) + '</span> ') + esc(t('stories.none')) + '</p>' + storiesPartsHtml(partIds);
  }
  const pick = list.find((s) => s.id === PICKED[n.id]) || list.find((s) => s.frame && s.type === 'story') || list.find((s) => s.type === 'story') || list[0];
  const book = bookStatus(repo, pick.storybook);
  const tabs = '<div class="sb-tabs" role="tablist">' + list.map((s) => '<button class="sb-tab' + (s.id === pick.id ? ' on' : '') + (s.type === 'docs' ? ' docs' : '') + '"'
    + ' role="tab" aria-selected="' + (s.id === pick.id ? 'true' : 'false') + '" onclick="storyPick(' + jsArg(n.id) + ',' + jsArg(s.id) + ')"'
    + (s.docs ? tipAttrs({ text: s.docs, noFocus: true }) : '') + '>' + esc(storyWord(s)) + '</button>').join('') + '</div>';
  let picture = '';
  if (!LIVE.answer) picture = '<p class="set-note">' + esc(t('stories.checking')) + '</p>';
  else if (!book || !book.reachable) picture = notReachedHtml(book, repo);
  else if (!pick.frame) {
    picture = '<div class="sb-absent"><span class="api-chip warn"' + defAttrs('stories.notListed') + '>' + sym('absent') + esc(t('stories.notListed')) + '</span>'
      + '<p>' + esc(def('stories.notListed')) + '</p></div>';
  } else {
    picture = '<div class="sb-frame-wrap"><iframe class="sb-frame" src="' + esc(pick.frame) + '" loading="lazy" title="'
      + esc(t('stories.frameTitle').replace('{name}', storyWord(pick)).replace('{component}', bizLabel(n))) + '"></iframe>'
      + '<button class="sb-enlarge" onclick="openStoryLightbox(' + jsArg(n.id) + ',' + jsArg(pick.id) + ')" title="' + esc(t('stories.openLarge')) + '" aria-label="' + esc(t('stories.openLarge')) + '"></button></div>'
      + '<div class="sb-actions"><button class="btn primary" onclick="openStoryLightbox(' + jsArg(n.id) + ',' + jsArg(pick.id) + ')">' + sym('story') + ' ' + esc(t('stories.openLarge')) + '</button>'
      + '<a class="btn" href="' + esc(managerUrl(book, pick)) + '" target="_blank" rel="noopener">' + sym('open') + ' ' + esc(t('stories.openInStorybook')) + '</a></div>';
  }
  const shows = pick.docs ? '<div class="rd sb-shows"><b>' + esc(t('stories.shows')) + '</b> ' + storyDocHtml(pick.docs) + '</div>' : '';
  const where = lens !== 'business' && pick.file ? '<div class="rd sb-where">' + esc(pick.file + ':' + pick.line) + vsl(repo, pick.file, pick.line) + '</div>' : '';
  return head + tabs + picture + shows + where + storiesPartsHtml(partIds);
}

/** A reader picked a story in the inspector: remember it and redraw the section. @group Stories */
export function storyPick(nodeId, storyId) {
  PICKED[nodeId] = storyId;
  const el = document.getElementById('insp-stories');
  const n = S.GRAPH && S.GRAPH.nodes.find((x) => x.id === nodeId);
  if (el && n) el.innerHTML = storiesBodyHtml(n);
  const lb = document.getElementById('sb-lb');
  if (lb && lb.dataset.node === nodeId) openStoryLightbox(nodeId, storyId);
}

/** Check the Storybook again — a reader who just started it should not have to reload. @group Stories */
export function storiesRetry() {
  loadStories(true).then(() => {
    const el = document.getElementById('insp-stories');
    const n = el && S.GRAPH && S.GRAPH.nodes.find((x) => x.id === el.dataset.node);
    if (el && n) el.innerHTML = storiesBodyHtml(n);
    const lb = document.getElementById('sb-lb');
    if (lb) openStoryLightbox(lb.dataset.node, lb.dataset.story);
    const cat = document.getElementById('sb-cat');
    if (cat) fillCatalogue();
  });
}

/**
 * The large story view: every story of the component down the side, the
 * picked one framed at up to 90vw × 85vh — a component is judged by looking
 * at it, so it gets the room a design render gets. Esc or a click outside
 * closes it; the element is created on demand and removed on close.
 * @group Stories
 * @business The component drawn large, one state at a time.
 */
export function openStoryLightbox(nodeId, storyId) {
  const n = S.GRAPH && S.GRAPH.nodes.find((x) => x.id === nodeId);
  if (!n) return;
  loadStories(false).then(() => drawLightbox(n, storyId));
}

/** Draw (or redraw) the large view once the live answer is in hand. @group Stories */
function drawLightbox(n, storyId) {
  const list = storiesOf(n);
  if (!list.length) return;
  const pick = list.find((s) => s.id === storyId) || list.find((s) => s.frame) || list[0];
  PICKED[n.id] = pick.id;
  const repo = repoOf(n);
  const book = bookStatus(repo, pick.storybook);
  const lens = currentLens();
  let el = document.getElementById('sb-lb');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sb-lb'; el.className = 'sb-lb';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    el.onclick = closeStoryLightbox;
    document.body.appendChild(el);
    document.addEventListener('keydown', storyLightboxKey, true);
  }
  el.dataset.node = n.id; el.dataset.story = pick.id;
  el.setAttribute('aria-label', t('stories.title') + ' · ' + bizLabel(n));
  const picture = !book || !book.reachable ? notReachedHtml(book, repo)
    : !pick.frame ? '<div class="sb-absent"><span class="api-chip warn">' + sym('absent') + esc(t('stories.notListed')) + '</span><p>' + esc(def('stories.notListed')) + '</p></div>'
      : '<iframe class="sb-lb-frame" src="' + esc(pick.frame) + '" title="' + esc(t('stories.frameTitle').replace('{name}', storyWord(pick)).replace('{component}', bizLabel(n))) + '"></iframe>';
  el.innerHTML = '<div class="sb-lb-inner" onclick="event.stopPropagation()">'
    + '<div class="sb-lb-head">' + sym('story') + '<span class="sb-lb-name">' + esc(bizLabel(n)) + '</span>'
    + (lens !== 'business' && pick.title ? '<span class="api-chip">' + esc(pick.title) + '</span>' : '')
    + '<span class="sb-lb-story">' + esc(storyWord(pick)) + '</span>'
    + (book && book.reachable && pick.frame ? '<a class="ext" href="' + esc(managerUrl(book, pick)) + '" target="_blank" rel="noopener">' + sym('open') + ' ' + esc(t('stories.openInStorybook')) + '</a>' : '')
    + '<button class="x" onclick="closeStoryLightbox()" aria-label="' + esc(t('stories.close')) + '" title="' + esc(t('stories.close')) + '">✕</button></div>'
    + '<div class="sb-lb-body"><nav class="sb-lb-list" aria-label="' + esc(t('stories.title')) + '">'
    + list.map((s) => '<button class="sb-lb-item' + (s.id === pick.id ? ' on' : '') + '" aria-current="' + (s.id === pick.id ? 'true' : 'false') + '" onclick="storyPick(' + jsArg(n.id) + ',' + jsArg(s.id) + ')">'
      + '<span class="nm">' + esc(storyWord(s)) + '</span>' + (s.docs ? '<span class="d">' + storyDocHtml(s.docs) + '</span>' : '') + '</button>').join('')
    + '</nav><div class="sb-lb-stage">' + picture
    + (lens !== 'business' && pick.file ? '<div class="rd sb-where">' + esc(pick.file + ':' + pick.line) + vsl(repo, pick.file, pick.line) + '</div>' : '')
    + '</div></div></div>';
}

/** Esc closes the large view before the central keymap sees the key (capture). @group Stories */
function storyLightboxKey(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation(); e.preventDefault();
  closeStoryLightbox();
}
/** Tear the large view down and drop its key listener. @group Stories */
export function closeStoryLightbox() {
  const el = document.getElementById('sb-lb');
  if (el) el.remove();
  document.removeEventListener('keydown', storyLightboxKey, true);
}

/** renders adjacency, built once per loaded graph. @group Stories */
let RENDERS = { graph: null, out: null };
/**
 * The parts of a screen that can be seen on their own: the screen node, the
 * components it names, and what it renders within two hops (the page → its
 * page component → the parts on it) that carry stories — never a part tagged
 * `plumbing`: a primitive every screen uses is a helper here, as it is in the
 * journey, and stays one click away in the inspector.
 * @group Stories
 */
export function screenStoryIds(n, extra) {
  if (!n || !S.GRAPH) return [];
  if (RENDERS.graph !== S.GRAPH) {
    const out = new Map();
    for (const e of S.GRAPH.edges || []) {
      if (e.kind !== 'renders') continue;
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from).push(e.to);
    }
    RENDERS = { graph: S.GRAPH, out };
  }
  const ids = [n.id].concat(extra || []);
  let frontier = ids.slice();
  for (let hop = 0; hop < 2; hop++) {
    const next = [];
    for (const id of frontier) for (const to of RENDERS.out.get(id) || []) { ids.push(to); next.push(to); }
    frontier = next;
  }
  return ids.filter((id) => {
    const x = S.BYID[id];
    return x && (x.stories || []).length && !(x.tags || []).includes('plumbing');
  });
}

/**
 * Story chips for the parts a journey screen shows: one chip per node that
 * carries stories — the screen itself and each component it renders — opening
 * the large view. Empty when none does, so a journey with no stories is
 * unchanged.
 * @group Stories
 * @business The parts of this screen that can be seen on their own.
 */
export function storyChipsHtml(ids) {
  const seen = new Set();
  const chips = [];
  for (const id of ids || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const n = S.BYID[id] || (S.GRAPH && S.GRAPH.nodes.find((x) => x.id === id));
    const count = n && (n.stories || []).length;
    if (!count) continue;
    chips.push('<button class="api-chip sb-chip" onclick="event.stopPropagation();openStoryLightbox(' + jsArg(id) + ')"' + tipAttrs({ key: 'stories.title', noFocus: true }) + '>'
      + sym('story') + esc(bizLabel(n)) + ' · ' + esc((count === 1 ? t('stories.countOne') : t('stories.count')).replace('{n}', count)) + '</button>');
  }
  return chips.length ? '<div class="sb-chips" onclick="event.stopPropagation()">' + chips.join('') + '</div>' : '';
}

/**
 * The catalogue on the front door: each Storybook the graph recorded — where
 * it runs, whether it answered, what its index matched — then every component
 * with stories, grouped by the first part of its title, each opening the large
 * view. Nothing at all when no repo in scope carries stories or a Storybook.
 * @group Stories
 * @business Every part of the product that can be seen on its own, grouped the way the design system files them.
 */
export function storiesCatalogueHtml() {
  const meta = (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.stories) || {};
  if (!Object.values(meta).some((m) => (m.storybooks || []).length || m.stories)) return '';
  setTimeout(() => loadStories(false).then(fillCatalogue), 0);
  return '<section class="sb-cat-wrap"><h2' + defAttrs('stories.catalogue.title') + '>' + sym('story') + ' ' + esc(t('stories.catalogue.title')) + '</h2>'
    + '<p class="sub">' + esc(t('stories.catalogue.sub')) + '</p><div id="sb-cat">' + catalogueBodyHtml() + '</div></section>';
}

/**
 * The catalogue's *n of m matched* with its tip: the typed count the server
 * sends (`storybooks[].counted.matched`, stories and docs pages apart), or the
 * two numbers it is printed from when an older server sends none.
 * @group Stories
 */
function matchedTip(live, c) {
  const k = live && live.counted && live.counted.matched;
  if (k) {
    return plainTip(k.n, 'stories.catalogue.matched', k.scope, '/api/stories',
      (k.breakdown || []).map((p) => [countWords(p.key, p.n).replace(String(p.n), '').trim(), p.n]), 'stories.catalogue.matched', { m: k.of != null ? k.of : c.resolved + c.unresolved });
  }
  return plainTip(c.resolved, 'stories.catalogue.matched', 'count.scope.storybook', '/api/stories', null, null, { m: c.resolved + c.unresolved });
}

/** Redraw the catalogue's inside once the live answer is in. @group Stories */
function fillCatalogue() {
  const el = document.getElementById('sb-cat');
  if (el) el.innerHTML = catalogueBodyHtml();
}

/** The catalogue from the graph's nodes and the live answer, in scope. @group Stories */
function catalogueBodyHtml() {
  const meta = (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.stories) || {};
  const scoped = S.scope === 'all' || !S.scope || !S.scope.length ? null : new Set(S.scope);
  const lens = currentLens();
  const nodes = (S.GRAPH.nodes || []).filter((n) => (n.stories || []).length || (LIVE.answer && LIVE.answer.byNode && LIVE.answer.byNode[n.id]))
    .filter((n) => !scoped || scoped.has(repoOf(n)));
  const books = Object.entries(meta).filter(([repo]) => !scoped || scoped.has(repo))
    .flatMap(([repo, m]) => (m.storybooks || []).map((ref) => ({ repo, ref, live: bookStatus(repo, ref.configDir) })));
  const bookRows = books.map(({ repo, ref, live }) => {
    const reached = live && live.reachable;
    const c = live && live.counts;
    return '<div class="sb-book">' + '<span class="sb-book-name">' + esc(ref.name || repo) + '</span>'
      + (reached ? '<span class="api-chip ok"' + defAttrs('stories.running') + '>' + esc(t('stories.running')) + '</span>'
        : LIVE.answer ? '<span class="api-chip warn">' + sym('absent') + esc(t('journey.absent.notReached')) + '</span>' : '')
      + (ref.url && /^https?:\/\//i.test(ref.url) ? '<a class="ext" href="' + esc(ref.url) + '" target="_blank" rel="noopener">' + sym('open') + ' ' + esc(ref.url) + '</a>' : '')
      + (lens !== 'business' ? '<span class="sb-book-dir">' + esc(ref.configDir) + '</span>' : '')
      + (c ? '<span class="sb-book-n"' + matchedTip(live, c) + '>' + esc(t('stories.catalogue.matched').replace('{n}', c.resolved).replace('{m}', c.resolved + c.unresolved)) + '</span>' : '')
      + (c && c.unresolved ? '<span class="api-chip warn"' + plainTip(c.unresolved, 'stories.catalogue.unresolved', 'count.scope.storybook', '/api/stories') + '>' + esc(t('stories.catalogue.unresolved').replace('{n}', c.unresolved)) + '</span>' : '')
      + (live && (live.notListed || []).length ? '<span class="api-chip warn"' + plainTip(live.notListed.length, 'stories.catalogue.notListed', 'count.scope.storybook', '/api/stories') + '>' + esc(t('stories.catalogue.notListed').replace('{n}', live.notListed.length)) + '</span>' : '')
      + (live && !reached ? notReachedHtml(live, repo) : '') + '</div>';
  }).join('');
  const groups = new Map();
  for (const n of nodes) {
    const list = storiesOf(n);
    const title = (list.find((s) => s.title) || {}).title || '';
    const group = title.includes('/') ? title.split('/').slice(0, -1).join(' / ') : t('stories.catalogue.ungrouped');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ n, list });
  }
  const groupHtml = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, items]) => '<div class="sb-group"><span class="hud-label">' + esc(g) + ' · <span class="cnt"'
    + plainTip(items.length, 'surf.stories.components', 'surf.scope.storyGroup', '/api/stories') + '>' + items.length + '</span></span><div class="sb-grid">'
    + items.sort((a, b) => bizLabel(a.n).localeCompare(bizLabel(b.n))).map(({ n, list }) => {
      const k = list.filter((s) => s.type === 'story').length;
      return '<button class="sb-card" onclick="openStoryLightbox(' + jsArg(n.id) + ')">' + sym('story')
        + '<span class="nm">' + esc(bizLabel(n)) + '</span>'
        + '<span class="ct"' + plainTip(k, 'stories.count', 'count.scope.component', '/api/stories', null, null) + '>' + esc((k === 1 ? t('stories.countOne') : t('stories.count')).replace('{n}', k)) + '</span>'
        + (lens !== 'business' ? '<span class="cd">' + esc(n.name) + '</span>' : '') + '</button>';
    }).join('') + '</div></div>').join('');
  return bookRows + (groupHtml || '<p class="set-note">' + esc(t('stories.none')) + '</p>');
}

expose({ storyPick, storiesRetry, openStoryLightbox, closeStoryLightbox });
