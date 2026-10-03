// surfaces/changes.js — the Changes surface (change-history-2026-09 §4, chunk H7).
//
// Three sections, one route, and a line between two kinds of answer that this
// surface never crosses:
//
//   A · the sync history — every sync of this graph for one repository, what it
//       recorded, and the commits it swept up since the sync before it;
//   B · what changed — the measured difference between two graphs, read from the
//       frozen `farsight-diff v1` document;
//   C · who and when — what git recorded over the same range.
//
// B measures the graph; C narrates the repository. They are drawn **side by side
// and never merged** (`changes.sideBySide`): a commit no sync ever read has no
// measured half at all, and merging the two would let one borrow the other's
// authority.
//
// Every number-carrying sentence here is computed in the core and fetched — the
// spine's notes are `spineSentences()`, a row's note is `spineRowNote()`, a
// change's sentence is `changeSentence()`, the attribution caveats are
// `attributeDiffOver()`'s. This module decides which of them to draw, in which
// register, and re-words none of them.
//
// Register means the lens, not the two word registers: the business register
// leaves out the change kinds that are facts about how Farsight read the code
// rather than about the software, and says that it did
// (`changes.hiddenInBusiness`). The code register adds the file, its ⧉ link and
// the commits that touched it.

import { S, esc, jsArg, expose, currentLens } from '../store.js';
import { t, def } from '../strings.js';
import { sym, symWord } from '../sym.js';
import { vsl } from '../lib/graph-render.js';
import { defAttrs, plainTip, unCode } from '../lib/counted.js';
import { tipAttrs } from '../lib/tooltip.js';

/** The business lens reads the sentences the core wrote with their code said in words. */
function said(text) { return currentLens() === 'business' ? unCode(text) : String(text || ''); }

/**
 * What this surface has fetched and resolved, so a register flip redraws from it
 * instead of asking the server the same three questions again.
 */
let ST = { repo: null, route: null, history: null, changes: null, narrative: null, resolved: null, unreadable: false, error: null, allRows: false, allChanges: false, openRuns: new Set() };

/** The kinds the business register leaves out — facts about the reading, not about the software. */
const HIDDEN_IN_BUSINESS = ['edge_confidence_changed', 'node_renamed'];

/** How many spine rows are drawn before the rest fold behind their own count. */
const SPINE_ROWS = 20;

/** How many changes of one severity are drawn before the rest fold behind their count. */
const CHANGE_ROWS = 25;

// Opening tags written out whole: a class or title attribute assembled from
// pieces reads as prose to the string lint (RULE 1), as EV_OPEN does in
// portfolio.js.
const NOTE_OPEN = { note: '<p class="set-note ch-said">', warn: '<p class="set-note ch-said warn">' };
/** A defined word with its tip — its define and its Grammar Book entry, on a click, a key or a rest. */
function term(key) {
  return def(key) ? '<span class="ch-term"' + defAttrs(key) + '>' + esc(t(key)) + '</span>' : esc(t(key));
}

/**
 * Mount the Changes surface.
 * @group Changes surface
 * @business What changed between two syncs of this graph, and what the repositories recorded over the same period.
 */
export function mountChanges(route, el) {
  const repos = knownRepos();
  const repo = (route.repo && repos.includes(route.repo) ? route.repo : null) || remembered(repos) || repos[0] || null;
  ST = { repo, route, history: null, changes: null, narrative: null, resolved: null, unreadable: false, error: null, allRows: false, allChanges: false, openRuns: new Set() };
  el.innerHTML = '<div class="set-wrap ch-wrap" id="ch-wrap">' + headHtml()
    + '<div id="ch-body"><p class="set-note">' + esc(t('portfolio.loading')) + '</p></div></div>';
  if (!repo) {
    // no local source and no checkout recorded: syncs may exist, but this surface
    // is per repository (H3b) and there is none here to name one
    ST.error = { text: t('sys.noGraph') };
    return draw();
  }
  load().catch((err) => { ST.error = { text: String((err && err.message) || err) }; draw(); });
}

