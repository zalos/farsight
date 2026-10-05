// shell.js — the viewer shell: hash router + nav + chrome (sync chip,
// READ-ONLY, register toggle, Share, keymap), role-based landing, plus the
// chrome-owned panels moved from viewer.js (lens/theme/scope/chips, search
// palette + focus, settings page, Model Hub overlay). Entry module.

import { S, expose, esc, jsArg, loadAll, hydrateScope, indexGuards, collSourceNames, scopedRepos, inScope, bizLabel, bizName, humanize, effectiveGroup, currentLens, cssId, repoOf } from './store.js';
import { buildSearchIndex, searchIndex } from './lib/search-model.js';
import { t, def, initRegister, onRegisterChange, toggleRegister } from './strings.js';
import { sym, grammarHtml } from './sym.js';
import { render, select, scopeLabel, closeCtx, refreshStats, cardOf } from './lib/graph-render.js';
import { mountJourneys, hideJourneyOverlay, journeysRefresh } from './surfaces/journeys.js';
import { cmapScopeHtml, projectTravelItems } from './surfaces/codemap-projects.js';
import { pickerHasQuery } from './lib/multi-pick.js';
import { mountCodemap, unmountCodemap, codemapRefresh } from './surfaces/codemap.js';
import { mountPortfolio, portfolioRefresh } from './surfaces/portfolio.js';
import { mountChanges, changesRefresh } from './surfaces/changes.js';
import { mountStewardship } from './surfaces/stewardship.js';
import { mountApis, apisRefresh } from './surfaces/apis.js';
import { mountTests, testsRefresh } from './surfaces/tests.js';
import { mountWork, workRefresh } from './surfaces/work.js';
import { mountMap, mapRefresh, mapUpdate, unmountMap, mapEnabled, mapOpen, mapTravel } from './surfaces/map.js';
import { closeShare } from './share.js';
import { initKeymap } from './keymap.js';
import { impactFromRoute } from './impact.js';
import './provenance.js';
import { initTips, registerTip, tableTip, linksTip, setTip, grammarHref, tipAttrs, tipOpen } from './lib/tooltip.js';
import { plainTip } from './lib/counted.js';

// ── router ──────────────────────────────────────────────────────
// `map` is behind the workspace's `flags.map` (Settings → Experiments): `navTabs()` leaves it out when off
const NAV = ['portfolio', 'journeys', 'map', 'codemap', 'apis', 'tests', 'changes', 'work'];
/** The tabs the bar draws: NAV without the surfaces a workspace flag keeps off. @group Shell */
export function navTabs() { return NAV.filter((s) => s !== 'map' || mapEnabled()); }
/**
 * The surfaces, each with how it is mounted, unmounted, and — the contract the
 * filters run on — how it is **refreshed in place**.
 *
 * `refresh(reason, route)` is called when something outside the route changes
 * what the surface should be showing. Four reasons, and the split that matters
 * runs between the first two and the last two:
 *
 *   - `'lens'` · `'register'` — the **words** changed. Every fact the surface
 *     holds is still true, so it redraws from what it already fetched.
 *   - `'scope'` · `'sync'` — the **facts** changed. The scope moved which
 *     sources answer; a sync replaced the graph underneath. Ask again.
 *
 * A surface that declares a `refresh` decides for itself which reason means
 * what. A surface that declares none is re-mounted — an honest fallback,
 * because a surface that silently ignores a filter tells the reader the filter
 * does not apply when in truth nobody wired it.
 */
const SURFACES = {
  portfolio: { mount: mountPortfolio, refresh: portfolioRefresh },
  journeys: { mount: mountJourneys, unmount: hideJourneyOverlay, refresh: journeysRefresh },
  codemap: { mount: mountCodemap, unmount: unmountCodemap, refresh: codemapRefresh },
  apis: { mount: mountApis, refresh: apisRefresh },
  tests: { mount: mountTests, refresh: testsRefresh },
  changes: { mount: mountChanges, refresh: changesRefresh },
  work: { mount: mountWork, refresh: workRefresh },
  // `update(route)`: the route moved inside the surface (another journey, a screen
  // opened, the back button) — the board keeps its place instead of re-mounting
  map: { mount: mountMap, unmount: unmountMap, refresh: mapRefresh, update: mapUpdate },
  stewardship: { mount: mountStewardship },
  grammar: { mount: mountGrammar, refresh: refreshGrammar },
};
let currentSurface = null;

/**
 * Tell the surface on screen that the scope, the lens or the register moved.
 *
 * Before this existed each filter hand-wired the surfaces it happened to know
 * about: `applyScope()` redrew the code map and nothing else, and `setLens()`
 * called two named per-surface hooks. Every other surface kept the previous
 * filter's content until the reader navigated away and back, which re-mounted
 * it — so the filter looked broken on five of seven surfaces and, worse, looked
 * *applied* on a table that had not moved.
 *
 * One dispatch, one contract. Nothing is re-mounted on a reason a surface has
 * declared it can handle.
 * @group Shell
 */
export function refreshSurface(reason) {
  const surface = currentSurface && SURFACES[currentSurface];
  if (!surface) return;
  const el = document.getElementById('surface');
  if (surface.refresh) surface.refresh(reason, S.route);
  else if (el && S.route) { el.innerHTML = ''; surface.mount(S.route, el); }
  // the status bar's shown/hidden count is drawn on every surface but computed
  // from the map's display list; the Code map's own refresh recomputes it on the
  // way through render(), so only the others ask for it here
  if (reason === 'scope' && currentSurface !== 'codemap') refreshStats();
}

/**
 * The three kinds of range `#/changes/<base>...<head>` can name, read back from
 * the param — two syncs of the graph, two declared releases, or two commits.
 *
 * Returns `{kind, base, head}` or **null**, and null is the honest answer for
 * anything else: a prefix this grammar does not know, one end a sync and the
 * other a commit, or `sync:` ends that are not numbers. A route that quietly
 * read an unknown param as the kind it most resembles would render one view
 * under another view's link, which is the defect the 2026-09-23 swarm found in
 * a retired deep-link parameter ("a shared link can silently render something
 * else"). The surface says it cannot read the link instead.
 *
 * `rel:` and `commit:` are accepted here and resolved by the surface, which is
 * where the workspace's declared releases and the snapshot spine are known: a
 * commit range carries a measured difference only where a sync bracketed it.
 * @group Shell
 */
export function parseRange(param) {
  if (!param) return null;
  const m = /^(?:(sync|rel|commit):)?([\w.-]+)\.\.\.(?:(sync|rel|commit):)?([\w.-]+)$/.exec(param);
  if (!m) return null;
  // a range is two ends of one kind; naming two different kinds is not a range
  if (m[1] && m[3] && m[1] !== m[3]) return null;
  const numeric = /^\d+$/.test(m[2]) && /^\d+$/.test(m[4]);
  const kind = m[1] || m[3] || (numeric ? 'sync' : null);
  if (!kind) return null;
  if (kind === 'sync' && !numeric) return null;
  return { kind, base: m[2], head: m[4], raw: param };
}

/**
 * Parse the location hash into {surface, param, range, sync, scope, view, lens, band, repo, node, op, line}.
 * Grammar: #/<surface>[/<param>][@sync:N][?scope=…&view=…&lens=…&band=…&dock=…&biz=…&repo=…&node=…&op=…&line=N&impact=<id>&hops=N&z=…&x=…&y=…&card=<kind>:<id>]
 * — sync and scope are parsed and carried in the store even where not yet
 * consumed (P1 snapshots / P3 scope model consume them: nothing re-renders from
 * `@sync:N` yet — `farsight serve --as-of sync:N` is what serves an older
 * snapshot today, so no surface may offer that hash as a way to see one); node deep-links the
 * Code map to one card, op/line deep-link the APIs surface to one operation /
 * one spec line; lens picks the register a shared link opens in, view picks
 * the journey's visual (storyboard | timeline | sheet | drill — the last behind a workspace flag), band the system band's shape
 * (rows | ladder).
 * @group Shell
 */
