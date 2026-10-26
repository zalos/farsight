// surfaces/map-compare.js — compare two syncs on a storyline, on the Map (round 2026-10-10, proposal 7).
//
// A *Compare* control beside the storyline picker (only while a storyline is drawn), the change chips on the
// storyline's cards — the chain's covers and the lanes' stage cards — and a panel on the right, *what changed on this
// storyline*: the two syncs, the count by kind, each change a sentence with its door. Everything is one answer of
// `GET /api/compare` (core storylineDiff); the address carries it as `?compare=<a>..<b>`. The board draws the later
// sync: when that is not the served one, the Map reads its journeys `asof` it (map.js `compareAsOf`).
//
// The Map owns the board, the chrome, the link and the redraws; this module answers with HTML and paints chips into
// what the Map drew. Every word is the catalog's, every number a `Counted` with its tip.

import { esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from '../lib/tooltip.js';
import { countedHtml } from '../lib/counted.js';
import { gateAttrs } from '../lib/gate-card.js';
import {
  parseCompare,
  compareParam,
  compareOfRaw,
  compareQuery,
  chipsFor,
  stageDeltas,
  entryOf,
  sentenceParts,
  doorHref,
  compareSubject,
} from '../lib/compare-model.js';

const API = '/api/compare';
const biz = () => currentLens() === 'business';
const fill = (key, vars) =>
  Object.entries(vars || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));

/** The comparison on screen: what the address asked, what the server answered, and the menu's state. */
export const CMP = {
  /** `{ from, to }` from `?compare=`, or null */
  spec: null,
  /** the storyline it was asked for */
  storyline: null,
  /** the `/api/compare` answer, or null while it is asked */
  data: null,
  /** a sentence when the server could not compare (a sync not held, no storyline at either end) */
  error: null,
  loading: false,
  menu: false,
  /** the syncs the history holds, newest first (from the last answer, for the menu) */
  syncs: [],
  gen: 0,
  /** the storyline and spec the answer in hand was asked for (the Map asks again only when it moves) */
  key: null,
};

/** The comparison the address names, read on mount and on every route move. */
export function readCompare(raw) {
  return parseCompare(compareOfRaw(raw));
}

/** The value the address carries for the comparison on screen, or null. */
export function compareHashValue() {
  return CMP.spec ? compareParam(CMP.spec) : null;
}

/** Whether the board is comparing (a storyline is drawn and an answer is in hand). */
export function comparing() {
  return !!(CMP.spec && CMP.data && CMP.data.diff);
}

/**
 * Ask the server for the comparison on `storyline`; `done(answer)` once it lands (also on an error, with null).
 * A newer ask makes an older answer moot.
 */
export function loadCompare(storyline, repo, done) {
  if (!CMP.spec || !storyline) {
    CMP.data = null;
    CMP.error = null;
    CMP.loading = false;
    done(null);
    return;
  }
  const gen = ++CMP.gen;
  CMP.storyline = storyline;
  CMP.loading = true;
  CMP.error = null;
  fetch(compareQuery(storyline, CMP.spec, repo))
    .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
    .then(({ ok, body }) => {
      if (gen !== CMP.gen) return;
      CMP.loading = false;
      if (body && Array.isArray(body.syncs)) CMP.syncs = body.syncs;
      if (!ok) {
        CMP.data = null;
        CMP.error = (body && body.error) || t('compare.panel.unheld').replace('{sync}', '?');
        done(null);
        return;
      }
      // no green run to compare from: the absence word and why, in the panel (the server answers it, never a 404)
      if (body && body.noGreen) {
        CMP.data = null;
        CMP.error = t('journey.absent.notIndexed') + ' · ' + (body.sentence || '');
        done(null);
        return;
      }
      CMP.data = body;
      done(body);
    })
    .catch((err) => {
      if (gen !== CMP.gen) return;
      CMP.loading = false;
      CMP.data = null;
      CMP.error = String((err && err.message) || err);
      done(null);
    });
}

/** Set the comparison (null ends it). The Map writes the address and asks again. */
export function setCompareSpec(spec) {
  CMP.spec = spec;
  CMP.menu = false;
  if (!spec) {
    CMP.data = null;
    CMP.error = null;
  }
}

/** The sync the board must be drawn at, when the later end is not the one the server serves; else null. */
export function compareAsOf() {
  const to = CMP.data && CMP.data.to;
  return to && to.served === false && to.sync != null ? to.sync : null;
}

// ── the control ────────────────────────────────────────────────────────────