/**
 * Redraw after the scope or the register moved.
 *
 * The business register draws fewer kinds and no code, so a register or lens
 * flip must redraw — and must not re-ask the server, because the answer has not
 * changed. A sync does change it: there is a new row on the spine and a new head
 * to compare against, so that one asks again.
 *
 * **The source scope does not reach this surface, and that is not an
 * oversight.** Every answer here is per repository (H3b): the spine, the
 * measured diff and the git narrative are all asked for one checkout, chosen in
 * this surface's own repository picker and remembered across visits. Letting
 * the global source filter override that explicit, persisted choice would swap
 * the reader's repository under them; narrowing the picker to the scope would
 * need a word for "no repository in this scope has a recorded checkout" that
 * the catalog does not have. So a scope change redraws nothing here.
 * @group Changes surface
 */
export function changesRefresh(reason) {
  if (reason === 'scope') return;
  // a sync adds a row to the spine and a new head to compare against: re-ask
  if (reason === 'sync') { chRetry(); return; }
  if (document.getElementById('ch-body')) draw();
}

/** Which repositories a history can be shown for — the checkouts ingest recorded. */
function knownRepos() {
  const names = new Set(Object.keys(S.ROOTS || {}));
  for (const src of (S.SETTINGS && S.SETTINGS.sources) || []) {
    if (src.type === 'local' && src.enabled !== false) names.add(src.name || src.id);
  }
  return [...names].sort();
}

function remembered(repos) {
  try {
    const r = localStorage.getItem('fs-changes-repo');
    return r && repos.includes(r) ? r : null;
  } catch (err) { return null; }
}

// ── fetching ────────────────────────────────────────────────────────────────

/**
 * The spine first, then the range it brackets. The spine is what resolves a
 * `commit:` or `rel:` range — only a sync that recorded a commit can bracket one
 * — and it is the section a reader can already use while the other two arrive,
 * the progressive fill portfolio.js does for the same reason.
 */
async function load() {
  const r = await fetch('/api/history?repo=' + encodeURIComponent(ST.repo));
  const spine = await r.json();
  if (!r.ok || spine.error) {
    ST.error = { text: spine.error || '', status: r.status };
    return draw();
  }
  ST.history = spine;
  // a param that is not a range resolves to **nothing**, never to the default:
  // drawing the latest two syncs under a link that named something else is the
  // silent substitution the 2026-09-23 swarm found and this surface must not do
  ST.unreadable = !!(ST.route && ST.route.param && !ST.route.range);
  ST.resolved = ST.unreadable ? null : resolveRange(ST.route && ST.route.range, spine);
  draw();
  if (!ST.resolved || !ST.resolved.baseSync) return;
  const q = 'from=sync:' + ST.resolved.baseSync + '&to=sync:' + ST.resolved.headSync;
  const [changes, narrative] = await Promise.all([
    fetch('/api/changes?' + q).then((x) => x.json()).catch(() => null),
    fetch('/api/history?repo=' + encodeURIComponent(ST.repo) + '&' + q).then((x) => x.json()).catch(() => null),
  ]);
  ST.changes = changes;
  ST.narrative = narrative && narrative.range ? narrative.range : null;
  draw();
}

/**
 * Read the route's range back as two syncs, or say why it cannot be.
 *
 * All three kinds funnel through the spine, because a measured difference needs
 * a graph at both ends and only a sync has one. A commit or a release resolves
 * when some sync recorded that commit; when none did, the range is reported as
 * one that cannot be closed (`changes.partialRange`) and **no** measured
 * difference is drawn — rather than quietly showing the nearest sync range,
 * which would render one comparison under another one's link.
 *
 * With no range in the link at all, the newest sync and the one before it are
 * compared and the words name both, so a default is never mistaken for a choice
 * somebody made.
 */
