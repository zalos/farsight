// One row editor for settings forms. The caller owns the rows and their field folds.
import { esc } from '../store.js';
import { t } from '../strings.js';
import { defAttrs } from './counted.js';
import { applyReadOnly, readOnlyWhy } from './read-only.js';
import { editRows } from './settings-model.js';

export function buttonHtml(key, attrs = '') {
  return `<button type="button" class="btn" data-write ${attrs}${defAttrs(key)}>${esc(t(key))}</button>`;
}

/** A labelled field with a stable server path for the one validation message. */
export function fieldHtml({
  key,
  path,
  value,
  options,
  type = 'text',
  id,
  hint = '',
  optional = false,
  tipOnInput = false,
}) {
  const name = id || 'set-field-' + path.replace(/[^\w-]/g, '-');
  const tip = defAttrs(key);
  const attrs = `id="${esc(name)}" data-field="${esc(path)}" data-write aria-describedby="${esc(name)}-problem"${tipOnInput ? tip : ''}`;
  const input = options
    ? `<select ${attrs}>${options
        .map((o) => {
          const [v, label] = Array.isArray(o) ? o : [o, 'settings.value.' + o];
          return `<option value="${esc(v)}"${String(value ?? '') === v ? ' selected' : ''}>${esc(t(label))}</option>`;
        })
        .join('')}</select>`
    : type === 'textarea'
      ? `<textarea ${attrs} rows="3" autocomplete="off">${esc(value ?? '')}</textarea>`
      : `<input ${attrs} type="${type}"${type === 'checkbox' ? (value ? ' checked' : '') : ` value="${esc(value ?? '')}"`}${optional ? ' data-optional' : ''} autocomplete="off"/>`;
  return `<div class="settings-field" data-field-wrap="${esc(path)}"><label for="${esc(name)}"${tipOnInput ? tip.replace('tabindex="0"', 'tabindex="-1"') : tip}>${esc(t(key))}</label>${input}${hint ? `<p class="set-note">${esc(t(hint))}</p>` : ''}<p class="settings-problem" id="${esc(name)}-problem" data-problem-for="${esc(path)}" role="status" hidden></p></div>`;
}

/** Mount a grid. Columns supply HTML; callbacks edit the caller's shared draft in place. */
export function rowEditor(root, spec) {
  const { rows, columns, onChange } = spec;
  const draw = (focus) => {
    root.innerHTML = `<div class="settings-grid-scroll"><table class="settings-grid" role="grid" aria-label="${esc(t(spec.label))}"><thead><tr role="row">${columns.map((c) => `<th role="columnheader"${defAttrs(c.key)}>${esc(t(c.key))}</th>`).join('')}<th role="columnheader"${defAttrs('settings.rowActions')}>${esc(t('settings.rowActions'))}</th></tr></thead><tbody>${rows.map((row, index) => `<tr role="row" data-row="${index}">${columns.map((col) => `<td role="gridcell" tabindex="-1">${col.html(row, index)}</td>`).join('')}<td role="gridcell" tabindex="-1" class="settings-row-actions">${['up', 'down', 'remove'].map((action) => buttonHtml('settings.' + action, `data-row-action="${action}"${(action === 'up' && index === 0) || (action === 'down' && index === rows.length - 1) ? ' disabled' : ''}`)).join('')}</td></tr>`).join('')}</tbody></table></div>${!rows.length && spec.empty ? `<p class="set-note">${esc(t(spec.empty))}</p>` : ''}${spec.add ? buttonHtml(spec.addKey || 'settings.add', 'data-row-action="add"') : ''}`;
    root.querySelector('[role="gridcell"]')?.setAttribute('tabindex', '0');
    root
      .querySelectorAll(
        '[role="gridcell"] input,[role="gridcell"] select,[role="gridcell"] textarea,[role="gridcell"] button',
      )
      .forEach((el) => (el.tabIndex = -1));
    applyReadOnly(root);
    if (spec.afterRender) spec.afterRender();
    if (focus !== undefined)
      (
        root.querySelector(
          `[data-row="${Math.max(0, Math.min(rows.length - 1, focus))}"] input, [data-row="${Math.max(0, Math.min(rows.length - 1, focus))}"] select`,
        ) || root.querySelector('[data-row-action="add"]')
      )?.focus();
  };
  root.onclick = (event) => {
    const button = event.target.closest('[data-row-action]');
    if (!button || readOnlyWhy() || button.disabled) return;
    const action = button.dataset.rowAction;
    const index = Number(button.closest('[data-row]')?.dataset.row || 0);
    editRows(rows, action, index, action === 'add' ? spec.add() : undefined);
    onChange();
    draw(action === 'add' ? rows.length - 1 : action === 'up' ? index - 1 : action === 'down' ? index + 1 : index);
  };
  root.oninput = (event) => {
    if (readOnlyWhy()) return;
    const row = event.target.closest('[data-row]');
    if (row && spec.input) spec.input(event, rows[Number(row.dataset.row)], Number(row.dataset.row));
  };
  root.addEventListener('focusin', (event) => {
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell) return;
    root.querySelectorAll('[role="gridcell"]').forEach((el) => (el.tabIndex = el === cell ? 0 : -1));
    root
      .querySelectorAll(
        '[role="gridcell"] input,[role="gridcell"] select,[role="gridcell"] textarea,[role="gridcell"] button',
      )
      .forEach((el) => (el.tabIndex = -1));
    cell
      .querySelectorAll('input,select,textarea,button')
      .forEach((el) => (el.tabIndex = event.target === cell ? -1 : 0));
  });
  root.onkeydown = (event) => {
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell) return;
    if (event.key === 'Escape' && event.target !== cell) {
      event.stopPropagation();
      cell.focus();
    }
    if (event.target !== cell) return;
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      cell.querySelector('input,select,textarea,button,[role="combobox"]')?.focus();
      return;
    }
    const row = cell.parentElement;
    const index = [...row.children].indexOf(cell);
    const next =
      event.key === 'ArrowRight'
        ? cell.nextElementSibling
        : event.key === 'ArrowLeft'
          ? cell.previousElementSibling
          : event.key === 'ArrowDown'
            ? row.nextElementSibling?.children[index]
            : event.key === 'ArrowUp'
              ? row.previousElementSibling?.children[index]
              : null;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  draw();
  return { draw };
}
