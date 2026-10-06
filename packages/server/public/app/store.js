// store.js — shared viewer state + fetch layer + model helpers.
// One mutable state bag (S) shared by every module; inline event handlers in
// generated HTML reach it as window.S. No framework, no build step (Phase 1).

/**
 * The viewer's shared state: graph + settings + string catalog, current
 * route/register/scope/lens selection, and every piece of render state the
 * old single-file viewer kept in module globals.
 * @group Shell
 */
export const S = {
  GRAPH: null, ROOTS: {}, SETTINGS: null,
  STRINGS: null,            // /api/strings catalog (null until loaded / on failure)
  register: 'professional', // 'hud' | 'professional' — persisted fs-register
  route: null,              // parsed hash route {surface,param,sync,scope,view,repo}
  prevSurfaceHash: null,    // where closing a journey overlay returns to
  selected: null, activeTag: null, positions: {}, focusSet: null, palIndex: 0,
  // a fast-travel pick bound for the code map: focusOn() once the map has mounted (shell.js pick)
  pendingFocus: null,
  expandedGroups: new Set(), scope: 'all',
  // the code map's projects and packages (surfaces/codemap-projects.js): group, filters, chips, the open view
  cmap: null,
  guardsByTarget: {}, validatesByTarget: {}, EDGES_OF: new Map(), displayCache: null, displayById: null, BYID: {}, RENDER_PARENTS: {},
  JOURNEY: null, journeyObserver: null, journeyActive: 0,
  JRN_TREE: null, jrnForksOpen: false, mhTimer: null,
  jrnLayout: null,          // 'storyboard' | 'timeline' | 'sheet' | 'drill' — the journey view axis (persisted fs-jrn-layout; the register picks the default)
  JRN_STORY: null,          // the storyboard's selection: {seg, mo, orders} — which screen, which action, the j/k order of its ledger
  jrnView: null,            // 'rows' | 'ladder' — the system band's shape (persisted fs-jrn-view)
  jrnDock: null,            // 'inline' | 'bottom' | 'right' — where the code pane opens (persisted fs-jrn-dock)
  jrnBiz: null,             // 'words' | 'gates' | 'decisions' — what the business lane draws (persisted fs-jrn-biz)
};

/**
 * Publish functions on window so the string-built inline handlers
 * (onclick="…") keep working across the ES-module split.
 * @group Shell
 */
export function expose(fns) { Object.assign(window, fns); }
expose({ S });

/**
 * Fetch graph + settings + string catalog in parallel. The string catalog is
 * fail-soft: if /api/strings is unreachable the viewer renders raw keys
 * rather than dying.
 * @group Shell
 */
export async function loadAll() {
  const [g, s, str] = await Promise.all([
    fetch('/graph').then((r) => r.json()),
    fetch('/api/settings').then((r) => r.json()),
    fetch('/api/strings').then((r) => r.json()).catch(() => null),
  ]);
  S.GRAPH = g; S.ROOTS = g.roots || {}; S.SETTINGS = s;
  S.STRINGS = str && str.strings ? str.strings : null;
}

// ── model helpers ───────────────────────────────────────────────
/** @group Shell */
export function repoOf(n) { return n.repo || (n.loc && n.loc.repo) || n.id.split('::')[0]; }
/**
 * One pass over the graph's nodes and one over its edges, so the map and the
 * inspector look things up instead of scanning every edge per card: nodes by id,
 * the gates on each target, the `validates` edges into each node (rule badges),
 * the edges touching each node in graph order (the inspector's relations), and
 * which components render each component.
 * @group Shell
 */
