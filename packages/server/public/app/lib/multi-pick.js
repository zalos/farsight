// lib/multi-pick.js — one searchable picker for every place a project (or a tag value,
// or a package) is picked: a search field over a list of options grouped under headings
// in a fixed order, multi-select (chips above the field, select all shown, clear) or
// single-select (one pick and done).
//
// A host builds the picker as HTML (`pickerHtml(id, spec)`) inside whatever it draws —
// the scope menu and the Views menu rebuild themselves with innerHTML — and every event
// is handled here by delegation on the document, so a picker needs no mount call and
// survives its host redrawing it: the query, the active option and the chips' fold are
// kept by id, and focus returns to the field when a host redraws during a change.
//
// The list is an ARIA listbox (`aria-multiselectable` in multi mode) driven from the
// field with `aria-activedescendant`: type to filter (prefix and substring, accent- and
// case-insensitive, over every word an option lists in `match`), ↑/↓ move, Enter
// toggles (or picks), Space toggles once ↑/↓ have moved (before that it types a space),
// ⌘A selects every option shown, Esc clears the query, then closes.
//
// Spec: { options: [{ id, word, group, sub?, countHtml?, match?: string[] }],
//         groups: [{ key, word }] (the fixed order; an option outside them lists last),
//         selected: iterable of ids, multi: bool, label, placeholder, countKey ({n} of {m} …),
//         onChange(ids, id, on), onClose?() }

import { esc, cssId } from '../store.js';
import { t } from '../strings.js';
import { tipAttrs } from './tooltip.js';
import { shownOptions } from './multi-pick-model.js';

export { fold, matchScore, shownOptions } from './multi-pick-model.js';

const PICKERS = new Map();
/** Chips shown before the rest fold into `+n`. */
export const FOLD_AT = 6;

function stateOf(id) {
  const p = PICKERS.get(id);
  return p ? p.state : { query: '', active: null, nav: false, unfold: false };
}
const optId = (pid, oid) => 'mpk-' + cssId(pid) + '-o-' + cssId(oid);

/** The picker as HTML, registered under `id` (a host redrawing it keeps its query). */
export function pickerHtml(id, spec) {
  const state = stateOf(id);
  const p = { id, spec: { ...spec, selected: new Set(spec.selected || []) }, state };
  PICKERS.set(id, p);
  const multi = !!spec.multi;
  const listId = 'mpk-' + cssId(id) + '-list';
  return '<div class="mpk' + (multi ? ' mpk-multi' : ' mpk-single') + '" data-mp="' + esc(id) + '" role="group" aria-label="' + esc(spec.label || '') + '">'
    + '<div class="mpk-chips">' + chipsHtml(p) + '</div>'
    + '<div class="mpk-bar"><input class="mpk-q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="' + listId + '"'
    + ' aria-label="' + esc(spec.label || '') + '" placeholder="' + esc(spec.placeholder || '') + '" value="' + esc(state.query) + '" autocomplete="off" spellcheck="false"/>'
    + '<span class="mpk-count" aria-live="polite"' + (spec.countKey ? tipAttrs({ key: spec.countKey, noFocus: true }) + ' tabindex="-1"' : '') + '>' + esc(countText(p)) + '</span></div>'
    + (multi ? '<div class="mpk-acts"><button type="button" class="mpk-act" data-mp-act="all">' + esc(t('codemap.pick.selectAll')) + '</button>'
      + '<button type="button" class="mpk-act" data-mp-act="clear">' + esc(t('codemap.pick.clear')) + '</button></div>' : '')
    + '<div class="mpk-list" id="' + listId + '" role="listbox"' + (multi ? ' aria-multiselectable="true"' : '') + ' aria-label="' + esc(spec.label || '') + '">' + listHtml(p) + '</div>'
    + '</div>';
}

function shown(p) { return shownOptions(p.spec.options || [], p.spec.groups || [], p.state.query); }

function countText(p) {
  if (!p.spec.countKey) return '';
  return t(p.spec.countKey).replace('{n}', String(shown(p).length)).replace('{m}', String((p.spec.options || []).length));
}

