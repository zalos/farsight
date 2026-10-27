// surfaces/journeys.js — the Journeys front door (`#/journeys`): the state of play, the storylines, the journeys
// organised persona → group, the designs and the entry points. One journey is read on the Map (lanes round
// 2026-10-10, proposal 1: the journey page `#/journeys/<entry>` and its storyboard · timeline · sheet · drill views
// retired into the Map's stops and layouts — surfaces/map-stops.js; an old link is rewritten by the shell,
// lib/route-url.js `overlayToMap`). The journey's drawing the Map's stops reuse lives in lib/journey-draw.js and its
// pure folds in lib/journey-model.js. Everything from the server is untrusted display data → esc().

import { readinessDoorHtml } from '../lib/readiness-door.js';
import { S, expose, esc, jsArg, repoOf, bizLabel, inScope, currentLens, cssId } from '../store.js';
import { t, proseHtml } from '../strings.js';
import { sym } from '../sym.js';
import { vsl, linkHtml } from '../lib/graph-render.js';
import { stateOfPlayShellHtml, mountStateOfPlay } from '../lib/state-of-play.js';
import { walkDoorHtml } from '../lib/tour.js';
import { askBoxHtml, redrawAsk } from '../lib/ask.js';
import { tipAttrs, tipSource } from '../lib/tooltip.js';
import { plainTip, countedHtml, defAttrs } from '../lib/counted.js';
import {
  loadJourneyTree,
  jrnPersonaName,
  jrnGroupName,
  jrnOrgCountsHtml,
  screenThumbHtml,
} from '../lib/journeys-tree.js';
import { filterTree, findStoryline, firstScreenOf } from '../lib/journeys-model.js';
import { jrnWords, jrnDocLinkHtml } from '../lib/journey-draw.js';

// ── surface mount (router-driven) ───────────────────────────────
/**
 * Open a journey — on the Map, the one place a journey is read (lanes round 2026-10-10, proposal 1): its street at
 * the register's own view. Any entry a journey can start from works (a route, a page, a function — *Run journey* on
 * the code map, the entry points below): the Map arrives on the screen that shows it, or walks from it.
 * @group Journey view
 * @business Opens one journey on the Map, where its screens, actions and code are one zoom apart.
 */
function openJourney(id) {
  location.hash = '#/map/' + encodeURIComponent(id);
}

/**
 * Entry points that can run as a journey: routes, pages, and anything tagged
 * @entrypoint — grouped by source, derived from the loaded graph.
 * @group Journey view
 */
function journeyEntries() {
  return S.GRAPH.nodes.filter(
    (n) => inScope(n) && (n.kind === 'route' || n.kind === 'page' || (n.tags || []).includes('entrypoint')),
  );
}

/**
 * The Journeys front door: the state of play, the storylines, the journeys organised persona → group, the designs
 * and the entry points. A chosen journey opens on the Map (an old `#/journeys/<entry>` link is rewritten there by the
 * shell before this surface is asked).
 * @group Journey view
 */
export function mountJourneys(route, el) {
  renderPicker(el);
}

/**
 * Redraw after the scope or the register moved: its entry lists are filtered by the scope and its words come from
 * the catalog.
 * @group Journey view
 */