export function indexGuards() {
  S.guardsByTarget = {}; S.validatesByTarget = {}; S.EDGES_OF = new Map(); S.BYID = {}; S.RENDER_PARENTS = {};
  S.GRAPH.nodes.forEach((n) => (S.BYID[n.id] = n));
  const touch = (id, e) => { const l = S.EDGES_OF.get(id); if (l) l.push(e); else S.EDGES_OF.set(id, [e]); };
  S.GRAPH.edges.forEach((e) => {
    if (e.kind === 'guards') {
      const g = S.BYID[e.from];
      if (g) (S.guardsByTarget[e.to] = S.guardsByTarget[e.to] || []).push(g);
    }
    if (e.kind === 'validates') (S.validatesByTarget[e.to] = S.validatesByTarget[e.to] || []).push(e);
    if (e.kind === 'renders') (S.RENDER_PARENTS[e.to] = S.RENDER_PARENTS[e.to] || []).push(e.from);
    touch(e.from, e);
    if (e.to !== e.from) touch(e.to, e);
  });
}
/** A component rendered by exactly one other component is "embedded" —
 *  it collapses under its topmost non-embedded ancestor.
 * @group Shell */
export function embeddedRootOf(n) {
  if (n.kind !== 'component') return null;
  let cur = n, root = null;
  for (let i = 0; i < 10; i++) {
    const parents = S.RENDER_PARENTS[cur.id];
    if (!parents || parents.length !== 1) break;
    const p = S.BYID[parents[0]];
    if (!p || p.kind !== 'component') break;
    root = p; cur = p;
  }
  return root;
}
/** Effective grouping for a node: explicit/file group (parser) or embedded-component container.
 * @group Shell */
export function effectiveGroup(n) {
  // answered once per node object: every surface's status bar folds the whole graph through here, and the
  // name (humanize) was most of that fold on a large graph. A reload brings new node objects, so a new answer.
  if (EFFECTIVE_GROUP.has(n)) return EFFECTIVE_GROUP.get(n);
  let out = null;
  if (n.group) out = { key: repoOf(n) + '::' + n.group, name: groupName(n), codename: n.group, laneKind: n.kind === 'component' ? 'component' : 'function' };
  else {
    const root = embeddedRootOf(n);
    if (root) out = { key: 'emb::' + root.id, name: bizLabel(root) + ' · embedded', codename: 'inside <' + root.name + '>', laneKind: 'component', anchor: root };
  }
  EFFECTIVE_GROUP.set(n, out);
  return out;
}
const EFFECTIVE_GROUP = new WeakMap();
/** @group Shell */
export function groupName(n) {
  const base = n.group.includes('/') ? n.group.split('/').pop() : n.group;
  return humanize(base);
}
/** @group Shell */
export function collSourceNames(c) { return c.sourceIds.map((id) => { const s = (S.SETTINGS.sources || []).find((s) => s.id === id); return s && s.name; }).filter(Boolean); }
/** @group Shell */
export function scopedRepos() {
  if (S.scope === 'all' || !S.scope.length) return null;
  return new Set(S.scope);
}
/**
 * Load the persisted scope: 'all' or an array of source names. Migrates the
 * old single-value 'fs-scope' key ('src:'/'coll:' tokens) into the new shape.
 * @group Lens, theme & filters
 */