function chipsHtml(p) {
  const sel = [...p.spec.selected];
  // a single pick shows its choice as a chip only when the host asks (a filter that can be dropped)
  if ((!p.spec.multi && !p.spec.chips) || !sel.length) return '';
  const byId = new Map((p.spec.options || []).map((o) => [o.id, o]));
  const fold = sel.length > FOLD_AT && !p.state.unfold;
  const list = fold ? sel.slice(0, FOLD_AT) : sel;
  return list.map((id) => {
    const word = byId.has(id) ? byId.get(id).word : String(id).split('::').pop();
    return '<button type="button" class="mpk-chip" data-mp-rm="' + esc(id) + '" aria-label="' + esc(t('codemap.pick.remove').replace('{name}', word)) + '">'
      + '<span>' + esc(word) + '</span><span class="mpk-x" aria-hidden="true">✕</span></button>';
  }).join('')
    + (fold ? '<button type="button" class="mpk-chip mpk-more" data-mp-act="unfold"' + tipAttrs({ key: 'codemap.pick.more', noFocus: true }) + '>' + esc(t('codemap.pick.more').replace('{n}', String(sel.length - FOLD_AT))) + '</button>'
      : sel.length > FOLD_AT ? '<button type="button" class="mpk-chip mpk-more" data-mp-act="fold">' + esc(t('codemap.pick.fewer')) + '</button>' : '');
}

function listHtml(p) {
  const opts = shown(p);
  if (!opts.length) return '<div class="mpk-none">' + esc(t('codemap.pick.none')) + '</div>';
  if (!opts.some((o) => o.id === p.state.active)) p.state.active = opts[0].id;
  const words = new Map((p.spec.groups || []).map((g) => [g.key, g.word]));
  let html = '', group = null, gi = 0;
  for (const o of opts) {
    if (o.group !== group) {
      if (group !== null) html += '</div>';
      group = o.group;
      const hid = 'mpk-' + cssId(p.id) + '-g' + (gi++);
      html += '<div role="group" class="mpk-group" aria-labelledby="' + hid + '"><div class="mpk-gh hud-label" id="' + hid + '" role="presentation">' + esc(words.get(o.group) || o.group || '') + '</div>';
    }
    const on = p.spec.selected.has(o.id);
    html += '<div role="option" class="mpk-opt' + (on ? ' on' : '') + (o.id === p.state.active ? ' hot' : '') + '" id="' + optId(p.id, o.id) + '" data-mp-opt="' + esc(o.id) + '" aria-selected="' + (on ? 'true' : 'false') + '">'
      + (p.spec.multi ? '<span class="mpk-box" aria-hidden="true">' + (on ? '✓' : '') + '</span>' : '')
      + '<span class="mpk-w"><span class="mpk-word">' + esc(o.word) + '</span>' + (o.sub ? '<span class="mpk-sub">' + esc(o.sub) + '</span>' : '') + '</span>'
      + (o.countHtml ? '<span class="mpk-n">' + o.countHtml + '</span>' : '')
      + '</div>';
  }
  return html + '</div>';
}

/** Redraw what moves in a picker on screen (chips, count, list), the field untouched. */
function refresh(root, p) {
  const chips = root.querySelector('.mpk-chips'), count = root.querySelector('.mpk-count'), list = root.querySelector('.mpk-list');
  if (chips) chips.innerHTML = chipsHtml(p);
  if (count) count.textContent = countText(p);
  if (list) list.innerHTML = listHtml(p);
  const q = root.querySelector('.mpk-q');
  if (q) q.setAttribute('aria-activedescendant', p.state.active && shown(p).some((o) => o.id === p.state.active) ? optId(p.id, p.state.active) : '');
  const hot = list && list.querySelector('.mpk-opt.hot');
  // the active option kept in view inside the list only: the menu around the picker stays where it is
  if (hot && list) {
    const top = hot.offsetTop - list.offsetTop, bottom = top + hot.offsetHeight;
    const head = 22;
    if (top - head < list.scrollTop) list.scrollTop = Math.max(0, top - head);
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
}

/** Change the selection and tell the host; give the field its focus back if the host redrew the picker. */
function commit(p, ids, id, on) {
  const hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-mp]');
  p.spec.selected = new Set(ids);
  if (p.spec.onChange) p.spec.onChange([...ids], id, on);
  const root = rootOf(p.id);
  if (!root) return;
  const live = PICKERS.get(p.id);
  refresh(root, live);
  if (hadFocus) {
    const q = root.querySelector('.mpk-q');
    if (q && document.activeElement !== q) { q.focus({ preventScroll: true }); q.setSelectionRange(q.value.length, q.value.length); }
  }
}
function rootOf(id) {
  return [...document.querySelectorAll('[data-mp]')].find((n) => n.dataset.mp === id) || null;
}
function toggle(p, id) {
  if (!p.spec.multi) { commit(p, [id], id, true); return; }
  const s = new Set(p.spec.selected);
  const on = !s.has(id);
  on ? s.add(id) : s.delete(id);
  commit(p, [...s], id, on);
}
function pickerOf(el) {
  const root = el && el.closest && el.closest('[data-mp]');
  return root ? { root, p: PICKERS.get(root.dataset.mp) } : null;
}

