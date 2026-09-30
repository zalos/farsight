// surfaces/apis.js — the APIs surface (docs/proposals/openapi-surface.md).
// Routes: #/apis (every surface in scope) · #/apis/<apiId> (operations by
// tag) · #/apis/<apiId>?op=<routeId> (one operation: contract, consumers,
// drift) · #/apis/<apiId>?view=spec&line=N (the spec file itself) ·
// #/apis/<apiId>?view=compare (a proposed spec against the code — READ-ONLY).
// All facts come from /api/apis* (core/openapi.ts); nothing is computed here.

import { S, expose, esc, mdInline, repoOf, bizLabel, bizName, currentLens, humanize, plainClause } from '../store.js';
import { t, def } from '../strings.js';
import { sym } from '../sym.js';
import { vsl, scopeLabel } from '../lib/graph-render.js';
import { tipAttrs, registerTip, numberTip, tipSource } from '../lib/tooltip.js';
import { defAttrs, unCode } from '../lib/counted.js';

/** True in the business lens: no methods, paths, identifiers or spec lines. @group APIs */
function biz() { return currentLens() === 'business'; }

/** A catalog word's tip, or nothing when it has no define. @group APIs */
function tipOf(key) { return key && def(key) ? defAttrs(key) : ''; }

/**
 * One of the card's counts: what it counts (its `apis.def.*` words), over what
 * (this API — its spec and the code in scope), from where. Read when it opens.
 * @group APIs
 */
registerTip('apiCount', (el, a) => a && numberTip({ count: a.n, of: 'apis.count.' + a.k, scope: 'surf.scope.api', source: tipSource('/api/apis'), grammarKey: 'apis.def.' + a.k })
  + '<p class="tip-p">' + esc(a.spec ? t('apis.specSource') : t('apis.def.' + a.k)) + '</p>');

/** The operation's name as the business lens reads it: the spec's summary, or the route in words. @group APIs */
function opWords(op) {
  return plainClause(op.summary) || bizName({ kind: 'route', name: op.name });
}

let CURRENT = null; // the surface detail last fetched (for compare/op panels)

/** `?scope=` for the API endpoints, from the viewer's multi-select scope.
 * @group APIs */
function scopeParam() {
  return S.scope === 'all' || !S.scope.length ? 'all' : S.scope.join(',');
}

/** Hash link helpers — every navigation on this surface is a plain href.
 * @group APIs */
function apiHref(apiId, q) {
  const qs = q ? '?' + Object.entries(q).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
  return '#/apis/' + encodeURIComponent(apiId) + qs;
}

/**
 * Mount the APIs surface for the current route: the list, or one surface's
 * detail (operations / spec / compare, plus an optional focused operation).
 * @group APIs
 * @business The API catalogue: what each API offers, who uses it, and where its documentation and its code disagree.
 */
export function mountApis(route, el) {
  document.body.classList.remove('surface-graph');
  el.innerHTML = '<div class="set-wrap api-wrap"><p class="set-note">' + esc(t('apis.loading')) + '</p></div>';
  if (!route.param) loadList(el);
  else loadDetail(el, decodeURIComponent(route.param), route);
}

/**
 * Redraw after the scope or the register moved.
 *
 * Both reasons re-ask `/api/apis*`. The scope is a query parameter on every one
 * of those calls, so its answer genuinely changes; the register does not, but
 * this surface keeps no cached list to re-word from — one request is the honest
 * cost of not leaving the previous register's words on screen.
 * @group APIs
 */
export function apisRefresh(reason, route) {
  const el = document.getElementById('surface');
  if (el) mountApis(route || { param: null }, el);
}

