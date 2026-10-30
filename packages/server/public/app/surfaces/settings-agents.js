import { esc } from '../store.js';
import { t } from '../strings.js';
import { defAttrs } from '../lib/counted.js';
import { fieldHtml, rowEditor } from '../lib/row-editor.js';
import { readAt, writeAt } from '../lib/settings-model.js';
import { readOnlyWhy } from '../lib/read-only.js';

export function renderAgents(root, { draft, changed }) {
  root.innerHTML = `<section class="set-sec settings-fields">${fieldHtml({ key: 'settings.tools', path: 'mcp.tools', value: draft.mcp?.tools || 'core', options: ['core', 'all'] })}${fieldHtml({ key: 'settings.budget', path: 'mcp.budget', value: draft.mcp?.budget, type: 'number', optional: true })}</section><section id="set-lessons" class="set-sec"><h2 id="set-lessons-title"${defAttrs('set.lessons.title')}>${esc(t('set.lessons.title'))}</h2><p class="set-note">${esc(t('set.lessons.sub'))}</p><div id="lessonrows"></div></section><section class="set-sec"><h2${defAttrs('settings.grantsSummary')}>${esc(t('settings.grantsSummary'))}</h2>${
    (draft.sources || [])
      .filter((s) => s.type === 'work')
      .map(
        (s) =>
          `<article class="settings-access"><h3>${esc(s.name)}</h3><p${defAttrs('settings.mode')}>${esc(t('settings.value.' + (s.mode || 'read-only')))}</p>${
            (s.permissions?.grants || [])
              .filter((g) => !g.principals || g.principals.includes('agent'))
              .map(
                (g) =>
                  `<p>${(g.actions || []).map((a) => `<span${defAttrs('settings.value.' + a)}>${esc(t('settings.value.' + a))}</span>`).join(' · ')} · ${esc(t('settings.value.' + (g.confirm || 'always')))}${g.scope || g.fields || g.to ? ` · <span${defAttrs('settings.grantRestrictions')}>${esc(t('settings.grantRestrictions'))}</span>` : ''}</p>`,
              )
              .join('') || `<p class="set-note">${esc(t('settings.grantsEmpty'))}</p>`
          }<p${defAttrs('settings.agentWrites')}>${esc(t('settings.agentWrites'))}: ${esc(t('settings.value.' + (s.permissions?.agentWrites || 'confirm')))}</p></article>`,
      )
      .join('') || `<p class="set-note">${esc(t('settings.grantsEmpty'))}</p>`
  }<a href="#/settings/sources"${defAttrs('settings.permissions')}>${esc(t('settings.permissions'))}</a></section>`;
  const rows = draft.lessons || [];
  const commit = () => {
    draft.lessons = rows;
    changed();
  };
  rowEditor(root.querySelector('#lessonrows'), {
    rows,
    label: 'set.lessons.title',
    empty: 'settings.lessonsEmpty',
    addKey: 'set.lessons.add',
    add: () => ({ text: '', pinned: true, date: new Date().toISOString().slice(0, 10) }),
    onChange: commit,
    columns: [
      {
        key: 'settings.lessonText',
        html: (row, i) => fieldHtml({ key: 'settings.lessonText', path: `lessons[${i}].text`, value: row.text }),
      },
      {
        key: 'settings.lessonPinned',
        html: (row, i) =>
          fieldHtml({
            key: 'settings.lessonPinned',
            path: `lessons[${i}].pinned`,
            value: row.pinned,
            type: 'checkbox',
          }),
      },
    ],
    input(event, row) {
      const input = event.target;
      if (!input.dataset.field) return;
      if (input.type === 'checkbox') row.pinned = input.checked;
      else row.text = input.value;
      commit();
      event.stopPropagation();
    },
  });
  root.oninput = (event) => {
    const input = event.target.closest('[data-field]');
    if (!input || input.closest('#lessonrows') || readOnlyWhy()) return;
    const path = input.dataset.field;
    const value = input.value === '' ? undefined : path === 'mcp.budget' ? Number(input.value) : input.value;
    if (readAt(draft, path) !== value) {
      writeAt(draft, path, value);
      changed();
    }
  };
}
