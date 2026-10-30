// Seven views over the workspace overlay. The shell owns validation, Save and Discard.
import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { countedHtml, defAttrs } from '../lib/counted.js';
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';
import { rowEditor, fieldHtml, buttonHtml } from '../lib/row-editor.js';
import * as model from '../lib/settings-model.js';

const key = (name) => 'settings.forms.' + name;
export const formTitleKey = (form) =>
  key(currentLens() === 'business' && ['nodes', 'openapi'].includes(form) ? form + 'Business' : form);
const options = (values, optional = false) => [
  ...(optional ? [['', 'settings.value.unset']] : []),
  ...values.map((value) => [value, key('value.' + value)]),
];
const tiers = ['business', 'policy', 'technical'];
const matchers = ['call', 'decorator', 'annotation', 'query', 'regex'];
const kinds = ['route', 'guard', 'external', 'queue', 'rule', 'flag', 'entrypoint'];
const lines = (value) =>
  String(value)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const fill = (name, vars) =>
  Object.entries(vars).reduce((text, [k, v]) => text.split('{' + k + '}').join(v), t(key(name)));
const sample = { action: 'approve', resource: 'invoice', 0: 'approve', 1: 'invoice' };

function newRow(path, rows, form) {
  let name = t(key('untitled'));
  while (rows.some((r) => r.path === path && r.key === name)) name += '_';
  const base = { path };
  if (path === 'patterns')
    return {
      ...base,
      value: {
        id: '',
        files: [],
        match: { call: '' },
        emit: { kind: 'route', method: 'GET', path: '', handler: 'enclosing' },
      },
    };
  if (path === 'nodes') return { ...base, value: { kind: form === 'endpoints' ? 'route' : 'guard', name: '' } };
  if (path === 'openapi') return { ...base, value: { path: '' } };
  if (path === 'openapiIgnore' || path.endsWith('.delegates')) return { ...base, value: '' };
  if (path === 'externals') return { ...base, value: { name: '', kind: 'http', import: '' } };
  if (path === 'stores') return { ...base, value: { name: '', kind: 'sql' } };
  let value = {};
  if (path.endsWith('.security') || path.endsWith('.guards') || path.endsWith('.middleware'))
    value = { label: '$action on $resource', tier: 'policy', requires: '$action' };
  else if (path === 'guards' || path === 'tags' || path === 'entrypoints') value = [];
  else if (path === 'gateTiers') value = 'policy';
  else if (path.endsWith('.mappings')) value = { method: 'GET', path: 'arg:0' };
  else if (path.endsWith('.verbs')) value = 'GET';
  else if (path === 'glossary') value = { label: '' };
  return { ...base, key: name, value };
}