function resolveRange(range, spine) {
  const rows = spine.spine || [];
  // with no snapshots there is nothing to bracket a range with; the spine's own
  // note is what says so, and it is already drawn above this
  if (!rows.length) return null;
  const has = (n) => rows.some((x) => x.sync === n);
  const syncOf = (sha) => {
    const hit = rows.find((x) => x.commit && (x.commit.startsWith(sha) || sha.startsWith(x.commit)));
    return hit ? hit.sync : null;
  };
  const words = (key, base, head) => t(key).replace('{base}', base).replace('{head}', head);

  if (!range) {
    const head = rows[0].sync;
    const older = rows.find((x) => x.sync < head);
    if (!older) return { kind: 'sync', text: words('changes.range.syncs', head, head), why: [t('changes.partialRange')] };
    return { kind: 'sync', baseSync: older.sync, headSync: head, text: words('changes.range.syncs', older.sync, head) };
  }
  if (range.kind === 'sync') {
    const base = +range.base;
    const head = +range.head;
    const text = words('changes.range.syncs', base, head);
    if (!has(base) || !has(head)) return { kind: 'sync', text, why: [t('changes.partialRange')] };
    return { kind: 'sync', baseSync: Math.min(base, head), headSync: Math.max(base, head), text };
  }
  if (range.kind === 'commit') {
    const text = words('changes.range.commits', range.base.slice(0, 7), range.head.slice(0, 7));
    const b = syncOf(range.base);
    const h = syncOf(range.head);
    // a commit no sync recorded cannot carry a measured difference — that is the
    // honest limit of a commit range, and the absence word for it already exists
    if (b == null || h == null) return { kind: 'commit', text, why: [t('changes.partialRange'), t('journey.absent.notIndexed')] };
    return { kind: 'commit', baseSync: Math.min(b, h), headSync: Math.max(b, h), text, via: words('changes.range.syncs', Math.min(b, h), Math.max(b, h)) };
  }
  // rel: — declared in .farsight/settings.json, never discovered from tags (§3)
  const declared = (S.SETTINGS && S.SETTINGS.releases) || [];
  const text = words('changes.range.releases', range.base, range.head);
  if (!declared.length) return { kind: 'rel', text, why: [t('changes.noReleases')] };
  const find = (name) => declared.find((x) => x && x.name === name && (!x.repo || x.repo === ST.repo));
  const b = find(range.base);
  const h = find(range.head);
  const bs = b && b.commit ? syncOf(b.commit) : null;
  const hs = h && h.commit ? syncOf(h.commit) : null;
  if (bs == null || hs == null) return { kind: 'rel', text, why: [t('changes.partialRange')] };
  return { kind: 'rel', baseSync: Math.min(bs, hs), headSync: Math.max(bs, hs), text, via: words('changes.range.syncs', Math.min(bs, hs), Math.max(bs, hs)) };
}

// ── chrome ──────────────────────────────────────────────────────────────────

/** Title, what the surface is, the identity every claim on it is as of, and the repository picker. */
function headHtml() {
  const meta = (S.GRAPH && S.GRAPH.meta) || {};
  const none = t('journey.absent.notIndexed');
  const ident = t('chrome.identity')
    .replace('{commit}', meta.commit ? String(meta.commit).slice(0, 7) : none)
    .replace('{build}', (S.VERSION && S.VERSION.farsight && S.VERSION.farsight.commit) || (meta.farsight && meta.farsight.commit) || none)
    .replace('{n}', meta.sync != null ? String(meta.sync) : none);
  const repos = knownRepos();
  const picker = repos.length > 1
    ? '<div class="ch-repos"><span class="hud-label">' + term('changes.repo') + '</span>'
      + repos.map((r) => '<button class="ch-repo' + (r === ST.repo ? ' on' : '') + '" onclick="chSetRepo(' + jsArg(r) + ')">' + esc(r) + '</button>').join('')
      + '</div>'
    : '<p class="set-note">' + term('changes.repo') + ': <b>' + esc(ST.repo || none) + '</b></p>';
  // the business lens reads which sync; the commit and the build are a developer's
  const idLine = currentLens() === 'business' ? t('tip.sync').replace('{n}', meta.sync != null ? String(meta.sync) : none) : ident;
  return '<h1>' + esc(t('nav.changes')) + '</h1>'
    + '<p class="sub">' + esc(t('changes.sub')) + '</p>'
    + '<p class="ch-id mono">' + esc(idLine) + '</p>'
    + picker;
}

/** Switch repository: the spine and the narrative are per repository (H3b).
 * @group Changes surface */
function chSetRepo(repo) {
  try { localStorage.setItem('fs-changes-repo', repo); } catch (err) {}
  mountChanges({ ...(ST.route || {}), repo }, document.getElementById('surface'));
}

/** Draw every spine row rather than the newest page of them.
 * @group Changes surface */
function chAllRows() { ST.allRows = true; draw(); }

/** Draw every measured change rather than a page of each severity.
 * @group Changes surface */
function chAllChanges() { ST.allChanges = true; draw(); }

/** Re-run the fetches after a failure — the error state's own button.
 * @group Changes surface */
function chRetry() { mountChanges(ST.route || { param: null, range: null, repo: ST.repo }, document.getElementById('surface')); }

// ── render ──────────────────────────────────────────────────────────────────

/** Draw the whole surface from `ST`. Called after every fetch and on a lens flip.
 * @group Changes surface */