// ── list ────────────────────────────────────────────────────────
/** @group APIs */
async function loadList(el) {
  let data;
  try { data = await fetch('/api/apis?scope=' + encodeURIComponent(scopeParam())).then((r) => r.json()); }
  catch (err) { el.innerHTML = '<div class="set-wrap api-wrap"><p class="set-note">' + esc(t('sys.apisFailed')) + '</p></div>'; return; }
  if (data.error) { el.innerHTML = '<div class="set-wrap api-wrap"><p class="set-note">' + esc(data.error) + '</p></div>'; return; }
  let html = '<div class="set-wrap api-wrap"><div class="api-head"><h1>' + esc(t('nav.apis')) + '</h1>'
    + '<span class="api-scope">' + esc(t('apis.scopeLabel')) + ' · ' + esc(scopeLabel()) + '</span></div>'
    + '<p class="sub">' + esc(t('apis.sub')) + '</p>';
  if (!data.apis.length) html += '<div class="set-sec"><p class="set-note">' + esc(t('apis.empty')) + '</p></div>';
  else html += '<div class="api-grid">' + data.apis.map(cardHtml).join('') + '</div>';
  el.innerHTML = html + '</div>';
}

/** One API card: name, kind, source, description, the seven counts with their definitions.
 * @group APIs */
function cardHtml(a) {
  const isUrl = /^https?:\/\//.test(a.specPath || '');
  return '<div class="api-card' + (a.kind === 'implied' ? ' implied' : '') + '">'
    + '<h2>' + sym('api') + esc(a.name) + (a.version ? '<span class="api-ver">v' + esc(a.version) + '</span>' : '') + '</h2>'
    + '<span class="api-kind">' + esc(a.kind === 'spec' ? t('apis.kindSpec') : t('apis.kindImplied')) + ' · ' + esc(a.repo) + '</span>'
    + (a.specPath ? '<span class="api-path">' + esc(a.specPath) + (isUrl ? '' : vsl(a.repo, a.specPath, 1)) + '</span>' : '')
    + (a.description ? mdInline(biz() ? unCode(a.description) : a.description) : '')
    + countsHtml(a.counts, a.specSource, a)
    + '<a class="btn primary" href="' + apiHref(a.id) + '">' + esc(t('apis.open')) + '</a>'
    + '</div>';
}

/** The counts row — each number carries its definition as a tooltip (numbers name their definition; P3's metric objects take over).
 * @group APIs */
function countsHtml(c, specSource, api) {
  // one vocabulary with the CLI and MCP: declared = named in the spec · implemented = with source ·
  // not implemented = declared, no code (never a warning on a spec-only source — there is no code to be missing)
  const keys = ['operations', 'declared', 'implemented', 'notImplemented', 'undocumented', 'consumers', 'gated', 'drift'];
  return '<div class="api-counts">' + keys.map((k) => {
    const warn = (k === 'drift' || (k === 'notImplemented' && !specSource) || k === 'undocumented') && c[k] > 0;
    const tip = tipAttrs({ id: 'apiCount', args: { k, n: c[k], spec: !!(k === 'notImplemented' && specSource) } });
    // drift is never a bare number: it opens one sentence per kind of difference
    if (k === 'drift' && c[k] > 0 && api) {
      return '<button class="api-count warn drift"' + tipAttrs({ key: 'journey.drift.byKind', noFocus: true }) + ' onclick="apisToggleDrift(this)">'
        + esc(t('apis.drift.count').replace('{n}', c[k])) + '</button>';
    }
    return '<span class="api-count' + (warn ? ' warn' : '') + '"' + tip + '><b>' + c[k] + '</b><span>' + esc(t('apis.count.' + k)) + '</span></span>';
  }).join('') + '</div>' + (c.drift > 0 && api ? driftByKindHtml(api) : '');
}

/**
 * Every difference between the spec and the code, one sentence per kind with
 * how many operations carry it — never a defect count (the clarity pass
 * §3.1, *drift*). `security-missing-in-spec` carries the clause that keeps it
 * from reading as a fault: an OpenAPI document has no way to declare a
 * same-origin or rate-limit check as a security scheme.
 * @group APIs
 * @business Explains what differs between the written contract and the built code, kind by kind.
 */
