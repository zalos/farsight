import { esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { pickerHtml, resetPicker } from '../lib/multi-pick.js';
import { fieldHtml, rowEditor } from '../lib/row-editor.js';
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';

export function renderCollections(root, { draft, changed }) {
  const rows = draft.collections || [];
  const commit = () => {
    draft.collections = rows;
    changed();
  };
  root.innerHTML = `<p class="set-note settings-collection-help">${esc(t('settings.collectionHelp'))}</p><div class="settings-collection-editor"></div>`;
  rowEditor(root.querySelector('.settings-collection-editor'), {
    rows,
    label: 'settings.collections',
    empty: 'set.noCollections',
    addKey: 'settings.addCollection',
    add: () => ({ name: '', sourceIds: [] }),
    onChange: commit,
    columns: [
      {
        key: 'settings.name',
        html: (row, i) => fieldHtml({ key: 'settings.name', path: `collections[${i}].name`, value: row.name }),
      },
      {
        key: 'settings.members',
        html: (row, i) => {
          const id = 'settings-members-' + i;
          resetPicker(id);
          return `<div>${pickerHtml(id, {
            options: (draft.sources || []).map((s) => ({ id: s.id, word: s.name, group: 'sources' })),
            groups: [
              { key: 'sources', word: t(currentLens() === 'business' ? 'settings.systems' : 'settings.sources') },
            ],
            selected: row.sourceIds,
            multi: true,
            label: t('settings.members'),
            placeholder: t('settings.findMember'),
            onChange(ids) {
              if (readOnlyWhy()) return;
              row.sourceIds = ids;
              commit();
              applyReadOnly(root);
            },
          })}</div><p class="settings-problem" data-problem-for="collections[${i}].sourceIds" hidden></p>`;
        },
      },
    ],
    input(event, row) {
      if (event.target.matches('[data-field]')) {
        row.name = event.target.value;
        commit();
      }
    },
    afterRender() {
      root
        .querySelectorAll('[data-mp] input,[data-mp] button,[data-mp] [role="option"]')
        .forEach((el) => el.setAttribute('data-write', ''));
      applyReadOnly(root);
    },
  });
}
