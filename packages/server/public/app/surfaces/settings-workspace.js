import { esc } from '../store.js';
import { t } from '../strings.js';
import { fieldHtml } from '../lib/row-editor.js';
import { readAt, writeAt } from '../lib/settings-model.js';
import { readOnlyWhy } from '../lib/read-only.js';

export function renderWorkspace(root, context) {
  const { draft, changed, preview } = context;
  root.innerHTML = `<div class="set-sec settings-fields">${fieldHtml({ key: 'settings.theme', path: 'theme', id: 'set-theme', value: draft.theme || 'system', options: ['system', 'dark', 'light'] })}<p id="set-theme-note" class="set-preview" aria-live="polite"></p>${fieldHtml({ key: 'settings.defaultLens', path: 'defaultLens', id: 'set-lens', value: draft.defaultLens || 'hybrid', options: ['business', 'hybrid', 'code'] })}${fieldHtml({ key: 'settings.defaultSurface', path: 'defaultSurface', id: 'set-surface', value: draft.defaultSurface || '', options: [['', 'settings.value.automatic'], ...['portfolio', 'journeys', 'codemap', 'apis', 'changes', 'work'].map((s) => [s, 'nav.' + s])], hint: 'set.landingSub' })}</div><section class="set-sec"><h2>${esc(t('settings.experiments'))}</h2>${fieldHtml({ key: 'settings.designShots', path: 'flags.designShots', id: 'set-flag-shots', value: readAt(draft, 'flags.designShots'), type: 'checkbox', hint: 'set.flagShotsSub' })}</section>`;
  root.oninput = (event) => {
    const input = event.target.closest('[data-field]');
    if (!input || readOnlyWhy()) return;
    writeAt(draft, input.dataset.field, input.type === 'checkbox' ? input.checked : input.value || undefined);
    if (input.dataset.field === 'theme') preview(input.value);
    changed();
  };
}