export function parseRoute() {
  let h = location.hash || '';
  if (!h.startsWith('#/')) return null;
  h = h.slice(2);
  let query = '';
  const qi = h.indexOf('?');
  if (qi >= 0) { query = h.slice(qi + 1); h = h.slice(0, qi); }
  let sync = null;
  const sm = h.match(/@sync:(\d+)$/);
  if (sm) { sync = +sm[1]; h = h.slice(0, sm.index); }
  const segs = h.split('/').filter(Boolean);
  const q = new URLSearchParams(query);
  const param = segs.slice(1).join('/') || null;
  return {
    surface: segs[0] || '',
    param,
    // the Changes grammar: `sync:N...sync:M` · `rel:<a>...rel:<b>` · `commit:<a>...<b>`
    // (bare numbers are syncs). null where the param is not a range — including a
    // param this grammar cannot read, which is never relabelled into a kind it is
    // merely like.
    range: parseRange(param),
    sync,
    scope: q.get('scope'),
    view: q.get('view') || 'map',
    // the Tests surface's level filter: all | unit | integration | e2e
    level: q.get('level'),
    lens: q.get('lens'),
    band: q.get('band'),
    dock: q.get('dock'),
    // the business lane's open view: words | gates | decisions
    biz: q.get('biz'),
    repo: q.get('repo'),
    node: q.get('node'),
    // the code map's grouping (none | project | a tag dimension) and its two views' subjects
    group: q.get('group'),
    project: q.get('project'),
    // the Journeys front door's filters: one persona (`persona=`) and one group of journeys (`group=`, shared with the code map's grouping)
    persona: q.get('persona'),
    // the code map's tag filter (`tag=domain:billing,type:ui`) and the project box fast travel arrives at
    tag: q.get('tag'),
    box: q.get('box'),
    package: q.get('package'),
    op: q.get('op'),
    line: q.get('line') ? +q.get('line') : null,
    // what-uses-this, deep-linked: the seed and the distance the reader had open
    // the Grammar Book opened at one entry (a tip's *In the Grammar Book* link)
    key: q.get('key'),
    impact: q.get('impact'),
    hops: q.get('hops') ? +q.get('hops') : null,
    // the WORK surface's filters: one tracker, one state category, one person, the words typed, one journey
    source: q.get('source'),
    state: q.get('state'),
    assignee: q.get('assignee'),
    q: q.get('q'),
    flow: q.get('flow'),
    // the Map's picture (§K): its scale and the world point at the middle, and the explore card open (`<kind>:<nodeId>`)
    z: q.get('z'),
    x: q.get('x'),
    y: q.get('y'),
    card: q.get('card'),
    // the Map's Affected mode (lane I): the seed the board is dimmed around and how far out it asks
    affected: q.get('affected'),
    ahops: q.get('ahops') ? +q.get('ahops') : null,
    raw: location.hash,
  };
}

/**
 * Apply the current hash: unmount the previous surface, set the body's
 * surface class, mount the new surface into #surface (or the graph frame),
 * refresh the nav. Unknown/empty routes land on the settings' defaultSurface
 * — a default, never a cage: a deep link always wins.
 * @group Shell
 */
export function applyRoute() {
  let r = parseRoute();
  if (!r || !SURFACES[r.surface]) {
    const dflt = defaultSurface();
    history.replaceState(null, '', '#/' + dflt);
    r = parseRoute();
  }
  // the map is a workspace experiment: with its flag off a #/map link reads as the Portfolio
  if (r.surface === 'map' && !mapEnabled()) {
    history.replaceState(null, '', '#/portfolio');
    r = parseRoute();
  }
  S.route = r;
  // a shared link may name the register and the journey band's shape it was written in
  if (r.lens && /^(business|hybrid|code)$/.test(r.lens) && currentLens() !== r.lens) setLens(r.lens, true);
  if (r.band === 'ladder' || r.band === 'rows') S.jrnView = r.band;
  // …and which journey visual it was written in (the view axis; deep link wins over persistence)
  if (r.surface === 'journeys' && /^(storyboard|timeline|sheet|drill)$/.test(r.view || '')) S.jrnLayout = r.view;
  if (r.surface === 'journeys' && /^(inline|bottom|right)$/.test(r.dock || '')) S.jrnDock = r.dock;
  if (r.surface === 'journeys' && /^(words|gates|decisions)$/.test(r.biz || '')) S.jrnBiz = r.biz;
  // the same surface, a new place inside it: a surface that can follow its own route keeps its state
  if (currentSurface === r.surface && SURFACES[r.surface].update && document.getElementById('surface').childElementCount) {
    SURFACES[r.surface].update(r);
    renderChrome();
    impactFromRoute(r);
    return;
  }
  if (currentSurface && currentSurface !== r.surface) {
    const u = SURFACES[currentSurface].unmount;
    if (u) u();
  }
  currentSurface = r.surface;
  // A focus is the code map's filter. Closing a journey used to leave one behind
  // on whatever surface it returned to — `focus: POC…` in the search box, an
  // *exit focus* chip and a status bar cut to 122 of 1678, on a page the focus
  // does nothing to (pass swarm 2026-09-25). Off the map, it is dropped.
  if (r.surface !== 'codemap' && S.focusSet) dropFocus();
  document.body.className = document.body.className.replace(/\bsurface-[\w-]+\b/g, '').replace(/\s+/g, ' ').trim();
  document.body.classList.add('surface-' + r.surface);
  const surfEl = document.getElementById('surface');
  surfEl.innerHTML = '';
  SURFACES[r.surface].mount(r, surfEl);
  const graphMode = document.body.classList.contains('surface-graph');
  surfEl.style.display = graphMode ? 'none' : '';
  renderChrome();
  // The status bar's shown/hidden count is global chrome, drawn on every surface,
  // but only the Code map's own render() used to write it — so a session that
  // landed anywhere else (and since B2.2 the business and hybrid registers land
  // on Journeys) read `loading…` in the bottom-left for as long as it stayed
  // there. Nothing was loading: the graph was in hand, the count simply had no
  // writer. Every other surface asks for it here, once it has mounted.
  if (r.surface !== 'codemap') refreshStats();
  // a shared link may also name what the reader was asking "what uses this?" about
  impactFromRoute(r);
}

/**
 * Where an unrouted visit lands. An explicit `defaultSurface` in the workspace
 * settings always wins — a default is a default, never a cage. With none, the
 * register decides: the business and hybrid readers open on the product (its
 * journeys), the code reader on the code map. Landing everyone on a map of the
 * repository asked a business reader to understand the tool before the app
 * (R17, the brief's bar).
 * @group Shell
 */
export function defaultSurface() {
  const chosen = S.SETTINGS && S.SETTINGS.defaultSurface;
  if (chosen && SURFACES[chosen]) return chosen;
  return currentLens() === 'code' ? 'codemap' : 'journeys';
}

/** The Grammar Book route — rendered entirely from sym.js + the catalog.
 * @group Grammar */
function mountGrammar(route, el) {
  el.innerHTML = grammarHtml(S.STRINGS);
  grammarShowKey(route && route.key);
}
/** Scroll the book to one entry and mark it — where a tip's book link lands.
 * @group Grammar */
function grammarShowKey(key) {
  if (!key) return;
  const row = document.getElementById('gb-k-' + key);
  if (!row) return;
  row.classList.add('gb-hit');
  row.scrollIntoView({ block: 'center' });
}

/**
 * The book is the catalog, so it redraws for a register or lens change and is
 * unmoved by the source scope — it describes the words, not any one workspace.
 * @group Grammar
 */
function refreshGrammar(reason) {
  if (reason === 'scope') return;
  const el = document.getElementById('surface');
  if (el) el.innerHTML = grammarHtml(S.STRINGS);
  grammarShowKey(S.route && S.route.key);
}

// ── chrome ──────────────────────────────────────────────────────
/** Compact "n min/h/d ago" for the sync chip.
 * @group Shell */
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1 min ago';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  return Math.floor(h / 24) + ' d ago';
}
/**
 * Sync chip: LIVE dot + sync ordinal (when P1's snapshots provide one) and
 * age while fresh; amber clock + the word STALE past seven days (G19: STALE
 * is always clock + word, and amber stays in the attention family).
 * @group Shell
 */
function syncChipHtml() {
  const meta = (S.GRAPH && S.GRAPH.meta) || {};
  // the details — workspace, sync, when, which build — are the chip's tip
  // (`syncChipTip`), not a title attribute: a table the reader can open with a
  // click or a keypress, and whose code rows the business lens leaves out
  if (!meta.generatedAt) return '<span class="syncchip" data-tip="chrome.sync" tabindex="0">' + sym('stale') + ' <b>' + esc(t('status.stale')) + '</b> · ' + esc(t('chrome.syncNever')) + '</span>';
  const ms = Date.now() - Date.parse(meta.generatedAt);
  // every identity says what it is: a bare hash in the chip was read as the
  // Farsight build as often as the source commit (the clarity pass §3.3.5)
  const ident = esc(t('chrome.identity')
    .replace('{commit}', meta.commit ? String(meta.commit).slice(0, 7) : t('journey.absent.notIndexed'))
    .replace('{build}', (S.VERSION && S.VERSION.farsight && S.VERSION.farsight.commit) || (meta.farsight && meta.farsight.commit) || t('journey.absent.notIndexed'))
    .replace('{n}', meta.sync != null ? String(meta.sync) : t('journey.absent.notIndexed')));
  // which graph: workspace name in the chip, graph path + time in the tip — a server
  // started in another workspace is caught at a glance, not after a debugging round
  const ws = meta.workspace ? '<b class="ws">' + esc(meta.workspace) + '</b> · ' : '';
  const restart = restartNeeded(S.VERSION) ? ' · <b class="restart">' + esc(t('chrome.restartNeeded')) + '</b>' : '';
  const tip = ' data-tip-id="syncChip" tabindex="0"';
  // the words ride in a .ct span so a narrow window ellipsises the chip instead of
  // cutting the workspace name mid-letter; the whole line stays in the tip
  if (ms >= 7 * 864e5) return '<span class="syncchip stale"' + tip + '>' + sym('stale') + '<span class="ct"> <b>' + esc(t('status.stale')) + '</b> · ' + ws + esc(t('chrome.synced')) + ' ' + esc(ago(ms)) + '</span></span>';
  return '<span class="syncchip' + (restart ? ' restart' : '') + '"' + tip + '>' + sym(restart ? 'warning' : 'live') + '<span class="ct"> ' + ws + ident + ' · ' + esc(ago(ms)) + restart + '</span></span>';
}
/**
 * Whether the chip says RESTART — read from `/api/version`'s `install`, where
 * the server decides it build to build (core `installState` → `sameBuild`,
 * `install.basis: 'build'`), the same decision `farsight status` and its
 * `currency` findings print. The viewer compares no dates of its own: a rebuild
 * of the same clean commit is not a restart, a different build is.
 * @group Shell
 */