function draw() {
  const wrap = document.getElementById('ch-wrap');
  if (wrap) wrap.innerHTML = headHtml() + '<div id="ch-body"></div>';
  const body = document.getElementById('ch-body');
  if (!body) return;
  if (ST.error) {
    body.innerHTML = '<p class="set-note warn">' + esc(t('sys.historyFailed'))
      + (ST.error.text ? ' ' + esc(ST.error.text) : '')
      + (ST.error.status ? ' · ' + esc(t('sys.httpStatus').replace('{status}', ST.error.status)) : '') + '</p>'
      + '<button class="rel" onclick="chRetry()">' + esc(t('journey.retry')) + '</button>';
    return;
  }
  if (!ST.history) { body.innerHTML = '<p class="set-note">' + esc(t('portfolio.loading')) + '</p>'; return; }
  body.innerHTML = rangeHtml() + spineHtml() + measuredHtml() + narrativeHtml()
    + '<p class="set-note"><a href="#/grammar">' + esc(t('journeys.startGrammar')) + '</a></p>';
}

/**
 * What this page is comparing, in the words of the kind of range it is — always
 * drawn, including for a link this grammar cannot read, so nothing is ever
 * rendered under a link that named something else.
 * @group Changes surface
 */
function rangeHtml() {
  const r = ST.resolved;
  const param = ST.route && ST.route.param;
  if (ST.unreadable) {
    return '<p class="set-note warn ch-range">' + esc(t('changes.rangeUnreadable'))
      + ' <span class="mono">' + esc(param) + '</span></p>';
  }
  if (!r) return '';
  return '<p class="ch-range">' + esc(r.text)
    + (r.via ? ' <span class="ch-via">' + esc(r.via) + '</span>' : '')
    + (r.why || []).map((w) => '<span class="ch-why warn">' + esc(w) + '</span>').join('')
    + '</p>';
}

/**
 * Why a section has nothing to draw, in the range's own words: *no releases
 * declared* where nothing has been declared, *not indexed* where a commit no
 * sync read was asked for, and only otherwise the general *cannot be closed at
 * both ends*. The reason a reader is given is the reason that applies.
 * @group Changes surface
 */
function whyNot(r) {
  return (r && r.why && r.why[0]) || t('changes.partialRange');
}

// ── A · the sync history ────────────────────────────────────────────────────

/**
 * Every sync for this repository, newest first, with the sentences the core
 * computed about the spine as a whole above them.
 *
 * The order is the honesty: *no history has been read* comes before any number,
 * because until one has, no commit can be placed and every count is a floor.
 * The bound word and *these counts overlap* sit with the counts they qualify.
 * @group Changes surface
 */
function spineHtml() {
  const h = ST.history;
  const notes = (h.notes || []).map((n) => (NOTE_OPEN[n.level] || NOTE_OPEN.note) + esc(said(n.text)) + '</p>').join('');
  const bound = h.bound === 'exact' ? 'changes.bound.exact' : 'changes.bound.floor';
  const rows = h.spine || [];
  // runs of re-indexed syncs fold first, then the page is cut: a folded run is
  // one line on the page and every sync in it is accounted for in the count
  const items = foldRuns(rows);
  const visible = ST.allRows ? items : items.slice(0, SPINE_ROWS);
  const shownN = visible.reduce((a, x) => a + (x.fold ? x.rows.length : 1), 0);
  const more = rows.length - shownN;
  return '<div class="set-sec"><h2>' + esc(t('changes.spine')) + '</h2>'
    + notes
    + '<p class="set-note">' + term(bound) + ' · ' + term('changes.notASum') + '</p>'
    + '<table class="src-table ch-table"><thead><tr>'
    + '<th>' + esc(t('chrome.sync')) + '</th><th>' + esc(t('changes.col.when')) + '</th>'
    + '<th>' + esc(t('changes.commit')) + '</th><th>' + esc(t('changes.col.note')) + '</th>'
    + '</tr></thead><tbody>' + visible.map((r) => (r.fold ? runRowHtml(r) : spineRowHtml(r.row))).join('') + '</tbody></table>'
    + (more > 0
      ? '<button class="rel ch-more" onclick="chAllRows()"' + plainTip(shownN, 'chrome.shownOf', 'surf.scope.spine', '/api/history', null, null, { t: rows.length, hidden: more }) + '>'
        + esc(t('chrome.shownOf').replace('{n}', shownN).replace('{t}', rows.length).replace('{hidden}', more)) + '</button>'
      : '')
    + '</div>';
}