function onInput(e) {
  if (!e.target.classList || !e.target.classList.contains('mpk-q')) return;
  const at = pickerOf(e.target);
  if (!at || !at.p) return;
  at.p.state.query = e.target.value;
  at.p.state.nav = false;
  at.p.state.active = null;
  refresh(at.root, at.p);
}

function onKey(e) {
  if (!e.target.classList || !e.target.classList.contains('mpk-q')) return;
  const at = pickerOf(e.target);
  if (!at || !at.p) return;
  const { p, root } = at;
  const opts = shown(p);
  const i = opts.findIndex((o) => o.id === p.state.active);
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    stop();
    if (!opts.length) return;
    // the first arrow lands on the option the field already points at (the first match), the next ones move
    const next = !p.state.nav && i >= 0 ? i : e.key === 'ArrowDown' ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
    p.state.active = opts[next].id; p.state.nav = true;
    refresh(root, p);
  } else if (e.key === 'Home' || e.key === 'End') {
    if (!p.state.nav || !opts.length) return;
    stop();
    p.state.active = opts[e.key === 'Home' ? 0 : opts.length - 1].id;
    refresh(root, p);
  } else if (e.key === 'Enter' || (e.key === ' ' && (p.state.nav || !p.state.query))) {
    stop();
    const o = opts[i >= 0 ? i : 0];
    if (o) toggle(p, o.id);
  } else if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A') && p.spec.multi) {
    stop();
    commit(p, [...new Set([...p.spec.selected, ...opts.map((o) => o.id)])], null, true);
  } else if (e.key === 'Escape') {
    if (p.state.query) { stop(); p.state.query = ''; e.target.value = ''; p.state.active = null; refresh(root, p); return; }
    if (p.spec.onClose) { stop(); p.spec.onClose(); }
  }
}

function onClick(e) {
  const at = pickerOf(e.target);
  if (!at || !at.p) return;
  const { p, root } = at;
  const rm = e.target.closest('[data-mp-rm]');
  if (rm) { e.preventDefault(); const s = new Set(p.spec.selected); s.delete(rm.dataset.mpRm); commit(p, [...s], rm.dataset.mpRm, false); return; }
  const act = e.target.closest('[data-mp-act]');
  if (act) {
    e.preventDefault();
    const a = act.dataset.mpAct;
    if (a === 'all') commit(p, [...new Set([...p.spec.selected, ...shown(p).map((o) => o.id)])], null, true);
    else if (a === 'clear') commit(p, [], null, false);
    else { p.state.unfold = a === 'unfold'; refresh(root, p); }
    return;
  }
  // a number's tip is its own click target: it opens the tip, it does not tick the option
  if (e.target.closest('[data-tip-id],[data-tip]')) return;
  const opt = e.target.closest('[data-mp-opt]');
  if (opt) {
    e.preventDefault();
    p.state.active = opt.dataset.mpOpt;
    toggle(p, opt.dataset.mpOpt);
    const q = root.querySelector('.mpk-q');
    if (q && rootOf(p.id) === root && document.activeElement !== q) q.focus({ preventScroll: true });
  }
}

/** Focus a picker's field (a host opening a menu for the keyboard). */
export function focusPicker(id) {
  const root = rootOf(id);
  const q = root && root.querySelector('.mpk-q');
  if (q) q.focus({ preventScroll: true });
}
/** Forget a picker's query (a host closing the menu it lived in). */
export function resetPicker(id) {
  const p = PICKERS.get(id);
  if (p) Object.assign(p.state, { query: '', active: null, nav: false });
}
/** True when the key event is for a picker with a query typed (Esc clears that first). */
export function pickerHasQuery(e) {
  const at = e && e.target && pickerOf(e.target);
  return !!(at && at.p && at.p.state.query);
}

if (typeof document !== 'undefined') {
  // capture: the menus a picker lives in stop clicks from bubbling (so a click inside never
  // closes them), and the keymap listens on the document too — the field's keys are its own
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onClick, true);
}
