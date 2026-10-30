// Settings owns one draft, one server check and one save. The shell only mounts this surface.
import { S, esc, currentLens, indexGuards } from '../store.js';
import { t } from '../strings.js';
import { defAttrs } from '../lib/counted.js';
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';
import * as model from '../lib/settings-model.js';
import { buttonHtml } from '../lib/row-editor.js';
import { renderWorkspace } from './settings-workspace.js';
import { renderSources } from './settings-sources.js';
import { renderCollections } from './settings-collections.js';
import { renderAgents } from './settings-agents.js';
import { renderConfigFiles } from './settings-config.js';

let root = null;
let draft = null;
let hooks = {};
let section = 'workspace';
let checkTimer;
let checkSequence = 0;
let problem = '';
let checking = false;
let saving = false;
let syncing = false;
let syncRequired = false;
let message = '';

function isDirty() {
  return !!draft && model.dirty(S.SETTINGS, draft);
}
function lastSection() {
  try {
    return localStorage.getItem('fs-settings-section');
  } catch {
    return null;
  }
}
function remember() {
  try {
    localStorage.setItem('fs-settings-section', section);
  } catch {
    /* session only */
  }
}
function sectionKey(item) {
  return currentLens() === 'business' ? item.businessKey : item.key;
}

export function mountSettings(route, element, callbacks) {
  hooks = callbacks;
  root = document.getElementById('settings');
  element.appendChild(root);
  root.classList.add('open', 'as-surface');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', t('surf.chrome.settings'));
  if (!draft) draft = model.clone(S.SETTINGS);
  settingsUpdate(route);
}
export function unmountSettings() {
  clearTimeout(checkTimer);
  checkSequence++;
  checking = false;
  root?.classList.remove('open', 'as-surface');
  if (root) document.body.appendChild(root);
  root = null;
}
export function settingsUpdate(route) {
  const asked = route?.param || lastSection() || 'workspace';
  section = model.sections.some((s) => s.id === asked) ? asked : 'workspace';
  remember();
  renderSettings();
}
export function settingsRefresh() {
  renderSettings();
}

function paintStatus() {
  if (!root) return;
  const dirty = isDirty();
  const bar = root.querySelector('#settings-savebar');
  bar.hidden = !dirty;
  root.querySelector('#settings-unsaved').textContent = t('settings.unsaved');
  const save = root.querySelector('#savebtn');
  const discard = root.querySelector('#discardbtn');
  applyReadOnly(root);
  root.querySelectorAll('[data-unsupported]').forEach((input) => {
    input.disabled = true;
  });
  save.disabled = saving || checking || !!problem;
  discard.disabled = saving;
  root.querySelector('#savenote').textContent = message;
  root.querySelector('#settings-check').textContent = checking ? t('settings.checking') : problem;
  root.querySelector('#settings-sync-needed').hidden = !syncRequired;
  root.querySelectorAll('[data-sync],#syncbtn').forEach((button) => {
    button.disabled = syncing || saving || dirty;
  });
  root.querySelectorAll('[data-problem-for]').forEach((el) => {
    el.hidden = true;
    el.textContent = '';
  });
  root.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  if (problem) {
    // The server prefixes its own sentence with the field path. Pick the most specific visible ancestor.
    const at = problem.replace(/^settings\./, '');
    const candidates = [...root.querySelectorAll('[data-problem-for]')]
      .filter((el) => at.startsWith(el.dataset.problemFor))
      .sort((a, b) => b.dataset.problemFor.length - a.dataset.problemFor.length);
    const target = candidates[0];
    if (target) {
      target.hidden = false;
      target.textContent = problem;
      root.querySelectorAll('[data-field]').forEach((input) => {
        if (input.dataset.field === target.dataset.problemFor) input.setAttribute('aria-invalid', 'true');
      });
    }
  }
}

export function settingsChanged() {
  if (readOnlyWhy()) return;
  message = '';
  problem = '';
  checkSequence++;
  checking = true;
  clearTimeout(checkTimer);
  paintStatus();
  checkTimer = setTimeout(() => checkDraft(), 250);
}

async function serverCheck(value) {
  const response = await fetch('/api/settings/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error('check');
  return response.json();
}
async function checkDraft() {
  const sequence = ++checkSequence;
  try {
    const result = await serverCheck(draft);
    if (sequence !== checkSequence) return false;
    problem = result.ok ? '' : result.problem;
    return !!result.ok;
  } catch {
    if (sequence === checkSequence) problem = t('settings.checkFailed');
    return false;
  } finally {
    if (sequence === checkSequence) {
      checking = false;
      paintStatus();
    }
  }
}

export async function saveSettings() {
  if (readOnlyWhy() || saving || !isDirty()) return false;
  clearTimeout(checkTimer);
  checkSequence++;
  saving = true;
  checking = true;
  paintStatus();
  // Disable editing during the transaction so an in-flight save cannot consume a later edit.
  root?.querySelectorAll('input,select,textarea').forEach((el) => {
    el.disabled = true;
  });
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error('read');
    const current = await response.json();
    const merged = model.mergeSettings(S.SETTINGS, draft, current);
    const result = await serverCheck(merged);
    if (!result.ok) {
      problem = result.problem;
      return false;
    }
    const saved = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merged),
    });
    if (!saved.ok) {
      const result = await saved.json().catch(() => ({}));
      problem = result.error || t('settings.saveFailed');
      return false;
    }
    syncRequired ||= model.needsSync(current, merged);
    S.SETTINGS = merged;
    draft = model.clone(merged);
    S.themePreview = null;
    problem = '';
    message = t('settings.saved');
    hooks.saved?.();
    return true;
  } catch {
    message = t('settings.saveFailed');
    return false;
  } finally {
    saving = false;
    checking = false;
    renderSettings();
  }
}

