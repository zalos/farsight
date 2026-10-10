// surfaces/journeys.js — the Journeys surface: an entry-point picker (with the
// Designs front door) plus the journey overlay, drawn as the BLUEPRINT
// TIMELINE (docs/proposals/blueprint-timeline.md, option C). Route:
// #/journeys/<entryId> (deep-linkable); the overlay is the surface's detail
// view. All glyphs are drawn sprite symbols — no emoji.
//
// A journey is a linearized execution walk (DFS pre-order) from one entry
// node, fetched from /api/journey; its `summary` folds the walk into segments
// (one per screen) over system rows. The overlay is one horizontal timeline:
// per segment, what the user sees · the line of visibility · the business as a
// flowchart · one row per system with the segment's markers. A marker expands
// in place into the Wallaby-style spliced code timeline — a caller's code
// splits at each child's call site and the callee nests inline with its own
// true line-number gutter — or into the contract for a planned step. Fork data
// (node.branches, step.conditions, top-level forkCount) is all optional.
// Everything from the server is untrusted display data → esc().

import { S, expose, esc, jsArg, repoOf, bizLabel, humanize, inScope, effectiveGroup, currentLens, cssId } from '../store.js';
import { t, def, evidenceWord, plainWords, proseHtml, unTick } from '../strings.js';
import { sym } from '../sym.js';
import { nodeCardHtml, vsl, linkHtml, designChipHtml, designThumbHtml } from '../lib/graph-render.js';
import { journeyViewHash, isJourneyRoute, withParams, mapScreenHash, stepIndex, journeyStepHash } from '../lib/route-url.js';
import { doorsFor, doorsHtml } from '../lib/detail-doors.js';
import { gateAttrs } from '../lib/gate-card.js';
import { trapFocus, releaseFocus, rememberOpener } from '../lib/focus-trap.js';
import { storyChipsHtml, screenStoryIds } from '../stories.js';
import { registerTip, tipAttrs, numberTip, tableTip, tipSource } from '../lib/tooltip.js';
import { plainTip, countedHtml, defAttrs, countKey } from '../lib/counted.js';
import { jrnDrillEnabled, jrnDrillIndex, jrnDrillHtml, jrnDrillMount, jrnDrillOrders, jrnDrillEnsureAction, jrnDrillSelected, jrnDrillStep, jrnInspPanelHtml } from './journey-drill.js';
import { fillJourneyWork } from '../work-chips.js';
import { loadJourneyTree, jrnPersonaName, jrnGroupName, jrnOrgCountsHtml, screenThumbHtml } from '../lib/journeys-tree.js';
import { filterTree, placesOf, storylineOf, findStoryline, firstScreenOf } from '../lib/journeys-model.js';
import { lifecycleStripHtml, headerLifecycles } from '../lib/lifecycle-strip.js';
import { freshLineHtml, freshSentence, freshShown } from '../lib/freshness.js';
import { exportToolHtml, registerExport } from '../lib/export.js';
import { testChipHtml, distinctArgs } from '../lib/test-chip.js';

const JRN_REPO_COLORS = ['var(--cyan)', 'var(--ok)', 'var(--fn)', 'var(--tbl)', 'var(--auth)', 'var(--amber)'];
const JRN_CATS = ['access', 'guard', 'state', 'error', 'flag', 'branch'];

// ── surface mount (router-driven) ───────────────────────────────
/**
 * Navigate to a journey by entry id — the router owns the overlay, so every
 * open journey has a shareable #/journeys/<id> URL.
 * @group Journey view
 */
function gotoJourney(id, step) {
  if (!/^#\/journeys\//.test(location.hash)) S.prevSurfaceHash = location.hash || '#/journeys';
  // the router empties #surface on the way, so the control that is being clicked
  // has to be remembered here — it will not exist when the overlay traps focus
  rememberOpener(document.activeElement);
  // a step (the storyline's arrows and its first journey: step 1) opens at that screen, in the view the reader has
  location.hash = step ? journeyStepHash(id, step, { view: jrnLayout() }) : '#/journeys/' + encodeURIComponent(id);
}

/**
 * Entry points that can run as a journey: routes, pages, and anything tagged
 * @entrypoint — grouped by source, derived from the loaded graph.
 * @group Journey view
 */
function journeyEntries() {
  return S.GRAPH.nodes.filter((n) => inScope(n) && (
    n.kind === 'route' || n.kind === 'page' || (n.tags || []).includes('entrypoint')
  ));
}

/**
 * The Journeys surface: honest header (what ships in P5) + the real entry
 * picker; a chosen entry opens the existing journey overlay via the router.
 * @group Journey view
 */
export function mountJourneys(route, el) {
  renderPicker(el);
  // a link to one step (`?step=n[&node=id]`, round 2026-10-05 §3.1) is spent once the journey has drawn
  S.jrnPendingStep = route.param && route.step ? { step: route.step, node: route.node || null } : null;
  if (route.param) openJourney(decodeURIComponent(route.param));
  else hideJourneyOverlay();
}

/**
 * Redraw after the scope or the register moved.
 *
 * The picker is rebuilt either way: its entry lists are filtered by the scope
 * and its words come from the catalog. **An open journey stays open.** A
 * journey is one flow, named by the route and by the link a reader shared; the
 * source filter says which systems the lists offer, not which flow the reader
 * is in the middle of — closing it would throw away their place to enforce a
 * filter they did not aim at it. It redraws in place through the same path a
 * lens flip uses, which keeps the selected step and the scroll.
 * @group Journey view
 */
export function journeysRefresh(reason, route) {
  const el = document.getElementById('surface');
  if (el) renderPicker(el);
  journeyLensRefresh();
}

/**
 * The picker itself: the start-here card, the designs section and the entry
 * points in scope — everything the surface draws that is not the overlay. Split
 * out of the mount so a scope or register change can rebuild it without running
 * the mount's tail, which opens or closes the journey overlay.
 * @group Journey view
 */
function renderPicker(el) {
  const entries = journeyEntries();
  const byRepo = {};
  entries.forEach((n) => (byRepo[repoOf(n)] = byRepo[repoOf(n)] || []).push(n));
  let html = '<div class="set-wrap"><h1>' + esc(t('journeys.pickerTitle')) + '</h1><p class="sub">' + esc(t('journeys.pickerSub')) + '</p>'
    + startHereHtml()
    + '<div id="jrn-storylines"></div>'
    + '<div id="jrn-organised"></div>'
    + '<div id="jrn-designs"></div>';
  const repos = Object.keys(byRepo).sort();
  if (!repos.length) html += '<div class="set-sec"><p class="set-note">' + esc(t('journeys.pickerEmpty')) + '</p></div>';
  else html += '<div class="set-sec"><h2>' + esc(t('journeys.entryPoints')) + '</h2><p class="set-note">' + esc(t('journeys.entryPointsSub')) + '</p></div>';
  repos.forEach((repo) => {
    html += '<div class="set-sec"><h2>' + esc(repo) + '</h2>';
    byRepo[repo].slice(0, 60).forEach((n) => {
      html += '<button class="rel" onclick="openJourney(' + jsArg(n.id) + ')"><span class="rk">' + esc(n.kind) + '</span>'
        + esc(bizLabel(n)) + ' <span style="font-family:var(--mono);font-size:10px;color:var(--dim)">' + esc(n.name) + '</span>'
        + (n.loc ? '<span style="float:right;font-family:var(--mono);font-size:9.5px;color:var(--dim)">' + esc(n.loc.path) + ':' + n.loc.line + vsl(repoOf(n), n.loc.path, n.loc.line) + '</span>' : '')
        + '</button>';
    });
    if (byRepo[repo].length > 60) html += '<p class="set-note">+ ' + (byRepo[repo].length - 60) + ' more — narrow the scope</p>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
  jrnMountDesigns();
}

/**
 * Three steps for someone who has never opened this before: where to start, how
 * to change the register, and where every word on screen is defined. Chrome, not
 * data — it says nothing about the product, so it cannot be wrong about it.
 * @group Journey view
 */
function startHereHtml() {
  return '<div class="set-sec jrn-start"><h2>' + esc(t('journeys.startHere')) + '</h2>'
    + '<ol class="jrn-startlist"><li>' + esc(t('journeys.startStep1')) + '</li>'
    + '<li>' + esc(t('journeys.startStep2')) + '</li>'
    + '<li>' + esc(t('journeys.startStep3')) + '</li></ol>'
    + '<div class="jrn-startbtns">'
    + '<a class="rel" href="#/grammar">' + sym('open') + ' ' + esc(t('journeys.startGrammar')) + '</a>'
    + '<button class="rel" onclick="toggleKeymapPanel()">' + esc(t('journeys.startKeys')) + '</button>'
    + '</div></div>';
}

// ── designs front door (docs/proposals/design-source.md) ────────
/** `?scope=` for /api/design — the viewer's multi-select scope in the shape
 * the API endpoints take.
 * @group Journey view */
function jrnScopeParam() {
  return S.scope === 'all' || !S.scope.length ? 'all' : S.scope.join(',');
}
/**
 * The Designs section above the entry lists: one card per design source with
 * its counts, the screens that are designed but not built (each runs as a
 * planned journey), and the screens that are built. Fail-soft — when no
 * manifest is in scope, or /api/design is unavailable, nothing extra renders.
 * @group Journey view
 * @business Lists the screens a design declares and whether the code has them yet.
 */
async function jrnMountDesigns() {
  const answer = await jrnFrontDoorData();
  if (!answer) return;
  const { data, got } = answer;
  const host = document.getElementById('jrn-designs');
  if (!host) return;
  host.innerHTML = '<div class="set-sec"><h2>' + esc(t('design.title')) + '</h2>'
    + '<p class="set-note">' + esc(t('design.sub')) + '</p>'
    + data.designs.map(jrnDesignCardHtml).join('') + '</div>';
  const org = document.getElementById('jrn-organised');
  if (!org || !got || !got.tree) return;
  JRN_ORG = { tree: got.tree, designs: data.designs, live: got.live };
  const stories = document.getElementById('jrn-storylines');
  if (stories) { stories.innerHTML = jrnStorylinesHtml(JRN_ORG); jrnShowStoryline(stories, got.tree, (S.route || {}).storyline); }
  org.innerHTML = jrnOrganisedHtml(JRN_ORG, S.route || {});
}

// ── the storylines: one business thing, end to end (round-2026-10-05 §2.2) ──
/**
 * Above the personas: one card per storyline the design declares — its name and
 * sentence, how many journeys it chains and how many are built, the journeys as
 * numbered chips in its order (coloured as the screen chips are: built, not
 * built), and two ways in: the Map drawing only this storyline, and its first
 * journey. Nothing when the tree declares none.
 * @group Journey view
 * @business The whole life of one business thing — an invoice, a vendor — journey by journey, whoever does the work.
 */
function jrnStorylinesHtml(org) {
  const tree = org && org.tree;
  const list = (tree && tree.storylines) || [];
  if (!list.length) return '';
  const mapOn = !!(S.SETTINGS && S.SETTINGS.flags && S.SETTINGS.flags.map);
  const stepKey = currentLens() === 'business' ? 'journeys.storyline.bizStepOf' : 'journeys.storyline.stepOf';
  let html = '<div class="set-sec jrn-stories"><h2' + defAttrs('journeys.storyline.title') + '>' + esc(t('journeys.storyline.title')) + '</h2>'
    + '<p class="set-note">' + esc(t('journeys.storyline.sub')) + ' '
    + (tree.counts && tree.counts.storylines ? countedHtml(tree.counts.storylines, '/api/journeys', { cls: 'jrn-org-n' }) : '') + '</p>';
  for (const st of list) {
    const steps = st.journeys || [];
    const chips = steps.map((j, i) => {
      const built = j.total > 0 && j.built >= j.total;
      const cls = built ? 'ok' : j.built > 0 ? 'warn' : 'stub';
      const where = t(stepKey).replace('{n}', i + 1).replace('{m}', steps.length);
      const status = t(j.statusKey || 'journey.status.designedNotBuilt').replace('{n}', j.built || 0).replace('{m}', j.total || 0);
      return (i ? '<span class="jrn-story-then" aria-hidden="true">›</span>' : '')
        + '<a class="api-chip jrn-story-step ' + cls + '" href="' + esc(journeyStepHash(j.nodeId, 1, { view: jrnLayout() })) + '"'
        + tipAttrs({ text: where + ' · ' + (j.name || j.id) + ' · ' + status }) + '><b>' + (i + 1) + '</b>' + esc(j.name || j.id) + '</a>';
    }).join('');
    // its branches (swarm-fixes 2026-10-05 §6), indented under the chain: the step each leaves from, its condition,
    // its journey and the step it comes back to
    const branches = (st.branches || []).map((b) => {
      const at = steps.findIndex((j) => j.nodeId === b.branchOf);
      const back = b.rejoins ? steps.findIndex((j) => j.nodeId === b.rejoins) : -1;
      const built = b.total > 0 && b.built >= b.total;
      const cls = built ? 'ok' : b.built > 0 ? 'warn' : 'stub';
      const status = t(b.statusKey || 'journey.status.designedNotBuilt').replace('{n}', b.built || 0).replace('{m}', b.total || 0);
      return '<li class="jrn-story-branch" data-branch="' + esc(b.id) + '" data-of="' + esc(b.branchOf) + '">' + sym('fork')
        + '<span class="of"' + defAttrs('journeys.storyline.branchOf') + '>' + (at >= 0 ? '<b>' + (at + 1) + '</b> ' : '') + esc(t('journeys.storyline.branchOf').replace('{name}', b.branchOfName || '')) + '</span>'
        + '<span class="when"' + defAttrs('journeys.storyline.when') + '>' + esc(t('journeys.storyline.when').replace('{when}', b.when)) + '</span>'
        + '<a class="api-chip jrn-story-step ' + cls + '" href="' + esc(journeyStepHash(b.nodeId, 1, { view: jrnLayout() })) + '"'
        + tipAttrs({ text: t('journeys.storyline.branch') + ' · ' + (b.name || b.id) + ' · ' + status }) + '>' + esc(b.name || b.id) + '</a>'
        + '<span class="back"' + defAttrs(b.rejoins ? 'journeys.storyline.rejoins' : 'journeys.storyline.noReturn') + '>'
        + (b.rejoins ? (back >= 0 ? '<b>' + (back + 1) + '</b> ' : '') + esc(t('journeys.storyline.rejoins').replace('{name}', b.rejoinsName || '')) : esc(t('journeys.storyline.noReturn'))) + '</span></li>';
    }).join('');
    // its picture: the first journey's first screen, or the placeholder — never an empty box
    const thumb = steps.length ? screenThumbHtml(firstScreenOf(org.designs, steps[0].nodeId), 'jrn-story-thumb') : '';
    html += '<div class="dsg-flow jrn-story" data-storyline="' + esc(st.id) + '">' + thumb + '<div class="dsg-flow-head">'
      + '<span class="dsg-flow-name">' + esc(st.name || st.id) + '</span>'
      + '<span class="jrn-pcount">' + jrnOrgCountsHtml(st.counts) + '</span></div>'
      + (st.description ? '<p class="dsg-flow-desc">' + esc(jrnWords(st.description)) + '</p>' : '')
      + (chips ? '<div class="dsg-chips jrn-story-steps">' + chips + '</div>' : '<p class="set-note">' + esc(t('journeys.storyline.empty')) + '</p>')
      + (branches ? '<ul class="jrn-story-branches">' + branches + '</ul>' : '')
      + '<div class="jrn-story-go">'
      + (mapOn ? '<a class="rel jrn-story-map" href="' + esc('#/map?storyline=' + encodeURIComponent(st.id)) + '">' + sym('open') + ' ' + esc(t('journeys.storyline.openMap')) + '</a>' : '')
      + (steps.length ? '<button class="rel jrn-story-first" onclick="openJourney(' + jsArg(steps[0].nodeId) + ', 1)">' + sym('start') + ' ' + esc(t('journeys.storyline.openFirst')) + '</button>' : '')
      + '</div></div>';
  }
  return html + '</div>';
}

/**
 * `#/journeys?storyline=<id>` (fast travel to a storyline with the Map off): the card of that storyline is marked and
 * scrolled to; a storyline nobody declares is said so above the cards, with a door to each one there is.
 */
function jrnShowStoryline(host, tree, id) {
  if (!id) return;
  const story = findStoryline(tree, id);
  if (story) {
    const card = [...host.querySelectorAll('.jrn-story[data-storyline]')].find((el) => el.dataset.storyline === story.id);
    if (card) { card.classList.add('hot'); card.scrollIntoView({ block: 'center' }); }
    return;
  }
  const list = (tree && tree.storylines) || [];
  const sec = host.querySelector('.jrn-stories') || host;
  const note = '<p class="set-note jrn-story-unknown"><span' + defAttrs('journeys.storyline.unknown') + '>' + esc(t('journeys.storyline.unknown').replace('{id}', id)) + '</span> '
    + (list.length ? '<span' + defAttrs('journeys.storyline.known') + '>' + esc(t('journeys.storyline.known')) + '</span> '
      + list.map((x) => '<a href="' + esc('#/journeys?storyline=' + encodeURIComponent(x.id)) + '">' + esc(x.name) + '</a>').join(' · ')
      : '<span' + defAttrs('journeys.storyline.noneKnown') + '>' + esc(t('journeys.storyline.noneKnown')) + '</span>') + '</p>';
  if (sec.classList && sec.classList.contains('jrn-stories')) sec.querySelector('h2').insertAdjacentHTML('afterend', note);
  else sec.insertAdjacentHTML('afterbegin', '<div class="set-sec jrn-stories">' + note + '</div>');
}

// ── the organised section: persona → group → journeys ───────────
/** The last tree the front door drew, kept so a group toggle need not refetch. */
let JRN_ORG = null;
const JRN_FOLD_KEY = 'fs-jrn-groups';
/** The groups a reader folded, by `persona/group` id — remembered in this browser. */
function jrnFoldedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(JRN_FOLD_KEY) || '[]')); } catch { return new Set(); }
}
/**
 * One organised section across the manifests in scope: a heading per persona
 * (its description and counts), its groups in order — folded or open, a persona
 * with one group shows no group heading — and the journey cards as the
 * manifests had them. `?persona=` and `?group=` in the hash narrow it.
 * @group Journey view
 * @business Every journey, by the person it is for and then by group, in the order the design says.
 */
function jrnOrganisedHtml(org, route) {
  const tree = org.tree;
  if (!tree || !tree.personas || !tree.personas.length) return '';
  const shown = filterTree(tree, route.persona, route.group);
  const filtered = shown !== tree;
  const rowsOf = new Map();
  const repoByFlow = new Map();
  for (const d of org.designs || []) for (const f of d.flows || []) { rowsOf.set(f.nodeId, d.screens || []); repoByFlow.set(f.nodeId, d.repo); }
  const folded = jrnFoldedGroups();
  const multi = new Map();
  for (const p of tree.personas) for (const g of p.groups) for (const j of g.journeys) {
    if (!multi.has(j.nodeId)) multi.set(j.nodeId, []);
    if (!multi.get(j.nodeId).includes(p)) multi.get(j.nodeId).push(p);
  }
  let html = '<div class="set-sec jrn-org"><h2' + defAttrs('journeys.persona.title') + '>' + esc(t('journeys.persona.title')) + '</h2>'
    + '<p class="set-note">' + esc(t('journeys.persona.sub')) + ' '
    + countedHtml(tree.counts.journeys, '/api/journeys', { cls: 'jrn-org-n' }) + '<span class="jrn-org-sep"> · </span>'
    + countedHtml(tree.counts.personas, '/api/journeys', { cls: 'jrn-org-n' }) + '<span class="jrn-org-sep"> · </span>'
    + countedHtml(tree.counts.groups, '/api/journeys', { cls: 'jrn-org-n' }) + '</p>'
    + (tree.derived ? '<p class="set-note">' + esc(t('portfolio.personaDerived')) + '</p>' : '');
  if (filtered) {
    const what = [route.persona ? jrnPersonaName(tree.personas.find((p) => p.id === route.persona) || { name: route.persona }) : '',
      route.group ? (jrnGroupName((tree.personas.flatMap((p) => p.groups).find((g) => g.id === route.group)) || { name: route.group })) : ''].filter(Boolean).join(' · ');
    html += '<p class="set-note jrn-org-filter">' + esc(t('journeys.persona.filtered').replace('{what}', what))
      + ' <a href="' + esc(location.hash.split('?')[0] || '#/journeys') + '">' + esc(t('journeys.persona.showAll')) + '</a></p>';
  }
  if (!shown.personas.length) return html + '<p class="set-note">' + esc(t('journeys.persona.empty')) + '</p></div>';
  for (const p of shown.personas) {
    html += '<section class="jrn-persona" data-persona="' + esc(p.id) + '">'
      + '<div class="jrn-phead"><a class="hud-label jrn-pname" href="' + esc('#/journeys?persona=' + encodeURIComponent(p.id)) + '">' + esc(jrnPersonaName(p)) + '</a>'
      + (p.id && !p.declared ? '<span class="api-chip"' + defAttrs('journeys.persona.undeclared') + '>' + esc(t('journeys.persona.undeclared')) + '</span>' : '')
      + '<span class="jrn-pcount">' + jrnOrgCountsHtml(p.counts) + '</span></div>'
      + (p.description ? '<p class="dsg-flow-desc">' + proseHtml(p.description) + '</p>' : '');
    const heads = p.groups.length > 1;
    for (const g of p.groups) {
      const key = p.id + '/' + g.id;
      const isFolded = heads && folded.has(key);
      const cards = g.journeys.map((f) => {
        const others = (multi.get(f.nodeId) || []).filter((x) => x !== p);
        const also = others.length ? '<span class="api-chip"' + defAttrs('journeys.persona.alsoUnder') + '>'
          + esc(t('journeys.persona.alsoUnder').replace('{names}', others.map(jrnPersonaName).join(' · '))) + '</span>' : '';
        return jrnFlowCardHtml(f, rowsOf.get(f.nodeId) || [], f.repo || repoByFlow.get(f.nodeId), !!f.pinned, also);
      }).join('');
      if (!heads) { html += '<div class="jrn-group" data-group="' + esc(g.id) + '">' + cards + '</div>'; continue; }
      const bodyId = 'jrn-g-' + cssId(key);
      html += '<div class="jrn-group' + (isFolded ? ' folded' : '') + '" data-group="' + esc(g.id) + '">'
        + '<div class="jrn-ghead"><button type="button" class="jrn-gtoggle" aria-expanded="' + (!isFolded) + '" aria-controls="' + esc(bodyId) + '"'
        + ' data-key="' + esc(key) + '" onclick="jrnToggleGroup(this)" aria-label="' + esc(t('journeys.persona.toggle') + ' · ' + jrnGroupName(g)) + '"><span class="jrn-chev" aria-hidden="true"></span>'
        + '<span class="jrn-gname">' + esc(jrnGroupName(g)) + '</span></button>'
        + '<span class="jrn-gcount">' + jrnOrgCountsHtml(g.counts) + '</span></div>'
        + (g.description ? '<p class="dsg-flow-desc">' + proseHtml(g.description) + '</p>' : '')
        + '<div class="jrn-gbody" id="' + esc(bodyId) + '"' + (isFolded ? ' hidden' : '') + '>' + cards + '</div></div>';
    }
    html += '</section>';
  }
  return html + '</div>';
}
/**
 * Fold or open one group of journeys, and remember it in this browser.
 * @group Journey view
 */
function jrnToggleGroup(btn) {
  const key = btn.dataset.key;
  const box = btn.closest('.jrn-group');
  const body = box && box.querySelector('.jrn-gbody');
  if (!body) return;
  const fold = !body.hidden;
  body.hidden = fold;
  box.classList.toggle('folded', fold);
  btn.setAttribute('aria-expanded', String(!fold));
  const set = jrnFoldedGroups();
  if (fold) set.add(key); else set.delete(key);
  try { localStorage.setItem(JRN_FOLD_KEY, JSON.stringify([...set])); } catch { /* a private window: the fold holds for this visit */ }
}

/** The front door's two answers, one read per scope and sync: a picker drawn twice in a row (a mount, then
 * a register or lens redraw) awaits the same read and paints back to back, never one under the pointer later. */
const JRN_DOOR = new Map();
function jrnFrontDoorData() {
  const key = jrnScopeParam() + '@' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || '');
  if (!JRN_DOOR.has(key)) {
    JRN_DOOR.clear();
    JRN_DOOR.set(key, (async () => {
      const data = await fetch('/api/design?scope=' + encodeURIComponent(jrnScopeParam())).then((r) => r.json());
      if (!data || data.error || !Array.isArray(data.designs) || !data.designs.length) return null;
      // the journeys themselves, organised persona → group above the manifests (§4.4) — read
      // before either is drawn, so the page lands in one paint and nothing moves under the pointer
      let got = null;
      try { got = await loadJourneyTree(data.designs); } catch (err) { got = null; }
      return { data, got };
    })().catch(() => { JRN_DOOR.delete(key); return null; }));
  }
  return JRN_DOOR.get(key);
}
/**
 * One design source: its name and manifest, the Figma file, the counts with
 * their definitions on hover, and the screen lists. Every count is a fact
 * from /api/design — nothing is derived here.
 * @group Journey view
 */
function jrnDesignCardHtml(d) {
  const c = d.counts || {};
  // flows only appear once the manifest declares any — an absent count is not a zero
  const keys = (c.flows != null ? ['flows'] : []).concat(['screens', 'designed', 'built', 'designOnly', 'codeOnly', 'drift']);
  // every count opens its tip — what it counts, over what, from where; drift adds
  // its breakdown by kind of difference, which is the half a reader acts on
  // (story swarm 2026-09-25: *18 DRIFT is the one number that won't explain itself*)
  const counts = '<div class="api-counts">' + keys.map((k) => '<span class="api-count' + (k === 'drift' && c[k] > 0 ? ' warn' : '') + '"'
    + plainTip(c[k] || 0, 'design.count.' + k, 'design.scope.manifest', '/api/design', k === 'drift' ? designDriftRows([...(d.screens || []), ...(d.flows || [])]) : null)
    + '><b>' + (c[k] || 0) + '</b><span>' + esc(t('design.count.' + k)) + '</span></span>').join('') + '</div>';
  const rows = d.screens || [];
  const notBuilt = rows.filter((s) => s.status === 'design-only');
  const built = rows.filter((s) => s.status === 'both');
  const isUrl = /^https?:\/\//.test(d.manifestPath || '');
  return '<div class="dsg-card"><h3>' + sym('design') + esc(d.name || '') + '</h3>'
    + '<div class="dsg-path">' + esc(d.repo || '') + ' · ' + esc(d.manifestPath || '')
      + (d.manifestPath && !isUrl ? vsl(d.repo, d.manifestPath, 1) : '') + '</div>'
    + (d.figmaFile ? '<div class="dsg-path">' + linkHtml(d.figmaFile, t('design.openFigma')) + '</div>' : '')
    + counts
    + (notBuilt.length ? '<div class="dsg-list"><span class="hud-label">' + esc(t('design.notBuilt')) + '</span>'
      + notBuilt.map(jrnDesignRowHtml).join('') + '</div>' : '')
    + (built.length ? '<div class="dsg-list"><span class="hud-label">' + esc(t('design.built')) + '</span>'
      + built.map(jrnDesignRowHtml).join('') + '</div>' : '')
    + '</div>';
}
/**
 * One flow the design declares — a named, ordered set of screens (a feature a
 * person moves through). Shows how much of it is built, the screens in order
 * with their status, the product docs that describe it, and runs the whole
 * flow as one journey. Screen names come from the surface's own rows, joined
 * by design id; nothing is invented when a row is missing.
 * @group Journey view
 * @business One named journey the design declares, and how much of it exists in code.
 */
function jrnFlowCardHtml(f, rows, repo, pinned, extra) {
  const byId = {};
  (rows || []).forEach((r) => { if (r.designId) byId[r.designId] = r; });
  const chips = (f.screens || []).map((id, i) => {
    const r = byId[id] || {};
    const cls = r.status === 'both' ? 'ok' : r.status === 'design-only' ? 'stub' : '';
    // a design id is how the design files the screen: the business register reads its name
    // (and the id only when the design gave it no name), as the journey's own header does
    const words = currentLens() === 'business' ? esc(r.name || id) : esc(id) + (r.name ? ' · ' + esc(r.name) : '');
    return '<span class="api-chip ' + cls + '"><b>' + (i + 1) + '</b>' + words + '</span>';
  }).join('');
  // the surface carries each doc's title beside its path (R21); an older server sends paths only
  const docs = (f.docLinks || f.docs || []).map((d) => jrnDocLinkHtml(repo, d)).join('');
  // one status word for a flow, the same one MCP prints: built · partly built
  // n of m · designed, not built (never "not built" of a whole flow)
  const built = f.built != null ? f.built : 0;
  const total = f.total != null ? f.total : (f.screens || []).length;
  const statusKey = total > 0 && built >= total ? 'journey.status.built'
    : built > 0 ? 'journey.status.partly' : 'journey.status.designedNotBuilt';
  const statusText = t(statusKey).replace('{n}', built).replace('{m}', total);
  return '<div class="dsg-flow' + (pinned ? ' pinned' : '') + '"><div class="dsg-flow-head">'
    + '<span class="dsg-flow-name">' + esc(f.name || f.id || '') + '</span>'
    + (pinned ? '<span class="pf-pin">' + esc(t('portfolio.pinned')) + '</span>' : '')
    + '<span class="api-chip ' + (statusKey === 'journey.status.built' ? 'ok' : 'stub') + '">' + esc(statusText) + '</span>'
    + (f.phase ? '<span class="api-chip">' + esc(t('design.phase')) + ' ' + esc(f.phase) + '</span>' : '')
    + (extra || '')
    // the status word already carries n of m when it is partly built — only a
    // fully built flow needs the count spelled out beside it
    + (statusKey === 'journey.status.built' ? '<span class="dsg-sub">' + esc(t('design.screensBuilt').replace('{b}', built).replace('{n}', total)) + '</span>' : '')
    + '</div>'
    + (f.description && proseHtml(f.description) ? '<p class="dsg-flow-desc">' + proseHtml(f.description) + '</p>' : '')
    + (chips ? '<div class="dsg-chips">' + chips + '</div>' : '')
    + (docs ? '<div class="dsg-docs">' + docs + '</div>' : '')
    + (f.nodeId ? '<button class="rel" onclick="openJourney(' + jsArg(f.nodeId) + ')">' + sym('start') + ' ' + esc(t('journey.openJourney')) + '</button>' : '')
    + '</div>';
}
/**
 * A repo-relative product doc as a ⧉ link into the editor, labelled by the
 * document's own H1 when ingest read one (`link.title`) and by its file name
 * when it did not — `0006 — Low-friction contractor flow` tells a reader
 * whether to open it; `0006-low-friction-contractor-flow.md` does not (R21).
 * The path is always on the hover. Takes either a link object from a node or
 * a bare path (a surface row that carries no title).
 * @group Journey view
 */
function jrnDocLinkHtml(repo, link) {
  const path = link && typeof link === 'object' ? (link.ref || link.url) : link;
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return linkHtml(path);
  const title0 = link && typeof link === 'object' && link.title ? String(link.title) : '';
  const business = currentLens() === 'business';
  // a document's title is words somebody wrote, and its number (`0021 —`) is the
  // citation key a reader quotes it by — kept in every register (swarm 2026-10-05,
  // the business analyst: "the number is the citation key I need"); a bare file name
  // is how the repository files it, and the business lens does not read that
  const num = (title0.match(/^\s*(\d{2,5})\s*[—–-]\s*/) || [])[1] || '';
  const rest = plainWords(title0.replace(/^\s*\d{2,5}\s*[—–-]\s*/, ''));
  const title = business ? (rest ? (num ? num + ' — ' : '') + rest : '') : title0;
  if (business && !title) return '';
  const base = String(path).split('/').pop();
  // the hover keeps the path — and the whole title, since a narrow lane clips it
  return '<span class="dsg-doc" title="' + esc(title ? title + '\n' + path : path) + '"><span class="l">' + esc(title || base) + '</span>' + vsl(repo, path, 1) + '</span>';
}
/**
 * A drift count's breakdown: one row per kind of difference, in words, with how
 * many of that kind — the rows sum to the count they explain.
 * @group Journey view
 */
function designDriftRows(rows) {
  const by = {};
  for (const r of rows) for (const x of (r.drift || [])) by[x.kind] = (by[x.kind] || 0) + 1;
  return Object.keys(by).sort((a, b) => by[b] - by[a] || (a < b ? -1 : 1)).map((k) => [t('design.drift.' + k), by[k]]);
}
/**
 * One screen row in the Designs section — its design id, name, route and
 * drift count; clicking runs that screen as a journey (a design-only screen
 * runs entirely as planned steps).
 * @group Journey view
 */
function jrnDesignRowHtml(s) {
  const drift = (s.drift || []).length;
  return '<button class="rel" onclick="openJourney(' + jsArg(s.nodeId) + ')">'
    + (s.designId ? '<span class="dsg-id">' + esc(s.designId) + '</span>' : '')
    + esc(s.name || '')
    + (s.route ? '<span class="dsg-sub">' + esc(s.route) + '</span>' : '')
    + (drift ? '<span class="dsg-sub"'
      // inside a button: the tip opens on hover and is not a second tab stop in the row
      + tipAttrs({ number: { count: drift, of: 'design.count.drift', scope: 'design.scope.screen', source: tipSource('/api/design'), breakdown: { rows: designDriftRows([s]) } }, noFocus: true }) + '>' + sym('warning') + ' ' + drift + ' ' + esc(t('design.count.drift')) + '</span>' : '')
    + '</button>';
}

/** Tear the overlay down without navigating (router leaves the surface).
 * @group Journey view */
export function hideJourneyOverlay() {
  const j = document.getElementById('journey');
  if (!j.classList.contains('open')) return;
  j.classList.remove('open');
  releaseFocus();
  if (S.journeyObserver) { S.journeyObserver.disconnect(); S.journeyObserver = null; }
  jrnToggleForks(false);
}

// ── journey helpers ─────────────────────────────────────────────
/**
 * Stable per-repo band colour: hash the repo name into the 6-colour token cycle.
 * @group Journey view
 */
