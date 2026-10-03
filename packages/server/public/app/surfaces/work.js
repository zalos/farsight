// surfaces/work.js — the WORK surface (docs/proposals/work-items-sync.md §2, §7,
// §9, §10): the trackers this workspace reads, their items, one item's pane
// with the simple edits, and what the work changed in the code.
//
// Routes: #/work[?source=&state=&assignee=&q=&flow=&view=list|board|sources]
// and #/work/<itemId> — one item (`work::<source>::<key>`).
//
// Every fact is an answer from `/api/work*` (work-api.md): the viewer filters by
// asking again, never counts, and prints each number as the `Counted` it came
// with. Writes are intents: the page posts one and draws the answer the gate
// gave — applied, waiting for a person, a conflict, or denied with all three
// verdicts — and never draws a write as done before the tracker has said so.
// The business lens reads the tracker's words: titles, state names, people.
// Keys, ids, shas, files and patches are the developer registers'.

import { S, expose, esc, jsArg, bizName, humanize } from '../store.js';
import { t, def, plainWords } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from '../lib/tooltip.js';
import { countedHtml, defAttrs } from '../lib/counted.js';
import { kindWord } from '../lib/graph-render.js';
import { openImpact } from '../impact.js';
import { CAT_KEY, CATS, providerWord, sourceName, stateHtml, freshHtml, whenWords, workBiz, forgetFlowWork } from '../work-chips.js';

const VIEWS = ['list', 'board', 'sources'];
const ACTION_KEY = { comment: 'work.hud.action.comment', edit: 'work.hud.action.edit', assign: 'work.hud.action.assign', transition: 'work.hud.action.transition', link: 'work.hud.action.link', label: 'work.hud.action.label', create: 'work.hud.action.create' };
const VIA_KEY = { subject: 'work.hud.via.subject', branch: 'work.hud.via.branch', 'merge-subject': 'work.hud.via.merge', url: 'work.hud.via.url', declared: 'work.hud.via.declared', commit: 'work.hud.via.commit' };
const TIER_KEY = { HIGH: 'work.hud.tier.high', MEDIUM: 'work.hud.tier.medium', LOW: 'work.hud.tier.low' };
const FINDING_KEY = { 'done-not-built': 'work.hud.finding.doneNotBuilt', 'todo-but-committed': 'work.hud.finding.todoButCommitted', 'no-code': 'work.hud.finding.noCode' };
const FSTATUS_KEY = { added: 'work.hud.fstatus.added', modified: 'work.hud.fstatus.modified', deleted: 'work.hud.fstatus.deleted', renamed: 'work.hud.fstatus.renamed' };

let VIEW = 'list';
let F = { source: '', state: '', assignee: '', q: '', flow: '' };
let ITEM_ID = null;       // #/work/<id>
let LIST = null;          // the last /api/work answer
let DETAIL = null;        // the last /api/work/item/<id> answer
let OUTBOX = null;        // /api/work/outbox, for the Sources view and the item's waiting writes
let ERR = null;           // { status, error } of a failed load
let GEN = 0;              // a load that outlived its page writes nothing
let ANSWERS = [];         // this item's write answers, newest first: { status, answer, action, payload }
let EDITING = null;       // 'title' | 'description' | 'assign' | 'move' | null
let PEOPLE = null;        // /api/work/people for the item's source
let STATES = null;        // /api/work/states for the item's source
let SYNCING = false;
const OPEN_DIFF = new Set();   // commits whose change is open, by sha
const DIFFS = new Map();       // sha → { state: 'loading'|'ok'|'error', data }
const SEEN_PEOPLE = new Map(); // people seen in any answer, for the assignee filter

/** The link for the list with filters, the way `parseRoute` reads it back. @group Work */
function listHref(over) {
  const f = Object.assign({}, F, { view: VIEW }, over || {});
  const q = [];
  if (f.view && f.view !== 'list') q.push('view=' + encodeURIComponent(f.view));
  for (const k of ['source', 'state', 'assignee', 'q', 'flow']) if (f[k]) q.push(k + '=' + encodeURIComponent(f[k]));
  return '#/work' + (q.length ? '?' + q.join('&') : '');
}

/**
 * Mount the WORK surface for the current route: the strip first, so the page
 * says what it is while the answer is still in flight.
 * @group Work
 * @business The work board: what the trackers say is being done, by whom, and what it changed.
 */
export function mountWork(route, el) {
  document.body.classList.remove('surface-graph');
  VIEW = VIEWS.includes(route && route.view) ? route.view : 'list';
  F = { source: (route && route.source) || '', state: (route && route.state) || '', assignee: (route && route.assignee) || '', q: (route && route.q) || '', flow: (route && route.flow) || '' };
  const next = route && route.param ? decodeURIComponent(route.param) : null;
  if (next !== ITEM_ID) { ANSWERS = []; EDITING = null; PEOPLE = null; STATES = null; OPEN_DIFF.clear(); }
  ITEM_ID = next;
  DETAIL = null; ERR = null;
  el.innerHTML = '<div class="wk-wrap"><div id="wk-strip"></div><div id="wk-body"><p class="wk-note" style="padding:16px 22px">'
    + esc(t(ITEM_ID ? 'work.hud.loadingItem' : 'work.hud.loading')) + '</p></div></div>';
  drawStrip();
  load();
}

/**
 * Words changed (lens, register): redraw from what is in hand. Facts changed
 * (a sync): ask again. The source scope filters code repositories and not
 * trackers, so it moves nothing here.
 * @group Work
 */
export function workRefresh(reason) {
  if (!document.querySelector('.wk-wrap')) return;
  if (reason === 'sync') { forgetFlowWork(); load(); return; }
  draw();
}

/** Ask for what the route names: the list (with the outbox on the Sources view) or one item. @group Work */
function load() {
  const gen = ++GEN;
  ERR = null;
  const get = (u) => fetch(u).then(async (r) => {
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) throw { status: r.status, error: (d && d.error) || '' };
    return d;
  });
  const outbox = get('/api/work/outbox').catch(() => null);
  const main = ITEM_ID ? get('/api/work/item/' + encodeURIComponent(ITEM_ID)) : get('/api/work' + listQuery());
  Promise.all([main, outbox]).then(([d, ob]) => {
    if (gen !== GEN) return;
    OUTBOX = ob;
    if (ITEM_ID) { DETAIL = d; seedWaiting(); } else { LIST = d; (d.items || []).forEach((i) => i.assignee && SEEN_PEOPLE.set(i.assignee.id, i.assignee.name)); }
    draw();
  }).catch((e) => {
    if (gen !== GEN) return;
    ERR = e && typeof e === 'object' && 'status' in e ? e : { status: 0, error: String((e && e.message) || e || '') };
    draw();
  });
}

/** `?source=&state=&assignee=&q=&flow=` for /api/work — the server filters, so its counts follow. @group Work */
function listQuery() {
  const q = [];
  for (const k of ['source', 'state', 'assignee', 'q', 'flow']) if (F[k]) q.push(k + '=' + encodeURIComponent(F[k]));
  return q.length ? '?' + q.join('&') : '';
}