function endWords(e) {
  if (!e) return '';
  return 'sync ' + (e.sync != null ? e.sync : '?');
}
/** The control's current value: *sync a → sync b · since <day>*, or *off*. */
function currentWords() {
  if (!CMP.spec) return t('compare.control.off');
  if (!CMP.data) return CMP.loading ? t('compare.loading') : CMP.spec.from + ' → ' + CMP.spec.to;
  const a = CMP.data.from,
    b = CMP.data.to;
  const range = fill('compare.control.range', { a: a.sync, b: b.sync });
  const day = a.at ? String(a.at).slice(0, 10) : '';
  return range + (day ? ' · ' + fill('compare.control.since', { date: a.label || day }) : '');
}

/**
 * The Compare control: the word, the current value, and a menu of ways to choose the earlier end — the sync
 * before, a sync the history holds, since the last green run, since a day, since a release, off. Drawn only while
 * a storyline is.
 */
export function compareToolHtml(storyline) {
  if (!storyline) return '';
  const on = !!CMP.spec;
  const item = (act, words, tip, extra) =>
    '<button type="button" class="map-seg" data-act="' +
    act +
    '"' +
    (extra || '') +
    tipAttrs({ ...tip, noFocus: true }) +
    '>' +
    esc(words) +
    '</button>';
  const served = CMP.data && CMP.data.to ? CMP.data.to.sync : null;
  const syncs = (CMP.syncs || []).filter((s) => served == null || s.sync < served).slice(0, 8);
  const menu =
    '<span class="map-cmp-menu" role="menu">' +
    item('cmp-pick', t('compare.choice.previous'), { key: 'compare.choice.previous' }, ' data-from="previous"') +
    syncs
      .map((s) =>
        item(
          'cmp-pick',
          fill('compare.choice.sync', { n: s.sync, date: String(s.at || '').slice(0, 10) }),
          { key: 'compare.choice.sync' },
          ' data-from="' + s.sync + '"',
        ),
      )
      .join('') +
    item('cmp-pick', t('compare.choice.lastGreen'), { key: 'compare.choice.lastGreen' }, ' data-from="last-green"') +
    item('cmp-date', t('compare.choice.date'), { key: 'compare.choice.date' }) +
    item('cmp-tag', t('compare.choice.tag'), { key: 'compare.choice.tag' }) +
    (on ? item('cmp-off', t('compare.control.off'), { key: 'compare.control.off' }) : '') +
    '</span>';
  return (
    '<span class="map-cmp-pick' +
    (on ? ' on' : '') +
    (CMP.menu ? ' open' : '') +
    '" data-export-skip>' +
    '<span class="hud-label"' +
    tipAttrs({ key: 'compare.control', noFocus: true }) +
    '>' +
    esc(t('compare.control')) +
    '</span>' +
    '<button type="button" class="map-tb map-cmp-cur" data-act="cmp-menu" aria-haspopup="menu" aria-expanded="' +
    !!CMP.menu +
    '"' +
    tipAttrs({ key: on && CMP.data ? 'compare.control.range' : 'compare.control', noFocus: true }) +
    '>' +
    esc(currentWords()) +
    '</button>' +
    menu +
    '</span>'
  );
}

/**
 * A click in the toolbar that belongs to the control: returns the new spec to set (`undefined` = not ours, `null` =
 * off), or `'menu'` when only the menu moved.
 */
export function compareChromeClick(b) {
  switch (b.dataset.act) {
    case 'cmp-menu':
      CMP.menu = !CMP.menu;
      return 'menu';
    case 'cmp-pick':
      return { from: b.dataset.from, to: 'now' };
    case 'cmp-date': {
      const v = window.prompt(
        t('compare.choice.datePrompt'),
        CMP.data && CMP.data.from && CMP.data.from.at ? String(CMP.data.from.at).slice(0, 10) : '',
      );
      return v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? { from: v.trim(), to: 'now' } : 'menu';
    }
    case 'cmp-tag': {
      const v = window.prompt(t('compare.choice.tagPrompt'), '');
      return v && v.trim() ? { from: 'tag:' + v.trim(), to: 'now' } : 'menu';
    }
    case 'cmp-off':
      return null;
    default:
      return undefined;
  }
}

// ── the chips ──────────────────────────────────────────────────────────────

/** One chip: its words in the register on screen, its tone, and the change's sentences as its tip. */
function chipHtml(c, deltas) {
  const words = fill(c.key, c.vars);
  const tip = deltas
    .filter((d) => d.kind === c.kind)
    .map((d) => sentenceText(d))
    .join(' · ');
  return (
    '<span class="map-chip map-cmp-chip t-' +
    c.tone +
    '" data-cmp-kind="' +
    esc(c.kind) +
    '"' +
    tipAttrs({ text: t('compare.kind.' + c.kind) + ' · ' + tip, noFocus: true }) +
    '>' +
    esc(words) +
    '</span>'
  );
}