export async function syncNow() {
  if (readOnlyWhy() || syncing) return;
  if (isDirty()) {
    message = t('settings.syncFirst');
    paintStatus();
    return;
  }
  syncing = true;
  message = t('set.syncing');
  paintStatus();
  try {
    const response = await fetch('/api/sync', { method: 'POST' });
    if (!response.ok) throw new Error('sync');
    const result = await response.json();
    if (result.error) throw new Error('sync');
    const [settingsResponse, graphResponse] = await Promise.all([fetch('/api/settings'), fetch('/graph')]);
    if (!settingsResponse.ok || !graphResponse.ok) throw new Error('reload');
    S.SETTINGS = await settingsResponse.json();
    draft = model.clone(S.SETTINGS);
    S.GRAPH = await graphResponse.json();
    S.ROOTS = S.GRAPH.roots || {};
    indexGuards();
    hooks.synced?.();
    syncRequired = false;
    message = t('settings.synced');
  } catch {
    message = t('settings.syncFailed');
  } finally {
    syncing = false;
    renderSettings();
  }
}

function registered(id, fields, previous) {
  const source = draft.sources.find((s) => s.id === id);
  if (source) {
    const merged = model.mergeSettings(previous, source, { ...previous, ...fields });
    Object.keys(source).forEach((key) => delete source[key]);
    Object.assign(source, merged);
  }
  syncRequired = true;
  paintStatus();
}

export function renderSettings() {
  if (!root || !draft) return;
  const selected = model.sections.find((s) => s.id === section);
  root.innerHTML = `<div class="settings-page"><header class="settings-heading"><div><h1>${esc(t('surf.chrome.settings'))}</h1><p>${esc(t('settings.intro'))}</p></div><button type="button" class="btn" id="settings-back"${defAttrs('settings.back')}>${esc(t('settings.back'))}</button></header><p id="set-ro" class="set-ro" role="status" hidden></p><div class="settings-layout"><nav class="settings-rail" aria-label="${esc(t('surf.chrome.settings'))}">${model.sections.map((item) => `<a href="#/settings/${item.id}"${item.id === section ? ' aria-current="page"' : ''}${defAttrs(sectionKey(item))}>${esc(t(sectionKey(item)))}</a>`).join('')}</nav><main class="settings-content"><h2 id="settings-section-title"${defAttrs(sectionKey(selected))}>${esc(t(sectionKey(selected)))}</h2><div id="settings-section"></div><div class="settings-feedback"><p id="settings-check" role="status"></p><p id="savenote" role="status"></p><div id="settings-sync-needed" hidden>${buttonHtml('settings.syncApply', 'id="syncbtn"')}<p class="consequence">${esc(t('set.syncConsequence'))}</p></div></div></main></div><footer id="settings-savebar" class="settings-savebar" hidden><div><strong id="settings-unsaved"></strong><p id="save-consequence" class="consequence">${esc(t('set.saveConsequence'))}</p></div>${buttonHtml('settings.save', 'id="savebtn" class="primary"')}${buttonHtml('settings.discard', 'id="discardbtn"')}</footer></div>`;
  const content = root.querySelector('#settings-section');
  const context = { draft, changed: settingsChanged, sync: syncNow, checkSecret: () => {}, preview: hooks.preview };
  if (section === 'workspace') renderWorkspace(content, context);
  else if (section === 'sources') renderSources(content, context);
  else if (section === 'collections') renderCollections(content, context);
  else if (section === 'agents') renderAgents(content, context);
  else {
    content.innerHTML = `${model
      .unavailableFields(draft, S.VERSION)
      .map(
        (field) =>
          `<div class="settings-unavailable"><label>${esc(field.source)}${currentLens() === 'business' ? '' : ` · <code>${esc(field.field)}</code>`}<input data-write data-unsupported disabled value="${esc(t('settings.notInBuild'))}"${defAttrs('settings.notInBuild')}/></label><p class="settings-problem" data-problem-for="${esc(field.path)}" hidden></p></div>`,
      )
      .join(
        '',
      )}<section id="set-config" class="set-sec"><h3 id="set-config-title"></h3><p id="set-config-sub" class="set-note"></p><div id="cfgrows"></div></section>`;
    renderConfigFiles(registered);
  }
  root.querySelector('#settings-back').onclick = () => hooks.close?.();
  root.querySelector('#savebtn').onclick = saveSettings;
  root.querySelector('#syncbtn').onclick = syncNow;
  root.querySelector('#discardbtn').onclick = () => {
    if (readOnlyWhy() || saving) return;
    clearTimeout(checkTimer);
    checkSequence++;
    checking = false;
    problem = '';
    message = '';
    draft = model.clone(S.SETTINGS);
    S.themePreview = null;
    hooks.saved?.();
    renderSettings();
  };
  paintStatus();
}