/** Ask again after a failure — the same request, nothing kept from the error. @group Work */
export function workRetry() {
  const b = document.getElementById('wk-body');
  if (b) b.innerHTML = '<p class="wk-note" style="padding:16px 22px">' + esc(t(ITEM_ID ? 'work.hud.loadingItem' : 'work.hud.loading')) + '</p>';
  load();
}

/** Redraw the strip and the body from the answers in hand. @group Work */
function draw() {
  drawStrip();
  const b = document.getElementById('wk-body');
  if (!b) return;
  if (ERR) { b.innerHTML = errHtml(ERR); return; }
  if (ITEM_ID) { b.innerHTML = DETAIL ? paneHtml(DETAIL) : ''; return; }
  if (!LIST) return;
  b.innerHTML = listBodyHtml(LIST);
}

/** A failed load: the invariant sentence, the status and the server's words, and *ask again*. @group Work */
function errHtml(e) {
  return '<div class="wk-body"><div class="wk-err" role="alert"><b' + defAttrs('sys.workFailed') + '>' + esc(t('sys.workFailed')) + '</b>'
    + (workBiz() ? '' : '<span class="code">' + esc(String(e.status || '')) + (e.error ? ' · ' + esc(e.error) : '') + '</span>')
    + '<button class="btn primary" onclick="workRetry()">' + esc(t('work.hud.retry')) + '</button></div></div>';
}

// ── the strip ─────────────────────────────────────────────────────────────

/** Title, standfirst, the counts, the three views and *sync now*. @group Work */
function drawStrip() {
  const el = document.getElementById('wk-strip');
  if (!el) return;
  const c = LIST && LIST.counts;
  const counts = !ITEM_ID && c ? '<span class="counts">' + [countedHtml(c.items, '/api/work'), countedHtml(c.sources, '/api/work')].filter(Boolean).join(' · ') + '</span>' : '';
  const views = ITEM_ID ? '' : '<div class="wk-views" role="group">' + VIEWS.map((v) => '<button class="' + (v === VIEW ? 'on' : '') + '"'
    + tipAttrs({ key: 'work.hud.view.' + v, noFocus: true }) + ' aria-pressed="' + (v === VIEW) + '" onclick="location.hash=' + jsArg(listHref({ view: v })) + '">'
    + esc(t('work.hud.view.' + v)) + '</button>').join('') + '</div>';
  el.innerHTML = '<div class="wk-strip"><h1>' + sym('work') + esc(t('nav.work')) + '</h1>'
    + '<p class="sub">' + esc(t('work.hud.sub')) + '</p>' + counts + views
    + '<button class="wk-syncbtn" onclick="workSync()"' + (SYNCING ? ' disabled' : '') + tipAttrs({ key: 'work.hud.syncNow', noFocus: true }) + '>'
    + sym('sync') + esc(t(SYNCING ? 'work.hud.syncing' : 'work.hud.syncNow')) + '</button></div>';
}

/**
 * Ask every work source (or one) for what changed, then read the page again.
 * The graph's own sync runs the work sync too; this is the button for work alone.
 * @group Work
 */
