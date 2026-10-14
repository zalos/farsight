import { createPortal } from './portal.js';

let strings;
const root = document.querySelector('#app');
const t = key => strings[`echo.ui.${key}`].professional;
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
const word = (tag, key, className = '') => {
  const node = el(tag, className, t(key));
  node.title = strings[`echo.ui.${key}`].define;
  return node;
};
let config, revision, running, installation, selected, baseline, defaults, portalOptions, readOnly;
let portal, activeView = 'memories';
let form, profileList, saveButton, editState, notice;
let busy = false;

async function request(path, options) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(20_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('failed'));
  return data;
}

function field(key, name, value, options = {}) {
  const box = el('div', options.wide ? 'field wide' : 'field');
  const label = word('label', key);
  label.htmlFor = name;
  let input;
  if (options.options) {
    input = el('select');
    for (const [optionValue, optionKey] of options.options) {
      const option = word('option', optionKey);
      option.value = optionValue;
      input.append(option);
    }
  } else if (options.multiline) {
    input = el('textarea');
    input.rows = 3;
  } else {
    input = el('input');
    input.type = options.type || 'text';
    if (input.type === 'number') { input.min = options.min ?? 1; input.step = options.step ?? '1'; }
    input.autocomplete = 'off';
    input.spellcheck = false;
  }
  input.id = name;
  input.name = name;
  input.value = value ?? '';
  input.required = !!options.required;
  if (options.max !== undefined) input.max = options.max;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.hint) {
    const hint = word('span', options.hint, 'field-hint');
    hint.id = `${name}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    box.append(label, input, hint);
  } else box.append(label, input);
  return box;
}

function toggle(key, name, value) {
  const label = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.name = name;
  input.id = name;
  input.checked = value;
  label.append(input, word('span', key));
  return label;
}

function section(key, note) {
  const card = el('section', 'card');
  const heading = word('h2', key);
  const grid = el('div', 'fields');
  card.append(heading);
  if (note) card.append(word('p', note, 'section-note'));
  card.append(grid);
  return { card, grid };
}

function captureForm() {
  if (readOnly || !form?.elements.individual) return;
  const values = new FormData(form);
  const value = name => String(values.get(name) ?? '').trim();
  const optional = name => value(name) || undefined;
  const p = config.profiles[selected];
  p.identity = { individual: value('individual'), team: optional('team'), project: value('project') };
  p.backend = { mode: value('backendMode'), url: value('backendUrl'), ...(value('backendMode') === 'external' ? { secretRef: optional('backendSecret') } : {}) };
  p.model = { provider: value('provider'), baseUrl: value('modelUrl'), model: value('modelName'), secretRef: optional('modelSecret'), ...(p.model.allowInsecureHttp !== undefined || values.has('allowInsecureHttp') ? { allowInsecureHttp: values.has('allowInsecureHttp') } : {}) };
  const submind = {
    mode: value('submindMode'),
    maxSteps: Number(value('maxSteps')), maxSearches: Number(value('maxSearches')),
    maxCandidates: Number(value('maxCandidates')), evidenceMaxChars: Number(value('evidenceMaxChars')),
    inputMaxChars: Number(value('inputMaxChars')), lookbackDays: Number(value('lookbackDays')),
    timeoutMs: Math.round(Number(value('submindTimeout')) * 1000), expandedMaxChars: Number(value('expandedMaxChars')),
  };
  // Older settings remain byte-shape compatible until the reader changes this policy.
  if (p.submind || Object.keys(submind).some(key => submind[key] !== defaults.submind[key])) p.submind = submind;
  p.web = { port: Number(value('port')), farsightOrigin: optional('farsightOrigin') };
  p.hooks = { claude: values.has('claude'), codex: values.has('codex'), vscode: values.has('vscode') };
  p.skills = { directories: value('skillDirectories').split('\n').map(line => line.trim()).filter(Boolean) };
  p.budget = { briefMaxChars: Number(value('briefLimit')), modelMaxTokens: Number(value('tokenLimit')), timeoutMs: Math.round(Number(value('timeout')) * 1000) };
  if (values.has('default')) config.defaultProfile = selected;
}

function markDirty() {
  captureForm();
  const dirty = JSON.stringify(config) !== baseline;
  editState.textContent = t(dirty ? 'unsaved' : 'savedState');
  editState.classList.toggle('dirty', dirty);
  saveButton.disabled = readOnly || busy || !dirty;
}

function renderProfiles() {
  profileList.replaceChildren();
  for (const id of Object.keys(config.profiles)) {
    const button = el('button', id === selected ? 'profile selected' : 'profile');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(id === selected));
    button.append(el('span', 'profile-name', id));
    if (id === running.profileId) button.append(word('span', 'running', 'profile-meta'));
    button.addEventListener('click', () => {
      if (busy) return;
      captureForm();
      selected = id;
      renderProfiles();
      renderForm();
      markDirty();
    });
    profileList.append(button);
  }
}

function renderForm() {
  form.replaceChildren();
  const p = config.profiles[selected];
  const context = el('div', 'editing-context');
  const contextText = el('div');
  contextText.append(word('span', 'editing', 'eyebrow'), el('h2', 'profile-title', selected));
  const defaultToggle = toggle('default', 'default', config.defaultProfile === selected);
  defaultToggle.querySelector('input').disabled = config.defaultProfile === selected;
  // Disabled controls are not included in FormData; the current default stays
  // unchanged unless the reader explicitly chooses a different profile.
  context.append(contextText, defaultToggle);
  form.append(context, word('p', 'editingNote', 'editing-note'));

  const identity = section('identity', 'identityNote');
  identity.grid.append(field('individual', 'individual', p.identity.individual, { required: true }), field('team', 'team', p.identity.team, { hint: 'optional' }), field('project', 'project', p.identity.project, { required: true, wide: true }));
  const memory = section('memory', 'memoryNote');
  const backendMode = field('backendMode', 'backendMode', p.backend.mode, { options: [['managed', 'managed'], ['external', 'external']], wide: true });
  const backendSecret = field('backendSecretRef', 'backendSecret', p.backend.secretRef, { wide: true, hint: 'secretsNote' });
  function setBackendMode() {
    const external = backendMode.querySelector('select').value === 'external';
    backendSecret.hidden = !external;
    backendSecret.querySelector('input').disabled = !external;
    if (!external) backendSecret.querySelector('input').value = '';
  }
  backendMode.addEventListener('change', setBackendMode);
  setBackendMode();
  memory.grid.append(backendMode, field('backendUrl', 'backendUrl', p.backend.url, { type: 'url', required: true, wide: true }), backendSecret);
  const model = section('model', 'modelNote');
  model.grid.append(field('provider', 'provider', p.model.provider, { options: [['ollama', 'ollama'], ['openai-compatible', 'compatible']], wide: true }), field('modelUrl', 'modelUrl', p.model.baseUrl, { type: 'url', required: true, wide: true }), field('modelName', 'modelName', p.model.model, { wide: true, hint: 'optional' }), field('secretRef', 'modelSecret', p.model.secretRef, { wide: true, hint: 'secretsNote' }), toggle('allowInsecureHttp', 'allowInsecureHttp', p.model.allowInsecureHttp), word('p', 'remoteModelNote', 'field-hint wide'));
  const submind = section('submind', 'submindNote');
  submind.card.classList.add('submind');
  const policy = p.submind ?? defaults.submind;
  const mode = field('submindMode', 'submindMode', policy.mode, { options: [['off', 'submindOff'], ['mock', 'submindMock'], ['model', 'submindModel']], wide: true });
  const modeNote = word('p', `submind${policy.mode[0].toUpperCase()}${policy.mode.slice(1)}Note`, 'mode-note');
  modeNote.setAttribute('role', 'status');
  mode.addEventListener('change', () => {
    const value = mode.querySelector('select').value;
    const key = `submind${value[0].toUpperCase()}${value.slice(1)}Note`;
    modeNote.textContent = t(key);
    modeNote.title = strings[`echo.ui.${key}`].define;
  });
  submind.grid.append(mode, modeNote,
    field('maxSteps', 'maxSteps', policy.maxSteps, { type: 'number', min: 1, max: 8, required: true }),
    field('maxSearches', 'maxSearches', policy.maxSearches, { type: 'number', min: 1, max: 8, required: true }),
    field('maxCandidates', 'maxCandidates', policy.maxCandidates, { type: 'number', min: 1, max: 50, required: true }),
    field('lookbackDays', 'lookbackDays', policy.lookbackDays, { type: 'number', min: 1, max: 3650, required: true }),
    field('evidenceMaxChars', 'evidenceMaxChars', policy.evidenceMaxChars, { type: 'number', min: 128, max: 64000, required: true }),
    field('inputMaxChars', 'inputMaxChars', policy.inputMaxChars, { type: 'number', min: 1024, max: 256000, required: true }),
    field('submindTimeout', 'submindTimeout', policy.timeoutMs / 1000, { type: 'number', min: 0.1, max: 300, step: '0.001', required: true }),
    field('expandedMaxChars', 'expandedMaxChars', policy.expandedMaxChars, { type: 'number', min: 128, max: 64000, required: true }),
    word('p', 'submindLimitsNote', 'field-hint wide'));
  const hooks = section('hooks', 'hooksNote');
  hooks.grid.append(toggle('claude', 'claude', p.hooks.claude), toggle('codex', 'codex', p.hooks.codex), toggle('vscode', 'vscode', p.hooks.vscode));
  const skills = section('skills', 'skillsNote');
  skills.grid.append(field('skillDirectories', 'skillDirectories', p.skills.directories.join('\n'), { wide: true, multiline: true, hint: 'onePerLine' }));
  const limits = section('limits');
  limits.grid.append(field('briefLimit', 'briefLimit', p.budget.briefMaxChars, { type: 'number', min: 128, max: 16384, required: true }), field('tokenLimit', 'tokenLimit', p.budget.modelMaxTokens, { type: 'number', min: 32, max: 4096, required: true }), field('timeout', 'timeout', p.budget.timeoutMs / 1000, { type: 'number', min: 0.1, max: 300, step: '0.001', required: true }), field('port', 'port', p.web.port, { type: 'number', min: 1024, max: 65535, required: true }), field('farsightOrigin', 'farsightOrigin', p.web.farsightOrigin, { type: 'url', wide: true, hint: 'embedNote' }));
  const cards = el('div', 'cards');
  cards.append(identity.card, memory.card, model.card, submind.card, hooks.card, skills.card, limits.card);
  form.append(cards);
  if (readOnly) for (const input of form.querySelectorAll('input, select, textarea')) input.disabled = true;
}

function announce(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
}

async function load() {
  const data = await request('/api/settings');
  config = data.config;
  revision = data.revision;
  running = data.running;
  installation = data.installation;
  defaults = data.defaults;
  portalOptions = data.portal ?? { available: false };
  readOnly = data.readOnly === true;
  baseline = JSON.stringify(config);
  if (!selected || !config.profiles[selected]) selected = config.profiles[running.profileId] ? running.profileId : config.defaultProfile;
}

function render() {
  portal?.cancel();
  root.replaceChildren();
  const header = el('header', 'masthead');
  const brand = el('div');
  brand.append(word('p', 'eyebrow', 'eyebrow'), word('h1', 'brand', 'brand'));
  const state = el('div', 'runtime');
  state.append(word('span', 'running', 'eyebrow'), el('strong', '', running.profileId), word('span', 'runningSubmind', 'eyebrow'), word('strong', `submind${running.submindMode[0].toUpperCase()}${running.submindMode.slice(1)}`));
  header.append(brand, state);
  const hero = el('div', 'hero');
  hero.append(word('span', 'foundation', 'badge'), word('h2', 'headline'), word('p', 'intro'));
  const boundary = el('div', 'boundary');
  boundary.append(word('strong', 'restart'), word('span', 'notBuilt'));
  const location = el('section', 'card installation');
  const locationHeading = el('div', 'installation-heading');
  locationHeading.append(word('h2', 'installation'), word('span', `scope${installation.scope[0].toUpperCase()}${installation.scope.slice(1)}`, 'badge'));
  const locations = el('dl', 'installation-paths');
  function pathRow(key, value) {
    if (!value) return;
    locations.append(word('dt', key), el('dd', '', value));
  }
  pathRow('configLocation', installation.configPath);
  pathRow('runningLocation', running.dataDirectory);
  pathRow('workspaceLocation', installation.workspaceRoot);
  location.append(locationHeading, word('p', `${installation.scope}ScopeNote`, 'section-note'), locations, word('p', 'installationNote', 'section-note installation-note'));
  const layout = el('div', 'layout');
  const sidebar = el('aside', 'sidebar');
  sidebar.append(word('h2', 'profiles', 'eyebrow'));
  profileList = el('nav', 'profiles');
  profileList.setAttribute('aria-label', t('profiles'));
  const isolation = el('div', 'isolation');
  isolation.append(word('h3', 'isolation'), word('p', 'isolationBody'));
  sidebar.append(profileList, isolation);
  const main = el('main');
  form = el('form');
  form.id = 'settings';
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (readOnly) return;
    captureForm();
    busy = true;
    form.inert = true;
    profileList.inert = true;
    reload.disabled = true;
    saveButton.disabled = true;
    saveButton.textContent = t('saving');
    try {
      const data = await request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify(config) });
      config = data.config;
      revision = data.revision;
      baseline = JSON.stringify(config);
      announce(t('saved'));
    } catch (error) { announce(error.message || t('failed'), true); }
    finally { busy = false; form.inert = false; profileList.inert = false; reload.disabled = false; saveButton.textContent = t('save'); markDirty(); }
  });
  const diagnostics = section('diagnostics', 'checkNote');
  diagnostics.card.classList.add('diagnostics');
  const checkButton = word('button', 'check', 'button secondary');
  checkButton.type = 'button';
  const results = el('div', 'check-results');
  results.setAttribute('role', 'status');
  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    results.replaceChildren(word('p', 'checking'));
    try {
      const data = await request('/api/checks');
      results.replaceChildren();
      if (!data.available) results.append(word('p', 'noChecks'));
      for (const check of data.checks) {
        const row = el('div', check.ok ? 'check ready' : 'check attention');
        row.append(el('strong', '', check.name), word('span', check.ok ? 'ready' : 'attention', 'check-state'), el('p', '', check.detail));
        results.append(row);
      }
    } catch (error) { results.replaceChildren(el('p', 'error', error.message || t('checkFailed'))); }
    finally { checkButton.disabled = false; }
  });
  diagnostics.grid.append(checkButton, results);
  main.append(form, diagnostics.card);
  layout.append(sidebar, main);
  const footer = el('footer', 'save-bar');
  editState = el('span', 'edit-state');
  notice = el('p', 'notice');
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  const reload = word('button', 'reload', 'button secondary');
  reload.type = 'button';
  reload.addEventListener('click', async () => {
    reload.disabled = true;
    try { await load(); render(); } catch (error) { announce(error.message || t('unavailable'), true); reload.disabled = false; }
  });
  saveButton = word('button', 'save', 'button primary');
  saveButton.type = 'submit';
  saveButton.setAttribute('form', 'settings');
  actions.append(reload, saveButton);
  const saveMessage = el('div', 'save-message');
  saveMessage.append(editState, notice);
  footer.append(saveMessage, actions);
  const tabs = el('div', 'view-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', strings['echo.portal.navigation'].professional);
  const settingsPanel = el('section', 'settings-panel'); settingsPanel.id = 'echo-settings'; settingsPanel.setAttribute('role', 'tabpanel'); settingsPanel.setAttribute('aria-labelledby', 'tab-settings');
  settingsPanel.append(hero, boundary, location, layout, footer);
  if (readOnly) { const note = el('p', 'synthetic-preview', strings['echo.portal.demoSettings'].professional); note.title = strings['echo.portal.demoSettings'].define; settingsPanel.prepend(note); }
  portal = createPortal({ strings, running, available: portalOptions.available, synthetic: portalOptions.synthetic });
  portal.element.setAttribute('role', 'tabpanel'); portal.element.setAttribute('aria-labelledby', 'tab-memories');
  const tabButtons = new Map();
  function selectView(view, focus = false) {
    activeView = view;
    for (const [key, tab] of tabButtons) { tab.setAttribute('aria-selected', String(view === key)); tab.tabIndex = view === key ? 0 : -1; }
    settingsPanel.hidden = view !== 'settings'; portal.element.hidden = view !== 'memories';
    if (view === 'memories') portal.activate(); else portal.cancel();
    if (focus) tabButtons.get(view).focus();
  }
  for (const view of ['memories', 'settings']) {
    const entry = strings[`echo.portal.${view}`]; const tab = el('button', 'view-tab', entry.professional);
    tab.type = 'button'; tab.title = entry.define; tab.id = `tab-${view}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `echo-${view}`);
    tab.addEventListener('click', () => selectView(view));
    tab.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); selectView(event.key === 'Home' ? 'memories' : event.key === 'End' ? 'settings' : activeView === 'memories' ? 'settings' : 'memories', true); } });
    tabButtons.set(view, tab); tabs.append(tab);
  }
  root.append(header, tabs, portal.element, settingsPanel);
  selectView(activeView);
  renderProfiles();
  renderForm();
  markDirty();
}

try {
  strings = await request('/api/strings');
  await load();
  render();
} catch {
  root.replaceChildren(el('p', 'boot-error', strings ? t('unavailable') : root.dataset.error));
}

window.addEventListener('pagehide', () => portal?.cancel());