function driftByKindHtml(api) {
  const by = {};
  (api.operations || []).forEach((op) => (op.drift || []).forEach((d) => { by[d.kind] = (by[d.kind] || 0) + 1; }));
  const kinds = Object.keys(by).sort((a, b) => by[b] - by[a]);
  if (!kinds.length) return '';
  return '<div class="api-driftkinds" hidden>' + kinds.map((k) => '<div class="api-drift">' + sym('warning')
    + '<div><b>' + esc(t('apis.drift.' + k)) + '</b> · ' + esc(String(by[k]))
    + (k === 'security-missing-in-spec' ? '<span class="api-desc">' + esc(t('apis.drift.securityNote')) + '</span>' : '')
    + '</div></div>').join('') + '</div>';
}
/** Open or close one card's per-kind drift sentences.
 * @group APIs */
export function apisToggleDrift(btn) {
  const box = btn.closest('.api-card').querySelector('.api-driftkinds');
  if (box) box.hidden = !box.hidden;
}
expose({ apisToggleDrift });

// ── detail ──────────────────────────────────────────────────────
/** @group APIs */
async function loadDetail(el, apiId, route) {
  let a;
  try { a = await fetch('/api/apis/' + encodeURIComponent(apiId)).then((r) => r.json()); }
  catch (err) { el.innerHTML = '<div class="set-wrap api-wrap"><p class="set-note">' + esc(t('sys.apisFailed')) + '</p></div>'; return; }
  if (a.error) { el.innerHTML = '<div class="set-wrap api-wrap"><a class="api-back" href="#/apis">← ' + esc(t('apis.back')) + '</a><p class="set-note">' + esc(a.error) + '</p></div>'; return; }
  CURRENT = a;
  const view = route.view === 'spec' || route.view === 'compare' ? route.view : 'ops';
  const isUrl = /^https?:\/\//.test(a.specPath || '');
  let html = '<div class="set-wrap api-wrap"><a class="api-back" href="#/apis">← ' + esc(t('apis.back')) + '</a>'
    + '<div class="api-head"><h1>' + esc(a.name) + '</h1>' + (a.version ? '<span class="api-ver">v' + esc(a.version) + '</span>' : '')
    + '<span class="api-kind">' + esc(a.kind === 'spec' ? t('apis.kindSpec') : t('apis.kindImplied')) + ' · ' + esc(a.repo) + '</span>'
    + (a.specPath ? '<span class="api-path">' + esc(a.specPath) + (isUrl ? '' : vsl(a.repo, a.specPath, 1)) + '</span>' : '')
    + '<span class="api-scope">' + esc(t('apis.scopeLabel')) + ' · ' + esc(scopeLabel()) + '</span></div>'
    + (a.description ? '<div class="sub">' + mdInline(biz() ? unCode(a.description) : a.description) + '</div>' : '')
    + countsHtml(a.counts, a.specSource)
    + '<div class="api-tabs">'
    + '<a class="api-tab' + (view === 'ops' ? ' on' : '') + '" href="' + apiHref(a.id) + '">' + esc(t('apis.tab.ops')) + '</a>'
    + '<a class="api-tab' + (view === 'spec' ? ' on' : '') + '" href="' + apiHref(a.id, { view: 'spec' }) + '">' + esc(t('apis.tab.spec')) + '</a>'
    + '<a class="api-tab' + (view === 'compare' ? ' on' : '') + '" href="' + apiHref(a.id, { view: 'compare' }) + '">' + esc(t('apis.tab.compare')) + '</a>'
    + '</div><div id="api-body"></div></div>';
  el.innerHTML = html;
  const body = document.getElementById('api-body');
  if (view === 'spec') renderSpecView(body, a, route.line);
  else if (view === 'compare') renderCompare(body, a);
  else {
    const op = route.op ? a.operations.find((o) => o.routeId === route.op) : null;
    body.innerHTML = (op ? opPanelHtml(a, op) : '') + opsTableHtml(a);
    if (op) { const p = document.getElementById('api-op'); if (p) p.scrollIntoView({ block: 'start' }); }
  }
}