function rowPath(row, sourceIndex, form) {
  const prefix = `sources[${sourceIndex}]${form === 'openapi' ? '' : '.config'}.${row.path}`;
  return row.key !== undefined ? prefix + '.' + row.key : prefix + '[' + row.index + ']';
}
function field(row, name, label, path, value, config = {}) {
  return fieldHtml({
    key: key(label),
    path: path + (name === '$value' || name === '$key' ? '' : '.' + name),
    value,
    ...config,
  }).replace('data-field=', `data-form-field="${esc(name)}" data-field=`);
}
function rowHtml(row, index, ctx) {
  const { sourceIndex, form, report } = ctx;
  const path = rowPath(row, sourceIndex, form);
  const v = row.value;
  const f = (name, label = name, config = {}) => field(row, name, label, path, model.readAt(v, name), config);
  const text = (name, label = name) => f(name, label, { type: 'textarea' });
  const list = (name, label = name) =>
    field(row, name, label, path, (model.readAt(v, name) || []).join('\n'), { type: 'textarea' });
  const value = (label, config = {}) => field(row, '$value', label, path, Array.isArray(v) ? v.join('\n') : v, config);
  let html =
    row.key !== undefined
      ? field(row, '$key', 'key', path, row.key, { id: `form-${sourceIndex}-${form}-${index}-key` })
      : '';
  if (/\.(security|guards|middleware)$/.test(row.path)) {
    html += f('label') + f('tier', 'tier', { options: options(tiers, true) }) + f('requires', 'grant');
    html += `<div class="set-note settings-label-preview"${defAttrs(key('preview'))}>${esc(t(key('preview')))}: <output>${esc(model.labelPreview(v.label, sample, row.key))}</output></div>`;
  } else if (row.path === 'guards') html += value('routeMatchers', { type: 'textarea' });
  else if (row.path === 'gateTiers') html += value('tier', { options: options(tiers) });
  else if (row.path.endsWith('.mappings')) html += f('method') + f('path');
  else if (row.path.endsWith('.verbs')) html += value('method');
  else if (row.path.endsWith('.delegates')) html += value('delegate');
  else if (row.path === 'nodes') {
    if (form !== 'endpoints') html += f('kind', 'kind', { options: options(['route', 'guard', 'external', 'queue']) });
    html +=
      f('name') +
      f('loc') +
      f('handler') +
      list('guards') +
      f('tier', 'tier', { options: options(tiers, true) }) +
      text('business');
    const notes = (report?.notes || []).filter((note) => v.name && note.includes(v.name));
    html += `<aside class="settings-form-audit"${defAttrs(key('audit'))}><b>${esc(t(key('audit')))}</b><ul>${(notes.length ? notes : [t(key('noAudit'))]).map((note) => `<li>${esc(note)}</li>`).join('')}</ul></aside>`;
  } else if (row.path === 'patterns') {
    const matcher = matchers.find((name) => Object.hasOwn(v.match || {}, name)) || 'call';
    html += f('id') + field(row, 'files', 'files', path, (v.files || []).join('\n'), { type: 'textarea' });
    html += field(row, '$matcher', 'matcher', path + '.match', matcher, { options: options(matchers) });
    html += field(row, 'match.' + matcher, 'expression', path, v.match?.[matcher], { type: 'textarea' });
    if (['call', 'decorator', 'annotation'].includes(matcher))
      html += field(
        row,
        'match.args',
        'args',
        path,
        Object.entries(v.match?.args || {})
          .map(([k, v]) => k + '=' + v)
          .join('\n'),
        { type: 'textarea' },
      );
    html += f('emit.kind', 'emit', { options: options(kinds) });
    const emitted = v.emit?.kind;
    html += f('emit.name', 'emitName');
    if (emitted === 'route') html += f('emit.method', 'emitMethod') + f('emit.path', 'emitPath');
    if (emitted === 'queue')
      html += f('emit.topic', 'emitTopic') + f('emit.publishes', 'emitPublishes') + f('emit.consumes', 'emitConsumes');
    html += f('emit.handler', 'handler');
    if (emitted === 'guard')
      html +=
        f('emit.guards', 'guards') +
        f('emit.requires', 'emitRequires') +
        f('emit.tier', 'tier', { options: options(tiers, true) });
    if (emitted === 'rule')
      html += f('emit.validates', 'emitValidates') + f('emit.tier', 'tier', { options: options(tiers, true) });
    html += list('emit.tags', 'emitTags') + text('business') + text('emit.business', 'business');
    html += `<div class="settings-pattern-actions">${buttonHtml(key('test'), `data-pattern-test="${index}"`)}${buttonHtml(key('untested'), `data-pattern-untested="${index}"`)}<p data-pattern-state="${index}" role="status"></p></div><div data-pattern-result="${index}" class="settings-pattern-result"></div>`;
  } else if (row.path === 'openapi') {
    html += field(row, '$document', 'documentRef', path, v.url || v.path) + f('name', 'documentName') + f('phase');
  } else if (row.path === 'openapiIgnore') html += value('ignored');
  else if (row.path === 'glossary') html += f('label', 'wordLabel') + text('description');
  else if (row.path === 'tags' || row.path === 'entrypoints') html += value('matchers', { type: 'textarea' });
  else if (row.path === 'externals')
    html +=
      f('name') +
      f('kind', 'kind', { options: options(['erp', 'ocr', 'files', 'email', 'queue', 'db', 'http', 'party']) }) +
      f('import') +
      f('store', 'store', { options: options(['true', 'false'], true) }) +
      text('role') +
      f('persona');
  else if (row.path === 'stores')
    html +=
      f('name') +
      f('kind', 'kind', { options: options(['sql', 'document', 'files', 'erp', 'other']) }) +
      f('engine', 'engine', { options: options(['postgres', 'mysql', 'sqlite', 'mssql', 'mongodb'], true) }) +
      list('tables');
  const available = form === 'openapi' || model.supportsField(S.VERSION, row.path.split('.')[0]);
  return `<fieldset class="settings-form-fields${available ? '' : ' settings-unavailable'}"${available ? '' : ' disabled'}><legend${defAttrs(key('row.' + row.path))}>${esc(t(key('row.' + row.path)))}</legend>${!available ? `<p>${esc(t('settings.notInBuild'))}</p>` : ''}${html}</fieldset><p class="settings-problem" data-problem-for="${esc(path)}" hidden></p>`;
}