function jrnRepoColor(repo) { let h = 0; const s = String(repo || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return JRN_REPO_COLORS[h % JRN_REPO_COLORS.length]; }
/** Business/humanized label for a journey node (server bizLabel, else humanize).
 * @group Journey view */
export function jrnLabel(n) { return (n && n.bizLabel) || humanize((n && n.name) || ''); }
/** Words somebody wrote, in the lens on screen: the business lens reads their plain
 * words (no document ids, paths or identifiers — `plainWords`), the others read them whole.
 * @group Journey view */
export function jrnWords(text) { return currentLens() === 'business' ? plainWords(text) : String(text || ''); }
/** An action's name in the lens on screen — the business lens reads its plain words,
 * then the sentence written for it, and says so where nobody wrote any.
 * @group Journey view */
export function jrnMoLabel(mo) {
  if (!mo) return '';
  if (currentLens() !== 'business') return unTick(mo.label);
  return plainWords(mo.label) || plainWords(mo.business) || t('journey.biz.noWords');
}
/** A stop the design declares and no call made, named the same way.
 * @group Journey view */
export function jrnDeclLabel(d) {
  if (currentLens() !== 'business') return String((d && (d.label || d.op)) || '');
  return plainWords(d && d.label) || t('journey.biz.noWords');
}
/** A design id beside a screen's name — outside the business lens, which reads the name alone.
 * @group Journey view */
export function jrnDesignIdHtml(sg) {
  return sg && sg.screen && sg.screen.designId && currentLens() !== 'business' ? '<span class="dsg-id">' + esc(sg.screen.designId) + '</span>' : '';
}
/**
 * Verb shown on a step's incoming arrow, keyed by edge kind.
 * @group Journey view
 */
function jrnVerb(s) {
  const n = s.node || {};
  switch (s.via) {
    case 'calls': return 'calls';
    case 'http': return (n.name && /^(GET|POST|PUT|PATCH|DELETE)\b/.test(n.name)) ? 'HTTP ' + n.name : 'HTTP call';
    case 'renders': return 'shows';
    case 'publishes': return 'emits';
    case 'consumes': return 'handles';
    case 'reads': return 'reads';
    case 'writes': return 'saves to';
    case 'planned': return t('journey.planned.' + ((s.planned || {}).kind || 'step'));
    default: return '';
  }
}
/**
 * A planned step that carries the REAL route node the design says the screen
 * calls (`planned.kind === 'calls'`): it renders as the route card everywhere,
 * dashed and marked, not as an abstract planned card.
 * @group Journey view
 */
function jrnIsPlannedCall(s) { return !!(s && s.planned && s.planned.kind === 'calls' && s.node); }

/**
 * One screen card in band 1: the derived page/component card in the graph's
 * own language plus what the design says about it — the thumbnail (large in
 * the business lens, hidden in the code lens), the design chip, and every ⧉
 * reference the screen has (design, the page file, each rendered component,
 * product docs). A screen is NOT a step: it carries no data-order, so
 * scroll-sync and j/k never see it.
 *
 * With a segment it also carries the **tests foot** (B4.2, board 07): what
 * proves this screen runs, read off `summary.coverage.segments[i]` — the
 * server's own fold, so the card and the Tests surface cannot disagree.
 * @group Journey view
 * @business Shows the screen a person is looking at during this journey, as it was designed, and what proves it runs.
 */
function jrnScreenCardHtml(n, big, ord, u, sg) {
  const row = u || {};
  const business = currentLens() === 'business';
  const desc = jrnWords(n.bizDescription || n.docs || row.business || '');
  const design0 = n.design || (row.designId || row.designStatus ? { status: row.designStatus, id: row.designId } : null);
  // the design's id (`SCR-01`) is how the authors cross-reference the manifest: a
  // business reader gets the status in words and not the id (pass swarm 2026-09-25)
  const design = design0 && business ? Object.assign({}, design0, { id: '' }) : design0;
  // the components a screen renders are code: their ⧉ links are for the other lenses
  const refs = jrnRefAnchors(n).concat(business ? [] : jrnComponentAnchors(row));
  (row.links || []).forEach((l) => {
    if (!l || l.kind === 'design') return;
    if (l.kind === 'see' && l.url) refs.push(linkHtml(l.url));
    else if (l.kind === 'doc' && !business) refs.push(l.url ? linkHtml(l.url) : jrnDocLinkHtml(n.repo || (n.loc && n.loc.repo), l));
  });
  return '<div class="node jrn-screen" style="border-left:3px solid ' + jrnRepoColor(n.repo) + '">'
    + (ord ? '<span class="dsg-ord">' + ord + '</span>' : '')
    + designThumbHtml(n, big ? 'lg' : '')
    + nodeCardHtml(n, false)
    + (desc ? '<div class="jrn-cdesc">' + esc(desc) + '</div>' : '')
    + (design ? '<div class="dsg-chips">' + designChipHtml(design) + '</div>' : '')
    + (refs.length ? '<div class="jrn-cdesc jrn-links" onclick="event.stopPropagation()">' + refs.join(' ') + '</div>' : '')
    + storyChipsHtml(screenStoryIds(n, row.components))
    + (sg ? jrnScreenFootHtml(sg) : '')
    + '</div>';
}
/** The tests foot of one screen card, from the segment's own coverage — never summed with its neighbours'.
 * @group Journey view */
function jrnScreenFootHtml(sg) {
  const cov = S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.coverage;
  const segCov = cov && cov.segments && cov.segments[sg.index];
  // its own class, not jrn-cdesc: the code register hides descriptions on a
  // screen card, and what proves the screen runs is not a description
  return '<div class="jrn-cfoot" onclick="event.stopPropagation()">'
    + jrnTestsFootHtml(segCov ? jrnScopeTestFacts(segCov) : null, { absent: 'journey.tests.noneScreen', cases: { seg: sg.index } })
    + '</div>';
}
/**
 * ⧉ links to the components a screen renders — the code a developer opens when
 * the business points at a screen. Only components already in the graph with a
 * location render; nothing is invented for the rest.
 * @group Journey view
 */
function jrnComponentAnchors(u) {
  return (u.components || []).map((id) => {
    const c = S.BYID[id];
    if (!c || !c.loc) return '';
    return '<span class="dsg-doc">' + esc(c.name || '') + vsl(repoOf(c), c.loc.path, c.loc.line) + '</span>';
  }).filter(Boolean);
}
/**
 * Cross-boundary divider text for a step, or '' if it isn't a boundary.
 * Shown in the map and, in the code pane, at the step's splice point.
 * @group Journey view
 */
function jrnBannerHtml(s) {
  const n = s.node || {};
  let text = '', cls = 'jrn-banner', icon = '';
  if (s.via === 'http') text = '⇄ HTTP ' + (n.name || 'call') + ' → ' + (n.repo || '');
  else if (s.via === 'publishes') { icon = sym('bolt'); text = ' async via ' + (n.name || 'queue'); cls += ' async'; }
  else if (s.via === 'consumes') { icon = sym('bolt'); text = ' async → ' + (n.name || '') + ' (' + (n.repo || '') + ')'; cls += ' async'; }
  else if (s.crossRepo) text = '⇄ crosses into ' + (n.repo || '');
  else return '';
  return '<div class="' + cls + '">' + icon + esc(text) + '</div>';
}

// ── journey tree & splice (pure — no DOM, unit-testable) ────────
/**
 * Pure: build parent/children/roots from the DFS pre-order depth sequence
 * of journey steps (the wire order from /api/journey).
 * @group Journey view
 */
function jrnBuildTree(steps) {
  const parent = steps.map(() => -1), children = steps.map(() => []), roots = [], stack = [];
  steps.forEach((s, i) => {
    const d = s.depth || 0;
    while (stack.length && (steps[stack[stack.length - 1]].depth || 0) >= d) stack.pop();
    if (stack.length) { parent[i] = stack[stack.length - 1]; children[parent[i]].push(i); } else roots.push(i);
    stack.push(i);
  });
  return { parent, children, roots };
}
/**
 * Pure: split a code block spanning absolute lines
 * [startLine … startLine+lineCount-1] at child call sites. kids is
 * [{idx,line}] where line is the call-site line (null when the call site is
 * not inside this block). Returns ordered segment descriptors:
 * {kind:'code',from,to} (1-based, inclusive) interleaved with
 * {kind:'child',idx}; each splice cuts after the call line; children whose
 * call site is outside the block append at the end with detached:true.
 * @group Journey view
 */
function jrnSpliceSegments(startLine, lineCount, kids) {
  const endLine = startLine + lineCount - 1, segs = [];
  const inline = kids.filter((k) => k.line != null && lineCount > 0 && k.line >= startLine && k.line <= endLine)
    .sort((a, b) => a.line - b.line || a.idx - b.idx);
  const inSet = new Set(inline.map((k) => k.idx));
  let cur = startLine;
  if (lineCount > 0) {
    for (const k of inline) {
      if (k.line >= cur) { segs.push({ kind: 'code', from: cur, to: k.line }); cur = k.line + 1; }
      segs.push({ kind: 'child', idx: k.idx });
    }
    if (cur <= endLine) segs.push({ kind: 'code', from: cur, to: endLine });
  }
  kids.forEach((k) => { if (!inSet.has(k.idx)) segs.push({ kind: 'child', idx: k.idx, detached: true }); });
  return segs;
}
/** Children of step i as splice inputs: call-site line when it lands in the
 * parent's own file, else null (detached).
 * @group Journey view */
function jrnKidsOf(i) {
  const p = S.JOURNEY.steps[i] || {}, ppath = p.node && p.node.loc && p.node.loc.path;
  return S.JRN_TREE.children[i].map((ci) => {
    const cs = (S.JOURNEY.steps[ci] || {}).callSite;
    return { idx: ci, line: (cs && ppath && cs.path === ppath) ? cs.line : null };
  });
}
/** Accumulated path conditions (root-first along the step tree) that must
 * hold to reach step i — the "state needed to get here" recipe.
 * @group Journey view */
function jrnAccConditions(i) {
  const chain = [];
  for (let cur = i; cur != null && cur >= 0; cur = S.JRN_TREE.parent[cur]) chain.push(cur);
  const out = [];
  chain.reverse().forEach((si) => ((((S.JOURNEY.steps[si] || {}).conditions)) || []).forEach((c) => out.push(c)));
  return out;
}
/** Journey children of step i whose call-site line sits inside [from,to]
 * of step i's own file (used to link fork arms to steps).
 * @group Journey view */
function jrnCallsInSpan(i, from, to) {
  return jrnKidsOf(i).filter((k) => k.line != null && k.line >= from && k.line <= to).map((k) => k.idx);
}

// ── journey fork cards & panel ──────────────────────────────────
/** Outcome markup for one fork arm: step links when a tracked call sits in the
 * arm's span, an exit note for guard-clause arms, else "no tracked calls".
 * @group Journey view */
function jrnArmOutcome(i, bp, arm) {
  const hits = jrnCallsInSpan(i, arm.line || 0, arm.endLine || 0);
  // the arm names the part it reaches and the stop that part sits in — a walk
  // index (`step 38`) is not a position a reader can find anywhere else
  if (hits.length) return hits.map((ci) => '<span class="jrn-fk-step" onclick="event.stopPropagation();jrnScrollTo(' + ci + ')">'
    + esc(t('journey.fork.jump').replace('{name}', ((S.JOURNEY.steps[ci] || {}).node || {}).name || '')) + (jrnStopText(ci) ? ' · ' + esc(jrnStopText(ci)) : '') + '</span>').join(' ');
  if (arm.exits || (bp.exits && (bp.arms || []).length === 1)) return '<span class="jrn-fk-exit">' + esc(t('journey.fork.exits')) + '</span>';
  return '<span class="jrn-fk-none">' + esc(t('journey.fork.noCalls')) + (bp.exits ? ' · ' + esc(t('journey.fork.mayExit')) : '') + '</span>';
}
/** Inline fork card for branch point bi of step i, toggled from the fork gutter:
 * lens-aware condition (business label + raw), category chip, arms with
 * business label + requires + outcome. Both label and raw spans are emitted
 * (.fk-biz / .fk-req, container .has-biz); lens CSS decides which shows.
 * @group Journey view */
function jrnForkCardHtml(i, bi, bp) {
  const cat = bp.category || 'branch';
  const sn = ((S.JOURNEY.steps[i] || {}).node) || {};
  const arms = (bp.arms || []).map((a) => '<span class="jrn-fk-arm' + (a.business ? ' has-biz' : '') + '"><span class="jrn-fk-lbl">' + esc(a.label || '') + '</span>'
    + (a.business ? '<span class="fk-biz">' + esc(a.business) + '</span>' : '')
    + '<span class="jrn-fk-req fk-req">' + esc(a.requires || '') + '</span>' + jrnArmOutcome(i, bp, a) + '</span>').join('');
  return '<span class="jrn-fork-card" id="jrn-fc-' + i + '-' + bi + '" style="display:none" onclick="event.stopPropagation()">'
    + '<span class="jrn-fk-head' + (bp.business ? ' has-biz' : '') + '">' + sym('fork') + ' '
      + (bp.business ? '<span class="fk-biz">' + esc(bp.business) + '</span>' : '')
      + '<span class="fk-req">' + esc(bp.condition || '') + '</span>'
      + '<span class="jrn-fk-cat cat-' + esc(cat) + '">' + esc(cat) + '</span>'
      + (sn.loc ? vsl(sn.repo, sn.loc.path, bp.line || sn.loc.line) : '') + '</span>'
    + arms + '</span>';
}
/** Toggle an inline fork card open/closed from its gutter line.
 * @group Journey view */
function jrnToggleFork(id, ev) {
  if (ev) ev.stopPropagation();
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}
/** All unique forks along the journey as [{i,bi,bp}], deduped by node id so a
 * repeated step doesn't list its branches twice.
 * @group Journey view */
function jrnCollectForks() {
  const out = [], seen = new Set();
  ((S.JOURNEY && S.JOURNEY.steps) || []).forEach((s, i) => {
    const n = s.node || {};
    if (!Array.isArray(n.branches) || !n.branches.length) return;
    const key = n.id || ('step' + i);
    if (seen.has(key)) return; seen.add(key);
    n.branches.forEach((bp, bi) => out.push({ i, bi, bp }));
  });
  return out;
}
/** One forks-panel entry: condition + location, arms with requires, outcome
 * step links and a copyable mock-state recipe (accumulated requires ∧ arm).
 * @group Journey view */
export function jrnForkEntryHtml(f) {
  const s = S.JOURNEY.steps[f.i] || {}, n = s.node || {};
  if (currentLens() === 'business') return jrnForkEntryBizHtml(f, n, 1);
  const loc = (n.loc ? n.loc.path : '') + ':' + (f.bp.line || '');
  const acc = jrnAccConditions(f.i).map((c) => c.requires).filter(Boolean);
  const arms = (f.bp.arms || []).map((a) => {
    // recipe stays raw code (reproduces state) in every lens — not lens-aware
    const recipe = acc.concat(a.requires ? [a.requires] : []).join(' && ');
    return '<div class="jrn-fkp-arm' + (a.business ? ' has-biz' : '') + '"><span class="jrn-fk-lbl">' + esc(a.label || '') + '</span>'
      + (a.business ? '<span class="fk-biz">' + esc(a.business) + '</span>' : '')
      + '<span class="jrn-fk-req fk-req">' + esc(a.requires || '') + '</span>' + jrnArmOutcome(f.i, f.bp, a)
      + (recipe ? '<button class="jrn-fk-copy" data-recipe="' + esc(recipe) + '" onclick="jrnCopyRecipe(this,event)" title="Copy mock-state recipe">' + sym('open') + '</button>' : '') + '</div>';
  }).join('');
  return '<div class="jrn-fkp-entry" onclick="jrnForkJump(' + f.i + ',' + f.bi + ')">'
    + '<div class="jrn-fkp-cond' + (f.bp.business ? ' has-biz' : '') + '">' + sym('fork') + ' '
      + (f.bp.business ? '<span class="fk-biz">' + esc(f.bp.business) + '</span>' : '')
      + '<span class="fk-req">' + esc(f.bp.condition || '') + '</span></div>'
    + '<div class="jrn-fkp-loc">' + esc(loc) + ' · ' + esc(n.name || '') + (n.loc ? vsl(n.repo, n.loc.path, f.bp.line || n.loc.line) : '') + '</div>' + arms + '</div>';
}
/** Step order → the segment marker the fold drew for it, so the drawer can
 * reach the words the fold already chose for that part (`SegmentMarker.title`
 * — an authored @business label, a verb-named handler's route summary, or the
 * first sentence a person wrote). Rebuilt per drawer render; an older server
 * with no summary simply yields nothing and every caller falls back.
 * @group Journey view */
let JRN_FORK_MARKS = null;
/** @group Journey view */
function jrnForkMarks() {
  if (JRN_FORK_MARKS) return JRN_FORK_MARKS;
  const m = new Map();
  const sum = (S.JOURNEY && S.JOURNEY.summary) || null;
  ((sum && sum.segments) || []).forEach((sg) => (sg.markers || []).forEach((mk) => {
    if (mk.stepOrder != null && !m.has(mk.stepOrder)) m.set(mk.stepOrder, mk);
  }));
  JRN_FORK_MARKS = m;
  return m;
}
/** The words a person wrote about the part step i sits in, or '' when nobody
 * wrote any. Never `humanize()`: an identifier bent into title case is a guess,
 * and the drawer's whole point in this register is that it does not guess.
 * @group Journey view */
function jrnForkPartWords(i, n) {
  const title = jrnMarkerTitle(jrnForkMarks().get(i));
  if (title) return title;
  const label = n && n.bizLabel && n.bizLabel !== n.name ? String(n.bizLabel) : '';
  return label;
}
/**
 * One forks-drawer entry in the business register. A branch carries a
 * plain-language label only where someone wrote a `// @business` directive on
 * it; on the journeys measured here none of them does. So this prints what the
 * graph does support — the sentence a person wrote about the part the branch
 * sits in — and then says, in the closed absence vocabulary, that the condition
 * itself was never written in plain language. The condition, its arms and what
 * each arm requires stay in the other two registers: they are code, and this is
 * the register that hides code.
 * @group Journey view
 * @business One place the journey can go more than one way, named by the part of the app it sits in.
 */
function jrnForkEntryBizHtml(f, n, count) {
  const head = plainWords(String(f.bp.business || '').trim() || jrnForkPartWords(f.i, n));
  const untr = '<span class="jrn-fkp-untr" title="' + esc(def('journey.biz.absent.notTranslated') || '') + '">'
    + sym('absent') + esc(t('journey.biz.absent.notTranslated')) + '</span>';
  // the same part, holding several of them: one card and ×n — the idiom the
  // gate checkpoints already fold with, so nothing new is spelled and the
  // group's count above still adds up to every branch, not to every card
  const many = count > 1
    ? '<span class="jrn-fkp-n" title="' + esc(def('journey.biz.untranslated') || '') + '">×' + count + '</span>' : '';
  return '<div class="jrn-fkp-entry biz" onclick="jrnForkJump(' + f.i + ',' + f.bi + ')">'
    + '<div class="jrn-fkp-biz">' + sym('fork')
    + (head ? '<b>' + esc(head) + '</b>' : untr) + many + '</div>'
    + (head && !f.bp.business ? '<div class="jrn-fkp-sub">' + untr + '</div>' : '') + '</div>';
}
/** One category's forks as cards. The business register folds the branches of
 * one part into a single card with ×n — ten identical sentences in a row is not
 * a list, and the group's count above still counts branches, not cards.
 * @group Journey view */
function jrnForkListHtml(list, biz) {
  if (!biz) return list.map(jrnForkEntryHtml).join('');
  let out = '';
  for (let k = 0; k < list.length;) {
    const id = (list[k].i) + '|' + (((S.JOURNEY.steps[list[k].i] || {}).node || {}).id || '');
    let j = k + 1;
    while (j < list.length && ((list[j].i) + '|' + (((S.JOURNEY.steps[list[j].i] || {}).node || {}).id || '')) === id) j++;
    out += jrnForkEntryBizHtml(list[k], ((S.JOURNEY.steps[list[k].i] || {}).node || {}), j - k);
    k = j;
  }
  return out;
}
/**
 * Forks-drawer markup: every fork grouped by category
 * (access → guard → state → error → flag → branch).
 * @group Journey view
 */
function jrnForksPanelHtml(forks) {
  JRN_FORK_MARKS = null;
  const biz = currentLens() === 'business';
  // the same drawer, the same groups, the same counts in every register — only
  // the words change, so a reader who switches registers keeps their place
  const title = esc(t(biz ? 'journey.biz.forks.title' : 'journey.forks.title'));
  const tip = esc(def(biz ? 'journey.biz.forks.title' : 'journey.forks.title') || '');
  const head = '<div class="jrn-fkp-head"><span class="hud-label" title="' + tip + '">' + title + '</span>'
    + '<button class="x" onclick="jrnToggleForks()" aria-label="' + esc(t('journey.closeExpanded')) + '">✕</button></div>';
  if (!forks.length) return head + '<div class="jrn-fkp-empty">' + esc(t('journey.forks.empty'))
    + (biz ? '' : '<br>' + esc(t('journey.forks.reingest'))) + '</div>';
  const byCat = {};
  forks.forEach((f) => { const c = f.bp.category || 'branch'; (byCat[c] = byCat[c] || []).push(f); });
  const cats = JRN_CATS.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => !JRN_CATS.includes(c)));
  return head + cats.map((cat) => '<div class="jrn-fkp-cat">' + jrnForkCatChip(cat, biz)
      + '<span class="jrn-fkp-n">' + byCat[cat].length + '</span></div>'
      + jrnForkListHtml(byCat[cat], biz)).join('');
}
/** The chip naming how a branch was sorted. Two of the six kinds are read off
 * the branch's shape (a catch, a path that returns or throws) and are facts;
 * the other four are a word match on the condition text, which is why the
 * business register says "looks like" and every define names which it is.
 * @group Journey view */
function jrnForkCatChip(cat, biz) {
  const key = (biz ? 'journey.biz.forkCat.' : 'journey.forkCat.') + cat;
  const known = S.STRINGS && S.STRINGS[key];
  return '<span class="jrn-fk-cat cat-' + esc(cat) + (biz ? ' biz' : '') + '"'
    + (known && def(key) ? ' title="' + esc(def(key)) + '"' : '') + '>'
    + esc(known ? t(key) : cat) + '</span>';
}
/** Open/close the forks drawer (pass true/false to force a state).
 * @group Journey view */
function jrnToggleForks(force) {
  S.jrnForksOpen = (force === true || force === false) ? force : !S.jrnForksOpen;
  const d = document.getElementById('jrn-forks');
  if (d) { d.classList.toggle('open', S.jrnForksOpen); jrnDrawerInert(d, S.jrnForksOpen); }
}
/**
 * A drawer parked off the right edge is out of reach, not only out of sight:
 * `inert` takes its stops out of the tab order and the accessibility tree. The
 * forks drawer holds a stop per branch — 311 on the POC — and a keyboard reader
 * walked into them off-screen, 343 of 400 stops with no ring in view (pass swarm
 * 2026-09-25, SDET blocker).
 * @group Journey view
 */
function jrnDrawerInert(d, open) {
  if (open) d.removeAttribute('inert'); else d.setAttribute('inert', '');
  d.setAttribute('aria-hidden', open ? 'false' : 'true');
}
/** Jump from a forks-panel entry to its step on the timeline: expand the step,
 * then scroll to and flash the fork line inside the expanded code.
 * @group Journey view */
function jrnForkJump(i, bi) {
  // the drawer sends a reader to a decision; the lane's view that draws it opens with them
  jrnRevealBizTab(i);
  jrnScrollTo(i);
  const line = document.getElementById('jrn-fl-' + i + '-' + bi);
  if (line && line.offsetParent) {
    line.scrollIntoView({ behavior: 'smooth', block: 'center' });
    line.classList.add('flash'); setTimeout(() => line.classList.remove('flash'), 1200);
  }
}
/** Copy a mock-state recipe (from data-recipe) to the clipboard.
 * @group Journey view */
function jrnCopyRecipe(btn, ev) {
  if (ev) ev.stopPropagation();
  navigator.clipboard.writeText(btn.dataset.recipe || '');
  btn.innerHTML = '✓'; setTimeout(() => { btn.innerHTML = sym('open'); }, 1200);
}

// ── journey rendering ───────────────────────────────────────────
/** Requires-chips for a step header: accumulated conditions to reach the step
 * (cap 3 shown, +n), amber-bordered like gate chips. Lens-aware: business label
 * (.fk-biz) beside the raw condition (.fk-req) — lens CSS shows the right one.
 * @group Journey view */
export function jrnReqChips(i) {
  // the business lens names only the conditions somebody wrote words for: a
  // condition in code (`canFile(accounts)`) is not a sentence
  const cs = jrnAccConditions(i).filter((c) => currentLens() !== 'business' || c.business);
  if (!cs.length) return '';
  const shown = cs.slice(0, 3).map((c) => '<span class="jrn-req' + (c.business ? ' has-biz' : '') + '" title="' + esc((c.name || '') + ' ' + (c.path || '') + ':' + (c.line || '')) + '">' + sym('fork') + ' '
    + (c.business ? '<span class="fk-biz">' + esc(c.business) + '</span>' : '')
    + '<span class="fk-req">' + esc(c.requires || '') + '</span></span>').join('');
  return '<span class="jrn-reqs">' + shown + (cs.length > 3 ? '<span class="jrn-req more">+' + (cs.length - 3) + '</span>' : '') + '</span>';
}
/**
 * The reference anchors for a node, unwrapped: the design deep link, `@see`
 * URLs, and the repo-relative product docs a flow points at (⧉ into the
 * editor). Returned as an array so callers choose their own container.
 * @group Journey view
 */
export function jrnRefAnchors(n) {
  const out = [];
  if (n.design && n.design.url) out.push(linkHtml(n.design.url, t('insp.designOpen')));
  (n.links || []).forEach((l) => {
    if (!l) return;
    if (l.kind === 'see' && l.url) out.push(linkHtml(l.url));
    else if (l.kind === 'doc') out.push(l.url ? linkHtml(l.url) : jrnDocLinkHtml(n.repo || repoOf(n), l));
  });
  return out.filter(Boolean);
}
// ── business flow map ───────────────────────────────────────────
/**
 * Business phrasing for a journey gate: guard/rule name minus code prefixes.
 * @group Journey view
 */
export function jrnGateText(g) { return String(g.name || '').replace(/^requireScope: /, 'scope '); }
/**
 * Decision block for step i in the business flow: a diamond with the fork's
 * business label (`@business` tag on the branch point/arm, else the raw
 * condition), the pathway taken (✓, continues below), and every other arm as
 * a labeled alternate pathway — linking to the step it leads to, or marked as
 * ending the flow. Built from the hop's path conditions plus the parent
 * node's branch data.
 * @group Journey view
 * @business Shows each decision as a diamond with the paths the process can take.
 */
function jrnFlowDecision(s, i) {
  // a step can sit under several forks; the diamond is the TRANSLATED one (business or guard
  // class) — a technical `catch` arm on the same hop is counted, never drawn. Older servers
  // carry no class: then every condition is a candidate, as before.
  const conds = (s.conditions || []).filter((c) => c && c.requires && (!c.class || c.class !== 'technical'));
  if (!conds.length) return '';
  const c0 = conds[0];
  const pi = S.JRN_TREE.parent[i];
  const pn = pi >= 0 ? (((S.JOURNEY.steps[pi] || {}).node) || {}) : {};
  const bp = (pn.branches || []).find((b) => b && b.line === c0.line);
  let alts = '';
  if (bp) {
    (bp.arms || []).forEach((a) => {
      if (a.label === c0.arm) return;
      const hits = pi >= 0 ? jrnCallsInSpan(pi, a.line || 0, a.endLine || 0) : [];
      const out = hits.length
        ? hits.map((ci) => '<span class="jrn-fl-goto" onclick="event.stopPropagation();jrnScrollTo(' + ci + ')">→ ' + esc(jrnLabel(((S.JOURNEY.steps[ci] || {}).node) || {})) + '</span>').join(' ')
        : (a.exits || bp.exits ? '<span class="jrn-fl-ends">' + sym('stopped') + ' flow ends here</span>' : '<span class="jrn-fl-ends">no tracked steps</span>');
      alts += '<div class="jrn-fl-arm"><span class="jrn-fl-armlbl">' + esc(a.label || 'else') + '</span>'
        + (a.business ? '<span class="jrn-fl-armtxt">' + esc(a.business) + '</span>' : '') + out + '</div>';
    });
  }
  return '<div class="jrn-fl-dec" title="' + esc(conds.map((c) => c.requires).join(' && ')) + '">'
    + '<div class="jrn-fl-diamond"><span class="jrn-fl-dq"><i>?</i></span>'
      + '<span class="jrn-fl-dtxt">' + esc(c0.business || c0.requires) + '</span>'
      + (conds.length > 1 ? '<span class="jrn-fl-more">+' + (conds.length - 1) + ' more</span>' : '') + '</div>'
    + '<div class="jrn-fl-taken">✓ ' + esc(c0.business ? c0.business : 'when ' + c0.requires) + ' — continues below</div>'
    + (alts ? '<div class="jrn-fl-alts">' + alts + '</div>' : '') + '</div>';
}
/**
 * One line-numbered code segment of step i covering absolute lines [from,to]:
 * true gutter via the CSS counter, ↳ highlight on child call lines, clickable
 * drawn fork markers on branch lines (from node.branches) with inline fork cards.
 * @group Journey view
 */
function jrnCodeSeg(s, i, from, to, lines, startLine, callLines) {
  const branches = (s.node && s.node.branches) || [];
  let out = '';
  for (let L = from; L <= to; L++) {
    const txt = lines[L - startLine] != null ? lines[L - startLine] : '';
    const bIdx = branches.findIndex((b) => b && b.line === L);
    const isCall = callLines.has(L);
    const mark = '<span class="lm">' + (bIdx >= 0 ? sym('fork') : isCall ? '↳' : '') + '</span>';
    out += '<span class="cl' + (isCall ? ' call' : '') + (bIdx >= 0 ? ' fork' : '') + '"'
      + (bIdx >= 0 ? ' id="jrn-fl-' + i + '-' + bIdx + '" onclick="jrnToggleFork(\'jrn-fc-' + i + '-' + bIdx + '\',event)" title="' + esc((branches[bIdx].business ? branches[bIdx].business + ' — ' : '') + (branches[bIdx].category || 'branch') + ' fork — click for arms') + '"' : '')
      + '>' + mark + (esc(txt) || ' ') + '</span>';
    if (bIdx >= 0) out += jrnForkCardHtml(i, bIdx, branches[bIdx]);
  }
  return '<pre class="jrn-pre" style="counter-reset:jrnln ' + (from - 1) + '">' + out + '</pre>';
}
/**
 * Body of step i: code segments split at child call sites, interleaved with
 * the children's own sections nested at their splice point (banner first);
 * detached children (call site not in this file) append after the last
 * segment; steps with no code render a compact event card.
 * @group Journey view
 */
function jrnSegmentsHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const lines = (s.code == null || s.code === '') ? [] : String(s.code).split('\n');
  const startLine = s.codeStartLine || (n.loc && n.loc.line) || 1;
  const kids = jrnKidsOf(i);
  const callLines = new Set(kids.map((k) => k.line).filter((l) => l != null));
  const segs = jrnSpliceSegments(startLine, lines.length, kids);
  let html = '';
  if (!lines.length) html += '<div class="jrn-event">' + esc(jrnVerb(s) || 'event') + (n.loc ? ' · ' + esc(n.loc.path) : '') + '</div>';
  segs.forEach((g) => {
    if (g.kind === 'code') html += jrnCodeSeg(s, i, g.from, g.to, lines, startLine, callLines);
    else {
      const c = S.JOURNEY.steps[g.idx] || {};
      html += '<div class="jrn-splice" style="border-left-color:' + jrnRepoColor(c.node && c.node.repo) + '">'
        + jrnBannerHtml(c) + jrnSectionHtml(g.idx) + '</div>';
    }
  });
  if (s.codeTruncated) html += '<div class="jrn-trunc-note">… code truncated</div>';
  return html;
}
/**
 * Recursive spliced code-timeline section for step i: sticky header (kind
 * chip, names, requires-chips), call-site note, then the spliced body.
 * Repeat/cycle steps collapse to a one-line row at their splice point with
 * an expand control.
 * @group Journey view
 */
function jrnSectionHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const color = jrnRepoColor(n.repo);
  const plannedCall = jrnIsPlannedCall(s);
  if (s.planned && !plannedCall) {
    const p = s.planned;
    return '<section class="jrn-sec jrn-sec-planned" id="jrn-sec-' + i + '" style="border-left-color:' + color + '">'
      + '<div class="jrn-sec-head" data-order="' + i + '">'
      + '<span class="jrn-stepno">' + (i + 1) + '</span>'
      + '<span class="jrn-cchip k-planned">' + esc(t('journey.planned')) + '</span>'
      + '<span class="jrn-biz">' + esc(t('journey.planned.' + (p.kind || 'step'))) + ' ' + esc(p.label || '') + '</span>'
      + (p.detail ? '<span class="jrn-code-name">' + esc(p.detail) + '</span>' : '')
      + (n.contract ? '<a class="jrn-contract" href="#/apis/' + encodeURIComponent(n.contract.apiId) + '?op=' + encodeURIComponent(n.routeId || '') + '">' + sym('api') + esc(t('apis.contractLink')) + '</a>' : '')
      + '</div><div class="jrn-event jrn-plan-note">' + esc(t('journey.plannedNote')) + '</div></section>';
  }
  if (s.repeat || s.cycle) {
    const canExpand = !!(s.repeat || s.code);
    const label = s.cycle ? '↺ recursion — traversal stopped' : '↻ already shown';
    return '<section class="jrn-sec jrn-collapsed" id="jrn-sec-' + i + '" style="border-left-color:' + color + '">'
      + '<div class="jrn-sec-head" data-order="' + i + '">'
      + '<span class="jrn-stepno">' + (i + 1) + '</span>'
      + '<span class="jrn-cchip k-' + esc(n.kind || '') + '">' + esc(n.kind || '') + '</span>'
      + '<span class="jrn-code-name">' + esc(n.name || '') + '</span>'
      + '<span class="jrn-collabel">' + label + '</span>'
      + (canExpand ? '<button class="jrn-expbtn" onclick="jrnExpandRepeat(this)">expand</button>' : '')
      + '</div>'
      + (canExpand ? '<div class="jrn-repeat-body" style="display:none">' + jrnSegmentsHtml(i) + '</div>' : '')
      + '</section>';
  }
  const gateBanners = (s.gates || []).map((g) => {
    const gn = S.BYID[g.id];
    return '<div class="jrn-gate-banner' + (g.kind === 'rule' ? ' rule' : '') + (g.planned ? ' planned' : '') + '"' + (gn ? gateAttrs(g.id, { step: s.order, config: g.config }) : '') + '>'
      + sym(g.kind === 'rule' ? 'shield' : 'lock') + ' requires ' + esc(String(g.name || '').replace(/^requireScope: /, ''))
      + (g.planned ? ' <i>' + esc(t('journey.plannedGate')) + '</i>' : '')
      + (gn && gn.loc ? vsl(repoOf(gn), gn.loc.path, gn.loc.line) : '') + '</div>';
  }).join('');
  const meta = [n.loc ? n.loc.path + ':' + n.loc.line : '', n.repo, n.group].filter(Boolean).join(' · ');
  const head = '<div class="jrn-sec-head" data-order="' + i + '">'
    + '<span class="jrn-stepno">' + (i + 1) + '</span>'
    + '<span class="jrn-cchip k-' + esc(n.kind || '') + '">' + esc(n.kind || '') + '</span>'
    + '<span class="jrn-biz">' + esc(jrnLabel(n)) + '</span>'
    + '<span class="jrn-code-name">' + esc(n.name || '') + '</span>'
    + jrnReqChips(i)
    + (n.contract ? '<a class="jrn-contract" href="#/apis/' + encodeURIComponent(n.contract.apiId) + '?op=' + encodeURIComponent(n.id) + '" title="' + esc(n.contract.summary || '') + '">' + sym('api') + esc(t('apis.contractLink')) + '</a>' : '')
    + '<span class="jrn-meta">' + esc(meta) + '</span>'
    + (n.loc ? vsl(n.repo, n.loc.path, n.loc.line) : '') + '</div>';
  const pi = S.JRN_TREE ? S.JRN_TREE.parent[i] : -1;
  const prepo = pi >= 0 ? (((S.JOURNEY.steps[pi] || {}).node || {}).repo || n.repo) : n.repo;
  const callsite = s.callSite ? '<div class="jrn-callsite">← from ' + esc(s.callSite.path) + ':' + s.callSite.line + vsl(prepo, s.callSite.path, s.callSite.line) + '</div>' : '';
  // a flow entry has no code of its own: what it does carry is the design's
  // description of the feature and the product docs that specify it
  const refs = n.kind === 'flow' ? jrnRefAnchors(n) : [];
  const flowNote = n.kind === 'flow'
    ? ((n.bizDescription || n.docs ? '<div class="jrn-event jrn-flow-note">' + esc(n.bizDescription || n.docs) + '</div>' : '')
      + (refs.length ? '<div class="jrn-refs">' + refs.join(' ') + '</div>' : ''))
    : '';
  return gateBanners
    + '<section class="jrn-sec' + (plannedCall ? ' jrn-sec-planned' : '') + '" id="jrn-sec-' + i + '" style="border-left-color:' + color + '">'
    + head + callsite + flowNote
    + (plannedCall ? '<div class="jrn-event jrn-plan-note">' + esc(t('design.plannedCall')) + '</div>' : '')
    + jrnSegmentsHtml(i) + '</section>';
}
/**
 * Open the journey overlay for an entry node: fetch /api/journey and render it.
 * @group Journey view
 * @business Plays a flow through end to end — every step of code that runs, in order.
 */
export async function openJourney(id) {
  const overlay = document.getElementById('journey');
  jrnSkipLink(overlay);
  overlay.classList.add('open');
  // the overlay is a dialog over a page that is still there: make what it covers
  // inert, so the ✕ is a few stops away instead of 214 and Tab cannot walk into
  // the covered surface — while the header, the filters and the status bar
  // around it stay live for the pointer and the keyboard
  trapFocus(overlay);
  document.getElementById('jrn-title').textContent = '…';
  document.getElementById('jrn-count').textContent = '';
  const orgEl = document.getElementById('jrn-orgline'); if (orgEl) orgEl.innerHTML = '';
  document.getElementById('jrn-trunc').style.display = 'none';
  const cutEl = document.getElementById('jrn-cuts'); if (cutEl) cutEl.style.display = 'none';
  const fb = document.getElementById('jrn-forksbtn'); if (fb) fb.style.display = 'none';
  jrnToggleForks(false);
  S.JOURNEY = null; S.JRN_TREE = null; S.JRN_DRILL = null; S.jrnStep = null;
  jrnShowState(jrnStateHtml(t('journey.loading')));
  try {
    const r = await fetch('/api/journey?entry=' + encodeURIComponent(id));
    // a server that answered with something other than JSON still has a status to report
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) { jrnShowState(jrnStateHtml(t('sys.journeyFailed'), data.error || t('sys.httpStatus').replace('{status}', r.status), id)); return; }
    // a pasted name resolved server-side: make the URL say the id it landed on (deep links stay exact)
    if (data.resolvedFrom && data.entry && data.entry.id && data.entry.id !== id) {
      history.replaceState(null, '', '#/journeys/' + encodeURIComponent(data.entry.id));
    }
    jrnShowContent();
    renderJourney(data);
  } catch (err) {
    jrnShowState(jrnStateHtml(t('sys.journeyFailed'), err.message, id));
  }
}
/**
 * The journey's first stop: a link to the top bar. The overlay is a non-modal
 * dialog — the chrome around it stays live for the pointer — but a keyboard
 * reader tabbing forward walked the whole journey and never reached the nav,
 * search or the register (pass swarm 2026-09-25: SDET blocker, QA, staff). This
 * is the way out forward, without making the dialog modal again. Hidden until it
 * has the focus, as skip links are.
 * @group Journey view
 * @business A keyboard shortcut out of the journey to the bar at the top of the page.
 */
function jrnSkipLink(overlay) {
  let sk = document.getElementById('jrn-skip');
  if (!sk) {
    sk = document.createElement('button');
    sk.id = 'jrn-skip';
    sk.className = 'jrn-skip';
    sk.type = 'button';
    sk.addEventListener('click', jrnSkipToChrome);
    overlay.insertBefore(sk, overlay.firstChild);
  }
  sk.textContent = t('journey.skipToChrome');
}
/** Move the keyboard to the top bar's first control (the surfaces), the journey left open behind it.
 * @group Journey view */
function jrnSkipToChrome() {
  const first = [...document.querySelectorAll('.topbar #nav button, .topbar #nav a, .topbar [tabindex="0"], .topbar button')]
    .find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (first) first.focus();
}
/**
 * The overlay with nothing to draw yet: the surface's name, one word for what
 * is happening, the reason when something failed, and the way back in. Every
 * word comes from the catalog — a state is as much a rendering as a timeline.
 * @group Journey view
 */
function jrnStateHtml(word, reason, retryId) {
  return '<div class="jrn-emk">' + esc(t('nav.journeys')) + '</div>' + esc(word)
    + (reason ? '<div class="jrn-emreason">' + esc(reason) + '</div>' : '')
    + (retryId ? '<button class="rel jrn-retry" onclick="openJourney(' + jsArg(retryId) + ')">' + esc(t('journey.retry')) + '</button>' : '');
}
/**
 * Close the overlay and land the graph focused on the journey's nodes with
 * the entry selected — closing a walk drops you on the neighborhood you just
 * walked.
 * @group Journey view
 */
