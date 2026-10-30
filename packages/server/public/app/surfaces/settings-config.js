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
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';

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

function openApiHtml(repo, meta, counts) {
  if (!meta) return '';
  const source = ((S.SETTINGS && S.SETTINGS.sources) || []).find(
    (s) => s.name === repo && (s.type === 'local' || s.type === 'git'),
  );
  const rows = (documents, candidate) =>
    documents
      .map((d) => {
        const origin = 'config.openapi.origin.' + (candidate ? 'candidate' : d.origin);
        const controls =
          candidate && source
            ? ['register', 'dismiss']
                .map(
                  (action) =>
                    '<button type="button" class="btn" data-write data-openapi-action="' +
                    action +
                    '" data-source="' +
                    esc(source.id) +
                    '" data-path="' +
                    esc(d.path) +
                    '"' +
                    defAttrs('config.openapi.' + action) +
                    '>' +
                    esc(t('config.openapi.' + action)) +
                    '</button>',
                )
                .join(' ')
            : '';
        return (
          '<tr class="cfg-openapi-row" data-path="' +
          esc(d.path) +
          '"><td><code' +
          defAttrs('config.openapi.title') +
          '>' +
          esc(d.path) +
          '</code><div>' +
          esc(d.title) +
          (d.version ? ' · ' + esc(d.version) : '') +
          '</div></td><td>' +
          countedHtml(counts && counts.operations && counts.operations[d.path], API) +
          '</td><td' +
          defAttrs(origin) +
          '>' +
          esc(t(origin)) +
          '</td><td class="cfg-openapi-actions">' +
          controls +
          '</td></tr>'
        );
      })
      .join('');
  return (
    '<section class="cfg-openapi"><div class="cfg-sub"' +
    defAttrs('config.openapi.title') +
    '>' +
    esc(t('config.openapi.title')) +
    '</div>' +
    countedHtml(counts && counts.applied, API, { cls: 'cnt-n cfg-n-applied' }) +
    ' · ' +
    esc(t('count.scope.source')) +
    '<table class="src-table cfg-table"><tbody>' +
    rows(meta.applied || [], false) +
    '</tbody></table><div class="cfg-sub"' +
    defAttrs('config.openapi.candidates') +
    '>' +
    esc(t('config.openapi.candidates')) +
    ' · ' +
    countedHtml(counts && counts.candidates, API, { cls: 'cnt-n cfg-n-candidates' }) +
    ' · ' +
    esc(t('count.scope.source')) +
    '</div><table class="src-table cfg-table"><tbody>' +
    rows(meta.candidates || [], true) +
    '</tbody></table><div class="set-note cfg-openapi-note" role="status"></div></section>'
  );
}

function patternsHtml(meta, counts) {
  if (!meta || !meta.rules.length) return '';
  const columns = ['matched', 'nodes', 'edges', 'unresolved', 'skipped'];
  const rows = meta.rules
    .map((rule, i) => {
      const details = [
        ...rule.unresolved.map((u) =>
          esc(u.path + ':' + u.line + ' · ' + t('config.patterns.unresolved') + ' ' + u.capture),
        ),
        ...(counts?.[i]?.unresolvedOmitted ? [countedHtml(counts[i].unresolvedOmitted, API)] : []),
        ...rule.skipped.map((s) => esc(s.path + ' · ' + s.reason)),
        ...(counts?.[i]?.skippedOmitted ? [countedHtml(counts[i].skippedOmitted, API)] : []),
      ];
      return (
        '<tr class="cfg-pattern-row"><td' +
        defAttrs('config.patterns.rule') +
        '><b>' +
        esc(rule.id) +
        '</b><div>' +
        esc(rule.file) +
        '</div></td>' +
        columns.map((key) => '<td>' + countedHtml(counts && counts[i] && counts[i][key], API) + '</td>').join('') +
        '</tr>' +
        (details.length
          ? '<tr><td colspan="6"><ul>' + details.map((note) => '<li>' + note + '</li>').join('') + '</ul></td></tr>'
          : '')
      );
    })
    .join('');
  return (
    '<section class="cfg-patterns"><div class="cfg-sub"' +
    defAttrs('config.patterns.title') +
    '>' +
    esc(t('config.patterns.title')) +
    ' · <span' +
    defAttrs('count.scope.source') +
    '>' +
    esc(t('count.scope.source')) +
    '</span></div><table class="src-table cfg-table"><tbody>' +
    rows +
    '</tbody></table></section>'
  );
}