function updateValue(row, name, value) {
  if (name === '$key') row.key = value;
  else if (name === '$value') row.value = Array.isArray(row.value) ? lines(value) : value;
  else if (name === '$document') {
    delete row.value.path;
    delete row.value.url;
    row.value[/^https?:/i.test(value) ? 'url' : 'path'] = value;
  } else if (name === '$matcher')
    row.value.match = {
      [value]: '',
      ...(['call', 'decorator', 'annotation'].includes(value) && row.value.match?.args
        ? { args: row.value.match.args }
        : {}),
    };
  else if (name === 'match.args') {
    const args = Object.fromEntries(
      lines(value).map((line) => {
        const at = line.indexOf('=');
        const capture = at < 0 ? line : line.slice(0, at).trim();
        const selector = at < 0 ? '' : line.slice(at + 1).trim();
        return [capture, /^-?\d+$/.test(selector) ? Number(selector) : selector];
      }),
    );
    model.writeAt(row.value, name, Object.keys(args).length ? args : undefined);
  } else if (name === 'files') row.value.files = value.trim().split(/\s+/).filter(Boolean);
  else if (name === 'guards' || name === 'tables' || name === 'emit.tags')
    model.writeAt(row.value, name, value ? lines(value) : undefined);
  else if (name === 'store') model.writeAt(row.value, name, value === '' ? undefined : value === 'true');
  else model.writeAt(row.value, name, value === '' && !['id', 'name', 'label'].includes(name) ? undefined : value);
}

export function patternResultHtml(result) {
  const counts = model.patternTestCounted(result);
  const summary = [counts.rules, counts.matches, result.matchCounts?.returned, result.matchCounts?.omitted]
    .filter(Boolean)
    .map((c) => countedHtml(c, 'POST /api/patterns/test'))
    .join(' · ');
  const matches = [...result.matches].sort((a, b) => Number(!!b.unresolved.length) - Number(!!a.unresolved.length));
  const diagnostics = result.report.rules.flatMap((rule, i) => [
    ...(rule.skipped || []).map((skip) => esc(skip.path + ' · ' + skip.reason)),
    ...(result.counts?.[i]?.skippedOmitted
      ? [countedHtml(result.counts[i].skippedOmitted, 'POST /api/patterns/test')]
      : []),
  ]);
  return `<p>${summary}</p>${
    matches.length
      ? `<ul>${matches
          .map(
            (match) =>
              `<li>${esc(
                fill('match', {
                  site: match.path + ':' + match.line,
                  captures: JSON.stringify(match.captures),
                  kind: t(key('value.' + match.kind)),
                  name: match.name,
                  handler: match.unresolved.length
                    ? t('config.patterns.unresolved') + ' (' + match.unresolved.join(', ') + ')'
                    : match.handler || t('config.patterns.noHandler'),
                }),
              )}</li>`,
          )
          .join('')}</ul>`
      : `<p>${esc(t(key('noMatches')))}</p>`
  }${diagnostics.length ? `<ul>${diagnostics.map((note) => `<li>${note}</li>`).join('')}</ul>` : ''}`;
}