export function hydrateScope() {
  try {
    const raw = localStorage.getItem('fs-scope-v2');
    if (raw) { const v = JSON.parse(raw); if (v === 'all' || Array.isArray(v)) { S.scope = v; return; } }
  } catch (err) {}
  const old = localStorage.getItem('fs-scope');
  if (!old || old === 'all') return;
  if (old.startsWith('src:')) S.scope = [old.slice(4)];
  else if (old.startsWith('coll:')) {
    const c = (S.SETTINGS.collections || []).find((c) => c.name === old.slice(5));
    if (c) { const names = collSourceNames(c); if (names.length) S.scope = names; }
  }
}
/** @group Shell */
export function inScope(n) { const r = scopedRepos(); return !r || r.has(repoOf(n)); }
/** @group Shell */
export function humanize(name) {
  return name.replace(/^(GET|POST|PATCH|PUT|DELETE) /, (m) => ({ GET: 'View ', POST: 'Submit ', PATCH: 'Update ', PUT: 'Replace ', DELETE: 'Remove ' }[m.trim()] || m))
    .replace(/\/:param/g, '').replace(/^\//, '').replace(/\//g, ' ')
    .replace(/\.[tj]sx?$/, '').replace(/.*\bsrc /, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
/** @group Shell */
export function bizLabel(n) { return (n.facets && n.facets.business && n.facets.business.label) || n.bizLabel || humanize(n.name || ''); }

/**
 * A sentence somebody wrote, cut to the part a business reader can use: its
 * first clause, with no parenthesised document ids and no code spans —
 * *Approve (→ APPROVED, as code) and post the BC draft through the outbox.*
 * reads *Approve and post the BC draft through the outbox*.
 * @group Shell
 */
export function plainClause(s) {
  let out = String(s || '').split(/\s[—–]\s|(?<=[.!?])\s/)[0];
  out = out.replace(/`[^`]*`/g, ' ').replace(/\s*\([^)]*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return out.replace(/[.;:,]+$/, '').trim();
}

/**
 * A route's name in words when nobody wrote one: the verb, then the path's
 * meaningful parts — never `api`, a version or a parameter placeholder, which
 * are how the code addresses the thing and not what it is.
 * @group Shell
 */
export function routeWords(name) {
  const m = /^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/.exec(String(name || ''));
  if (!m) return humanize(String(name || ''));
  const verb = { GET: 'View', POST: 'Submit', PATCH: 'Update', PUT: 'Replace', DELETE: 'Remove' }[m[1]];
  const parts = m[2].split('/').filter((p) => p && !/^(api|v\d+)$/i.test(p) && !/^[:{[]/.test(p));
  return (verb + ' ' + humanize(parts.join(' ')).toLowerCase()).trim();
}

/**
 * A sentence the fold wrote, with the code taken out for the business lens —
 * `humanize()` applied to each identifier-shaped token rather than the token:
 * a file or a path reads as its name in words, `camelCase` and `SNAKE_CASE` as
 * words, a method and a path as the route's words, a commit hash as nothing.
 * Every other lens gets the sentence as it was written.
 * @group Shell
 */
export function unCode(text) {
  return unCodeAll(text);
}
/**
 * A commit's subject as the business register reads it: the sentence, without its
 * conventional-commit type and scope (`chore(memory): …`, `fix(core)!: …`), then
 * unCode(). The type and scope are how the repository files the change; the
 * sentence after them is what somebody wrote about it (swarm 2026-10-05).
 * @group Store
 */
export function commitWords(subject) {
  return unCode(String(subject || '').replace(/^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i, ''));
}
function unCodeAll(text) {
  const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
  const file = (p) => words(String(p).split('/').filter(Boolean).pop().replace(/\.[\w.]+$/, '').replace(/\.(spec|test|stories)$/, ''));
  return String(text || '')
    // a document's id in brackets — (SCR-08.5), (PBI #352) — is the docs' handle, not words;
    // an ADR number is the citation key a reader quotes the decision by, so a bracket that
    // cites only ADRs stays in every register (swarm 2026-10-05, the business analyst)
    .replace(/\s*\((?:[^()]*\b(?:[A-Z]{2,6}[- ]?#?\d[\w.]*|ADR|PBI)\b[^()]*)\)/g, (m) => (/\bADR[\s-]?\d/.test(m) && !/\b(?!ADR)[A-Z]{2,6}[- ]?#?\d|\bPBI\b/.test(m) ? m : ''))
    .replace(/`([^`]*)`/g, (m, x) => (/[/.]/.test(x) ? file(x) : words(x)))
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:{}.[\]-]*)/g, (m, p) => words(p.split('/').filter((s) => s && !/^(api|v\d+)$/i.test(s) && !/^[:{[]/.test(s)).join(' ')))
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, (m) => file(m))
    .replace(/\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md)\b/g, (m) => file(m))
    .replace(/\b[a-f0-9]{7,40}\b/g, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? '' : m))
    .replace(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, (m) => words(m))
    .replace(/\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g, (m) => words(m))
    .replace(/\s+([,.;:)])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * The one name the business register prints for a thing — the words a person
 * wrote for it, or `humanize()` of its name, and **never** the identifier. It
 * differs from `bizLabel()` only where that one falls back to a humanized
 * identifier that is still code: a route reads its contract's summary (the
 * sentence the spec's author wrote) instead of *Submit api v1 ops invoices
 * {invoice id} approve*, and a gate reads the label after its identifier
 * (`requireContractorSession: signed-in contractor` → *Signed-in contractor*).
 * @group Shell
 */
export function bizName(n) {
  if (!n) return '';
  const own = (n.facets && n.facets.business && n.facets.business.label) || n.bizLabel;
  // a label that names a file or an identifier is said in words, like any other sentence
  if (own) return /\.[a-z]{2,4}\b|[a-z][A-Z]|_/.test(own) ? unCode(own) : own;
  const name = String(n.name || '');
  // a package's name is how the code imports it (`@scope/date-fns`): its words drop the scope and the separators
  if (n.kind === 'package') return humanize(name.replace(/^@[^/]+\//, '').replace(/[/.]/g, ' ')) || name;
  if (n.kind === 'route') return plainClause(n.contract && n.contract.summary) || routeWords(name);
  if (n.kind === 'guard' || n.kind === 'rule') {
    // the label a gate carries after its identifier (`requireX: signed-in contractor`),
    // cut to its first clause; a label that is itself code gives way to the
    // sentence written for business, and that to the name in words
    const i = name.indexOf(': ');
    const label = plainClause(i > 0 ? name.slice(i + 2) : name);
    if (label && !/[a-z][A-Z]|_|=|^[\w$]+$/.test(label)) return label.charAt(0).toUpperCase() + label.slice(1);
    const said = plainClause(n.facets && n.facets.business && n.facets.business.description);
    if (said) return unCode(said);
  }
  // a test's title and a journey's name are words somebody wrote — said in words where they name code
  if (n.kind === 'test' || n.kind === 'flow') return /\/|[a-z][A-Z]|_|\.[a-z]{2,4}\b/.test(name) ? unCode(name) : name;
  const words = humanize(name.replace(/\.(spec|test|stories)(?=\.|$)/, '').replace(/\.json$/, '')).replace(/\s*:\w+/g, '').trim();
  return words || humanize(n.kind || '');
}

/** The active lens ('business'|'hybrid'|'code') from the body class —
 *  body now carries surface-* classes too, so never string-strip className.
 * @group Shell */
export function currentLens() {
  const m = document.body.className.match(/\blens-(business|hybrid|code)\b/);
  return m ? m[1] : 'hybrid';
}

/** @group Shell */
export function cssId(s) { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }
/** @group Shell */
/**
 * A value as a JS string argument inside an HTML event-handler attribute: `onclick="f(' + jsArg(x) + ')"`.
 * `esc()` alone is not enough there — the HTML parser decodes `&#39;` back to `'` before the handler runs.
 * @group Shell
 */
export function jsArg(s) { return esc(JSON.stringify(String(s))); }
export function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/**
 * The little bit of markdown a spec's own prose actually uses: `code`, **bold**
 * and blank-line paragraphs. Escaped first, so the text is still text — a
 * description written in a YAML file cannot inject markup here.
 *
 * Deliberately not a markdown parser: a description that reaches for anything
 * more stays readable as the words its author typed, which is better than a
 * half-rendered document.
 * @group Shell
 */
export function mdInline(text) {
  return esc(String(text || ''))
    .split(/\n\s*\n/)
    .map((para) => para
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, ' '))
    .filter(Boolean)
    .map((para) => '<p class="api-desc">' + para + '</p>')
    .join('');
}