export function closeJourney() {
  document.getElementById('journey').classList.remove('open');
  releaseFocus();
  jrnToggleForks(false);
  // Hand the URL back to the surface we came from (deep-link discipline). With
  // nowhere to go back to — a pasted journey link, or a first visit — the
  // fallback is this surface's own list, never the code map: the overlay *is*
  // the Journeys surface's detail view, and since B2.2 the business and hybrid
  // registers do not land on the code map at all. A business reader who pressed
  // Esc used to be deposited on the developer surface with no explanation.
  const back = (S.prevSurfaceHash && !/^#\/journeys\//.test(S.prevSurfaceHash)) ? S.prevSurfaceHash : '#/journeys';
  // Landing on the code map focused on the walk is only a gift when the reader
  // lands on the code map. Anywhere else it was a hidden filter left behind — a
  // `focus: POC…` in the search box and `122 shown of 1678` on the next page the
  // reader opened, with nothing on screen saying why (pass swarm 2026-09-25).
  if (S.JOURNEY && S.GRAPH && /^#\/codemap/.test(back)) {
    const ids = (S.JOURNEY.steps || []).map((s) => s.node && s.node.id).filter((id) => id && S.BYID[id]);
    if (ids.length) {
      S.focusSet = new Set(ids);
      const entryId = (S.JOURNEY.entry && S.JOURNEY.entry.id && S.BYID[S.JOURNEY.entry.id]) ? S.JOURNEY.entry.id : ids[0];
      const n = S.BYID[entryId], eg = n && effectiveGroup(n);
      if (eg) S.expandedGroups.add(eg.key);
      document.getElementById('focuschip').style.display = '';
      document.getElementById('searchlabel').textContent = t('chrome.focusPrefix') + ' ' + (n ? n.name : 'journey');
      window.select(entryId);
    }
  }
  if (/^#\/journeys\//.test(location.hash) && location.hash !== back) location.hash = back;
}
/** Show a loading / error message and hide the timeline.
 * @group Journey view */
function jrnShowState(msg) {
  const e = document.getElementById('jrn-empty');
  e.style.display = ''; e.innerHTML = msg;
  document.getElementById('jrn-tl').style.display = 'none';
  const pane = document.getElementById('jrn-dock');
  if (pane) pane.style.display = 'none';
}
/** Reveal the timeline (lens CSS still governs which lanes are folded).
 * @group Journey view */
function jrnShowContent() {
  document.getElementById('jrn-empty').style.display = 'none';
  document.getElementById('jrn-tl').style.display = '';
  jrnApplyDock();
}

// ── the blueprint timeline (docs/proposals/blueprint-timeline.md · option C) ──
// One horizontal timeline. One column per SEGMENT — a screen and everything
// the walk does until the next screen. Three lanes stacked inside every
// column: what the user sees · the line of visibility · the business (a
// flowchart in words) · what the system does as ONE ROW PER SYSTEM the journey
// touches (a repo, an API by its spec, records, messages, a third party). A
// marker in a system row opens its contract (planned) or its spliced code
// (built) in place, as a row under its system. Linked journeys (◀ requires ·
// leads to ▶) are slim columns at either end. Every fact comes from
// /api/journey's `summary` (segments · systems · links); the lens folds lanes
// in CSS; nothing here is drawn by hand.

const JRN_LANE_W = 190, JRN_SEG_W = 440, JRN_FIT_MIN = 420, JRN_FIT_PAD = 22;
// the readable width of one checkpoint row: business prints the words alone,
// hybrid and code print the identifier that declared it as well
// (JRN_COL_W and JRN_COL_W_CODE are the `columns:` minimums in viewer.html —
// change them together, or the browser's column count and this width disagree)
// 540, not 560: at 1440 the room beside the lane is 1136px and two 560px
// columns want 1150, so ten pixels of arithmetic dropped hybrid and code to a
// single column on the commonest laptop. Caught by switching the register on a
// live page rather than by loading each one from its own URL.
const JRN_COL_W = 470, JRN_COL_W_CODE = 540, JRN_COL_GAP = 30, JRN_COL_SOLO = 1.36;
const JRN_MOM_MIN = 196, JRN_MOM_MAX = 372, JRN_MOM_PAD = 34, JRN_LADDER_LINES = 26;

/**
 * Measure the segment columns before anything is drawn: a moment is as wide as
 * its widest marker (clamped), a segment is the sum of its moments (never
 * narrower than one segment used to be), and in ladder mode a segment is wide
 * enough for one column per system. Held on S so every row of the grid — the
 * header, the screens, the business band and each system row — lines up.
 * @group Journey view
 */
function jrnMeasure(sum) {
  const ladder = jrnView() === 'ladder';
  // the business lens draws counts, not chips — only the stops and the API row's cards size a column
  const business = currentLens() === 'business';
  S.JRN_MOMW = sum.segments.map((sg) => jrnRankOrder(sg).map((mo) => {
    let w = 30 + String(mo.label || '').length * 6.4;
    if (mo.component) w = Math.max(w, 26 + String(mo.component.label || '').length * 6.2);
    sg.markers.forEach((m) => {
      if (m.moment !== mo.index) return;
      // folded away by default — it wraps inside its drill when that is opened
      if (m.helper || (m.tier != null && m.tier > 1)) return;
      // a seam card's summary and its two ⧉ ends wrap inside the card; only its title line sizes the column
      if (m.kind === 'call') w = Math.max(w, 44 + jrnMarkerText(m).length * 6.4 + 86);
      else if (!business) w = Math.max(w, JRN_MOM_PAD + jrnMarkerText(m).length * 6.4);
    });
    return Math.round(Math.max(JRN_MOM_MIN, Math.min(JRN_MOM_MAX, w)));
    // every row draws one cell per declared-only stop too, so they must be measured
  }).concat((sg.declaredOnly || []).map((d) => Math.round(Math.max(JRN_MOM_MIN,
    Math.min(JRN_MOM_MAX, 30 + String(d.label || d.op || '').length * 6.4))))));
  S.JRN_SEGW = sum.segments.map((sg, i) => {
    if (ladder) return Math.max(JRN_SEG_W, jrnLadderModel(sum, sg).width);
    const sumW = (S.JRN_MOMW[i] || []).reduce((a, b) => a + b, 0) + 32;
    return Math.max(JRN_SEG_W, sumW);
  });
}
/**
 * Give the content inside the timeline the width of the WINDOW.
 *
 * A segment's cell is as wide as its system band makes it — 4,121px for the
 * gates of the reference app's first screen, 8,819px for the row that holds its screen
 * card — so "fill your container" is the wrong instruction for anything a
 * person reads: it runs the text off the right of the screen. The old answer
 * was a constant (720px for the gates list, whatever the monitor), which is
 * the opposite failure: a 1920px window bought the reader nothing.
 *
 * The bound both want is the same one — *do not run past the right edge of the
 * window* — and it is measurable rather than guessable. The timeline renders
 * scrolled to x=0, so an element's own `left` is its offset from the content
 * origin; the width that still fits beside the sticky lane is the window minus
 * that offset. CSS carries a `calc(100vw - 420px)` fallback for the frame
 * before this runs and for a browser that never fires the resize.
 * @group Journey view
 */
export function jrnFitToWindow() {
  const tl = document.getElementById('jrn-tl');
  if (!tl) return;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  if (!vw) return;
  const wide = currentLens() !== 'business';
  tl.querySelectorAll('.jrn-gatelist,.jrn-usercell .jrn-screen').forEach((el) => {
    el.style.maxWidth = '';
    // The offset is taken from the element's own CELL, not from the window.
    // Reading it off the window would measure where this segment happens to be
    // sitting right now, so the second screen — 4,000px off to the right —
    // would be told it has no room and draw a one-column list, and the row
    // would be as tall as that. A segment is read with its column against the
    // sticky lane, so that is the geometry every segment is measured in, and
    // every screen of a journey gets the same width for the same content.
    const cell = el.closest('.jrn-cell');
    const inset = cell ? Math.round(el.getBoundingClientRect().left - cell.getBoundingClientRect().left) : 0;
    // never smaller than one readable column
    const avail = Math.max(JRN_FIT_MIN, vw - JRN_LANE_W - inset - JRN_FIT_PAD);
    el.style.maxWidth = (el.classList.contains('jrn-gatelist')
      ? jrnListWidth(avail, wide ? JRN_COL_W_CODE : JRN_COL_W)
      : avail) + 'px';
  });
}
/**
 * How wide a checkpoint list may be, given the room beside the lane.
 *
 * Once there is room for two columns the answer is *all of it*: multi-column
 * layout divides its container, so every pixel the window gains is shared out
 * among the rows and each column stays around 530-570px — a width the eye
 * takes in whole, with the repeat count within a glance of the words it
 * counts. Below that the browser would draw ONE column as wide as the
 * container, and a 796px row carrying "path id shape ×7" puts the 7 six
 * hundred pixels from the thing it counts; that single column is the only
 * case that needs a cap, and it is a cap on a ROW, not on the list.
 * @group Journey view
 */
function jrnListWidth(avail, colW) {
  return avail >= colW * 2 + JRN_COL_GAP ? avail : Math.min(avail, Math.round(colW * JRN_COL_SOLO));
}
/** Grid template for one timeline row: lane label · segments.
 * @group Journey view */
function jrnRowStyle(sum) {
  const cols = [JRN_LANE_W + 'px'];
  const widths = S.JRN_SEGW || sum.segments.map(() => JRN_SEG_W);
  widths.forEach((w) => cols.push('minmax(' + w + 'px,1fr)'));
  const min = JRN_LANE_W + widths.reduce((a, b) => a + b, 0);
  return 'grid-template-columns:' + cols.join(' ') + ';min-width:' + min + 'px';
}
/** The moment column template for one segment's cells — the variable every system row shares.
 * @group Journey view */
function jrnMomStyle(si) {
  return 'grid-template-columns:' + ((S.JRN_MOMW && S.JRN_MOMW[si]) || ['1fr']).map((w) => w + 'px').join(' ');
}
/** A lane label cell (sticky on the left while the timeline scrolls).
 * @group Journey view */
function jrnLaneHtml(label, sub, cls, extra) {
  return '<div class="jrn-lane' + (cls ? ' ' + cls : '') + '"><span class="hud-label">' + esc(label) + '</span>'
    + (sub ? '<span class="jrn-lane-sub">' + esc(sub) + '</span>' : '') + (extra || '') + '</div>';
}
/**
 * The journeys either side of this one, as the strip the storyboard already
 * draws: ◀ requires · leads to ▶ · part of, each chip running that flow.
 *
 * They used to be two 176px COLUMNS of the timeline grid — and a grid column
 * exists on every row, so a card belonging to ONE row (the screens) drew an
 * empty 176 x 880px rail down the business lane and every system row under it.
 * At 1440 that rail plus the lane label was a quarter of the window before any
 * content began. One strip above the grid says the same thing once, in the
 * shape the storyboard already uses for it.
 * @group Journey view
 * @business Shows the journey that must happen before this one, and the one that follows it.
 */
function jrnTimelineLinksHtml(sum) {
  const html = jrnStoryLinksHtml(sum);
  return html ? '<div class="jrn-tl-links">' + html + '</div>' : '';
}
/** "part of" chips for the header: the longer flows this journey sits inside.
 * @group Journey view */
function jrnPartOfHtml(sum) {
  if (!sum.links.partOf.length) return '';
  return '<span class="hud-label">' + esc(t('journey.partOf')) + '</span>' + sum.links.partOf.map((l) =>
    '<span class="jrn-chip go" onclick="openJourney(' + jsArg(l.id) + ')" title="' + esc(l.id) + '">' + sym('interchange') + esc(l.name) + '</span>').join('');
}
/** The graph node behind a segment's screen — from the journey's `screens`
 * (full design reference), the loaded graph, or the summary row itself.
 * @group Journey view */
export function jrnScreenNode(sg) {
  const id = sg.screen && sg.screen.id;
  if (!id) return null;
  return (S.JOURNEY.screens || []).find((n) => n && n.id === id) || S.BYID[id] || { id, name: sg.screen.name, kind: sg.screen.kind, design: sg.screen.designStatus ? { status: sg.screen.designStatus, id: sg.screen.designId } : undefined };
}
/**
 * The column header for one segment: its ordinal, the screen's name (or
 * "before the first screen"), its counts, and a progress bar that fills as the
 * reader walks its markers — the rail stop of the timeline.
 * @group Journey view
 */
function jrnSegHeadHtml(sg) {
  const business = currentLens() === 'business';
  const name = sg.screen ? sg.screen.name : t('journey.beforeFirstScreen');
  const k = sg.counted || {};
  // this screen's own numbers, each a typed count scoped *on this screen* with its
  // tip. The business lens prints what a person can do here and the checks; the
  // walk's own units (repeats, cut points) are the code lens's, and the design's
  // id is a cross-reference the business lens does not print
  const bits = [
    // a screen with nothing to do says nothing about it in the business lens: `0 things the user can do` reads as a fault
    business && k.actions && !k.actions.n ? ''
      : jrnCountedHtml(k.actions, { noFocus: true }) || jrnNumHtml(sg.counts.calls, 'journey.countCalls', 'journey.scopeHere', { noFocus: true }),
    sg.counts.planned && !business ? jrnNumHtml(sg.counts.planned, 'journey.plannedCount', 'journey.scopeHere', { noFocus: true }) : '',
    k.gates && k.gates.n ? jrnCountedHtml(k.gates, { noFocus: true, rel: [k.checks] }) : '',
    k.decisions && k.decisions.n ? jrnCountedHtml(k.decisions, { noFocus: true }) : '',
    sg.counts.cutPoints && !business ? jrnNumHtml(sg.counts.cutPoints, 'journey.countCut', 'journey.scopeHere', { noFocus: true }) : '',
    sg.counts.repeats && currentLens() === 'code' ? jrnNumHtml(sg.counts.repeats, 'journey.countRepeats', 'journey.scopeHere', { noFocus: true }) : '',
  ].filter(Boolean);
  return '<div class="jrn-cell jrn-seghead" id="jrn-sh-' + sg.index + '" onclick="jrnSelectSegment(' + sg.index + ')">'
    + '<span class="ord">' + (sg.index + 1) + '</span><span class="jrn-seg-name">' + esc(name) + '</span>'
    + '<span class="jrn-seg-meta">' + (sg.screen && sg.screen.designId && !business ? esc(sg.screen.designId) + ' · ' : '') + bits.join(' · ') + '</span>'
    + '<span class="jrn-seg-bar"><i id="jrn-sb-' + sg.index + '"></i></span></div>';
}
/**
 * Lane 1 cell: the screen as designed — the derived card, thumbnail, design
 * chip and ⧉ links (shared with the inspector), or the entry card when the
 * segment has no screen (a route or job entry).
 * @group Journey view
 * @business The screen a person is looking at during this part of the journey, as it was designed.
 */
function jrnUserCellHtml(sg) {
  const n = jrnScreenNode(sg);
  if (!n) {
    const e = S.JOURNEY.entry || {};
    return '<div class="jrn-cell jrn-usercell"><span class="hud-label">' + esc(t('journey.startsAt')) + '</span>'
      + '<div class="node jrn-screen" style="border-left:3px solid ' + jrnRepoColor(e.repo) + '">' + nodeCardHtml(e, false) + (e.bizDescription ? '<div class="jrn-cdesc">' + esc(e.bizDescription) + '</div>' : '') + '</div></div>';
  }
  return '<div class="jrn-cell jrn-usercell">' + jrnScreenCardHtml(n, currentLens() === 'business', 0, sg.screen, sg) + '</div>';
}
/** First sentence of a business text (cut at ". "), capped so a flowchart step stays one box.
 * @group Journey view */
export function jrnFirstSentence(txt) {
  const str = String(txt || '').trim();
  const m = /^(.{12,}?)\.\s/.exec(str);
  let out = m ? m[1] : str;
  if (out.length > 160) out = out.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  return out;
}
/**
 * A gate's name split into the two things it holds: the identifier of the
 * function that declared it, and the requirement somebody wrote next to it
 * (`requireContractorSession: contractorSession required`). The parser builds
 * the name that way from the `@guard` tag; a rule carries no tag at all, so
 * its name is the schema's identifier and nothing else.
 * @group Journey view
 */
export function jrnGateParts(g) {
  const raw = String(g.name || '');
  const i = raw.indexOf(': ');
  if (i <= 0) return { ident: '', phrase: raw };
  return { ident: raw.slice(0, i), phrase: raw.slice(i + 2) };
}
/** A token only a developer would write: camelCase, snake_case, SHOUT_CASE, `a=b`. */
const JRN_DEV_TOKEN = /[a-z][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]|=/;
/** Labels of the checks every web application has, by the words their authors use — first match wins. */
const JRN_GATE_SHAPES = [
  ['returnPath', /\breturn.?to\b.*\bpath\b|\bredirect target\b/i],
  ['sameOrigin', /^same.?origin\b|\bcsrf\b/i],
  ['rateLimit', /\brate.?limit/i],
  ['idShape', /\bid shape\b/i],
];
/** A name that is one bare identifier and no prose at all (`uuid`, `problemSchema`). */
const JRN_BARE_IDENT = /^[A-Za-z0-9_$]+$/;
/**
 * The checkpoint as a person would say it, or `''` when nobody said it.
 *
 * The business lens may not print an identifier, and this project does not let
 * `humanize()` stand in for a name outside it — so the only words allowed here
 * are the ones a developer actually declared: the text after the colon in a
 * `@guard` tag. Where that text is itself a token out of the code
 * (`contractorSession required`, `BC_MODE=mock only`), or where there is no tag
 * at all — which is every validation rule, whose name is just its schema — this
 * returns nothing and the caller counts it into one honest line instead of
 * manufacturing a sentence for it.
 * @group Journey view
 */
export function jrnGateInWords(g) {
  const { phrase } = jrnGateParts(g);
  // a handful of checks every web application has, named the way a developer names
  // them (*same-origin on mutating routes*, *public-path rate limit*, *path id shape*):
  // the label is words a person wrote, and still a word a product owner would have to
  // look up (swarm 2026-10-05). The shape is read off that label — never guessed from
  // the code — and said with the catalog's sentence for it.
  const shape = phrase && JRN_GATE_SHAPES.find(([, re]) => re.test(phrase));
  if (shape) return t('journey.biz.gateShape.' + shape[0]);
  if (!phrase || JRN_BARE_IDENT.test(phrase) || JRN_DEV_TOKEN.test(phrase)) return '';
  return phrase;
}
/**
 * What to call a checkpoint, in the register the reader asked for — the ONE
 * decision, read by the timeline's list, the sheet, the storyboard and the
 * drill alike. Business gets the requirement somebody wrote and nothing else;
 * hybrid and code get the name the code carries. Before this, three of the four
 * views asked the question for themselves and answered it with the identifier,
 * so a reader who pressed `v` in the business register watched the tool start
 * speaking code at them.
 * @group Journey view
 */
export function jrnGateLabel(g) {
  return currentLens() === 'business' ? plainWords(jrnGateInWords(g)) : jrnGateText(g);
}
/**
 * One list of checkpoints split the one way every view reads it: `rows` in the
 * order the walk met them, `drawn` the ones this register can name, and `mute`
 * how many it cannot. The count a heading prints is `rows.length` — the whole
 * list — so the number beside a list and the rows inside it are never two
 * claims about different things.
 * @group Journey view
 */
export function jrnGatesShown(list) {
  const rows = (list || []).slice().sort((a, b) => a.stepOrder - b.stepOrder);
  const drawn = currentLens() === 'business' ? rows.filter((g) => jrnGateLabel(g)) : rows;
  return { rows, drawn, mute: rows.length - drawn.length };
}
/**
 * One checkpoint as a row of the list: kind glyph, what it requires, how many
 * times this screen met it, and the code behind it. A row, not a card, because
 * forty-seven cards of forty-seven widths in a wrapping flex is a cloud the eye
 * has to track rather than a list it can scan — the columns here line up, so a
 * reader runs down one edge and the ×n counts sit under one another.
 * @group Journey view
 */
function jrnGateRowHtml(g, qualifier) {
  const gn = S.BYID[g.id];
  const words = jrnGateLabel(g);
  // a click (or Enter) opens the gate card; a planned gate is not in the graph, so it still walks to its step
  const opens = gn ? gateAttrs(g.id, { step: g.stepOrder, config: g.config })
    : ' onclick="jrnScrollTo(' + g.stepOrder + ')"';
  return '<div class="jrn-gl-row' + (g.kind === 'rule' ? ' rule' : '') + (g.config ? ' config' : '') + (g.planned ? ' planned' : '') + '"'
    + opens + ' title="' + esc(g.name || '') + '">'
    + sym(g.config ? 'gear' : g.kind === 'rule' ? 'shield' : 'lock')
    + '<span class="jrn-gl-w">' + esc(words) + (g.planned ? ' <i>' + esc(t('journey.plannedGate')) + '</i>' : '')
    // a real space, not only the margin: this row is read in a screenshot and
    // pasted into a ticket as often as it is clicked
    + (qualifier ? ' <i class="jrn-gl-same" title="' + esc(def('journey.sameWords') || '') + '">' + esc(qualifier) + '</i>' : '') + '</span>'
    + '<span class="jrn-gl-x"' + (g.count > 1 ? ' title="' + esc(t('journey.gateTimes').replace('{n}', g.count)) + '"' : '') + '>'
    + (g.count > 1 ? '×' + g.count : '') + '</span>'
    // the doors on the row itself, not behind a ▸ (the business register draws none: they open code)
    + '<span class="jrn-gl-go">' + (gn ? doorsHtml(doorsFor(g.kind === 'rule' ? 'rule' : 'gate', gn)) : '')
    + '</span></div>';
}
/**
 * One named list of checkpoints: a heading carrying THIS screen's count, then
 * the rows in the order the walk met them — which is what the lane's own
 * sub-line promises. In the business lens the ones nobody wrote words for are
 * not drawn with an identifier standing in for a sentence; they are counted
 * into one line at the foot of their own list, so the heading's number and the
 * rows a reader can see never disagree about what is here.
 * @group Journey view
 */
function jrnBizGroupHtml(key, total, body, mute, cls, scopeKey) {
  // A count with no rows under it is not an empty state a reader can act on: in
  // the business register every validation rule of a real application is a schema
  // identifier, so this section drew a heading, a count and an apology three
  // times and could never draw a row (visual swarm 2026-09-24). When nothing is
  // drawn the group says *none of these is written in plain language* — none, not
  // a number equal to the count, which reads as though some were shown — and
  // wears `empty` so it collapses to one line instead of reserving a list's room.
  const allMuted = total > 0 && mute >= total;
  return '<div class="jrn-gl-grp' + (cls ? ' ' + cls : '') + (allMuted ? ' empty' : '') + '">'
    + '<div class="jrn-gl-head"><span class="hud-label" title="' + esc(def(key) || '') + '">' + esc(t(key)) + '</span>'
    // which scope this number counts over, on the screen rather than in a
    // tooltip: the control above this cell counts the same word journey-wide
    + (scopeKey ? '<span class="jrn-gl-scope" title="' + esc(def(scopeKey) || '') + '">' + esc(t(scopeKey)) + '</span>' : '')
    + jrnNumHtml(total, key, scopeKey || 'count.scope.action', { num: true, noFocus: true, cls: 'n' }) + '</div>' + (allMuted ? '' : body)
    + (mute ? '<div class="jrn-gl-mute">' + sym('warning')
      + esc(allMuted ? t('journey.biz.noneInWords') : t('journey.biz.notInWords').replace('{n}', mute)) + '</div>' : '')
    + '</div>';
}
function jrnGateGroupHtml(list, key, scopeKey, cls) {
  if (!list.length) return '';
  const { rows, drawn, mute } = jrnGatesShown(list);
  // Two checkpoints whose developers wrote the same @guard phrase collapse to one
  // wording once the identifier is stripped, and two identical adjacent rows read
  // as a bug in the tool rather than as two places in the code (visual swarm
  // 2026-09-24: `invoice field edit gate` twice, `submit readiness`, `invoice
  // ownership`). Each keeps its own row, its own ×n and its own link, and says
  // which of the places sharing that name it is — a collision named, not folded.
  // Keyed on jrnGateLabel, which is what the row actually prints, so the
  // qualifier appears exactly when a reader would see two rows reading alike.
  const same = new Map();
  drawn.forEach((g) => { const w = jrnGateLabel(g); same.set(w, (same.get(w) || 0) + 1); });
  const seen = new Map();
  const html = drawn.map((g) => {
    const w = jrnGateLabel(g);
    const n = same.get(w) || 1;
    if (n < 2) return jrnGateRowHtml(g);
    const i = (seen.get(w) || 0) + 1;
    seen.set(w, i);
    return jrnGateRowHtml(g, t('journey.sameWords').replace('{i}', i).replace('{n}', n));
  }).join('');
  return jrnBizGroupHtml(key, rows.length, '<div class="jrn-gl-rows">' + html + '</div>',
    mute, cls || (key === 'journey.bizGroup.rules' ? 'rules' : ''), scopeKey);
}
/**
 * The gates and rules of one screen as two aligned lists rather than one cloud
 * of cards. They are different kinds — a gate says who may pass, a rule says
 * what the data must look like — and interleaving them by accident of walk
 * order was most of what made the old view unreadable.
 * @group Journey view
 * @business What has to be true before this part of the journey goes through.
 */
function jrnGateListHtml(gates, scopeKey, configChecks) {
  const cfg = (configChecks || []).map((g) => ({ ...g, kind: 'guard', config: true }));
  if ((!gates || !gates.length) && !cfg.length) return '';
  return '<div class="jrn-gatelist">'
    + jrnGateGroupHtml((gates || []).filter((g) => g.kind !== 'rule'), 'journey.bizGroup.gates', scopeKey)
    + jrnGateGroupHtml((gates || []).filter((g) => g.kind === 'rule'), 'journey.bizGroup.rules', scopeKey)
    // the config checks the screen's code meets on the way: listed apart, counted apart (swarm-fixes 2026-10-05, finding 4)
    + jrnGateGroupHtml(cfg, 'journey.bizGroup.configChecks', scopeKey, 'config')
    + '</div>';
}
/**
 * The checks of one action — the ONE renderer the sheet's *Gates & business*
 * cell, the storyboard's *The checks* row and (in its own boxes) the drill all
 * read. It draws the gates as the two headed, counted lists the timeline draws,
 * then the decisions this register shows under a heading of their own, then
 * what the walk could not put into words. Three views used to answer these
 * questions for themselves, which is how the same checkpoint came to be called
 * `requirePathId: path id shape` on one keystroke and *path id shape* on the
 * next.
 *
 * The lane's control governs it: `gates` narrows to the checkpoints,
 * `decisions` to the forks, and `words` — where the lane opens — draws both as
 * the register words them. `words` is the wider setting here rather than the
 * narrower one it is in the timeline, because this cell is the only place these
 * three views draw a gate at all: narrowing it by default would have three of
 * the four views claim a journey has no checkpoints.
 * @group Journey view
 * @business What has to be true for this action to go through, and where it can go differently.
 */
export function jrnChecksHtml(sg, mo) {
  const tab = jrnBizTab();
  const gates = (sg.gates || []).filter((g) => g.stepOrder >= mo.from && g.stepOrder <= mo.to);
  const configs = (sg.configChecks || []).filter((g) => g.stepOrder >= mo.from && g.stepOrder <= mo.to);
  const inRange = jrnSegDecisions(sg).filter((d) => d.order >= mo.from && d.order <= mo.to);
  // business draws the decisions somebody wrote; a guard-class condition nobody
  // labelled is a predicate in code and is counted, not named
  const shown = currentLens() === 'business' ? inRange.filter((d) => d.cls !== 'guard') : inRange;
  // one number in every lens (docs/COUNTS.md §2 #2): the technical conditions of
  // this action plus the gate conditions nobody labelled — which hybrid and code
  // also draw as decisions, and still count here, because they are still not in
  // plain language
  const un = jrnMomentUntranslated(sg, mo) + inRange.filter((d) => d.cls === 'guard').length;
  const untr = un ? jrnUntranslatedHtml(un, 'count.scope.action', null, jrnActionUntrList(sg, mo)) : '';
  // the forks get the same headed, counted list the gates get — so a register
  // that can name none of them says *n of these are not written in plain
  // language* under a heading that says n, and never *none indexed* about
  // decisions the walk plainly found
  const decs = tab === 'gates' || !inRange.length ? ''
    : '<div class="jrn-gatelist">' + jrnBizGroupHtml('journey.decisions', inRange.length,
      shown.map(jrnSheetDecChipHtml).join(''), inRange.length - shown.length) + '</div>';
  const body = (tab === 'decisions' ? '' : jrnGateListHtml(gates, undefined, configs)) + decs;
  return body ? body + untr : (untr || jrnAbsentHtml('noneIndexed'));
}
/** What the walk could not put into words, said in the register's own voice — a
 * sentence in business, a chip beside the checks elsewhere. One line, every view.
 * @group Journey view */
export function jrnUntranslatedHtml(n, scope, c, list) {
  // the number is the same in every lens (`count.unit.notInWords`); only the words differ
  const biz = currentLens() === 'business';
  const key = biz ? 'journey.biz.untranslated' : 'count.unit.notInWords';
  // with no typed count (an action's cell), the same builder over a bare one, so the list rides along
  const cc = c || { n, unit: 'count.unit.notInWords', bizUnit: 'journey.biz.untranslated', scope: scope || 'journey.scopeHere' };
  const tip = tipAttrs({ id: 'jrnCounted', args: { c: cc, list: list || undefined } });
  return biz
    ? '<div class="jrn-untr sentence"' + tip + '>' + sym('warning') + esc(jrnCountWord(key, n)) + '</div>'
    : '<span class="jrn-untr"' + tip + '>' + sym('warning') + esc(jrnCountWord(key, n)) + '</span>';
}
/**
 * The three things the business lane can draw beneath its sentence. `words`
 * is the default everywhere: the lane opens on what a person wrote and on
 * nothing else. The gates and the branch structure are each one click away,
 * and their counts are on the control whether or not they are drawn — a
 * reader must always be able to tell "there are none" from "they are not
 * shown".
 * @group Journey view
 */
const JRN_BIZ_TABS = ['words', 'gates', 'decisions'];
/** The business lane's open tab — a `?biz=` deep link wins, else what this browser last chose.
 * @group Journey view */
export function jrnBizTab() {
  if (!S.jrnBiz) {
    let v = null;
    try { v = localStorage.getItem('fs-jrn-biz'); } catch (e) { v = null; }
    S.jrnBiz = JRN_BIZ_TABS.indexOf(v) >= 0 ? v : 'words';
  }
  return S.jrnBiz;
}
/**
 * Open one of the business lane's three views and redraw *only that lane* —
 * the system band keeps its selection, its folds and its scroll, and a jump
 * already in flight is never handed a stale marker.
 * @group Journey view
 * @business Chooses what the business lane shows: what happens in words, the checks, or where it can branch.
 */
export function jrnSetBizTab(v) {
  S.jrnBiz = JRN_BIZ_TABS.indexOf(v) >= 0 ? v : 'words';
  try { localStorage.setItem('fs-jrn-biz', S.jrnBiz); } catch (e) { /* private mode: the tab is just not remembered */ }
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const row = document.querySelector('#jrn-tl .jrn-bizrow');
  // the timeline redraws one lane so the band keeps its selection, its folds and
  // its scroll; the other three draw the checks inside a grid whose columns are
  // measured together, so they redraw whole — the open screen, action and
  // register are all state and survive it. Either way the new rows have never
  // been measured, so they are fitted to the window before they are read; the
  // whole-journey path below is fitted by renderJourney itself.
  if (sum && row) { row.outerHTML = jrnBizRowHtml(sum, jrnRowStyle(sum)); jrnFitToWindow(); }
  else if (S.JOURNEY) renderJourney(S.JOURNEY);
}
/**
 * One segment's decisions, split the one way every drawer of this lane reads
 * them so a count and a cell can never disagree: `inWords` = the ones someone
 * put in words (a guard-class condition with no `@business` label is a
 * predicate in code, not a decision anybody wrote), `shown` = what this lens
 * draws at all — business draws only the authored ones and folds the rest
 * into its "not translated" sentence, hybrid and code draw every one.
 * @group Journey view
 */
function jrnBizDecs(sg) {
  const all = jrnSegDecisions(sg);
  // an older server carries no class: then nothing is folded away, exactly as before
  const inWords = all.filter((d) => d.cls !== 'guard');
  const shown = currentLens() === 'business' ? inWords : all;
  return { all, inWords, shown, unlabelled: all.length - shown.length };
}
/**
 * What each of the lane's three views holds — the numbers on the control.
 *
 * One control sits above eleven cells, so its number has to say *which* count
 * it is. It is the journey's, counted the way the journey header counts it:
 * each checkpoint and each decision once, however many screens meet it. That
 * makes `gates` identical to the header's `24 gates` and `decisions` identical
 * to its `21 decisions` — before this, the control summed the per-screen lists
 * and printed `47` beside a header saying `24`, two bases for one word on one
 * screen. Each screen's own share is on the heading of its list, where it can
 * be read against the row it describes.
 *
 * `words` is the subset of those decisions somebody actually put into words.
 * On the reference app it is 0, and 0 is the answer: nothing in this flow's branches was
 * written in plain language. A control that said 42 while every cell under it
 * drew none was not being kinder, only less useful.
 * @group Journey view
 */
function jrnBizCounts(sum) {
  // the core counts what each view draws (docs/COUNTS.md §2 #7): `inWords` is the
  // lines the words view draws — one per screen, one per decision in words — so
  // the tab no longer reads `IN WORDS · 0` above eleven sentences
  if (sum.counted && sum.counted.inWords) {
    return { words: sum.counted.inWords, gates: sum.counted.gates, decisions: sum.counted.decisions };
  }
  const dec = (sum.business && sum.business.decisions) || [];
  const segs = sum.segments || [];
  const wrap = (n, unit) => ({ n, unit, scope: 'journey.scopeAll', source: 'journeySummary()' });
  return {
    words: wrap(segs.filter((sg) => sg.screen || segs.length === 1).length + dec.filter((d) => d.class !== 'guard').length, 'count.unit.inWords'),
    gates: wrap((sum.counts && sum.counts.gates) || 0, 'journey.countGates'),
    decisions: wrap((sum.counts && sum.counts.decisions) || 0, 'journey.countDecisions'),
  };
}
/**
 * The lane's view control: one for the whole band, in the sticky lane label.
 * Per segment it would be the clutter it exists to remove — eleven copies of
 * it on the reference app's POC flow, each to be set separately — so it sits once beside
 * the lane's name and every count is legible from there.
 * @group Journey view
 */
export function jrnBizTabsHtml(sum) {
  const at = jrnBizTab();
  const c = jrnBizCounts(sum);
  // the tab is a button, so the number inside it carries the tip (hover) and the
  // button keeps its own click: what it counts, over the whole journey, and how it splits
  const btn = (k, key, c) => '<button class="jrn-biztab' + (at === k ? ' on' : '') + '" role="tab" aria-selected="' + (at === k) + '"'
    + ' onclick="jrnSetBizTab(\'' + k + '\')">'
    + '<span class="l">' + esc(t(key)) + '</span><span class="n"' + tipAttrs({ id: 'jrnCounted', args: { c }, noFocus: true, tipKey: 'biztab-' + k }) + '>' + (c ? c.n : 0) + '</span></button>';
  // the control's numbers are journey-wide and each cell's heading is its
  // screen's: three totals used to sit on one screen with nothing saying the
  // scopes differed (visual swarm 2026-09-24), so each says which it is
  return '<div class="jrn-biztabs" role="tablist" aria-label="' + esc(t('journey.bizTabs')) + '">'
    + btn('words', 'journey.bizTab.words', c.words)
    + btn('gates', 'journey.bizTab.gates', c.gates)
    + btn('decisions', 'journey.bizTab.decisions', c.decisions)
    + '<span class="jrn-bizscope" title="' + esc(def('journey.scopeAll') || '') + '">' + esc(t('journey.scopeAll')) + '</span></div>';
}
/** The segment's decisions as one line of ⑂ chips that jump to their fork — the compact form.
 * @group Journey view */
function jrnDecChipsHtml(list) {
  return '<div class="jrn-decs">' + jrnNumHtml(list.length, 'journey.decisionsFolded', 'journey.scopeHere', { noFocus: true, cls: 'jrn-decn' })
    + list.map((d) => '<span class="jrn-dec-chip" onclick="jrnScrollTo(' + d.order + ')" title="' + esc(t('journey.decisionChip')) + '">'
      + sym('fork') + esc(d.label) + '</span>').join('') + '</div>';
}
/**
 * Lane 2 cell: what the business promises during one segment — ▶ start on the
 * first, the sentence the person is living through, then whichever of the
 * lane's three views is open (the decisions named in words · the gates and
 * rules met here · every decision as a diamond with its pathways), ■ end on
 * the last. Gates and decisions jump to their step. The sentence is the lane's
 * spine and stays in every view; what the walk could not put into words is
 * said in every view too — hiding it would make this the one lane that
 * implies the walk was complete.
 * @group Journey view
 * @business This part of the journey in words: what the person does, and — one click away — who is allowed in and where it can branch.
 */
function jrnBizCellHtml(sg, last) {
  const scr = sg.screen;
  // the flowchart step is the first sentence of the screen's business text — the
  // full description stays on the screen card above the line of visibility
  const full = (scr && scr.business) || (scr && scr.name) || (S.JOURNEY.entry && (S.JOURNEY.entry.bizDescription || S.JOURNEY.entry.docs)) || '';
  const business = currentLens() === 'business';
  // the business lens reads the sentence's plain words; where nothing plain is
  // left, the screen's name stands in — the line the tab's count promises is drawn
  const text = business ? (jrnFirstSentence(plainWords(full)) || (scr && scr.name) || '') : jrnFirstSentence(full);
  const d = jrnBizDecs(sg);
  const tab = jrnBizTab();
  let html = '<div class="jrn-cell jrn-bizcell tab-' + tab + (business ? '' : ' compact') + '"><div class="jrn-flowh">';
  if (sg.index === 0) html += '<span class="jrn-fl-start">▶ ' + esc(t('journey.start')) + '</span>';
  html += '<div class="jrn-flowcol">';
  if (text) {
    html += '<div class="jrn-fl-step" onclick="jrnSelectSegment(' + sg.index + ')"><span class="jrn-fl-verb">'
      + esc(sg.index === 0 ? t('journey.verb.first') : t('journey.verb.then')) + '</span>' + esc(text) + '</div>';
  }
  // exactly one of the three, and an empty cell always says which kind is absent
  // rather than leaving a reader to wonder whether it was merely not drawn
  let body = '';
  if (tab === 'gates') {
    body = jrnGateListHtml(sg.gates, 'journey.scopeHere', sg.configChecks);
  } else if (tab === 'decisions') {
    // the flowchart is not deleted, only moved behind the view that asks for it —
    // in every register, including code, which hid it only because it was always on.
    // The fold's decision list and a step's own conditions are two sources, and the
    // diamond is drawn from the second: a decision the first counts and the second
    // cannot picture is still NAMED, as a chip, so what this view draws is exactly
    // what its count claims. (Before the views, those decisions were counted by the
    // fold and drawn nowhere — 27 of the reference app's 42 on the submission flow.)
    const plain = [];
    const drawn = d.shown.map((x) => {
      const dia = jrnFlowDecision(S.JOURNEY.steps[x.order], x.order);
      if (!dia) plain.push(x);
      return dia;
    }).join('') + (plain.length ? jrnDecChipsHtml(plain) : '');
    body = d.all.length
      ? '<div class="jrn-gatelist">' + jrnBizGroupHtml('journey.decisions', d.all.length, drawn, d.all.length - d.shown.length, '', 'journey.scopeHere') + '</div>'
      : '';
  } else {
    // the words view draws the screen's sentence (above) and, under it, the
    // decisions somebody described in words — the lines the tab's number counts
    body = d.inWords.length
      ? '<div class="jrn-gatelist">' + jrnBizGroupHtml('journey.bizGroup.words', d.inWords.length, jrnDecChipsHtml(d.inWords), 0, '', 'journey.scopeHere') + '</div>'
      : '';
  }
  // the gates and decisions views exist to draw their kind, so an empty one names the
  // absence; the words view is the sentence, and only a segment with no sentence either
  // leaves a reader with a blank cell to interpret
  html += body || (tab === 'words' && text ? '' : jrnAbsentHtml('noneIndexed'));
  // what the fold could NOT translate is said, not drawn as a decision — one
  // number in every lens (`segments[i].counted.notInWords`): the technical
  // conditions plus the gate conditions nobody labelled, which hybrid and code
  // also draw as decisions and still count here
  const nw = sg.counted && sg.counted.notInWords;
  const un = nw ? nw.n : (sg.untranslated || 0) + jrnSegDecisions(sg).filter((x) => x.cls === 'guard').length;
  if (un) html += jrnUntranslatedHtml(un, 'journey.scopeHere', nw || null, { t: [sg.from, sg.to], g: [sg.from, sg.to] });
  html += '</div>' + (last ? '<span class="jrn-fl-end">■ ' + esc(t('journey.end')) + '</span>' : '<span class="jrn-fl-next">▶</span>') + '</div></div>';
  return html;
}
/**
 * The decisions of one segment, with the step each one gates. When the server
 * folds them (`decisions[]` with a `stepOrder`) those are used verbatim —
 * they are the TRANSLATED ones, business and guard classes only, and what was
 * not translated is counted separately rather than drawn as a diamond. An
 * older server has neither, so the walk's own path conditions are folded here
 * exactly as before (deduped by fork + arm).
 * @group Journey view
 */
export function jrnSegDecisions(sg) {
  // Probe the SUMMARY, not this one segment's array. The fold names each decision
  // once, on the first screen that meets it, so a later screen legitimately folds
  // to `[]` — and reading that empty array as "no fold here" sent the lane back to
  // the walk, which re-derived 49 conditions the fold had deliberately deduped and
  // classed them all as business. That is where the control's `42 in words` came
  // from on a flow whose fold says none of its decisions were written in words.
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const folds = sum && sum.business && Array.isArray(sum.business.decisions);
  if (folds || (Array.isArray(sg.decisions) && sg.decisions.length && sg.decisions[0].stepOrder != null)) {
    return (sg.decisions || []).map((d) => ({ order: d.stepOrder, label: d.label || d.arm || '', cls: d.class }));
  }
  const out = [], seen = new Set();
  for (let i = sg.from; i <= sg.to; i++) {
    const st = S.JOURNEY.steps[i];
    const conds = ((st && st.conditions) || []).filter((c) => c && c.requires);
    if (!conds.length) continue;
    const key = conds.map((c) => c.nodeId + ':' + c.line + ':' + c.arm).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ order: i, label: conds[0].business || conds[0].requires });
  }
  return out;
}
/** Glyph + colour class for a marker (a rendered component wears the screen glyph: a moment of its screen).
 * @group Journey view */