/** One form uses the shared row editor; all changes replace only its slice of the shared draft. */
export function renderOverlayForm(root, { source, sourceIndex, form, report, changed, patternChecks }) {
  let addPath = model.formPaths[form][0];
  const block = () => (form === 'openapi' ? source : source.config || {});
  const rows = model.rowsOf(block(), form);
  const code = currentLens() !== 'business';
  const supported = (path) => form === 'openapi' || model.supportsField(S.VERSION, path.split('.')[0]);
  const available = model.formPaths[form].filter(supported);
  addPath = available[0] || addPath;
  root.innerHTML = `<header class="settings-form-heading"><h3${defAttrs(formTitleKey(form))}>${esc(t(formTitleKey(form)))}</h3>${code ? `<button type="button" class="btn" data-form-json aria-expanded="false"${defAttrs(key('json'))}>${esc(t(key('json')))}</button>` : ''}</header><p class="set-note">${esc(t(key('empty.' + form)))}</p>${code ? `<p class="set-note settings-form-paths"><code>${esc(model.formPaths[form].join(' · '))}</code></p><pre class="settings-form-json" hidden></pre>` : ''}<div class="settings-form-add">${fieldHtml({ key: key('rowType'), path: `form-${sourceIndex}-${form}-type`, value: addPath, options: model.formPaths[form].map((p) => [p, key('row.' + p)]) })}</div><div class="settings-form-rows"></div><p class="settings-problem" data-problem-for="sources[${sourceIndex}]${form === 'openapi' ? '.openapi' : '.config'}" hidden></p>`;
  const type = root.querySelector('.settings-form-add select');
  for (const option of type.options)
    if (!supported(option.value)) {
      option.disabled = true;
      option.textContent += ' · ' + t('settings.notInBuild');
    }
  type.oninput = () => {
    addPath = type.value;
  };
  const json = root.querySelector('.settings-form-json');
  const updateJson = () => {
    if (json) json.textContent = JSON.stringify(model.formBlock(block(), form), null, 2);
  };
  root.querySelector('[data-form-json]')?.addEventListener('click', (event) => {
    json.hidden = !json.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!json.hidden));
    updateJson();
  });
  const commit = () => {
    const next = model.blockOf(rows, block(), form);
    if (form === 'openapi') {
      if (Object.hasOwn(next, 'openapi')) source.openapi = next.openapi;
      if (Object.hasOwn(next, 'openapiIgnore')) source.openapiIgnore = next.openapiIgnore;
    } else source.config = next;
    rows.splice(0, rows.length, ...model.rowsOf(block(), form));
    updateJson();
    changed();
  };
  const grid = root.querySelector('.settings-form-rows');
  const paintTests = () => {
    if (form !== 'patterns') return;
    rows.forEach((row, i) => {
      const saved = patternChecks.get(model.patternStamp(source, row.value));
      const state = grid.querySelector(`[data-pattern-state="${i}"]`);
      if (state)
        state.textContent = saved
          ? t(key(saved.kind === 'tested' ? 'tested' : 'acceptedUntested'))
          : t(key('needsTest'));
      const result = grid.querySelector(`[data-pattern-result="${i}"]`);
      if (result) result.innerHTML = saved?.result ? patternResultHtml(saved.result) : '';
    });
  };
  const editor = rowEditor(grid, {
    label: formTitleKey(form),
    rows,
    empty: key('empty.' + form),
    add: () => newRow(addPath, rows, form),
    columns: [{ key: key('entry'), html: (row, i) => rowHtml(row, i, { sourceIndex, form, report }) }],
    onChange: commit,
    input: (event, row, index) => {
      const name = event.target.dataset.formField;
      if (!name || !supported(row.path)) return;
      if (
        name === '$key' &&
        rows.some((other) => other !== row && other.path === row.path && other.key === event.target.value)
      ) {
        event.target.value = row.key;
        const note = event.target.closest('.settings-field').querySelector('.settings-problem');
        note.hidden = false;
        note.textContent = t(key('duplicate'));
        return;
      }
      updateValue(row, name, event.target.value);
      commit();
      if (name === '$matcher' || name === 'emit.kind' || name === 'kind') editor.draw(index);
      else {
        const preview = event.target.closest('tr').querySelector('.settings-label-preview output');
        if (preview) preview.textContent = model.labelPreview(row.value.label, sample, row.key);
        paintTests();
      }
    },
    afterRender: () => {
      for (const [i, row] of rows.entries())
        if (!supported(row.path))
          grid.querySelectorAll(`[data-row="${i}"] [data-write]`).forEach((el) => {
            el.disabled = true;
            el.setAttribute('data-unsupported', '');
          });
      if (!available.length)
        root.querySelectorAll('[data-write]').forEach((el) => {
          el.disabled = true;
          el.setAttribute('data-unsupported', '');
        });
      paintTests();
    },
  });
  grid.onchange = (event) => {
    if (event.target.dataset.formField === '$key') editor.draw();
  };
  grid.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pattern-test],[data-pattern-untested]');
    if (!button || readOnlyWhy() || button.disabled) return;
    const index = Number(button.dataset.patternTest ?? button.dataset.patternUntested);
    const row = rows[index];
    if (!row) return;
    const stamp = model.patternStamp(source, row.value);
    if (button.hasAttribute('data-pattern-untested')) {
      patternChecks.set(stamp, { kind: 'untested' });
      changed();
      paintTests();
      return;
    }
    const state = grid.querySelector(`[data-pattern-state="${index}"]`);
    const savedSource = S.SETTINGS.sources.find((s) => s.id === source.id);
    if (!savedSource || model.patternStamp(source, {}) !== model.patternStamp(savedSource, {})) {
      state.textContent = t(key('testSourceChanged'));
      return;
    }
    state.textContent = t(key('testing'));
    button.disabled = true;
    try {
      const response = await fetch('/api/patterns/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: source.id, rule: row.value }),
      });
      const result = await response.json();
      if (!response.ok) {
        state.textContent = result.error || t(key('failed'));
        return;
      }
      // A response for an earlier edit stays attached only to that exact edit.
      patternChecks.set(stamp, { kind: 'tested', result });
      changed();
      paintTests();
    } catch {
      state.textContent = t(key('failed'));
    } finally {
      button.disabled = false;
      applyReadOnly(root);
    }
  });
  applyReadOnly(root);
  if (!available.length)
    root.querySelectorAll('[data-write]').forEach((el) => {
      el.disabled = true;
      el.setAttribute('data-unsupported', '');
    });
}