/** Status chip (declared + implemented / not implemented / undocumented) + deprecated + drift chips, always words.
 * @group APIs */
function statusChips(op) {
  let html = '';
  const chip = (cls, key) => '<span class="api-chip' + (cls ? ' ' + cls : '') + '"' + tipAttrs({ key, noFocus: false }) + '>' + esc(t(key)) + '</span>';
  if (op.status === 'both') html += chip('ok', 'apis.status.both');
  else if (op.status === 'spec-only') html += chip('stub', 'apis.status.specOnly');
  else if (op.status === 'implemented') html += chip('', 'apis.status.implemented');
  else if (op.status === 'declared') html += chip('', 'apis.status.declared');
  else html += chip('warn', 'apis.status.codeOnly');
  if (op.deprecated) html += chip('warn', 'apis.chip.deprecated');
  (op.drift || []).forEach((d) => {
    if (d.kind === 'spec-only' || d.kind === 'code-only') return; // already the status chip
    // the message names the code; the business lens reads it with the code said in words
    html += '<span class="api-chip warn"' + tipAttrs({ text: biz() ? unCode(d.message) : d.message }) + '>' + sym('warning') + esc(t('apis.drift.' + d.kind)) + '</span>';
  });
  return html;
}

/**
 * A gate as its chip reads it: the words after the identifier — the business
 * lens never reads `requireContractorSession`, and the others read the label
 * the code wrote beside it, which is what the chip always showed for a scope.
 * @group APIs
 */
function gateWords(x) {
  const s = String(x).replace(/^requireScope: /, '');
  if (!biz()) return s;
  const i = s.indexOf(': ');
  const label = i > 0 ? s.slice(i + 2) : s;
  // a label that is itself an identifier (`contractorSession`) reads as words
  return /^[\w$]+$/.test(label) ? humanize(label) : unCode(label);
}

/** Operations grouped by their first spec tag, one table per group.
 * @group APIs */
function opsTableHtml(a) {
  const groups = {};
  a.operations.forEach((op) => { const g = (op.tags && op.tags[0]) || ''; (groups[g] = groups[g] || []).push(op); });
  const lens = currentLens();
  const business = lens === 'business';
  // named tags first, the untagged group last
  return Object.keys(groups).sort((x, y) => (x === '') - (y === '') || x.localeCompare(y)).map((g) => {
    const rows = groups[g].map((op) => {
      const gates = (op.gates || []).map((x) => '<span class="api-chip gate">' + sym('lock') + esc(gateWords(x)) + '</span>').join('');
      const nCons = Array.isArray(op.consumers) ? op.consumers.length : (op.consumers || 0);
      // the business lens names an operation by what it does — the spec's summary —
      // and never by its method, its path or its operationId
      const nameCell = business
        ? '<td class="api-opcell"><a class="api-opname biz" href="' + apiHref(a.id, { op: op.routeId }) + '">' + esc(opWords(op)) + '</a></td>'
        : '<td class="api-opcell"><span class="m-chip m-' + esc(op.method) + '">' + esc(op.method) + '</span>'
          + '<a class="api-opname" href="' + apiHref(a.id, { op: op.routeId }) + '">' + esc(op.path) + '</a>'
          + (op.contract && op.contract.spec && op.contract.spec.operationId ? '<span class="api-opid">' + esc(op.contract.spec.operationId) + '</span>' : '') + '</td>'
          + '<td>' + (op.summary ? '<div class="api-sum">' + esc(op.summary) + '</div>' : '<div class="api-sum none">' + esc(humanize(op.name)) + '</div>') + '</td>';
      return '<tr class="op' + (op.status === 'spec-only' ? ' spec-only' : '') + '">'
        + nameCell
        + '<td>' + gates + '</td>'
        + '<td><b class="api-num" style="color:var(--ink)"' + tipAttrs({ number: { count: nCons, of: 'apis.count.consumers', scope: 'surf.scope.operation', source: tipSource('/api/apis'), grammarKey: 'apis.def.consumers' } }) + '>' + nCons + '</b></td>'
        + '<td>' + statusChips(op) + '</td>'
        + '<td class="api-acts">'
        + '<a href="' + apiHref(a.id, { op: op.routeId }) + '">' + esc(t('apis.contractLink')) + '</a>'
        + (op.loc ? '<a href="#/journeys/' + encodeURIComponent(op.routeId) + '">' + esc(t('apis.op.journey')) + '</a>' : '')
        + '<a href="#/codemap?node=' + encodeURIComponent(op.routeId) + '">' + esc(t('apis.op.codemap')) + '</a>'
        + (op.loc && lens !== 'business' ? vsl(op.loc.repo, op.loc.path, op.loc.line) : '')
        + '</td></tr>';
    }).join('');
    return '<div class="api-group"><h3>' + esc(g || t('apis.untagged')) + '</h3><table class="api-table"><thead><tr>'
      + '<th>' + esc(t('apis.col.operation')) + '</th>' + (business ? '' : '<th>' + esc(t('apis.col.summary')) + '</th>') + '<th>' + esc(t('apis.col.gates')) + '</th>'
      + '<th>' + esc(t('apis.col.consumers')) + '</th><th>' + esc(t('apis.col.status')) + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }).join('');
}

