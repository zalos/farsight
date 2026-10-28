/** Read-only memory exploration. Every request stays bound to the running server profile. */
export function createPortal({ strings, running, available, synthetic = false }) {
  const t = (key) => strings[`echo.portal.${key}`].professional;
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const word = (tag, key, className = '') => {
    const node = el(tag, className, t(key));
    node.title = strings[`echo.portal.${key}`].define;
    return node;
  };
  const button = (key, className = 'button secondary') => {
    const node = word('button', key, className);
    node.type = 'button';
    return node;
  };
  const labeled = (key, id, type = 'text') => {
    const box = el('div', 'field');
    const label = word('label', key);
    label.htmlFor = id;
    const input = el(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input');
    if (input.tagName === 'INPUT') input.type = type;
    input.id = id;
    input.name = id;
    input.autocomplete = 'off';
    if (type === 'textarea') input.rows = 3;
    box.append(label, input);
    return { box, input };
  };
  const savedDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? t('unknownDate')
      : new Intl.DateTimeFormat(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'UTC',
          timeZoneName: 'short',
        }).format(date);
  };
  const day = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? t('unknownDate')
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
  };
  const validMemory = (value) =>
    value &&
    ['id', 'revision', 'title', 'content', 'timestamp'].every((key) => typeof value[key] === 'string') &&
    typeof value.truncated === 'boolean';
  const channels = new Map();
  let active = false,
    initialized = false,
    pages = [],
    cursor = null,
    selectedId = null,
    browseCriteria = {},
    browseRetry;
  const begin = (name) => {
    channels.get(name)?.abort();
    const controller = new AbortController();
    channels.set(name, controller);
    return controller;
  };
  const current = (name, controller) => active && channels.get(name) === controller && !controller.signal.aborted;
  async function request(path, body, controller, timed = true) {
    const signal = timed ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) : controller.signal;
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : t('failed'));
    return data;
  }
  const errorText = (error) =>
    error?.name === 'TimeoutError'
      ? t('timeout')
      : error instanceof Error && error.message
        ? error.message
        : t('failed');
  const root = el('section', 'memory-portal');
  root.id = 'echo-memories';
  root.setAttribute('aria-label', t('memories'));
  const heading = el('div', 'portal-heading');
  const headingText = el('div');
  headingText.append(word('span', 'readOnly', 'badge'), word('h2', 'headline'), word('p', 'intro'));
  heading.append(headingText);
  root.append(heading);
  if (synthetic) {
    const preview = el('div', 'synthetic-preview');
    preview.dataset.testid = 'synthetic-preview';
    preview.append(word('strong', 'demoTitle'), word('span', 'demoNote'));
    root.append(preview);
  }
  const identity = el('section', 'portal-identity');
  identity.setAttribute('aria-label', strings['echo.ui.running'].professional);
  const bound = el('div', 'portal-profile');
  bound.append(el('span', 'eyebrow', strings['echo.ui.running'].professional), el('strong', '', running.profileId));
  const labels = el('dl');
  for (const key of ['individual', 'team', 'project']) {
    if (running.identity?.[key]) labels.append(word('dt', key), el('dd', '', running.identity[key]));
  }
  identity.append(bound, labels, word('p', 'boundary'));
  root.append(identity);
  if (!available) {
    root.append(word('p', 'unavailable', 'portal-status error'));
    return { element: root, activate() {}, cancel() {} };
  }

  const searchForm = el('form', 'memory-search');
  searchForm.setAttribute('aria-label', t('searchForm'));
  const search = labeled('search', 'memory-search', 'search');
  search.input.maxLength = 4000;
  search.box.classList.add('search-query');
  const hint = word('span', 'searchHint', 'field-hint');
  hint.id = 'memory-search-hint';
  search.input.setAttribute('aria-describedby', hint.id);
  search.box.append(hint);
  const since = labeled('since', 'memory-since', 'date');
  const until = labeled('until', 'memory-until', 'date');
  const submit = button('search', 'button primary');
  submit.type = 'submit';
  searchForm.append(search.box, since.box, until.box, submit);
  root.append(searchForm);
  const browseStatus = el('div', 'portal-status');
  browseStatus.setAttribute('role', 'status');
  browseStatus.setAttribute('aria-live', 'polite');
  root.append(browseStatus);
  const workspace = el('div', 'memory-workspace');
  const listSide = el('section', 'memory-list-side');
  const toolbar = el('div', 'memory-toolbar');
  toolbar.append(word('h3', 'results'));
  const topics = labeled('topics', 'memory-topic', 'select');
  toolbar.append(topics.box);
  const results = el('div', 'memory-results');
  results.dataset.testid = 'memory-results';
  const loadMore = button('loadMore');
  loadMore.hidden = true;
  const limited = word('p', 'limited', 'portal-footnote');
  limited.hidden = true;
  listSide.append(toolbar, results, loadMore, limited);
  const detail = el('aside', 'memory-detail');
  detail.dataset.testid = 'memory-detail';
  detail.tabIndex = -1;
  detail.setAttribute('aria-label', t('detail'));
  detail.setAttribute('aria-live', 'polite');
  workspace.append(listSide, detail);
  root.append(workspace);

  function resetDetail() {
    channels.get('detail')?.abort();
    selectedId = null;
    detail.replaceChildren(word('span', 'detail', 'eyebrow'), word('p', 'detailEmpty', 'detail-placeholder'));
    for (const node of results.querySelectorAll('[aria-pressed]')) node.setAttribute('aria-pressed', 'false');
  }
  function metadata(memory, node) {
    const values = el('dl', 'memory-metadata');
    values.append(word('dt', 'savedAt'), el('dd', '', savedDate(memory.timestamp)));
    if (memory.provenance?.workspace) values.append(word('dt', 'source'), el('dd', '', memory.provenance.workspace));
    else values.append(word('dt', 'source'), word('dd', 'noSource'));
    if (memory.provenance?.commit)
      values.append(word('dt', 'commit'), el('dd', 'memory-revision', memory.provenance.commit));
    if (memory.provenance?.savedAt)
      values.append(word('dt', 'provenanceSaved'), el('dd', '', savedDate(memory.provenance.savedAt)));
    node.append(values);
  }
  function topicTags(memory) {
    const tags = el('div', 'memory-tags');
    for (const topic of memory.topics ?? [])
      if (typeof topic === 'string') tags.append(el('span', 'memory-topic-tag', topic));
    return tags;
  }
  function detailHeading() {
    const top = el('div', 'detail-heading');
    const close = button('closeDetail', 'text-button');
    close.addEventListener('click', () => {
      const prior = selectedId;
      resetDetail();
      for (const card of results.querySelectorAll('[data-memory-id]'))
        if (card.dataset.memoryId === prior) card.focus();
    });
    top.append(word('span', 'detail', 'eyebrow'), close);
    return top;
  }
  async function showDetail(reference) {
    const controller = begin('detail');
    selectedId = reference.id;
    for (const node of results.querySelectorAll('[data-memory-id]'))
      node.setAttribute('aria-pressed', String(node.dataset.memoryId === selectedId));
    detail.replaceChildren(detailHeading(), word('p', 'loading', 'detail-placeholder'));
    detail.focus({ preventScroll: true });
    if (matchMedia('(max-width: 850px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await request('/api/memory/expand', { id: reference.id, revision: reference.revision }, controller);
      if (!current('detail', controller)) return;
      if (
        data.schema !== 'echo-memory/v1' ||
        !['ready', 'changed', 'missing'].includes(data.status) ||
        (data.status !== 'missing' && (!validMemory(data.memory) || data.memory.id !== reference.id))
      )
        throw new Error(t('malformed'));
      detail.replaceChildren(detailHeading());
      if (data.status === 'missing') {
        detail.append(word('p', 'missing', 'portal-status'));
        return;
      }
      const memory = data.memory;
      if (data.status === 'changed') detail.append(word('p', 'changed', 'portal-status warning'));
      detail.append(el('h3', '', memory.title), topicTags(memory));
      metadata(memory, detail);
      detail.append(word('span', 'reference', 'eyebrow'), el('p', 'memory-content', memory.content));
      if (memory.truncated) detail.append(word('p', 'clipped', 'portal-footnote warning'));
    } catch (error) {
      if (!current('detail', controller)) return;
      const retry = button('retry');
      retry.addEventListener('click', () => showDetail(reference));
      detail.replaceChildren(detailHeading(), el('p', 'error', errorText(error)), retry);
    }
  }
  function countNode(count) {
    if (!count || !Number.isSafeInteger(count.n) || count.n < 0 || !strings[count.unit] || !strings[count.scope])
      return null;
    const line = el(
      'p',
      'page-count',
      `${strings[count.unit].professional.replace('{n}', String(count.n))} ${strings[count.scope].professional}`,
    );
    line.title = `${strings[count.unit].define} ${strings[count.scope].define}`;
    return line;
  }
  function renderResults() {
    const chosen = topics.input.value;
    results.replaceChildren();
    let any = false;
    for (const page of pages) {
      const visible = page.memories.filter((memory) => !chosen || memory.topics?.includes(chosen));
      if (!visible.length) continue;
      any = true;
      const section = el('section', 'memory-page');
      const count = chosen ? null : countNode(page.counts?.shown);
      if (count) section.append(count);
      const groups = new Map();
      for (const memory of visible) {
        const label = day(memory.timestamp);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(memory);
      }
      for (const [label, memories] of groups) {
        const group = el('section', 'memory-day');
        group.append(el('h4', 'memory-date', label));
        for (const memory of memories) {
          const card = el('button', 'memory-card');
          card.type = 'button';
          card.dataset.memoryId = memory.id;
          card.setAttribute('aria-pressed', String(memory.id === selectedId));
          card.title = strings['echo.portal.openMemory'].define;
          const top = el('div', 'memory-card-top');
          top.append(el('h5', '', memory.title), word('span', 'openMemory', 'memory-open'));
          card.append(top, el('p', 'memory-excerpt', memory.content), topicTags(memory));
          const source = el('p', 'memory-card-source', memory.provenance?.workspace || t('noSource'));
          source.title = strings['echo.portal.source'].define;
          card.append(source);
          card.addEventListener('click', () => showDetail(memory));
          group.append(card);
        }
        section.append(group);
      }
      results.append(section);
    }
    if (!any) results.append(word('p', chosen ? 'emptyTopic' : 'empty', 'empty-memories'));
    loadMore.hidden = !cursor;
    limited.hidden = !pages.some((page) => !page.exhaustive);
  }
  function renderTopics() {
    const chosen = topics.input.value;
    topics.input.replaceChildren();
    const all = word('option', 'allTopics');
    all.value = '';
    topics.input.append(all);
    const values = new Set(
      pages
        .flatMap((page) => page.memories.flatMap((memory) => memory.topics ?? []))
        .filter((value) => typeof value === 'string'),
    );
    for (const value of [...values].sort((a, b) => a.localeCompare(b))) {
      const option = el('option', '', value);
      option.value = value;
      topics.input.append(option);
    }
    topics.input.value = values.has(chosen) ? chosen : '';
  }
  async function browse(next = false) {
    const controller = begin('browse');
    const nextCursor = next ? cursor : null;
    if (!next) {
      pages = [];
      cursor = null;
      resetDetail();
      renderTopics();
      results.replaceChildren();
      const sinceValue = since.input.value ? `${since.input.value}T00:00:00.000Z` : undefined;
      const untilValue = until.input.value ? `${until.input.value}T23:59:59.999Z` : undefined;
      if (sinceValue && untilValue && sinceValue > untilValue) {
        browseStatus.replaceChildren(word('p', 'invalidDates', 'error'));
        return;
      }
      browseCriteria = {
        query: search.input.value.trim(),
        ...(sinceValue ? { since: sinceValue } : {}),
        ...(untilValue ? { until: untilValue } : {}),
      };
    }
    loadMore.hidden = true;
    submit.disabled = true;
    results.setAttribute('aria-busy', 'true');
    browseStatus.replaceChildren(word('p', 'loading'));
    browseRetry = () => browse(next);
    try {
      const data = await request(
        '/api/memory/browse',
        { ...browseCriteria, ...(nextCursor ? { cursor: nextCursor } : {}) },
        controller,
      );
      if (!current('browse', controller)) return;
      if (
        data.schema !== 'echo-portal/v1' ||
        data.profileId !== running.profileId ||
        !Array.isArray(data.memories) ||
        !data.memories.every(validMemory) ||
        (data.nextCursor !== null && typeof data.nextCursor !== 'string')
      )
        throw new Error(t('malformed'));
      pages.push(data);
      cursor = data.nextCursor;
      renderTopics();
      renderResults();
      browseStatus.replaceChildren();
      if (data.truncated) browseStatus.append(word('p', 'clipped', 'warning'));
    } catch (error) {
      if (!current('browse', controller)) return;
      const retry = button('retry');
      retry.addEventListener('click', () => browseRetry());
      browseStatus.replaceChildren(el('p', 'error', errorText(error)), retry);
    } finally {
      if (current('browse', controller)) {
        submit.disabled = false;
        results.setAttribute('aria-busy', 'false');
      }
    }
  }
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    browse();
  });
  searchForm.addEventListener('input', () => {
    channels.get('browse')?.abort();
    pages = [];
    cursor = null;
    resetDetail();
    renderTopics();
    results.replaceChildren();
    loadMore.hidden = true;
    limited.hidden = true;
    submit.disabled = false;
    results.setAttribute('aria-busy', 'false');
    browseStatus.replaceChildren(word('p', 'pendingSearch'));
  });
  topics.input.addEventListener('change', () => {
    resetDetail();
    renderResults();
  });
  loadMore.addEventListener('click', () => browse(true));
  resetDetail();
  renderTopics();

  const ask = el('section', 'submind-panel');
  const askHeading = el('div', 'submind-heading');
  askHeading.append(
    word('h3', 'askTitle'),
    word(
      'span',
      running.submindMode === 'mock' ? 'askMock' : running.submindMode === 'model' ? 'askModel' : 'askOff',
      'submind-mode',
    ),
  );
  const askForm = el('form', 'submind-form');
  askForm.setAttribute('aria-label', t('askTitle'));
  const query = labeled('askQuery', 'submind-query', 'textarea');
  query.input.required = true;
  query.input.maxLength = 4000;
  const askButton = button('ask', 'button primary');
  askButton.type = 'submit';
  const cancel = button('cancel');
  cancel.hidden = true;
  const askActions = el('div', 'actions');
  askActions.append(askButton, cancel);
  askForm.append(query.box, askActions);
  query.input.disabled = running.submindMode === 'off';
  askButton.disabled = running.submindMode === 'off';
  const askStatus = el('div', 'portal-status');
  askStatus.setAttribute('role', 'status');
  const brief = el('section', 'research-brief');
  brief.setAttribute('aria-label', t('research'));
  brief.dataset.testid = 'research-brief';
  ask.append(askHeading, askForm, askStatus, brief);
  root.append(ask);
  const stopWords = {
    complete: 'reasonComplete',
    no_matches: 'reasonNoMatches',
    disabled: 'askOff',
    budget: 'reasonBudget',
    timeout: 'reasonTimeout',
    model_unavailable: 'reasonModelUnavailable',
    invalid_response: 'reasonInvalidResponse',
    store_unavailable: 'reasonStoreUnavailable',
  };
  function idleAsk() {
    askButton.disabled = running.submindMode === 'off';
    query.input.disabled = running.submindMode === 'off';
    cancel.hidden = true;
  }
  function cancelAsk() {
    channels.get('ask')?.abort();
    idleAsk();
    askStatus.replaceChildren(word('p', 'cancelled'));
  }
  cancel.addEventListener('click', cancelAsk);
  function renderBrief(data) {
    if (
      data.schema !== 'echo-memory/v1' ||
      data.mode !== running.submindMode ||
      !Array.isArray(data.findings) ||
      !Array.isArray(data.actions) ||
      !data.coverage ||
      !Object.hasOwn(stopWords, data.coverage.stopReason)
    )
      throw new Error(t('malformed'));
    const actions = data.actions.filter(
      (action) =>
        action?.rel === 'read_more' &&
        action.operation === 'memory.expand' &&
        typeof action.arguments?.id === 'string' &&
        typeof action.arguments?.revision === 'string',
    );
    for (const finding of data.findings) {
      if (
        typeof finding.problem !== 'string' ||
        typeof finding.fix !== 'string' ||
        (finding.why !== null && typeof finding.why !== 'string') ||
        !Array.isArray(finding.citations)
      )
        throw new Error(t('malformed'));
      const card = el('article', 'finding');
      for (const [key, value] of [
        ['problem', finding.problem],
        ['fix', finding.fix],
        ['why', finding.why ?? t('whyUnknown')],
      ])
        card.append(word('h4', key), el('p', '', value));
      const refs = el('div', 'finding-references');
      refs.append(word('span', 'citations', 'eyebrow'));
      for (const citation of finding.citations) {
        if (typeof citation.id !== 'string' || typeof citation.revision !== 'string') throw new Error(t('malformed'));
        const item = el('div', 'finding-reference');
        item.append(el('strong', '', citation.title || citation.id));
        if (citation.timestamp) item.append(el('span', 'field-hint', savedDate(citation.timestamp)));
        const action = actions.find(
          (value) => value.arguments.id === citation.id && value.arguments.revision === citation.revision,
        );
        if (action) {
          const more = button('readMore', 'text-button');
          more.addEventListener('click', () => showDetail(action.arguments));
          item.append(more);
        }
        refs.append(item);
      }
      card.append(refs);
      brief.append(card);
    }
    if (!data.findings.length) brief.append(word('p', 'researchEmpty', 'empty-memories'));
    askStatus.replaceChildren(
      word(
        'p',
        stopWords[data.coverage.stopReason],
        data.status === 'partial' || data.status === 'unavailable' ? 'warning' : '',
      ),
    );
    if (data.coverage.truncated) askStatus.append(word('p', 'clipped', 'warning'));
  }
  askForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running.submindMode === 'off' || !query.input.value.trim()) return;
    const controller = begin('ask');
    brief.replaceChildren();
    askStatus.replaceChildren(word('p', 'askLoading'));
    askButton.disabled = true;
    query.input.disabled = true;
    cancel.hidden = false;
    try {
      const data = await request('/api/memory/ask', { query: query.input.value.trim() }, controller, false);
      if (!current('ask', controller)) return;
      renderBrief(data);
    } catch (error) {
      if (!current('ask', controller)) return;
      brief.replaceChildren();
      askStatus.replaceChildren(el('p', 'error', errorText(error)));
    } finally {
      if (current('ask', controller)) idleAsk();
    }
  });
  return {
    element: root,
    activate() {
      active = true;
      if (!initialized) {
        initialized = true;
        browse();
      }
    },
    cancel() {
      active = false;
      for (const controller of channels.values()) controller.abort();
      submit.disabled = false;
      results.setAttribute('aria-busy', 'false');
      loadMore.hidden = !cursor;
      browseStatus.replaceChildren();
      if (!pages.length) initialized = false;
      if (channels.get('detail')?.signal.aborted && detail.querySelector('.detail-placeholder')) resetDetail();
      if (!cancel.hidden) {
        idleAsk();
        askStatus.replaceChildren(word('p', 'cancelled'));
      }
    },
  };
}