function jrnMarkGlyph(m, n) {
  if (m.kind === 'call') return { g: 'api', c: 'k-route' };
  if (m.kind === 'record') return { g: 'record', c: 'k-table' };
  if (m.kind === 'message') return { g: 'message', c: 'k-queue' };
  if (m.kind === 'external') return { g: 'external', c: 'k-external' };
  if (n && (n.kind === 'component' || n.kind === 'page')) return { g: 'screen', c: 'k-page' };
  return { g: 'step', c: 'k-function' };
}
/** The plain text a marker shows — one source for the drawn chip and for the column measurement.
 * @group Journey view */
export function jrnMarkerText(m) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const lens = currentLens();
  // one written call with several implementations behind it: the call as the source
  // writes it, and how many could run — never one implementation's name (blocker 3)
  if (m.choice) {
    const n2 = m.choice.candidates.length;
    return lens === 'business'
      ? m.choice.words + ' · ' + t('journey.biz.oneOf').replace('{n}', n2)
      : m.choice.label + ' · ' + t('journey.oneOf').replace('{n}', n2);
  }
  if (m.kind === 'call') {
    const opId = n.contract && n.contract.spec && n.contract.spec.operationId;
    // business: what the call is for, in words — never its verb, its operationId or its path
    if (lens === 'business') return jrnCallWords(m, n);
    return (m.method ? m.method + ' ' : '') + String(opId || m.path || m.name || '');
  }
  const name = String(n.name || m.name || '');
  if (lens === 'code') return name;
  // the words the fold already chose for this marker (`SegmentMarker.title`):
  // the authored @business label, else — for a handler named for its HTTP verb —
  // the summary its route's spec gives it, else the first sentence a person
  // wrote. Never a humanized guess, and the same words MCP prints, so the two
  // surfaces cannot name one marker differently.
  const title = jrnMarkerTitle(m);
  if (lens === 'business') return plainWords(title) || plainWords(n.bizLabel) || humanize(String(n.name || m.name || ''));
  // hybrid = the identifier, plus a NAME beside it — never a guess (§1.4), and
  // never a paragraph: a band column is one chip wide, so a sentence per chip
  // buys readable words with a row three times as tall. The fold says which of
  // the three kinds of words these are: a short authored name and the words a
  // verb-named handler borrows from its route stand beside the identifier; a
  // documentation sentence stays in the tooltip, the panel and the business
  // register, where it has room.
  const short = title && title !== name && (m.titleFrom === 'label' || m.titleFrom === 'route') ? title : '';
  const label = short || ((n.bizLabel && n.bizLabel !== name) ? n.bizLabel : '');
  return label ? name + ' · ' + unTick(label) : name;
}
/**
 * The words the core chose for this marker, or '' when it chose none. An older
 * server carries no `title`, so every caller falls back to what it printed
 * before rather than inventing one here — the rule lives in `journey()`, and a
 * second rule in the viewer is how two surfaces start disagreeing.
 * @group Journey view
 */
export function jrnMarkerTitle(m) { return String((m && m.title) || '').trim(); }
/** A call in the business lens's words: its authored label, else the summary its
 * contract gives it, else its route said the way humanize() says it — never the
 * verb, the operationId or the path.
 * @group Journey view */
export function jrnCallWords(m, n) {
  const c = (n && n.contract) || {};
  return plainWords(n && n.bizLabel) || plainWords(jrnMarkerTitle(m)) || plainWords(c.summary)
    || humanize(String((n && n.name) || m.name || ''));
}
/** Every candidate of a run-time choice, and the sentence that refuses to pick one — as tooltip text.
 * @group Journey view */
export function jrnChoiceTip(c) {
  return c.label + ' · ' + t('journey.oneOf').replace('{n}', c.candidates.length)
    + ' — ' + t('journey.oneOf.unknown') + '\n' + c.candidates.map((x) => x.name + (x.title ? ' — ' + x.title : '')).join('\n')
    + (c.setAside && c.setAside.length ? '\n' + t('journey.oneOf.setAside').replace('{list}', c.setAside.join(', ')) : '');
}
/**
 * The run-time choice behind one call, opened: where the call is written, the
 * implementations that could run it (each with the words its author gave it and
 * a ⧉ into the editor), what the resolution set aside, and how it was matched.
 * Nothing here says which one ran — the code at that line does not say.
 * @group Journey view
 * @business Shows a call that several parts of the system could answer, and names every one of them.
 */
export function jrnChoiceHtml(c) {
  if (!c) return '';
  // the business register reads the call and the candidates in words: no declared type, no
  // technique, no test doubles — the sentence that refuses to pick one stays in every register
  const biz = currentLens() === 'business';
  // each candidate kept its own step in the walk — that is where its source location is
  const row = (x) => {
    const n = (S.JOURNEY.steps[x.stepOrder] || {}).node || null;
    const loc = n && n.loc && !biz ? vsl(n.loc.repo || (n.id || '').split('::')[0], n.loc.path, n.loc.line) : '';
    const head = biz ? (x.title || x.words || x.name) : x.name;
    return '<li><b>' + esc(head) + '</b>' + loc + (x.title && !biz ? '<i>' + esc(x.title) + '</i>' : '') + '</li>';
  };
  const at = c.at && !biz ? '<span class="at">' + esc(c.at.name + ' · ' + c.at.path + ':' + c.at.line) + vsl((c.at.nodeId || '').split('::')[0], c.at.path, c.at.line) + '</span>' : '';
  return '<div class="jrn-oneof">'
    + '<span class="hd">' + sym('oneof') + '<b>' + esc(biz ? c.words : c.label) + '</b>'
    + '<span class="n" title="' + esc(def('journey.oneOf') || '') + '">'
    + esc(biz ? t('journey.biz.oneOf').replace('{n}', c.candidates.length) : t('journey.oneOf').replace('{n}', c.candidates.length)) + '</span>'
    + (c.iface && !biz ? '<span class="via" title="' + esc(def('journey.oneOf.through') || '') + '">' + esc(t('journey.oneOf.through').replace('{iface}', c.iface)) + '</span>' : '')
    + '</span>'
    + at
    + '<span class="why">' + esc(t('journey.oneOf.unknown')) + '</span>'
    + '<span class="hud-label">' + esc(t('journey.oneOf.candidates')) + '</span>'
    + '<ul>' + c.candidates.map(row).join('') + '</ul>'
    + (!biz && c.setAside && c.setAside.length ? '<span class="aside">' + esc(t('journey.oneOf.setAside').replace('{list}', c.setAside.join(', '))) + '</span>' : '')
    + (!biz && c.technique ? '<span class="how">' + esc(t('journey.oneOf.how').replace('{technique}', c.technique).replace('{confidence}', c.confidence || '')) + '</span>' : '')
    + '</div>';
}
/**
 * One marker on a system row: method + operationId for a call, the name for a
 * step/record/message, dashed when declared and not built, a ↺ ghost when the
 * walk already ran it, ▸-prefixed when it is a helper inside its handler.
 * Carries data-order so selection, j/k and the forks drawer address it by step.
 * @group Journey view
 */
export function jrnMarkerHtml(m) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const gk = jrnMarkGlyph(m, n);
  const lens = currentLens();
  let label;
  if (m.kind === 'call' && m.method && lens !== 'business') label = '<b>' + esc(m.method) + '</b> ' + esc(jrnMarkerText(m).slice(m.method.length + 1));
  else label = esc(jrnMarkerText(m));
  // which side of a transaction boundary this part is written on: the mark is quiet (a rule
  // down its edge) and the words are the catalog's, so a chip cannot say it in its own way
  const txKey = m.tx ? (lens === 'business' ? 'journey.biz.tx.' + m.tx : 'journey.tx.' + m.tx) : '';
  // the chip clips to its column, so the tooltip carries both halves in full:
  // the identifier it is, and the words it was given
  const tip = m.choice ? jrnChoiceTip(m.choice)
    : [m.name, jrnMarkerTitle(m) || m.business].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ');
  const title = tip + (m.path ? ' · ' + m.method + ' ' + m.path : '')
    + (m.planned ? ' · ' + t('journey.plannedNote') : '') + (m.repeat ? ' · ' + t('journey.repeated') : '')
    + (txKey ? ' · ' + t(txKey) : '');
  return '<span class="jrn-mk ' + (m.choice ? 'oneof ' : '') + gk.c + (m.tx ? ' tx-' + m.tx : '') + (m.planned ? ' planned' : '') + (m.repeat ? ' rep' : '') + (m.helper ? ' helper' : '')
    + '" data-order="' + m.stepOrder + '" tabindex="0" onclick="event.stopPropagation();jrnSelect(' + m.stepOrder + ')" title="' + esc(title) + '">'
    + sym(m.choice ? 'oneof' : gk.g) + label + (m.op ? '<i>' + esc(t('journey.op.' + m.op)) + '</i>' : '') + (m.repeat ? '<span class="rep">↺</span>' : '')
    + (m.cut ? '<span class="cut" title="' + esc(def('journey.cutPoints')) + '">▸ ' + esc(t('journey.notFollowed').replace('{n}', m.cut)) + '</span>' : '')
    + '</span>';
}
/**
 * The seam card: one call drawn as the line where the UX meets the API —
 * method, operationId (or path), the spec's own summary and its contract
 * status, then both ends with ⧉ into the editor: the fetch line the browser
 * made it from, and where the API starts. A declared operation with no code
 * behind it says so rather than inventing a handler.
 * @group Journey view
 * @business Shows each API call as the promise it is, with the screen that asks and the service that answers.
 */
export function jrnSeamCardHtml(m) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const c = n.contract || {};
  const lens = currentLens();
  const opId = c.spec && c.spec.operationId;
  const business = lens === 'business';
  const name = business ? jrnCallWords(m, n) : (opId || m.path || m.name);
  const summary0 = c.summary && c.summary !== name ? c.summary : (n.bizLabel && n.bizLabel !== name ? n.bizLabel : '');
  const summary = business ? (plainWords(summary0) !== name ? plainWords(summary0) : '') : summary0;
  const statusKey = c.status === 'both' ? 'apis.status.both' : c.status === 'spec-only' ? 'apis.status.specOnly'
    : c.status === 'declared' ? 'apis.status.declared' : c.status === 'code-only' ? 'apis.status.codeOnly' : 'apis.status.implemented';
  const statusCls = c.status === 'both' ? ' ok' : c.status === 'code-only' ? ' warn' : c.status === 'spec-only' ? ' stub' : '';
  const end = (e, cls, word) => e
    ? '<span class="' + cls + '">' + esc(word) + ' ' + esc(e.path + ':' + e.line) + vsl(e.repo, e.path, e.line) + '</span>'
    : '<span class="' + cls + ' miss">' + esc(word) + ': ' + esc(t('journey.seam.notBuilt')) + '</span>';
  return '<span class="jrn-seam' + (m.planned ? ' planned' : '') + (m.repeat ? ' rep' : '') + '" data-order="' + m.stepOrder + '" tabindex="0"'
    + ' onclick="jrnSelect(' + m.stepOrder + ')" title="' + esc((m.method || '') + ' ' + (m.path || '')) + '">'
    + '<span class="l1">' + sym('api') + (m.method && !business ? '<b>' + esc(m.method) + '</b>' : '') + '<span class="nm">' + esc(name) + '</span>'
    // the code names no method and several endpoints share the address: the read one is shown, and says so
    + (m.methodAssumed ? '<span class="api-chip warn"' + tipAttrs({ key: 'journey.seam.methodAssumed', noFocus: true }) + '>' + esc(t('journey.seam.methodAssumed')) + '</span>' : '')
    + (summary ? '<span class="sum">' + proseHtml(summary) + '</span>' : '')
    // whether the spec and the code agree is a developer's question
    + (business ? '' : '<span class="api-chip' + statusCls + '">' + esc(t(statusKey)) + '</span>')
    + (m.repeat ? '<span class="rep">↺</span>' : '') + '</span>'
    + '<span class="l2">' + end(m.caller, 'ux', '← ' + t('journey.seam.from')) + end(m.handler, 'sv', '→ ' + t('journey.seam.handled')) + '</span></span>';
}
/** The component a moment's action lives in: a span header, or the continuation line when it stayed open.
 * @group Journey view */
function jrnCompSpanHtml(mo) {
  if (!mo.component) return '';
  const open = mo.component.stepOrder < mo.from;
  return '<span class="jrn-compspan' + (open ? ' cont' : '') + '" onclick="jrnScrollTo(' + mo.component.stepOrder + ')" title="' + esc(mo.component.name) + '">'
    + sym('screen') + '<span class="nm">' + esc(mo.component.label) + (open ? ' · ' + esc(t('journey.stillOpen')) : '') + '</span>'
    + jrnCompStoryHtml(mo.component.id) + '</span>';
}
/** A story glyph on a component span when the component can be seen on its own — opens the large story view.
 * @group Journey view */
function jrnCompStoryHtml(id) {
  const c = id && S.BYID[id];
  if (!c || !(c.stories || []).length) return '';
  return '<button class="sb-compspan" onclick="event.stopPropagation();openStoryLightbox(' + jsArg(id) + ')" title="' + esc(t('stories.openLarge') + ' · ' + t('stories.title')) + '" aria-label="' + esc(t('stories.openLarge') + ' · ' + t('stories.title')) + '">' + sym('story') + '</button>';
}
/** Label + sub-line for a system row by its kind — a repo row names the side of the seam it is.
 * @group Journey view */
function jrnRowLabel(r) {
  if (r.kind === 'api') return { label: t('journey.row.api') + ' · ' + r.label, sub: r.planned ? t('journey.rowPlanned') : t('journey.rowSub.api') };
  if (r.kind === 'repo') {
    const side = r.side === 'ux' ? 'ux' : 'server';
    return { label: t('journey.row.' + side), sub: r.planned ? t('journey.rowPlanned') : r.label + ' · ' + t('journey.rowSub.' + side) };
  }
  if (r.kind === 'external') return { label: t('journey.row.external') + ' · ' + r.label, sub: t('journey.rowSub.external') };
  return { label: t('journey.row.' + r.kind), sub: t('journey.rowSub.' + r.kind) };
}
// ── the view axis: lens × view × band (journey-views-pass-2026-09 §2.1) ──
/**
 * The visual a journey opens on when the reader has not chosen one: the
 * business register lands on the storyboard (the product in its own words),
 * hybrid on the sheet (every action across, every layer down), the code lens
 * on the timeline it has always had. A default, never a cage — an explicit
 * choice is remembered and a `?view=` link always wins.
 * @group Journey view
 * @business Opens the journey in the shape that suits the reader: the storyboard for the business, the sheet for both, the timeline for code.
 */
/** Where this browser remembers the journey view a register last chose (one key per register). */
function jrnLayoutKey(lens) { return 'fs-jrn-layout.' + lens; }
function jrnDefaultLayout() {
  const lens = currentLens();
  return lens === 'business' ? 'storyboard' : lens === 'code' ? 'timeline' : 'sheet';
}
/**
 * Which visual the journey is drawn as — `storyboard` (the screens and the
 * selected action's ledger), `timeline` (the blueprint timeline), `sheet` (the
 * system sheet) or `drill` (behind its flag). A `?view=` deep link wins (the
 * shell puts it on S.jrnLayout), else what this browser last chose in this
 * register, else the register's own default.
 * @group Journey view
 */
function jrnLayout() {
  // the register decides the landing view, and the reader's last choice is remembered per register: one choice
  // for every register opened the business reader on the Sheet a hybrid session had picked (three swarms running)
  const lens = currentLens();
  if (S.jrnLayout && S.jrnLayoutLens && S.jrnLayoutLens !== lens) S.jrnLayout = null;
  if (!S.jrnLayout) {
    let saved = '';
    try { saved = localStorage.getItem(jrnLayoutKey(lens)) || ''; } catch (e) { saved = ''; }
    S.jrnLayout = /^(storyboard|timeline|sheet|drill)$/.test(saved) ? saved : jrnDefaultLayout();
  }
  // a `?view=` link's choice holds for the register it was opened in
  S.jrnLayoutLens = lens;
  // the drill is an experiment: with the flag off, a remembered or deep-linked `drill` reads as the timeline (and share links say so)
  if (S.jrnLayout === 'drill' && !jrnDrillEnabled()) S.jrnLayout = 'timeline';
  return S.jrnLayout;
}
/**
 * The STORYBOARD · TIMELINE · SHEET (· DRILL) switch in the journey header — the
 * primary control of this surface, so it is drawn with a visible label beside the
 * flow's name rather than as one chip among five at the right edge. Key `v` does
 * the same thing.
 *
 * The button the current register opens in carries a quiet mark and says so in
 * its tooltip. A default that moves a familiar view reads as a deletion; naming
 * it on the control itself is the smallest place to say otherwise, and it says
 * nothing about the product — only about where this browser lands.
 *
 * One catalog key is both the visible label and the group's accessible name, so
 * the control cannot announce itself one way and read another.
 * @group Journey view
 */
function jrnLayoutSwitchHtml() {
  const v = jrnLayout();
  const dflt = jrnDefaultLayout();
  const b = (k, key) => {
    const isDflt = k === dflt;
    const tip = [def(key) || t(key), isDflt ? (def('journey.layoutDefault') || t('journey.layoutDefault')) : ''].filter(Boolean).join('\n\n');
    return '<button class="jrn-viewbtn' + (v === k ? ' on' : '') + (isDflt ? ' deflt' : '')
      + '" onclick="jrnSetLayout(\'' + k + '\')" aria-pressed="' + (v === k ? 'true' : 'false')
      + '" title="' + esc(tip) + '">' + esc(t(key)) + '</button>';
  };
  return '<span class="hud-label" id="jrn-viewsw-label">' + esc(t('journey.layoutSwitch')) + '</span>'
    + '<span class="jrn-viewsw jrn-layoutsw" role="group" aria-labelledby="jrn-viewsw-label">'
    + b('storyboard', 'journey.layout.storyboard') + b('timeline', 'journey.layout.timeline') + b('sheet', 'journey.layout.sheet')
    + (jrnDrillEnabled() ? b('drill', 'journey.layout.drill') : '') + '</span>';
}
/**
 * Switch the journey between its visuals and redraw. Selection, lens and
 * scope survive the switch — only the drawing changes.
 * @group Journey view
 * @business Switches between reading the journey as a storyboard, as a timeline and as one sheet of actions × layers.
 */
export function jrnSetLayout(v) {
  S.jrnLayout = /^(storyboard|sheet)$/.test(v) ? v : (v === 'drill' && jrnDrillEnabled()) ? 'drill' : 'timeline';
  S.jrnLayoutLens = currentLens();
  try { localStorage.setItem(jrnLayoutKey(S.jrnLayoutLens), S.jrnLayout); } catch (e) { /* private mode: the view is just not remembered */ }
  jrnWriteViewHash();
  if (S.JOURNEY) renderJourney(S.JOURNEY);
}
/**
 * Make the address bar name the view and the band the reader is looking at.
 *
 * `y` has always written the full state into the shared link; the address bar
 * did not, so clicking DRILL (or pressing `v`) changed the picture while the
 * URL still said `view=timeline` — and copying the address bar, which is what
 * people actually do, handed a colleague a different screen with nothing to
 * say so. `replaceState` because a view switch is not a new place: Back should
 * still leave the journey, not walk back through four views.
 * @group Journey view
 */
function jrnWriteViewHash() {
  const h = location.hash || '';
  if (!isJourneyRoute(h)) return;
  const next = journeyViewHash(h, { view: S.jrnLayout || '', band: S.jrnView || '' });
  if (next !== h) history.replaceState(null, '', next);
}
/** Cycle the journey's visual (the `v` key).
 * @group Journey view */
export function jrnCycleLayout() {
  const order = jrnDrillEnabled() ? ['storyboard', 'timeline', 'sheet', 'drill'] : ['storyboard', 'timeline', 'sheet'];
  jrnSetLayout(order[(order.indexOf(jrnLayout()) + 1) % order.length]);
}

// ── the code pane's dock: in place · bottom · right (2026-09-15) ─────────
/**
 * Where a marker's contract / code opens — `inline` under its system row (the
 * board behaviour), or pinned as a pane at the `bottom` or the `right` of the
 * overlay so it never scrolls out of reach. A `?dock=` deep link wins (the
 * shell puts it on S.jrnDock), else what this browser last chose; `bottom`
 * when nothing was chosen yet.
 * @group Journey view
 */
function jrnDock() {
  if (!S.jrnDock) {
    try { S.jrnDock = localStorage.getItem('fs-jrn-dock'); } catch (e) { S.jrnDock = null; }
    if (!/^(inline|bottom|right)$/.test(S.jrnDock || '')) S.jrnDock = 'bottom';
  }
  return S.jrnDock;
}
/** The IN PLACE · BOTTOM · RIGHT switch in the journey header (key `d` cycles it).
 * @group Journey view */
function jrnDockSwitchHtml() {
  const v = jrnDock();
  const b = (k, key) => '<button class="jrn-viewbtn' + (v === k ? ' on' : '') + '" onclick="jrnSetDock(\'' + k + '\')" title="' + esc(def(key) || t(key)) + '">' + esc(t(key)) + '</button>';
  return '<span class="jrn-viewsw jrn-docksw" role="group" aria-label="' + esc(t('journey.dockSwitch')) + '">'
    + b('inline', 'journey.dock.inline') + b('bottom', 'journey.dock.bottom') + b('right', 'journey.dock.right') + '</span>';
}
/**
 * Move the code pane — in place, bottom or right — and re-open the selected
 * marker there. Selection, lens, view and band survive; only the pane moves.
 * @group Journey view
 * @business Pins the code and contract pane where it can be read without scrolling away from the journey.
 */
export function jrnSetDock(v) {
  S.jrnDock = /^(inline|bottom|right)$/.test(v) ? v : 'bottom';
  try { localStorage.setItem('fs-jrn-dock', S.jrnDock); } catch (e) { /* private mode: the pane is just not remembered */ }
  jrnApplyDock();
  const sw = document.getElementById('jrn-docksw');
  if (sw) sw.innerHTML = jrnDockSwitchHtml();
  if (S.JOURNEY && S.JRN_MARK) jrnSelect(S.journeyActive, true);
}
/** Cycle the code pane's dock (the `d` key): in place → bottom → right.
 * @group Journey view */
export function jrnCycleDock() {
  const order = ['inline', 'bottom', 'right'];
  jrnSetDock(order[(order.indexOf(jrnDock()) + 1) % order.length]);
}
/** Put the dock's class on the overlay body and size the pane from what this browser last dragged it to.
 * @group Journey view */
function jrnApplyDock() {
  const body = document.getElementById('jrn-body');
  const pane = document.getElementById('jrn-dock');
  if (!body || !pane) return;
  // the drill has its own inspector on the right: the pane stays out of the way there
  const d = jrnLayout() === 'drill' ? 'inline' : jrnDock();
  body.classList.toggle('dock-bottom', d === 'bottom');
  body.classList.toggle('dock-right', d === 'right');
  pane.style.display = d === 'inline' ? 'none' : '';
  if (d === 'inline') pane.innerHTML = '';
  // whether the pane holds anything — and therefore how much room it takes — is
  // decided in jrnDockRender, the one place that knows what is selected
  if (d !== 'inline' && !pane.innerHTML) jrnDockRender(-1);
  jrnDockSize();
}
/**
 * Drag the pane's edge (its grip) to resize it; the size is remembered per
 * dock so the next journey opens the same way.
 * @group Journey view
 */
