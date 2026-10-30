import { S, esc } from '../store.js';
import { t } from '../strings.js';
import { defAttrs, countedHtml } from '../lib/counted.js';
import { setTip } from '../lib/tooltip.js';
import { fieldHtml, buttonHtml, rowEditor } from '../lib/row-editor.js';
import * as model from '../lib/settings-model.js';
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';
import { sentinelScanDoorHtml } from './sentinel.js';

const newSources = new WeakSet();
const actions = ['comment', 'edit', 'assign', 'transition', 'link', 'label', 'create'];
const labels = {
  name: 'name',
  type: 'type',
  path: 'path',
  enabled: 'enabled',
  exclude: 'exclude',
  'storybook.url': 'storybookUrl',
  'storybook.command': 'storybookCommand',
  provider: 'provider',
  site: 'site',
  org: 'org',
  'scope.projects': 'projects',
  mode: 'mode',
  'auth.kind': 'authKind',
  'auth.user': 'authUser',
  'auth.secret': 'authSecret',
  poll: 'poll',
};
const choices = {
  type: Object.keys(model.sourceFields),
  provider: ['jira', 'azure-devops', 'fixture'],
  mode: [
    ['read-only', 'settings.mode.read-only'],
    ['edit', 'settings.mode.edit'],
  ],
  'auth.kind': [
    'none',
    'api-token',
    'scoped-token',
    'oauth-3lo',
    'entra-device-code',
    'entra-auth-code',
    'az-cli',
    'pat',
  ],
};
const lists = new Set(['exclude', 'scope.projects']);

function sourceForm(source, index) {
  return `<div class="settings-fields">${(model.sourceFields[source.type] || [])
    .filter(
      (path) =>
        path !== 'permissions' &&
        !(
          source.type === 'work' &&
          ((path === 'path' && source.provider !== 'fixture') ||
            (path === 'site' && source.provider !== 'jira') ||
            (path === 'org' && source.provider !== 'azure-devops'))
        ),
    )
    .map((path) => {
      const value = model.readAt(source, path);
      const field = fieldHtml({
        key: 'settings.' + labels[path],
        path: `sources[${index}].${path}`,
        value: lists.has(path) ? (value || []).join(path === 'exclude' ? ' ' : ', ') : value,
        options: choices[path],
        type: path === 'enabled' ? 'checkbox' : 'text',
        hint: path === 'auth.secret' ? 'settings.secretHint' : '',
        optional: !['name', 'path'].includes(path),
      });
      if (path !== 'auth.secret') return field;
      return `<div>${field}<div class="settings-secret-prefix">${['keychain:', 'env:'].map((prefix) => buttonHtml(prefix === 'keychain:' ? 'settings.keychainRef' : 'settings.envRef', `data-secret-prefix="${prefix}" data-secret-source="${index}"`)).join('')}</div></div>`;
    })
    .join(
      '',
    )}</div>${source.type === 'work' ? `<section class="settings-permissions"><h3${defAttrs('settings.permissions')}>${esc(t('settings.permissions'))}</h3><div class="permissions-rows" data-permissions="${index}"></div><div class="settings-fields">${fieldHtml({ key: 'settings.agentWrites', path: `sources[${index}].permissions.agentWrites`, value: source.permissions?.agentWrites || 'confirm', options: ['confirm', 'allow'] })}${fieldHtml({ key: 'settings.attribution', path: `sources[${index}].permissions.attribution`, value: source.permissions?.attribution || 'prefix', options: ['prefix', 'none'] })}</div></section>` : ''}`;
}

