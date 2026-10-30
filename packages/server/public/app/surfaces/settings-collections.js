import { esc } from '../store.js';
import { t } from '../strings.js';
import { pickerHtml, resetPicker } from '../lib/multi-pick.js';
import { fieldHtml, rowEditor } from '../lib/row-editor.js';
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';

export function renderCollections(root, { draft, changed }) {
  const rows = (draft.collections ||= []);
  rowEditor(root, {
    rows,
    label: 'settings.collections',
    empty: 'set.noCollections',
    addKey: 'settings.addCollection',
    add: () => ({ name: '', sourceIds: [] }),
    onChange: changed,
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
          return `<div data-write>${pickerHtml(id, {
            options: (draft.sources || []).map((s) => ({ id: s.id, word: s.name, group: 'sources' })),
            groups: [{ key: 'sources', word: t('settings.systems') }],
            selected: row.sourceIds,
            multi: true,
            label: t('settings.members'),
            placeholder: t('settings.findMember'),
            onChange(ids) {
              if (readOnlyWhy()) return;
              row.sourceIds = ids;
              changed();
              applyReadOnly(root);
            },
          })}</div><p class="settings-problem" data-problem-for="collections[${i}].sourceIds" hidden></p>`;
        },
      },
    ],
    input(event, row) {
      if (event.target.matches('[data-field]')) {
        row.name = event.target.value;
        changed();
      }
    },
    afterRender() {
      root
        .querySelectorAll('[data-mp] input,[data-mp] button,[data-mp] [role="option"]')
        .forEach((el) => el.setAttribute('data-write', ''));
      applyReadOnly(root);
    },
  });
  // Explain collections once; the grid and picker supply the controls.
  root.insertAdjacentHTML('afterbegin', `<p class="set-note">${esc(t('settings.collectionHelp'))}</p>`);
}
