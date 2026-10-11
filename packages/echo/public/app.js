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
let config, revision, running, selected, baseline;
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
  if (!form?.elements.individual) return;
  const values = new FormData(form);
  const value = name => String(values.get(name) ?? '').trim();
  const optional = name => value(name) || undefined;
  const p = config.profiles[selected];
  p.identity = { individual: value('individual'), team: optional('team'), project: value('project') };
  p.backend = { mode: value('backendMode'), url: value('backendUrl'), ...(value('backendMode') === 'external' ? { secretRef: optional('backendSecret') } : {}) };
  p.model = { provider: value('provider'), baseUrl: value('modelUrl'), model: value('modelName'), secretRef: optional('modelSecret') };
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
  saveButton.disabled = busy || !dirty;
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
  form.append(context);

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
  model.grid.append(field('provider', 'provider', p.model.provider, { options: [['ollama', 'ollama'], ['openai-compatible', 'compatible']], wide: true }), field('modelUrl', 'modelUrl', p.model.baseUrl, { type: 'url', required: true, wide: true }), field('modelName', 'modelName', p.model.model, { wide: true, hint: 'optional' }), field('secretRef', 'modelSecret', p.model.secretRef, { wide: true, hint: 'secretsNote' }));
  const hooks = section('hooks', 'hooksNote');
  hooks.grid.append(toggle('claude', 'claude', p.hooks.claude), toggle('codex', 'codex', p.hooks.codex), toggle('vscode', 'vscode', p.hooks.vscode));
  const skills = section('skills', 'skillsNote');
  skills.grid.append(field('skillDirectories', 'skillDirectories', p.skills.directories.join('\n'), { wide: true, multiline: true, hint: 'onePerLine' }));
  const limits = section('limits');
  limits.grid.append(field('briefLimit', 'briefLimit', p.budget.briefMaxChars, { type: 'number', min: 128, max: 16384, required: true }), field('tokenLimit', 'tokenLimit', p.budget.modelMaxTokens, { type: 'number', min: 32, max: 4096, required: true }), field('timeout', 'timeout', p.budget.timeoutMs / 1000, { type: 'number', min: 0.1, max: 300, step: '0.001', required: true }), field('port', 'port', p.web.port, { type: 'number', min: 1024, max: 65535, required: true }), field('farsightOrigin', 'farsightOrigin', p.web.farsightOrigin, { type: 'url', wide: true, hint: 'embedNote' }));
  const cards = el('div', 'cards');
  cards.append(identity.card, memory.card, model.card, hooks.card, skills.card, limits.card);
  form.append(cards);
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
  baseline = JSON.stringify(config);
  if (!selected || !config.profiles[selected]) selected = config.profiles[running.profileId] ? running.profileId : config.defaultProfile;
}

function render() {
  root.replaceChildren();
  const header = el('header', 'masthead');
  const brand = el('div');
  brand.append(word('p', 'eyebrow', 'eyebrow'), word('h1', 'brand', 'brand'));
  const state = el('div', 'runtime');
  state.append(word('span', 'running', 'eyebrow'), el('strong', '', running.profileId));
  header.append(brand, state);
  const hero = el('div', 'hero');
  hero.append(word('span', 'foundation', 'badge'), word('h2', 'headline'), word('p', 'intro'));
  const boundary = el('div', 'boundary');
  boundary.append(word('strong', 'restart'), word('span', 'notBuilt'));
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
  root.append(header, hero, boundary, layout, footer);
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
