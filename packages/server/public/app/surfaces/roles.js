// surfaces/roles.js — who may do what (outsider round 2026-10-13, worklist F4).
//
// `#/roles[?role=&guard=&flow=&repo=]`: every action a role check stands in front of, one row each — the action in
// the words its authors wrote, one column per role the code names (*may* · *not listed*, or *roles not read* across
// them when the check is handed something other than a named list), where the list was read from (outside the
// business register), the journeys and screens whose walk reaches the action (each a door to the Map), and the test
// that reaches it quoted by its own name with its own last run. Everything is read from `GET /api/roles` (core
// roles.ts `roleTable()`): this page folds nothing. Reached from the front door's state of play, the Map dock's
// *about* tab and every role guard's gate card. Saves as CSV and JSON (the same answer).

import { esc, currentLens } from '../store.js';
import { t, plainWords } from '../strings.js';
import { sym } from '../sym.js';
import { countedHtml, defAttrs } from '../lib/counted.js';
import { jrnRoleWords } from '../lib/journey-draw.js';

const API = '/api/roles';
const RS = { route: null, data: null, gen: 0 };

function fill(key, vars) {
  let s = t(key);
  for (const [k, v] of Object.entries(vars || {})) s = s.split('{' + k + '}').join(String(v));
  return s;
}
const biz = () => currentLens() === 'business';
const word = (key) => '<span' + defAttrs(key) + '>' + esc(t(key)) + '</span>';

/** The query the page asks with: the address's filters, passed through as they are. */
function queryOf(route) {
  const q = new URLSearchParams();
  for (const k of ['repo', 'role', 'guard', 'flow']) if (route && route[k]) q.set(k, route[k]);
  return q.toString();
}

/**
 * Mount the table.
 * @group Roles
 * @business Who may do what: every action a role check stands in front of, the roles the code lists for it, and the test that proves it.
 */
export function mountRoles(route, el) {
  RS.route = route;
  RS.data = null;
  const gen = ++RS.gen;
  el.innerHTML =
    '<div class="set-wrap rl-wrap"><div class="set-sec rl-sheet" id="rl-sheet" aria-busy="true"><p class="set-note">' +
    esc(t('roles.loading')) +
    '</p></div></div>';
  const q = queryOf(route);
  fetch(API + (q ? '?' + q : ''))
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (gen !== RS.gen) return;
      RS.data = body || { error: true };
      draw();
    })
    .catch(() => {
      if (gen === RS.gen) {
        RS.data = { error: true };
        draw();
      }
    });
}

/** The lens or the register moved: redraw from what was read; the scope or a sync: ask again. @group Roles */
export function rolesRefresh(reason, route) {
  if ((reason === 'scope' || reason === 'sync') && route) {
    const el = document.getElementById('surface');
    if (el) mountRoles(route, el);
    return;
  }
  if (RS.data) draw();
}

function roleHead(r) {
  return (
    '<th class="rl-role" scope="col"' + defAttrs('roles.col.roles') + '>' + esc(biz() ? jrnRoleWords(r) : r) + '</th>'
  );
}

function proofHtml(row) {
  const first = (row.tests || []).find((x) => !x.runLevel);
  if (!first)
    return (
      '<span class="rl-none"' +
      defAttrs('roles.proof.none') +
      '>' +
      sym('absent') +
      esc(t('roles.proof.none')) +
      '</span>'
    );
  const run = first.status
    ? ' <span class="rl-run run-' +
      esc(first.status) +
      '"' +
      defAttrs('roles.lastRun') +
      '>' +
      esc(fill('roles.lastRun', { status: first.status, date: String(first.at || '').slice(0, 10) })) +
      '</span>'
    : '';
  return (
    '<span class="rl-quote"' +
    defAttrs('roles.proof') +
    '>' +
    esc(fill('roles.proof', { test: first.name })) +
    '</span>' +
    run +
    (!biz() && first.loc ? ' <code class="rl-loc">' + esc(first.loc.path + ':' + first.loc.line) + '</code>' : '') +
    ((row.tests || []).filter((x) => !x.runLevel).length > 1
      ? ' <span class="rl-more">' +
        esc(fill('gate.more', { n: row.tests.filter((x) => !x.runLevel).length - 1 })) +
        '</span>'
      : '')
  );
}

function whereHtml(row) {
  if (!row.journeys.length) return '<span class="rl-none">—</span>';
  return row.journeys
    .map((j) => {
      const sc = row.screens.filter((s) => s.flow === j.id).map((s) => s.name);
      return (
        '<a class="rl-j" href="#/map/' +
        esc(encodeURIComponent(j.id)) +
        '">' +
        esc(j.name) +
        '</a>' +
        (sc.length ? ' <span class="rl-sc">' + esc(sc.join(' · ')) + '</span>' : '')
      );
    })
    .join('<br>');
}