async function changeOpenApi(event) {
  const button = event.target.closest('[data-openapi-action]');
  if (!button || readOnlyWhy() || button.disabled) return;
  const { source: id, path, openapiAction: action } = button.dataset;
  const row = button.closest('.cfg-openapi-row');
  const note = button.closest('.cfg-openapi').querySelector('.cfg-openapi-note');
  const controls = row.querySelectorAll('button');
  controls.forEach((el) => {
    el.disabled = true;
  });
  try {
    const url = '/api/sources/' + encodeURIComponent(id) + '/openapi';
    const response = await fetch(action === 'dismiss' ? url + '?path=' + encodeURIComponent(path) : url, {
      method: action === 'dismiss' ? 'DELETE' : 'POST',
      ...(action === 'register'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }
        : {}),
    });
    if (!response.ok) throw new Error(String(response.status));
    // The Settings save/sync sends its draft wholesale. Keep just these saved fields
    // current so that pressing Sync cannot silently undo the registration.
    const source = S.SETTINGS.sources.find((s) => s.id === id);
    if (source) {
      source.openapi = (source.openapi || []).filter((d) => (d.url || d.path) !== path);
      source.openapiIgnore = (source.openapiIgnore || []).filter((p) => p !== path);
      if (action === 'register') source.openapi.push({ path });
      else source.openapiIgnore.push(path);
    }
    row.querySelector('.cfg-openapi-actions').textContent = t('config.openapi.saved');
    note.textContent = t('config.openapi.saved');
  } catch {
    note.textContent = t('config.openapi.failed');
    controls.forEach((el) => {
      el.disabled = false;
    });
  }
}