function renderPermissions(root, source, index, changed) {
  const confirmationTip = (input) =>
    setTip(input.closest('[role="gridcell"]'), {
      id: 'def',
      args: { key: 'settings.value.' + (input.value || 'unset') },
    });
  // Missing grants remain missing until the editor is changed.
  const rows = source.permissions?.grants || [];
  const commit = () => {
    source.permissions ||= {};
    source.permissions.grants = rows;
    changed();
  };
  rowEditor(root, {
    rows,
    label: 'settings.permissions',
    empty: 'settings.grantsEmpty',
    add: () => ({ actions: ['comment'], principals: ['human'], confirm: 'always' }),
    onChange: commit,
    afterRender: () => root.querySelectorAll('[data-field$=".confirm"]').forEach(confirmationTip),
    columns: [
      {
        key: 'settings.actions',
        html: (row, i) =>
          `<div class="settings-grant-actions">${actions.map((a) => `<label${defAttrs('settings.action.' + a)}><input type="checkbox" data-write data-action="${a}"${row.actions?.includes(a) ? ' checked' : ''}/> ${esc(t('settings.action.' + a))}</label>`).join('')}</div>${row.scope || row.fields || row.to ? `<p class="set-note"${defAttrs('settings.grantRestrictions')}>${esc(t('settings.grantRestrictions'))}</p>` : ''}<p class="settings-problem" data-problem-for="sources[${index}].permissions.grants[${i}]" hidden></p>`,
      },
      ...['human', 'agent'].map((principal) => ({
        key: 'settings.' + principal,
        html: (row) =>
          `<input type="checkbox" data-write data-principal="${principal}" aria-label="${esc(t('settings.' + principal))}"${!row.principals || row.principals.includes(principal) ? ' checked' : ''}/>`,
      })),
      {
        key: 'settings.confirm',
        html: (row, i) =>
          fieldHtml({
            key: 'settings.confirm',
            path: `sources[${index}].permissions.grants[${i}].confirm`,
            value: row.confirm || '',
            options: [['', 'settings.value.unset'], 'always', 'agent', 'never'],
          }),
      },
    ],
    input(event, row) {
      const input = event.target;
      if (input.dataset.action)
        row.actions = input.checked
          ? [...new Set([...(row.actions || []), input.dataset.action])]
          : (row.actions || []).filter((a) => a !== input.dataset.action);
      else if (input.dataset.principal) {
        const current = row.principals || ['human', 'agent'];
        row.principals = input.checked
          ? [...new Set([...current, input.dataset.principal])]
          : current.filter((p) => p !== input.dataset.principal);
      } else if (input.dataset.field) {
        model.writeAt(row, 'confirm', input.value || undefined);
        confirmationTip(input);
      } else return;
      commit();
      event.stopPropagation();
    },
  });
}