/** One operation: contract (params · body · responses · security), source + spec line, consumers with call sites and screens, drift.
 * @group APIs
 * @business Everything known about one API operation: what it takes and returns, who is allowed, who calls it, and where documentation and code disagree.
 */
function opPanelHtml(a, op) {
  const c = op.contract || {};
  const lens = currentLens();
  // rows are [keyHtml, valueHtml] — callers escape
  const kv = (rows) => '<div class="api-kv">' + rows.map(([k, v]) => '<span class="k">' + k + '</span><span class="v">' + v + '</span>').join('') + '</div>';
  const business = lens === 'business';
  const words = (x) => esc(business ? unCode(x) : x);
  let html = '<div class="api-op" id="api-op"><a class="api-back" href="' + apiHref(a.id) + '">← ' + esc(t('apis.op.all')) + '</a>'
    + '<h2>' + (business ? '<span>' + esc(opWords(op)) + '</span>'
      : '<span class="m-chip m-' + esc(op.method) + '">' + esc(op.method) + '</span><span class="api-code" style="font-size:14px;color:var(--ink)">' + esc(op.path) + '</span>')
    + statusChips(op) + '</h2>'
    + (op.summary && !business ? '<p class="api-desc">' + esc(op.summary) + '</p>' : '')
    + (c.description ? '<p class="api-desc">' + words(c.description) + '</p>' : '')
    + (op.docs && op.docs !== c.description ? '<p class="api-desc">' + words(op.docs) + '</p>' : '');
  if (business) return html + opPanelBizHtml(op) + '</div>';

  // where it lives: source + spec
  const src = op.loc ? esc(op.loc.path) + ':' + op.loc.line + vsl(op.loc.repo, op.loc.path, op.loc.line) : '<i>' + esc(t('apis.op.noSource')) + '</i>';
  const specRef = c.spec ? esc(c.spec.path) + (c.spec.line != null ? ':' + c.spec.line : '')
    + (c.spec.line != null && !/^https?:/.test(c.spec.path) ? vsl(a.repo, c.spec.path, c.spec.line) : '')
    + ' <a class="api-back" href="' + apiHref(a.id, { view: 'spec', line: c.spec.line }) + '">' + esc(t('apis.tab.spec')) + ' →</a>'
    + (c.spec.operationId ? ' <span class="api-code">operationId ' + esc(c.spec.operationId) + '</span>' : '') : '';
  html += '<div class="api-op-sec">' + kv([[esc(t('apis.op.source')), src]].concat(specRef ? [[esc(t('apis.op.inSpec')), specRef]] : [])) + '</div>';

  // the contract
  if (c.params && c.params.length) {
    html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.params')) + '</span>'
      + kv(c.params.map((p) => ['<span class="api-code">' + esc(p.name) + '</span>', esc(p.in) + (p.type ? ' · ' + esc(p.type) : '') + (p.required ? ' · ' + esc(t('apis.op.required')) : '') + (p.description ? ' — ' + esc(p.description) : '')])) + '</div>';
  }
  if (c.requestBody) {
    const b = c.requestBody;
    html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.body')) + '</span>'
      + kv([[esc(b.schema || b.contentType || '—'), (b.required ? esc(t('apis.op.required')) + ' · ' : '') + (b.contentType ? '<span class="api-code">' + esc(b.contentType) + '</span> ' : '')
        + (b.fields && b.fields.length ? '<span class="api-code">' + esc(t('apis.op.fields')) + ': ' + esc(b.fields.join(', ')) + '</span>' : '')]]) + '</div>';
  }
  if (c.responses && c.responses.length) {
    html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.responses')) + '</span>'
      + kv(c.responses.map((r) => ['<span class="api-code">' + esc(r.status) + '</span>', esc(r.description || '') + (r.schema ? ' <span class="api-code">' + esc(r.schema) + '</span>' : '')])) + '</div>';
  }
  if ((c.security && c.security.length) || (op.gates && op.gates.length)) {
    html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.security')) + '</span>'
      + (c.security || []).map((x) => '<span class="api-chip">' + esc(x) + '</span>').join('')
      + (op.gates || []).map((x) => '<span class="api-chip gate">' + sym('lock') + esc(x) + '</span>').join('') + '</div>';
  }

  // drift
  const drift = (op.drift || []);
  html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.drift')) + '</span>'
    + (drift.length ? drift.map((d) => '<div class="api-drift">' + sym('warning') + '<div><b>' + esc(t('apis.drift.' + d.kind)) + '</b>' + esc(d.message) + '</div></div>').join('')
      : '<p class="api-desc">' + esc(t('apis.op.noDrift')) + '</p>') + '</div>';

  // consumers — the code where client and API intersect
  html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.consumers')) + '</span>';
  const cons = op.consumers || [];
  if (!cons.length) html += '<p class="api-desc">' + esc(t('apis.op.consumersEmpty')) + '</p>';
  cons.forEach((x) => {
    const n = x.caller || {};
    const line = x.line != null ? x.line : (n.loc ? n.loc.line : null);
    html += '<div class="api-cons"><a class="api-opname" href="#/codemap?node=' + encodeURIComponent(n.id) + '">' + esc(bizLabel(n)) + '</a> <span class="api-code">' + esc(n.name || '') + '</span>'
      + (x.crossRepo ? ' <span class="api-chip">' + esc(t('apis.op.otherSource')) + ' · ' + esc(n.repo || '') + (x.confidence ? ' · ' + esc(x.confidence) : '') + '</span>' : '')
      + (n.loc && line != null ? '<div class="mono">' + esc(t('apis.op.callSite')) + ' ' + esc(n.loc.path) + ':' + line + vsl(n.repo, n.loc.path, line) + '</div>' : '')
      + ((x.screens || []).length ? '<div class="screens"><span class="api-code">' + esc(t('apis.op.reachedFrom')) + '</span> '
        + x.screens.map(screenLinkHtml).join('') + '</div>' : '')
      + '</div>';
  });
  html += '</div></div>';
  return html;
}

