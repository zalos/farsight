// surfaces/settings-config.js — the Config files list on the Settings page
// (docs/proposals/round-2026-10-05.md §6). Read only, over `GET /api/config`:
// one block per source with its counts (the fold's `Counted`s, `configCounts()`
// in core), one row per farsight.config.json — its path with the editor door,
// whether it speaks for the whole source or is scoped to a folder, the settings
// it gives and what was ignored — then the conflicts and the notes in words.
// The business lens names the settings in words; hybrid and code print the
// names as they are written in the file.

import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { vsl } from '../lib/graph-render.js';
import { countedHtml, defAttrs } from '../lib/counted.js';

const API = '/api/config';
const cache = { key: null, data: null, error: false, pending: null };

/** A catalog word with `{name}` placeholders filled. */
function fill(key, vars) {
  let s = t(key);
  for (const [k, v] of Object.entries(vars || {})) s = s.split('{' + k + '}').join(String(v));
  return s;
}

/** One setting a file gives: its name in the file (hybrid, code) or in words (business). */
function fieldHtml(name, lens) {
  const key = 'config.field.' + name;
  const known = S.STRINGS && S.STRINGS[key];
  if (lens === 'business' && known) return '<span class="cfg-field"' + defAttrs(key) + '>' + esc(t(key)) + '</span>';
  return '<code class="cfg-field"' + (known ? defAttrs(key) : '') + '>' + esc(name) + '</code>';
}

/** The list for every source the graph recorded config files for, as HTML. Pure over its input. */
export function configFilesHtml(data, lens) {
  lens = lens || currentLens();
  const metas = (data && data.config) || {};
  const repos = Object.keys(metas).sort();
  if (!repos.length) return '<div class="set-note cfg-none">' + esc(t('config.none')) + '</div>';
  return repos.map((repo) => {
    const meta = metas[repo];
    const counts = (data.counts && data.counts[repo]) || {};
    const rows = (meta.files || []).map((f) => {
      const scope = f.root
        ? '<span class="cfg-scope cfg-root"' + defAttrs('config.scope.root') + '>' + esc(t('config.scope.root')) + '</span>'
        : '<span class="cfg-scope"' + defAttrs('config.scope.dir') + '>' + esc(fill('config.scope.dir', { dir: f.dir })) + '</span>';
      const gives = f.fields && f.fields.length
        ? f.fields.map((x) => fieldHtml(x, lens)).join(' ')
        : '<span class="set-note"' + defAttrs('config.noFields') + '>' + esc(t('config.noFields')) + '</span>';
      const ignored = f.ignored && f.ignored.length
        ? '<span class="cfg-ign-l"' + defAttrs('config.ignored') + '>' + esc(t('config.ignored')) + '</span> ' + f.ignored.map((x) => fieldHtml(x, lens)).join(' ')
        : '';
      return '<tr class="cfg-row" data-path="' + esc(f.path) + '">'
        + '<td class="mono cfg-path">' + esc(f.path) + ' ' + vsl(repo, f.path, 1) + '</td>'
        + '<td>' + scope + '</td>'
        + '<td class="cfg-gives"><span class="cfg-gives-l"' + defAttrs('config.gives') + '>' + esc(t('config.gives')) + '</span> ' + gives + '</td>'
        + '<td class="cfg-ign">' + ignored + '</td></tr>';
    }).join('');
    const conflicts = (meta.conflicts || []).map((c) =>
      '<li class="cfg-conflict" data-kind="' + esc(c.kind) + '"' + defAttrs('config.conflict.' + c.kind) + '>'
      + esc(fill('config.conflict.' + c.kind, { key: c.key, files: (c.files || []).join(', '), kept: c.kept })) + '</li>').join('');
    const notes = (meta.notes || []).map((n) => '<li class="cfg-note">' + esc(n) + '</li>').join('');
    return '<div class="cfg-src" data-repo="' + esc(repo) + '">'
      + '<div class="cfg-head"><b>' + esc(repo) + '</b> '
      + countedHtml(counts.files, API, { cls: 'cnt-n cfg-n-files' })
      + (counts.conflicts && counts.conflicts.n ? ' · ' + countedHtml(counts.conflicts, API, { cls: 'cnt-n cfg-n-conflicts' }) : '')
      + '</div>'
      + '<table class="src-table cfg-table"><tbody>' + rows + '</tbody></table>'
      + (conflicts ? '<div class="cfg-sub"' + defAttrs('config.conflicts') + '>' + esc(t('config.conflicts')) + '</div><ul class="cfg-list">' + conflicts + '</ul>' : '')
      + (notes ? '<div class="cfg-sub"' + defAttrs('config.notes') + '>' + esc(t('config.notes')) + '</div><ul class="cfg-list cfg-notes">' + notes + '</ul>' : '')
      + '</div>';
  }).join('');
}

/** Draw the list into the Settings page, asking the server again when the graph changed since the last answer. */
export function renderConfigFiles() {
  const host = document.getElementById('cfgrows');
  if (!host) return;
  const title = document.getElementById('set-config-title');
  if (title) { title.textContent = t('config.title'); title.setAttribute('data-tip', 'config.title'); }
  const sub = document.getElementById('set-config-sub');
  if (sub) sub.textContent = t('config.sub');
  const key = (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.generatedAt) || '';
  const draw = () => {
    host.innerHTML = cache.error ? '<div class="set-note">' + esc(t('config.failed')) + '</div>' : configFilesHtml(cache.data);
  };
  if (cache.key === key && (cache.data || cache.error)) { draw(); return; }
  if (cache.pending) return;
  cache.pending = fetch(API).then((r) => (r.ok ? r.json() : r.status === 404 ? { config: {} } : Promise.reject(new Error(String(r.status)))))
    .then((d) => { cache.data = d; cache.error = false; })
    .catch(() => { cache.data = null; cache.error = true; })
    .finally(() => { cache.key = key; cache.pending = null; draw(); });
}