/** The chips a journey's cover carries, or '' when it carries none. */
export function coverChipsHtml(flow) {
  if (!comparing()) return '';
  const diff = CMP.data.diff;
  const entry = (diff.byJourney || []).find((j) => j.flow === flow);
  if (!entry) return '';
  const deltas = diff.deltas.filter((d) => d.journeys.includes(flow));
  return (
    '<span class="map-cmp-chips" data-cmp-for="' +
    esc(flow) +
    '">' +
    chipsFor(entry, biz())
      .map((c) => chipHtml(c, deltas))
      .join('') +
    '</span>'
  );
}

/** Paint the chips into every cover the Map drew (the chain layout). */
export function paintCompareCovers(world) {
  if (!world) return;
  world.querySelectorAll('.map-cmp-chips').forEach((n) => n.remove());
  if (!comparing()) return;
  world.querySelectorAll('.map-dcover[data-enter]').forEach((cover) => {
    const html = coverChipsHtml(cover.dataset.enter);
    const agg = cover.querySelector('.agg');
    if (html && agg) agg.insertAdjacentHTML('afterend', '<div class="agg map-cmp-row">' + html + '</div>');
  });
}

/** Paint the chips into every stage card of the lanes: the changes on that screen, a journey's verdict on its first. */
export function paintCompareLanes(root) {
  if (!root) return;
  root.querySelectorAll('.map-cmp-chips').forEach((n) => n.remove());
  root.querySelectorAll('.ln-stage.cmp-on').forEach((n) => n.classList.remove('cmp-on'));
  if (!comparing()) return;
  const diff = CMP.data.diff;
  const seen = new Set();
  root.querySelectorAll('.ln-stage[data-flow]').forEach((st) => {
    const flow = st.dataset.flow;
    const first = !seen.has(flow);
    seen.add(flow);
    const deltas = stageDeltas(diff, flow, st.dataset.name, first);
    if (!deltas.length) return;
    const built = (diff.byJourney || []).find((j) => j.flow === flow);
    const entry = entryOf(deltas, built && built.built ? { built: built.built } : {});
    // the changes first, under the name: a comparison is about them, and the card's height is fixed
    const ttl = st.querySelector('.ttl');
    if (ttl) {
      ttl.insertAdjacentHTML(
        'afterend',
        '<div class="ln-chips map-cmp-chips">' +
          chipsFor(entry, biz())
            .map((c) => chipHtml(c, deltas))
            .join('') +
          '</div>',
      );
      st.classList.add('cmp-on');
    }
  });
}

// ── the panel ──────────────────────────────────────────────────────────────

/** A change's sentence as text in the register on screen. */
function sentenceText(d) {
  const s = biz() ? d.biz : d.sentence;
  return sentenceParts(t(s.key), s)
    .map((p) => p.text)
    .join('');
}
/** A change's sentence as HTML: identifiers set apart in the code face (never in business). */
function sentenceHtml(d) {
  const s = biz() ? d.biz : d.sentence;
  return sentenceParts(t(s.key), s)
    .map((p) => (p.code ? '<code>' + esc(p.text) + '</code>' : esc(p.text)))
    .join('');
}
function doorHtml(d) {
  const words = t(d.door.key);
  if (d.door.kind === 'gate' && d.door.node)
    return '<span class="rel map-cmp-door"' + gateAttrs(d.door.node) + '>' + esc(words) + ' ›</span>';
  const href = doorHref(d.door);
  return href
    ? '<a class="rel map-cmp-door" href="' +
        esc(href) +
        '"' +
        tipAttrs({ key: d.door.key, noFocus: true }) +
        '>' +
        esc(words) +
        ' ›</a>'
    : '';
}