/** The list for every source the graph recorded config files for, as HTML. Pure over its input. */
export function configFilesHtml(data, lens) {
  lens = lens || currentLens();
  const metas = (data && data.config) || {};
  const openapi = (data && data.openapi) || {};
  const patterns = (data && data.patterns) || {};
  const repos = [...new Set([...Object.keys(metas), ...Object.keys(openapi), ...Object.keys(patterns)])].sort();
  if (!repos.length) return '<div class="set-note cfg-none">' + esc(t('config.none')) + '</div>';
  return repos
    .map((repo) => {
      const meta = metas[repo] || {};
      const counts = (data.counts && data.counts[repo]) || {};
      const rows = (meta.files || [])
        .map((f) => {
          const scope = f.root
            ? '<span class="cfg-scope cfg-root"' +
              defAttrs('config.scope.root') +
              '>' +
              esc(t('config.scope.root')) +
              '</span>'
            : '<span class="cfg-scope"' +
              defAttrs('config.scope.dir') +
              '>' +
              esc(fill('config.scope.dir', { dir: f.dir })) +
              '</span>';
          const gives =
            f.fields && f.fields.length
              ? f.fields.map((x) => fieldHtml(x, lens)).join(' ')
              : '<span class="set-note"' + defAttrs('config.noFields') + '>' + esc(t('config.noFields')) + '</span>';
          const ignored =
            f.ignored && f.ignored.length
              ? '<span class="cfg-ign-l"' +
                defAttrs('config.ignored') +
                '>' +
                esc(t('config.ignored')) +
                '</span> ' +
                f.ignored.map((x) => fieldHtml(x, lens)).join(' ')
              : '';
          return (
            '<tr class="cfg-row" data-path="' +
            esc(f.path) +
            '">' +
            '<td class="mono cfg-path">' +
            esc(f.path) +
            ' ' +
            vsl(repo, f.path, 1) +
            '</td>' +
            '<td>' +
            scope +
            '</td>' +
            '<td class="cfg-gives"><span class="cfg-gives-l"' +
            defAttrs('config.gives') +
            '>' +
            esc(t('config.gives')) +
            '</span> ' +
            gives +
            '</td>' +
            '<td class="cfg-ign">' +
            ignored +
            '</td></tr>'
          );
        })
        .join('');
      const conflicts = (meta.conflicts || [])
        .map(
          (c) =>
            '<li class="cfg-conflict" data-kind="' +
            esc(c.kind) +
            '"' +
            defAttrs('config.conflict.' + c.kind) +
            '>' +
            esc(fill('config.conflict.' + c.kind, { key: c.key, files: (c.files || []).join(', '), kept: c.kept })) +
            '</li>',
        )
        .join('');
      // with the configuration's own notes, where the design and the code disagree about who uses a screen
      const personaNotes = (data.personaNotes && data.personaNotes[repo]) || [];
      const notes = [...(meta.notes || []), ...personaNotes]
        .map((n) => '<li class="cfg-note">' + esc(n) + '</li>')
        .join('');
      return (
        '<div class="cfg-src" data-repo="' +
        esc(repo) +
        '">' +
        '<div class="cfg-head"><b>' +
        esc(repo) +
        '</b> ' +
        countedHtml(counts.files, API, { cls: 'cnt-n cfg-n-files' }) +
        (counts.conflicts && counts.conflicts.n
          ? ' · ' + countedHtml(counts.conflicts, API, { cls: 'cnt-n cfg-n-conflicts' })
          : '') +
        '</div>' +
        '<table class="src-table cfg-table"><tbody>' +
        rows +
        '</tbody></table>' +
        (conflicts
          ? '<div class="cfg-sub"' +
            defAttrs('config.conflicts') +
            '>' +
            esc(t('config.conflicts')) +
            '</div><ul class="cfg-list">' +
            conflicts +
            '</ul>'
          : '') +
        (notes
          ? '<div class="cfg-sub"' +
            defAttrs('config.notes') +
            '>' +
            esc(t('config.notes')) +
            '</div><ul class="cfg-list cfg-notes">' +
            notes +
            '</ul>'
          : '') +
        openApiHtml(repo, openapi[repo], data.openapiCounts && data.openapiCounts[repo]) +
        patternsHtml(patterns[repo], data.patternCounts && data.patternCounts[repo]) +
        '</div>'
      );
    })
    .join('');
}

/** Draw the list into the Settings page, asking the server again when the graph changed since the last answer. */
export function renderConfigFiles() {
  const host = document.getElementById('cfgrows');
  if (!host) return;
  const title = document.getElementById('set-config-title');
  if (title) {
    title.textContent = t('config.title');
    title.setAttribute('data-tip', 'config.title');
  }
  const sub = document.getElementById('set-config-sub');
  if (sub) sub.textContent = t('config.sub');
  const key = (S.GRAPH && S.GRAPH.meta && S.GRAPH.meta.generatedAt) || '';
  const draw = () => {
    host.innerHTML = cache.error
      ? '<div class="set-note">' + esc(t('config.failed')) + '</div>'
      : configFilesHtml(cache.data);
    host.onclick = changeOpenApi;
    applyReadOnly(host);
  };
  if (cache.key === key && (cache.data || cache.error)) {
    draw();
    return;
  }
  if (cache.pending) return;
  cache.pending = fetch(API)
    .then((r) => (r.ok ? r.json() : r.status === 404 ? { config: {} } : Promise.reject(new Error(String(r.status)))))
    .then((d) => {
      cache.data = d;
      cache.error = false;
    })
    .catch(() => {
      cache.data = null;
      cache.error = true;
    })
    .finally(() => {
      cache.key = key;
      cache.pending = null;
      draw();
    });
}