export function restartNeeded(v) {
  return !!(v && v.install && v.install.newerInstalled);
}
/**
 * The sync chip's tip — the exemplar of a tip that is a table: which graph,
 * which sync, when, and the builds on either side of it. The source commit,
 * the builds and the graph file are code rows, so the business lens reads the
 * workspace, the sync and its age and nothing a developer would have to decode.
 * Built when it opens, so it reads `/api/version` if that has arrived since.
 * @group Shell
 */
function syncChipTip() {
  const meta = (S.GRAPH && S.GRAPH.meta) || {};
  const v = S.VERSION || {};
  const bl = (b) => (b ? b.version + ' · ' + t('chrome.built') + ' ' + String(b.built).replace('T', ' ').slice(0, 16) + (b.commit ? ' · ' + b.commit : '') : '');
  const when = meta.generatedAt ? ago(Date.now() - Date.parse(meta.generatedAt)) + ' · ' + String(meta.generatedAt).replace('T', ' ').slice(0, 19) : '';
  const cur = v.currency;
  const rows = [
    meta.workspace ? ['chrome.workspace', meta.workspace] : null,
    meta.sync != null ? ['tip.syncChip.sync', String(meta.sync)] : null,
    when ? ['tip.syncChip.when', when] : null,
    meta.commit ? { cells: ['tip.syncChip.commit', String(meta.commit).slice(0, 12)], code: true } : null,
    v.farsight ? { cells: ['chrome.build', bl(v.farsight)], code: true } : null,
    // the build on disk beside the one running: the pair RESTART is decided on
    v.install && v.install.installed ? { cells: ['chrome.buildInstalled', bl(Object.assign({ version: v.farsight ? v.farsight.version : '' }, v.install.installed))], code: true } : null,
    meta.farsight ? { cells: ['chrome.graphIngestedBy', bl(meta.farsight)], code: true } : null,
    meta.graphPath ? { cells: ['chrome.graphFile', meta.graphPath], code: true } : null,
    restartNeeded(v) ? ['chrome.restartNeeded', def('chrome.restartNeeded')] : null,
    ...(cur && !cur.ok ? (cur.findings || []).map((f) => ({ cells: ['tip.syncChip.attention', f], code: true })) : []),
  ].filter(Boolean);
  return tableTip({ caption: 'tip.syncChip.head', rows })
    + '<p class="tip-p">' + esc(def('chrome.sync')) + '</p>'
    + linksTip([{ label: 'nav.changes', href: '#/changes' }, { label: 'tip.grammar', href: grammarHref('chrome.sync') }]);
}
registerTip('syncChip', syncChipTip);
/**
 * (Re)render the register-sensitive chrome: nav tabs, sync chip, READ-ONLY
 * chip, register toggle, search label.
 * @group Shell
 */
export function renderChrome() {
  const nav = document.getElementById('nav');
  const cur = S.route && S.route.surface;
  // One order in every register. The code register used to put the map first
  // (R26), so the first tab stopped meaning Portfolio the moment a reader
  // switched — and a reader who clicks by position landed on another page (pass
  // swarm 2026-09-25, three reviewers). Where each register *lands* still
  // differs (defaultSurface); where each tab *sits* does not.
  if (nav) nav.innerHTML = navTabs().map((s) => '<button class="navtab' + (cur === s ? ' on' : '') + '"'
    + tipAttrs({ key: 'nav.' + s, noFocus: true })
    + ' onclick="location.hash=\'#/' + s + '\'">' + esc(t('nav.' + s)) + '</button>').join('');
  const sc = document.getElementById('syncchipwrap');
  if (sc) sc.innerHTML = syncChipHtml();
  const ro = document.getElementById('readonly');
  if (ro) { ro.textContent = t('sys.readonly'); ro.removeAttribute('title'); setTip(ro, { text: t('sys.readonlySub') }); }
  const reg = document.getElementById('regtoggle');
  if (reg) { reg.textContent = t(S.register === 'hud' ? 'chrome.registerToPro' : 'chrome.registerToHud'); setTip(reg, { key: 'surf.chrome.register' }); }
  // the gear opens Settings (it read as a theme toggle): its tip says what is behind it
  const gear = document.getElementById('gearbtn');
  if (gear) { gear.removeAttribute('title'); setTip(gear, { key: 'surf.chrome.settings' }); }
  if (!S.focusSet) document.getElementById('searchlabel').textContent = t('chrome.search');
  document.getElementById('focuschip').innerHTML = '✕ ' + esc(t('chrome.exitFocus'));
  document.getElementById('pinput').placeholder = t('palette.placeholder');
  const shareBtn = document.getElementById('sharebtn');
  if (shareBtn) shareBtn.textContent = t('chrome.share');
  // the tag chips are words in the business lens and the code's labels elsewhere
  if (S.GRAPH) buildChips();
  // the register's words change the controls' widths, so the fit is re-measured
  // every time the chrome is redrawn — never assumed from the last measurement
  fitTopbar();
}

// ── the top bar's fit (the overflow menu) ───────────────────────────────
/**
 * The controls the bar may fold away, in the order it gives them up.
 *
 * Least essential first, so the two the 2026-09-24 review named as unreachable
 * *and* irreplaceable are the last to go: `?` is the only route to the keymap,
 * and Settings is the only route to the sources, the theme and the flags. A
 * control that folds is not hidden — it moves into the ⋯ menu with its own
 * words intact, which is why the menu re-hosts the real element instead of
 * drawing a copy of it. One control, one accessible name, one place it lives.
 * @group Shell
 */
const TOPBAR_FOLD = ['hubbtn', 'sharewrap', 'regtoggle', 'readonly', 'kmbtn', 'gearbtn', 'nav'];
/**
 * Fold the bar until it fits the window.
 *
 * The bar is one nowrap row ~1720px wide. Below that it used to lose its right
 * end silently — `overflow-x:hidden` on the body meant there was not even a
 * scrollbar to say a control existed. Measured: at 1440, five controls sat
 * entirely off-screen and stayed in the tab order, so a keyboard user focused
 * things they could not see.
 *
 * Measure, fold one, measure again — the loop reads the DOM rather than a
 * breakpoint, because the identity chip's width depends on the workspace name
 * and the register's words, so no fixed width is true for every workspace.
 * @group Shell
 */
export function fitTopbar() {
  const bar = document.querySelector('.topbar');
  const wrap = document.getElementById('morewrap');
  const menu = document.getElementById('moremenu');
  const btn = document.getElementById('morebtn');
  if (!bar || !wrap || !menu || !btn) return;
  const el = (k) => document.getElementById(k === 'sharewrap' ? 'sharebtn' : k);
  // start from the whole bar: unfold everything, then fold only what has to go
  for (const k of TOPBAR_FOLD) {
    const c = el(k);
    const host = k === 'sharewrap' && c ? c.closest('.share-wrap') : c;
    if (host && host.parentElement === menu) bar.insertBefore(host, wrap);
  }
  menu.querySelectorAll('.fs-morelbl').forEach((n) => n.remove());
  wrap.style.display = 'none';
  menu.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
  // While fitting, the identity chip is measured at its full width: a control
  // that folds gets a home in the menu, but the chip — which says which
  // workspace, which source commit, which build and which sync — has nowhere
  // else to be said. So squeezing it is the *last* resort, after every
  // foldable control has folded; its ellipsis and its tooltip are the backstop
  // for a workspace whose name is longer than any window.
  const chip = document.getElementById('syncchipwrap');
  if (chip) { chip.style.flexShrink = '0'; chip.style.minWidth = ''; }
  const fits = () => bar.scrollWidth <= bar.clientWidth + 1;
  let folded = 0;
  const fold = (k) => {
    const c = el(k);
    const host = k === 'sharewrap' && c ? c.closest('.share-wrap') : c;
    if (!host || host.parentElement === menu) return;
    if (!folded) wrap.style.display = '';
    menu.appendChild(host);
    // `?` and the gear carry a glyph and no word — fine beside their neighbours in
    // the bar, unreadable as a menu row. Folded, they borrow their own accessible
    // name, so the menu never lists a button nobody can identify.
    const label = host.getAttribute && host.getAttribute('aria-label');
    if (label && host.textContent.trim().length < 3) {
      const l = document.createElement('span');
      l.className = 'fs-morelbl'; l.textContent = label;
      host.appendChild(l);
    }
    folded++;
  };
  // the priority ladder, in order: fold the action controls · then squeeze the
  // identity chip · then, only in a window too narrow for the register's own nav
  // words (HUD's tabs run 717px at 1100), fold the nav itself. Every rung has a
  // home in the ⋯ menu; the rung that has none — a control simply off the edge —
  // is the defect this replaced.
  for (const k of TOPBAR_FOLD) {
    if (k === 'nav') continue;
    if (fits()) break;
    fold(k);
  }
  if (chip) chip.style.flexShrink = '';
  if (!fits() && chip) chip.style.minWidth = '0';
  if (!fits()) fold('nav');
  if (!folded) { wrap.style.display = 'none'; return; }
  btn.innerHTML = sym('more') + '<span class="cnt">' + folded + '</span>';
  btn.setAttribute('aria-label', t('chrome.more'));
  btn.removeAttribute('title');
  // the count's tip names what it counts — the controls folded away, by name
  const nameOf = (n) => (n.id === 'nav' ? t('tip.more.nav')
    : n.classList.contains('share-wrap') ? nameOf(n.querySelector('button') || n)
      : (n.getAttribute('aria-label') || n.textContent || '').trim());
  const names = [...menu.children].map(nameOf).filter(Boolean);
  setTip(btn, { number: { count: folded, of: 'tip.more.of', scope: 'tip.more.scope', source: 'tip.more.source',
    breakdown: { rows: names.map((x) => [x]) }, grammarKey: 'chrome.more' } });
}
/** Open / close the overflow menu.
 * @group Shell */