/**
 * Runs of syncs that only re-indexed one commit on a newer build — the same
 * sentence sixty times buried the rows that swept something in (pass swarm
 * 2026-09-25). The newest of a run stays a row; the rest fold behind one line
 * that says how many and opens them. Returns `{ row }` and `{ fold, rows, key }`.
 * @group Changes surface
 */
function foldRuns(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    let j = i + 1;
    if (r.note === 'reindexed') {
      while (j < rows.length && rows[j].note === 'reindexed' && rows[j].commit === r.commit) j++;
    }
    out.push({ row: r });
    const rest = rows.slice(i + 1, j);
    if (rest.length) {
      const key = String(r.sync);
      if (ST.openRuns.has(key) || rest.length < 2) rest.forEach((x) => out.push({ row: x }));
      else out.push({ fold: true, rows: rest, key });
    }
    i = j;
  }
  return out;
}
/** The line a folded run of re-indexed syncs stands behind. @group Changes surface */
function runRowHtml(f) {
  const first = f.rows[f.rows.length - 1].sync;
  const last = f.rows[0].sync;
  return '<tr class="ch-run"><td colspan="4"><button class="rel ch-more" onclick="chOpenRun(' + jsArg(f.key) + ')"'
    + plainTip(f.rows.length, 'surf.changes.reindexRun', 'surf.scope.spine', '/api/history', null, 'changes.reindexed') + '>'
    + esc(t('surf.changes.reindexRun').replace('{n}', f.rows.length).replace('{a}', first).replace('{b}', last)) + '</button></td></tr>';
}
/** Open one folded run of re-indexed syncs. @group Changes surface */
function chOpenRun(key) { ST.openRuns.add(String(key)); draw(); }

/** One word per commit state — the field the core says to switch on. */
const STATE_WORD = {
  recorded: 'changes.state.recorded',
  'not-in-history': 'changes.state.notInHistory',
  'below-floor': 'changes.state.belowFloor',
  'history-unread': 'changes.state.historyUnread',
  none: 'changes.state.noCommit',
  'not-in-sync': 'changes.state.notInSync',
};

/**
 * One sync. The ordinal links to its own comparison (the sync before it → this
 * one), which is what the column is for: a row a reader wonders about becomes
 * the measured difference below.
 *
 * Absences are words — a row with no commit prints its state word and the
 * absence glyph, never a blank cell — and `read here` is drawn only where the
 * core earned a number (`commitKnown === true`), because a 0 there would be a
 * count that was never taken.
 * @group Changes surface
 */