/**
 * The rest of one operation for the business lens: who is allowed (the gates in
 * words), where the written contract and the code disagree (said in words), and
 * who uses it — the screens, by name. No parameters, schemas, files or lines.
 * @group APIs
 */
function opPanelBizHtml(op) {
  let html = '';
  if ((op.gates || []).length) {
    html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.security')) + '</span>'
      + op.gates.map((x) => '<span class="api-chip gate">' + sym('lock') + esc(gateWords(x)) + '</span>').join('') + '</div>';
  }
  const drift = op.drift || [];
  html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.drift')) + '</span>'
    + (drift.length ? drift.map((d) => '<div class="api-drift">' + sym('warning') + '<div><b>' + esc(t('apis.drift.' + d.kind)) + '</b> ' + esc(unCode(d.message)) + '</div></div>').join('')
      : '<p class="api-desc">' + esc(t('apis.op.noDrift')) + '</p>') + '</div>';
  const cons = op.consumers || [];
  html += '<div class="api-op-sec"><span class="hud-label">' + esc(t('apis.op.consumers')) + '</span>'
    + (cons.length ? cons.map((x) => {
      const n = x.caller || {};
      return '<div class="api-cons"><a class="api-opname" href="#/codemap?node=' + encodeURIComponent(n.id) + '">' + esc(bizName(n)) + '</a>'
        + ((x.screens || []).length ? '<div class="screens">' + x.screens.map(screenLinkHtml).join('') + '</div>' : '') + '</div>';
    }).join('') : '<p class="api-desc">' + esc(t('apis.op.consumersEmpty')) + '</p>') + '</div>';
  return html;
}