export function journeysRefresh(_reason, _route) {
  const el = document.getElementById('surface');
  if (el) renderPicker(el);
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
  let html =
    '<div class="set-wrap"><h1>' +
    esc(t('journeys.pickerTitle')) +
    '</h1><p class="sub">' +
    esc(t('journeys.pickerSub')) +
    '</p>' +
    // READ THIS IF beside the STATE OF PLAY, and the words this application leans on (round 2026-10-10)
    stateOfPlayShellHtml() +
    // Ask, under the state of play (round 2026-10-10, proposal 8): a question answered from the graph
    '<div class="set-sec jrn-ask">' +
    askBoxHtml({ id: 'front', repo: S.scope !== 'all' && S.scope.length === 1 ? S.scope[0] : '' }) +
    '</div>' +
    '<div id="jrn-storylines"></div>' +
    '<div id="jrn-organised"></div>' +
    '<div id="jrn-designs"></div>';
  const repos = Object.keys(byRepo).sort();
  if (!repos.length)
    html += '<div class="set-sec"><p class="set-note">' + esc(t('journeys.pickerEmpty')) + '</p></div>';
  else
    html +=
      '<div class="set-sec"><h2>' +
      esc(t('journeys.entryPoints')) +
      '</h2><p class="set-note">' +
      esc(t('journeys.entryPointsSub')) +
      '</p></div>';
  repos.forEach((repo) => {
    html += '<div class="set-sec"><h2>' + esc(repo) + '</h2>';
    byRepo[repo].slice(0, 60).forEach((n) => {
      html +=
        '<button class="rel" onclick="openJourney(' +
        jsArg(n.id) +
        ')"><span class="rk">' +
        esc(n.kind) +
        '</span>' +
        esc(bizLabel(n)) +
        ' <span style="font-family:var(--mono);font-size:10px;color:var(--dim)">' +
        esc(n.name) +
        '</span>' +
        (n.loc
          ? '<span style="float:right;font-family:var(--mono);font-size:9.5px;color:var(--dim)">' +
            esc(n.loc.path) +
            ':' +
            n.loc.line +
            vsl(repoOf(n), n.loc.path, n.loc.line) +
            '</span>'
          : '') +
        '</button>';
    });
    if (byRepo[repo].length > 60)
      html += '<p class="set-note">+ ' + (byRepo[repo].length - 60) + ' more — narrow the scope</p>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
  redrawAsk(el);
  // both reads start now; the state of play paints first, then the journeys under it — one order, so nothing
  // the reader is pointing at moves when the card above it fills
  jrnFrontDoorData();
  mountStateOfPlay(jrnScopeParam()).finally(() => jrnMountDesigns());
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
  host.innerHTML =
    '<div class="set-sec"><h2>' +
    esc(t('design.title')) +
    '</h2>' +
    '<p class="set-note">' +
    esc(t('design.sub')) +
    '</p>' +
    data.designs.map(jrnDesignCardHtml).join('') +
    '</div>';
  const org = document.getElementById('jrn-organised');
  if (!org || !got || !got.tree) return;
  JRN_ORG = { tree: got.tree, designs: data.designs, live: got.live };
  const stories = document.getElementById('jrn-storylines');
  if (stories) {
    stories.innerHTML = jrnStorylinesHtml(JRN_ORG);
    jrnShowStoryline(stories, got.tree, (S.route || {}).storyline);
  }
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
  const stepKey = currentLens() === 'business' ? 'journeys.storyline.bizStepOf' : 'journeys.storyline.stepOf';
  let html =
    '<div class="set-sec jrn-stories"><h2' +
    defAttrs('journeys.storyline.title') +
    '>' +
    esc(t('journeys.storyline.title')) +
    '</h2>' +
    '<p class="set-note">' +
    esc(t('journeys.storyline.sub')) +
    ' ' +
    (tree.counts && tree.counts.storylines
      ? countedHtml(tree.counts.storylines, '/api/journeys', { cls: 'jrn-org-n' })
      : '') +
    '</p>';
  for (const st of list) {
    const steps = st.journeys || [];
    const chips = steps
      .map((j, i) => {
        const built = j.total > 0 && j.built >= j.total;
        const cls = built ? 'ok' : j.built > 0 ? 'warn' : 'stub';
        const where = t(stepKey)
          .replace('{n}', i + 1)
          .replace('{m}', steps.length);
        const status = t(j.statusKey || 'journey.status.designedNotBuilt')
          .replace('{n}', j.built || 0)
          .replace('{m}', j.total || 0);
        return (
          (i ? '<span class="jrn-story-then" aria-hidden="true">›</span>' : '') +
          '<a class="api-chip jrn-story-step ' +
          cls +
          '" href="' +
          esc('#/map/' + encodeURIComponent(j.nodeId)) +
          '"' +
          tipAttrs({ text: where + ' · ' + (j.name || j.id) + ' · ' + status }) +
          '><b>' +
          (i + 1) +
          '</b>' +
          esc(j.name || j.id) +
          '</a>'
        );
      })
      .join('');
    // its branches (swarm-fixes 2026-10-05 §6), indented under the chain: the step each leaves from, its condition,
    // its journey and the step it comes back to
    const branches = (st.branches || [])
      .map((b) => {
        const at = steps.findIndex((j) => j.nodeId === b.branchOf);
        const back = b.rejoins ? steps.findIndex((j) => j.nodeId === b.rejoins) : -1;
        const built = b.total > 0 && b.built >= b.total;
        const cls = built ? 'ok' : b.built > 0 ? 'warn' : 'stub';
        const status = t(b.statusKey || 'journey.status.designedNotBuilt')
          .replace('{n}', b.built || 0)
          .replace('{m}', b.total || 0);
        return (
          '<li class="jrn-story-branch" data-branch="' +
          esc(b.id) +
          '" data-of="' +
          esc(b.branchOf) +
          '">' +
          sym('fork') +
          '<span class="of"' +
          defAttrs('journeys.storyline.branchOf') +
          '>' +
          (at >= 0 ? '<b>' + (at + 1) + '</b> ' : '') +
          esc(t('journeys.storyline.branchOf').replace('{name}', b.branchOfName || '')) +
          '</span>' +
          '<span class="when"' +
          defAttrs('journeys.storyline.when') +
          '>' +
          esc(t('journeys.storyline.when').replace('{when}', b.when)) +
          '</span>' +
          '<a class="api-chip jrn-story-step ' +
          cls +
          '" href="' +
          esc('#/map/' + encodeURIComponent(b.nodeId)) +
          '"' +
          tipAttrs({ text: t('journeys.storyline.branch') + ' · ' + (b.name || b.id) + ' · ' + status }) +
          '>' +
          esc(b.name || b.id) +
          '</a>' +
          '<span class="back"' +
          defAttrs(b.rejoins ? 'journeys.storyline.rejoins' : 'journeys.storyline.noReturn') +
          '>' +
          (b.rejoins
            ? (back >= 0 ? '<b>' + (back + 1) + '</b> ' : '') +
              esc(t('journeys.storyline.rejoins').replace('{name}', b.rejoinsName || ''))
            : esc(t('journeys.storyline.noReturn'))) +
          '</span></li>'
        );
      })
      .join('');
    // its picture: the first journey's first screen, or the placeholder — never an empty box
    const thumb = steps.length ? screenThumbHtml(firstScreenOf(org.designs, steps[0].nodeId), 'jrn-story-thumb') : '';
    html +=
      '<div class="dsg-flow jrn-story" data-storyline="' +
      esc(st.id) +
      '">' +
      thumb +
      '<div class="dsg-flow-head">' +
      '<span class="dsg-flow-name">' +
      esc(st.name || st.id) +
      '</span>' +
      '<span class="jrn-pcount">' +
      jrnOrgCountsHtml(st.counts) +
      '</span></div>' +
      (st.description ? '<p class="dsg-flow-desc">' + esc(jrnWords(st.description)) + '</p>' : '') +
      (chips
        ? '<div class="dsg-chips jrn-story-steps">' + chips + '</div>'
        : '<p class="set-note">' + esc(t('journeys.storyline.empty')) + '</p>') +
      (branches ? '<ul class="jrn-story-branches">' + branches + '</ul>' : '') +
      '<div class="jrn-story-go">' +
      '<a class="rel jrn-story-map" href="' +
      esc('#/map?storyline=' + encodeURIComponent(st.id)) +
      '">' +
      sym('open') +
      ' ' +
      esc(t('journeys.storyline.openMap')) +
      '</a>' +
      readinessDoorHtml(st.id, 'jrn-story-ready', st.repo) +
      walkDoorHtml({ storyline: st.id }, 'jrn-story-walk') +
      (steps.length
        ? '<button class="rel jrn-story-first" onclick="openJourney(' +
          jsArg(steps[0].nodeId) +
          ')">' +
          sym('start') +
          ' ' +
          esc(t('journeys.storyline.openFirst')) +
          '</button>'
        : '') +
      '</div></div>';
  }
  return html + '</div>';
}

/**
 * `#/journeys?storyline=<id>` (a link to the front door at one storyline): the card of that storyline is marked and
 * scrolled to; a storyline nobody declares is said so above the cards, with a door to each one there is.
 */
function jrnShowStoryline(host, tree, id) {
  if (!id) return;
  const story = findStoryline(tree, id);
  if (story) {
    const card = [...host.querySelectorAll('.jrn-story[data-storyline]')].find(
      (el) => el.dataset.storyline === story.id,
    );
    if (card) {
      card.classList.add('hot');
      card.scrollIntoView({ block: 'center' });
    }
    return;
  }
  const list = (tree && tree.storylines) || [];
  const sec = host.querySelector('.jrn-stories') || host;
  const note =
    '<p class="set-note jrn-story-unknown"><span' +
    defAttrs('journeys.storyline.unknown') +
    '>' +
    esc(t('journeys.storyline.unknown').replace('{id}', id)) +
    '</span> ' +
    (list.length
      ? '<span' +
        defAttrs('journeys.storyline.known') +
        '>' +
        esc(t('journeys.storyline.known')) +
        '</span> ' +
        list
          .map(
            (x) => '<a href="' + esc('#/journeys?storyline=' + encodeURIComponent(x.id)) + '">' + esc(x.name) + '</a>',
          )
          .join(' · ')
      : '<span' + defAttrs('journeys.storyline.noneKnown') + '>' + esc(t('journeys.storyline.noneKnown')) + '</span>') +
    '</p>';
  if (sec.classList && sec.classList.contains('jrn-stories'))
    sec.querySelector('h2').insertAdjacentHTML('afterend', note);
  else sec.insertAdjacentHTML('afterbegin', '<div class="set-sec jrn-stories">' + note + '</div>');
}

// ── the organised section: persona → group → journeys ───────────
/** The last tree the front door drew, kept so a group toggle need not refetch. */
let JRN_ORG = null;
const JRN_FOLD_KEY = 'fs-jrn-groups';
/** The groups a reader folded, by `persona/group` id — remembered in this browser. */
function jrnFoldedGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(JRN_FOLD_KEY) || '[]'));
  } catch {
    return new Set();
  }
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
  for (const d of org.designs || [])
    for (const f of d.flows || []) {
      rowsOf.set(f.nodeId, d.screens || []);
      repoByFlow.set(f.nodeId, d.repo);
    }
  const folded = jrnFoldedGroups();
  const multi = new Map();
  for (const p of tree.personas)
    for (const g of p.groups)
      for (const j of g.journeys) {
        if (!multi.has(j.nodeId)) multi.set(j.nodeId, []);
        if (!multi.get(j.nodeId).includes(p)) multi.get(j.nodeId).push(p);
      }
  let html =
    '<div class="set-sec jrn-org"><h2' +
    defAttrs('journeys.persona.title') +
    '>' +
    esc(t('journeys.persona.title')) +
    '</h2>' +
    '<p class="set-note">' +
    esc(t('journeys.persona.sub')) +
    ' ' +
    countedHtml(tree.counts.journeys, '/api/journeys', { cls: 'jrn-org-n' }) +
    '<span class="jrn-org-sep"> · </span>' +
    countedHtml(tree.counts.personas, '/api/journeys', { cls: 'jrn-org-n' }) +
    '<span class="jrn-org-sep"> · </span>' +
    countedHtml(tree.counts.groups, '/api/journeys', { cls: 'jrn-org-n' }) +
    '</p>' +
    (tree.derived ? '<p class="set-note">' + esc(t('portfolio.personaDerived')) + '</p>' : '');
  if (filtered) {
    const what = [
      route.persona ? jrnPersonaName(tree.personas.find((p) => p.id === route.persona) || { name: route.persona }) : '',
      route.group
        ? jrnGroupName(
            tree.personas.flatMap((p) => p.groups).find((g) => g.id === route.group) || { name: route.group },
          )
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    html +=
      '<p class="set-note jrn-org-filter">' +
      esc(t('journeys.persona.filtered').replace('{what}', what)) +
      ' <a href="' +
      esc(location.hash.split('?')[0] || '#/journeys') +
      '">' +
      esc(t('journeys.persona.showAll')) +
      '</a></p>';
  }
  if (!shown.personas.length) return html + '<p class="set-note">' + esc(t('journeys.persona.empty')) + '</p></div>';
  for (const p of shown.personas) {
    html +=
      '<section class="jrn-persona" data-persona="' +
      esc(p.id) +
      '">' +
      '<div class="jrn-phead"><a class="hud-label jrn-pname" href="' +
      esc('#/journeys?persona=' + encodeURIComponent(p.id)) +
      '">' +
      esc(jrnPersonaName(p)) +
      '</a>' +
      (p.id && !p.declared
        ? '<span class="api-chip"' +
          defAttrs('journeys.persona.undeclared') +
          '>' +
          esc(t('journeys.persona.undeclared')) +
          '</span>'
        : '') +
      '<span class="jrn-pcount">' +
      jrnOrgCountsHtml(p.counts) +
      '</span></div>' +
      (p.description ? '<p class="dsg-flow-desc">' + proseHtml(p.description) + '</p>' : '');
    const heads = p.groups.length > 1;
    for (const g of p.groups) {
      const key = p.id + '/' + g.id;
      const isFolded = heads && folded.has(key);
      const cards = g.journeys
        .map((f) => {
          const others = (multi.get(f.nodeId) || []).filter((x) => x !== p);
          const also = others.length
            ? '<span class="api-chip"' +
              defAttrs('journeys.persona.alsoUnder') +
              '>' +
              esc(t('journeys.persona.alsoUnder').replace('{names}', others.map(jrnPersonaName).join(' · '))) +
              '</span>'
            : '';
          return jrnFlowCardHtml(f, rowsOf.get(f.nodeId) || [], f.repo || repoByFlow.get(f.nodeId), !!f.pinned, also);
        })
        .join('');
      if (!heads) {
        html += '<div class="jrn-group" data-group="' + esc(g.id) + '">' + cards + '</div>';
        continue;
      }
      const bodyId = 'jrn-g-' + cssId(key);
      html +=
        '<div class="jrn-group' +
        (isFolded ? ' folded' : '') +
        '" data-group="' +
        esc(g.id) +
        '">' +
        '<div class="jrn-ghead"><button type="button" class="jrn-gtoggle" aria-expanded="' +
        !isFolded +
        '" aria-controls="' +
        esc(bodyId) +
        '"' +
        ' data-key="' +
        esc(key) +
        '" onclick="jrnToggleGroup(this)" aria-label="' +
        esc(t('journeys.persona.toggle') + ' · ' + jrnGroupName(g)) +
        '"><span class="jrn-chev" aria-hidden="true"></span>' +
        '<span class="jrn-gname">' +
        esc(jrnGroupName(g)) +
        '</span></button>' +
        '<span class="jrn-gcount">' +
        jrnOrgCountsHtml(g.counts) +
        '</span></div>' +
        (g.description ? '<p class="dsg-flow-desc">' + proseHtml(g.description) + '</p>' : '') +
        '<div class="jrn-gbody" id="' +
        esc(bodyId) +
        '"' +
        (isFolded ? ' hidden' : '') +
        '>' +
        cards +
        '</div></div>';
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
  if (fold) set.add(key);
  else set.delete(key);
  try {
    localStorage.setItem(JRN_FOLD_KEY, JSON.stringify([...set]));
  } catch {
    /* a private window: the fold holds for this visit */
  }
}

/** The front door's two answers, one read per scope and sync: a picker drawn twice in a row (a mount, then
 * a register or lens redraw) awaits the same read and paints back to back, never one under the pointer later. */
const JRN_DOOR = new Map();
function jrnFrontDoorData() {
  const key = jrnScopeParam() + '@' + ((S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) || '');
  if (!JRN_DOOR.has(key)) {
    JRN_DOOR.clear();
    JRN_DOOR.set(
      key,
      (async () => {
        const data = await fetch('/api/design?scope=' + encodeURIComponent(jrnScopeParam())).then((r) => r.json());
        if (!data || data.error || !Array.isArray(data.designs) || !data.designs.length) return null;
        // the journeys themselves, organised persona → group above the manifests (§4.4) — read
        // before either is drawn, so the page lands in one paint and nothing moves under the pointer
        let got;
        try {
          got = await loadJourneyTree(data.designs);
        } catch (err) {
          got = null;
        }
        return { data, got };
      })().catch(() => {
        JRN_DOOR.delete(key);
        return null;
      }),
    );
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
  const keys = (c.flows != null ? ['flows'] : []).concat([
    'screens',
    'designed',
    'built',
    'designOnly',
    'codeOnly',
    'drift',
  ]);
  // every count opens its tip — what it counts, over what, from where; drift adds
  // its breakdown by kind of difference, which is the half a reader acts on
  // (story swarm 2026-09-25: *18 DRIFT is the one number that won't explain itself*)
  const counts =
    '<div class="api-counts">' +
    keys
      .map(
        (k) =>
          '<span class="api-count' +
          (k === 'drift' && c[k] > 0 ? ' warn' : '') +
          '"' +
          plainTip(
            c[k] || 0,
            'design.count.' + k,
            'design.scope.manifest',
            '/api/design',
            k === 'drift' ? designDriftRows([...(d.screens || []), ...(d.flows || [])]) : null,
          ) +
          '><b>' +
          (c[k] || 0) +
          '</b><span>' +
          esc(t('design.count.' + k)) +
          '</span></span>',
      )
      .join('') +
    '</div>';
  const rows = d.screens || [];
  const notBuilt = rows.filter((s) => s.status === 'design-only');
  const built = rows.filter((s) => s.status === 'both');
  const isUrl = /^https?:\/\//.test(d.manifestPath || '');
  return (
    '<div class="dsg-card"><h3>' +
    sym('design') +
    esc(d.name || '') +
    '</h3>' +
    '<div class="dsg-path">' +
    esc(d.repo || '') +
    ' · ' +
    esc(d.manifestPath || '') +
    (d.manifestPath && !isUrl ? vsl(d.repo, d.manifestPath, 1) : '') +
    '</div>' +
    (d.figmaFile ? '<div class="dsg-path">' + linkHtml(d.figmaFile, t('design.openFigma')) + '</div>' : '') +
    counts +
    (notBuilt.length
      ? '<div class="dsg-list"><span class="hud-label">' +
        esc(t('design.notBuilt')) +
        '</span>' +
        notBuilt.map(jrnDesignRowHtml).join('') +
        '</div>'
      : '') +
    (built.length
      ? '<div class="dsg-list"><span class="hud-label">' +
        esc(t('design.built')) +
        '</span>' +
        built.map(jrnDesignRowHtml).join('') +
        '</div>'
      : '') +
    '</div>'
  );
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
  (rows || []).forEach((r) => {
    if (r.designId) byId[r.designId] = r;
  });
  const chips = (f.screens || [])
    .map((id, i) => {
      const r = byId[id] || {};
      const cls = r.status === 'both' ? 'ok' : r.status === 'design-only' ? 'stub' : '';
      // a design id is how the design files the screen: the business register reads its name
      // (and the id only when the design gave it no name), as the journey's own header does
      const words = currentLens() === 'business' ? esc(r.name || id) : esc(id) + (r.name ? ' · ' + esc(r.name) : '');
      return '<span class="api-chip ' + cls + '"><b>' + (i + 1) + '</b>' + words + '</span>';
    })
    .join('');
  // the surface carries each doc's title beside its path (R21); an older server sends paths only
  const docs = (f.docLinks || f.docs || []).map((d) => jrnDocLinkHtml(repo, d)).join('');
  // one status word for a flow, the same one MCP prints: built · partly built
  // n of m · designed, not built (never "not built" of a whole flow)
  const built = f.built != null ? f.built : 0;
  const total = f.total != null ? f.total : (f.screens || []).length;
  const statusKey =
    total > 0 && built >= total
      ? 'journey.status.built'
      : built > 0
        ? 'journey.status.partly'
        : 'journey.status.designedNotBuilt';
  const statusText = t(statusKey).replace('{n}', built).replace('{m}', total);
  return (
    '<div class="dsg-flow' +
    (pinned ? ' pinned' : '') +
    '"><div class="dsg-flow-head">' +
    '<span class="dsg-flow-name">' +
    esc(f.name || f.id || '') +
    '</span>' +
    (pinned ? '<span class="pf-pin">' + esc(t('portfolio.pinned')) + '</span>' : '') +
    '<span class="api-chip ' +
    (statusKey === 'journey.status.built' ? 'ok' : 'stub') +
    '">' +
    esc(statusText) +
    '</span>' +
    (f.phase ? '<span class="api-chip">' + esc(t('design.phase')) + ' ' + esc(f.phase) + '</span>' : '') +
    (extra || '') +
    // the status word already carries n of m when it is partly built — only a
    // fully built flow needs the count spelled out beside it
    (statusKey === 'journey.status.built'
      ? '<span class="dsg-sub">' + esc(t('design.screensBuilt').replace('{b}', built).replace('{n}', total)) + '</span>'
      : '') +
    '</div>' +
    (f.description && proseHtml(f.description) ? '<p class="dsg-flow-desc">' + proseHtml(f.description) + '</p>' : '') +
    (chips ? '<div class="dsg-chips">' + chips + '</div>' : '') +
    (docs ? '<div class="dsg-docs">' + docs + '</div>' : '') +
    (f.nodeId
      ? '<button class="rel" onclick="openJourney(' +
        jsArg(f.nodeId) +
        ')">' +
        sym('start') +
        ' ' +
        esc(t('journey.openJourney')) +
        '</button>'
      : '') +
    (f.nodeId ? walkDoorHtml({ flow: f.nodeId }, 'jrn-walk') : '') +
    '</div>'
  );
}
/**
 * A drift count's breakdown: one row per kind of difference, in words, with how
 * many of that kind — the rows sum to the count they explain.
 * @group Journey view
 */
function designDriftRows(rows) {
  const by = {};
  for (const r of rows) for (const x of r.drift || []) by[x.kind] = (by[x.kind] || 0) + 1;
  return Object.keys(by)
    .sort((a, b) => by[b] - by[a] || (a < b ? -1 : 1))
    .map((k) => [t('design.drift.' + k), by[k]]);
}
/**
 * One screen row in the Designs section — its design id, name, route and
 * drift count; clicking runs that screen as a journey (a design-only screen
 * runs entirely as planned steps).
 * @group Journey view
 */
function jrnDesignRowHtml(s) {
  const drift = (s.drift || []).length;
  return (
    '<button class="rel" onclick="openJourney(' +
    jsArg(s.nodeId) +
    ')">' +
    (s.designId ? '<span class="dsg-id">' + esc(s.designId) + '</span>' : '') +
    esc(s.name || '') +
    (s.route ? '<span class="dsg-sub">' + esc(s.route) + '</span>' : '') +
    (drift
      ? '<span class="dsg-sub"' +
        // inside a button: the tip opens on hover and is not a second tab stop in the row
        tipAttrs({
          number: {
            count: drift,
            of: 'design.count.drift',
            scope: 'design.scope.screen',
            source: tipSource('/api/design'),
            breakdown: { rows: designDriftRows([s]) },
          },
          noFocus: true,
        }) +
        '>' +
        sym('warning') +
        ' ' +
        drift +
        ' ' +
        esc(t('design.count.drift')) +
        '</span>'
      : '') +
    '</button>'
  );
}

expose({ openJourney, jrnToggleGroup });