function spineRowHtml(row) {
  const code = currentLens() === 'code';
  const business = currentLens() === 'business';
  const served = (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.sync) === row.sync;
  const prev = ((ST.history && ST.history.spine) || []).find((x) => x.sync < row.sync);
  const link = prev
    ? '<a href="#/changes/' + prev.sync + '...' + row.sync + '?repo=' + encodeURIComponent(ST.repo) + '">' + row.sync + '</a>'
    : String(row.sync);
  const stateKey = STATE_WORD[row.commitState] || 'changes.state.noCommit';
  // a commit hash is a developer's handle on the fact; the business lens reads the fact
  const commitCell = row.commit && business
    ? '<span' + defAttrs(stateKey) + '>' + esc(t(stateKey)) + '</span>'
    : row.commit
    ? '<span class="mono"' + tipAttrs({ text: row.commit }) + '>' + esc(row.commit.slice(0, 7)) + '</span>'
      + '<span class="pf-sub">' + term(row.commitFrom === 'workspace' ? 'changes.from.workspace' : 'changes.from.source') + '</span>'
    : row.commitUnverified
      ? '<span class="mono"' + tipAttrs({ text: row.commitUnverified }) + '>' + esc(business ? '' : row.commitUnverified.slice(0, 7)) + '</span>'
        + '<span class="pf-sub warn">' + term('changes.unverified') + '</span>'
      : '<span class="dim">' + symWord('absent', stateKey) + '</span>';
  // the register's word where the catalog has one, the core's sentence otherwise.
  // An unread history is the one case where the sentence is **not** repeated per
  // row: it carries the remedy, the section states it once above the table, and
  // fifty-three copies of it would bury every other row's note.
  // same commit, files differ: say the working tree moved — never *no new commits* alone,
  // which let a test run read "the code changed after this run" beside a still spine
  const note = row.note === 'tree-changed' ? '<span' + defAttrs('changes.treeChanged') + '>' + esc(t('changes.treeChanged')) + '</span>'
    : row.note === 'reindexed' ? esc(t('changes.reindexed'))
    : row.note === 'history-unread' ? term('changes.state.historyUnread')
      : esc(said(row.noteText || ''));
  const sweptLine = row.swept != null
    ? '<span class="pf-sub">' + term('changes.swept') + ': <span' + plainTip(row.swept, 'changes.swept', 'surf.scope.sync', '/api/history') + '>' + row.swept + '</span>'
      + (row.unindexed ? ' · <span' + plainTip(row.unindexed, 'journey.absent.notIndexed', 'surf.scope.sync', '/api/history') + '>' + row.unindexed + '</span> ' + term('journey.absent.notIndexed') : '') + '</span>'
    : '';
  // `--as-of sync:N` is how an older snapshot is actually served today. The hash
  // grammar carries a sync but nothing re-renders from it (shell.js parseRoute),
  // so the command is offered to the register that can run it and a link that
  // would silently show the current graph is not drawn at all.
  const asOf = code
    // str:ok — a CLI flag printed as data; its label is t('changes.asOf') on hover
    ? '<span class="pf-sub mono"' + defAttrs('changes.asOf') + '>--as-of sync:' + row.sync + '</span>'
    : '';
  return '<tr' + (served ? ' class="pinned"' : '') + '><td>' + link
    + (served ? '<span class="pf-pin">' + term('changes.servedHere') + '</span>' : '') + asOf + '</td>'
    + '<td class="mono when">' + esc(String(row.at).replace('T', ' ').slice(0, 16)) + '</td>'
    + '<td>' + commitCell + '</td>'
    + '<td class="note">' + note + sweptLine + '</td></tr>';
}

// ── B · what changed ────────────────────────────────────────────────────────

/**
 * The measured difference, from the frozen document: the counts first (they are
 * complete even when the list is cut), then one line per change in severity
 * order carrying the core's sentence.
 *
 * The business register draws neither `edge_confidence_changed` nor
 * `node_renamed` — facts about how Farsight read the code, not about the
 * software — and drops them from the counts as well as the list, so the two can
 * never disagree; `changes.hiddenInBusiness` says kinds were left out.
 * @group Changes surface
 */
function measuredHtml() {
  const r = ST.resolved;
  const head = '<div class="set-sec"><h2>' + esc(t('changes.measured')) + '</h2>'
    + '<p class="set-note">' + term('changes.sideBySide') + '</p>';
  if (ST.unreadable) return head + '<p class="set-note warn">' + esc(t('changes.rangeUnreadable')) + '</p></div>';
  if (!r || !r.baseSync) return head + '<p class="set-note warn">' + esc(whyNot(r)) + '</p></div>';
  if (!ST.changes) return head + '<p class="set-note">' + esc(t('portfolio.loading')) + '</p></div>';
  if (ST.changes.error) return head + '<p class="set-note warn">' + esc(ST.changes.error) + '</p></div>';
  const lens = currentLens();
  const doc = ST.changes.diff || {};
  const hide = lens === 'business' ? HIDDEN_IN_BUSINESS : [];
  const counts = doc.counts || {};
  const kinds = Object.keys(counts).filter((k) => counts[k] > 0 && hide.indexOf(k) < 0);
  const changes = (doc.changes || []).filter((c) => hide.indexOf(c.kind) < 0);
  // the count per kind is the contract's own vocabulary — `journey_changed`,
  // `record_added` — so it belongs to the registers that read contracts (§4-B).
  // The business register gets the sentences and the severity they sit under.
  const countsLine = lens === 'business'
    ? (doc.changes || []).length ? '' : '<p class="set-note">' + term('changes.nothingMeasured') + '</p>'
    : kinds.length
      ? '<p class="ch-counts">' + kinds.map((k) => '<span class="ch-kind"' + plainTip(counts[k], 'surf.changes.kindCount', 'surf.scope.range', '/api/changes', null, 'changes.measured', { kind: k }) + '><span class="mono">' + esc(k) + '</span> ' + counts[k] + '</span>').join('') + '</p>'
      : '<p class="set-note">' + term('changes.nothingMeasured') + '</p>';
  const cut = doc.truncated ? '<p class="set-note warn">' + term('changes.listCut') + '</p>' : '';
  const left = hide.some((k) => counts[k] > 0) ? '<p class="set-note">' + term('changes.hiddenInBusiness') + '</p>' : '';
  const groups = ['breaking', 'notable', 'info'].map((sev) => {
    const list = changes.filter((c) => c.severity === sev);
    if (!list.length) return '';
    // a page of each severity, the rest behind their own count: sixty lines of one
    // kind buries the two breaking ones, and the counts above are already complete
    const shown = ST.allChanges ? list : list.slice(0, CHANGE_ROWS);
    const more = list.length - shown.length;
    return '<h3 class="gb-group hud-label">' + term('changes.sev.' + sev) + '</h3>'
      + '<ul class="ch-list">' + shown.map(changeHtml).join('') + '</ul>'
      + (more > 0
        ? '<button class="rel ch-more" onclick="chAllChanges()"' + plainTip(shown.length, 'chrome.shownOf', 'surf.scope.range', '/api/changes', null, null, { t: list.length, hidden: more }) + '>'
          + esc(t('chrome.shownOf').replace('{n}', shown.length).replace('{t}', list.length).replace('{hidden}', more)) + '</button>'
        : '');
  }).join('');
  return head + countsLine + cut + left + groups + (lens === 'code' ? attributionNotesHtml() : '') + '</div>';
}