function jrnDockGrip(e) {
  const pane = document.getElementById('jrn-dock');
  const body = document.getElementById('jrn-body');
  if (!pane || !body || e.button) return;
  e.preventDefault();
  const d = jrnDock();
  const start = d === 'bottom' ? e.clientY : e.clientX;
  const from = d === 'bottom' ? pane.offsetHeight : pane.offsetWidth;
  const max = d === 'bottom' ? body.clientHeight - 120 : body.clientWidth - 320;
  let size = from;
  const move = (ev) => {
    size = Math.max(160, Math.min(max, from + (start - (d === 'bottom' ? ev.clientY : ev.clientX))));
    if (d === 'bottom') pane.style.height = size + 'px'; else pane.style.width = size + 'px';
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    try { localStorage.setItem('fs-jrn-dock-' + d, String(Math.round(size))); } catch (err) { /* not remembered */ }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
/** Fill the pinned pane with the selected marker's expansion, or with the hint when nothing is selected.
 * @group Journey view */
function jrnDockSize() {
  const pane = document.getElementById('jrn-dock');
  if (!pane) return;
  const d = jrnLayout() === 'drill' ? 'inline' : jrnDock();
  const open = !pane.classList.contains('empty');
  let size = 0;
  try { size = +localStorage.getItem('fs-jrn-dock-' + d) || 0; } catch (e) { size = 0; }
  pane.style.height = d === 'bottom' && size && open ? size + 'px' : '';
  pane.style.width = d === 'right' && size && open ? size + 'px' : '';
}
/**
 * Render the docked pane: a chosen marker's contract or code, or the one-line
 * hint that says how to choose one.
 * @group Journey view
 */
function jrnDockRender(i) {
  const pane = document.getElementById('jrn-dock');
  if (!pane) return;
  const grip = '<div class="jrn-dock-grip" onpointerdown="jrnDockGrip(event)" title="' + esc(t('journey.dockResize')) + '"></div>';
  const open = i >= 0 && S.JRN_MARK && S.JRN_MARK[i];
  // an empty pane holds no code, so it takes no room: it collapses to its one-line
  // hint until a marker is chosen. Held open it cost the bottom 40% of the journey —
  // and with it the records, messages, third-party and Verified-by rows.
  pane.classList.toggle('empty', !open);
  pane.innerHTML = grip + '<div class="jrn-dock-body">'
    + (open ? jrnExpHtml(i) : '<div class="jrn-dock-hint">' + esc(t('journey.expandHint')) + '</div>') + '</div>';
  jrnDockSize();
}

// ── the ladder (board F): one segment on its side ───────────────
/** The band's view mode — `rows` (the moment grid) or `ladder`, remembered per browser.
 * @group Journey view */
function jrnView() {
  // a `?band=` deep link wins (the shell puts it on S.jrnView), else what this browser last chose
  if (!S.jrnView) { try { S.jrnView = localStorage.getItem('fs-jrn-view') === 'ladder' ? 'ladder' : 'rows'; } catch (e) { S.jrnView = 'rows'; } }
  return S.jrnView;
}
/** The `rows | ladder` control in the band header (key `l` does the same).
 * @group Journey view */
function jrnViewToggleHtml() {
  const v = jrnView();
  const b = (k, label) => '<button class="jrn-viewbtn' + (v === k ? ' on' : '') + '" onclick="jrnSetView(\'' + k + '\')">' + esc(label) + '</button>';
  return '<span class="jrn-viewsw">' + b('rows', t('journey.view.rows')) + b('ladder', t('journey.view.ladder')) + '</span>';
}
/**
 * Switch the system band between the moment grid and the ladder, and redraw.
 * @group Journey view
 * @business Turns the segment on its side — systems as columns, time running down, one line per step.
 */
export function jrnSetView(v) {
  S.jrnView = v === 'ladder' ? 'ladder' : 'rows';
  try { localStorage.setItem('fs-jrn-view', S.jrnView); } catch (e) { /* private mode: the view is just not remembered */ }
  jrnWriteViewHash();
  if (S.JOURNEY) renderJourney(S.JOURNEY);
}
/** Toggle rows ↔ ladder (the `l` key).
 * @group Journey view */
export function jrnToggleView() {
  if (jrnLayout() !== 'timeline') return; // the band's shape is a timeline control — the sheet and the drill have no band
  jrnSetView(jrnView() === 'ladder' ? 'rows' : 'ladder');
}
/** Short column label for a system in the ladder header.
 * @group Journey view */
function jrnLadderColLabel(r) { const lb = jrnRowLabel(r); return lb.label; }
// The ladder's widths. A column a screen uses is never narrower than twice the
// share it had when every system drew a full lane (172 px), and grows to what
// it holds; a column it skips between two it uses keeps its place, narrow; the
// columns after the last one it uses fold into one end column.
const JRN_LAD_TIME = 150, JRN_LAD_COL = 172, JRN_LAD_USED = 344, JRN_LAD_MAX = 520, JRN_LAD_SKIP = 34, JRN_LAD_END = 210, JRN_LAD_PAD = 32;
/**
 * One segment's ladder before it is drawn: its lines (the time cell and the
 * cells by system key), which systems those lines use, and the columns that
 * follow from that — every system up to the last one used, each `used` or
 * `skip` (in its place, narrow), then the systems after it folded into one
 * `end` list. A screen whose ladder reaches the last system with no gap has no
 * end column and draws every column exactly as it always did.
 * @group Journey view
 * @business Works out which parts of the system one screen actually uses, so the ones it never reaches fold into one column that says so.
 */
function jrnLadderModel(sum, sg) {
  const uxKey = (sum.systems.find((r) => r.kind === 'repo' && r.side === 'ux') || {}).key;
  const svKey = (sum.systems.find((r) => r.kind === 'repo' && r.side === 'server') || {}).key;
  const momStart = new Map();
  sg.moments.forEach((mo) => { const first = sg.markers.find((m) => m.moment === mo.index); if (first) momStart.set(first.stepOrder, mo); });
  // `want` is what a cell needs, in px, so a column can be as wide as its widest line
  const want = {};
  const need = (key, px) => { want[key] = Math.max(want[key] || 0, px); };
  const MONO = 6.3;
  const lines = sg.markers.map((m) => {
    const mo = momStart.get(m.stepOrder);
    const time = mo ? '<span class="o">' + jrnMomOrdinal(sg, mo) + ' · ' + esc(jrnMoLabel(mo)) + '</span>' : String(m.stepOrder + 1);
    const cells = {};
    if (m.kind === 'call') {
      if (uxKey && m.caller) {
        const at = m.caller.path + ':' + m.caller.line;
        cells[uxKey] = '<span class="go">' + esc(at) + ' →</span>';
        need(uxKey, 30 + (at.length + 2) * MONO);
      }
      cells[m.system] = jrnSeamCardHtml(m) + '<span class="go"> →</span>';
      need(m.system, 70 + jrnMarkerText(m).length * MONO);
    } else if (m.kind === 'record' || m.kind === 'message' || m.kind === 'external') {
      if (svKey) { cells[svKey] = '<span class="go out">→</span>'; need(svKey, 40); }
      cells[m.system] = jrnMarkerHtml(m);
      need(m.system, 44 + jrnMarkerText(m).length * MONO);
    } else {
      // indented by tier: the handler flush left, its parts one step in, their drill-downs deeper
      const tier = m.tier != null ? m.tier : (m.helper ? 1 : 0);
      const node = m.nodeId && S.JOURNEY.steps[m.stepOrder] && S.JOURNEY.steps[m.stepOrder].node;
      const loc = node && node.loc ? node.loc.path + ':' + node.loc.line : '';
      cells[m.system] = '<span class="ind"></span>'.repeat(tier) + jrnMarkerHtml(m)
        + (loc ? '<span class="back">' + esc(loc) + '</span>' : '');
      // the name whole, and the file line as far as it fits: it is the part that may ellipsize
      need(m.system, 40 + tier * 16 + jrnMarkerText(m).length * MONO + (loc ? 8 + Math.min(loc.length, 30) * 5.9 : 0));
    }
    return { time, cells };
  });
  const used = new Set();
  lines.forEach((l) => Object.keys(l.cells).forEach((k) => used.add(k)));
  let last = -1;
  sum.systems.forEach((r, i) => { if (used.has(r.key)) last = i; });
  const cols = sum.systems.slice(0, last + 1).map((r) => ({ r, state: used.has(r.key) ? 'used' : 'skip' }));
  const end = sum.systems.slice(last + 1);
  const full = !end.length && cols.every((c) => c.state === 'used');
  const widths = cols.map((c) => (c.state === 'skip' ? JRN_LAD_SKIP
    : Math.round(Math.max(JRN_LAD_USED, Math.min(JRN_LAD_MAX, want[c.r.key] || 0)))));
  const oldW = JRN_LAD_TIME + sum.systems.length * JRN_LAD_COL;
  // the screen that reaches every system is drawn exactly as before; any other is as
  // wide as what it uses, and never wider than it used to be
  // — unless its end column is wider than the lanes it folds: then no used column is narrower than it was
  const nUsed = cols.filter((c) => c.state === 'used').length, nSkip = cols.length - nUsed;
  const rest = JRN_LAD_PAD + JRN_LAD_TIME + nSkip * JRN_LAD_SKIP + (end.length ? JRN_LAD_END : 0);
  const width = full ? oldW
    : Math.min(Math.max(oldW, rest + nUsed * JRN_LAD_COL), rest + widths.reduce((a, b) => a + b, 0) - nSkip * JRN_LAD_SKIP);
  // each system this screen leaves empty wears the core's word for it — the same
  // word the rows and the sheet print: a walk cut short before it cannot say it took no part
  const word = (key) => jrnAbsentWord(sg, null, key);
  return { lines, cols, end, full, widths, width, word };
}
/** The grid template of one ladder: the time column, then one track per drawn column.
 * @group Journey view */
function jrnLadderTemplate(lm) {
  if (lm.full) return 'grid-template-columns:' + JRN_LAD_TIME + 'px repeat(' + lm.cols.length + ',minmax(0,1fr))';
  const n = Math.max(1, Math.min(lm.lines.length, JRN_LADDER_LINES));
  return 'grid-template-rows:repeat(' + (n + 1) + ',auto) minmax(0,1fr);grid-template-columns:' + JRN_LAD_TIME + 'px '
    + lm.cols.map((c, i) => (c.state === 'skip' ? JRN_LAD_SKIP + 'px' : 'minmax(0,' + lm.widths[i] + 'fr)')).join(' ')
    + (lm.end.length ? ' ' + JRN_LAD_END + 'px' : '');
}
/** The absence word for a system the ladder does not draw as a column, in the lens's words.
 * @group Journey view */
function jrnLadderAbsentWord(word) { return jrnAbsentText(word); }
/**
 * One ladder line: the time cell, then one cell per drawn column. A column the
 * screen does not use holds one cell that spans the lines on show — its words
 * run down it — so line `i` draws that cell on the first line, nothing while
 * the span covers it, and an empty filler past it (the lines behind *more*).
 * @group Journey view
 */
function jrnLadderLine(lm, time, cells, cls, i, span) {
  const spanned = (html) => (i === 0 ? html : i < span.n ? '' : span.pad);
  return '<div class="jrn-lline' + (cls ? ' ' + cls : '') + '"><div class="t">' + time + '</div>'
    + lm.cols.map((c) => (c.state === 'skip' ? spanned(span.skip[c.r.key]) : '<div class="lc">' + (cells[c.r.key] || '') + '</div>')).join('')
    + (lm.end.length ? spanned(span.end) : '') + '</div>';
}
/**
 * One segment as a ladder: the systems it uses as columns, time running down,
 * one line per marker in step order. A call crosses the seam left to right — the
 * fetch line in the browser column, the seam card in the API column; helpers
 * are indented under their handler; records and messages are drawn with an
 * arrow out of the service column. A system skipped before or between the ones
 * the screen uses keeps its place as a narrow dimmed column; the systems after
 * the last one it uses fold into one end column that names each with its
 * absence word. Long segments cap at a line budget.
 * @group Journey view
 * @business Reads one screen as a sequence — the stack trace with names, in the order it happens — and says where it stops.
 */
function jrnLadderCellHtml(sum, sg) {
  const lm = jrnLadderModel(sum, sg);
  const biz = currentLens() === 'business';
  const endKey = biz ? 'journey.biz.ladder.end' : 'journey.ladder.end';
  const colTip = (key) => tipAttrs({ id: 'jrnLadderCol', args: { seg: sg.index, key } });
  const head = '<div class="jrn-lline jrn-lhead"><div class="t">' + esc(t('journey.ladder.time')) + ' ↓</div>'
    + lm.cols.map((c) => {
      const r = c.r, k = ' k-' + esc(r.kind) + (r.side ? ' side-' + esc(r.side) : '');
      if (c.state === 'skip') {
        return '<div class="lc skip' + k + '"' + colTip(r.key) + ' aria-label="' + esc(jrnLadderColLabel(r) + ' · ' + jrnLadderAbsentWord(lm.word(r.key))) + '">'
          + sym('absent') + '</div>';
      }
      return '<div class="lc' + k + '">' + esc(jrnLadderColLabel(r)) + '</div>';
    }).join('')
    + (lm.end.length ? '<div class="lc lend"' + colTip('end') + '>' + esc(t(endKey)) + '</div>' : '') + '</div>';
  const n = Math.max(1, Math.min(lm.lines.length, JRN_LADDER_LINES));
  // the spans reach one row further, into a filler row that is the grid's only
  // flexible one: an end list taller than the lines grows that row, never the lines
  const rows = ' style="grid-row:span ' + (n + 1) + '"';
  const skip = {};
  lm.cols.forEach((c) => {
    if (c.state === 'skip') skip[c.r.key] = '<div class="lc skip"' + rows + ' data-sys="' + esc(c.r.key) + '" data-absent="' + lm.word(c.r.key) + '"><span class="v">' + esc(jrnLadderColLabel(c.r) + ' · ' + jrnLadderAbsentWord(lm.word(c.r.key))) + '</span></div>';
  });
  const end = '<div class="lc lend-list"' + rows + '>'
    + lm.end.map((r) => '<span class="le" data-sys="' + esc(r.key) + '" data-absent="' + lm.word(r.key) + '">' + sym('absent') + '<span class="le-n">' + esc(jrnLadderColLabel(r)) + '</span>'
      + '<span class="le-w">' + esc(jrnLadderAbsentWord(lm.word(r.key))) + '</span></span>').join('') + '</div>';
  const span = { n, skip, end, pad: '<div class="lc lpad"></div>' };
  const lines = lm.lines.map((l, i) => jrnLadderLine(lm, l.time, l.cells, i >= JRN_LADDER_LINES ? 'over s' + sg.index : '', i, span));
  // a screen with no line at all still says where it stops
  if (!lines.length && !lm.full) lines.push(jrnLadderLine(lm, '', {}, '', 0, span));
  if (!lm.full) {
    lines.splice(n, 0, '<div class="jrn-lline lfill"><div class="t"></div>'
      + lm.cols.map((c) => (c.state === 'used' ? '<div class="lc"></div>' : '')).join('') + '</div>');
  }
  const hidden = Math.max(0, lm.lines.length - JRN_LADDER_LINES);
  return '<div class="jrn-cell jrn-laddercell' + (lm.full ? '' : ' folded') + '" data-seg="' + sg.index + '" data-used="' + lm.cols.filter((c) => c.state === 'used').length
    + '" data-end="' + lm.end.length + '"><div class="jrn-ladder" style="' + jrnLadderTemplate(lm) + '">' + head + lines.join('') + '</div>'
    + (hidden ? '<button class="jrn-lmore" onclick="jrnLadderMore(' + sg.index + ',this)">▾ ' + esc(t('journey.moreSteps').replace('{n}', hidden)) + '</button>' : '')
    + '</div>';
}
/**
 * The tip on a ladder column the screen does not use: the end column (what it
 * stands for, and every system folded into it with its absence word) or a
 * narrow skipped column (which system, and why it keeps its place).
 * @group Journey view
 */
function jrnLadderColTip(el, args) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const sg = sum && (sum.segments || []).find((x) => x.index === (args && args.seg));
  if (!sg) return '';
  const lm = jrnLadderModel(sum, sg);
  const biz = currentLens() === 'business';
  if (args.key === 'end') {
    const k = biz ? 'journey.biz.ladder.end' : 'journey.ladder.end';
    return '<div class="tip-h">' + esc(t(k)) + '</div><p class="tip-p">' + esc(def(k) || '') + '</p>'
      + tableTip({ caption: 'journey.ladder.folded', rows: lm.end.map((r) => [jrnLadderColLabel(r), jrnLadderAbsentWord(lm.word(r.key))]) });
  }
  const r = sum.systems.find((x) => x.key === args.key);
  if (!r) return '';
  const k = biz ? 'journey.biz.ladder.skip' : 'journey.ladder.skip';
  return '<div class="tip-h">' + esc(jrnLadderColLabel(r) + ' · ' + jrnLadderAbsentWord(lm.word(r.key))) + '</div>'
    + '<p class="tip-p">' + esc(def(k) || '') + '</p>';
}
registerTip('jrnLadderCol', jrnLadderColTip);
/** Reveal the lines past a ladder's budget.
 * @group Journey view */
function jrnLadderMore(si, btn) {
  document.querySelectorAll('#jrn-tl .jrn-lline.over.s' + si).forEach((el) => el.classList.remove('over'));
  if (btn) btn.style.display = 'none';
}
/** The whole band in ladder mode: one ladder per segment, one expansion slot beneath.
 * @group Journey view */
function jrnLadderHtml(sum, rowStyle) {
  return '<div class="jrn-row jrn-ladderrow" style="' + rowStyle + '">' + jrnLaneHtml('', '', 'jrn-ladderlane')
    + sum.segments.map((sg) => jrnLadderCellHtml(sum, sg)).join('') + '</div>'
    + '<div class="jrn-exp" id="jrn-exp-0" style="display:none"></div>';
}
/** The moment stops of one segment: ordinal · label · ↺, the header of the moment grid.
 * @group Journey view */
function jrnMomHeadHtml(sg) {
  const found = jrnRankOrder(sg);
  // the stops the screen's manifest lists that no call in its code made: drawn
  // dotted, after the ones that ran, so the rail is the whole promise (R6)
  const declared = (sg.declaredOnly || []).map((d) => '<div class="jrn-momcol"><span class="jrn-momlbl declonly" title="' + esc(t('journey.rail.declaredOnly')) + '">'
    + '<span class="o">·</span><span class="n">' + esc(jrnDeclLabel(d)) + '</span></span></div>').join('');
  return '<div class="jrn-cell jrn-momhead" data-seg="' + sg.index + '"><div class="jrn-mom" style="' + jrnMomStyle(sg.index) + '">'
    + found.map((mo) => '<div class="jrn-momcol"><span class="jrn-momlbl" onclick="jrnScrollTo(' + (mo.callStep != null ? mo.callStep : mo.actionStep) + ')" title="' + esc(mo.business || mo.label) + '">'
      + '<span class="o">' + jrnMomOrdinal(sg, mo) + '</span><span class="n">' + esc(jrnMoLabel(mo)) + '</span>' + (mo.repeat ? '<span class="rep">↺</span>' : '') + '</span></div>').join('')
    + declared + '</div></div>';
}
/**
 * A segment's actions in the order its screen's manifest lists the operations,
 * with anything the manifest does not list after them in walk order. The fold
 * gives every action its `rank`; the array itself stays in walk order because
 * the marker rows index into it positionally, so the ordering is a display
 * choice made here and nowhere else.
 * @group Journey view
 */
export function jrnMomOrdinal(sg, mo) {
  const i = jrnRankOrder(sg).findIndex((x) => x.index === mo.index);
  return (i < 0 ? mo.index : i) + 1;
}
/**
 * A segment's actions in the order its screen's manifest lists the operations,
 * with anything the manifest does not list after them in walk order.
 * @group Journey view
 */
export function jrnRankOrder(sg) {
  const ms = (sg.moments || []).slice();
  if (!ms.some((mo) => mo.rank != null)) return ms;
  return ms.sort((a, b) => (a.rank != null ? a.rank : a.index) - (b.rank != null ? b.rank : b.index));
}
/**
 * The drill tree of one cell (a system row × a moment): who hangs under whom,
 * from the core's `under`, and which markers are drawn by default — every root
 * of the cell, plus tiers 0–1 that are not plumbing: the handler and the parts
 * it calls, the action and the parts it calls. Everything deeper folds under
 * the part it belongs to and opens one level at a time; the spliced code view
 * still shows the whole subtree in order. A server built before tiers marks
 * only helpers: then, as before, only those fold.
 *
 * One more grouping on top of that: the **same node reached again inside the
 * same cell is one chip**, carrying how many more times the walk met it, with
 * the repeats folded under it. A cell then describes the parts that did the
 * work rather than listing one chip per visit — the numbers are untouched,
 * every repeat keeps its own step order, and the fold names how many there are.
 * @group Journey view
 * @business Groups a step's inner workings under it — the controller, then what it calls, then the details on demand.
 */
export function jrnCellTree(ms) {
  const here = new Set(ms.map((m) => m.stepOrder));
  // the business lens folds plumbing too: a part the code tags as plumbing (a
  // class-name joiner, a card frame) does not change what the journey does, and
  // its developer's sentence (*"dropping anything falsy"*) is not a business
  // reader's to meet on arrival (pass swarm 2026-09-25). It is one click away.
  const helper = jrnHelperTest();
  const kids = new Map();
  ms.forEach((m) => {
    if (m.under == null || !here.has(m.under)) return;
    if (!kids.has(m.under)) kids.set(m.under, []);
    kids.get(m.under).push(m);
  });
  const all = ms.filter((m) => m.under == null || !here.has(m.under) || (!helper(m) && (m.tier == null || m.tier <= 1)));
  // the first visit keeps the chip; the rest of that node's visits fold under it
  const firstOf = new Map(), agains = new Map(), top = [];
  all.forEach((m) => {
    const seen = firstOf.get(m.nodeId);
    if (seen == null) { firstOf.set(m.nodeId, m.stepOrder); top.push(m); return; }
    if (!agains.has(seen)) agains.set(seen, []);
    agains.get(seen).push(m);
  });
  // a repeat is still "drawn" — it hangs under its first visit, never a second
  // time inside somebody else's drill
  const drawn = new Set(all.map((m) => m.stepOrder));
  const drill = (o) => (kids.get(o) || []).filter((k) => !drawn.has(k.stepOrder));
  const again = (o) => agains.get(o) || [];
  return { top, drill, again };
}
/** Whether a marker folds as plumbing in the lens on screen: the core's `helper`, and in the business lens a part tagged `plumbing`.
 * @group Journey view */
function jrnHelperTest() {
  const biz = currentLens() === 'business';
  const tagged = (m) => {
    const n = ((S.JOURNEY && S.JOURNEY.steps[m.stepOrder]) || {}).node;
    return !!(n && (n.tags || []).includes('plumbing'));
  };
  return (m) => !!m.helper || (biz && m.kind === 'step' && tagged(m));
}
/** A marker with its repeats and then its drill folded beneath it: the seam card for a call, the chip for anything else.
 * @group Journey view */
function jrnMarkerTreeHtml(m, tree, parentFold) {
  return (m.kind === 'call' ? jrnSeamCardHtml(m) : jrnMarkerHtml(m)) + jrnCellFoldsHtml(m, tree, parentFold);
}
/** The two folds every drawn marker carries: the same part reached again, then what it called.
 * @group Journey view */
export function jrnCellFoldsHtml(m, tree, parentFold) {
  const rep = tree.again ? tree.again(m.stepOrder) : [];
  return (rep.length ? jrnFoldHtml(rep, tree, parentFold, rep.length === 1 ? 'journey.againOne' : 'journey.again') : '')
    + jrnFoldHtml(tree.drill(m.stepOrder), tree, parentFold);
}
/** Forget every fold before a layout is drawn (they register while it draws).
 * @group Journey view */
function jrnResetFolds() { S.JRN_FOLDS = []; S.JRN_FOLD_OF = {}; }
/**
 * The steps folded under a part: one `▸ n inside` chip (`▸ n helpers` when
 * all of them are plumbing) that opens them in place, each with its own fold
 * beneath — a drill-down one level at a time. Registered on S so j/k skips
 * what is folded away and opens it again when something inside is selected.
 * `word` names a fold that is not a drill-down — the repeats of one part —
 * so the button says which kind of hidden it is.
 * @group Journey view
 * @business Hides what a step did internally behind a count — open it to drill one level deeper.
 */
export function jrnFoldHtml(list, tree, parentFold, word) {
  if (!list || !list.length) return '';
  if (!S.JRN_FOLDS) jrnResetFolds();
  const id = 'jrn-fold-' + S.JRN_FOLDS.length;
  const f = { id, orders: list.map((m) => m.stepOrder), open: false, parent: parentFold || null };
  S.JRN_FOLDS.push(f);
  f.orders.forEach((o) => { S.JRN_FOLD_OF[o] = f; });
  const helper = jrnHelperTest();
  const key = word || (list.every(helper) ? (currentLens() === 'business' ? 'journey.biz.helpersFolded' : 'journey.helpersFolded') : 'journey.inside');
  // the button opens the fold; its number carries the tip (what is folded, and where)
  return '<button class="jrn-foldbtn" id="' + id + '-b" onclick="jrnToggleHelpers(\'' + id + '\')">'
    + '▸ ' + esc(jrnCountWord(key, list.length)).replace(String(list.length), () => jrnNumHtml(list.length, key, 'count.scope.node', { num: true, noFocus: true })) + '</button>'
    + '<span class="jrn-fold" id="' + id + '">' + list.map((m) => jrnMarkerTreeHtml(m, tree, id)).join('') + '</span>';
}
/** Open / close one fold and re-walk the j/k order around it.
 * @group Journey view */
function jrnToggleHelpers(id) {
  const el = document.getElementById(id), btn = document.getElementById(id + '-b'), f = (S.JRN_FOLDS || []).find((x) => x.id === id);
  if (!el) return;
  const open = !el.classList.contains('open');
  el.classList.toggle('open', open);
  if (btn) btn.classList.toggle('on', open);
  if (f) f.open = open;
  S.JRN_ORDERS = jrnOrdersNow();
}
/** Whether step order o is on screen: every fold above it is open.
 * @group Journey view */
function jrnUnfolded(o) {
  const byId = (id) => (S.JRN_FOLDS || []).find((x) => x.id === id);
  for (let f = (S.JRN_FOLD_OF || {})[o]; f; f = f.parent ? byId(f.parent) : null) if (!f.open) return false;
  return true;
}
/** The j/k walk: every marker the layout draws — step order on the timeline,
 * down a column then on to the next action in the sheet — minus what is still folded away.
 * @group Journey view */
function jrnOrdersNow() {
  if (S.JRN_STORY) return (S.JRN_STORY.orders || []).slice();
  const all = S.JRN_SHEET ? jrnSheetOrders() : S.JRN_DRILL ? jrnDrillOrders() : Object.keys(S.JRN_MARK || {}).map(Number).sort((a, b) => a - b);
  return all.filter(jrnUnfolded);
}
/**
 * Open the business lane's view that holds step i, when one does and the open
 * one does not — so a reader sent to a decision from the forks drawer lands
 * on a lane that draws it. Deliberately NOT wired into `jrnSelect`: selecting
 * a marker in the system band is not a jump to the lane, and flipping the
 * lane's view under a j/k walk would be the tool moving without being asked.
 * Redrawing one row leaves the band's markers, folds and selection untouched,
 * so a jump already in flight keeps its node.
 * @group Journey view
 */
function jrnRevealBizTab(i) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum || !document.querySelector('#jrn-tl .jrn-bizrow')) return;
  const sg = (sum.segments || []).find((x) => i >= x.from && i <= x.to);
  if (!sg) return;
  const d = jrnBizDecs(sg);
  const has = {
    gates: (sg.gates || []).some((g) => g.stepOrder === i),
    words: d.inWords.some((x) => x.order === i),
    decisions: d.shown.some((x) => x.order === i),
  };
  const at = jrnBizTab();
  if (has[at]) return;
  const open = JRN_BIZ_TABS.find((k) => has[k]);
  if (open) jrnSetBizTab(open);
}
/** Open whatever hides step i — every closed fold above it, or a folded sheet
 * cell — so a jump from a chip, a gate or the forks drawer lands on something visible.
 * @group Journey view */
function jrnRevealFold(i) {
  const el = document.querySelector('#jrn-tl [data-order="' + i + '"]');
  if (!el) return;
  for (let fold = el.closest('.jrn-fold'); fold; fold = fold.parentElement && fold.parentElement.closest('.jrn-fold')) {
    if (!fold.classList.contains('open')) jrnToggleHelpers(fold.id);
  }
  const cell = el.closest('.jrn-scell');
  if (cell && !cell.classList.contains('open')) {
    cell.classList.add('open');
    cell.querySelectorAll('.jrn-smore').forEach((b) => { b.style.display = 'none'; });
    S.JRN_ORDERS = jrnOrdersNow();
  }
}
/** A count cell's word for n: the catalog's singular where it pairs one
 * (`<key>One`), else the plural with {n} filled in. The pair exists because a
 * cell can hold exactly one thing and "1 things" is how a register loses a
 * reader's trust in the numbers beside it.
 * @group Journey view */
function jrnCountWord(key, n) {
  const one = key + 'One';
  if (n === 1 && S.STRINGS && S.STRINGS[one]) return t(one);
  return t(key).replace('{n}', n);
}
// ── typed counts (docs/COUNTS.md): the number, its words, its scope, its tip ──
/**
 * One of the journey's typed counts — `summary.counted[name]`, handed out by the
 * core with its words and its scope. A server built before the ledger carries
 * none: then the plain field it always had is dressed the same way, so the
 * header still prints a number and its tip still names what it counts.
 * @group Journey view
 */
function jrnC(sum, name) {
  const c = sum && sum.counted && sum.counted[name];
  if (c) return c;
  const cnt = (sum && sum.counts) || {};
  const old = {
    screens: [cnt.screens, 'journey.countScreens', 'journey.biz.countScreens'],
    actions: [cnt.called, 'journey.countActions', 'journey.biz.countActions'],
    gates: [cnt.gates, 'journey.countGates', 'journey.countGates'],
    checks: [cnt.checks, 'journey.countChecks', 'journey.countChecks'],
    decisions: [cnt.decisions, 'journey.countDecisions', 'journey.countDecisions'],
    steps: [cnt.steps, 'journey.countSteps', ''],
  }[name];
  if (!old || old[0] == null) return null;
  return { n: old[0], unit: old[1], bizUnit: old[2] || undefined, scope: 'journey.scopeAll', source: 'journeySummary().counts' };
}
/**
 * A typed count in the words of the lens on screen: its `bizUnit` in the
 * business lens — and nothing at all where it has none, because a count in a
 * developer's unit is not the business lens's to print — else its `unit`.
 * `unit` forces one key in every lens (the header's short form).
 * @group Journey view
 */
export function jrnCountedWords(c, unit) {
  if (!c) return '';
  const key = unit || (currentLens() === 'business' ? c.bizUnit : c.unit);
  if (!key) return '';
  return jrnCountWord(key, c.n).replace('{m}', c.of != null ? c.of : '');
}
/** A part of a breakdown in words, its number left to the column beside it.
 * @group Journey view */
function jrnPartWords(p) {
  const w = jrnCountWord(p.key, p.n).replace(String(p.n), '').replace(/\s{2,}/g, ' ').trim();
  return (p.label ? p.label + ' · ' : '') + w;
}
/**
 * The tip of a typed count: what it counts (the define of the words it is
 * printed with), the scope it counts over, where it came from — the answer and
 * the sync, and outside the business lens the core function that computed it —
 * then its breakdown as a table whose parts add up to it, then the numbers
 * printed *beside* it (never inside it), each under its own name.
 * @group Journey view
 */
function jrnCountedTip(el, a) {
  const c = a && a.c;
  if (!c) return '';
  const biz = currentLens() === 'business';
  const of = (biz && c.bizUnit) || c.unit;
  const src = tipSource(a.api || '/api/journey');
  if (!biz && c.source) src.note = c.source;
  const rows = (c.breakdown || []).map((p) => [jrnPartWords(p), p.n]);
  const rel = (a.rel || []).filter((r) => r && r.n).map((r) => {
    const w = jrnCountedWords(r);
    if (!w) return null;
    // every part, zeroes too: `80 e2e` travels with `0 seen in a run`
    const parts = (r.breakdown || []).map((p) => jrnCountWord(p.key, p.n)).join(' · ');
    return [w + (parts && (r.breakdown || []).length > 1 ? ' (' + parts + ')' : '')];
  }).filter(Boolean);
  return numberTip({ count: c.n, of, vars: { m: c.of != null ? c.of : '' }, scope: c.scope, source: src,
    breakdown: rows.length ? { rows } : null })
    + (a.list ? jrnUntrListTip(a.list, c.n) : '')
    + (rel.length ? tableTip({ caption: 'tip.journey.related', rows: rel }) : '');
}
registerTip('jrnCounted', jrnCountedTip);
/**
 * The conditions not in plain language, one row each — the list the sentence
 * says is behind it. `list` names the step ranges the count covered: `t` for the
 * technical conditions (the fold's `business.untranslated.items`), `g` for the
 * gate conditions nobody labelled (its guard-class decisions); `null` is none,
 * `true` is the whole journey. The business lens folds rows that share a place
 * and a kind into one with a count, never prints the condition (it is code), and
 * names the place in words somebody wrote — or says nobody did. Drawn only when
 * the rows add up to `n`, so the list can never disagree with the number.
 * @group Journey view
 */
function jrnUntrListTip(list, n) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const un = sum && sum.business && sum.business.untranslated;
  if (!un || !Array.isArray(un.items)) return '';
  const inR = (r, o) => r === true || (Array.isArray(r) && o >= r[0] && o <= r[1]);
  const biz = currentLens() === 'business';
  JRN_FORK_MARKS = null;
  const stepNode = (o) => ((S.JOURNEY.steps || [])[o] || {}).node || {};
  const where = (o, name) => {
    if (!biz) return name || '';
    return plainWords(jrnForkPartWords(o, stepNode(o))) || t('journey.biz.noWords');
  };
  const items = un.items.filter((u) => inR(list.t, u.stepOrder))
    .map((u) => ({ o: u.stepOrder, where: where(u.stepOrder, u.name), kind: (biz ? 'journey.biz.forkCat.' : 'journey.forkCat.') + (u.category || 'branch'), cond: u.requires || '' }))
    .concat((sum.business.decisions || []).filter((d) => d.class === 'guard' && inR(list.g, d.stepOrder))
      .map((d) => ({ o: d.stepOrder, where: where(d.stepOrder, (S.BYID[d.nodeId] && S.BYID[d.nodeId].name) || ''), kind: 'tip.untr.gate', cond: d.label || '' })))
    .sort((x, y) => x.o - y.o);
  if (!items.length || items.length !== n) return '';
  if (!biz) {
    return tableTip({ caption: 'tip.untr.caption', columns: ['tip.untr.col.where', 'tip.untr.col.kind', { label: 'tip.untr.col.cond', code: true }],
      rows: items.map((u) => [{ text: u.where, code: true }, u.kind, { text: u.cond, code: true }]) });
  }
  const groups = new Map();
  for (const u of items) {
    const k = u.where + '\u0000' + u.kind;
    const g = groups.get(k) || { where: u.where, kind: u.kind, n: 0 };
    g.n++; groups.set(k, g);
  }
  return tableTip({ caption: 'tip.untr.caption', columns: ['tip.untr.col.where', 'tip.untr.col.kind', { label: 'tip.untr.col.n', num: true }],
    rows: [...groups.values()].map((g) => [g.where, g.kind, g.n]) });
}
/**
 * A typed count drawn as words with its tip — the one way a journey prints a
 * number the core counted. `o.unit` forces the words, `o.rel` names the counts
 * printed beside it in the tip, `o.num` prints the number alone (inside a
 * sentence that already says what it is), `o.cls` adds a class.
 * @group Journey view
 */
export function jrnCountedHtml(c, o) {
  const opt = o || {};
  const words = opt.num ? String(c ? c.n : '') : jrnCountedWords(c, opt.unit);
  if (!c || !words) return '';
  return '<span class="jrn-num' + (opt.cls ? ' ' + opt.cls : '') + '"'
    + tipAttrs({ id: 'jrnCounted', args: { c, rel: opt.rel || undefined, api: opt.api || undefined, list: opt.list || undefined }, tipKey: opt.tipKey, noFocus: opt.noFocus })
    + '>' + esc(words) + '</span>';
}
/**
 * A number the viewer counts itself — the markers in one cell, the chips a fold
 * hides — with the standard tip: what it counts, over what, from which answer.
 * No core fold carries these; the scope says how far they reach.
 * @group Journey view
 */
function jrnNumHtml(n, key, scope, o) {
  const opt = o || {};
  return '<span class="jrn-num' + (opt.cls ? ' ' + opt.cls : '') + '"'
    + tipAttrs({ number: { count: n, of: key, scope, source: tipSource('/api/journey') }, noFocus: opt.noFocus })
    + '>' + esc(opt.num ? String(n) : jrnCountWord(key, n)) + '</span>';
}
/**
 * The journey header's `N screens` tip: the count, what it counts, over what,
 * from `/api/journey` at this sync, and the screens themselves in order with
 * whether each is built. Read from the journey on screen when the tip opens,
 * so a redraw or a register flip never leaves it describing another journey.
 * @group Journey view
 */
function jrnScreensTip() {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return '';
  const cnt = sum.counts || {};
  const user = sum.user || [];
  const count = cnt.screens != null ? cnt.screens : user.length;
  const built = (u) => (u.designStatus ? u.designStatus === 'both' : !!u.loc);
  const nBuilt = user.filter(built).length;
  const biz = currentLens() === 'business';
  // the split is built / not built — it adds up to the count; the screens
  // themselves follow as a list, which is not a breakdown and is not captioned as one
  return numberTip({
    count, of: biz ? 'journey.biz.countScreens' : 'journey.countScreens', scope: 'tip.screens.scope', source: tipSource('/api/journey'),
    breakdown: user.length === count ? { rows: [['journey.status.built', nBuilt], ['journey.status.notBuilt', count - nBuilt]] } : null,
  }) + (user.length ? tableTip({
    caption: 'tip.journey.screensList',
    columns: ['tip.screens.col.n', 'tip.screens.col.screen', 'tip.screens.col.status'],
    rows: user.map((u, i) => [String(i + 1), u.name || '', built(u) ? 'journey.status.built' : 'journey.status.notBuilt']),
  }) : '');
}
registerTip('jrnScreens', jrnScreensTip);
/** One system row's cell for one segment: a grid of that segment's moments, each holding
 * the markers this system contributed to that moment (a count in the business lens),
 * drawn as the drill tree — the parts on top, what they called folded under them.
 * @group Journey view */
function jrnSysCellHtml(sg, r) {
  // the business register does not count in steps — the word is a developer's
  // unit and RULE 5 cannot see this key, so the lens picks a `journey.biz.*`
  // sibling that the lint does guard. The number is the same number.
  const biz = currentLens() === 'business';
  const ck = r.kind === 'repo' ? (biz ? 'journey.biz.countSteps' : 'journey.countSteps')
    : r.kind === 'records' ? 'journey.countRecords' : r.kind === 'messages' ? 'journey.countMessages' : 'journey.countCalls';
  const cells = jrnRankOrder(sg).map((mo) => {
    const span = r.kind === 'repo' && r.side === 'ux' ? jrnCompSpanHtml(mo) : '';
    // the moment's component is drawn once, as the span header — never again as a marker beneath it
    const ms = sg.markers.filter((m) => m.system === r.key && m.moment === mo.index
      && !(span && mo.component && m.stepOrder === mo.component.stepOrder));
    // an empty cell says which kind of nothing it is: this row took no part in
    // this action, or the walk was cut before it could get there
    // — the core's word for this (action, row), the one every view prints
    if (!ms.length && !span) return '<div class="jrn-momcol" data-sys="' + esc(r.key) + '" data-mo="' + mo.index + '">' + jrnAbsentHtml(jrnAbsentWord(sg, mo, r.key)) + '</div>';
    const tree = jrnCellTree(ms);
    const drawn = tree.top.map((m) => jrnMarkerTreeHtml(m, tree, null)).join('');
    return '<div class="jrn-momcol">' + span
      + (ms.length ? '<span class="jrn-mks">' + drawn + '</span>'
        + jrnNumHtml(ms.length, ck, 'count.scope.action', { noFocus: true, cls: 'jrn-mkcount' }) : '')
      + '</div>';
  }).concat((sg.declaredOnly || []).map(() => '<div class="jrn-momcol">' + jrnAbsentHtml('notReached', t('journey.rail.declaredOnly')) + '</div>')).join('');
  return '<div class="jrn-cell jrn-syscell" data-seg="' + sg.index + '"><div class="jrn-mom" style="' + jrnMomStyle(sg.index) + '">' + cells + '</div></div>';
}
/**
 * Lane 3: one row per system the journey touches, in request order — the
 * screen asks, the API, the service does, records, messages, third party.
 * Each segment's cell is a grid of that screen's moments, so a column reads
 * down as one transaction and a row reads across as one system's part in the
 * screen. After every row sits its expansion slot — the contract / spliced
 * code of the selected marker opens there, under its system, never elsewhere.
 * @group Journey view
 * @business The systems involved — the app, each API, the records and messages — and what each does in every moment of a screen.
 */
function jrnSystemRowsHtml(sum, rowStyle) {
  let html = '<div class="jrn-row jrn-momrow" style="' + rowStyle + '">' + jrnLaneHtml('', '', 'jrn-momlane')
    + sum.segments.map(jrnMomHeadHtml).join('') + '</div>';
  sum.systems.forEach((r, ri) => {
    const lb = jrnRowLabel(r);
    html += '<div class="jrn-row jrn-sysrow k-' + esc(r.kind) + (r.side ? ' side-' + esc(r.side) : '') + (r.planned ? ' planned' : '') + '" style="' + rowStyle + '">'
      + jrnLaneHtml(lb.label, lb.sub, 'jrn-sysl')
      + sum.segments.map((sg) => jrnSysCellHtml(sg, r)).join('')
      + '</div><div class="jrn-exp" id="jrn-exp-' + ri + '" style="display:none"></div>';
  });
  const hasData = sum.systems.some((r) => r.kind === 'records' || r.kind === 'messages' || r.kind === 'external');
  if (!hasData && sum.counts.planned) html += '<div class="jrn-row jrn-footnote" style="' + rowStyle + '">' + jrnLaneHtml('', '', 'jrn-sysl') + '<div class="jrn-cell jrn-none" style="grid-column:2/-1">' + esc(t('journey.noRowsYet')) + '</div></div>';
  return html;
}
/** How many conditions of this action the core could not translate into a
 * business decision. The count is reported per segment, so it shows once, on
 * the action the segment starts with; a server that does not report it yet
 * shows nothing rather than a zero.
 * @group Journey view */
/** The step ranges an action's not-in-plain-language count covers: its own gate
 * conditions, and the screen's technical ones on its first action only — the
 * same split `jrnMomentUntranslated` counts by.
 * @group Journey view */
export function jrnActionUntrList(sg, mo) {
  return { t: mo.index === 0 ? [sg.from, sg.to] : null, g: [mo.from, mo.to] };
}
function jrnMomentUntranslated(sg, mo) {
  if (!sg.untranslated) return 0;
  return mo.index === 0 ? sg.untranslated : 0;
}
/** How many subtrees the walk did not follow inside this action (the markers'
 * own cut points). Absent on a server built before cut points — then nothing
 * is claimed either way.
 * @group Journey view */
function jrnMomentCut(sg, mo) {
  return sg.markers.reduce((a, m) => a + (m.moment === mo.index && m.cut ? m.cut : 0), 0);
}

// ── the system sheet (the journey-timeline design reference 04-system-sheet) ──
// One grid. COLUMNS are the journey's actions in order — every moment of every
// segment, flattened (a moment is a CALL GROUP: one client-side action and
// everything it caused). ROWS are the layers of the system in request order,
// derived from the same `summary.systems` the timeline uses, plus the two
// layers that are always asked about: gates & business, and what verifies it.
// A cell holds at most two chips and folds the rest; an empty cell says which
// kind of empty it is. Every chip is a step of the walk — clicking one opens
// the same expansion the timeline opens, as a full-width row under its layer.

const JRN_SHEET_COL = 214, JRN_SHEET_LANE = 178;

/** One layer row of the sheet for a system row of the summary — the repo rows
 * read as app / server parts, the API row by its spec title.
 * @group Journey view */
function jrnSheetSysLayer(r) {
  if (r.kind === 'api') return { key: r.key, kind: 'api', row: r, label: t('journey.layer.api'), sub: r.planned ? t('journey.rowPlanned') : r.label, cls: 'api' };
  if (r.kind === 'repo') {
    const ux = r.side === 'ux';
    return { key: r.key, kind: 'repo', side: r.side, row: r, label: t(ux ? 'journey.layer.app' : 'journey.layer.server'),
      sub: r.label + ' · ' + t('journey.rowSub.' + (ux ? 'ux' : 'server')), cls: ux ? 'app' : 'srv' };
  }
  const lb = jrnRowLabel(r);
  return { key: r.key, kind: r.kind, row: r, label: lb.label, sub: lb.sub, cls: r.kind === 'records' ? 'db' : r.kind === 'messages' ? 'msg' : 'ext' };
}
/**
 * The sheet's model: the columns (every moment of every segment in journey
 * order) and the layers (the summary's systems in request order, with *what
 * the user sees* on top, *gates & business* after the code layers and
 * *verified by* at the foot). Nothing is invented — a system the journey never
 * touches has no row, and the always-present rows say so in words.
 * @group Journey view
 */
export function jrnSheetModel(sum) {
  const cols = [];
  sum.segments.forEach((sg) => jrnRankOrder(sg).forEach((mo, i) => cols.push({ index: cols.length, sg, mo, first: i === 0 })));
  const rows = sum.systems || [];
  const layers = [{ key: 'user', kind: 'user', label: t('journey.layer.user'), sub: t('journey.layerSub.user'), cls: 'ui' }];
  rows.filter((r) => r.kind === 'repo' || r.kind === 'api').forEach((r) => layers.push(jrnSheetSysLayer(r)));
  layers.push({ key: 'gates', kind: 'gates', label: t('journey.layer.gates'), sub: t('journey.layerSub.gates'), cls: 'gate' });
  rows.filter((r) => r.kind !== 'repo' && r.kind !== 'api').forEach((r) => layers.push(jrnSheetSysLayer(r)));
  layers.push({ key: 'verified', kind: 'verified', label: t('journey.layer.verified'), sub: t('journey.layerSub.verified'), cls: 'test' });
  return { cols, layers };
}
/** The markers one cell of the sheet draws: this layer's markers inside this
 * action, with their drill tree — the parts on top, what they called folded under them.
 * @group Journey view */
function jrnSheetCellMarkers(layer, col) {
  const { sg, mo } = col;
  if (!layer.row) return { ms: [], tree: jrnCellTree([]) };
  const ms = sg.markers.filter((m) => m.system === layer.key && m.moment === mo.index
    // the moment's component is the user layer's span header — never drawn twice
    && !(layer.cls === 'app' && mo.component && m.stepOrder === mo.component.stepOrder));
  return { ms, tree: jrnCellTree(ms) };
}
/** The call that gives an action its outcomes — the moment's own call step,
 * else the first call marker inside it.
 * @group Journey view */
function jrnSheetMomentCall(sg, mo) {
  const calls = sg.markers.filter((m) => m.kind === 'call' && m.moment === mo.index);
  return (mo.callStep != null && calls.find((m) => m.stepOrder === mo.callStep)) || calls[0] || null;
}
/**
 * The absence word for one empty (action, layer) cell — the core's, never a
 * view's own. `journeySummary()` decides it once per fact (`segment.absent`,
 * core `journeyAbsence`) and every view that prints the cell — rows, ladder,
 * sheet, drill, storyboard — asks here, so the same cell cannot wear two words
 * (story swarm 2026-09-25, finding 4). `mo` null asks for the whole screen (the
 * ladder's folded columns); `key` is a system row key or `user`. A server that
 * predates the fold falls back to the rows view's old rule.
 * @group Journey view
 */
export function jrnAbsentWord(sg, mo, key) {
  const a = sg && sg.absent;
  if (a) {
    const w = mo ? (a.moments[mo.index] || {})[key] : (a.screen || {})[key];
    if (w) return w;
  }
  const cut = mo ? (sg.cutPoints || []).some((c) => c.moment === mo.index) : (sg.cutPoints || []).length > 0;
  return cut ? 'notReached' : 'notInvolved';
}
/** The absence word for a layer kind (records · messages · external · afterwards) in one action — the core's. `mo` null asks for the whole journey.
 * @group Journey view */
export function jrnAbsentKindWord(sg, mo, kind) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const all = sum && sum.absentKinds && sum.absentKinds[kind];
  if (all) return all;
  if (!mo) return 'notInvolved';
  const a = sg && sg.absent;
  if (a && a.kinds) return (a.kinds[mo.index] || {})[kind] || 'notInvolved';
  return jrnAbsentWord(sg, mo, '');
}
/** An absence word in the lens's register: the business sibling where the catalog has one.
 * @group Journey view */
export function jrnAbsentText(kind) {
  const biz = 'journey.biz.absent.' + kind;
  return currentLens() === 'business' && S.STRINGS && S.STRINGS[biz] ? t(biz) : t('journey.absent.' + kind);
}
/**
 * An empty cell in the words of the fact: *none indexed* (we looked and found
 * nothing), *not built* (declared somewhere, no code behind it), *not
 * involved* (this layer takes no part in this action) or *not reached* (the
 * walk was cut before it). Never a bare dash, and in the business register its
 * business sibling — the same word the ladder prints.
 * @group Journey view
 * @business Says which kind of nothing an empty cell is — nothing found, nothing built yet, or nothing to do here.
 */