export function workSync(source) {
  if (SYNCING) return;
  SYNCING = true;
  drawStrip();
  fetch('/api/work/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(source ? { source } : {}) })
    .catch(() => null)
    .then(() => { SYNCING = false; forgetFlowWork(); load(); });
}

// ── the list ──────────────────────────────────────────────────────────────

/** The source cards, the filters, then the list, the board or the sources' outbox. @group Work */
function listBodyHtml(d) {
  const sources = d.sources || [];
  if (!sources.length) return '<div class="wk-body"><p class="wk-note"' + defAttrs('work.hud.empty') + '>' + esc(t('work.hud.empty')) + '</p></div>';
  const items = d.items || [];
  let main;
  if (VIEW === 'sources') main = outboxHtml();
  else if (!items.length) main = '<p class="wk-note"' + defAttrs('work.none') + '>' + esc(t('work.none')) + '</p>';
  else main = VIEW === 'board' ? boardHtml(items) : tableHtml(items);
  return '<div class="wk-body"><div class="wk-cards">' + sources.map(cardHtml).join('') + '</div>'
    + (VIEW === 'sources' ? '' : filtersHtml(sources)) + main + '</div>';
}

/** A source's host, for the card: `invoice-app.atlassian.net`. @group Work */
function hostOf(s) {
  const u = s.site || s.org || '';
  try { return new URL(u).host + (s.org ? new URL(u).pathname.replace(/\/$/, '') : ''); } catch (e) { return u; }
}

/**
 * A card's title names the tracker once: the provider word, then the
 * workspace's name for the source — unless that name already starts with the
 * provider word (*Jira — invoice-app*), or is only the source id.
 * @group Work
 */
export function cardTitle(s) {
  const word = providerWord(s.provider);
  const name = sourceName(s.id);
  if (!name || name === s.id) return word;
  if (word && name.toLowerCase().startsWith(word.toLowerCase())) return name;
  return word + ' · ' + name;
}

/**
 * One tracker: its name and mode, where it lives, when it last agreed with the
 * tracker, what it holds, what it lets Farsight do, and its own *sync now*.
 * @group Work
 */
function cardHtml(s) {
  const biz = workBiz();
  const f = s.freshness || { state: 'never' };
  const mode = s.mode === 'edit' ? 'edit' : 'read-only';
  return '<div class="wk-card ' + esc(f.state || '') + '" data-source="' + esc(s.id) + '">'
    + '<div class="t">' + esc(cardTitle(s)) + ' <span class="wk-mode ' + (mode === 'edit' ? 'edit' : '') + '"' + defAttrs(mode === 'edit' ? 'work.mode.edit' : 'work.mode.readOnly') + '>'
    + esc(t(mode === 'edit' ? 'work.mode.edit' : 'work.mode.readOnly')) + '</span></div>'
    + '<div class="host">' + esc(hostOf(s)) + (biz ? '' : ' · <span class="id">' + esc(s.id) + '</span>') + (s.user && s.user.name ? ' · ' + esc(t('work.hud.src.as').replace('{name}', s.user.name)) : '') + '</div>'
    + freshHtml(f)
    + (s.counts && s.counts.items ? '<div class="kv">' + countedHtml(s.counts.items, '/api/work') + '</div>' : '')
    + capsHtml(s)
    + '<div><button class="wk-ctl" onclick="workSync(this.dataset.source)" data-source="' + esc(s.id) + '">' + esc(t('work.hud.syncNow')) + '</button></div>'
    + '</div>';
}

/** What a tracker lets Farsight do, in words — from its declared capabilities, never assumed. @group Work */
function capsHtml(s) {
  const c = s.capabilities;
  if (!c) return '';
  const bits = [];
  if (c.comments) bits.push(t(c.comments.write && s.mode === 'edit' ? 'work.hud.cap.commentsRw' : 'work.hud.cap.commentsRo'));
  if (s.mode === 'edit') {
    const acts = (c.actions || ['comment', 'edit', 'assign', 'transition', 'link', 'label', 'create']).map((a) => t(ACTION_KEY[a] || a));
    bits.push(t('work.hud.cap.actions').replace('{actions}', acts.join(', ')));
    if (c.concurrency) bits.push('<span' + defAttrs(c.concurrency === 'revision' ? 'work.hud.cap.revision' : 'work.hud.cap.compare') + '>' + esc(t(c.concurrency === 'revision' ? 'work.hud.cap.revision' : 'work.hud.cap.compare')) + '</span>');
  }
  if (c.transitions) bits.push(t(c.transitions === 'graph' ? 'work.hud.cap.moveGraph' : 'work.hud.cap.movePerItem'));
  return '<div class="kv"><b' + defAttrs('work.hud.cap.head') + '>' + esc(t('work.hud.cap.head')) + '</b> '
    + bits.map((b) => (b.startsWith('<span') ? b : esc(b))).join(' · ') + '</div>';
}

/** Source · state · assignee · search, and *clear filters*. Each change asks the server again. @group Work */
function filtersHtml(sources) {
  const opt = (v, label, on) => '<option value="' + esc(v) + '"' + (on ? ' selected' : '') + '>' + esc(label) + '</option>';
  const src = '<label' + defAttrs('work.hud.filter.source') + '>' + esc(t('work.hud.filter.source'))
    + ' <select onchange="workFilter(\'source\',this.value)" aria-label="' + esc(t('work.hud.filter.source')) + '">' + opt('', t('work.hud.filter.all'), !F.source)
    + sources.map((s) => opt(s.id, providerWord(s.provider) + (workBiz() ? '' : ' · ' + s.id), F.source === s.id)).join('') + '</select></label>';
  const cats = '<div class="wk-cats" role="group" aria-label="' + esc(t('work.hud.filter.state')) + '">'
    + ['', ...CATS].map((c) => '<button class="' + (F.state === c ? 'on' : '') + '" aria-pressed="' + (F.state === c) + '" onclick="workFilter(\'state\',\'' + c + '\')">'
      + esc(c ? t(CAT_KEY[c]) : t('work.hud.filter.all')) + '</button>').join('') + '</div>';
  if (F.assignee && F.assignee !== 'none' && !SEEN_PEOPLE.has(F.assignee)) SEEN_PEOPLE.set(F.assignee, F.assignee);
  const who = '<label' + defAttrs('work.hud.filter.assignee') + '>' + esc(t('work.hud.filter.assignee'))
    + ' <select onchange="workFilter(\'assignee\',this.value)" aria-label="' + esc(t('work.hud.filter.assignee')) + '">' + opt('', t('work.hud.filter.anyone'), !F.assignee)
    + opt('none', t('work.label.unassigned'), F.assignee === 'none')
    + [...SEEN_PEOPLE.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => opt(id, name, F.assignee === id)).join('') + '</select></label>';
  const q = '<input type="search" id="wk-q" value="' + esc(F.q) + '" placeholder="' + esc(t('work.hud.filter.search')) + '" aria-label="' + esc(t('work.hud.filter.search')) + '" oninput="workSearch(this.value)"/>';
  const any = F.source || F.state || F.assignee || F.q || F.flow;
  const flow = F.flow ? '<span class="wk-chip">' + sym('work') + esc(S.BYID[F.flow] ? bizName(S.BYID[F.flow]) : F.flow) + '</span>' : '';
  return '<div class="wk-filters">' + src + cats + who + q + flow
    + (any ? '<button class="wk-ctl" onclick="location.hash=\'#/work' + (VIEW !== 'list' ? '?view=' + VIEW : '') + '\'">' + esc(t('work.hud.filter.clear')) + '</button>' : '') + '</div>';
}

/** Change one filter: the link carries it, so the filtered list is a link a reader can share. @group Work */
export function workFilter(k, v) {
  F[k] = v || '';
  location.hash = listHref();
}

let SEARCH_T = null;
/**
 * Search as the reader types: the link is rewritten in place (no remount, so the
 * box keeps its focus) and the list asks again after a pause.
 * @group Work
 */
export function workSearch(v) {
  F.q = String(v || '');
  clearTimeout(SEARCH_T);
  SEARCH_T = setTimeout(() => {
    history.replaceState(null, '', listHref());
    if (S.route) S.route.q = F.q;
    const gen = ++GEN;
    fetch('/api/work' + listQuery()).then((r) => (r.ok ? r.json() : Promise.reject({ status: r.status }))).then((d) => {
      if (gen !== GEN) return;
      LIST = d;
      drawStrip();
      const box = document.querySelector('.wk-body');
      const main = document.getElementById('wk-main');
      if (box && main) main.outerHTML = (d.items || []).length ? (VIEW === 'board' ? boardHtml(d.items) : tableHtml(d.items)) : '<p class="wk-note" id="wk-main">' + esc(t('work.none')) + '</p>';
    }).catch((e) => { if (gen === GEN) { ERR = e; draw(); } });
  }, 220);
}

/** An item's name in the register on screen: the title, with the key beside it outside the business lens. @group Work */
function itemName(i, link) {
  const key = workBiz() ? '' : '<span class="wk-key">' + esc(i.key) + '</span>';
  const title = link ? '<a class="wk-title" href="#/work/' + encodeURIComponent(i.id) + '">' + esc(i.title) + '</a>' : esc(i.title);
  return key + title + (currentCode() ? '<span class="wk-id">' + esc(i.id) + '</span>' : '');
}
/** True only in the code lens — it alone prints ids and the raw record. @group Work */
function currentCode() { return document.body.classList.contains('lens-code'); }

/** A number printed bare in a cell, its tip the `Counted` it came with. @group Work */
function cellCount(c) {
  if (!c) return '';
  return countedHtml(c, '/api/work', { words: String(c.n), cls: 'wk-num' });
}

/** The list: one row per item, newest change first (the server's order). @group Work */
function tableHtml(items) {
  const cols = ['item', 'state', 'assignee', 'type', 'labels', 'links', 'commits', 'updated'];
  const head = (c) => {
    const key = c === 'assignee' ? 'work.label.assignee' : c === 'labels' ? 'work.label.labels' : c === 'updated' ? 'work.label.updated'
      : c === 'commits' && workBiz() ? 'work.hud.col.commitsBiz' : 'work.hud.col.' + c;
    return '<th' + (def(key) ? defAttrs(key) : '') + '>' + esc(t(key)) + '</th>';
  };
  return '<table class="wk-table" id="wk-main"><thead><tr>' + cols.map(head).join('') + '</tr></thead><tbody>'
    + items.map((i) => '<tr data-item="' + esc(i.id) + '">'
      + '<td>' + itemName(i, true) + '</td>'
      + '<td>' + stateHtml(i.state) + '</td>'
      + '<td>' + (i.assignee ? esc(i.assignee.name) : '<span class="wk-dim">' + esc(t('work.label.unassigned')) + '</span>') + '</td>'
      + '<td><span class="wk-type">' + esc(i.type && i.type.name) + '</span></td>'
      + '<td>' + (i.labels || []).map((l) => '<span class="wk-label">' + esc(l) + '</span>').join('') + '</td>'
      + '<td>' + cellCount(i.links) + '</td>'
      + '<td>' + cellCount(i.commits) + '</td>'
      + '<td class="wk-dim">' + esc(whenWords(i.updated)) + '</td>'
      + '</tr>').join('') + '</tbody></table>';
}

/** The board: the same items in four columns by where they stand. @group Work */
function boardHtml(items) {
  return '<div class="wk-board" id="wk-main">' + CATS.map((c) => {
    const col = items.filter((i) => i.state && i.state.category === c);
    return '<div class="wk-col" data-cat="' + c + '"><h3>' + stateHtml({ category: c }) + '</h3>'
      + col.map((i) => '<a class="wk-tile" href="#/work/' + encodeURIComponent(i.id) + '">' + (workBiz() ? '' : '<span class="wk-key">' + esc(i.key) + '</span>') + esc(i.title)
        + '<div class="meta"><span class="wk-type">' + esc(i.type && i.type.name) + '</span>'
        + (i.state && i.state.name ? '<span>' + esc(i.state.name) + '</span>' : '')
        + '<span>' + (i.assignee ? esc(i.assignee.name) : esc(t('work.label.unassigned'))) + '</span></div></a>').join('')
      + '</div>';
  }).join('') + '</div>';
}

/** The Sources view's second half: every write waiting for a person, with its controls. @group Work */
function outboxHtml() {
  const list = waiting();
  return '<div class="wk-sec" id="wk-main"><h2' + defAttrs('work.hud.outbox.head') + '>' + esc(t('work.hud.outbox.head')) + '</h2>'
    + (list.length ? list.map((o) => answerHtml({ status: waitWord(o), answer: { intent: o, verdicts: o.verdicts, item: o.theirs }, action: o.action, payload: o.payload, key: o.key, item: o.item, fromOutbox: true })).join('')
      : '<p class="wk-note">' + esc(t('work.hud.outbox.empty')) + '</p>') + '</div>';
}

/**
 * The outbox's writes that still wait for a person: queued for confirmation, or
 * stopped by a conflict. Confirmed, denied and failed ones are history (the audit).
 * @group Work
 */
function waiting() {
  return ((OUTBOX && OUTBOX.intents) || []).filter((o) => ['queued', 'pending', 'conflict'].includes(o.status || o.state));
}
/** The answer word for a waiting write: queued in the outbox is *waiting for your confirmation*. @group Work */
function waitWord(o) { const s = o.status || o.state; return s === 'queued' ? 'pending' : s; }

// ── the item pane ─────────────────────────────────────────────────────────

/** The writes already waiting for this item (from the outbox) join the answers on the pane. @group Work */
function seedWaiting() {
  const mine = waiting().filter((o) => o.item === ITEM_ID);
  const have = new Set(ANSWERS.map((a) => a.answer && a.answer.intent && a.answer.intent.id));
  for (const o of mine) {
    if (have.has(o.id)) continue;
    ANSWERS.push({ status: waitWord(o), answer: { intent: o, verdicts: o.verdicts, item: o.theirs }, action: o.action, payload: o.payload, fromOutbox: true });
  }
}

/** The item's source capabilities: from the item answer, else the source card the list carried. @group Work */
function caps(d) {
  if (d && d.capabilities) return d.capabilities;
  const card = LIST && (LIST.sources || []).find((s) => d && d.item && s.id === d.item.source);
  return (card && card.capabilities) || {};
}
/**
 * The *preview* control beside a text edit — drawn only for a source that can
 * check a write without saving it (Azure DevOps `validateOnly`) **and** a server
 * that says it will honour the dry run (`previewable` on the item's answer). A
 * source or a server that cannot gets no button, never a fake one — and never a
 * button that would write for real.
 * @group Work
 */
function previewBtn(d, onclick) {
  return caps(d).dryRun && d && d.previewable === true ? '<button class="btn" data-preview="1" onclick="' + onclick + '"' + tipAttrs({ key: 'work.hud.edit.preview', noFocus: true }) + '>' + esc(t('work.hud.edit.preview')) + '</button>' : '';
}

/** Whether the policy lets this page draw an action's control, and the reason when it does not. @group Work */
function allowed(d, action) {
  if (d.mode !== 'edit') return { ok: false, reason: '' };
  const a = d.allowed && d.allowed[action];
  if (a == null) return { ok: false, reason: '' };
  if (typeof a === 'boolean') return { ok: a, reason: '' };
  return { ok: !!a.policy, reason: a.reason || '' };
}

/**
 * One item: who, where it stands, what was said, and — beside it — what the
 * work changed in the code. Controls are drawn only in edit mode and only for
 * what the policy grants; a read-only source says so once.
 * @group Work
 */
function paneHtml(d) {
  const it = d.item || {};
  const biz = workBiz();
  const ro = d.mode !== 'edit';
  const can = (a) => allowed(d, a).ok;
  const ctl = (action, what, label) => (can(action) ? ' <button class="wk-ctl" data-action="' + action + '" onclick="workEdit(\'' + what + '\')">' + esc(t(label)) + '</button>' : '');
  const denied = ro ? [] : ['comment', 'assign', 'transition', 'edit'].filter((a) => !can(a));
  const tracker = providerWord(it.provider);
  const parent = it.parent ? '<a href="#/work/' + encodeURIComponent(it.parent) + '">' + esc(biz ? t('work.label.parent') : String(it.parent).split('::').pop()) + '</a>' : '';
  const facts = [
    ['work.hud.col.state', stateHtml(it.state) + (it.fields && it.fields.stateUndefinedByType ? ' <span class="wk-undef"' + defAttrs('work.state.undefinedByType') + '>' + sym('warning') + esc(t('work.state.undefinedByType')) + '</span>' : '') + (EDITING === 'move' ? '' : ctl('transition', 'move', 'work.hud.edit.move')) + (EDITING === 'move' ? pickerHtml('move') : '')],
    ['work.label.assignee', (it.assignee ? esc(it.assignee.name) : '<span class="wk-dim">' + esc(t('work.label.unassigned')) + '</span>') + (EDITING === 'assign' ? pickerHtml('assign') : ctl('assign', 'assign', 'work.hud.edit.assign'))],
    ['work.hud.field.type', '<span class="wk-type">' + esc(it.type && it.type.name) + '</span>'],
    (it.labels || []).length ? ['work.label.labels', it.labels.map((l) => '<span class="wk-label">' + esc(l) + '</span>').join('')] : null,
    it.iteration ? ['work.label.iteration', esc(it.iteration.name)] : null,
    parent ? ['work.label.parent', parent] : null,
    it.area ? ['work.label.area', esc(it.area)] : null,
    it.reporter ? ['work.label.reporter', esc(it.reporter.name)] : null,
  ].filter(Boolean);
  const head = '<div class="wk-sec wk-head">'
    + '<div><a class="wk-back" href="#/work">' + esc(t('work.hud.back')) + '</a></div>'
    + (EDITING === 'title' ? '<div class="wk-ed"><input id="wk-title-in" value="' + esc(it.title) + '" aria-label="' + esc(t('work.hud.edit.title')) + '"/><div class="row">'
      + '<button class="btn primary" onclick="workSaveTitle()">' + esc(t('work.hud.edit.save')) + '</button>' + previewBtn(d, 'workSaveTitle(true)') + '<button class="btn" onclick="workEdit(null)">' + esc(t('work.hud.edit.cancel')) + '</button></div></div>'
      : '<h1>' + (biz ? '' : '<span class="wk-key">' + esc(it.key) + '</span>') + '<span id="wk-title">' + esc(it.title) + '</span>' + ctl('edit', 'title', 'work.hud.edit.title') + '</h1>')
    + '<dl class="wk-facts">' + facts.map(([k, v]) => '<dt' + (def(k) ? defAttrs(k) : '') + '>' + esc(t(k)) + '</dt><dd>' + v + '</dd>').join('') + '</dl>'
    + '<div class="wk-chips">' + freshHtml(d.freshness)
    + ' <span class="wk-mode' + (ro ? '' : ' edit') + '"' + defAttrs(ro ? 'work.mode.readOnly' : 'work.mode.edit') + '>' + esc(t(ro ? 'work.mode.readOnly' : 'work.mode.edit')) + '</span>'
    + (/^https?:\/\//.test(it.url || '') ? ' <a class="ext" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + sym('open') + ' ' + esc(t('work.hud.openIn').replace('{tracker}', tracker)) + '</a>' : '')
    + (currentCode() ? ' <span class="wk-id">' + esc(it.id) + '</span>' : '') + '</div>'
    + (ro ? '<p class="wk-note" id="wk-readonly"' + defAttrs('work.hud.edit.readOnly') + '>' + esc(t('work.hud.edit.readOnly')) + '</p>' : '')
    + (denied.length ? '<p class="wk-note"' + defAttrs('work.hud.edit.notGranted') + '>' + esc(t('work.hud.edit.notGranted').replace('{actions}', denied.map((a) => t(ACTION_KEY[a])).join(', '))) + '</p>' : '')
    + '</div>';
  const answers = ANSWERS.length ? '<div id="wk-answers" class="wk-diff">' + ANSWERS.map((a, i) => answerHtml(a, i)).join('') + '</div>' : '<div id="wk-answers"></div>';
  const bodyText = it.body ? (it.body.format === 'markdown' ? String(it.body.raw != null ? it.body.raw : it.body.text) : it.body.text) : '';
  const desc = '<div class="wk-sec"><h2>' + esc(t('work.hud.pane.description')) + ctl('edit', 'description', 'work.hud.edit.description') + '</h2>'
    + (EDITING === 'description'
      ? '<div class="wk-ed"><textarea id="wk-desc-in" aria-label="' + esc(t('work.hud.edit.description')) + '">' + esc(bodyText) + '</textarea><div class="row">'
        + '<button class="btn primary" onclick="workSaveDesc()">' + esc(t('work.hud.edit.save')) + '</button>' + previewBtn(d, 'workSaveDesc(true)') + '<button class="btn" onclick="workEdit(null)">' + esc(t('work.hud.edit.cancel')) + '</button></div></div>'
      : (bodyText ? '<div class="wk-md">' + (biz ? '<p>' + esc(plainWords(it.body.text) || t('work.hud.noDescription')) + '</p>' : mdLite(bodyText)) + '</div>'
        : '<p class="wk-note">' + esc(t('work.hud.noDescription')) + '</p>'))
    + '</div>';
  const comments = '<div class="wk-sec"><h2>' + esc(t('work.label.comments')) + '</h2>'
    + ((it.comments || []).length ? it.comments.map(commentHtml).join('') : '<p class="wk-note">' + esc(t('work.hud.noComments')) + '</p>')
    + (can('comment') ? '<div class="wk-ed"><textarea id="wk-comment-in" placeholder="' + esc(t('work.hud.edit.comment')) + '" aria-label="' + esc(t('work.hud.edit.comment')) + '"></textarea>'
      + '<div class="row"><button class="btn primary" data-action="comment" onclick="workComment()">' + esc(t('work.hud.edit.post')) + '</button>' + previewBtn(d, 'workComment(true)') + '</div></div>' : '')
    + '</div>';
  const hist = '<div class="wk-sec"><h2' + defAttrs('work.hud.pane.history') + '>' + esc(t('work.label.history')) + '</h2>'
    + ((it.history || []).length ? '<ul class="wk-hist">' + it.history.map((h) => '<li>' + esc(whenWords(h.at)) + (h.by ? ' · ' + esc(h.by.name) : '') + ' · <b>'
      + esc(biz ? humanize(String(h.field).split('.').pop()).toLowerCase() : h.field) + '</b> ' + esc(h.from || '') + ' → ' + esc(h.to || '') + '</li>').join('') + '</ul>'
      : '<p class="wk-note">' + esc(t('work.hud.noHistory')) + '</p>') + '</div>';
  const raw = currentCode() && it.raw != null ? '<div class="wk-sec"><h2' + defAttrs('work.hud.pane.raw') + '>' + esc(t('work.hud.pane.raw')) + '</h2><pre class="wk-raw">' + esc(JSON.stringify(it.raw, null, 2)) + '</pre></div>' : '';
  return '<div class="wk-pane" data-item="' + esc(it.id) + '"><div>' + head + answers + desc + comments + hist + raw + '</div>'
    + '<div>' + changedHtml(d) + findingsHtml(d) + linksHtml(d) + '</div></div>';
}

/** One comment: who, when, the words — and the attribution line when an agent asked for it. @group Work */
function commentHtml(c) {
  const text = c.body ? (c.body.format === 'markdown' ? String(c.body.raw != null ? c.body.raw : c.body.text) : c.body.text) : '';
  const agent = (c.requestedBy && c.requestedBy.kind === 'agent') || /^via Farsight \(agent\)/i.test(String((c.body && c.body.text) || ''));
  return '<div class="wk-comment"><div class="by"><b>' + esc((c.author && c.author.name) || '') + '</b> · ' + esc(whenWords(c.created)) + '</div>'
    + '<div class="wk-md">' + (workBiz() ? '<p>' + esc(plainWords(c.body && c.body.text)) + '</p>' : mdLite(text)) + '</div>'
    + (agent ? '<div class="wk-attrib">' + sym('automation') + '<span' + defAttrs('work.hud.attrib.agent') + '>' + esc(t('work.hud.attrib.agent')) + '</span>'
      + (!workBiz() && c.requestedBy && c.requestedBy.tool ? ' <span class="wk-dim">· ' + esc(c.requestedBy.tool) + '</span>' : '') + '</div>' : '')
    + '</div>';
}

/**
 * A small, safe markdown: escaped first, then paragraphs, `-`/`*`/`1.` lists,
 * fenced code, `code`, **bold** and http(s) links. Anything more stays the
 * words its author typed. No library, no raw HTML through.
 * @group Work
 */
export function mdLite(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, code = null;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) => '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">' + txt + '</a>');
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
  for (const line of lines) {
    if (code) { if (/^```/.test(line)) { out.push('<pre>' + esc(code.join('\n')) + '</pre>'); code = null; } else code.push(line); continue; }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const li = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = li[1] ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(li[3]);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  if (code) out.push('<pre>' + esc(code.join('\n')) + '</pre>');
  flushPara(); flushList();
  return out.join('');
}

// ── the edits ─────────────────────────────────────────────────────────────

/** Open one edit (`title` · `description` · `assign` · `move`), or close it with null. @group Work */
export function workEdit(what) {
  EDITING = what || null;
  const src = DETAIL && DETAIL.item && DETAIL.item.source;
  const redraw = () => { draw(); focusEdit(); };
  if (what === 'assign' && !PEOPLE) {
    fetch('/api/work/people?source=' + encodeURIComponent(src)).then((r) => (r.ok ? r.json() : { people: [] })).catch(() => ({ people: [] }))
      .then((d) => { PEOPLE = d.people || []; redraw(); });
  } else if (what === 'move' && !STATES) {
    const type = DETAIL.item.type ? '&type=' + encodeURIComponent(DETAIL.item.type.name) : '';
    fetch('/api/work/states?source=' + encodeURIComponent(src) + type).then((r) => (r.ok ? r.json() : { states: [] })).catch(() => ({ states: [] }))
      .then((d) => { STATES = d.states || []; redraw(); });
  }
  redraw();
}
/** Put the keyboard where the edit just opened. @group Work */
function focusEdit() {
  const el = EDITING === 'title' ? document.getElementById('wk-title-in') : EDITING === 'description' ? document.getElementById('wk-desc-in')
    : document.querySelector('.wk-pick button');
  if (el) el.focus();
}

/** The people picker (assign) or the state picker (move), drawn under the fact it changes. @group Work */
function pickerHtml(what) {
  if (what === 'assign') {
    if (!PEOPLE) return '<span class="wk-note">…</span>';
    return '<div class="wk-pick" role="listbox" aria-label="' + esc(t('work.hud.edit.pick')) + '">'
      + PEOPLE.map((p) => '<button role="option" data-person="' + esc(p.id) + '" onclick="workAssign(this.dataset.person)">' + esc(p.name) + '</button>').join('')
      + '<button role="option" data-person="" onclick="workAssign(\'\')">' + esc(t('work.hud.edit.nobody')) + '</button>'
      + '<button onclick="workEdit(null)">' + esc(t('work.hud.edit.cancel')) + '</button></div>';
  }
  if (!STATES) return '<span class="wk-note">…</span>';
  return '<div class="wk-pick" role="listbox" aria-label="' + esc(t('work.hud.edit.move')) + '">'
    + STATES.map((s) => '<button role="option" data-state="' + esc(s.name) + '" data-cat="' + esc(s.category) + '" onclick="workMove(this.dataset.state,this.dataset.cat)">' + stateHtml(s, true) + '</button>').join('')
    + '<button onclick="workEdit(null)">' + esc(t('work.hud.edit.cancel')) + '</button></div>';
}

/** Who is asking: the person signed in to this source, as the server reports them. @group Work */
function requestedBy() {
  const u = DETAIL && DETAIL.user;
  const card = LIST && (LIST.sources || []).find((s) => DETAIL && s.id === DETAIL.item.source);
  return { kind: 'human', id: (u && u.id) || (card && card.user && card.user.id) || 'hud' };
}

/**
 * Post one intent and draw the gate's answer. Nothing on the page changes
 * until the answer arrives: *applied* replaces the item with the tracker's copy,
 * the others are drawn as what they are.
 * @group Work
 */
function postIntent(action, payload, preview) {
  const it = DETAIL.item;
  const entry = { status: 'sending', action, payload, preview: !!preview };
  ANSWERS.unshift(entry);
  EDITING = null;
  draw();
  fetch('/api/work/intent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ item: it.id, action, payload, requestedBy: requestedBy(), baseRevision: it.revision }, preview ? { dryRun: true } : {})),
  }).then(async (r) => {
    const a = await r.json().catch(() => null);
    if (!r.ok || !a) throw new Error((a && a.error) || String(r.status));
    return a;
  }).then((a) => { settleEntry(entry, a); }).catch((e) => { entry.status = 'failed'; entry.answer = { error: String(e.message || e) }; draw(); });
}
/** Take an answer onto its entry; an applied one brings the tracker's copy of the item with it. @group Work */
function settleEntry(entry, a) {
  entry.status = a.status || 'failed';
  entry.answer = a;
  // a preview the tracker took is a preview, never a write: the item on screen is not replaced
  if (entry.preview && (a.status === 'applied' || a.status === 'pending' || a.status === 'previewed')) { entry.status = 'previewed'; draw(); return; }
  if (a.status === 'applied' && a.item && DETAIL && a.item.id === DETAIL.item.id) DETAIL.item = a.item;
  draw();
}

/** @group Work */ export function workAssign(personId) { postIntent('assign', { assignee: personId || null }); }
/** A state picked by its tracker name — two states can share a category (In Progress, In Review). @group Work */
// the category rides with the name: a grant's `to` allow-lists categories, and the tracker checks the name is one
export function workMove(name, category) { postIntent('transition', { to: name || category, ...(category ? { category } : {}) }); }
/** @group Work */ export function workComment(preview) {
  const el = document.getElementById('wk-comment-in');
  const body = el ? el.value.trim() : '';
  if (body) postIntent('comment', { body }, preview);
}
/** @group Work */ export function workSaveTitle(preview) {
  const el = document.getElementById('wk-title-in');
  const title = el ? el.value.trim() : '';
  if (title && title !== DETAIL.item.title) postIntent('edit', { title }, preview); else workEdit(null);
}
/** @group Work */ export function workSaveDesc(preview) {
  const el = document.getElementById('wk-desc-in');
  if (el) postIntent('edit', { description: el.value }, preview);
}

/**
 * Confirm, drop or re-base a waiting write — on the item pane (by its place in
 * the answers) or on the Sources view's outbox (by intent id alone).
 * @group Work
 */
export function workSettle(intentId, verb, idx) {
  const entry = idx != null && idx !== '' && ANSWERS[+idx] ? ANSWERS[+idx] : null;
  if (entry) { entry.status = 'sending'; draw(); }
  fetch('/api/work/intent/' + encodeURIComponent(intentId) + '/' + verb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then((r) => r.json().catch(() => null)).then((a) => {
      if (!entry) { load(); return; }
      // dropped only when the server says so: a refused drop (an intent already applied) is not shown dropped
      if (verb === 'drop' && a && a.status === 'failed' && /dropped/.test(a.error || '')) { entry.status = 'dropped'; entry.answer = a; draw(); return; }
      settleEntry(entry, a || { status: 'failed' });
    }).catch(() => { if (entry) { entry.status = 'failed'; draw(); } });
}

/** What was asked for, in words: the comment, the person, the state, the new title. @group Work */
function askedWords(action, p) {
  const pl = p || {};
  if (action === 'comment') return String(pl.body || '');
  if (action === 'assign') {
    const who = (PEOPLE || []).find((x) => x.id === pl.assignee);
    return pl.assignee ? (who ? who.name : SEEN_PEOPLE.get(pl.assignee) || (workBiz() ? '' : pl.assignee)) : t('work.hud.edit.nobody');
  }
  if (action === 'transition') return String(pl.toName || pl.to || '');
  if (action === 'edit') return String(pl.title != null ? pl.title : pl.description != null ? pl.description : '');
  return '';
}
/** The tracker's current value of what the write would change. @group Work */
function theirWords(action, item) {
  if (!item) return '';
  if (action === 'assign') return item.assignee ? item.assignee.name : t('work.label.unassigned');
  if (action === 'transition') return (item.state && item.state.name) || '';
  if (action === 'edit') return item.title || '';
  return '';
}

/**
 * The answer to one write, drawn as what it is:
 * applied · waiting for your confirmation (confirm / drop) · a conflict (the
 * tracker's version beside what you asked; re-base / drop) · denied (three
 * lines: your policy says … · Jira says … · the credential can …) · failed.
 * @group Work
 */
function answerHtml(a, idx) {
  const st = a.status;
  const ans = a.answer || {};
  const intent = ans.intent || {};
  const act = t(ACTION_KEY[a.action] || a.action);
  // what a person typed is words; in the business lens its code is said in words too
  const asked = workBiz() && (a.action === 'comment' || a.action === 'edit') ? plainWords(askedWords(a.action, a.payload)) : askedWords(a.action, a.payload);
  const idxAttr = a.fromOutbox && idx == null ? '' : String(idx);
  const btn = (verb, key) => '<button class="btn' + (verb === 'drop' ? '' : ' primary') + '" data-verb="' + verb + '" data-intent="' + esc(intent.id || '') + '" data-idx="' + esc(idxAttr) + '"'
    + ' onclick="workSettle(this.dataset.intent,this.dataset.verb,this.dataset.idx)">' + esc(t(key)) + '</button>';
  const what = '<div class="row"><span class="wk-via">' + esc(act) + '</span>'
    + (a.fromOutbox && a.key && idx == null && !workBiz() ? '<a href="#/work/' + encodeURIComponent(a.item || intent.item) + '">' + esc(a.key) + '</a>' : '')
    + (asked ? '<span>' + esc(asked.length > 140 ? asked.slice(0, 140) + '…' : asked) + '</span>' : '')
    + (intent.requestedBy && intent.requestedBy.kind === 'agent' ? '<span class="wk-attrib">' + sym('automation') + esc(t('work.hud.outbox.agent')) + '</span>' : '') + '</div>';
  // the tracker's dry run, when the gate asked for one before the write: printed beside the verdicts
  const pv = ans.preview ? '<div class="wk-dim" data-preview-answer="' + (ans.preview.ok ? 'ok' : 'refused') + '"' + defAttrs(ans.preview.ok ? 'work.preview.ok' : 'work.preview.refused') + '>'
    + esc(ans.preview.ok ? t('work.preview.ok') : t('work.preview.refused').replace('{reason}', ans.preview.reason || '')) + '</div>' : '';
  const head = (glyph, key) => '<div class="h">' + sym(glyph) + '<span' + (def(key) ? defAttrs(key) : '') + '>' + esc(t(key)) + '</span></div>';
  if (st === 'sending') return '<div class="wk-ans sending" data-status="sending">' + head('sync', 'work.hud.ans.sending') + what + '</div>';
  if (st === 'previewed') return '<div class="wk-ans applied" data-status="previewed">' + head('shield', 'work.hud.ans.previewed') + what + verdictsHtml(ans.verdicts) + pv + '</div>';
  if (st === 'applied') return '<div class="wk-ans applied" data-status="applied">' + head('live', 'work.hud.ans.applied') + what + pv + '</div>';
  if (st === 'pending') {
    return '<div class="wk-ans pending" data-status="pending">' + head('human', 'work.hud.ans.pending') + what
      + '<div class="row">' + btn('confirm', 'work.hud.ans.confirm') + btn('drop', 'work.hud.ans.drop') + '</div></div>';
  }
  if (st === 'conflict') {
    // the tracker's copy beside the ask: from the answer, else the item on screen — never a blank box
    const cur = ans.item || (DETAIL && DETAIL.item && DETAIL.item.id === (intent.item || a.item) ? DETAIL.item : null);
    const theirs = theirWords(a.action, cur);
    return '<div class="wk-ans conflict" data-status="conflict">' + head('warning', 'work.hud.ans.conflict') + what
      + (theirs ? '<div class="vs"><div data-side="theirs"><span class="hud-label">' + esc(t('work.hud.ans.theirs')) + '</span>' + esc(theirs) + '</div>'
        + '<div data-side="yours"><span class="hud-label">' + esc(t('work.hud.ans.yours')) + '</span>' + esc(asked) + '</div></div>' : '')
      + '<div class="row">' + btn('rebase', 'work.hud.ans.rebase') + btn('drop', 'work.hud.ans.drop') + '</div></div>';
  }
  if (st === 'denied') return '<div class="wk-ans denied" data-status="denied">' + head('violation', 'work.hud.ans.denied') + what + verdictsHtml(ans.verdicts) + pv + '</div>';
  if (st === 'dropped') return '<div class="wk-ans" data-status="dropped">' + head('stopped', 'work.hud.ans.dropped') + what + '</div>';
  return '<div class="wk-ans failed" data-status="failed">' + head('violation', 'work.hud.ans.failed') + what
    + (ans.error ? '<div class="wk-dim">' + esc(ans.error) + '</div>' : '') + pv + '</div>';
}

/** The three verdicts, one line each, in the order the gate asks them. @group Work */
function verdictsHtml(v) {
  if (!v) return '';
  const tracker = providerWord(DETAIL && DETAIL.item && DETAIL.item.provider);
  const line = (key, x) => {
    if (!x) return '';
    const yes = !!x.allowed;
    return '<li class="' + (yes ? 'yes' : 'no') + '" data-verdict="' + esc(key) + '"><span class="yn">' + esc(t(yes ? 'work.hud.ans.yes' : 'work.hud.ans.no')) + '</span>'
      + '<span>' + esc(t(key).replace('{tracker}', tracker)) + ': ' + esc(x.reason || '') + '</span></li>';
  };
  return '<ul class="wk-verdicts">' + line('work.hud.ans.policy', v.policy) + line('work.hud.ans.tracker', v.tracker) + line('work.hud.ans.credential', v.credential) + '</ul>';
}

// ── what this work changed ────────────────────────────────────────────────

/** A node chip that fast-travels to where the node can be seen (the code map, mostly). @group Work */
function nodeChip(id) {
  const n = S.BYID[id];
  const kind = n ? n.kind : id.includes('::route::') ? 'route' : id.includes('::page::') ? 'page' : 'function';
  const name = n ? (workBiz() ? bizName(n) : n.name) : (workBiz() ? humanize(id.split('::').pop()) : id.split('::').pop());
  return '<button class="wk-node k-' + esc(kind) + '" data-node="' + esc(id) + '" onclick="workTravel(this.dataset.node)"><span class="k">' + esc(kindWord(kind)) + '</span>' + esc(name) + '</button>';
}
/** Arrive on a node the way ⌘K does. @group Work */
export function workTravel(id) {
  if (window.pick && S.BYID[id]) window.pick(id);
  else location.hash = '#/codemap?node=' + encodeURIComponent(id);
}

/**
 * The commits that name this item, each expandable to its files and its
 * change, the distinct parts they touched as a typed count, and *see what uses
 * these* into the change-impact panel.
 * @group Work
 */
function changedHtml(d) {
  const biz = workBiz();
  const commits = d.commits || [];
  const touched = [...new Set(commits.flatMap((c) => c.nodes || []))];
  const tc = d.touched;
  return '<div class="wk-sec" id="wk-changed"><h2' + defAttrs('work.hud.pane.changed') + '>' + esc(t('work.hud.pane.changed'))
    + (tc ? ' · ' + countedHtml(tc, '/api/work/item') : '') + '</h2>'
    + (touched.length ? '<div class="wk-chips">' + touched.map(nodeChip).join('') + '</div>'
      + '<div class="wk-chips"><button class="wk-ctl" onclick="workImpact()"' + tipAttrs({ key: 'work.hud.seeImpact', noFocus: true }) + '>' + sym('fork') + ' ' + esc(t('work.hud.seeImpact')) + '</button>'
      + '<span id="wk-impact-list"></span></div>' : '')
    + (commits.length ? commits.map((c) => commitHtml(c, biz)).join('') : '<p class="wk-note"' + defAttrs('work.hud.noCommits') + '>' + esc(t('work.hud.noCommits')) + '</p>')
    + '</div>';
}

/** Offer each touched part to the change-impact panel — the panel answers for one part at a time. @group Work */
export function workImpact() {
  const commits = (DETAIL && DETAIL.commits) || [];
  const touched = [...new Set(commits.flatMap((c) => c.nodes || []))].filter((id) => S.BYID[id]);
  if (touched.length === 1) { openImpact(touched[0]); return; }
  const el = document.getElementById('wk-impact-list');
  if (el) el.innerHTML = touched.map((id) => '<button class="wk-node" data-node="' + esc(id) + '" onclick="openImpact(this.dataset.node)">' + sym('fork') + esc(workBiz() ? bizName(S.BYID[id]) : S.BYID[id].name) + '</button>').join('');
}

/** One commit: subject, author and when, how it names the item, its files, and its change on demand. @group Work */
function commitHtml(c, biz) {
  const open = OPEN_DIFF.has(c.sha);
  const subj = biz ? plainWords(c.subject) || t('work.hud.via.commit') : c.subject;
  return '<div class="wk-commit" data-sha="' + esc(c.sha) + '">'
    + '<div class="subj">' + esc(subj) + '</div>'
    + '<div class="meta">' + esc(c.author || '') + ' · ' + esc(whenWords(c.at))
    + ' <span class="wk-via">' + esc(t(VIA_KEY[c.via] || 'work.hud.via.commit')) + '</span>'
    + (biz ? '' : ' <span class="wk-sha">' + esc(String(c.sha).slice(0, 7)) + '</span>' + (c.branch ? ' <span class="wk-sha">' + esc(c.branch) + '</span>' : ''))
    + '</div>'
    + (biz ? '' : '<ul class="wk-files">' + (c.files || []).map((f) => '<li><span class="wk-fs ' + esc(f.status) + '">' + esc(t(FSTATUS_KEY[f.status] || f.status)) + '</span>' + esc(f.path) + '</li>').join('') + '</ul>'
      + '<div><button class="wk-ctl" aria-expanded="' + open + '" data-sha="' + esc(c.sha) + '" onclick="workDiff(this.dataset.sha)">' + esc(t(open ? 'work.hud.diff.hide' : 'work.hud.diff.show')) + '</button></div>'
      + (open ? diffHtml(c.sha) : ''))
    + '</div>';
}

/** Open or close one commit's change; the first open asks for it. @group Work */
export function workDiff(sha) {
  if (OPEN_DIFF.has(sha)) { OPEN_DIFF.delete(sha); draw(); return; }
  OPEN_DIFF.add(sha);
  if (!DIFFS.has(sha)) {
    DIFFS.set(sha, { state: 'loading' });
    fetch('/api/work/item/' + encodeURIComponent(ITEM_ID) + '/diff?sha=' + encodeURIComponent(sha))
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })).catch(() => ({ ok: false, d: null })))
      .then(({ ok, d }) => { DIFFS.set(sha, ok && d && !d.error ? { state: 'ok', data: d } : { state: 'error', data: d }); draw(); })
      .catch(() => { DIFFS.set(sha, { state: 'error' }); draw(); });
  }
  draw();
}

/** A commit's change: per file, the unified patch in the HUD's colours and the parts it touched as chips. @group Work */
function diffHtml(sha) {
  const e = DIFFS.get(sha);
  if (!e || e.state === 'loading') return '<p class="wk-note">' + esc(t('work.hud.diff.loading')) + '</p>';
  if (e.state === 'error') return '<p class="wk-note"' + defAttrs('work.hud.diff.failed') + '>' + esc(t('work.hud.diff.failed')) + (e.data && e.data.error ? ' · ' + esc(e.data.error) : '') + '</p>';
  return '<div class="wk-diff">' + (e.data.files || []).map((f) => '<div class="wk-dfile" data-path="' + esc(f.path) + '"><div class="fh"><span class="wk-fs ' + esc(f.status) + '">' + esc(t(FSTATUS_KEY[f.status] || f.status)) + '</span>' + esc(f.path)
    + ((f.nodes || []).length ? ' ' + f.nodes.map(nodeChip).join('') : '') + '</div>'
    + '<pre class="wk-patch">' + patchLines(f.patch) + '</pre></div>').join('') + '</div>';
}

/** A unified patch, one span per line: added, removed, hunk header or context. @group Work */
function patchLines(patch) {
  return String(patch || '').replace(/\n$/, '').split('\n').map((l) => {
    const cls = /^@@/.test(l) ? 'hunk' : /^\+(?!\+\+)/.test(l) ? 'add' : /^-(?!--)/.test(l) ? 'del' : 'ctx';
    return '<span class="' + cls + '">' + esc(l || ' ') + '</span>';
  }).join('');
}

/** Where the tracker and the code disagree, both sides said. @group Work */
function findingsHtml(d) {
  const f = d.findings || [];
  if (!f.length) return '';
  const biz = workBiz();
  return '<div class="wk-sec"><h2' + defAttrs('work.hud.pane.findings') + '>' + esc(t('work.hud.pane.findings')) + '</h2>'
    + f.map((x) => '<div class="wk-finding" data-kind="' + esc(x.kind) + '">' + sym('warning') + '<div><b' + defAttrs(FINDING_KEY[x.kind] || 'work.hud.finding.other') + '>' + esc(t(FINDING_KEY[x.kind] || 'work.hud.finding.other')) + '</b> '
      + esc(biz ? plainWords(x.text) : x.text)
      + '<ul class="prov">' + (x.provenances || []).map((p) => '<li>' + esc(t(p.source === 'code' ? 'work.hud.prov.code' : 'work.hud.prov.tracker')) + ': ' + esc(biz ? plainWords(p.what) : p.what) + '</li>').join('') + '</ul></div></div>').join('')
    + '</div>';
}

/** The parts this item is about, with how each link was found and how sure it is. @group Work */
function linksHtml(d) {
  const links = d.links || [];
  const biz = workBiz();
  return '<div class="wk-sec"><h2' + defAttrs('work.hud.pane.links') + '>' + esc(t('work.hud.pane.links')) + '</h2>'
    + (links.length ? links.map((l) => '<div class="wk-chips" data-link="' + esc(l.nodeId) + '">' + nodeChip(l.nodeId)
      + ' <span class="wk-via">' + esc(t(VIA_KEY[l.via] || 'work.hud.via.commit')) + '</span>'
      + ' <span class="wk-tier"' + defAttrs(TIER_KEY[l.tier] || 'work.hud.tier.low') + '>' + esc(t(TIER_KEY[l.tier] || 'work.hud.tier.low')) + '</span>'
      + (biz || !l.provenance ? '' : ' <span class="wk-dim">' + esc(l.provenance) + '</span>') + '</div>').join('')
      : '<p class="wk-note">' + esc(t('work.hud.noLinks')) + '</p>')
    + '</div>';
}

expose({ workRetry, workSync, workFilter, workSearch, workEdit, workAssign, workMove, workComment, workSaveTitle, workSaveDesc, workSettle, workDiff, workTravel, workImpact, openImpact });