/** Subject kind → the one glyph the grammar licenses for it. */
const GLYPH_OF = {
  route: 'start', page: 'screen', component: 'screen', table: 'record', queue: 'message',
  guard: 'gate', rule: 'shield', flow: 'start', test: 'automation', external: 'external',
};

/**
 * One change: the core's sentence, then what each register adds — hybrid the
 * graph's confidence in the fact and the technique behind it, code the file with
 * its ⧉ link and the commits that touched that file.
 *
 * Attribution is drawn under the word *file level*: the commits that touched a
 * file are not the commits that changed a function in it, and the label is what
 * stops the list being read as a cause. An empty list is only ever drawn where
 * the field is present, which is the core's way of saying a history was read.
 * @group Changes surface
 */
function changeHtml(c) {
  const lens = currentLens();
  const sentence = (ST.changes.sentences || {})[c.id] || c.kind;
  let html = '<li class="ch-change sev-' + esc(c.severity) + '">'
    + sym(GLYPH_OF[c.subject && c.subject.kind] || 'step') + ' ' + esc(said(sentence));
  if (lens !== 'business') {
    html += '<span class="ch-meta mono">' + esc(c.confidence) + (c.technique ? ' · ' + esc(c.technique) : '') + '</span>';
  }
  if (lens === 'code' && c.loc) {
    html += '<span class="pf-sub mono">' + esc(c.loc.path) + ':' + c.loc.line + ' ' + vsl(c.loc.repo, c.loc.path, c.loc.line) + '</span>';
  }
  if (lens === 'code' && c.attribution) {
    const shas = c.attribution.commits || [];
    html += '<span class="pf-sub">' + term('changes.attribution') + ' · ' + term('changes.fileLevel')
      + (shas.length
        ? ' <span class="mono">' + shas.map((s) => esc(s.slice(0, 7))).join(' ') + '</span>'
          + (c.attribution.unindexed ? ' · ' + c.attribution.unindexed + ' ' + esc(t('journey.absent.notIndexed')) : '')
        : ' · ' + esc(t('journey.absent.noneIndexed')))
      + '</span>';
  }
  return html + '</li>';
}

/**
 * The attribution header and its per-repository sentences, from the core. They
 * are what keep an empty commit list from reading as *nothing touched this*: a
 * repository with no history read gets no field at all, and one of these
 * sentences says so by name.
 * @group Changes surface
 */
function attributionNotesHtml() {
  const a = ST.changes.attribution;
  if (!a) return '';
  return '<p class="set-note">' + esc(said(a.header)) + '</p>'
    + (a.notes || []).map((n) => (NOTE_OPEN[n.level] || NOTE_OPEN.note) + esc(n.text) + '</p>').join('');
}

// ── C · who and when ────────────────────────────────────────────────────────

/**
 * The repository's own account of the same range: who committed, when, what they
 * touched, and how much of it no sync ever ingested.
 *
 * Never a measurement of the graph. A commit no sync read can still be named
 * here — that is why this section is drawn beside the measured one and not
 * inside it.
 * @group Changes surface
 */