export function jrnAbsentHtml(kind, why) {
  // six words, six meanings: the reason line is the key's own sub-sentence, its
  // definition, or — when the fold knows why — the fact behind this one cell
  const subKey = 'journey.absentSub.' + kind;
  const sub = S.STRINGS && S.STRINGS[subKey] ? t(subKey) : '';
  const reason = why || sub || def('journey.absent.' + kind) || '';
  return '<span class="jrn-mk none ' + kind + '" data-absent="' + kind + '" title="' + esc(reason) + '">'
    + sym(kind === 'notBuilt' ? 'warning' : 'absent') + esc(jrnAbsentText(kind)) + '</span>';
}
/** `req → res` for a call, from the contract's request body and its first 2xx
 * response — schema names as plain chips, no tree.
 * @group Journey view */
export function jrnSchemaChipHtml(m) {
  const n = (S.JOURNEY.steps[m.stepOrder] || {}).node || {};
  const c = n.contract || {};
  const req = (c.requestBody && c.requestBody.schema) || '';
  const res = (c.responses || []).filter((r) => /^2/.test(String(r.status))).map((r) => r.schema).filter(Boolean)[0] || '';
  if (!req && !res) return '';
  const text = req ? t('journey.schemaChip').replace('{req}', req).replace('{res}', res) : t('journey.schemaOut').replace('{res}', res);
  return '<span class="jrn-mk schema" onclick="jrnSelect(' + m.stepOrder + ')">' + esc(text.trim()) + '</span>';
}
/** One gate as a sheet chip — the checkpoint in words and how often this action met it.
 * @group Journey view */
function jrnSheetGateChipHtml(g) {
  return '<span class="jrn-mk gate"' + (S.BYID[g.id] ? gateAttrs(g.id, { step: g.stepOrder, config: g.config }) : ' onclick="jrnScrollTo(' + g.stepOrder + ')"') + ' title="' + esc(g.name || '') + '">'
    + sym(g.kind === 'rule' ? 'shield' : 'lock') + esc(jrnGateText(g)) + (g.count > 1 ? ' ×' + g.count : '')
    + (g.planned ? ' <i>' + esc(t('journey.plannedGate')) + '</i>' : '') + '</span>';
}
/** One translated decision as a sheet chip — a fork the flow can take in this action.
 * @group Journey view */
function jrnSheetDecChipHtml(d) {
  return '<span class="jrn-mk dec" onclick="jrnScrollTo(' + d.order + ')" title="' + esc(t('journey.decisionChip')) + '">'
    + sym('fork') + esc(d.label) + '</span>';
}
/**
 * The chips of one cell under the fold rule: two are shown, the rest hide
 * behind `+n more`; each chip carries its own drill (`▸ n inside`) beneath it.
 * Both open the cell in place — the grid is never redrawn, so nothing else moves.
 * @group Journey view
 */
function jrnSheetChipsHtml(chips, li, ci) {
  const rest = chips.slice(2);
  return chips.slice(0, 2).join('')
    + (rest.length ? '<span class="jrn-sx">' + rest.join('') + '</span>'
      + '<button class="jrn-smore" onclick="jrnSheetOpen(' + li + ',' + ci + ',\'open\',this)">' + esc(t('journey.moreChips')).replace('{n}', () => jrnNumHtml(rest.length, 'journey.moreChips', 'count.scope.action', { num: true, noFocus: true })) + '</button>' : '')
}
/** Open the rest of a cell's chips and re-walk the j/k order so the revealed steps join it.
 * @group Journey view */
function jrnSheetOpen(li, ci, what, btn) {
  const cell = document.querySelector('#jrn-tl .jrn-scell[data-layer="' + li + '"][data-col="' + ci + '"]');
  if (!cell) return;
  cell.classList.add(what);
  if (btn) btn.style.display = 'none';
  S.JRN_ORDERS = jrnOrdersNow();
}
// ── what proves it runs: one fold, one foot (B4.2, board 07) ─────
// Each chip's opening tag is written out in full: a class attribute assembled
// from pieces reads as prose to the string lint (RULE 1).
const JRN_FOOT_EV = '<span class="ev ';
const JRN_FOOT_NONE = '<span class="ev none" title="';
/**
 * The facts a foot prints for a list of coverage refs the core did not fold —
 * only a table, which no test touches directly and which is reached through
 * its accessors. Cases per level and coverage reports counted apart. No
 * evidence word and no verdict: the core decides both, and for a table it gave
 * only its cases by their own runs (`coverageViaRuns`), which the caller adds
 * (docs/COUNTS.md §4 — the viewer's own copy of the rule is gone, and so is its
 * fold of a weakest run: swarm 2026-10-05, finding 1).
 * @group Journey view
 */
function jrnTestFacts(refs) {
  const by = new Map();
  (refs || []).forEach((x) => { if (x && x.id && !by.has(x.id)) by.set(x.id, x); });
  const all = [...by.values()];
  const cases = all.filter((x) => !x.runLevel);
  return {
    e2e: cases.filter((x) => x.level === 'e2e').length,
    unit: cases.filter((x) => x.level === 'unit').length,
    integration: cases.filter((x) => x.level === 'integration').length,
    observed: cases.filter((x) => x.evidence === 'observed').length,
    runLevel: all.length - cases.length,
    total: cases.length,
    run: null,
    verdict: null,
  };
}
/**
 * The facts of one scope as the core folded them — the counts, the evidence
 * word and its class, the run that earned that word (`observation`) and the
 * covering tests' own last run (`run`) — read, never recomputed. A scope is a
 * journey, a screen, an action (`coverage.moments`) or one step.
 * @group Journey view
 */
export function jrnFoldFacts(cov) {
  if (!cov) return null;
  const k = cov.counted || {};
  const c = (cov.counts && cov.counts.tests) || {};
  const n = (x, fb) => (x ? x.n : (fb || 0));
  const e2e = n(k.e2e, c.e2e), unit = n(k.unit, c.unit), integration = n(k.integration, c.integration);
  return {
    e2e, unit, integration, observed: n(k.observed, c.observed), runLevel: n(k.runReports, c.runLevel),
    total: k.tests ? k.tests.n : e2e + unit + integration,
    evidenceWord: cov.evidenceWord || null, counted: cov.counted || null, observation: cov.observation || null,
    // the cell's one verdict (core `testVerdict`): the word, its own run's status, every case by its run
    verdict: cov.verdict || null,
    chip: cov.chip || 'none', run: cov.run || null, note: cov.note, freshness: cov.freshness || null,
    // a designed, not-built screen: no verdict, the cases that reach the route it will call (core `segmentCoverage`)
    notBuilt: !!(cov.notBuilt || (cov.verdict && cov.verdict.notBuilt)),
  };
}
/** The same facts as the server already folded them for a whole scope — read, never recomputed.
 * @group Journey view */
function jrnScopeTestFacts(cov) { return jrnFoldFacts(cov); }
/** One step's facts: the core's own fold for it, or — for a table, which no test touches directly — what reaches its accessors.
 * @group Journey view */
export function jrnStepTestFacts(i) {
  const s = (S.JOURNEY && S.JOURNEY.steps[i]) || {};
  if (s.coverage && s.coverage.evidenceWord) return jrnFoldFacts(s.coverage);
  const direct = (s.coverage && s.coverage.tests) || [];
  const f = jrnTestFacts(direct.length ? direct : (Array.isArray(s.coverageVia) ? s.coverageVia : []));
  // a table's accessors' cases by their own runs, counted in core
  if (!direct.length && s.coverageViaRuns) f.verdict = { runs: s.coverageViaRuns };
  return f;
}
/** One action's facts: the core's slim entry for it (`coverage.moments[i][k]`), or — on an older server — every test reaching a step inside it.
 * @group Journey view */
function jrnActionTestFacts(sg, mo) {
  const cov = S.JOURNEY.summary && S.JOURNEY.summary.coverage;
  const k = (sg.moments || []).indexOf(mo);
  const slim = cov && cov.moments && cov.moments[sg.index] && cov.moments[sg.index][k >= 0 ? k : mo.index];
  if (slim) return jrnFoldFacts(slim);
  const refs = [];
  for (let i = mo.from; i <= mo.to; i++) {
    const c = S.JOURNEY.steps[i] && S.JOURNEY.steps[i].coverage;
    if (c) refs.push(...(c.tests || []));
  }
  return jrnTestFacts(refs);
}
/** The action a step of the walk belongs to — the segment and moment whose range holds it.
 * @group Journey view */
function jrnStepAction(i) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const sg = sum && (sum.segments || []).find((x) => i >= x.from && i <= x.to);
  const mo = sg && (sg.moments || []).find((x) => i >= x.from && i <= x.to);
  return sg && mo ? { sg, mo } : null;
}
/**
 * The facts of the action one step belongs to — the wider scope a step's own
 * foot names beside its own, so *no test reaches this part* and the action's
 * *72 tests* read as two scopes and never as one contradiction (story swarm
 * 2026-09-25, finding 4).
 * @group Journey view
 */
export function jrnStepActionFacts(i) {
  const at = jrnStepAction(i);
  return at ? jrnActionTestFacts(at.sg, at.mo) : null;
}
/** The scope a foot's numbers count over, as a label in front of them — the `Counted`'s own scope, never a guess.
 * @group Journey view */
export function jrnFootScopeHtml(facts) {
  const scope = facts && facts.counted && facts.counted.tests && facts.counted.tests.scope;
  if (!scope) return '';
  return '<div class="line"><span class="hud-label jrn-tscope" data-scope="' + esc(scope) + '"' + tipAttrs({ key: scope }) + '>' + esc(t(scope)) + '</span></div>';
}
/**
 * The wider scope beside an empty narrow one: a step no test reaches, inside an
 * action some tests do — the action's number, with its own scope, and the
 * sentence that says the two are not the same claim.
 * @group Journey view
 */
function jrnFootWiderHtml(wider) {
  const k = wider && wider.counted && wider.counted.tests;
  if (!k || !k.n) return '';
  return '<div class="line jrn-twider" data-scope="' + esc(k.scope) + '"' + tipAttrs({ key: 'journey.tests.widerScope' }) + '>'
    + esc(t('journey.tests.widerScope')).replace('{n}', () => jrnCountedHtml(k, { noFocus: true })) + '</div>';
}
/**
 * The covering tests' own last runs as a line of its own: how many cases, as a
 * number whose tip breaks them down by what each one's run said (core
 * `testVerdict().runs`, a breakdown that sums), and the runner projects. It is
 * **never** a verdict: the cell's one verdict is the evidence word beside it,
 * and printing the weakest run here put *skipped* under *passed, by its own
 * declaration* for one skipped case among 145 (swarm 2026-10-05, finding 1).
 * @group Journey view */
export function jrnRunLineHtml(facts, chipped) {
  const runs = facts && facts.verdict && facts.verdict.runs;
  if (!runs || !runs.n) return '';
  const run = facts.run;
  // under a test chip the cases are already printed with their scope and their skips (round 2026-10-10): the line keeps
  // only where they ran, so no second bare number of the same cases stands under the chip
  if (chipped) {
    return run && run.projects && run.projects.length ? '<div class="line jrn-runs"><span class="rl rl-proj"' + tipAttrs({ key: 'journey.tests.runProjects' }) + '>'
      + esc(t('journey.tests.runProjects').replace('{list}', run.projects.join(', '))) + '</span></div>' : '';
  }
  return '<div class="line jrn-runs"><span class="hud-label"' + tipAttrs({ key: 'journey.tests.theirRuns' }) + '>' + esc(t('journey.tests.theirRuns')) + '</span>'
    + jrnCountedHtml(runs, { noFocus: true, cls: 'rl' })
    // its own sentence: beside the freshness it read as one ungrammatical phrase (round 2)
    + (run && run.projects && run.projects.length ? '<span class="rl rl-proj"' + tipAttrs({ key: 'journey.tests.runProjects' }) + '>' + esc(t('journey.tests.runProjects').replace('{list}', run.projects.join(', '))) + '</span>' : '')
    + '</div>';
}
/** The foot's *open the list* door, scoped — '' where the foot has no scope to keep.
 * @group Journey view */
function jrnCasesDoorHtml(scope) {
  if (!scope) return '';
  return '<div class="line jrn-cases"><a href="' + esc(jrnCasesHref(scope)) + '" title="' + esc(def('journey.tests.open') || '') + '">' + esc(t('journey.tests.open')) + '</a></div>';
}
/**
 * The door from a foot to the cases it counts, keeping the foot's scope: the
 * journey's screen (`seg`), one action in it (`seg` + `action`), or one step
 * (`node`). The Tests page opens on exactly those cases, with the same verdict
 * (swarm 2026-10-05: *open the list* landed on every case of every journey).
 * @group Journey view
 */
export function jrnCasesHref(scope) {
  const sc = scope || {};
  const flow = S.JOURNEY && S.JOURNEY.entry && S.JOURNEY.entry.id;
  if (sc.node) return '#/tests?node=' + encodeURIComponent(sc.node);
  if (!flow) return '#/tests';
  return '#/tests?flow=' + encodeURIComponent(flow)
    + (sc.seg != null ? '&seg=' + sc.seg + (sc.action != null ? '&action=' + sc.action : '') : '');
}
/**
 * The run behind an evidence word, in words: who observed it — test cases a
 * results report named, or coverage reports that name none — and when. Printed
 * beside the word, so *seen by a coverage run · stale* never stands above a
 * `0 observed` it does not explain (pass swarm 2026-09-25). A scope whose word
 * no run earned says *nothing observed*.
 * @group Journey view
 */
export function jrnObsText(facts) {
  const o = facts && facts.observation;
  if (!o) return facts && facts.evidenceWord && facts.evidenceWord.cls !== 'none' ? t('journey.obs.none') : '';
  return [jrnObsWho(o), (o.at || '').slice(0, 10)].filter(Boolean).join(' · ');
}
/** Who observed a run: the cases a results report named, and the coverage reports that name none.
 * @group Journey view */
function jrnObsWho(o) {
  // a declaration's cases are known to have passed; a case coverage placed is known to have run
  return [o.cases ? jrnCountWord(o.by === 'declaration' ? 'journey.obs.passed' : 'journey.obs.cases', o.cases) : '', o.reports ? jrnCountWord('journey.obs.reports', o.reports) : ''].filter(Boolean).join(' · ');
}
/**
 * The evidence chip's tip: the word and what it means, then the run behind it
 * — who observed it, when, what that run said, whether the code moved since —
 * and in the business lens the sentence the core wrote for it.
 * @group Journey view
 */
function jrnEvidenceTip(el, a) {
  const ev = (a && a.ev) || {};
  if (!ev.key) return '';
  const o = a.obs;
  const rows = o ? [
    ['tip.journey.obs.by', jrnObsWho(o)],
    ['tip.journey.obs.when', (o.at || '').slice(0, 10)],
    // the cell's verdict (core `testVerdict().status`): none when a coverage report alone earned the word
    ['tip.journey.obs.verdict', a.verdict ? (a.verdict.status ? 'tests.run.' + a.verdict.status : '') : o.by === 'runs' ? '' : 'tests.run.' + (o.status || 'unknown')],
    ['tip.journey.obs.since', o.freshness === 'changed' && o.changedBy === 'working-tree' ? 'tests.freshness.changedTree' : 'tests.freshness.' + (o.freshness || 'unknown')],
  ].filter((r) => r[1]) : [['tip.journey.obs.by', 'journey.obs.none']];
  const biz = currentLens() === 'business';
  return '<div class="tip-h">' + esc(t(ev.key)) + '</div>'
    + (def(ev.key) ? '<p class="tip-p">' + esc(def(ev.key)) + '</p>' : '')
    + (biz && ev.biz ? '<p class="tip-p">' + esc(t(ev.biz)) + '</p>' : '')
    + tableTip({ caption: 'tip.journey.obs.head', rows })
    // *stale* as a comparison: the sentence that names the run's side and the code's (core freshness.ts)
    + (freshShown(a.fresh) ? '<p class="tip-p jrn-fresh-tip">' + esc(freshSentence(a.fresh)) + '</p>' : '');
}
registerTip('jrnEvidence', jrnEvidenceTip);
/** The evidence chip: the core's word, its class for the shape, and its tip.
 * @group Journey view */
export function jrnEvChipHtml(facts) {
  const ev = evidenceWord(facts);
  const cls = ev.cls;
  if (cls === 'none') return '';
  return JRN_FOOT_EV + esc(cls) + '"' + tipAttrs({ id: 'jrnEvidence', args: { ev, obs: facts.observation || null, verdict: facts.verdict ? { status: facts.verdict.status } : null, fresh: facts.freshness || null } }) + '>'
    + (cls === 'observed' ? sym('live') : cls === 'stale' ? sym('stale') : cls === 'reached' ? sym('step') : '')
    + esc(t(ev.key)) + '</span>';
}
// written out whole: an attribute assembled from pieces reads as prose to the lint
const JRN_IMPDOOR = '<div class="line imp-door"><a href="#" onclick="return impactGo(this)" data-node="';
/**
 * The foot's door to impact (B4.6): from *what proves this runs* to *what else
 * uses this*, on the node the foot is about. Shown only once this server has
 * answered `/api/impact` at least once — the panel asks for the open step as
 * soon as it draws, so the door appears a moment after the first selection and
 * never at all on a build whose endpoint 404s. A door onto an error is worse
 * than no door.
 * @group Journey view
 * @business Opens what else uses this step.
 */
function jrnImpactDoorHtml(id) {
  if (!id || !S.impactHasEndpoint) return '';
  return JRN_IMPDOOR + esc(id) + '" title="' + esc(def('impact.door') || '') + '">' + esc(t('impact.door')) + '</a></div>';
}
/**
 * The tests foot: one evidence chip — the core's word, never the viewer's — with
 * the run that earned it printed beside it, the counts as its caption (cases per
 * level, every number with its tip), and the covering tests' own last run on a
 * line of its own, labelled as theirs. Never a percentage — the metric with its
 * bound lives on the Tests surface.
 *
 * The business register prints the same facts as two sentences: how many tests
 * reach this and how many of them end to end, then the sentence the core wrote
 * for the evidence (`evidenceWord.biz`) — so a coverage report alone reads *a
 * coverage run reached this code … it does not say which test did*, and never
 * *a run reached this code* above a Tests page that says no e2e run was seen.
 * @group Journey view
 * @business What proves this runs: how many tests reach it, and whether any of them has actually been run.
 */
export function jrnTestsFootHtml(facts, opts) {
  const o = opts || {};
  const business = currentLens() === 'business';
  if (!(S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.coverage)) {
    return '<div class="jrn-tfoot"><div class="line">' + JRN_FOOT_NONE + esc(t('journey.noTestsSub')) + '">'
      + sym('absent') + esc(t('journey.noTests')) + '</span></div></div>';
  }
  if (facts && facts.notBuilt) {
    // no code, no verdict: what the cases do reach, with that scope — never *passed* on a screen with no code
    return '<div class="jrn-tfoot"><div class="line">' + testChipHtml(facts) + '</div>' + jrnCasesDoorHtml(o.cases) + '</div>';
  }
  if (!facts || (!facts.total && !facts.runLevel)) {
    return '<div class="jrn-tfoot"><div class="line">' + JRN_FOOT_NONE + esc((facts && facts.note) || def('journey.absent.notReached') || '') + '">'
      + sym('absent') + esc(t(o.absent || 'journey.noTestReaches')) + '</span></div>' + jrnFootWiderHtml(o.wider) + jrnImpactDoorHtml(o.impact) + '</div>';
  }
  // one chip: the count, the scope it counts over, the cell's one word, and the skips beside it (round 2026-10-10)
  // — a table's accessors carry no typed count, so their foot keeps the plain evidence chip
  const chip = testChipHtml(facts) || jrnEvChipHtml(facts);
  const k = facts.counted || {};
  // a number the core typed carries its own tip; one it did not (a table's
  // accessors) prints as the plain number it is
  const num = (c, n) => (c ? jrnCountedHtml(c, { num: true, noFocus: true }) : esc(String(n)));
  if (business) {
    const ev = evidenceWord(facts);
    const runKey = ev.biz || (facts.chip === 'observed-stale' ? 'journey.biz.testsRun.stale' : 'journey.biz.testsRun.none');
    return '<div class="jrn-tfoot"><div class="line">' + chip + '</div>'
      + '<div class="line biz">' + esc(t(runKey)) + '</div>' + jrnCasesDoorHtml(o.cases) + jrnImpactDoorHtml(o.impact) + '</div>';
  }
  const obs = jrnObsText(facts);
  return '<div class="jrn-tfoot">'
    + '<div class="line">' + chip + (obs ? '<span class="obs">' + esc(obs) + '</span>' : '') + '</div>'
    + (chip.indexOf('data-tchip') >= 0 ? '' : jrnFootScopeHtml(facts)) + '<div class="line"><span class="cnt">'
    + esc(t('journey.tests.foot')).replace('{e2e}', () => num(k.e2e, facts.e2e)).replace('{unit}', () => num(k.unit, facts.unit))
      .replace('{int}', () => num(k.integration, facts.integration)).replace('{obs}', () => num(k.observed, facts.observed)) + '</span></div>'
    + jrnRunLineHtml(facts, chip.indexOf('data-tchip') >= 0)
    + jrnCasesDoorHtml(o.cases)
    + jrnImpactDoorHtml(o.impact) + '</div>';
}
/**
 * The *Verified by* cell of one action: the foot over the core's own fold for
 * that action (`coverage.moments`) — one chip for the class the action's own
 * tests carry, the run behind it, the counts as its caption. One chip per cell,
 * and it describes that cell (board 07, §4.4).
 * @group Journey view
 * @business Which tests prove this action — and when nothing does, it says so.
 */
function jrnSheetVerifiedHtml(sg, mo) {
  const cov = S.JOURNEY.summary && S.JOURNEY.summary.coverage;
  if (!cov) return '<span class="jrn-mk none" title="' + esc(t('journey.noTestsSub')) + '">' + sym('absent') + esc(t('journey.noTests')) + '</span>';
  const k = (sg.moments || []).indexOf(mo);
  return jrnTestsFootHtml(jrnActionTestFacts(sg, mo), { cases: { seg: sg.index, action: k >= 0 ? k : mo.index } });
}
/**
 * One cell: the layer's part in one action. The user layer draws the moment's
 * component (and the screen where a segment starts), the API layer the seam
 * card with its schemas, the gates layer the checkpoints and translated
 * decisions of that action, the code layers their step chips.
 * @group Journey view
 * @business What one layer of the system does during one action of the journey.
 */
function jrnSheetCellHtml(layer, li, col) {
  const { sg, mo } = col;
  const business = currentLens() === 'business';
  let inner = '';
  if (layer.kind === 'user') {
    // the screen itself is what the user sees when the action has no component of its own
    const scr = col.first || !mo.component ? jrnScreenNode(sg) : null;
    inner = (mo.component ? jrnCompSpanHtml(mo) : '')
      + (scr ? '<span class="jrn-mk ui" onclick="jrnSelectSegment(' + sg.index + ')">' + sym('screen') + esc((sg.screen && sg.screen.name) || scr.name || '') + '</span>' : '');
    if (!inner) inner = jrnAbsentHtml(jrnAbsentWord(sg, mo, 'user'));
  } else if (layer.kind === 'gates') {
    // one renderer for the checks, shared with the storyboard and the timeline's
    // lane: the gates as two headed lists in this register's words, the decisions
    // it shows, and what it could not word. The chip cloud this cell used to draw
    // named every checkpoint by its identifier in every register.
    inner = jrnChecksHtml(sg, mo);
  } else if (layer.kind === 'verified') {
    inner = jrnSheetVerifiedHtml(sg, mo);
  } else {
    const mk = jrnSheetCellMarkers(layer, col);
    // a part, then its repeats and what it called folded under it (the seam card keeps its schema chip first)
    const draw = (m) => (m.kind === 'call' ? jrnSeamCardHtml(m) + (business ? '' : jrnSchemaChipHtml(m)) : jrnMarkerHtml(m))
      + jrnCellFoldsHtml(m, mk.tree, null);
    inner = mk.tree.top.length
      ? jrnSheetChipsHtml(mk.tree.top.map(draw), li, col.index)
      : jrnAbsentHtml(jrnAbsentWord(sg, mo, layer.key));
  }
  return '<div class="jrn-scell ' + esc(layer.cls || '') + '" data-layer="' + li + '" data-col="' + col.index + '" data-sys="' + esc(layer.key) + '" data-seg="' + sg.index + '" data-mo="' + mo.index + '">' + inner + '</div>';
}
/**
 * One column head — the action stop: its ordinal, its name, a person glyph
 * when a screen made the call or a system glyph when nothing client-side did,
 * the contract statuses it can answer with (they come from the spec, so they
 * are tagged as such), ↺ when the walk already ran it.
 * @group Journey view
 * @business One action of the journey: what the person (or the system) does, and what the contract says can come back.
 */
function jrnSheetHeadHtml(col) {
  const mo = col.mo, sg = col.sg;
  const call = jrnSheetMomentCall(sg, mo);
  const n = call ? ((S.JOURNEY.steps[call.stepOrder] || {}).node || {}) : {};
  const outs = ((n.contract && n.contract.responses) || []).map((r) => {
    const cls = /^2/.test(String(r.status)) ? ' ok' : /^4/.test(String(r.status)) ? ' warn' : '';
    return '<span class="api-chip st' + cls + '" title="' + esc(t('journey.fromSpec') + ' · ' + (r.description || '')) + '">' + esc(String(r.status)) + '</span>';
  }).join('');
  const cut = jrnMomentCut(sg, mo);
  return '<div class="jrn-sbh' + (mo.repeat ? ' rep' : '') + '" data-col="' + col.index + '"'
    + ' onclick="jrnScrollTo(' + (mo.callStep != null ? mo.callStep : mo.actionStep) + ')" title="' + esc(mo.business || mo.label) + '">'
    + '<span class="t"><span class="ord">' + (col.index + 1) + '</span>' + sym(mo.component ? 'human' : 'automation') + esc(jrnMoLabel(mo)) + '</span>'
    + '<span class="out">' + outs
      + (mo.repeat ? '<span class="api-chip rep">' + esc(t('journey.repeated')) + '</span>' : '')
      + (cut ? '<span class="api-chip warn">' + esc(t('journey.countCut').replace('{n}', cut)) + '</span>' : '')
    + '</span></div>';
}
/** The screen a run of columns belongs to, spanning them — name, route,
 * design id and (outside the code lens) the thumbnail it was designed as.
 * @group Journey view */
function jrnSheetScreenHtml(sg, from, span) {
  const n = jrnScreenNode(sg);
  const name = (sg.screen && sg.screen.name) || (n && n.name) || t('journey.beforeFirstScreen');
  // the route is code: the business lens reads the screen's name alone
  const sub = n && n.name !== name && currentLens() !== 'business' ? n.name : '';
  return '<div class="jrn-sscr' + (sg.screen ? '' : ' entry') + '" style="grid-column:' + (from + 2) + ' / span ' + span + '" onclick="jrnSelectSegment(' + sg.index + ')">'
    + (n ? designThumbHtml(n, 'sheet') : '')
    + '<span class="tx"><span class="t">' + jrnDesignIdHtml(sg) + esc(name) + '</span>'
    + (sub ? '<span class="s">' + esc(sub) + '</span>' : '') + '</span></div>';
}
/** j/k order in the sheet: down a column, then on to the next action — the way
 * the sheet is read. Folded plumbing joins the walk when its fold is opened.
 * @group Journey view */
function jrnSheetOrders() {
  const sh = S.JRN_SHEET;
  if (!sh) return [];
  const out = [];
  sh.cols.forEach((col) => sh.layers.forEach((layer) => {
    jrnSheetCellMarkers(layer, col).ms.forEach((m) => out.push(m.stepOrder));
  }));
  return out;
}
/**
 * Index the sheet before it is drawn: the model on S (the cell functions and
 * j/k read it), every marker's layer row (so the expansion slot opens under
 * its own layer) and the j/k walk order.
 * @group Journey view
 */
function jrnSheetIndex(sum) {
  S.JRN_SHEET = jrnSheetModel(sum);
  const byKey = {};
  S.JRN_SHEET.layers.forEach((l, li) => { if (l.key) byKey[l.key] = li; });
  S.JRN_MARK = {};
  sum.segments.forEach((sg) => sg.markers.forEach((m) => {
    S.JRN_MARK[m.stepOrder] = { seg: sg.index, row: byKey[m.system] != null ? byKey[m.system] : 0 };
  }));
  S.JRN_ORDERS = jrnSheetOrders();
}
/**
 * The whole sheet: the screens spanning their actions, the action stops, then
 * one row per layer with its expansion slot beneath. It scrolls inside the
 * journey frame — the page itself never scrolls sideways.
 * @group Journey view
 * @business The whole journey on one sheet: every action across, every layer of the system down.
 */
function jrnSheetHtml(sum) {
  const sh = S.JRN_SHEET;
  const cols = sh.cols;
  const style = 'grid-template-columns:' + JRN_SHEET_LANE + 'px repeat(' + cols.length + ',minmax(' + JRN_SHEET_COL + 'px,1fr));'
    + 'min-width:' + (JRN_SHEET_LANE + cols.length * JRN_SHEET_COL) + 'px';
  let html = '<div class="jrn-sheet" style="' + style + '">';
  html += '<div class="jrn-slane scrlane"></div>';
  let at = 0;
  sum.segments.forEach((sg) => {
    const span = (sg.moments || []).length;
    if (!span) return;
    html += jrnSheetScreenHtml(sg, at, span);
    at += span;
  });
  // the corner names what a column is — a stop — and counts them with the core's
  // own number (`counted.actionStops`, the drill's `stop n of t`), so the columns
  // and the number above them are one count, not the header's actions
  const stops = sum.counted && sum.counted.actionStops;
  const cornerKey = currentLens() === 'business' ? 'journey.biz.sheetCorner' : 'journey.sheetCorner';
  html += '<div class="jrn-slane corner"><span class="hud-label"' + tipAttrs({ key: cornerKey, noFocus: true }) + '>' + esc(t(cornerKey)) + '</span>'
    + (stops && stops.n === cols.length ? '<span class="sub">' + jrnCountedHtml(stops, { num: false, noFocus: true }) + '</span>' : '') + '</div>'
    + cols.map(jrnSheetHeadHtml).join('');
  sh.layers.forEach((layer, li) => {
    html += '<div class="jrn-slane ' + esc(layer.cls || '') + '"><span class="hud-label">' + esc(layer.label) + '</span>'
      + (layer.sub ? '<span class="sub">' + esc(layer.sub) + '</span>' : '')
      // the checks lane carries the same control the timeline's lane carries, in
      // the same state: a reader who narrowed to the gates and pressed `v` is
      // still looking at the gates
      + (layer.kind === 'gates' ? jrnBizTabsHtml(sum) : '') + '</div>'
      + cols.map((col) => jrnSheetCellHtml(layer, li, col)).join('')
      + '<div class="jrn-exp jrn-sexp" id="jrn-exp-' + li + '" style="display:none"></div>';
  });
  return html + '</div>';
}


// ── the storyboard (02-design-changes §3 · the business register's default) ──
const JRN_STORY_SYS_GLYPH = { api: 'api', records: 'record', messages: 'message', external: 'external', afterwards: 'bolt' };

/**
 * The storyboard's selection — which screen is open and which of its actions.
 * Clamped to what this summary actually has, so a remembered selection from a
 * longer journey can never point at a screen that is not there.
 * @group Journey storyboard
 */
function jrnStoryAt(sum) {
  const sel = S.JRN_STORY || {};
  const si = Math.max(0, Math.min(sum.segments.length - 1, sel.seg != null ? sel.seg : 0));
  const sg = sum.segments[si];
  const order = jrnRankOrder(sg);
  const mo = order.find((x) => x.index === sel.mo) || order[0] || null;
  return { si, sg, mo, order };
}
/**
 * Open a screen and one of its actions, then redraw the storyboard in place —
 * the journey header, the lens and the code pane stay as they were.
 * @group Journey storyboard
 * @business Moves the storyboard to another screen or another thing the person does on it.
 */
export function jrnStoryGo(si, mi) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return;
  S.JRN_STORY = { seg: si, mo: mi != null ? mi : null, orders: [] };
  const at = jrnStoryAt(sum);
  S.JRN_STORY = { seg: at.si, mo: at.mo ? at.mo.index : null, orders: [] };
  jrnStoryRender(sum);
  jrnDockRender(S.journeyActive >= 0 && S.JRN_MARK[S.journeyActive] ? S.journeyActive : -1);
}
/** Enter / Space on a scene selects it — a scene holds its own zoomable thumbnail, so it is not a button element.
 * @group Journey storyboard */
export function jrnStoryKey(ev, si) {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  ev.preventDefault();
  jrnStoryGo(si);
}
/** Every action of every screen in reading order — what `[` and `]` walk.
 * @group Journey storyboard */
function jrnStoryFlat(sum) {
  const out = [];
  sum.segments.forEach((sg) => jrnRankOrder(sg).forEach((mo) => out.push({ si: sg.index, mi: mo.index })));
  return out;
}
/** Previous / next action (`[` / `]`), crossing into the next screen at the end of one.
 * @group Journey storyboard */
function jrnStoryStep(d) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return;
  const flat = jrnStoryFlat(sum);
  const at = jrnStoryAt(sum);
  const i = flat.findIndex((x) => x.si === at.si && at.mo && x.mi === at.mo.index);
  const next = flat[Math.max(0, Math.min(flat.length - 1, (i < 0 ? 0 : i) + d))];
  if (next) jrnStoryGo(next.si, next.mi);
}
/** The system rows a screen's own actions reached — the scene's solid glyphs.
 * @group Journey storyboard */
function jrnStoryReached(sg) {
  const set = new Set();
  (sg.markers || []).forEach((m) => set.add(m.system));
  return set;
}
/**
 * The systems a screen takes part in, as glyph chips: solid for the ones its
 * actions reached, dashed and dimmed with the absence word for the ones they
 * did not, and in the accent where this screen is the first to reach one.
 * Every chip carries its word, so the meaning never rests on colour alone.
 * @group Journey storyboard
 * @business Shows at a glance which parts of the system this screen involves — and which it leaves alone.
 */
function jrnStorySysHtml(sum, sg) {
  const here = jrnStoryReached(sg);
  return '<span class="jrn-sceneSys">' + (sum.systems || []).map((r) => {
    const on = here.has(r.key);
    const first = on && !sum.segments.some((x) => x.index < sg.index && jrnStoryReached(x).has(r.key));
    const label = r.kind === 'external' ? r.label : jrnRowLabel(r).label;
    const tip = on ? (first ? t('journey.scene.newHere') : jrnRowLabel(r).sub) : jrnAbsentText(jrnAbsentWord(sg, null, r.key));
    return '<span class="jrn-sysg' + (on ? (first ? ' on new' : ' on') : '') + '" title="' + esc(tip) + '">'
      + sym(r.kind === 'repo' ? (r.side === 'ux' ? 'screen' : 'step') : (JRN_STORY_SYS_GLYPH[r.kind] || 'step'))
      + esc(label) + '</span>';
  }).join('') + '</span>';
}
/**
 * One scene of the strip: the screen as it was designed — ordinal, thumbnail
 * (≤ 260 px, the lightbox on click), its design id, route and status word, the
 * first sentence of what the design says it is for, which of the journey's
 * actions happen on it, and the systems it involves. A segment with no screen
 * (the entry) says where the journey starts instead of inventing one.
 * @group Journey storyboard
 * @business One screen of the journey, as the design declares it and as the code has it.
 */
function jrnStorySceneHtml(sum, sg, sel) {
  const n = jrnScreenNode(sg);
  const found = jrnRankOrder(sg);
  const name = (sg.screen && sg.screen.name) || (n && (n.bizLabel || n.name)) || t('journey.beforeFirstScreen');
  const u = (sum.user || []).find((x) => sg.screen && x.id === sg.screen.id) || {};
  const business = currentLens() === 'business';
  const desc = jrnFirstSentence(jrnWords((sg.screen && sg.screen.business) || (n && (n.bizDescription || n.docs)) || u.business || ''));
  // the route and the design id are code and cross-references: the business lens reads the name
  const route = n && n.name && n.name !== name && !business ? n.name : '';
  const again = found.length > 0 && found.every((mo) => mo.repeat);
  // `actions 1–9` is a range of this screen's stops on the rail — its end is the
  // stops count, scoped *on this screen*, with the split in its tip
  const stops = sg.counted && sg.counted.actionStops;
  const acts = found.length
    ? esc(t(again ? 'journey.scene.again' : 'journey.scene.actions').replace('{from}', 1)).replace('{to}', () => (stops && stops.n === found.length
      ? jrnCountedHtml(stops, { num: true, noFocus: true })
      : jrnNumHtml(found.length, 'count.unit.actionStops', 'journey.scopeHere', { num: true, noFocus: true })))
    : esc(t('journey.absent.notInvolved'));
  const decl = (sg.declaredOnly || []).length;
  return '<div class="jrn-scene' + (sel ? ' on' : '') + (sg.screen ? '' : ' entry') + '" role="button" tabindex="0"'
    + ' aria-pressed="' + (sel ? 'true' : 'false') + '" onclick="jrnStoryGo(' + sg.index + ')" onkeydown="jrnStoryKey(event,' + sg.index + ')">'
    + '<span class="jrn-scene-h"><span class="ord">' + (sg.index + 1) + '</span>'
    + jrnDesignIdHtml(sg)
    + '<span class="t">' + esc(name) + '</span></span>'
    + (n ? designThumbHtml(n, 'story') : '')
    + (route ? '<span class="jrn-scene-r">' + esc(route) + '</span>' : '')
    + (n && n.design ? '<span class="dsg-chips">' + designChipHtml(business ? Object.assign({}, n.design, { id: '' }) : n.design) + '</span>' : '')
    + (desc ? '<span class="jrn-scene-d">' + esc(desc) + '</span>' : '')
    + storyChipsHtml(screenStoryIds(n, u.components))
    + '<span class="jrn-scene-a">' + acts + (decl ? ' · ' + jrnNumHtml(decl, 'journey.countDeclaredOnly', 'journey.scopeHere', { noFocus: true }) : '') + '</span>'
    + jrnSceneTestsHtml(sum, sg)
    + jrnStorySysHtml(sum, sg) + '</div>';
}
/**
 * A scene's tests line (round 2026-10-10): the screen's cases *over this screen*,
 * its one word and its skips — or, for a designed, not-built screen, why it has
 * no verdict — so the per-screen numbers read as screens beside the header's
 * distinct journey total, never as parts of it.
 * @group Journey storyboard
 */