/**
 * One screen a consumer is reached from: the link into the code map plus, when
 * a design manifest describes that screen, the id the docs use ("INV-01") —
 * so the API row and the design review name the same screen.
 * @group APIs
 */
function screenLinkHtml(s) {
  const d = s.design || {};
  return '<a href="#/codemap?node=' + encodeURIComponent(s.id) + '">' + sym('screen') + ' ' + esc(bizName(s)) + '</a>'
    + (d.id && !biz() ? '<span class="api-chip"' + tipAttrs({ key: 'insp.design' }) + '>' + sym('design') + esc(d.id) + '</span>' : '');
}

// ── spec file view ──────────────────────────────────────────────
/** The spec file itself, line-numbered, with one line highlighted from ?line=N. Business lens hides it (it is code).
 * @group APIs */
async function renderSpecView(body, a, line) {
  if (currentLens() === 'business') { body.innerHTML = '<div class="set-sec"><p class="set-note">' + esc(t('apis.spec.hidden')) + '</p></div>'; return; }
  if (!a.specPath) {
    body.innerHTML = '<div class="set-sec"><p class="set-note">' + esc(t('apis.spec.none')) + '</p>'
      + '<a class="btn primary" target="_blank" rel="noopener" href="/api/openapi?repo=' + encodeURIComponent(a.repo) + '&format=yaml">' + esc(t('apis.spec.generate')) + '</a>'
      + '<p class="set-note" style="margin-top:6px">' + esc(t('apis.spec.generateSub')) + '</p></div>';
    return;
  }
  body.innerHTML = '<p class="set-note">' + esc(t('apis.spec.loading')) + '</p>';
  let text;
  try {
    const r = await fetch('/api/apis/' + encodeURIComponent(a.id) + '/spec');
    if (!r.ok) { const e = await r.json().catch(() => ({})); body.innerHTML = '<p class="set-note">' + esc(e.error || t('sys.apisFailed')) + '</p>'; return; }
    text = await r.text();
  } catch (err) { body.innerHTML = '<p class="set-note">' + esc(t('sys.apisFailed')) + '</p>'; return; }
  const isUrl = /^https?:\/\//.test(a.specPath);
  const lines = text.split('\n');
  body.innerHTML = (isUrl ? '<p class="set-note">' + esc(t('apis.spec.url')) + '</p>' : '')
    + '<div class="spec-view">' + lines.map((l, i) => '<div class="spec-line' + (line === i + 1 ? ' hot' : '') + '" id="L' + (i + 1) + '"><span class="ln">' + (i + 1) + '</span>' + esc(l) + '</div>').join('') + '</div>';
  if (line) { const el = document.getElementById('L' + line); if (el) el.scrollIntoView({ block: 'center' }); }
}

// ── compare a proposed spec ─────────────────────────────────────
/** Paste / URL form → POST /api/apis/diff → the drift report. Nothing is stored.
 * @group APIs
 * @business Check a proposed API document against what the code really does, before anyone builds against it.
 */