function rowHtml(row, roles) {
  const b = biz();
  const words = plainWords(row.words) || row.words;
  const action = b
    ? '<span class="rl-act">' +
      esc(words) +
      '</span>' +
      '<span class="rl-biz"' +
      defAttrs('roles.anyOf') +
      '>' +
      esc(row.rolesRead ? fill('roles.anyOf', { roles: jrnRoleWords(row.roles.join(', ')) }) : t('roles.cell.unread')) +
      '</span>'
    : '<code class="rl-code">' +
      esc(row.action.method && row.action.path ? row.action.method + ' ' + row.action.path : row.action.name) +
      '</code><span class="rl-act">' +
      esc(row.words) +
      '</span>';
  const cells = row.rolesRead
    ? roles
        .map((r) =>
          row.roles.includes(r)
            ? '<td class="rl-cell may"' + defAttrs('roles.cell.may') + '>' + esc(t('roles.cell.may')) + '</td>'
            : '<td class="rl-cell not"' + defAttrs('roles.cell.not') + '>' + esc(t('roles.cell.not')) + '</td>',
        )
        .join('')
    : '<td class="rl-cell unread" colspan="' +
      roles.length +
      '"' +
      defAttrs('roles.cell.unread') +
      '>' +
      esc(t('roles.cell.unread')) +
      '</td>';
  return (
    '<tr data-action="' +
    esc(row.action.id) +
    '">' +
    '<th scope="row" class="rl-a">' +
    action +
    '</th>' +
    cells +
    (b ? '' : '<td class="rl-from"><code>' + esc(row.requiresFrom || '') + '</code></td>') +
    '<td class="rl-where">' +
    whereHtml(row) +
    '</td>' +
    '<td class="rl-proof">' +
    proofHtml(row) +
    '</td></tr>'
  );
}

function filtersHtml(d) {
  const at = (RS.route && RS.route.role) || '';
  const href = (role) => {
    const r = Object.assign({}, RS.route || {}, { role });
    const q = queryOf(r);
    return '#/roles' + (q ? '?' + q : '');
  };
  const chip = (role, label, on) =>
    '<a class="rl-chip' + (on ? ' on' : '') + '" href="' + esc(href(role)) + '">' + esc(label) + '</a>';
  return (
    '<div class="rl-filters"><span class="hud-label"' +
    defAttrs('roles.filter.role') +
    '>' +
    esc(t('roles.filter.role')) +
    '</span>' +
    chip('', t('roles.filter.all'), !at) +
    (d.roles || []).map((r) => chip(r, biz() ? jrnRoleWords(r) : r, at === r)).join('') +
    '</div>'
  );
}

function draw() {
  const host = document.getElementById('rl-sheet');
  if (!host) return;
  host.removeAttribute('aria-busy');
  const d = RS.data;
  if (!d || d.error) {
    host.innerHTML = '<p class="set-note"' + defAttrs('roles.unavailable') + '>' + esc(t('roles.unavailable')) + '</p>';
    return;
  }
  const q = queryOf(RS.route);
  const head =
    '<h2' +
    defAttrs('roles.title') +
    '>' +
    esc(t('roles.title')) +
    '</h2>' +
    '<p class="rl-lead"' +
    defAttrs('roles.lead') +
    '>' +
    esc(t('roles.lead')) +
    '</p>' +
    '<p class="rl-counts">' +
    [d.counted.actions, d.counted.roles, d.counted.passed]
      .map((c) => countedHtml(c, API, { cls: 'rl-n' }))
      .join(' · ') +
    '</p>' +
    '<div class="rl-save">' +
    '<a class="rel" download="farsight-roles.csv" href="' +
    esc(API + '?' + (q ? q + '&' : '') + 'format=csv') +
    '"' +
    defAttrs('roles.save.csv') +
    '>' +
    esc(t('roles.save.csv')) +
    '</a>' +
    '<a class="rel" download="farsight-roles.json" href="' +
    esc(API + (q ? '?' + q : '')) +
    '"' +
    defAttrs('roles.save.json') +
    '>' +
    esc(t('roles.save.json')) +
    '</a></div>';
  if (!d.rows.length) {
    host.innerHTML = head + '<p class="set-note"' + defAttrs('roles.empty') + '>' + esc(t('roles.empty')) + '</p>';
    return;
  }
  const roles = d.roles || [];
  const table =
    '<div class="rl-scroll"><table class="rl-table"><thead><tr>' +
    '<th scope="col">' +
    word('roles.col.action') +
    '</th>' +
    roles.map(roleHead).join('') +
    (biz() ? '' : '<th scope="col">' + word('roles.col.from') + '</th>') +
    '<th scope="col">' +
    word('roles.col.where') +
    '</th><th scope="col">' +
    word('roles.col.proof') +
    '</th></tr></thead><tbody>' +
    d.rows.map((r) => rowHtml(r, roles)).join('') +
    '</tbody></table></div>';
  host.innerHTML =
    head +
    filtersHtml(d) +
    table +
    '<p class="rl-holders"' +
    defAttrs('roles.holders') +
    '>' +
    sym('warning') +
    esc(t('roles.holders')) +
    '</p>';
}