function jrnSceneTestsHtml(sum, sg) {
  const cov = sum && sum.coverage && sum.coverage.segments && sum.coverage.segments[sg.index];
  if (!cov || !sg.screen) return '';
  const chip = testChipHtml(jrnFoldFacts(cov));
  return '<span class="jrn-scene-t jrn-cfoot" onclick="event.stopPropagation()">' + (chip || '<span class="jrn-mk none"' + defAttrs('journey.tests.noneScreen') + '>'
    + sym('absent') + esc(t('journey.tests.noneScreen')) + '</span>') + '</span>';
}
/**
 * The linked journeys as chips: what has to happen first (◀ requires), where
 * this one leads (leads to ▶) and the longer flows it is part of, each saying
 * how much of it is built and whether the link was declared or derived.
 * @group Journey storyboard
 * @business The journeys either side of this one — what comes before it, and what it leads to.
 */
function jrnStoryLinksHtml(sum) {
  const ls = sum.links || {};
  const row = (list, word, mark) => (list || []).map((l) => '<span class="jrn-chip go" onclick="openJourney(' + jsArg(l.id) + ')"'
    + ' title="' + esc(t('journey.linkHow.' + (l.how || 'declared'))) + '">' + sym('interchange')
    + esc(mark === 'l' ? '◀ ' + word + ' · ' + l.name : word + ' · ' + l.name + ' ▶')
    + (l.screens != null ? '<i>' + esc(t('journey.countBuilt').replace('{n}', l.built || 0).replace('{m}', l.screens)) + '</i>' : '') + '</span>').join('');
  const html = row(ls.requires, t('journey.requires'), 'l') + row(ls.leadsTo, t('journey.leadsTo'), 'r') + jrnPartOfHtml(sum);
  if (!html) return '';
  return '<div class="jrn-story-links"><span class="hud-label">' + esc(t('journey.linked')) + '</span>' + html + '</div>';
}
/**
 * The action rail of the open screen: every action its code made, in the order
 * the design lists the screen's operations, then the stops the design declares
 * that no call in the code made (dotted, worded) — the whole promise, not just
 * what runs. `[` and `]` walk it and cross into the next screen.
 * @group Journey storyboard
 * @business Everything a person can do on this screen, including what the design asks for and the code has not built.
 */
function jrnStoryRailHtml(sum, at) {
  const { sg, order, mo } = at;
  const stops = order.map((x, i) => '<button class="jrn-rstop' + (mo && x.index === mo.index ? ' on' : '') + (x.repeat ? ' rep' : '')
    + '" aria-pressed="' + (mo && x.index === mo.index ? 'true' : 'false') + '" onclick="jrnStoryGo(' + sg.index + ',' + x.index + ')"'
    + ' title="' + esc((x.business || x.label) + (x.declared === false ? ' · ' + t('journey.rail.unlisted') : '') + (x.repeat ? ' · ' + t('journey.repeated') : '')) + '">'
    + '<span class="o">' + (i + 1) + '</span><span class="n">' + esc(jrnMoLabel(x)) + '</span>'
    + (x.repeat ? '<span class="rep">↺</span>' : '') + (x.declared === false ? '<span class="uns">·</span>' : '') + '</button>').join('');
  const declared = (sg.declaredOnly || []).map((d) => '<span class="jrn-rstop declonly" title="' + esc(t('journey.rail.declaredOnly')) + '">'
    + '<span class="o">·</span><span class="n">' + esc(jrnDeclLabel(d)) + '</span></span>').join('');
  const name = (sg.screen && sg.screen.name) || t('journey.beforeFirstScreen');
  const prev = sg.index > 0, next = sg.index < sum.segments.length - 1;
  return '<div class="jrn-story-rail" role="tablist" aria-label="' + esc(t('journey.story.screens')) + '">'
    + '<div class="jrn-rail-h"><span class="hud-label">'
    + esc(t('journey.rail.screenOf').replace('{n}', sg.index + 1).replace('{name}', name)).replace('{t}', () => jrnNumHtml(sum.segments.length, 'journey.countScreens', 'journey.scopeAll', { num: true, noFocus: true })) + '</span>'
    + '<span class="jrn-rail-nav">'
    + (prev ? '<button class="jrn-viewbtn" onclick="jrnStoryGo(' + (sg.index - 1) + ')">◀ ' + esc(t('journey.rail.prevScreen')) + '</button>' : '')
    + (next ? '<button class="jrn-viewbtn" onclick="jrnStoryGo(' + (sg.index + 1) + ')">' + esc(t('journey.rail.nextScreen')) + ' ▶</button>' : '')
    + '</span></div>'
    + '<div class="jrn-stops">' + (stops || declared ? stops + declared : esc(t('journey.absent.notInvolved'))) + '</div></div>';
}
/**
 * One box of the ledger: what kind of thing it is, its name, the sentences
 * whoever wrote it left behind, and ⧉ into the editor. Clicking it opens its
 * code or contract in the pane. `×n` says how often this one action did it.
 * @group Journey storyboard
 */
function jrnStoryBoxHtml(o) {
  const loc = o.loc ? '<span class="loc">' + esc(o.loc.path + ':' + o.loc.line) + vsl(o.repo, o.loc.path, o.loc.line) + '</span>' : '';
  return '<div class="jrn-bx ' + esc(o.cls || '') + '"' + (o.order != null ? ' data-order="' + o.order + '" tabindex="0" onclick="jrnSelect(' + o.order + ')"' : '')
    + ' title="' + esc(o.title || '') + '">'
    + '<span class="k">' + sym(o.glyph) + esc(o.kind || '') + (o.count > 1 ? '<span class="rep">×' + o.count + '</span>' : '') + '</span>'
    + '<span class="n">' + esc(o.name || '') + loc + '</span>'
    + (o.lines || []).filter(Boolean).map((l) => '<span class="b">' + esc(l) + '</span>').join('')
    + '</div>';
}
/**
 * *What the user sees*: the part of the screen the action runs in, the action
 * in the design's own words, what the contract says comes back, and — at the
 * end of a screen — the screen that follows. The answer is the spec's, so it
 * is labelled as the spec's: no payload was captured.
 * @group Journey storyboard
 * @business What the person does here, and what the screen shows them back.
 */
function jrnStorySeesHtml(sum, sg, mo) {
  const business = currentLens() === 'business';
  const scr = (sg.screen && sg.screen.name) || t('journey.beforeFirstScreen');
  let html = '';
  if (mo.component) {
    const cn = (S.JOURNEY.steps[mo.component.stepOrder] || {}).node || {};
    html += jrnStoryBoxHtml({ order: mo.component.stepOrder, cls: 'ui', glyph: 'screen',
      kind: (cn.kind || t('journey.kind.screen')) + (mo.component.stepOrder < mo.from ? ' · ' + t('journey.stillOpen') : ''),
      name: business ? mo.component.label : mo.component.name,
      lines: [t('journey.sees.does').replace('{action}', jrnWords(mo.business) || jrnMoLabel(mo)).replace('{screen}', scr)],
      loc: cn.loc, repo: cn.repo, title: mo.component.name });
  } else if (sg.screen) {
    // no component of its own: the screen itself is what the user sees — the sheet draws it the same way
    const sn = jrnScreenNode(sg) || {};
    html += jrnStoryBoxHtml({ order: sg.from, cls: 'ui', glyph: 'screen', kind: t('journey.kind.screen'), name: sg.screen.name,
      lines: [t('journey.sees.does').replace('{action}', jrnWords(mo.business) || jrnMoLabel(mo)).replace('{screen}', scr)],
      loc: business ? null : sn.loc, repo: sn.repo, title: sg.screen.name });
  } else html += jrnAbsentHtml(jrnAbsentWord(sg, mo, 'user'));
  const call = jrnSheetMomentCall(sg, mo);
  const n = call ? ((S.JOURNEY.steps[call.stepOrder] || {}).node || {}) : {};
  const ok = (((n.contract || {}).responses) || []).filter((r) => /^2/.test(String(r.status)))[0];
  if (ok) {
    html += jrnStoryBoxHtml({ order: call.stepOrder, cls: 'ans', glyph: 'api', kind: t('journey.sees.answers'),
      name: business ? (plainWords(ok.description) || t('journey.biz.drill.answer')) : (ok.description || String(ok.status)),
      lines: [business ? '' : String(ok.status) + ' · ' + t('journey.fromSpec'), business ? '' : t('journey.insp.specNote')],
      title: t('journey.fromSpec') });
  }
  const order = jrnRankOrder(sg);
  const lastHere = order.length && order[order.length - 1].index === mo.index;
  const nxt = lastHere ? sum.segments[sg.index + 1] : null;
  if (nxt && nxt.screen) {
    html += '<div class="jrn-note go" onclick="jrnStoryGo(' + nxt.index + ')">' + sym('interchange')
      + esc(t('journey.sees.thenShows').replace('{screen}', nxt.screen.name)) + '</div>';
  }
  return html;
}
/**
 * *The checks*: the gates this action met, once each with `×n` when it met one
 * several times, then the decisions someone put in words. Checks in the code
 * that nobody labelled are counted in one sentence, never drawn as a decision.
 * @group Journey storyboard
 * @business What has to be true for this to go through, and where it can go differently.
 */
function jrnStoryChecksHtml(sg, mo) {
  return jrnChecksHtml(sg, mo);
}
/**
 * *What is recorded*: one box per table this action read or wrote, with the
 * part of the code that touched it named beside the verb. Walked edges only —
 * a table the start-up writes is not a table this action writes.
 * @group Journey storyboard
 * @business Which records this action creates, changes or reads.
 */
function jrnStoryRecordsHtml(sg, mo) {
  const ms = sg.markers.filter((m) => m.kind === 'record' && m.moment === mo.index);
  if (!ms.length) return jrnAbsentHtml(jrnAbsentKindWord(sg, mo, 'records'));
  const business = currentLens() === 'business';
  const by = new Map();
  ms.forEach((m) => { if (!by.has(m.name)) by.set(m.name, []); by.get(m.name).push(m); });
  return [...by.values()].map((list) => {
    const lines = [];
    list.forEach((m) => {
      const p = (S.JOURNEY.steps[m.under] || {}).node;
      if (!p) return;
      // business names the accessor the way a person would say it: its authored
      // label, else its own method name humanized — never the whole class path
      const acc = business ? (p.bizLabel || humanize(String(p.name || '').split('.').pop())) : p.name;
      const line = t('journey.record.by').replace('{op}', t('journey.via.' + (m.op || 'writes'))).replace('{accessor}', acc);
      if (lines.indexOf(line) < 0) lines.push(line);
    });
    const n0 = (S.JOURNEY.steps[list[0].stepOrder] || {}).node || {};
    return jrnStoryBoxHtml({ order: list[0].stepOrder, cls: 'db', glyph: 'record', kind: t('journey.kind.record'),
      name: jrnMarkerText(list[0]), count: list.length, loc: n0.loc, repo: n0.repo, title: list[0].name,
      lines: lines.slice(0, 3).concat(lines.length > 3 ? [t('journey.moreChips').replace('{n}', lines.length - 3)] : []) });
  }).join('');
}
/** The external systems one action reached, split by what they are for: the
 * messaging ones (email, queues) belong on the Messages row, the rest are third parties.
 * @group Journey storyboard */
function jrnStoryExternals(sum, sg, mo, messaging) {
  const rows = {};
  (sum.systems || []).forEach((r) => { rows[r.key] = r; });
  const ms = sg.markers.filter((m) => m.kind === 'external' && m.moment === mo.index
    && (['email', 'queue'].indexOf(jrnStoryExtKind(rows[m.system], m)) >= 0) === !!messaging);
  const by = new Map();
  ms.forEach((m) => { if (!by.has(m.name)) by.set(m.name, []); by.get(m.name).push(m); });
  return [...by.values()].map((list) => {
    const m = list[0];
    const n = (S.JOURNEY.steps[m.stepOrder] || {}).node || {};
    const ext = n.external || (S.BYID[m.nodeId] || {}).external || {};
    const kind = jrnStoryExtKind(rows[m.system], m);
    return jrnStoryBoxHtml({ order: m.stepOrder, cls: 'ext', glyph: 'external',
      kind: kind ? t('journey.external.kind.' + kind) : t('journey.kind.external'),
      name: jrnMarkerText(m), count: list.length, title: m.name,
      // the client it went through is code — a class name — and the business lens reads what it is for
      lines: [ext.via && currentLens() !== 'business' ? t('journey.external.via').replace('{via}', ext.via) : '', jrnFirstSentence(jrnWords(n.bizDescription || m.business || ''))] });
  });
}
/** The kind of external a marker reached — the system row's own, else the node's.
 * @group Journey storyboard */
function jrnStoryExtKind(row, m) {
  if (row && row.externalKind) return row.externalKind;
  const n = (S.JOURNEY.steps[m.stepOrder] || {}).node || {};
  const ext = n.external || (S.BYID[m.nodeId] || {}).external || {};
  return ext.kind || '';
}
/**
 * *Messages*: what this action sent that nobody waits for — a queue it
 * published to, a mail service it handed a message to.
 * @group Journey storyboard
 * @business What this action sends out: an email, or a job for something else to pick up.
 */
function jrnStoryMessagesHtml(sum, sg, mo) {
  const ms = sg.markers.filter((m) => m.kind === 'message' && m.moment === mo.index).map((m) => {
    const n = (S.JOURNEY.steps[m.stepOrder] || {}).node || {};
    return jrnStoryBoxHtml({ order: m.stepOrder, cls: 'msg', glyph: 'message', kind: t('journey.kind.message'),
      name: jrnMarkerText(m), loc: n.loc, repo: n.repo, title: m.name, lines: [jrnFirstSentence(n.bizDescription || m.business || '')] });
  }).concat(jrnStoryExternals(sum, sg, mo, true));
  return ms.length ? ms.join('') : jrnAbsentHtml(jrnAbsentKindWord(sg, mo, 'messages'));
}
/**
 * *Third party*: the systems outside this code that the action called, by what
 * they are for and the client it went through.
 * @group Journey storyboard
 * @business Who outside this product this action talks to.
 */
function jrnStoryExternalHtml(sum, sg, mo) {
  const boxes = jrnStoryExternals(sum, sg, mo, false);
  const word = jrnAbsentKindWord(sg, mo, 'external');
  return boxes.length ? boxes.join('') : jrnAbsentHtml(word, word === 'noneIndexed' ? t('journey.absentWhy.noExternal') : '');
}
/**
 * *Afterwards*: the work this action armed and did not wait for — a hook, a
 * worker, a callback something else runs. Registered here, run elsewhere.
 * @group Journey storyboard
 * @business What happens later, on its own, because of this action.
 */
function jrnStoryAfterwardsHtml(sg, mo) {
  const list = mo.afterwards || [];
  if (!list.length) return jrnAbsentHtml(jrnAbsentKindWord(sg, mo, 'afterwards'));
  const business = currentLens() === 'business';
  const by = new Map();
  list.forEach((a) => { if (!by.has(a.nodeId)) by.set(a.nodeId, []); by.get(a.nodeId).push(a); });
  return [...by.values()].map((group) => {
    const a = group[0];
    const n = (S.JOURNEY.steps[a.stepOrder] || {}).node || S.BYID[a.nodeId] || {};
    return jrnStoryBoxHtml({ order: a.stepOrder, cls: 'aft', glyph: 'bolt', kind: t('journey.kind.deferred'),
      name: business ? jrnLabel(n) || a.name : (n.name || a.name), count: group.length, loc: n.loc, repo: n.repo, title: a.nodeId,
      lines: [jrnFirstSentence(n.bizDescription || n.docs || '')] });
  }).join('');
}
/** One ledger row: its lane (the words and what belongs in it) and its boxes.
 * @group Journey storyboard */
function jrnStoryRowHtml(cls, label, sub, body, extra) {
  return '<div class="jrn-lrow"><div class="jrn-llane ' + esc(cls) + '"><span class="hud-label">' + esc(label) + '</span>'
    + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + (extra || '') + '</div>'
    + '<div class="jrn-lcell">' + body + '</div></div>';
}
/**
 * The ledger of one action, read top to bottom in request order: what the user
 * sees, what is checked, what is recorded, what is sent, who else is called,
 * what runs afterwards, and what proves any of it runs. A row with nothing in
 * it says which kind of nothing that is.
 * @group Journey storyboard
 * @business One thing the person does, and everything the system does because of it.
 */
function jrnStoryLedgerHtml(sum, at) {
  const { sg, mo, order } = at;
  if (!mo) return '<div class="jrn-story-ledger"><p class="set-note">' + esc(t('journey.absent.notInvolved')) + '</p></div>';
  const i = order.findIndex((x) => x.index === mo.index);
  const call = jrnSheetMomentCall(sg, mo);
  const cut = jrnMomentCut(sg, mo);
  return '<div class="jrn-story-ledger">'
    + '<div class="jrn-ledger-h"><span class="hud-label">'
    + esc(t('journey.ledger.actionOf').replace('{n}', (i < 0 ? 0 : i) + 1).replace('{name}', jrnMoLabel(mo))).replace('{t}', () => (sg.counted && sg.counted.actionStops && sg.counted.actionStops.n === order.length
      ? jrnCountedHtml(sg.counted.actionStops, { num: true, noFocus: true })
      : jrnNumHtml(order.length, 'count.unit.actionStops', 'journey.scopeHere', { num: true, noFocus: true }))) + '</span>'
    + (mo.repeat ? '<span class="api-chip rep">' + esc(t('journey.repeated')) + '</span>' : '')
    + (cut && currentLens() !== 'business' ? '<span class="api-chip warn">' + jrnNumHtml(cut, 'journey.countCut', 'count.scope.action', { noFocus: true }) + '</span>' : '')
    + (call ? jrnSeamCardHtml(call) : '') + '</div>'
    + jrnStoryRowHtml('ui', t('journey.layer.user'), t('journey.layerSub.user'), jrnStorySeesHtml(sum, sg, mo))
    + jrnStoryRowHtml('gate', t('journey.ledger.checks'), t('journey.ledgerSub.checks'), jrnStoryChecksHtml(sg, mo), jrnBizTabsHtml(sum))
    + jrnStoryRowHtml('db', t('journey.ledger.recorded'), t('journey.ledgerSub.recorded'), jrnStoryRecordsHtml(sg, mo))
    + jrnStoryRowHtml('msg', t('journey.row.messages'), t('journey.ledgerSub.messages'), jrnStoryMessagesHtml(sum, sg, mo))
    + jrnStoryRowHtml('ext', t('journey.row.external'), t('journey.ledgerSub.external'), jrnStoryExternalHtml(sum, sg, mo))
    + jrnStoryRowHtml('aft', t('journey.row.afterwards'), t('journey.rowSub.afterwards'), jrnStoryAfterwardsHtml(sg, mo))
    + jrnStoryRowHtml('test', t('journey.layer.verified'), t('journey.layerSub.verified'), jrnSheetVerifiedHtml(sg, mo))
    + '<div class="jrn-exp" id="jrn-exp-0" style="display:none"></div></div>';
}
/**
 * The whole storyboard: the flow in its own words with its documents, the
 * journeys either side of it, every screen in order, the actions of the open
 * screen, and the ledger of the open action. It scrolls down, never sideways.
 * @group Journey storyboard
 * @business The journey as a person walks it: screen by screen, action by action, in words.
 */
function jrnStoryboardHtml(sum) {
  const at = jrnStoryAt(sum);
  const repo = (sum.entry && sum.entry.repo) || (S.JOURNEY.entry && S.JOURNEY.entry.repo);
  const docs = (sum.business.docs || []).map((l) => (l && l.url ? linkHtml(l.url) : jrnDocLinkHtml(repo, l))).filter(Boolean);
  const desc = sum.business.description || '';
  return '<div class="jrn-story">'
    + (desc || docs.length ? '<div class="jrn-story-intro">'
      + (desc && proseHtml(desc) ? '<p class="jrn-story-blurb">' + proseHtml(desc) + '</p>' : '')
      + '<div class="jrn-story-src"><span class="hud-label">' + esc(t('journey.story.ownWords')) + '</span>'
      + (docs.length ? '<span class="dsg-docs">' + docs.join('') + '</span>' : '') + '</div></div>' : '')
    + jrnStoryLinksHtml(sum)
    + '<div class="jrn-story-strip"><span class="hud-label">' + esc(t('journey.story.screens')) + '</span>'
    + '<div class="jrn-scenes">' + sum.segments.map((sg) => jrnStorySceneHtml(sum, sg, sg.index === at.si)).join('') + '</div></div>'
    + jrnStoryRailHtml(sum, at)
    + jrnStoryLedgerHtml(sum, at)
    + '</div>';
}
/**
 * Draw (or redraw) the storyboard into the journey frame and index it: every
 * marker addressable by step so a chip, a gate or a jump still lands, and the
 * j/k walk set to the boxes this ledger actually drew.
 * @group Journey storyboard
 */
function jrnStoryRender(sum) {
  const tl = document.getElementById('jrn-tl');
  if (!tl) return;
  const at = jrnStoryAt(sum);
  S.JRN_STORY = { seg: at.si, mo: at.mo ? at.mo.index : null, orders: [] };
  S.JRN_MARK = {};
  sum.segments.forEach((sg) => sg.markers.forEach((m) => { S.JRN_MARK[m.stepOrder] = { seg: sg.index, row: 0 }; }));
  tl.innerHTML = jrnStoryboardHtml(sum);
  // the j/k walk is what this ledger drew, read in the order it was drawn
  S.JRN_STORY.orders = [...tl.querySelectorAll('.jrn-story-ledger [data-order]')].map((el) => +el.dataset.order);
  S.JRN_ORDERS = S.JRN_STORY.orders;
}

/** Is the lane's document list open? Remembered per browser; closed by default so
 * the band's height is set by what the lane is showing.
 * @group Journey view */
function jrnBizDocsOpen() {
  if (S.jrnBizDocs == null) {
    let v = null;
    try { v = localStorage.getItem('fs-jrn-bizdocs'); } catch (e) { v = null; }
    S.jrnBizDocs = v === '1';
  }
  return S.jrnBizDocs;
}
/**
 * Open or close the lane's document list and redraw only this lane.
 * @group Journey view
 * @business Shows or hides the product documents this journey was written from.
 */
export function jrnToggleBizDocs() {
  S.jrnBizDocs = !jrnBizDocsOpen();
  try { localStorage.setItem('fs-jrn-bizdocs', S.jrnBizDocs ? '1' : '0'); } catch (e) { /* private mode: not remembered */ }
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const row = document.querySelector('#jrn-tl .jrn-bizrow');
  if (sum && row) row.outerHTML = jrnBizRowHtml(sum, jrnRowStyle(sum));
}
/** The lane's documents behind a disclosure that always carries their number.
 * @group Journey view */
function jrnBizDocsHtml(docs) {
  const open = jrnBizDocsOpen();
  return '<div class="jrn-bizdocs' + (open ? ' open' : '') + '">'
    + '<button class="jrn-bizdocs-t" onclick="jrnToggleBizDocs()" aria-expanded="' + open + '"'
    + ' title="' + esc(def('journey.bizDocs') || '') + '">' + (open ? '\u25be ' : '\u25b8 ')
    + esc(t('journey.bizDocs').replace('{n}', docs.length)) + '</button>'
    + (open ? '<div class="dsg-docs">' + docs.join('') + '</div>' : '') + '</div>';
}
/**
 * The business lane as one row: its name, the documents behind it, the view
 * control, then one cell per segment. Its own function because opening one of
 * the lane's three views redraws exactly this row and nothing else.
 * @group Journey view
 */
function jrnBizRowHtml(sum, rs) {
  const segs = sum.segments;
  const docs = ((sum.business && sum.business.docs) || []).map((l) => l && l.url ? linkHtml(l.url) : jrnDocLinkHtml((sum.entry && sum.entry.repo) || (S.JOURNEY.entry && S.JOURNEY.entry.repo), l)).filter(Boolean);
  // the control comes before the documents: it is the interactive thing in this lane,
  // and a flow with six ADR chips pushed the third view past the bottom of the row.
  // The documents now open on a disclosure carrying their count, because a grid row
  // is as tall as its tallest cell and this lane's stack of six chips WAS that cell:
  // 271px of lane above 93px of drawn sentence. The count is always on the control,
  // so nothing is hidden — only folded, and by a reader who can unfold it.
  const extra = jrnBizTabsHtml(sum) + (docs.length ? jrnBizDocsHtml(docs) : '');
  return '<div class="jrn-row jrn-bizrow" style="' + rs + '">'
    + jrnLaneHtml(t('journey.bandBusiness'), t('journey.bizSub'), '', extra)
    + segs.map((sg, i) => jrnBizCellHtml(sg, i === segs.length - 1)).join('') + '</div>';
}
/**
 * The whole timeline: header row (rail stops), the user lane, the line of
 * visibility, the business lane, the system-rows heading and the rows. Link
 * columns hang off the user lane. Everything from `summary`.
 * @group Journey view
 * @business Reads one feature left to right: each screen, what the business promises on it, and what every system does under it.
 */
function jrnTimelineHtml(sum) {
  const rs = jrnRowStyle(sum);
  const segs = sum.segments;
  let html = jrnTimelineLinksHtml(sum)
    + '<div class="jrn-row jrn-hdrow" style="' + rs + '">' + jrnLaneHtml(t('journey.kind.screen'), '', 'jrn-hdlane') + segs.map(jrnSegHeadHtml).join('') + '</div>';
  html += '<div class="jrn-row jrn-userrow" style="' + rs + '">' + jrnLaneHtml(t('journey.bandUser'), t('journey.screensSub')) + segs.map(jrnUserCellHtml).join('') + '</div>';
  html += '<div class="jrn-row jrn-visrow" style="' + rs + '">' + jrnLaneHtml(t('journey.lineOfVisibility'), '', 'jrn-vislane') + '<div class="jrn-vis" style="grid-column:2/-1"></div></div>';
  html += jrnBizRowHtml(sum, rs);
  html += '<div class="jrn-row jrn-syshead" style="' + rs + '">' + jrnLaneHtml(t('journey.bandSystem'), t('journey.actionsSub'))
    + '<div class="jrn-cell jrn-syshint" style="grid-column:2/-1">' + esc(t('journey.countSystems').replace('{n}', sum.systems.length)) + ' · ' + esc(t('journey.expandHint'))
    + jrnViewToggleHtml() + '</div></div>';
  html += jrnView() === 'ladder' ? jrnLadderHtml(sum, rs) : jrnSystemRowsHtml(sum, rs);
  return html;
}
/**
 * A summary from a server built before moments (segments without `moments[]`)
 * still draws: every segment becomes one moment — its screen, all its markers —
 * so the band reads as one column per screen instead of throwing. The server
 * that wrote the graph says which build it is in the sync chip; restart it to
 * get the moment grid.
 * @group Journey view
 */
function jrnEnsureMoments(sum) {
  sum.segments.forEach((sg) => {
    if (Array.isArray(sg.moments) && sg.moments.length) return;
    const counts = { markers: sg.markers.length, calls: 0, planned: 0, records: 0, messages: 0 };
    sg.markers.forEach((m) => { m.moment = 0; if (m.kind === 'call') counts.calls++; if (m.planned) counts.planned++; if (m.kind === 'record') counts.records++; if (m.kind === 'message') counts.messages++; });
    sg.moments = [{ index: 0, label: sg.screen ? sg.screen.name : t('journey.beforeFirstScreen'), from: sg.from, to: sg.to, actionStep: sg.from, repeat: false, counts }];
  });
}
/**
 * Render a fetched journey as the blueprint timeline: build the step tree,
 * index the markers, fill the grid, wire the forks button/drawer, then select
 * the first marker in the code lens (the business lens lands on the screens).
 * Falls back to an honest message when the server sends no `segments` (an
 * older graph server) — never an empty frame. Nothing is selected on arrival
 * in any register: see the note at the end of this function.
 * @group Journey view
 * @business Draws the journey as one timeline: screens, business flow and system work in sync.
 */
export function renderJourney(data) {
  S.JOURNEY = data;
  jrnSkipLink(document.getElementById('journey'));
  const steps = data.steps || [];
  S.JRN_TREE = jrnBuildTree(steps);
  const sum = data.summary;
  const lens = currentLens();
  const entry = data.entry || {};
  const isFlow = entry.kind === 'flow';
  document.getElementById('jrn-title').textContent = isFlow
    ? ((entry.design && entry.design.name) || entry.bizLabel || entry.name || '')
    : (lens === 'code' ? (entry.name || '') : jrnLabel(entry));
  const cnt = (sum && sum.counts) || {};
  document.getElementById('jrn-count').innerHTML = jrnHeaderHtml(data, sum, cnt, lens);
  // who the journey is for and its group, from the organised tree (a flow only)
  const orgEl = document.getElementById('jrn-orgline');
  if (orgEl) orgEl.innerHTML = '';
  const storyEl = document.getElementById('jrn-storyline');
  if (storyEl) storyEl.innerHTML = '';
  if (isFlow && entry.id) jrnFillOrg(entry.id);
  // the status lifecycle of each record the journey reaches, read from the code
  const lcEl = document.getElementById('jrn-lifecycle');
  if (lcEl) lcEl.innerHTML = jrnLifecycleHtml(data);
  // the trackers' work on this journey, when a work source is configured and anything is linked
  fillJourneyWork(entry);
  const ls = document.getElementById('jrn-layoutsw');
  if (ls) ls.innerHTML = jrnLayoutSwitchHtml();
  const ds = document.getElementById('jrn-docksw');
  if (ds) { ds.innerHTML = jrnDockSwitchHtml(); ds.style.display = jrnLayout() === 'drill' ? 'none' : ''; }
  jrnApplyDock();
  // TRUNCATED means the whole walk stopped at the step budget — nothing else
  // truncated is the one thing it means: the whole walk hit the step cap. The
  // cap is where it stopped, which the payload's own step count states.
  const tr = document.getElementById('jrn-trunc');
  tr.style.display = data.truncated ? '' : 'none';
  if (data.truncated) {
    // attention is a triangle, a word and a dashed outline — never the colour alone
    tr.innerHTML = sym('warning') + esc(t('journey.truncated').replace('{cap}', (data.steps || []).length));
    tr.title = def('journey.truncated') || '';
  }
  jrnCutChip(data, cnt);
  const forks = jrnCollectForks();
  const fkCount = data.forkCount != null ? data.forkCount : forks.length;
  const fb = document.getElementById('jrn-forksbtn');
  // every raw branch of the code is a code-lens fact; the other lenses reach
  // the drawer from a marker's expansion instead of wearing the count
  // the forks button opens the drawer; its number carries the tip (branch points the walk met, every class)
  if (fb) {
    fb.style.display = (fkCount && lens === 'code') ? '' : 'none';
    fb.innerHTML = sym('fork') + ' ' + esc(jrnCountWord('journey.forks.count', fkCount)).replace(String(fkCount), () => jrnNumHtml(fkCount, 'journey.forks.count', 'journey.scopeAll', { num: true, noFocus: true }));
    fb.removeAttribute('title');
  }
  jrnToggleForks(false);
  const drawer = document.getElementById('jrn-forks');
  if (drawer) drawer.innerHTML = jrnForksPanelHtml(forks);
  const po = document.getElementById('jrn-partof');
  if (po) po.innerHTML = sum && sum.links ? jrnPartOfHtml(sum) : '';
  if (!sum || !Array.isArray(sum.segments) || !sum.systems) {
    jrnShowState(jrnStateHtml(t('sys.journeyOldServer')));
    return;
  }
  jrnEnsureMoments(sum);
  const tl = document.getElementById('jrn-tl');
  tl.classList.toggle('drill', jrnLayout() === 'drill');
  // the view axis: the same summary, drawn as the timeline, as the sheet or as the drill
  if (jrnLayout() === 'storyboard') {
    S.JRN_DRILL = null;
    S.JRN_SHEET = null;
    jrnResetFolds();
    jrnStoryRender(sum);
  } else if (jrnLayout() === 'drill') {
    S.JRN_STORY = null;
    S.JRN_SHEET = null;
    jrnResetFolds();
    jrnDrillIndex(sum, S.jrnLastEntry === entry.id);
    tl.innerHTML = jrnDrillHtml(sum);
    jrnDrillMount();
    S.JRN_ORDERS = jrnOrdersNow();
  } else if (jrnLayout() === 'sheet') {
    S.JRN_DRILL = null;
    S.JRN_STORY = null;
    S.JRN_SHEET = null;
    jrnSheetIndex(sum);
    jrnResetFolds();
    tl.innerHTML = jrnSheetHtml(sum);
    S.JRN_ORDERS = jrnOrdersNow();
  } else {
    S.JRN_DRILL = null;
    S.JRN_STORY = null;
    S.JRN_SHEET = null;
    // markers by step order → their system row index (for the expansion slot)
    S.JRN_MARK = {};
    const ladder = jrnView() === 'ladder';
    sum.segments.forEach((sg) => sg.markers.forEach((m) => { S.JRN_MARK[m.stepOrder] = { seg: sg.index, row: ladder ? 0 : sum.systems.findIndex((r) => r.key === m.system) }; }));
    S.JRN_ORDERS = Object.keys(S.JRN_MARK).map(Number).sort((a, b) => a - b);
    jrnMeasure(sum);
    jrnResetFolds();
    tl.innerHTML = jrnTimelineHtml(sum);
    S.JRN_ORDERS = jrnOrdersNow();
  }
  jrnImpactRings();
  // a journey opened without `?view=` still lands on *some* view (the register's
  // default, or what this browser last chose); the address says which, so a link
  // copied from the bar opens on the picture that was on the screen and not on
  // the reader's own default
  jrnWriteViewHash();
  const keep = S.journeyActive != null && S.JRN_MARK[S.journeyActive] && S.jrnLastEntry === entry.id;
  S.jrnLastEntry = entry.id;
  // NOTHING is selected on arrival. The code register used to open on the first
  // marker, which cost 293px of a 900px window — a third of the view, spent on a
  // step nobody asked for, before the reader had clicked anything. On the sheet
  // that hid half the layers; on the drill it left 3 of 14 beats. An empty pane
  // is 42px and carries the hint that says what to click, so the affordance is
  // not lost — only the space it was taking without being asked.
  const pending = S.jrnPendingStep;
  S.jrnPendingStep = null;
  if (pending) { S.journeyActive = -1; jrnDockRender(-1); jrnApplyStep(pending); }
  else if (keep) jrnSelect(S.journeyActive, true);
  else { S.journeyActive = -1; jrnDockRender(-1); jrnUpdateProgress(); }
  jrnToMapDraw();
  jrnFitToWindow();
}
/**
 * Arrive at the step a link names (`?step=n`, the 1-based screen ordinal the
 * Map's `screen` shares): the node's marker when the link names one on that
 * screen (or a gate met there), else the screen's first marker — and the
 * screen's head scrolled into view.
 * @group Journey view
 * @business Opens the journey at the screen the link was written on.
 */
function jrnApplyStep(p) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const segs = (sum && sum.segments) || [];
  const si = stepIndex(p.step, segs.length);
  if (si == null) return;
  const sg = segs[si];
  let order = null;
  if (p.node) {
    const m = sg.markers.find((x) => x.nodeId === p.node) || segs.flatMap((x) => x.markers).find((x) => x.nodeId === p.node);
    const g = !m && (sg.gates || []).find((x) => x.id === p.node);
    order = m ? m.stepOrder : g ? g.stepOrder : null;
  }
  if (order != null) jrnScrollTo(order);
  else jrnSelectSegment(si);
  // the screen's head to the left edge of the timeline, past the sticky row labels — a wide screen centred
  // would show its empty middle
  const head = document.getElementById('jrn-sh-' + si);
  const tl = document.getElementById('jrn-tl');
  if (head && tl) {
    const lab = tl.querySelector('.jrn-lane');
    const labW = lab ? lab.getBoundingClientRect().width : 190;
    tl.scrollLeft += head.getBoundingClientRect().left - tl.getBoundingClientRect().left - labW - 8;
  }
}
/** The 1-based screen ordinal a step order sits in, else null. @group Journey view */
function jrnScreenOrdinal(order) {
  const segs = (S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.segments) || [];
  const sg = order >= 0 ? segs.find((x) => order >= x.from && order <= x.to) : null;
  return sg ? sg.index + 1 : null;
}
/**
 * Keep the address on the step on screen (`?step=n&node=id`), so the bar and
 * *Copy link* name the screen and the part selected, and redraw the header's
 * *see it on the Map* for the same place.
 * @group Journey view
 */
function jrnWriteStepHash(order) {
  const h = location.hash || '';
  const step = jrnScreenOrdinal(order >= 0 ? order : S.journeyActive);
  const mk = order >= 0 ? jrnMarkerAt(order) : null;
  S.jrnStep = step ? { step, node: mk ? mk.nodeId : null } : null;
  if (isJourneyRoute(h)) {
    const next = withParams(h, { step: step ? String(step) : null, node: step && mk ? mk.nodeId : null });
    if (next !== h) history.replaceState(null, '', next);
  }
  jrnToMapDraw();
}
/** Whether the workspace turned the Map on (surfaces/map.js mapEnabled, read here without importing the surface). */
function jrnMapOn() { const f = S.SETTINGS && S.SETTINGS.flags; return !!(f && f.map); }
/**
 * The header's *see it on the Map*: this journey's street with the step on
 * screen framed, and — when the selected part is a call or something it reads
 * or writes — plumbing on with that part's card open.
 * @group Journey view
 * @business Opens the same journey on the Map, at the screen you are on.
 */
function jrnToMapDraw() {
  // beside the Map door: Save, which draws the journey as its storyboard (lib/export.js)
  const ex = document.getElementById('jrn-export');
  if (ex && !ex.firstChild) ex.innerHTML = exportToolHtml('storyboard', 'dd-door lead jrn-export-a'); // str:ok — class names
  const el = document.getElementById('jrn-tomap');
  if (!el) return;
  const entry = (S.JOURNEY && S.JOURNEY.entry) || {};
  if (entry.kind !== 'flow' || !jrnMapOn()) { el.innerHTML = ''; return; }
  const st = S.jrnStep || { step: 1, node: null };
  const mk = st.node ? jrnMarkerAt(S.journeyActive) : null;
  const kind = mk && mk.kind === 'call' ? 'call' : mk && (mk.kind === 'record' || mk.kind === 'message' || mk.kind === 'external') ? mk.kind : null;
  const href = mapScreenHash(entry.id, st.step, kind ? { node: mk.nodeId, kind } : {});
  el.innerHTML = '<a class="dd-door lead jrn-tomap-a" href="' + esc(href) + '"' + tipAttrs({ key: 'door.map', noFocus: true }) + '>' + sym('interchange') + esc(t('door.map')) + '</a>';
}
/**
 * Beside the journey's title, for a flow: `For <persona> · <group>`, read from
 * the same tree the front door draws (lib/journeys-tree.js), so the two cannot
 * disagree. A journey for two people names the first and says it is also for
 * the rest. Nothing is drawn when the tree does not list the journey.
 * @group Journey view
 * @business Says who the journey is for and which group of journeys it belongs to.
 */