export function renderSources(root, context) {
  const { draft, changed, sync } = context;
  let adding = false;
  const statusHtml = (source) => {
    const status = model.sourceStatus(source);
    const details = [
      `<span${defAttrs(status.key)}>${esc(t(status.key))}</span>`,
      ...status.counts.map((count) => countedHtml(count, '/api/settings')),
      ...status.notices.map((key) => `<span${defAttrs(key)}>${esc(t(key))}</span>`),
    ];
    return `<p class="settings-source-status">${details.join(' · ')}</p>${status.reason ? `<p class="set-note">${esc(status.reason)}</p>` : ''}`;
  };
  const draw = () => {
    const generated = S.GRAPH?.meta?.generatedAt;
    const date =
      generated && !Number.isNaN(Date.parse(generated)) ? new Date(generated).toLocaleString() : t('settings.noSync');
    root.innerHTML = `<p class="set-note"${defAttrs('settings.lastSync')}>${esc(t('settings.lastSync').replace('{date}', date))}</p><div id="srcrows">${(draft.sources || []).map((source, i) => `<article class="set-sec settings-source" data-source-card="${esc(source.id)}"><header><h3>${esc(source.name || t('settings.newSource'))}</h3><span class="settings-type"${defAttrs('settings.value.' + source.type)}>${esc(t('settings.value.' + source.type))}</span></header>${statusHtml(source)}${sourceForm(source, i)}<footer>${buttonHtml('settings.sync', 'data-sync')}${source.type === 'local' ? sentinelScanDoorHtml() : ''}${buttonHtml('settings.remove', `data-source-remove="${i}"`)}</footer></article>`).join('') || `<p class="set-note">${esc(t('set.noSources'))}</p>`}</div>${buttonHtml('settings.addSource', 'id="source-add" data-source-add')}<div id="source-add-form"${adding ? '' : ' hidden'}><label class="settings-field"${defAttrs('settings.type')}>${esc(t('settings.type'))}<select id="source-add-type" data-write>${Object.keys(
      model.sourceFields,
    )
      .map((type) => `<option value="${type}">${esc(t('settings.value.' + type))}</option>`)
      .join(
        '',
      )}</select></label>${buttonHtml('settings.addSource', 'data-source-create')}${buttonHtml('settings.cancel', 'data-source-cancel')}</div><p class="set-note">${esc(t('settings.syncAll'))}</p>`;
    root
      .querySelectorAll('[data-permissions]')
      .forEach((host) =>
        renderPermissions(
          host,
          draft.sources[Number(host.dataset.permissions)],
          Number(host.dataset.permissions),
          changed,
        ),
      );
    applyReadOnly(root);
  };
  root.oninput = (event) => {
    const input = event.target.closest('[data-field]');
    if (!input || input.closest('[data-permissions]') || readOnlyWhy()) return;
    const match = /^sources\[(\d+)\]\.(.*)$/.exec(input.dataset.field);
    if (!match) return;
    const source = draft.sources[Number(match[1])];
    const path = match[2];
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if (path === 'auth.secret') {
      // An incomplete hand-typed prefix stays only in this field, never in the draft or a request.
      value = model.secretReference(value);
      model.writeAt(source, path, value || (input.value ? '' : undefined));
      changed();
      return;
    }
    if (lists.has(path))
      value = value
        .split(path === 'exclude' ? /\s+/ : /[,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean);
    if (input.hasAttribute('data-optional') && value === '') value = undefined;
    if (path === 'type') model.changeSourceType(source, value);
    else model.writeAt(source, path, value);
    if (path === 'name' && newSources.has(source))
      source.id = model.sourceId(
        value,
        draft.sources.filter((s) => s !== source),
      );
    if (path === 'provider') {
      if (value !== 'jira') delete source.site;
      if (value !== 'azure-devops') delete source.org;
      if (value !== 'fixture') delete source.path;
    }
    changed();
    if (path === 'type' || path === 'provider') draw();
  };
  root.addEventListener('focusout', (event) => {
    const input = event.target;
    if (input.dataset.field?.endsWith('.auth.secret') && input.value && !model.secretReference(input.value))
      input.value = '';
  });
  root.onpaste = (event) => {
    const input = event.target;
    if (!input.dataset.field?.endsWith('.auth.secret') || readOnlyWhy()) return;
    const pasted = event.clipboardData?.getData('text') || '';
    const result = input.value.slice(0, input.selectionStart) + pasted + input.value.slice(input.selectionEnd);
    event.preventDefault();
    const reference = model.secretReference(result);
    if (reference) input.setRangeText(pasted, input.selectionStart, input.selectionEnd, 'end');
    else input.value = '';
    const index = Number(/^sources\[(\d+)\]/.exec(input.dataset.field)[1]);
    model.writeAt(draft.sources[index], 'auth.secret', reference || (result ? '' : undefined));
    changed();
  };
  root.onclick = (event) => {
    const button = event.target.closest('button');
    if (!button || readOnlyWhy()) return;
    if (button.dataset.secretPrefix) {
      const index = Number(button.dataset.secretSource);
      const path = `sources[${index}].auth.secret`;
      const input = [...root.querySelectorAll('[data-field]')].find((el) => el.dataset.field === path);
      model.writeAt(draft.sources[index], 'auth.secret', button.dataset.secretPrefix);
      input.value = button.dataset.secretPrefix;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      changed();
      return;
    }
    if (button.hasAttribute('data-sync')) {
      sync();
      return;
    }
    if (button.hasAttribute('data-source-add')) {
      adding = true;
      draw();
      root.querySelector('#source-add-type').focus();
    } else if (button.hasAttribute('data-source-cancel')) {
      adding = false;
      draw();
      root.querySelector('#source-add').focus();
    } else if (button.hasAttribute('data-source-create')) {
      const type = root.querySelector('#source-add-type').value;
      const source = { id: model.sourceId('', draft.sources), name: '', type, path: '', enabled: true };
      if (type === 'work')
        Object.assign(source, {
          provider: 'jira',
          mode: 'read-only',
          scope: { projects: [] },
          auth: { kind: 'api-token' },
        });
      newSources.add(source);
      draft.sources.push(source);
      adding = false;
      changed();
      draw();
      root.querySelector('.settings-source:last-child input').focus();
    } else if (button.dataset.sourceRemove !== undefined) {
      draft.sources.splice(Number(button.dataset.sourceRemove), 1);
      changed();
      draw();
      root.querySelector('#source-add').focus();
    }
  };
  draw();
}