/** The panel's HTML for the answer in hand (or the sentence saying why there is none). */
export function comparePanelHtml() {
  const close =
    '<button type="button" class="map-cmp-x" data-act="cmp-off" aria-label="' +
    esc(t('compare.panel.close')) +
    '"' +
    tipAttrs({ key: 'compare.panel.close', noFocus: true }) +
    '>✕</button>';
  const title =
    '<div class="hud-label map-cmp-title"' +
    tipAttrs({ key: 'compare.panel.title', noFocus: true }) +
    '>' +
    esc(t('compare.panel.title')) +
    '</div>';
  if (CMP.loading && !CMP.data) return close + title + '<p class="map-cmp-note">' + esc(t('compare.loading')) + '</p>';
  if (CMP.error)
    return (
      close +
      title +
      '<p class="map-cmp-note map-cmp-err"' +
      tipAttrs({ key: 'journey.absent.notIndexed', noFocus: true }) +
      '>' +
      esc(CMP.error) +
      '</p>'
    );
  if (!comparing()) return '';
  const { from, to, diff } = CMP.data;
  const day = from.at ? String(from.at).slice(0, 10) : '';
  const range =
    '<div class="map-cmp-range">' +
    esc(fill('compare.control.range', { a: from.sync, b: to.sync })) +
    (day ? ' · ' + esc(fill('compare.control.since', { date: from.label || day })) : '') +
    '</div>';
  const count =
    '<div class="map-cmp-count">' +
    countedHtml(diff.counted.deltas, API, { cls: 'cnt-n' }) +
    ' · <span' +
    tipAttrs({ key: 'count.scope.compare', noFocus: true }) +
    '>' +
    esc(t('count.scope.compare')) +
    '</span>' +
    ((diff.counted.deltas.breakdown || []).some((p) => p.n)
      ? ' — ' +
        diff.counted.deltas.breakdown
          .filter((p) => p.n)
          .map((p) => esc(fill(p.key, { n: p.n })))
          .join(' · ')
      : '') +
    '</div>';
  const items = diff.deltas.length
    ? diff.deltas
        .map(
          (d) =>
            '<li class="map-cmp-item k-' +
            esc(d.kind) +
            ' c-' +
            esc(d.change) +
            '" data-cmp-id="' +
            esc(d.id) +
            '">' +
            '<div class="map-cmp-kind"><span' +
            tipAttrs({ key: 'compare.kind.' + d.kind, noFocus: true }) +
            '>' +
            esc(t('compare.kind.' + d.kind)) +
            '</span> · <span' +
            tipAttrs({ key: 'compare.change.' + d.change, noFocus: true }) +
            '>' +
            esc(t('compare.change.' + d.change)) +
            '</span>' +
            (d.tier && !biz() ? ' · <span class="tier">' + esc(d.tier) + '</span>' : '') +
            '</div>' +
            '<div class="map-cmp-say">' +
            sentenceHtml(d) +
            '</div>' +
            doorHtml(d) +
            '</li>',
        )
        .join('')
    : '<li class="map-cmp-none"' +
      tipAttrs({ key: 'compare.panel.none', noFocus: true }) +
      '>' +
      esc(t('compare.panel.none')) +
      '</li>';
  const notes = (diff.notes || []).length
    ? '<div class="map-cmp-notes"' +
      tipAttrs({ text: diff.notes.join(' · '), noFocus: true }) +
      '>' +
      esc(fill(diff.notes.length === 1 ? 'compare.panel.notesOne' : 'compare.panel.notes', { n: diff.notes.length })) +
      '</div>'
    : '';
  const head = !to.served
    ? '<div class="map-cmp-head"' +
      tipAttrs({ key: 'compare.panel.headNote', noFocus: true }) +
      '>' +
      esc(fill('compare.panel.headNote', { b: to.sync })) +
      '</div>'
    : '';
  return (
    close +
    title +
    range +
    count +
    head +
    '<ol class="map-cmp-list">' +
    items +
    '</ol>' +
    notes +
    '<div class="map-cmp-foot"><button type="button" class="map-tb map-cmp-save" data-act="cmp-save"' +
    tipAttrs({ key: 'compare.panel.save', noFocus: true }) +
    '>' +
    sym('save') +
    ' ' +
    esc(t('compare.panel.save')) +
    '</button>' +
    '<div class="map-cmp-closed"' +
    tipAttrs({ key: 'compare.panel.closed', noFocus: true }) +
    '>' +
    esc(t('compare.panel.closed')) +
    '</div></div>'
  );
}

/** Draw (or hide) the panel in its host. */
export function drawComparePanel(host) {
  if (!host) return;
  const html = CMP.spec ? comparePanelHtml() : '';
  host.hidden = !html;
  host.innerHTML = html;
}

/**
 * What the Map's Save draws while comparing: the title names both syncs, the file is named for them, and the
 * changes ride under the picture as lines — so the saved A → B document says what changed without the panel.
 */
export function compareExportFacts(storyline) {
  if (!comparing()) return null;
  const { from, to, diff } = CMP.data;
  const title = fill('compare.export.what', { storyline: storyline.name, a: from.sync, b: to.sync });
  const lines = diff.deltas.map(
    (d) =>
      d.id + ' · ' + t('compare.kind.' + d.kind) + ' · ' + t('compare.change.' + d.change) + ' — ' + sentenceText(d),
  );
  return { title, subject: compareSubject(storyline.id, from, to), lines };
}