function narrativeHtml() {
  const r = ST.resolved;
  const head = '<div class="set-sec"><h2>' + esc(t('changes.narrative')) + '</h2>';
  if (ST.unreadable) return head + '<p class="set-note warn">' + esc(t('changes.rangeUnreadable')) + '</p></div>';
  if (!r || !r.baseSync) return head + '<p class="set-note warn">' + esc(whyNot(r)) + '</p></div>';
  if (!ST.narrative) return head + '<p class="set-note">' + esc(t('portfolio.loading')) + '</p></div>';
  const n = ST.narrative;
  const commits = n.commits || [];
  const notes = (n.notes || []).map((x) => (NOTE_OPEN[x.level] || NOTE_OPEN.note) + esc(said(x.text)) + '</p>').join('');
  if (!commits.length) {
    // why there is nothing here is the range's own fact: a re-index swept
    // nothing, an unread history cannot say what it swept. Both arrive as
    // sentences — printed, never a zero of commits dressed as a finding.
    return head + (notes || '<p class="set-note">' + esc(t('changes.reindexed')) + '</p>') + '</div>';
  }
  const people = new Set(commits.map((c) => c.email || c.author).filter(Boolean));
  const since = String(commits[commits.length - 1].at).slice(0, 10);
  const who = '<p class="ch-who"' + plainTip(commits.length, 'changes.byWhom', 'surf.scope.range', '/api/history', null, null, { commits: commits.length, people: people.size, date: since }) + '>' + esc(t('changes.byWhom')
    .replace('{commits}', commits.length).replace('{people}', people.size).replace('{date}', since)) + '</p>';
  const notIndexed = n.unindexed
    ? '<p class="set-note warn"><span' + plainTip(n.unindexed, 'journey.absent.notIndexed', 'surf.scope.range', '/api/history') + '>' + n.unindexed + '</span> ' + term('journey.absent.notIndexed') + '</p>' : '';
  const f = n.files;
  const files = f
    ? '<p class="set-note"><span' + plainTip(f.touched, 'changes.filesTouched', 'surf.scope.range', '/api/history') + '>' + esc(t('changes.filesTouched').replace('{n}', f.touched)) + '</span>'
      + (f.renamed ? ' · ' + term('changes.rename').replace('{n}', f.renamed) : '')
      + (f.identical ? ' · ' + esc(t('changes.renameIdentical').replace('{n}', f.identical)) : '')
      + '</p>'
    : '';
  return head + notes + who + notIndexed + files + touchedHtml(commits) + commitListHtml(commits) + '</div>';
}

/**
 * How many of the range's commits touched a file one of the measured changes
 * lives in — the one place the two halves of this page meet, and they meet in a
 * file, which is why the word beside it is *file level* and not *caused*.
 * @group Changes surface
 */
function touchedHtml(commits) {
  if (!ST.changes || !ST.changes.diff) return '';
  const attributed = new Set();
  let anyField = false;
  for (const c of ST.changes.diff.changes || []) {
    if (!c.attribution) continue;
    anyField = true;
    for (const s of c.attribution.commits || []) attributed.add(s);
  }
  if (!anyField) return ''; // no history read for any repository — the notes say so
  const n = commits.filter((c) => attributed.has(c.sha)).length;
  return '<p class="set-note"><span' + plainTip(n, 'changes.touchedFiles', 'surf.scope.range', '/api/history') + '>' + esc(t('changes.touchedFiles').replace('{n}', n)) + '</span> · ' + term('changes.fileLevel') + '</p>';
}

/** The commits themselves — the sha only in the register that has a use for it.
 * @group Changes surface */
function commitListHtml(commits) {
  const code = currentLens() === 'code';
  return '<table class="src-table ch-table"><tbody>' + commits.map((c) => '<tr>'
    + (code ? '<td class="mono"' + tipAttrs({ text: c.sha }) + '>' + esc(c.sha.slice(0, 7)) + '</td>' : '')
    + '<td class="mono when">' + esc(String(c.at).replace('T', ' ').slice(0, 16)) + '</td>'
    + '<td>' + esc(c.author || '') + '</td>'
    + '<td class="note">' + esc(said(c.subject || ''))
    + (c.indexed ? '' : '<span class="pf-sub dim">' + symWord('absent', 'journey.absent.notIndexed') + '</span>')
    + '</td></tr>').join('') + '</tbody></table>';
}

expose({ mountChanges, chSetRepo, chAllRows, chAllChanges, chRetry, chOpenRun });