function renderCompare(body, a) {
  body.innerHTML = '<div class="set-sec api-compare"><p class="set-note">' + esc(t('apis.compare.sub')) + '</p>'
    + '<div class="row"><input id="cmp-url" placeholder="' + esc(t('apis.compare.url')) + '"/>'
    + '<button class="btn primary" onclick="apisCompare()">' + esc(t('apis.compare.run')) + '</button>'
    + '<span class="set-note" id="cmp-note">' + esc(t('apis.compare.consequence')) + '</span></div>'
    + '<textarea id="cmp-text" placeholder="' + esc(t('apis.compare.paste')) + '"></textarea>'
    + '<div id="cmp-out"></div></div>';
}

/** @group APIs */
export async function apisCompare() {
  const a = CURRENT; if (!a) return;
  const url = document.getElementById('cmp-url').value.trim();
  const text = document.getElementById('cmp-text').value;
  const out = document.getElementById('cmp-out'), note = document.getElementById('cmp-note');
  if (!url && !text.trim()) return;
  note.textContent = t('apis.compare.running');
  try {
    const r = await fetch('/api/apis/diff', { method: 'POST', body: JSON.stringify({ ...(url ? { url } : { spec: text }), repo: a.repo }) });
    const res = await r.json();
    note.textContent = t('apis.compare.consequence');
    if (res.error) { out.innerHTML = '<p class="set-note">' + esc(res.error) + '</p>'; return; }
    out.innerHTML = compareHtml(res, a);
  } catch (err) { note.textContent = t('sys.compareFailed'); }
}

/** The drift report: three lists + the one-line count summary.
 * @group APIs */
function compareHtml(r, a) {
  const c = r.counts;
  let html = '<div class="api-cmp-sum">' + esc(t('apis.compare.summary').replace('{d}', c.declared).replace('{i}', c.implemented).replace('{m}', c.matched).replace('{s}', c.specOnly).replace('{c}', c.codeOnly).replace('{x}', c.mismatched)) + '</div>';
  const mism = r.matched.filter((m) => m.contract.drift && m.contract.drift.length);
  if (!r.specOnly.length && !r.codeOnly.length && !mism.length) return html + '<p class="api-desc">' + esc(t('apis.compare.agree')) + '</p>';
  if (r.specOnly.length) html += '<h3 class="hud-label">' + esc(t('apis.compare.declared')) + '</h3><ul class="api-cmp-list">'
    + r.specOnly.map((s) => '<li><span class="api-code" style="color:var(--ink)">' + esc(s.op) + '</span>' + (s.summary ? ' — ' + esc(s.summary) : '') + '</li>').join('') + '</ul>';
  if (r.codeOnly.length) html += '<h3 class="hud-label">' + esc(t('apis.compare.implemented')) + '</h3><ul class="api-cmp-list">'
    + r.codeOnly.map((x) => '<li><a class="api-opname" href="' + apiHref(a.id, { op: x.routeId }) + '">' + esc(x.name) + '</a>' + (x.loc ? ' <span class="api-code">' + esc(x.loc.path) + ':' + x.loc.line + '</span>' + vsl(x.loc.repo, x.loc.path, x.loc.line) : '') + '</li>').join('') + '</ul>';
  if (mism.length) html += '<h3 class="hud-label">' + esc(t('apis.compare.mismatched')) + '</h3><ul class="api-cmp-list">'
    + mism.map((m) => '<li><a class="api-opname" href="' + apiHref(a.id, { op: m.routeId }) + '">' + esc(m.op) + '</a>' + (m.matchedBy === 'basePath' ? ' <span class="api-chip">' + esc(t('apis.compare.viaBase')) + '</span>' : '')
      + (m.loc ? ' <span class="api-code">' + esc(m.loc.path) + ':' + m.loc.line + '</span>' + vsl(m.loc.repo, m.loc.path, m.loc.line) : '')
      + m.contract.drift.map((d) => '<span class="sub">' + esc(t('apis.drift.' + d.kind)) + ' — ' + esc(d.message) + '</span>').join('') + '</li>').join('') + '</ul>';
  return html;
}

expose({ apisCompare });
