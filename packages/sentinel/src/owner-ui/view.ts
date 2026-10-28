import { processLayout } from './process-layout.js';
// Static trusted browser code only. Every source-derived value is assigned as text; no scanned HTML executes.
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function ownerUiHtml(parent: string, instance: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body data-parent="${escape(parent)}" data-instance="${escape(instance)}"><main id="owner-ui" aria-live="polite"></main><script src="/client.js" defer></script></body></html>`;
}
export function ownerUiRecoveryHtml(title: string, explanation: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/style.css"></head><body><main><section role="alert"><h1>${escape(title)}</h1><p>${escape(explanation)}</p></section></main></body></html>`;
}
export const ownerUiCss = `:root{color-scheme:dark;--bg:#0a0d14;--panel:#111623;--text:#e7edf5;--muted:#a9b5c7;--line:#344052;--accent:#5bc8dd}body[data-theme=light]{color-scheme:light;--bg:#f4f6fa;--panel:#fff;--text:#192538;--muted:#46566d;--line:#c4ccda;--accent:#176d83}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:20px}h1,h2{font-family:"Avenir Next Condensed",system-ui,sans-serif}h1{margin:0 0 12px}h2{font-size:19px;margin:0 0 12px}section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0}p{line-height:1.5;color:var(--muted)}button,select{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:9px 12px;margin:4px 8px 4px 0}button{cursor:pointer}button.primary{border-color:var(--accent);color:var(--accent)}button:disabled,select:disabled{opacity:.55;cursor:not-allowed}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.notice{border-left:3px solid var(--accent);padding:10px 14px}.error{color:#e8a13c}.pill{display:inline-block;padding:4px 8px;border:1px solid var(--line);border-radius:12px;margin:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.scroll{overflow:auto;max-height:420px}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:8px;word-break:break-word}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}label{display:block}#message{min-height:24px}.process-dag{position:relative;overflow:auto;padding:8px;isolation:isolate}.process-level{display:flex;gap:16px;justify-content:center;align-items:flex-start;margin:32px 0;min-width:min-content}.process-card{position:relative;z-index:1;background:var(--panel);border:1px solid var(--accent);border-radius:8px;padding:12px;min-width:220px;max-width:440px;flex:1}.process-card summary{cursor:pointer;font-weight:600}.process-links{position:absolute;left:0;top:0;z-index:0;pointer-events:none;overflow:visible}.process-links path{stroke:var(--accent);stroke-width:2;fill:none}code{overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr 1fr;gap:6px}dd{margin:0}.detail{color:var(--muted);font:12px ui-monospace,monospace}@media(max-width:500px){main{padding:10px}section{padding:12px}button{width:100%;margin:5px 0}}`;
function browserMain(layout: typeof processLayout) {
  const root = document.getElementById('owner-ui')!,
    parentOrigin = document.body.dataset.parent!,
    hostInstance = document.body.dataset.instance!,
    documentId = 'document-' + crypto.randomUUID().replace(/-/g, ''),
    frameNonce = 'frame-' + crypto.randomUUID().replace(/-/g, '');
  let launchCode = new URLSearchParams(location.hash.slice(1)).get('launch');
  history.replaceState(null, '', location.pathname);
  let inspectPhase = 'analysis',
    selectedRun: string | null = null,
    hasRun = false,
    terminalRun = false,
    processSupported = false,
    baselineKey: string | null = null,
    graphBusy = false,
    graphSelection: string | null = null,
    graphState: string | null = null,
    reportGeneration = 0;
  let connectionHealthy = true,
    sessionLost = false,
    runDeadline: number | null = null,
    currentRunState: string | null = null;
  let words: Record<string, any> = {},
    register = 'professional',
    cap = '',
    view: any = null,
    readOnly = true,
    stopped = false,
    confirmation: any = null,
    inspection: any = null,
    collection = 'works',
    nextCursor: string | null = null,
    polling = false;
  const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>();
  const text = (name: string) => {
    const key = name.startsWith('sentinel.') ? name : 'sentinel.ownerUi.' + name;
    return words[key]?.[register] ?? words['sentinel.ownerUi.failed']?.[register] ?? key;
  };
  /** A word with its `{detail}` filled from the service's safe detail, or the parenthesis dropped when there is none. */
  const detailed = (name: string, detail: unknown) => {
    const w = text(name);
    if (!w.includes('{detail}')) return w;
    const d = typeof detail === 'string' ? detail.slice(0, 240) : '';
    return d ? w.split('{detail}').join(d) : w.replace(/\s*\(\{detail\}\)/, '').replace('{detail}', '');
  };
  const element = (tag: string, word?: string, parent?: HTMLElement) => {
    const e = document.createElement(tag);
    if (word) {
      e.textContent = text(word);
      e.title = words[word.startsWith('sentinel.') ? word : 'sentinel.ownerUi.' + word]?.define ?? '';
    }
    parent?.append(e);
    return e;
  };
  const notice = (value: string, error = false) => {
    const e = document.getElementById('message');
    if (e) {
      e.textContent = value;
      e.className = error ? 'notice error' : 'notice';
    }
  };
  const call = async (path: string, body: any = {}) => {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cap ? { authorization: 'Bearer ' + cap } : {}) },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      }),
      value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.message || text(value.error)), { code: value.error });
    return value;
  };
  const sessionFailure = (error: any) =>
    ['sentinel.ownerUi.expired', 'sentinel.ownerUi.replayed', 'sentinel.ownerUi.replaced'].includes(error?.code);
  const connectionFailure = (error: any) => {
    connectionHealthy = false;
    if (sessionFailure(error)) {
      sessionLost = true;
      stopped = true;
      confirmation = null;
      document.getElementById('confirm')?.remove();
    }
    notice(sessionFailure(error) ? text(error.code) : text('connectionLost'), true);
    writes();
  };
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error: any) {
      if (sessionFailure(error)) connectionFailure(error);
      else if (connectionHealthy) notice(error.code ? text(error.code) : text('failed'), true);
    }
  };
  const random = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('');
  const parentContext = () =>
    new Promise<any>((resolve, reject) => {
      const id = random(),
        timer = setTimeout(() => {
          waiting.delete(id);
          reject(Error('context'));
        }, 1200);
      waiting.set(id, { resolve, reject, timer });
      parent.postMessage(
        { type: 'sentinel-owner-context-request', id, frameNonce, documentId, hostInstance },
        parentOrigin,
      );
    });
  const writes = () => {
    const writable = connectionHealthy && !sessionLost && view?.mode === 'live' && view?.sync === null && !readOnly;
    for (const e of document.querySelectorAll<HTMLButtonElement>('button[data-effect]'))
      e.disabled =
        !writable ||
        (e.hasAttribute('data-requires-run') && (!hasRun || terminalRun)) ||
        (e.hasAttribute('data-requires-terminal') && !terminalRun) ||
        (e.dataset.action === 'start' && runDeadline !== null && Date.now() >= runDeadline);
    const total = document.getElementById('total-report') as HTMLButtonElement | null,
      comparison = document.getElementById('comparison-report') as HTMLButtonElement | null;
    if (total) total.disabled = currentRunState !== 'completed';
    if (comparison) comparison.disabled = currentRunState !== 'completed' || !baselineKey;
    const e = document.getElementById('readonly');
    if (e) e.hidden = writable;
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      !event.data ||
      event.data.type !== 'sentinel-owner-context' ||
      event.data.frameNonce !== frameNonce ||
      event.data.documentId !== documentId
    )
      return;
    const data = event.data;
    if (data.context?.hostInstance !== hostInstance) return;
    const old = view;
    view = data.context;
    if (data.presentation?.theme === 'light' || data.presentation?.theme === 'dark')
      document.body.dataset.theme = data.presentation.theme;
    if (['hud', 'professional'].includes(data.presentation?.register)) register = data.presentation.register;
    const pending = waiting.get(data.id);
    if (pending) {
      waiting.delete(data.id);
      clearTimeout(pending.timer);
      pending.resolve(view);
    } else if (cap && (!old || view.revision !== old.revision))
      void run(async () => {
        await call('/context', { view });
        confirmation = null;
        document.getElementById('confirm')?.remove();
        writes();
      });
    writes();
  });
  // The read pass for the parent page (transport/http/): reads of retained scans only. It is handed to the exact
  // paired parent with this frame's nonce and document, and only after this frame holds a live session.
  const handPass = async () => {
    if (!cap || sessionLost) return;
    const v = await call('/viewer-pass');
    parent.postMessage(
      { type: 'sentinel-owner-read', frameNonce, documentId, hostInstance, pass: v.pass, expiresAt: v.expiresAt },
      parentOrigin,
    );
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      !event.data ||
      !['sentinel-owner-read-request', 'sentinel-owner-scan', 'sentinel-owner-pipeline'].includes(event.data.type) ||
      event.data.frameNonce !== frameNonce ||
      event.data.documentId !== documentId
    )
      return;
    if (event.data.type === 'sentinel-owner-read-request') void handPass().catch(() => {});
    else if (event.data.type === 'sentinel-owner-pipeline') {
      // The parent's edited pipeline: this panel has the service check it and preview it, and the owner confirms the
      // write here. What comes back to the parent is the service's answer, never a capability or a receipt.
      const { pipeline, expectDigest } = event.data;
      if (
        !cap ||
        sessionLost ||
        !pipeline ||
        typeof pipeline !== 'object' ||
        Array.isArray(pipeline) ||
        !(expectDigest === null || (typeof expectDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(expectDigest)))
      )
        return;
      void run(async () => {
        notice(text('pipelineChecking'));
        try {
          showPipeline(await call('/pipeline-preview', { pipeline, expectDigest }));
        } catch (error: any) {
          tellPipeline({ state: 'failed', reasonCode: error?.code ?? 'sentinel.ownerUi.failed' });
          throw error;
        }
      });
    }
    // The parent's Scan button: this panel previews a fresh capture and waits for the owner's confirmation here, then
    // previews the start for a second confirmation (the facade's one composite receipt replaces the two later).
    else if (cap && !sessionLost)
      void run(async () => {
        scanFlow = true;
        notice(text('previewPending'));
        showPreview(await call('/preview'));
        document.getElementById('preview')?.scrollIntoView({ block: 'nearest' });
      });
  });
  let scanFlow = false;
  /** After a Scan's preparation is confirmed: wait for it to be prepared, then preview its start. */
  async function continueScan() {
    for (let i = 0; scanFlow && i < 240; i++) {
      const response = await call('/status');
      const phase = response.status?.found ? response.status.phase : null;
      if (phase === 'prepared') {
        scanFlow = false;
        await refresh();
        showPreview(await call('/control-preview', { action: 'start' }));
        document.getElementById('preview')?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (['interrupted', 'failed', 'canceled'].includes(phase)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    scanFlow = false;
  }
  function button(parent: HTMLElement, name: string, action: () => Promise<void>, effect = false) {
    const b = element('button', name, parent) as HTMLButtonElement;
    if (effect) b.dataset.effect = 'true';
    b.addEventListener('click', () => void run(action));
    return b;
  }
  function section(name: string) {
    const s = element('section', undefined, root);
    element('h2', name, s);
    return s;
  }
  let refreshPromise: Promise<void> | null = null;
  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = refreshNow()
      .catch((error) => {
        connectionFailure(error);
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }
  async function refreshNow() {
    const response = await call('/status'),
      status = response.status,
      nextRun = response.selection?.key ?? null;
    if (selectedRun !== nextRun) {
      reportGeneration++;
      selectedRun = nextRun;
      const report = document.getElementById('report-text')!;
      report.textContent = '';
      report.removeAttribute('data-format-digest');
      document.getElementById('preview')?.replaceChildren();
      confirmation = null;
      document.getElementById('process-graph')?.replaceChildren();
      document.getElementById('process-details')?.replaceChildren();
      graphSelection = null;
    }
    const e = document.getElementById('status')!;
    e.replaceChildren();
    hasRun = !!nextRun;
    if (!hasRun) {
      terminalRun = false;
      inspection = null;
      currentRunState = null;
      runDeadline = null;
      connectionHealthy = !sessionLost;
      document.getElementById('rows')?.replaceChildren();
      element('p', status?.found ? undefined : 'empty', e).textContent = status?.found
        ? String(status.phase)
        : text('empty');
      writes();
      return;
    }
    if (status?.found) {
      const preparation = element('p', undefined, e);
      element('strong', 'preparationState', preparation);
      element('span', undefined, preparation).textContent = ' · ';
      element('span', undefined, preparation).textContent = String(status.phase);
      if (status.runDeadlineAt) {
        element('span', 'deadline', e);
        const time = element('time', undefined, e);
        time.textContent = ' · ' + new Date(status.runDeadlineAt).toLocaleString();
        time.setAttribute('datetime', status.runDeadlineAt);
      }
      if (status.reasonCode) element('p', undefined, e).textContent = text(status.reasonCode);
    }
    const current = await call('/inspect', { phase: 'analysis', selectionId: nextRun });
    if (selectedRun !== nextRun) return;
    inspection =
      inspectPhase === 'analysis' ? current : await call('/inspect', { phase: inspectPhase, selectionId: nextRun });
    if (selectedRun !== nextRun) return;
    currentRunState = current.status;
    runDeadline = status?.runDeadlineAt ? Date.parse(status.runDeadlineAt) : null;
    if (!['completed', 'canceled'].includes(current.status) && runDeadline !== null && Date.now() >= runDeadline)
      element('p', 'deadlinePassed', e).className = 'notice';
    else if (status?.phase === 'prepared' && current.status === 'running' && current.counts.attempts.n === 0)
      element('p', 'preparedNotStarted', e).className = 'notice';
    element('h3', inspectPhase, e);
    const counts = element('div', undefined, e);
    for (const key of ['works', 'attempts', 'inputs', 'outputs']) {
      const pill = element('span', undefined, counts);
      pill.className = 'pill';
      pill.textContent = `${inspection.counts[key].n} ${text(key)}`;
      pill.title = words[inspection.counts[key].scope]?.define ?? '';
    }
    terminalRun = ['completed', 'canceled'].includes(current.status);
    const recorded = element('p', undefined, e);
    element('strong', 'recordedRunState', recorded);
    element('span', undefined, recorded).textContent = ' · ';
    element('span', undefined, recorded).textContent = String(current.status);
    await page(true);
    const recovered = !connectionHealthy;
    connectionHealthy = !sessionLost;
    if (recovered && !sessionLost) notice('');
    writes();
    if (
      processSupported &&
      (graphSelection !== selectedRun ||
        (graphState !== inspection.status && !document.querySelector('#process-graph details[open]')))
    )
      await graph();
  }
  async function runList() {
    if (!processSupported) return;
    const result = await call('/runs'),
      current = document.getElementById('run-choice') as HTMLSelectElement,
      base = document.getElementById('baseline-choice') as HTMLSelectElement;
    current.replaceChildren();
    base.replaceChildren();
    (element('option', 'chooseRun', current) as HTMLOptionElement).value = '';
    (element('option', 'noBaseline', base) as HTMLOptionElement).value = '';
    for (const row of result.runs) {
      for (const select of [current, base]) {
        const option = element('option', undefined, select) as HTMLOptionElement;
        option.value = row.key;
        option.textContent =
          new Date(row.createdAt).toLocaleString() + ' · ' + row.state + ' · ' + row.key.slice(0, 9) + '…';
      }
    }
    document.getElementById('run-note')!.textContent = result.more ? text('runsMore') : '';
  }
  async function collectionRows(view: any, name: string, workKey?: string) {
    const rows: any[] = [];
    let cursor: string | null = null;
    do {
      const result = await call('/page', {
        viewId: view.viewId,
        collection: name,
        ...(cursor ? { cursor } : {}),
        ...(workKey ? { workKey } : {}),
      });
      rows.push(...result.rows);
      if (rows.length > 20000) throw Error('limit');
      cursor = result.nextCursor;
    } while (cursor);
    return rows;
  }
  function identityLine(parent: HTMLElement, label: string, value: any) {
    const p = element('p', undefined, parent);
    element('strong', label, p);
    const code = element('code', undefined, p);
    code.textContent = ' · ' + String(value ?? text('unknown'));
  }
  function quantity(key: string, n: number) {
    return text(key).replace('{n}', Number(n.toPrecision(8)).toLocaleString());
  }
  function storage(n: number) {
    return quantity(
      n >= 1073741824 ? 'storageGiB' : n >= 1048576 ? 'storageMiB' : 'storageBytes',
      n >= 1073741824 ? n / 1073741824 : n >= 1048576 ? n / 1048576 : n,
    );
  }
  function showResources(parent: HTMLElement, resource: any) {
    if (!resource) return;
    const dl = element('dl', undefined, parent);
    for (const [key, label] of [
      ['deadlineMs', 'stageDeadline'],
      ['memoryBytes', 'memory'],
      ['cpuQuota', 'cpu'],
      ['maxPids', 'pids'],
      ['maxOutputBytes', 'outputLimit'],
    ] as const) {
      element('dt', label, dl);
      const value = element('dd', undefined, dl);
      value.textContent =
        key === 'deadlineMs'
          ? quantity('durationSeconds', resource[key] / 1000)
          : key === 'memoryBytes' || key === 'maxOutputBytes'
            ? storage(resource[key])
            : quantity(key === 'cpuQuota' ? 'processorCores' : 'processCount', resource[key]);
      value.title =
        key === 'memoryBytes' || key === 'maxOutputBytes' ? quantity('storageBytes', resource[key]) : text(label);
    }
    dl.title = text('resources');
  }
  function renderEvidence(parent: HTMLElement, name: string, rows: any[]) {
    const table = element('table', undefined, parent),
      head = element('tr', undefined, element('thead', undefined, table));
    const labels =
      name === 'attempts'
        ? ['column.work', 'column.state', 'column.accepted', 'outputs']
        : name === 'inputs'
          ? ['column.work', 'column.source', 'column.input']
          : ['column.output', 'column.format', 'column.privacy', 'column.accepted'];
    for (const label of labels) element('th', label, head);
    const body = element('tbody', undefined, table);
    for (const row of rows) {
      const tr = element('tr', undefined, body),
        values =
          name === 'attempts'
            ? [row.workKey, row.state, row.accepted, row.outputCount]
            : name === 'inputs'
              ? [row.workKey, row.sourceKey, row.inputKey]
              : [row.outputKey, row.mediaType, row.privacy, row.accepted];
      for (const value of values) {
        const td = element('td', undefined, tr);
        td.textContent =
          typeof value === 'string' && /^h[a-f0-9]{32}$/.test(value)
            ? value.slice(0, 9) + '…'
            : typeof value === 'boolean'
              ? text(value ? 'accepted' : 'notAccepted')
              : String(value ?? '');
        td.title = String(value ?? '');
      }
    }
  }
  async function workEvidence(view: any, row: any, parent: HTMLElement) {
    parent.replaceChildren();
    for (const name of ['attempts', 'inputs', 'outputs']) {
      const group = element('details', undefined, parent) as HTMLDetailsElement;
      element('summary', name, group);
      group.addEventListener('toggle', () => {
        if (!group.open || group.dataset.loaded) return;
        group.dataset.loaded = 'true';
        const content = element('div', undefined, group);
        let cursor: string | null = null;
        const load = async () => {
          const answer = await call('/page', {
            viewId: view.viewId,
            collection: name,
            workKey: row.workKey,
            ...(cursor ? { cursor } : {}),
          });
          renderEvidence(content, name, answer.rows);
          cursor = answer.nextCursor;
          more.disabled = !cursor;
          requestAnimationFrame(() => {
            const grid = parent.closest<HTMLElement>('.process-dag');
            if (grid) grid.dispatchEvent(new Event('redraw'));
          });
        };
        const more = button(group, 'more', load);
        void run(load);
      });
    }
    showResources(parent, row.resources);
    const rerun = button(parent, 'perWorkRerun', async () => {});
    rerun.disabled = true;
    rerun.title = text('rerunUnavailable');
    element('p', 'rerunUnavailable', parent);
  }

  async function graph() {
    if (!selectedRun || !processSupported || graphBusy) return;
    graphBusy = true;
    const selectionId = selectedRun,
      box = document.getElementById('process-graph')!;
    try {
      const current = await call('/inspect', { phase: 'analysis', selectionId }),
        earlier = await call('/inspect', { phase: 'bootstrap', selectionId }),
        views = earlier.planRevision < current.planRevision ? [earlier, current] : [current],
        panels: HTMLElement[] = [],
        drawers: Array<() => void> = [];
      for (const view of views) {
        const rows = await collectionRows(view, 'works'),
          levels = layout(rows),
          byKey = new Map(rows.map((r) => [r.workKey, r])),
          panel = element('section'),
          title = element('h3', view.historical ? 'earlier' : 'current', panel);
        title.title = text('graphSnapshot');
        element('p', 'parallel', panel);
        const grid = element('div', undefined, panel);
        grid.className = 'process-dag';
        grid.addEventListener('redraw', () => drawLinks(grid, rows));
        for (const keys of levels) {
          const level = element('div', undefined, grid);
          level.className = 'process-level';
          for (const key of keys) {
            const row = byKey.get(key)!,
              card = element('details', undefined, level) as HTMLDetailsElement;
            card.className = 'process-card';
            card.dataset.work = key;
            card.title = text('graphSnapshot');
            const summary = element('summary', undefined, card);
            summary.textContent =
              row.stage +
              ' · ' +
              (row.recordedWork?.state ?? 'awaiting-first-execution') +
              ' · ' +
              key.slice(0, 9) +
              '…';
            const body = element('div', undefined, card);
            for (const dep of row.prerequisites) {
              if (dep.binding === 'in-view') continue;
              const p = element('p', undefined, body);
              p.className = 'detail';
              p.textContent = text('references') + ' · ' + dep.workKey.slice(0, 9) + '… · ' + dep.binding;
            }
            card.addEventListener('toggle', () => {
              drawLinks(grid, rows);
              if (card.open && !card.dataset.loaded) {
                card.dataset.loaded = 'true';
                const content = element('div', undefined, body);
                void run(() => workEvidence(view, row, content));
              }
            });
          }
        }
        panels.push(panel);
        drawers.push(() => drawLinks(grid, rows));
      }
      if (selectionId !== selectedRun) return;
      box.replaceChildren(...panels);
      requestAnimationFrame(() => drawers.forEach((draw) => draw()));
      element('p', 'graphSnapshot', box);
      element('p', 'entryUnknown', box);
      graphSelection = selectionId;
      graphState = current.status;
      try {
        const details = await call('/process', { selectionId });
        if (selectionId === selectedRun) showProcessDetails(details);
      } catch (error: any) {
        if (selectionId === selectedRun) notice(error.code ? text(error.code) : text('failed'), true);
      }
    } finally {
      graphBusy = false;
    }
  }
  function drawLinks(grid: HTMLElement, rows: any[]) {
    if (!grid.isConnected) return;
    grid.querySelector('svg')?.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      bounds = grid.getBoundingClientRect();
    svg.setAttribute('class', 'process-links');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', String(grid.scrollWidth));
    svg.setAttribute('height', String(grid.scrollHeight));
    for (const row of rows) {
      const target = grid.querySelector<HTMLElement>('[data-work="' + row.workKey + '"]');
      if (!target) continue;
      const b = target.getBoundingClientRect();
      for (const dependency of row.prerequisites) {
        if (dependency.binding !== 'in-view') continue;
        const from = grid.querySelector<HTMLElement>('[data-work="' + dependency.workKey + '"]');
        if (!from) continue;
        const a = from.getBoundingClientRect(),
          x = a.x + a.width / 2 - bounds.x,
          y = a.bottom - bounds.y,
          tx = b.x + b.width / 2 - bounds.x,
          ty = b.top - bounds.y,
          path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${x},${y} C${x},${(y + ty) / 2} ${tx},${(y + ty) / 2} ${tx},${ty}`);
        svg.append(path);
      }
    }
    grid.prepend(svg);
  }
  function showProcessDetails(details: any) {
    const box = document.getElementById('process-details')!;
    box.replaceChildren();
    identityLine(box, 'runDeadline', new Date(details.runDeadlineAt).toLocaleString());
    element('p', 'scheduler', box);
    identityLine(box, 'currentSlots', quantity('slotCount', details.scheduler.currentDefault.slots));
    identityLine(box, 'memory', storage(details.scheduler.currentDefault.memoryBytes));
    identityLine(box, 'cpu', quantity('processorCores', details.scheduler.currentDefault.cpus));
    const grants = element('details', undefined, box);
    element('summary', 'pinned', grants);
    for (const grant of details.grants) {
      element('h4', undefined, grants).textContent = grant.stage;
      showResources(grants, grant);
    }
    element('h3', 'acceptedModels', box);
    element('p', 'modelReadOnly', box);
    const review = details.review;
    if (review.status !== 'available') {
      element('p', review.status === 'withheld' ? 'identityWithheld' : 'identityUnavailable', box);
      return;
    }
    for (const record of review.reviews) {
      const section = element('details', undefined, box);
      element('summary', undefined, section).textContent = record.stage + ' · ' + record.segmentId;
      identityLine(
        section,
        'requestedModel',
        record.requestedSelection.providerId + ' / ' + record.requestedSelection.modelId,
      );
      identityLine(section, 'reportedModel', record.reportedIdentity?.returnedModel);
      identityLine(section, 'identitySource', record.reportedIdentity?.source);
      const show = (label: string, value: any) =>
        identityLine(section, label, value.revision + ' · ' + value.digest + ' · ' + value.bytes);
      show('prompt', record.instructions.prompt);
      for (const skill of record.instructions.skills) {
        show('skill', skill);
        for (const resource of skill.resources) show('resource', resource);
      }
      identityLine(
        section,
        'assembly',
        record.instructions.assembly +
          ' · ' +
          record.instructions.digest +
          ' · ' +
          record.instructions.assembled.digest +
          ' · ' +
          record.instructions.assembled.bytes,
      );
    }
  }

  async function page(reset: boolean) {
    if (!inspection) return;
    const answer = await call('/page', {
      viewId: inspection.viewId,
      collection,
      ...(!reset && nextCursor ? { cursor: nextCursor } : {}),
    });
    nextCursor = answer.nextCursor;
    const box = document.getElementById('rows')!;
    if (reset) box.replaceChildren();
    const table = element('table', undefined, box),
      head = element('tr', undefined, element('thead', undefined, table));
    const labels =
      collection === 'works'
        ? ['column.stage', 'column.state', 'inputs']
        : collection === 'attempts'
          ? ['column.work', 'column.state', 'column.accepted', 'outputs']
          : collection === 'inputs'
            ? ['column.work', 'column.source', 'column.input']
            : ['column.output', 'column.format', 'column.privacy', 'column.accepted'];
    for (const label of labels) element('th', label, head);
    const body = element('tbody', undefined, table);
    for (const row of answer.rows) {
      const tr = element('tr', undefined, body),
        values =
          collection === 'works'
            ? [row.stage, row.recordedWork?.state ?? 'awaiting-first-execution', row.inputCount]
            : collection === 'attempts'
              ? [row.workKey, row.state, row.accepted, row.outputCount]
              : collection === 'inputs'
                ? [row.workKey, row.sourceKey, row.inputKey]
                : [row.outputKey, row.mediaType, row.privacy, row.accepted];
      for (const value of values) {
        const td = element('td', undefined, tr);
        const shown =
          typeof value === 'string' && /^h[a-f0-9]{32}$/.test(value)
            ? value.slice(0, 9) + '…'
            : typeof value === 'boolean'
              ? text(value ? 'accepted' : 'notAccepted')
              : words['sentinel.ownerUi.state.' + value]
                ? text('state.' + value)
                : String(value ?? '');
        td.textContent = shown;
        td.title = String(value ?? '');
      }
    }
    (document.getElementById('more') as HTMLButtonElement).disabled = !nextCursor;
  }
  /** What the parent page may know of a pipeline check or write: the service's own answer, in its own words. */
  function tellPipeline(answer: {
    state: 'checked' | 'refused' | 'written' | 'failed';
    reasonCode?: string | null;
    detail?: unknown;
    problems?: unknown;
    preview?: unknown;
    written?: unknown;
  }) {
    parent.postMessage(
      {
        type: 'sentinel-owner-pipeline-result',
        frameNonce,
        documentId,
        hostInstance,
        state: answer.state,
        reasonCode: typeof answer.reasonCode === 'string' ? answer.reasonCode : null,
        detail: typeof answer.detail === 'string' ? answer.detail.slice(0, 240) : null,
        problems: Array.isArray(answer.problems) ? answer.problems : [],
        preview: answer.preview && typeof answer.preview === 'object' ? answer.preview : null,
        written: answer.written && typeof answer.written === 'object' ? answer.written : null,
      },
      parentOrigin,
    );
  }
  function showPipeline(answer: any) {
    const e = document.getElementById('preview')!;
    e.replaceChildren();
    // offered a confirmation, the answer is { preview: <the service's answer>, confirmation }; refused, it is the answer
    const checked = answer.confirmation ? answer.preview : answer;
    if (answer.unavailable || !answer.confirmation) {
      notice(detailed(checked.reasonCode || 'pipelineRefused', checked.detail), true);
      tellPipeline({
        state: 'refused',
        reasonCode: checked.reasonCode,
        detail: checked.detail,
        problems: checked.problems,
        preview: checked.preview,
      });
      return;
    }
    tellPipeline({ state: 'checked', problems: checked.problems, preview: checked.preview });
    notice(text('pipelineReady'));
    confirmation = answer.confirmation;
    const p = element('p', 'pipelineWriteOnly', e);
    p.className = 'notice';
    const list = element('ul', undefined, e);
    for (const stage of checked.preview?.stages ?? []) {
      const li = element('li', undefined, list);
      li.textContent = String(stage.id) + ' · ' + text('change.' + stage.change);
    }
    for (const id of checked.preview?.removed ?? []) {
      const li = element('li', undefined, list);
      li.textContent = String(id) + ' · ' + text('change.removed');
    }
    for (const problem of checked.problems ?? []) {
      const li = element('li', undefined, list);
      li.className = 'warn';
      li.textContent = (problem.stage ? String(problem.stage) + ' · ' : '') + detailed(problem.code, problem.detail);
    }
    const confirm = button(
      e,
      'confirmPipeline',
      async () => {
        const current = confirmation;
        if (!current) return;
        confirmation = null;
        confirm.remove();
        notice(text('actionPending'));
        const done = await call('/confirm', { id: current.id, revision: current.revision });
        if (done.outcome === 'prepared' && done.facts?.written) {
          notice(text('pipelineWritten'));
          tellPipeline({
            state: 'written',
            problems: done.facts.problems,
            preview: done.facts.preview,
            written: { fileDigest: done.facts.fileDigest, digest: done.facts.digest, trust: done.facts.trust },
          });
        } else {
          notice(detailed(done.reasonCode || 'failed', done.facts?.detail), true);
          tellPipeline({
            state: 'refused',
            reasonCode: done.reasonCode,
            detail: done.facts?.detail,
            problems: done.facts?.problems,
          });
        }
      },
      true,
    );
    confirm.id = 'confirm';
    confirm.className = 'primary';
    writes();
    e.scrollIntoView({ block: 'nearest' });
  }
  function showPreview(answer: any) {
    const e = document.getElementById('preview')!;
    e.replaceChildren();
    if (answer.unavailable) {
      notice(text(answer.outcome.reasonCode || 'failed'), true);
      return;
    }
    notice(text('previewReady'));
    confirmation = answer.confirmation;
    const p = element('p', 'prepareSeparate', e);
    p.className = 'notice';
    element('p', 'effects', e);
    const list = element('ul', undefined, e);
    for (const effect of answer.preview.effects) {
      const li = element('li', undefined, list);
      li.textContent = String(effect);
    }
    if (answer.preview.action) {
      const target = element('p', undefined, e);
      target.textContent = text(answer.preview.action.slice(4)) + ' · ' + answer.preview.runId;
    }
    if (answer.preview.stages)
      for (const stage of answer.preview.stages) {
        const chip = element('span', undefined, e);
        chip.className = 'pill';
        chip.textContent = String(stage.stage);
      }
    // A start that calls models is one composite: the stages it runs and each model with its budget, confirmed once
    // here with one receipt for the start and one for each model's budget (ADR 48 as amended by U-3).
    if (answer.preview.composite) {
      const c = answer.preview.composite;
      element('p', 'compositeStart', e).className = 'notice';
      for (const stage of c.stages ?? []) {
        const chip = element('span', undefined, e);
        chip.className = 'pill';
        chip.textContent = String(stage);
      }
      const models = element('ul', undefined, e);
      for (const m of c.models ?? []) {
        const li = element('li', undefined, models);
        const b = m.budget ?? {};
        li.textContent =
          String(m.model ?? m.modelId) +
          ' · ' +
          String(m.runner ?? '') +
          ' · ' +
          text('budgetTokens').replace('{n}', String(b.maxTokens ?? '')) +
          (b.maxCost ? ' · ' + String(b.maxCost) + ' ' + String(b.currency ?? '') : '');
      }
    }
    const preparing = !!answer.preview.mode;
    const confirm = button(
      e,
      answer.preview.mode ? 'confirmPrepare' : 'confirmControl',
      async () => {
        const current = confirmation;
        if (!current) return;
        confirmation = null;
        confirm.remove();
        notice(text('actionPending'));
        const answer = await call('/confirm', { id: current.id, revision: current.revision });
        const accepted = ['submitted', 'requested', 'kept'].includes(answer.outcome);
        if (!accepted) notice(text(answer.reasonCode || 'failed'), true);
        else notice(text('actionAccepted'));
        await refresh();
        if (scanFlow && accepted && preparing) await continueScan();
        else scanFlow = false;
      },
      true,
    );
    confirm.id = 'confirm';
    confirm.className = 'primary';
    writes();
  }
  async function events() {
    while (!stopped && cap) {
      try {
        const event = await call('/events');
        if (event.challenge) {
          const context = await parentContext();
          await call('/ack', { id: event.challenge, view: context });
        }
      } catch (error) {
        connectionFailure(error);
        if (!stopped) await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  async function report(comparison = false) {
    const generation = ++reportGeneration,
      requestedRun = selectedRun,
      requestedBaseline = comparison ? baselineKey : null;
    const target = document.getElementById('report-text')!;
    target.textContent = '';
    target.removeAttribute('data-format-digest');
    const delivery = await call('/report', {
        runId: requestedRun,
        comparison,
        ...(comparison ? { baselineKey: requestedBaseline } : {}),
      }),
      parts: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await call('/delivery', { deliveryId: delivery.deliveryId, offset });
      const bytes = Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0));
      parts.push(bytes);
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    const bytes = new Uint8Array(delivery.formatBytes);
    let pos = 0;
    for (const part of parts) {
      bytes.set(part, pos);
      pos += part.length;
    }
    const digest =
      'sha256:' +
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    if (pos !== bytes.length || digest !== delivery.formatDigest) throw Error('digest');
    if (
      generation !== reportGeneration ||
      selectedRun !== requestedRun ||
      (comparison && baselineKey !== requestedBaseline)
    )
      return;
    target.textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    target.setAttribute('data-format-digest', digest);
  }
  async function main() {
    words = await (await fetch('/words.json', { credentials: 'omit', cache: 'no-store' })).json();
    root.replaceChildren();
    element('h1', 'title', root);
    const message = element('p', 'pairing', root);
    message.id = 'message';
    message.className = 'notice';
    if (parent === window) {
      notice(text('notParent'), true);
      return;
    }
    const initial = await parentContext();
    let secret = launchCode,
      kind = 'launch';
    if (!secret) {
      secret = sessionStorage.getItem('sentinel-owner-reload');
      kind = 'reload';
    }
    if (!secret) {
      location.replace('/bootstrap');
      return;
    }
    const active = await call('/session', { kind, secret, view: initial });
    cap = active.capability;
    launchCode = null;
    // eslint-disable-next-line no-useless-assignment -- Clear the bootstrap secret from the startup scope captured by later event handlers.
    secret = null;
    readOnly = active.readOnly;
    processSupported = active.processInspection === true;
    sessionStorage.setItem('sentinel-owner-reload', active.reloadToken);
    void handPass().catch(() => {});
    notice('');
    const readonly = element('p', 'readOnly', root);
    readonly.id = 'readonly';
    readonly.className = 'notice';
    const status = section('runControls'),
      state = element('div', undefined, status);
    state.id = 'status';
    status.id = 'run-controls';
    button(status, 'refresh', refresh);
    for (const phase of ['bootstrap', 'analysis'])
      button(status, phase, async () => {
        inspectPhase = phase;
        await refresh();
      });
    for (const action of ['start', 'pause', 'cancel']) {
      const actionButton = button(
        status,
        action,
        async () => {
          notice(text('previewPending'));
          showPreview(await call('/control-preview', { action }));
        },
        true,
      );
      actionButton.setAttribute('data-requires-run', '');
      actionButton.dataset.action = action;
      if (action === 'start') actionButton.className = 'primary';
    }
    for (const name of ['works', 'attempts', 'inputs', 'outputs'])
      button(status, name, async () => {
        collection = name;
        await page(true);
      });
    const rows = element('div', undefined, status);
    rows.id = 'rows';
    rows.className = 'scroll';
    const more = button(status, 'more', async () => page(false));
    more.id = 'more';
    more.disabled = true;
    const config = section('config');
    element('p', 'prepareSeparate', config);
    const models = element('label', 'models', config),
      select = element('select', undefined, models) as HTMLSelectElement;
    const option = element('option', 'deterministic', select);
    option.setAttribute('value', 'deterministic');
    select.disabled = true;
    element('p', 'modelReadOnly', config);
    element('p', 'configurationCli', config);
    element('p', 'hostedPaused', config);
    element('p', 'instructions', config);
    const save = button(config, 'save', async () => {});
    save.disabled = true;
    save.title = text('saveUnavailable');
    button(config, 'preview', async () => showPreview(await call('/preview')), true);
    button(config, 'linked', async () => showPreview(await call('/preview', { linked: true })), true).setAttribute(
      'data-requires-terminal',
      '',
    );
    const preview = element('div', undefined, config);
    preview.id = 'preview';
    const runs = section('runs');
    button(runs, 'runsRefresh', runList);
    const choices = element('label', 'chooseRun', runs),
      runChoice = element('select', undefined, choices) as HTMLSelectElement;
    runChoice.id = 'run-choice';
    runChoice.addEventListener(
      'change',
      () =>
        void run(async () => {
          if (!runChoice.value) return;
          reportGeneration++;
          const report = document.getElementById('report-text')!;
          report.textContent = '';
          report.removeAttribute('data-format-digest');
          await call('/select', { key: runChoice.value });
          await refresh();
        }),
    );
    button(runs, 'followPreparation', async () => {
      reportGeneration++;
      const report = document.getElementById('report-text')!;
      report.textContent = '';
      report.removeAttribute('data-format-digest');
      await call('/select', { key: null });
      await refresh();
    });
    const note = element('div', undefined, runs);
    note.id = 'run-note';
    const baselineLabel = element('label', 'baseline', runs),
      baselineChoice = element('select', undefined, baselineLabel) as HTMLSelectElement;
    baselineChoice.id = 'baseline-choice';
    baselineChoice.addEventListener(
      'change',
      () =>
        void run(async () => {
          reportGeneration++;
          baselineKey = baselineChoice.value || null;
          const report = document.getElementById('report-text')!;
          report.textContent = '';
          report.removeAttribute('data-format-digest');
          await call('/baseline', { key: baselineKey });
          writes();
        }),
    );
    const process = section('process');
    button(process, 'processRefresh', graph);
    const processGraph = element('div', undefined, process);
    processGraph.id = 'process-graph';
    const processDetails = element('div', undefined, process);
    processDetails.id = 'process-details';

    const reports = section('reportTitle');
    button(reports, 'report', () => report(false)).id = 'total-report';
    const differential = button(reports, 'comparisonReport', () => report(true));
    differential.id = 'comparison-report';
    const content = element('pre', undefined, reports);
    content.id = 'report-text';
    writes();
    void events();
    if (processSupported) await runList();
    await refresh();
    setInterval(() => {
      if (!polling && !sessionLost) {
        polling = true;
        void refresh()
          .catch(() => {
            /* refresh already displays the fixed connection notice. */
          })
          .finally(() => (polling = false));
      }
    }, 2000);
  }
  window.addEventListener('pagehide', () => {
    stopped = true;
  });
  void run(main);
}
export function ownerUiScript() {
  return `(${browserMain.toString()})(${processLayout.toString()});`;
}