function jrnFillOrg(entryId) {
  loadJourneyTree().then((got) => {
    if (!S.JOURNEY || !S.JOURNEY.entry || S.JOURNEY.entry.id !== entryId) return;
    jrnFillStoryline(got && got.tree, entryId);
    const places = placesOf(got && got.tree, entryId);
    const el = document.getElementById('jrn-orgline');
    if (!places.length || !el) return;
    const p = places[0];
    const others = [...new Set(places.slice(1).map((x) => x.persona))].filter((x) => x !== p.persona);
    el.innerHTML = '<span class="g-org"><span class="jrn-org-for"' + defAttrs('journeys.persona.for') + '>' + esc(t('journeys.persona.for')) + '</span> '
      + '<a class="jrn-org-p" href="' + esc('#/journeys?persona=' + encodeURIComponent(p.persona.id)) + '">' + esc(jrnPersonaName(p.persona)) + '</a>'
      + ' · <span class="jrn-org-g">' + esc(jrnGroupName(p.group)) + '</span>'
      + (others.length ? ' <span class="jrn-org-also"' + defAttrs('journeys.persona.alsoUnder') + '>' + esc(t('journeys.persona.alsoUnder').replace('{names}', others.map(jrnPersonaName).join(' · '))) + '</span>' : '')
      + '</span>';
  }).catch(() => { /* an older server with no design answer: the header keeps its counts */ });
}
/**
 * Beside who the journey is for: *Storyline · <name> · step n of m* with ‹ ›
 * that open the journey before and after it in that storyline (at its first
 * step: the journey opens from the top). The first storyline it is a step of;
 * the others are named in the tip. Nothing when it is in none.
 * @group Journey view
 * @business Says which end-to-end storyline this journey is part of, where it stands in it, and opens the journeys before and after.
 */
function jrnFillStoryline(tree, entryId) {
  const el = document.getElementById('jrn-storyline');
  if (!el) return;
  const at = storylineOf(tree, entryId);
  if (!at.length) { el.innerHTML = ''; return; }
  const a = at[0];
  // a branch is not a step: it reads *branch of <journey> · when …*, ‹ opens the step it leaves from and › the one it rejoins
  const where = a.branch
    ? t('journeys.storyline.branchOf').replace('{name}', a.branch.branchOfName || (a.prev && a.prev.name) || '') + ' · ' + t('journeys.storyline.when').replace('{when}', a.branch.when)
    : t(currentLens() === 'business' ? 'journeys.storyline.bizStepOf' : 'journeys.storyline.stepOf').replace('{n}', a.step).replace('{m}', a.of);
  const others = at.slice(1).map((x) => x.storyline.name + ' · ' + t('journeys.storyline.stepOf').replace('{n}', x.step).replace('{m}', x.of));
  const arrow = (j, glyph, key) => (j
    ? '<button type="button" class="jrn-story-nav" onclick="openJourney(' + jsArg(j.nodeId) + ', 1)" aria-label="' + esc(t(key) + ' · ' + (j.name || j.id)) + '"' + tipAttrs({ text: t(key) + ' · ' + (j.name || j.id) }) + '>' + glyph + '</button>'
    : '<span class="jrn-story-nav off" aria-hidden="true">' + glyph + '</span>');
  el.innerHTML = '<span class="jrn-story-line" data-storyline="' + esc(a.storyline.id) + '">'
    + arrow(a.prev, '‹', 'journeys.storyline.prev')
    + '<span class="jrn-org-for"' + defAttrs('journeys.storyline.word') + '>' + esc(t('journeys.storyline.word')) + '</span> '
    + '<span class="jrn-story-name"' + tipAttrs({ text: a.storyline.name + (a.storyline.description ? ' · ' + jrnWords(a.storyline.description) : '') + (others.length ? ' · ' + others.join(' · ') : '') }) + '>' + esc(a.storyline.name) + '</span>'
    + ' · <span class="jrn-story-at' + (a.branch ? ' branch' : '') + '"' + (a.branch ? tipAttrs({ text: where + ' · ' + (a.branch.rejoins ? t('journeys.storyline.rejoins').replace('{name}', a.branch.rejoinsName || '') : t('journeys.storyline.noReturn')) }) : defAttrs('journeys.storyline.stepOf')) + '>' + (a.branch ? sym('fork') + ' ' : '') + esc(where) + '</span>'
    + arrow(a.next, '›', 'journeys.storyline.next')
    + '</span>';
}
/**
 * The journey header's status lifecycle: one strip per record whose statuses the code declares and
 * that this journey moves (at most two, the rest counted) (`/api/journey` → `lifecycles`, core `journeyLifecycles`) — the statuses in declared
 * order, each move some code makes as a door to its writer, the moves this journey makes lit.
 * `''` when no record the journey reaches declares its statuses.
 * @group Journey view
 * @business Shows the statuses a record goes through and which part of the system moves it to each one.
 */
export function jrnLifecycleHtml(data) {
  const { shown, more } = headerLifecycles(data && data.lifecycles);
  const flow = data && data.entry && data.entry.kind === 'flow' ? data.entry.id : '';
  return shown.map((lc) => lifecycleStripHtml(lc, '/api/journey', { flow })).join('')
    + (more ? '<span class="lc-more"' + defAttrs('lifecycle.more') + '>' + esc(t('lifecycle.more').replace('{n}', more)) + '</span>' : '');
}
/**
 * The header count line: five named groups instead of a run of fourteen counts
 * (pass swarm 2026-09-25 — the staff engineer's *"a run-on of 14 counts"*, and
 * every reviewer's *"none of them names its scope"*). Each group prints one
 * number in its own words — screens (with how many are built), actions, gates &
 * rules, the conditions nobody put in plain language, and the tests with the
 * evidence word and the run behind it — and the rest of the journey's counts
 * sit in the tips of the group they belong to, each under its own name. The code
 * lens adds a sixth, the walk itself, in its developer units.
 *
 * Every number is a typed count the core handed out (`summary.counted`,
 * docs/COUNTS.md) and carries its tip: what it counts, the scope it counts over,
 * where it came from, its breakdown, and the numbers printed beside it. The
 * separators are real text, so the line pastes into a ticket as it reads.
 * @group Journey view
 * @business Says how big the journey is — screens, things to do, checks, what is not in plain words, and what proves it — each number with what it counts on hover or click.
 */
function jrnHeaderHtml(data, sum, cnt, lens) {
  const business = lens === 'business';
  const C = (name) => jrnC(sum, name);
  const cov = (sum && sum.coverage && sum.coverage.journey) || null;
  // the actions the header counts are the fold's split (`cnt.called`, and beside
  // it `cnt.again` and `cnt.declaredNotCalled`), never the occurrences the band
  // draws — those are the rail's stops, named as stops in the tip
  const actions = C('actions') || (cnt.called != null ? jrnC({ counts: cnt }, 'actions') : null);
  const groups = [];
  const g = (cls, items) => { const html = items.filter(Boolean).join(' · '); if (html) groups.push('<span class="jrn-hg ' + cls + '">' + html + '</span>'); };
  // screens: the list is the tip — the screens in order, built or not
  const screens = C('screens');
  g('g-screens', [
    screens ? '<span class="jrn-num jrn-screens"' + tipAttrs({ id: 'jrnScreens' }) + '>' + esc(jrnCountedWords(screens)) + '</span>' : '',
    jrnCountedHtml(C('built'), { cls: 'jrn-built' }),
  ]);
  // what a person can do; again, declared-not-called and the rail's stops are
  // other numbers about the same calls, so they are named in its tip, never summed into it
  const touches = ((sum && sum.systems) || []).filter((r) => r.kind === 'records' || r.kind === 'messages' || r.kind === 'external').map((r) => r.label);
  g('g-actions', [
    jrnCountedHtml(actions, { cls: 'jrn-actions', rel: [C('again'), C('declaredNotCalled'), C('actionStops'), C('planned'), C('setup'), C('deferred'), C('choices'), C('systems')] }),
    business && touches.length ? '<span class="jrn-touches">' + esc(t('journey.biz.touches').replace('{systems}', touches.join(' · '))) + '</span>' : '',
  ]);
  g('g-gates', [jrnCountedHtml(C('gates'), { rel: [C('checks'), C('decisions')] })]);
  // the whole — technical conditions plus gate conditions nobody labelled — in
  // every lens: one concept, one number. The header uses the short words; the
  // tip heads with the business sentence in the business lens.
  g('g-words', [jrnCountedHtml(C('notInWords'), { unit: 'count.unit.notInWords', cls: 'jrn-untrn', rel: [C('decisions'), C('inWords')], list: { t: true, g: true } })]);
  // the tests: how many reach the journey, the evidence word, and the run behind
  // it beside the word — so *seen by a coverage run* never stands alone above a
  // `0 observed` it does not explain. The e2e rung is in the tests' tip.
  const ev = cov ? evidenceWord(cov) : { cls: 'none', key: '' };
  const facts = cov ? jrnFoldFacts(cov) : null;
  const tk = (cov && cov.counted) || {};
  const chipCls = ev.cls === 'none' ? '' : ev.cls;
  // the shared-evidence case says it in a sentence: nothing of this flow is
  // built, so no word about it is a claim this flow can earn (blocker 2)
  const evHtml = cov && cov.sharedEvidence
    ? '<span class="jrn-e2e shared"' + tipAttrs({ key: 'journey.evidenceShared' }) + '>' + esc(t('journey.evidenceShared')) + '</span>'
    : chipCls ? '<span class="jrn-e2e ' + esc(chipCls) + '"' + tipAttrs({ id: 'jrnEvidence', args: { ev, obs: (cov && cov.observation) || null, verdict: cov && cov.verdict ? { status: cov.verdict.status } : null, fresh: (cov && cov.freshness) || null } }) + '>' + esc(t(ev.key)) + '</span>' : '';
  const obs = !business && facts && !(cov && cov.sharedEvidence) ? jrnObsText(facts) : '';
  g('g-tests', [
    // one chip: the cases, *over this journey*, *distinct* beside per-screen counts (its tip is the per-screen
    // table), the one word and the skips — the shared-evidence case keeps its sentence instead of the word
    cov && cov.counted && cov.counted.tests && cov.counted.tests.n
      ? testChipHtml(facts, { distinct: distinctArgs(sum), word: !cov.sharedEvidence, cls: 'jrn-htests', evCls: 'jrn-e2e' }) + (cov.sharedEvidence ? ' ' + evHtml : '')
      : jrnCountedHtml(tk.tests, { rel: [tk.e2e, tk.unit, tk.integration, tk.runReports] }) + evHtml,
    obs ? '<span class="jrn-obs">' + esc(obs) + '</span>' : '',
    // the freshness sentence beside the word: *stale* with both sides, or *current as of sync N* (finding 2)
    cov && !cov.sharedEvidence ? freshLineHtml(cov.freshness, 'jrn-fresh') : '',
  ]);
  // the walk, in the code lens only: its units are a developer's
  if (lens === 'code') {
    g('g-walk', [jrnCountedHtml(C('steps'), { rel: [C('repeats'), C('planned'), C('cutPoints'), C('systems')] })]);
  }
  return groups.join('<span class="jrn-hsep"> · </span>');
}
/**
 * The header's cut-points chip: how many subtrees the walk did not follow, and
 * why, by reason. A walk that never hit a budget says nothing at all — and
 * TRUNCATED stays reserved for the one thing it means, the step budget.
 *
 * The chip is a button: its number is the length of a list, and a count a
 * reader cannot open is the thing this phase exists to remove. Both the
 * tooltip's breakdown and the list behind it are built from the same filter the
 * core counts with — `reason !== 'repeat'` — so neither can disagree with the
 * number on the chip. Re-visits were walked once and drawn once; they are named
 * at the foot of the list, never added to it.
 * @group Journey view
 * @business Says how much of the journey was left unwalked, and why — instead of implying the whole thing is complete. Click it for the list.
 */
function jrnCutChip(data, cnt) {
  const el = document.getElementById('jrn-cuts');
  if (!el) return;
  const n = cnt.cutPoints || 0;
  jrnToggleCuts(false);
  el.style.display = n ? '' : 'none';
  if (!n) { el.innerHTML = ''; jrnCutListFill(null, cnt); return; }
  // the same cuts the number counts: a re-visit hides nothing, so it is not one
  const cuts = (data.cutPoints || []).filter((c) => c.reason !== 'repeat');
  const by = {};
  cuts.forEach((c) => { by[c.reason] = (by[c.reason] || 0) + 1; });
  // the chip is a button (it opens the list); its number carries the tip — what a
  // cut point is, over the journey, split by the budget that ran out
  const c = sum0Cut(data, n, by);
  el.innerHTML = sym('warning') + esc(t(countKey('journey.cutPoints', n))).replace('{n}', () => '<span class="jrn-num"' + tipAttrs({ number: c, noFocus: true }) + '>' + n + '</span>');
  el.removeAttribute('title');
  jrnCutListFill(data.summary, cnt);
}
/** The cut chip's number tip: the count, over the journey, split by reason (the parts add up to it). */
function sum0Cut(data, n, by) {
  const rows = jrnCutReasons(by).map((k) => [t('journey.cutReason.' + k).replace('{n}', '').trim(), by[k]]);
  return { count: n, of: 'journey.cutPoints', scope: 'journey.scopeAll', source: tipSource('/api/journey'), breakdown: rows.length ? { rows } : undefined };
}
/** The reasons a cut can have, the known ones first — an unknown one from a newer core still lists, last.
 * @group Journey view */
function jrnCutReasons(by) {
  const known = ['depth', 'steps'].filter((r) => by[r]);
  return known.concat(Object.keys(by).filter((r) => !known.includes(r)));
}
/**
 * Every cut point of this journey as one flat list in walk order, each row
 * carrying where it happened: the marker the core hung it on (the call site
 * that owns the fold, never a step no surface draws), the screen, and which
 * action of that screen. Read from `summary.segments[].cutPoints`, which the
 * core fills from the same filtered array `counts.cutPoints` counts — so the
 * list is the chip's number, itemised, and not a second count of the same thing.
 * @group Journey view
 */
function jrnCutRows(sum) {
  const entry = (S.JOURNEY && S.JOURNEY.entry) || {};
  const entryName = (entry.design && entry.design.name) || jrnLabel(entry);
  return (sum.segments || []).flatMap((sg) => (sg.cutPoints || []).map((c) => {
    const mo = (sg.moments || []).find((m) => m.index === c.moment);
    const mk = (sg.markers || []).find((m) => m.stepOrder === c.parentStep);
    return {
      reason: c.reason,
      name: c.name || c.nodeId,
      seg: sg.index,
      moment: c.moment,
      parentStep: c.parentStep,
      parent: (mk && mk.name) || '',
      action: mo ? jrnMomOrdinal(sg, mo) : c.moment + 1,
      screen: (sg.screen && sg.screen.name) || entryName,
    };
  }));
}
/** One row of the cut list: what the walk did not enter, and where it was standing when it stopped.
 * @group Journey view */
function jrnCutRowHtml(r) {
  const where = t('journey.cutPoint.row').replace('{parent}', r.parent).replace('{a}', r.action).replace('{screen}', r.screen);
  return '<button class="jrn-cut-entry" onclick="jrnCutJump(' + r.seg + ',' + r.moment + ',' + r.parentStep + ')" title="' + esc(def('journey.cutPoint.row') || '') + '">'
    + '<span class="jrn-cut-what">' + esc(r.name) + '</span>'
    + '<span class="jrn-cut-where">' + esc(where) + '</span></button>';
}
/**
 * Draw the drawer behind the chip: the chip's own number as the head, the
 * sentence that defines it, then one group per budget that ran out with its
 * count — the groups add up to the head, which is the whole point of opening
 * it. Re-visits close the panel as a separate fact, outside the sum, because
 * the walk did see them.
 * @group Journey view
 * @business Lists every place the walk stopped short, so the number in the header can be checked and walked.
 */
function jrnCutListFill(sum, cnt) {
  const d = document.getElementById('jrn-cutlist');
  if (!d) return;
  const n = cnt.cutPoints || 0;
  if (!sum || !Array.isArray(sum.segments) || !n) { d.innerHTML = ''; return; }
  const rows = jrnCutRows(sum);
  const by = {};
  rows.forEach((r) => { (by[r.reason] = by[r.reason] || []).push(r); });
  const head = t(countKey('journey.cutPoints', n)).replace('{n}', n);
  d.setAttribute('aria-label', head);
  d.innerHTML = '<div class="jrn-fkp-head"><span class="hud-label">' + sym('warning') + ' ' + esc(head) + '</span>'
    + '<button class="x" onclick="jrnToggleCuts(false)" aria-label="Close">✕</button></div>'
    + '<p class="jrn-cut-sub">' + esc(def('journey.cutPoints') || '') + '</p>'
    + jrnCutReasons(by).map((r) => '<div class="jrn-fkp-cat"><span class="jrn-cut-reason">'
      + esc(t('journey.cutReason.' + r).replace('{n}', by[r].length)) + '</span></div>'
      + by[r].map(jrnCutRowHtml).join('')).join('')
    + (cnt.repeats ? '<div class="jrn-cut-foot" title="' + esc(def('journey.countRepeats') || '') + '">'
      + esc(t('journey.countRepeats').replace('{n}', cnt.repeats)) + '</div>' : '');
}
/** Open / close the cut list (pass true/false to force a state).
 * @group Journey view */
function jrnToggleCuts(force) {
  S.jrnCutsOpen = (force === true || force === false) ? force : !S.jrnCutsOpen;
  const d = document.getElementById('jrn-cutlist');
  if (d) { d.classList.toggle('open', S.jrnCutsOpen); jrnDrawerInert(d, S.jrnCutsOpen); }
  const chip = document.getElementById('jrn-cuts');
  if (chip) chip.setAttribute('aria-expanded', S.jrnCutsOpen ? 'true' : 'false');
}
/**
 * Go to a cut point: the storyboard draws one action at a time, so it opens that
 * screen and action first; then the usual jump opens every fold above the step
 * (and the sheet cell, and the drill's action) and selects it. The drawer closes
 * on the way, because a marker behind the drawer is not one the reader can see.
 * @group Journey view
 * @business Takes you to the step the walk was on when it stopped, and opens whatever was hiding it.
 */
function jrnCutJump(si, mi, order) {
  jrnToggleCuts(false);
  if (S.JRN_STORY) jrnStoryGo(si, mi);
  jrnScrollTo(order);
}
/** Whether the cut list is open (Esc routing).
 * @group Journey view */
export function cutsOpen() { return !!S.jrnCutsOpen; }
/** Close just the cut list (Esc routing).
 * @group Journey view */
export function closeCuts() { jrnToggleCuts(false); }
/** A window of step i's own code around one line — the caller/handler slices of a seam splice.
 * @group Journey view */
function jrnCodeWindow(i, around, span) {
  const s = S.JOURNEY.steps[i];
  if (!s || s.code == null || s.code === '') return '';
  const lines = String(s.code).split('\n');
  const start = s.codeStartLine || (s.node && s.node.loc && s.node.loc.line) || 1;
  const at = around || start;
  const from = Math.max(start, at - span), to = Math.min(start + lines.length - 1, at + span);
  return jrnCodeSeg(s, i, from, to, lines, start, new Set(around ? [around] : []));
}
/** The contract block of a call: what the operation does, requires, returns and how it stands against the code.
 * @group Journey view */
export function jrnContractHtml(n) {
  const c = n.contract;
  if (!c) return '';
  const row = (k, v) => '<span class="k">' + esc(k) + '</span><span>' + v + '</span>';
  const statusKey = c.status === 'both' ? 'apis.status.both' : c.status === 'spec-only' ? 'apis.status.specOnly'
    : c.status === 'declared' ? 'apis.status.declared' : c.status === 'code-only' ? 'apis.status.codeOnly' : 'apis.status.implemented';
  let out = '<div class="jrn-contract-card"><span class="hd">' + sym('api') + esc(t('journey.contractHead')) + '</span>';
  if (c.summary || c.description) out += row(t('journey.contract.does'), proseHtml(c.description || c.summary));
  if ((c.security || []).length) out += row(t('journey.contract.requires'), (c.security || []).map((x) => sym('lock') + esc(x)).join(' '));
  const ret = (c.responses || []).filter((r) => /^2/.test(String(r.status)));
  if (ret.length) out += row(t('journey.contract.returns'), ret.map((r) => '<code>' + esc(r.status + (r.schema ? ' ' + r.schema : '')) + '</code>').join(' '));
  out += row(t('journey.contract.status'), esc(t(statusKey)));
  (c.drift || []).forEach((d) => { out += row('', '<span class="drift">' + esc(t('apis.drift.' + d.kind)) + '</span>'); });
  return out + '</div>';
}
/**
 * The selected marker's panel, rendered into its system row's expansion slot
 * or into the docked code pane: the same five tabs the drill's inspector draws
 * — docs · request/response · code · forks · tests — and the same head, so one
 * step answers the same questions in the same order wherever it is opened
 * (B4.1). It opens on **DOCS** outside the code register: what the people who
 * wrote this said it is for, before the code that implements it. The CODE tab
 * is what this slot used to be: the seam splice for a call, the Wallaby-style
 * spliced timeline for everything else.
 * @group Journey view
 * @business Opens one part of the journey: what it is for, what it promises, what it does, and what proves it runs.
 */
function jrnExpHtml(i) {
  return '<div class="jrn-insp">' + jrnInspPanelHtml(i) + '</div>';
}
/**
 * One step's own side of a transaction boundary, in the register the lens asks
 * for. Drawn wherever a step opens — the rows and sheet expansions and the
 * drill's inspector — so the fact is not reachable only by hovering a chip, and
 * so the drill flag being off cannot hide it.
 *
 * Silence is a claim-free answer: this step is not written inside a transaction
 * its caller opened. When the graph records no boundary anywhere, the fallback
 * sentence stands in its place, because absent is not a side.
 * @group Journey view
 */
export function jrnTxLineHtml(mk) {
  const biz = currentLens() === 'business';
  if (S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.txKnown === false) {
    return '<div class="jrn-insp-tx none">' + esc(t(biz ? 'journey.biz.txFallback' : 'journey.drill.txFallback')) + '</div>';
  }
  if (!mk || !mk.tx) return '';
  const key = (biz ? 'journey.biz.tx.' : 'journey.tx.') + mk.tx;
  return '<div class="jrn-insp-tx ' + mk.tx + '" title="' + esc(def(key)) + '">' + esc(t(key)) + '</div>';
}
/** The body of a step's expansion without its head — the seam splice for a call, the spliced code for anything else (the drill's CODE tab draws this alone).
 * @group Journey view */
export function jrnExpBodyHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const mk = jrnMarkerAt(i);
  // a call with several implementations opens with all of them, then the code
  const oneof = mk && mk.choice ? jrnChoiceHtml(mk.choice) : '';
  if (oneof) return oneof + '<div class="jrn-code">' + jrnSectionHtml(i) + '</div>';
  if (mk && mk.kind === 'call') {
    const where = (e, label) => e
      ? '<span class="from">' + esc(label + ' ' + e.path + ':' + e.line) + vsl(e.repo, e.path, e.line) + '</span>'
      : '<span class="from miss">' + esc(label + ' ' + t('journey.seam.notBuilt')) + '</span>';
    const caller = mk.caller ? '<span class="from">' + esc(mk.caller.name + ' · ' + mk.caller.path) + vsl(mk.caller.repo, mk.caller.path, mk.caller.line) + '</span>' : '';
    const route = n.loc ? '<span class="from">' + esc((n.name || '') + ' · ' + n.loc.path + ':' + n.loc.line) + vsl(n.repo, n.loc.path, n.loc.line) + '</span>' : '';
    // the caller's fetch line, then the route's own registration, then what it continues into
    const callerCode = mk.caller ? jrnCodeWindow(i - 1, mk.caller.line, 2) : '';
    const routeCode = mk.handler ? jrnCodeWindow(i, mk.handler.line, 1) : '';
    const next = S.JOURNEY.steps[i + 1];
    const cont = next && next.node && next.node.loc && next.depth === s.depth + 1;
    return '<div class="jrn-splice3">'
      + '<div class="side ux"><span class="hud-label">← ' + esc(t('journey.seam.uxSide')) + '</span>' + caller + where(mk.caller, '←' + ' ' + t('journey.seam.from')) + callerCode + '</div>'
      + '<div class="side ct">' + jrnContractHtml(n) + jrnReqChips(i) + '</div>'
      + '<div class="side sv"><span class="hud-label">→ ' + esc(t('journey.seam.apiSide')) + '</span>' + route + where(mk.handler, '→ ' + t('journey.seam.handled')) + routeCode
      + (cont ? '<span class="from">' + esc(t('journey.seam.continues')) + ' ▸ ' + esc(jrnLabel(next.node) + ' · ' + next.node.loc.path + ':' + next.node.loc.line) + vsl(next.node.repo, next.node.loc.path, next.node.loc.line) + '</span>' + jrnCodeWindow(i + 1, null, 2) : '')
      + '</div></div>';
  }
  return '<div class="jrn-code">' + jrnSectionHtml(i) + '</div>';
}
/** The summary marker for a step order (the fold's facts, not the walk's).
 * @group Journey view */
export function jrnMarkerAt(i) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return null;
  for (const sg of sum.segments) { const m = sg.markers.find((x) => x.stepOrder === i); if (m) return m; }
  return null;
}
/** Fill every segment's progress bar from the active step (a walked segment is full, a future one empty).
 * @group Journey view */
function jrnUpdateProgress() {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum) return;
  sum.segments.forEach((sg) => {
    const bar = document.getElementById('jrn-sb-' + sg.index);
    if (!bar) return;
    const a = S.journeyActive;
    let pct = 0;
    if (a >= 0 && sg.markers.length) {
      if (a > sg.to) pct = 100;
      else if (a >= sg.from) pct = Math.round(100 * sg.markers.filter((m) => m.stepOrder <= a).length / sg.markers.length);
    }
    bar.style.width = pct + '%';
    const head = document.getElementById('jrn-sh-' + sg.index);
    if (head) head.classList.toggle('on', a >= sg.from && a <= sg.to);
  });
}
/**
 * Select a marker by step order: ring it, open its contract / code in the
 * expansion slot under its system row (or in the pinned pane when the dock is
 * bottom / right), fill the progress bars. -1 closes the expansion. Called by markers, gates, chips, the forks drawer and j/k.
 * @group Journey view
 */
export function jrnSelect(i, noScroll) {
  if (!S.JOURNEY) return;
  if (i >= 0 && S.JRN_DRILL) jrnDrillEnsureAction(i);
  if (i >= 0) jrnRevealFold(i);
  S.journeyActive = i;
  document.querySelectorAll('#jrn-tl .jrn-mk, #jrn-tl .jrn-seam, #jrn-tl .jrn-bx').forEach((el) => el.classList.toggle('on', +el.dataset.order === i));
  document.querySelectorAll('#jrn-tl .jrn-exp').forEach((el) => { el.style.display = 'none'; el.innerHTML = ''; });
  const mk = S.JRN_MARK[i];
  if (S.JRN_DRILL) jrnDrillSelected(mk && mk.row >= 0 ? i : -1);
  else if (jrnDock() !== 'inline') jrnDockRender(mk && mk.row >= 0 ? i : -1);
  else if (mk && mk.row >= 0) {
    const slot = document.getElementById('jrn-exp-' + mk.row);
    if (slot) { slot.innerHTML = jrnExpHtml(i); slot.style.display = ''; }
  }
  jrnUpdateProgress();
  if (!noScroll) {
    const el = document.querySelector('#jrn-tl .jrn-mk[data-order="' + i + '"], #jrn-tl .jrn-seam[data-order="' + i + '"], #jrn-tl .jrn-bx[data-order="' + i + '"]');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  jrnImpactRings();
  jrnWriteStepHash(i);
}
/** Select a segment (its header or business step): its first marker, else just highlight it.
 * @group Journey view */
export function jrnSelectSegment(si) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  const sg = sum && sum.segments[si];
  if (!sg) return;
  if (sg.markers.length) jrnSelect(sg.markers[0].stepOrder);
  else { S.journeyActive = sg.from; jrnSelect(-1, true); S.journeyActive = sg.from; jrnUpdateProgress(); jrnWriteStepHash(sg.from); }
}
/**
 * Jump to step i from a chip, a gate or the forks drawer: the step's own
 * marker when it has one, else the nearest marker that owns it (a planned
 * receives/does/returns row belongs to its call; a screen row to its
 * segment's first marker).
 * @group Journey view
 */
export function jrnScrollTo(i) {
  if (!S.JOURNEY || !S.JRN_MARK) return;
  let cur = i;
  while (cur != null && cur >= 0 && !S.JRN_MARK[cur]) cur = S.JRN_TREE.parent[cur];
  if (cur != null && cur >= 0 && S.JRN_MARK[cur]) { jrnSelect(cur); return; }
  const sum = S.JOURNEY.summary;
  const sg = sum && sum.segments.find((x) => i >= x.from && i <= x.to);
  if (sg) jrnSelectSegment(sg.index);
}
/** Step to the next/previous marker on the timeline (j/k keys).
 * @group Journey view */
export function jrnNav(d) {
  const orders = S.JRN_ORDERS || [];
  if (!orders.length) return;
  const at = orders.indexOf(S.journeyActive);
  const next = at < 0 ? (d > 0 ? 0 : orders.length - 1) : Math.max(0, Math.min(orders.length - 1, at + d));
  jrnSelect(orders[next]);
}
/** Expand a collapsed repeat/cycle row in place, revealing its spliced body.
 * @group Journey view */
function jrnExpandRepeat(btn) {
  if (window.event) window.event.stopPropagation();
  const sec = btn.closest('.jrn-sec');
  const body = sec && sec.querySelector('.jrn-repeat-body');
  if (body) { body.style.display = ''; btn.style.display = 'none'; sec.classList.remove('jrn-collapsed'); }
}

/** Re-render the open journey after a lens switch (called by the shell).
 * @group Journey view */
export function journeyLensRefresh() {
  if (S.JOURNEY && document.getElementById('journey').classList.contains('open')) {
    jrnShowContent(); renderJourney(S.JOURNEY);
  }
}
/** Whether the journey overlay is open (keymap routing).
 * @group Journey view */
export function journeyOpen() { return document.getElementById('journey').classList.contains('open'); }
/** Whether the forks drawer is open (Esc routing).
 * @group Journey view */
export function forksOpen() { return S.jrnForksOpen; }
/** Close just the forks drawer (Esc routing).
 * @group Journey view */
export function closeForks() { jrnToggleForks(false); }
/** Whether a marker's contract / code is expanded (Esc closes it before the overlay).
 * @group Journey view */
export function expandedOpen() { return !!(S.JOURNEY && S.JRN_MARK && S.journeyActive >= 0 && S.JRN_MARK[S.journeyActive]); }
/** Close the expanded marker (Esc routing).
 * @group Journey view */
export function closeExpanded() { jrnSelect(-1, true); }
/** Previous / next action (`[` / `]`) — in the storyboard it crosses into the next screen; in the drill it opens the next action.
 * @group Journey view */
export function jrnActionStep(d) {
  if (S.JRN_DRILL) { jrnDrillStep(d); return; }
  if (S.JRN_STORY) jrnStoryStep(d);
}

// ── impact rings on the sheet (B5.4 · dependency-impact §4.3) ────
/**
 * The stop a part of the walk sits in — its column on the Sheet, its stop on the
 * drill's rail: `{ n, t }` (1-based, of the journey's stops), or null when the part
 * belongs to no stop (start-up work, a part before the first screen). A part the
 * band does not draw takes the stop of the nearest drawn part above it.
 *
 * One position, one word (swarm 2026-10-05, finding 3): the drawer used to print
 * the walk's own index (`STEP 232`), a number no other surface shows; the stop is
 * the number the Sheet's column, the drill's rail and the storyboard all print.
 * @group Journey view
 */
export function jrnStopOf(order) {
  const sum = S.JOURNEY && S.JOURNEY.summary;
  if (!sum || order == null || order < 0) return null;
  const find = (o) => { for (const sg of sum.segments) { const m = sg.markers.find((x) => x.stepOrder === o); if (m) return { sg, m }; } return null; };
  let cur = order, hit = find(cur);
  const parent = S.JRN_TREE && S.JRN_TREE.parent;
  for (let guard = 0; !hit && parent && cur != null && cur >= 0 && guard < 64; guard++) { cur = parent[cur]; hit = cur != null && cur >= 0 ? find(cur) : null; }
  if (!hit || hit.m.moment == null) return null;
  const cols = jrnSheetModel(sum).cols;
  const at = cols.findIndex((c) => c.sg === hit.sg && c.mo.index === hit.m.moment);
  return at < 0 ? null : { n: at + 1, t: cols.length };
}
/** `stop n of t` for a part of the walk, or `''` when it sits in no stop. @group Journey view */
export function jrnStopText(order) {
  const st = jrnStopOf(order);
  return st ? t('journey.insp.stopOf').replace('{n}', st.n).replace('{t}', st.t) : '';
}
/**
 * The step a node is drawn at, so an impact row can jump to it instead of
 * re-seeding the panel. The first step that stands on the node wins — a node
 * the walk met several times is one thing, and the earliest place it was met
 * is where a reader starts reading.
 * @group Journey view
 */
export function jrnStepOf(id) {
  if (!S.JOURNEY || !id) return -1;
  const steps = S.JOURNEY.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const n = steps[i] && steps[i].node;
    if (n && n.id === id) return i;
  }
  return -1;
}

/**
 * Ring the cells an open impact answer names. **Shape, not colour**: a solid
 * ring is what uses the seed directly, a dashed ring what reaches it through
 * something else, a dotted ring a place the walk stopped — so the rings read
 * the same in a greyscale print and to a reader who cannot separate the amber
 * from the cyan. The seed itself wears a double ring and the three counts.
 *
 * Drawn over the markers already in the DOM rather than into them, so the same
 * answer rings the rows, the sheet, the ladder and the drill without any of
 * them knowing about impact. Called after every journey render and selection;
 * with no answer open it takes every ring off again.
 * @group Journey view
 * @business Outlines everything that uses the thing you asked about, by how far away it is.
 */
export function jrnImpactRings() {
  const tl = document.getElementById('jrn-tl');
  if (!tl) return;
  const m = S.IMPACT_RINGS;
  const steps = (S.JOURNEY && S.JOURNEY.steps) || [];
  // how many rings this view actually drew: the storyboard has no markers to
  // ring and the drill draws one action at a time, so the panel may not claim
  // rings the reader cannot see
  if (m) m.drawn = 0;
  tl.querySelectorAll('.imp-halo, .imp-more').forEach((el) => el.remove());
  tl.querySelectorAll('[data-order]').forEach((el) => {
    el.classList.remove('imp-1', 'imp-n', 'imp-cut', 'imp-seed');
    if (!m) return;
    const st = steps[+el.dataset.order];
    const id = st && st.node && st.node.id;
    if (!id) return;
    if (id === m.seed) {
      el.classList.add('imp-seed');
      m.drawn++;
      el.insertAdjacentHTML('beforeend', jrnImpactHaloHtml(m));
      return;
    }
    // distance is the outline; being a stop is a second fact and gets a second
    // mark rather than replacing the first — a listed node that the walk also
    // stopped at is both, and neither half may eat the other
    if (m.hop[id] === 1) { el.classList.add('imp-1'); m.drawn++; }
    else if (m.hop[id] > 1) { el.classList.add('imp-n'); m.drawn++; }
    else if (m.cut.has(id)) { el.classList.add('imp-cut'); m.drawn++; }
    if (m.cut.has(id) && m.hop[id]) el.insertAdjacentHTML('beforeend', jrnImpactStopHtml());
  });
}
// written out whole: an attribute assembled from pieces reads as prose to the lint
const JRN_HALO = '<span class="imp-halo" title="';
const JRN_STOPMARK = '<span class="imp-more" title="';
/** The mark on a listed node the walk also stopped at: more stands behind it.
 * @group Journey view */
function jrnImpactStopHtml() {
  return JRN_STOPMARK + esc(def('impact.ring.stop') || '') + '">' + esc('\u22ef') + '</span>';
}
/** The seed's halo: three answers to three questions, which overlap and are never added.
 * @group Journey view */
function jrnImpactHaloHtml(m) {
  const tip = t('impact.halo').replace('{d}', m.direct).replace('{t}', m.through).replace('{c}', m.behind);
  return JRN_HALO + esc(tip) + '">' + esc('\u2191' + m.direct + ' \u223c' + m.through + ' \u22ef' + m.behind) + '</span>';
}

// The measured widths are only true for the window they were measured in, so
// re-measure when it changes — once per frame, never once per resize event.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', () => {
    if (S.jrnFitRaf) return;
    S.jrnFitRaf = requestAnimationFrame(() => { S.jrnFitRaf = 0; jrnFitToWindow(); });
  });
}
/**
 * What the journey's Save control draws: the storyboard, whole — every screen in order, the open screen's actions
 * and the ledger — switching to it first when another view is on, so the reader sees what is saved.
 * @group Journey storyboard
 * @business Saves the journey as its storyboard: every screen in order, as one picture.
 */
async function jrnStoryPicture() {
  if (!S.JOURNEY) return null;
  if (jrnLayout() !== 'storyboard') {
    jrnSetLayout('storyboard');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }
  const el = document.querySelector('#jrn-tl .jrn-story');
  const entry = S.JOURNEY.entry || {};
  return el ? { el, title: (document.getElementById('jrn-title') || {}).textContent || entry.name || '', subject: entry.id ? String(entry.id).split('::').pop() : '' } : null;
}
registerExport('storyboard', jrnStoryPicture);

expose({ openJourney: gotoJourney, closeJourney, jrnToggleGroup, jrnStoryGo, jrnStoryKey, jrnScrollTo, jrnSelect, jrnSelectSegment, jrnToggleFork, jrnToggleForks, jrnForkJump, jrnCopyRecipe, jrnExpandRepeat, jrnNav, jrnSetView, jrnSetBizTab, jrnToggleBizDocs, jrnSetLayout, jrnSetDock, jrnDockGrip, jrnSheetOpen, jrnToggleHelpers, jrnLadderMore, jrnToggleCuts, jrnCutJump, jrnImpactRings, jrnStepOf });