export function toggleMore(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('moremenu');
  const btn = document.getElementById('morebtn');
  if (!menu || !btn) return;
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
/**
 * A click inside the overflow menu.
 *
 * The menu must not close on the outside-click handler (it would shut before the
 * control it holds could be pressed), but it must close once one of them has
 * fired — Settings and Model Hub open full-screen, and a menu left open behind
 * them swallows the next Escape and the next click. Share is the exception: its
 * own popover is drawn inside the menu, so closing would take the popover with
 * it.
 * @group Shell
 */
export function moreMenuClick(ev) {
  if (ev) ev.stopPropagation();
  const target = ev && ev.target;
  if (!target || !target.closest) return;
  if (target.closest('.share-wrap')) return;
  if (target.closest('button')) closeMore();
}
/** Close the overflow menu (outside click / Esc).
 * @group Shell */
export function closeMore() {
  const menu = document.getElementById('moremenu');
  const btn = document.getElementById('morebtn');
  if (menu) menu.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
/** True while the overflow menu is open (the Escape ladder asks).
 * @group Shell */
export function moreOpen() {
  const menu = document.getElementById('moremenu');
  return !!menu && menu.classList.contains('open');
}

// ── lens / theme / scope / chips ────────────────────────────────
/**
 * Switch the lens (business · hybrid · code).
 *
 * `quiet` is for the two callers that are already in the middle of doing this
 * work themselves — boot, and a deep link's `?lens=` inside `applyRoute()`,
 * which renders the chrome and mounts the surface a moment later. Everyone else
 * gets the full switch: the chrome is re-rendered (its words and its tips are
 * the lens's), and the surface on screen is told to redraw.
 * @group Lens, theme & filters
 */
export function setLens(l, quiet) {
  document.body.classList.remove('lens-business', 'lens-hybrid', 'lens-code');
  document.body.classList.add('lens-' + l);
  ['business', 'hybrid', 'code'].forEach((x) => document.getElementById('lb-' + x).classList.toggle('on', x === l));
  document.getElementById('lens-status').textContent = 'lens: ' + l;
  if (quiet) return;
  renderChrome();
  refreshSurface('lens');
}
/**
 * Apply a theme: `dark`, `light`, or `system` — the reader's own
 * `prefers-color-scheme`, which is also what a workspace that saved no theme
 * gets. A saved theme always wins over the system's.
 * @group Lens, theme & filters
 */
export function applyTheme(theme) {
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const follow = !theme || theme === 'system';
  document.documentElement.dataset.theme = follow ? (mq && mq.matches ? 'light' : 'dark') : theme;
  S.themeFollowsSystem = follow;
}
/**
 * Preview a theme chosen in Settings, without writing it. The theme used to be
 * seeable only by saving the workspace's shared settings file — on a server
 * that says READ-ONLY in its top bar — so every reviewer skipped the light
 * theme (pass swarm 2026-09-25). Choosing now applies it at once, for this
 * window only; **Save settings** is what writes it for everyone.
 * @group Lens, theme & filters
 */
export function previewTheme(theme) {
  S.themePreview = theme;
  applyTheme(theme);
  const note = document.getElementById('set-theme-note');
  const saved = S.SETTINGS && (S.SETTINGS.theme || 'system');
  if (note) note.textContent = theme !== saved ? t('surf.theme.preview') : '';
}
/**
 * Rebuild the scope button label + grouped multi-select menu. Collections act
 * as source groups: checking a group toggles all of its members, a partial
 * selection shows as indeterminate; sources outside every group list under
 * "ungrouped". Multiple sources and groups combine as a union.
 * @group Lens, theme & filters
 * @business The source picker: choose which systems (or groups of systems) the map shows.
 */
export function buildScope() {
  const btn = document.getElementById('scopebtn');
  if (btn) {
    btn.innerHTML = '◈ <span class="sc-lbl">' + esc(scopeLabel()) + '</span><span class="sc-caret">▾</span>';
    // how many sources the scope lets through, and which: the number every surface counts over
    const names = (S.SETTINGS.sources || []).map((x) => x.name).filter((x) => S.scope === 'all' || S.scope.includes(x));
    setTip(btn, { number: { count: names.length, of: 'count.unit.sources', scope: 'count.scope.workspace', source: { api: '/api/settings' },
      breakdown: { rows: names.map((x) => [x, 1]) }, grammarKey: 'scope.all' } });
  }
  const menu = document.getElementById('scopemenu');
  if (!menu) return;
  const colls = S.SETTINGS.collections || [], srcs = S.SETTINGS.sources || [];
  // *all* is every source: its boxes read checked, so "All sources" never sits
  // highlighted above an unchecked list that looks like nothing is selected
  const isOn = (n) => S.scope === 'all' || S.scope.includes(n);
  const inColl = new Set(); colls.forEach((c) => collSourceNames(c).forEach((n) => inColl.add(n)));
  const row = (name) => '<label class="sc-row"><input type="checkbox" ' + (isOn(name) ? 'checked' : '') + ' onchange="toggleScopeSrc(' + jsArg(name) + ')"/><span>' + esc(name) + '</span></label>';
  let html = '<button class="sc-all' + (S.scope === 'all' ? ' on' : '') + '" onclick="setScopeAll()">◈ ' + esc(t('scope.all')) + '</button>';
  colls.forEach((c, i) => {
    const names = collSourceNames(c);
    const all = !!names.length && names.every(isOn);
    html += '<div class="sc-group"><label class="sc-row sc-ghead"><input type="checkbox" data-coll-i="' + i + '" ' + (all ? 'checked' : '') + ' onchange="toggleScopeColl(' + i + ')"/><span>▤ ' + esc(c.name) + '</span><span class="sc-n">' + names.length + '</span></label>'
      + names.map(row).join('') + '</div>';
  });
  const rest = srcs.map((s) => s.name).filter((n) => !inColl.has(n));
  if (rest.length) html += '<div class="sc-group"><div class="sc-plain hud-label">' + esc(t(colls.length ? 'scope.ungrouped' : 'scope.sources')) + '</div>' + rest.map(row).join('') + '</div>';
  // on the code map: its own filters — projects, tag values, depends on (surfaces/codemap-projects.js)
  html += cmapScopeHtml();
  html += '<div class="sc-foot"><button class="sc-save" onclick="saveScopeGroup()" title="' + esc(t('scope.newGroupTitle')) + '">' + esc(t('scope.newGroup')) + '</button></div>';
  menu.innerHTML = html;
  colls.forEach((c, i) => {
    const names = collSourceNames(c);
    const box = menu.querySelector('input[data-coll-i="' + i + '"]');
    if (box) box.indeterminate = names.some(isOn) && !names.every(isOn);
  });
}
/**
 * @group Lens, theme & filters
 */
export function toggleScopeMenu(ev) {
  if (ev) ev.stopPropagation();
  closeCtx();
  const m = document.getElementById('scopemenu');
  const open = !m.classList.contains('open');
  m.classList.toggle('open', open);
  const b = document.getElementById('scopebtn');
  if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
}
/**
 * @group Lens, theme & filters
 */
export function closeScopeMenu() {
  const m = document.getElementById('scopemenu');
  if (m) m.classList.remove('open');
  const b = document.getElementById('scopebtn');
  if (b) b.setAttribute('aria-expanded', 'false');
}
/** @group Lens, theme & filters */
export function scopeMenuOpen() { const m = document.getElementById('scopemenu'); return !!m && m.classList.contains('open'); }
/**
 * Esc with the scope menu open closes the menu — and nothing else. The one
 * keydown listener in keymap.js unwinds the open journey on Esc; this runs on
 * the window in the capture phase, ahead of it, and stops the key there, so the
 * journey's ladder never sees an Esc that was meant for the menu (with the
 * menu open, Esc used to close the journey and leave the menu hanging over the
 * page it returned to — pass swarm 2026-09-25). An open tip is on top of the
 * menu and closes first, through the keymap as always.
 * @group Lens, theme & filters
 */
function scopeMenuKey(e) {
  if (e.key !== 'Escape' || !scopeMenuOpen() || tipOpen()) return;
  // a picker in the menu with words typed clears them first (lib/multi-pick.js); the next Esc closes the menu
  if (pickerHasQuery(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeScopeMenu();
  const b = document.getElementById('scopebtn');
  if (b) b.focus({ preventScroll: true });
}
/**
 * Apply a scope selection, persist it, and refresh every view (menu stays
 * open so several sources can be picked in one visit).
 * @group Lens, theme & filters
 */
export function applyScope(v) {
  S.scope = v; localStorage.setItem('fs-scope-v2', JSON.stringify(v));
  buildScope(); buildChips();
  refreshSurface('scope');
}
/**
 * @group Lens, theme & filters
 */
export function setScopeAll() { applyScope('all'); }
/**
 * @group Lens, theme & filters
 */
export function toggleScopeSrc(name) {
  // from *all*, unchecking one source keeps every other one
  let cur = S.scope === 'all' ? (S.SETTINGS.sources || []).map((s) => s.name) : S.scope.slice();
  cur = cur.includes(name) ? cur.filter((n) => n !== name) : cur.concat(name);
  const every = (S.SETTINGS.sources || []).every((s) => cur.includes(s.name));
  applyScope(cur.length && !every ? cur : 'all');
}
/**
 * @group Lens, theme & filters
 */
export function toggleScopeColl(i) {
  const c = (S.SETTINGS.collections || [])[i]; if (!c) return;
  const names = collSourceNames(c);
  let cur = S.scope === 'all' ? (S.SETTINGS.sources || []).map((s) => s.name) : S.scope.slice();
  const all = !!names.length && names.every((n) => cur.includes(n));
  if (all) cur = cur.filter((n) => !names.includes(n));
  else names.forEach((n) => { if (!cur.includes(n)) cur.push(n); });
  applyScope(cur.length ? cur : 'all');
}
/**
 * Save the current multi-selection as a named collection so it can be
 * re-picked as one group later — persists straight to workspace settings.
 * @group Lens, theme & filters
 */
export async function saveScopeGroup() {
  if (S.scope === 'all' || !S.scope.length) return;
  const name = prompt(t('set.groupPrompt'));
  if (!name) return;
  const ids = (S.SETTINGS.sources || []).filter((s) => S.scope.includes(s.name)).map((s) => s.id);
  S.SETTINGS.collections.push({ name, sourceIds: ids });
  await fetch('/api/settings', { method: 'PUT', body: JSON.stringify(S.SETTINGS) });
  buildScope(); renderSettings();
}
/**
 * @group Lens, theme & filters
 */
export function buildChips() {
  const counts = {};
  S.GRAPH.nodes.filter((n) => inScope(n)).forEach((n) => (n.tags || []).forEach((tag) => (counts[tag] = (counts[tag] || 0) + 1)));
  // a tag is the code's own label; the business lens keeps only the ones that are
  // words (`deprecated`), never `runner:vitest` or `test:unit`
  const biz = currentLens() === 'business';
  const top = Object.entries(counts).filter(([tag]) => !biz || /^[a-z]+$/i.test(tag)).sort((a, b) => b[1] - a[1]).slice(0, 5);
  // a tag on tests counts the coverage reports beside the cases (each is a test node); the Tests page
  // counts cases only, so the tip splits the two and the numbers can be reconciled (docs/COUNTS.md, Chrome)
  const split = (tag, c) => {
    const tests = S.GRAPH.nodes.filter((n) => n.kind === 'test' && inScope(n) && (n.tags || []).includes(tag));
    const reports = tests.filter((n) => n.test && n.test.runLevel).length;
    // only a split that adds up to the chip's number: a tag also carried by parts that are not tests is not split
    if (!reports || tests.length !== c) return null;
    return [[t('count.unit.cases').replace('{n}', '').trim(), tests.length - reports], [t('count.unit.runReports').replace('{n}', '').trim(), reports]];
  };
  document.getElementById('chips').innerHTML = top.map(([tag, c]) =>
    '<button class="chip' + (S.activeTag === tag ? ' on' : '') + '" data-tag="' + esc(tag) + '" onclick="toggleTag(' + jsArg(tag) + ')">' + esc(biz ? humanize(tag) : tag)
    + ' · <span class="cnt"' + plainTip(c, 'surf.tagCount', 'count.scope.workspace', '/graph', split(tag, c), null, { tag }) + '>' + c + '</span></button>').join('');
}
/**
 * @group Lens, theme & filters
 */
export function toggleTag(tag) {
  S.activeTag = S.activeTag === tag ? null : tag;
  document.querySelectorAll('.chip[data-tag]').forEach((c) => c.classList.toggle('on', c.dataset.tag === S.activeTag));
  render();
}

// ── search palette & focus ──────────────────────────────────────
/**
 * Rank the graph against what was typed. Developers type identifiers
 * (`requireContractorSession`) and business readers type words, so a node is
 * matched on **both** in every register — its identifier (the name up to a
 * gate's label, and the id's last segment) and its business name — and an exact
 * hit on either outranks everything. Gates are searchable: the palette used to
 * leave them out, so the exact name of one found nothing while `require` found
 * other things (pass swarm 2026-09-25). What the row *shows* is the register's
 * business; what it *matches* is not.
 * @group Search & navigation
 */
export function searchNodes(q) {
  const raw = String(q || '').trim().toLowerCase();
  const terms = raw.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  // the palette asks again on every arrow key: the same query on the same graph, scope and lens is the same answer
  const key = raw + '|' + JSON.stringify(S.scope) + '|' + currentLens();
  if (SEARCH.answer && SEARCH.answer.graph === S.GRAPH && SEARCH.answer.key === key) return SEARCH.answer.results;
  // the nodes: folded once per graph (lib/search-model.js), ranked per keystroke over the folded strings
  if (SEARCH.graph !== S.GRAPH || !SEARCH.index) {
    SEARCH.graph = S.GRAPH;
    SEARCH.index = buildSearchIndex(S.GRAPH.nodes, { bizName, bizLabel, repoOf });
  }
  // one Set per scope, so a query that only grew its last word re-ranks the last answer's matches
  const scopeKey = JSON.stringify(S.scope);
  if (SEARCH.scopeKey !== scopeKey) { SEARCH.scopeKey = scopeKey; SEARCH.repos = scopedRepos(); }
  const nodeHits = searchIndex(SEARCH.index, raw, SEARCH.repos).hits;
  const projectHits = projectTravelItems().map((p) => {
    // a workspace project (surfaces/codemap-projects.js) is matched on its name, its words and its tags;
    // on a tie an application outranks a library, which outranks a test project
    const name = p.name.toLowerCase(), words = p.words.toLowerCase();
    const tags = [...(p.tags || []), ...p.tagWords].map((x) => String(x).toLowerCase());
    let score = 0;
    if (name === raw || words === raw) score += 100;
    for (const term of terms) {
      if (name === term || words === term) score += 10;
      else if (name.includes(term) || words.includes(term)) score += 5;
      else if (tags.some((x) => x.includes(term))) score += 4;
    }
    if (score > 0) score += p.type === 'application' ? 2 : p.type === 'library' ? 1 : 0;
    return { n: p, score };
  }).filter((r) => r.score > 0);
  // nodes first, then projects, each in its own order: a stable sort keeps that order on a tie
  const results = nodeHits.concat(projectHits).sort((a, b) => b.score - a.score).slice(0, 12).map((r) => r.n);
  SEARCH.answer = { graph: S.GRAPH, key, results };
  return results;
}
/** Fast travel's folded index (one per graph) and its last answer. */
const SEARCH = { graph: null, index: null, scopeKey: null, repos: null, answer: null };
/**
 * Leave the code map's focus without redrawing it — for when the map is not on
 * screen, where the focus filters nothing but still wrote itself into the
 * search box, the *exit focus* chip and the status bar.
 * @group Search & navigation
 */
export function dropFocus() {
  S.focusSet = null;
  const chip = document.getElementById('focuschip');
  if (chip) chip.style.display = 'none';
  const lbl = document.getElementById('searchlabel');
  if (lbl) lbl.textContent = t('chrome.search');
}
/**
 * Arrive on one card of the code map from fast travel: its group opened, the
 * card selected and scrolled into view, the inspector open — and **no focus
 * filter**. Arriving used to focus the map on the card's neighbourhood, a
 * filter the reader never chose, which then outlived the visit (pass swarm
 * 2026-09-25: *from a journey every pick lands on Code Map with a sticky focus
 * filter*). `f` still focuses, by choice.
 * @group Search & navigation
 */
export function arriveAt(id) {
  if (S.focusSet) dropFocus();
  // a gate has no card: the one it sits on is opened and scrolled to, and the
  // inspector stays on the gate — the thing that was picked (`cardOf`)
  const card = cardOf(id);
  const n = S.BYID[card];
  const eg = n && effectiveGroup(n);
  if (eg) S.expandedGroups.add(eg.key);
  select(id);
  const el = document.getElementById('nd-' + cssId(card));
  if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
}
/**
 * @group Search & navigation
 * @business Zooms the map to one thing and its neighborhood.
 */
export function focusOn(id, depth) {
  depth = depth || 2;
  const adj = {};
  S.GRAPH.edges.forEach((e) => { (adj[e.from] = adj[e.from] || []).push(e.to); (adj[e.to] = adj[e.to] || []).push(e.from); });
  const set = new Set([id]); let frontier = [id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    frontier.forEach((x) => (adj[x] || []).forEach((y) => { if (!set.has(y)) { set.add(y); next.push(y); } }));
    frontier = next;
  }
  S.focusSet = set;
  const n = S.GRAPH.nodes.find((n) => n.id === id);
  const eg = n && effectiveGroup(n);
  if (eg) S.expandedGroups.add(eg.key);
  document.getElementById('focuschip').style.display = '';
  // the business register names a thing by what it does, never by its identifier
  const name = n ? (currentLens() === 'business' ? bizLabel(n) : n.name) : '';
  document.getElementById('searchlabel').textContent = n ? (t('chrome.focusPrefix') + ' ' + name) : t('chrome.search');
  select(id);
}
/**
 * @group Search & navigation
 */
export function clearFocus() {
  S.focusSet = null;
  document.getElementById('focuschip').style.display = 'none';
  document.getElementById('searchlabel').textContent = t('chrome.search');
  render(); if (S.selected) select(S.selected);
}
/**
 * @group Search & navigation
 */
export function openPalette() {
  document.getElementById('veil').classList.add('open');
  document.getElementById('palette').classList.add('open');
  const inp = document.getElementById('pinput'); inp.value = ''; renderPalette([]); inp.focus();
}
/**
 * @group Search & navigation
 */
export function closePalette() {
  document.getElementById('veil').classList.remove('open');
  document.getElementById('palette').classList.remove('open');
}
/**
 * @group Search & navigation
 */
export function renderPalette(results) {
  S.palIndex = Math.min(S.palIndex, Math.max(0, results.length - 1));
  // Each row says where Enter goes (the surface fast travel arrives on). The
  // business register reads the thing's name and that destination only: the
  // kind, the identifier and the file are a developer's words for it.
  const biz = currentLens() === 'business';
  // two results with one business name (*Load invoice* ×2) are told apart by the
  // area of the product they sit in — in words, never by their file
  const names = results.map((n) => bizName(n));
  const dup = (i) => names.filter((x) => x === names[i]).length > 1;
  // the rows are the answer Enter and a click act on: each carries its node's full
  // id, and nothing re-resolves a pick by the name it shows (a dozen `Post`s)
  S.palResults = results;
  const owners = ownerLines(results, names);
  document.getElementById('presults').innerHTML = results.map((n, i) => {
    // a project row names its kind and where it lands in words: the code map, grouped by project
    if (n.kind === 'project') {
      return '<div class="presult presult-project' + (i === S.palIndex ? ' hot' : '') + '" data-id="' + esc(n.id) + '" onclick="pick(this.dataset.id)">'
        + (biz ? '<span class="pk pdest">' + esc(t('codemap.pick.dest')) + '</span><span class="pname">' + esc(n.words) + '</span><span class="meta"></span></div>'
          : '<span class="pk k-project">' + esc(t('codemap.pick.kind')) + '</span><span class="pname">' + esc(n.name)
            + (n.sub ? '<span class="powner">' + esc(n.sub) + '</span>' : '') + '</span><span class="meta"></span><span class="pdest pto">' + esc(t('codemap.pick.dest')) + '</span></div>');
    }
    const to = t('nav.' + travelTarget(n).surface);
    return '<div class="presult' + (i === S.palIndex ? ' hot' : '') + '" data-id="' + esc(n.id) + '" onclick="pick(this.dataset.id)">'
      + (biz ? '<span class="pk pdest">' + esc(to) + '</span><span class="pname">' + esc(names[i]) + (dup(i) ? '<span class="parea">' + esc(areaOf(n)) + '</span>' : '') + '</span><span class="meta"></span></div>'
        : '<span class="pk k-' + esc(n.kind) + '">' + esc(n.kind) + '</span><span class="pname">' + esc(names[i])
          + (String(n.name).toLowerCase() !== names[i].toLowerCase() ? '<span class="pid">' + esc(n.name) + '</span>' : '')
          + (owners[i] ? '<span class="powner">' + esc(owners[i]) + '</span>' : '') + '</span>'
          + '<span class="meta">' + (n.loc ? esc(n.loc.path) : '') + '</span><span class="pdest pto">' + esc(to) + '</span></div>');
  }).join('')
    || '<div class="presult" style="color:var(--dim)">' + esc(t('palette.hint').replace('{n}', String(S.GRAPH.nodes.length))) + '</div>';
}
/**
 * The part of the product a result sits in, in words: the folder its file is
 * in (never `src`, `lib`, `app` or a route parameter), humanized.
 * @group Search & navigation
 */
function areaOf(n) {
  const dirs = String((n.loc && n.loc.path) || '').split('/').slice(0, -1)
    .filter((d) => d && !/^(src|lib|libs|app|apps|api|v\d+|components?|server|client)$/i.test(d) && !/^[[({:]/.test(d));
  return dirs.length ? humanize(dirs[dirs.length - 1]) : humanize(n.kind || '');
}
/**
 * A second line for results that share a name, so a dozen `Post`s can be told
 * apart before one is picked: the owning class when the node is a method, else
 * the shortest end of its path that no other same-named result shares
 * (`auth/session/route.ts`, not `route.ts`). '' for a name that is unique.
 * @group Search & navigation
 */
export function ownerLines(results, names) {
  const out = results.map(() => '');
  // same words on screen, or the same identifier behind different words: either is a name to tell apart
  const groups = new Map();
  const add = (k, i) => groups.set(k, (groups.get(k) || []).concat(i));
  results.forEach((n, i) => { add('w:' + String(names[i]).toLowerCase(), i); add('n:' + String(n.name).toLowerCase(), i); });
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const segs = idx.map((i) => String((results[i].loc && results[i].loc.path) || results[i].id.split('::').slice(1, -1).join('/')).split('/').filter(Boolean));
    const cls = idx.map((i) => { const tail = String(results[i].id).split('::').pop(); return tail.includes('.') ? tail.slice(0, tail.lastIndexOf('.')) : ''; });
    const longest = Math.max(1, ...segs.map((p) => p.length));
    let k = 1;
    while (k < longest && new Set(segs.map((p) => p.slice(-k).join('/'))).size < idx.length) k++;
    idx.forEach((i, j) => {
      const where = segs[j].slice(-k).join('/');
      out[i] = cls[j] ? cls[j] + (where ? ' · ' + where : '') : where;
    });
  }
  return out;
}
/**
 * @group Search & navigation
 */
export function pick(id) {
  closePalette();
  // a project is not a graph node: it is one of the rows the palette showed
  const proj = (S.palResults || []).find((x) => x.id === id && x.kind === 'project');
  if (proj) {
    // already there: the hash would not change, so the map is asked to arrive again
    if (location.hash === proj.hash) history.replaceState(null, '', '#/codemap');
    location.hash = proj.hash;
    return;
  }
  const n = S.BYID[id] || S.GRAPH.nodes.find((x) => x.id === id);
  if (!n) return;
  const to = travelTarget(n);
  // the URL says where the reader arrived, so the arrival is a link they can share
  if (location.hash === to.hash) {
    // already there (the hash will not change, so nothing remounts): arrive in place
    if (to.surface === 'codemap') arriveAt(to.id);
    return;
  }
  // the map selects the card once it has mounted (surfaces/codemap.js)
  if (to.surface === 'codemap') S.pendingFocus = to.id;
  location.hash = to.hash;
}

/**
 * Where fast travel arrives for a node — the surface on which the reader can
 * *see* the thing they named, not a selection on a map that is hidden behind
 * the surface they were on (⌘K from Journeys used to change nothing but the
 * search label). The kind decides, then the register:
 *
 * - a **flow** is a journey — its blueprint, in every register;
 * - an **API** is its page on the APIs surface; a **test** its Tests detail;
 * - a **route or page** is where a journey starts: the business register
 *   reads it as that journey (since B2.2 it reads the product before the map),
 *   hybrid and code land on the code map with it in focus;
 * - a **gate** is a badge on what it guards: travel goes to that;
 * - **on the Map** (the surface on screen, so a pick made inside it) a flow is its
 *   street, a page or route a journey's screen (or the call's card) — `mapTravel`;
 * - anything else — a function, a table, a component — is one card on the code
 *   map, focused, with the inspector open. The map draws business names in the
 *   business register and the inspector leads with the business summary, so it
 *   is where that register sees a single part of the system too.
 * @group Search & navigation
 */
export function travelTarget(n) {
  // ⌘K from the Map stays on the Map (§K): a journey is its street, a screen that
  // journey's street with the screen open, a call its street with its card open.
  // Anything the board does not draw travels as it does from everywhere else.
  if (mapOpen()) {
    const m = mapTravel(n);
    if (m) return { surface: 'map', hash: m, id: n.id };
  }
  // a gate is drawn as a badge on what it guards, never as a card: travel to the
  // surface that card lives on, but keep the gate as the node arrived at — the
  // inspector (and `b`) answer for the thing picked, not for what it protects
  if (n.kind === 'guard') {
    const guarded = S.BYID[cardOf(n.id)];
    if (guarded && guarded.id !== n.id) {
      const via = travelTarget(guarded);
      if (via.surface === 'codemap') return { surface: 'codemap', hash: '#/codemap?node=' + encodeURIComponent(n.id), id: n.id };
      return via;
    }
  }
  const id = encodeURIComponent(n.id);
  if (n.kind === 'flow') return { surface: 'journeys', hash: '#/journeys/' + id, id: n.id };
  if (n.kind === 'api') return { surface: 'apis', hash: '#/apis/' + id, id: n.id };
  if (n.kind === 'test') return { surface: 'tests', hash: '#/tests/' + id, id: n.id };
  // a work item is its pane on the WORK surface, in every register
  if (n.kind === 'work' || String(n.id).startsWith('work::')) return { surface: 'work', hash: '#/work/' + id, id: n.id };
  if ((n.kind === 'route' || n.kind === 'page') && currentLens() === 'business') return { surface: 'journeys', hash: '#/journeys/' + id, id: n.id };
  return { surface: 'codemap', hash: '#/codemap?node=' + id, id: n.id };
}
/**
 * Palette list navigation (arrows + Enter), driven by keymap.js while the
 * palette is open.
 * @group Search & navigation
 */
export function paletteNav(e) {
  const results = searchNodes(document.getElementById('pinput').value);
  if (e.key === 'ArrowDown') { e.preventDefault(); S.palIndex = Math.min(S.palIndex + 1, results.length - 1); renderPalette(results); }
  if (e.key === 'ArrowUp') { e.preventDefault(); S.palIndex = Math.max(S.palIndex - 1, 0); renderPalette(results); }
  // Enter takes the row on screen — the list the reader saw, not a second search
  const shown = S.palResults && S.palResults.length ? S.palResults : results;
  if (e.key === 'Enter' && shown[S.palIndex]) { pick(shown[S.palIndex].id); }
}

// ── settings page ───────────────────────────────────────────────
/** @group Settings page */
export function settingsOpen() { return document.getElementById('settings').classList.contains('open'); }
/**
 * @group Settings page
 */
export function openSettings() { renderSettings(); document.getElementById('settings').classList.add('open'); }
/**
 * @group Settings page
 */
export function closeSettings() { document.getElementById('settings').classList.remove('open'); }
/**
 * @group Settings page
 * @business The settings screen: manage sources, collections, and appearance.
 */
export function renderSettings() {
  if (!S.SETTINGS) return;
  document.getElementById('srcrows').innerHTML = (S.SETTINGS.sources || []).map((s, i) =>
    '<tr><td><input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' onchange="S.SETTINGS.sources[' + i + '].enabled=this.checked" aria-label="enabled"/></td>'
    + '<td>' + esc(s.name) + '</td><td>' + s.type + '</td><td class="mono">' + esc(s.path) + '</td>'
    + '<td><input class="mono" style="width:100%;min-width:120px" value="' + esc((s.exclude || []).join(', ')) + '" placeholder="—" aria-label="exclude globs" onchange="S.SETTINGS.sources[' + i + '].exclude=this.value.split(\',\').map(x=>x.trim()).filter(Boolean)"/></td>'
    + '<td class="st ' + ((s.status || '').startsWith('ok') ? 'ok' : (s.status || '').startsWith('error') ? 'err' : '') + '">' + esc(s.status || '—') + '</td>'
    + '<td><button class="x" onclick="S.SETTINGS.sources.splice(' + i + ',1);renderSettings()" aria-label="remove">✕</button></td></tr>').join('')
    || '<tr><td colspan="7" style="color:var(--dim)">' + esc(t('set.noSources')) + '</td></tr>';
  document.getElementById('collrows').innerHTML = (S.SETTINGS.collections || []).map((c, i) =>
    '<div class="coll"><b>' + esc(c.name) + '</b><span class="mono">' + c.sourceIds.map((id) => { const s = S.SETTINGS.sources.find((s) => s.id === id); return s ? s.name : id; }).join(' · ') + '</span>'
    + '<button class="x" style="margin-left:auto" onclick="S.SETTINGS.collections.splice(' + i + ',1);renderSettings()">✕</button></div>').join('')
    || '<div class="set-note">' + esc(t('set.noCollections')) + '</div>';
  document.getElementById('set-theme').value = S.themePreview || S.SETTINGS.theme || 'system';
  const tn = document.getElementById('set-theme-note');
  if (tn) tn.textContent = S.themePreview && S.themePreview !== (S.SETTINGS.theme || 'system') ? t('surf.theme.preview') : '';
  document.getElementById('set-lens').value = S.SETTINGS.defaultLens || 'hybrid';
  const surf = document.getElementById('set-surface');
  if (surf) {
    surf.value = S.SETTINGS.defaultSurface || '';
    // with nothing chosen, say where the register actually lands rather than
    // showing a value the reader never picked
    const eff = document.getElementById('set-surface-eff');
    if (eff) eff.textContent = S.SETTINGS.defaultSurface ? '' : t('set.surfaceByRegister').replace('{s}', t('nav.' + defaultSurface()));
  }
  // experiments: workspace flags, off unless the settings file says so
  const fd = document.getElementById('set-flag-drill');
  if (fd) fd.checked = !!(S.SETTINGS.flags && S.SETTINGS.flags.journeyDrill);
  const fm = document.getElementById('set-flag-map');
  if (fm) fm.checked = mapEnabled();
  const fmn = document.getElementById('set-flag-map-name'); if (fmn) fmn.textContent = t('set.flagMap');
  const fms = document.getElementById('set-flag-map-sub'); if (fms) fms.textContent = t('set.flagMapSub');
  const fl = document.getElementById('set-flags-label'); if (fl) fl.textContent = t('set.flags');
  const fn = document.getElementById('set-flag-drill-name'); if (fn) fn.textContent = t('set.flagDrill');
  const fs = document.getElementById('set-flag-drill-sub'); if (fs) fs.textContent = t('set.flagDrillSub');
  const fh = document.getElementById('set-flag-shots');
  if (fh) fh.checked = !!(S.SETTINGS.flags && S.SETTINGS.flags.designShots);
  const fhn = document.getElementById('set-flag-shots-name'); if (fhn) fhn.textContent = t('set.flagShots');
  const fhs = document.getElementById('set-flag-shots-sub'); if (fhs) fhs.textContent = t('set.flagShotsSub');
  // consequence subtext on every action button (looking vs doing, F12)
  const sc = document.getElementById('sync-consequence'); if (sc) sc.textContent = t('set.syncConsequence');
  const vc = document.getElementById('save-consequence'); if (vc) vc.textContent = t('set.saveConsequence');
  const ls = document.getElementById('set-landing-sub'); if (ls) ls.textContent = t('set.landingSub');
  const ll = document.getElementById('set-landing-label'); if (ll) ll.textContent = t('set.landing');
}
/**
 * @group Settings page
 */
export function addSource() {
  const name = document.getElementById('src-name').value.trim();
  const type = document.getElementById('src-type').value;
  const path = document.getElementById('src-path').value.trim();
  const exclude = document.getElementById('src-exclude').value.split(',').map((x) => x.trim()).filter(Boolean);
  if (!name || !path) return;
  S.SETTINGS.sources.push({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, type, path, exclude, enabled: true });
  document.getElementById('src-name').value = ''; document.getElementById('src-path').value = ''; document.getElementById('src-exclude').value = '';
  renderSettings();
}
/**
 * @group Settings page
 */
export function addCollection() {
  const name = document.getElementById('coll-name').value.trim();
  if (!name) return;
  const repos = scopedRepos();
  const ids = (S.SETTINGS.sources || []).filter((s) => !repos || repos.has(s.name)).map((s) => s.id);
  S.SETTINGS.collections.push({ name, sourceIds: ids });
  document.getElementById('coll-name').value = '';
  renderSettings();
}
/** @group Settings page */
export async function saveSettings() {
  S.SETTINGS.theme = document.getElementById('set-theme').value;
  S.SETTINGS.defaultLens = document.getElementById('set-lens').value;
  const surf = document.getElementById('set-surface');
  if (surf) { if (surf.value) S.SETTINGS.defaultSurface = surf.value; else delete S.SETTINGS.defaultSurface; }
  const fd = document.getElementById('set-flag-drill');
  if (fd) { S.SETTINGS.flags = Object.assign({}, S.SETTINGS.flags, { journeyDrill: fd.checked }); }
  const fm = document.getElementById('set-flag-map');
  if (fm) { S.SETTINGS.flags = Object.assign({}, S.SETTINGS.flags, { map: fm.checked }); }
  const fh = document.getElementById('set-flag-shots');
  if (fh) { S.SETTINGS.flags = Object.assign({}, S.SETTINGS.flags, { designShots: fh.checked }); }
  applyTheme(S.SETTINGS.theme);
  S.themePreview = null;
  const tn = document.getElementById('set-theme-note');
  if (tn) tn.textContent = '';
  const r = await fetch('/api/settings', { method: 'PUT', body: JSON.stringify(S.SETTINGS) });
  document.getElementById('savenote').textContent = r.ok ? t('set.saved') : t('set.saveFailed');
  buildScope();
  // a flag may have added or taken away a tab
  renderChrome();
  setTimeout(() => (document.getElementById('savenote').textContent = ''), 2500);
}
/** @group Settings page */
export async function syncNow() {
  const btn = document.getElementById('syncbtn'), note = document.getElementById('syncnote');
  btn.disabled = true; note.textContent = t('set.syncing');
  await saveSettings();
  try {
    const r = await fetch('/api/sync', { method: 'POST' });
    const out = await r.json();
    if (out.error) { note.textContent = t('set.syncFailedPrefix') + ' ' + out.error; }
    else {
      S.SETTINGS = await fetch('/api/settings').then((r) => r.json());
      S.GRAPH = await fetch('/graph').then((r) => r.json()); S.ROOTS = S.GRAPH.roots || {};
      indexGuards(); buildScope(); buildChips(); renderSettings(); renderChrome();
      // a sync replaces the graph under whatever is on screen: the same contract
      // the filters run on, with the reason that says every fact is new
      refreshSurface('sync');
      note.textContent = t('set.syncedStats').replace('{n}', out.stats.nodes).replace('{e}', out.stats.edges);
    }
  } catch (err) { note.textContent = t('set.syncFailedPrefix') + ' ' + err.message; }
  btn.disabled = false;
}

// ── model hub ───────────────────────────────────────────────────
// Runtime overlay panel: live local AI models/tools/chains/agents from
// /api/modelhub/state. Everything from that endpoint is untrusted display
// data (user-writable event stream) — every dynamic value goes through esc().
/** @group Model Hub */
export function modelHubOpen() { return document.getElementById('modelhub').classList.contains('open'); }
/**
 * @group Model Hub
 * @business Opens the Model Hub — a live board of the machine's local AI models, tools, and agents.
 */
export function openModelHub() {
  document.getElementById('modelhub').classList.add('open');
  pollModelHub();
  if (S.mhTimer) clearInterval(S.mhTimer);
  S.mhTimer = setInterval(pollModelHub, 2000);
}
/**
 * @group Model Hub
 * @business Closes the Model Hub and stops its live polling.
 */
export function closeModelHub() {
  document.getElementById('modelhub').classList.remove('open');
  if (S.mhTimer) { clearInterval(S.mhTimer); S.mhTimer = null; }
}
/**
 * @group Model Hub
 * @business Fetches the current runtime state of local models and agents.
 */
export async function pollModelHub() {
  try {
    const st = await fetch('/api/modelhub/state').then((r) => r.json());
    renderModelHub(st);
  } catch (err) {
    renderModelHub(null);
  }
}
/**
 * One model/tool tile; pulses (via .live) while the model or tool is running.
 * @group Model Hub
 */
export function mhNode(id, kind, active, sub) {
  return '<div class="mh-node mh-' + esc(kind) + (active ? ' live' : '') + '">'
    + '<div class="mh-node-name">' + esc(id) + '</div>'
    + (sub ? '<div class="mh-node-sub">' + esc(sub) + '</div>' : '')
    + '</div>';
}
/**
 * @group Model Hub
 * @business Draws the Model Hub: capability categories, tools, chain flows, and agent activity.
 */
export function renderModelHub(st) {
  const root = document.getElementById('mh-body');
  const fresh = document.getElementById('mh-fresh');
  if (!st) { root.innerHTML = '<div class="mh-empty">' + esc(t('mh.unavailable')) + '</div>'; if (fresh) fresh.textContent = ''; return; }
  const reg = st.registry || { categories: [], tools: [], chains: [] };
  const toolAct = st.tools || {}, modelAct = st.models || {};
  const isModelActive = (id) => !!(modelAct[id] && modelAct[id].active);
  const isToolActive = (id) => !!(toolAct[id] && toolAct[id].active);
  let html = '';

  // ollama runtime: installed vs loaded
  const oll = st.ollama || { installed: [], loaded: [] };
  const loaded = oll.loaded || [];
  html += '<div class="mh-sec"><div class="hud-label">Ollama runtime</div>';
  if (!(oll.installed || []).length) html += '<div class="mh-note">' + esc(t('mh.ollamaEmpty')) + '</div>';
  else html += '<div class="mh-ollama">' + oll.installed.map((n) => {
    const on = loaded.indexOf(n) >= 0;
    return '<span class="mh-oll' + (on ? ' loaded' : '') + '">' + esc(n) + (on ? ' · loaded' : '') + '</span>';
  }).join('') + '</div>';
  html += '</div>';

  // capability categories → model nodes
  html += '<div class="mh-sec"><div class="hud-label">Capabilities</div>';
  if (!(reg.categories || []).length) html += '<div class="mh-note">' + esc(t('mh.noCategories')) + '</div>';
  else html += '<div class="mh-cats">' + reg.categories.map((cat) =>
    '<div class="mh-card"><div class="mh-card-h">' + esc(cat.name || cat.id) + '</div>'
    + '<div class="mh-nodes">' + (cat.models || []).map((m) => mhNode(m.id, 'model', isModelActive(m.id), m.runtime || m.license || '')).join('') + '</div></div>'
  ).join('') + '</div>';
  html += '</div>';

  // tools
  html += '<div class="mh-sec"><div class="hud-label">Tools</div><div class="mh-nodes">';
  html += (reg.tools || []).map((tl) => mhNode(tl.id, 'tool', isToolActive(tl.id), (tl.uses || []).join(', '))).join('') || '<div class="mh-note">' + esc(t('mh.noTools')) + '</div>';
  html += '</div></div>';

  // chains: step → step, edge animates while any step is active
  html += '<div class="mh-sec"><div class="hud-label">Chains</div>';
  if (!(reg.chains || []).length) html += '<div class="mh-note">' + esc(t('mh.noChains')) + '</div>';
  else html += reg.chains.map((ch) => {
    const steps = ch.steps || [];
    const live = steps.some(isToolActive);
    const inner = steps.map((s) => '<span class="mh-step' + (isToolActive(s) ? ' live' : '') + '">' + esc(s) + '</span>')
      .join('<span class="mh-arrow' + (live ? ' live' : '') + '">→</span>');
    return '<div class="mh-chain' + (live ? ' live' : '') + '"><div class="mh-chain-steps">' + inner + '</div>'
      + (ch.desc ? '<div class="mh-note">' + esc(ch.desc) + '</div>' : '') + '</div>';
  }).join('');
  html += '</div>';

  // Claude agent lane
  html += '<div class="mh-sec"><div class="hud-label">Claude agents</div><div class="mh-lane">';
  const sess = st.sessions || [];
  if (!sess.length) html += '<div class="mh-note">' + esc(t('mh.noAgents')) + '</div>';
  else html += sess.map((s) => {
    const id = String(s.session || '');
    const shortId = id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
    return '<div class="mh-agent' + (s.active ? ' live' : '') + '"><span class="mh-dot"></span>'
      + '<span class="mh-agent-id">' + esc(shortId) + '</span>'
      + '<span class="mh-agent-tool">' + esc(s.lastTool || '—') + '</span>'
      + '<span class="mh-agent-st">' + (s.active ? 'active' : 'idle') + '</span></div>';
  }).join('');
  html += '</div></div>';

  root.innerHTML = html;
  if (fresh) fresh.textContent = st.generatedAt ? ('updated ' + new Date(st.generatedAt).toLocaleTimeString()) : '';
}

// ── boot ────────────────────────────────────────────────────────
document.addEventListener('click', () => { closeCtx(); closeScopeMenu(); closeShare(); closeMore(); });
document.addEventListener('scroll', () => closeCtx(), true);
document.addEventListener('input', (e) => {
  if (e.target.id === 'pinput') { S.palIndex = 0; renderPalette(searchNodes(e.target.value)); }
});

/**
 * Boot the shell: load graph + settings + strings, restore register/theme/
 * lens/scope, start the router (deep link wins over the role-based landing),
 * bind the keymap.
 * @group Shell
 */
async function boot() {
  await loadAll();
  initRegister();
  hydrateScope();
  applyTheme(S.SETTINGS.theme); setLens(S.SETTINGS.defaultLens || 'hybrid', true);
  // with no theme saved, the window follows the reader's system as it changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (S.themeFollowsSystem) applyTheme(S.themePreview || S.SETTINGS.theme);
    });
  }
  indexGuards(); buildScope(); buildChips(); renderSettings();
  // the running build, fail-soft: an older server without /api/version just leaves the tooltip shorter
  fetch('/api/version').then((r) => (r.ok ? r.json() : null)).then((v) => { if (v) { S.VERSION = v; renderChrome(); } }).catch(() => {});
  // the word register is the third thing that changes what is on screen without
  // changing the route — it goes through the one contract, so the list of which
  // surfaces bother to redraw lives on each surface instead of here
  onRegisterChange(() => { renderChrome(); refreshSurface('register'); });
  window.addEventListener('hashchange', applyRoute);
  window.addEventListener('resize', fitTopbar);
  initTips();
  // ahead of keymap.js's listener: an Esc meant for the scope menu stops there
  window.addEventListener('keydown', scopeMenuKey, true);
  applyRoute();
  initKeymap();
}
boot();

expose({
  setLens, applyTheme, previewTheme, buildScope, toggleScopeMenu, closeScopeMenu, applyScope, setScopeAll, arriveAt, dropFocus,
  toggleScopeSrc, toggleScopeColl, saveScopeGroup, buildChips, toggleTag,
  searchNodes, focusOn, clearFocus, openPalette, closePalette, renderPalette, pick, travelTarget,
  openSettings, closeSettings, renderSettings, addSource, addCollection, saveSettings, syncNow,
  openModelHub, closeModelHub, pollModelHub, toggleMore, closeMore, moreMenuClick,
});
