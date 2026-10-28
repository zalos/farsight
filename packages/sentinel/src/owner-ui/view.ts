// The owner frame (ADR 48, the owner-panel retirement): the paired confirmation panel inside Farsight's Sentinel view,
// on the companion's own origin. It pairs, hands its parent the read pass, and previews and confirms what the parent
// asks for — a scan, a run's start, pause or cancel, a pipeline write — and nothing else: reading scans, stages,
// reports and the pipeline is the viewer surface's (packages/server/public/app/surfaces/sentinel.js).
// Static trusted browser code only. Every source-derived value is assigned as text; no scanned HTML executes.
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function ownerUiHtml(parent: string, instance: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body data-parent="${escape(parent)}" data-instance="${escape(instance)}"><main id="owner-ui" aria-live="polite"></main><script src="/client.js" defer></script></body></html>`;
}
export function ownerUiRecoveryHtml(title: string, explanation: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/style.css"></head><body><main><section role="alert"><h1>${escape(title)}</h1><p>${escape(explanation)}</p></section></main></body></html>`;
}
export const ownerUiCss = `:root{color-scheme:dark;--bg:#0a0d14;--panel:#111623;--text:#e7edf5;--muted:#a9b5c7;--line:#344052;--accent:#5bc8dd}body[data-theme=light]{color-scheme:light;--bg:#f4f6fa;--panel:#fff;--text:#192538;--muted:#46566d;--line:#c4ccda;--accent:#176d83}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:20px}h1,h2{font-family:"Avenir Next Condensed",system-ui,sans-serif}h1{margin:0 0 12px}h2{font-size:19px;margin:0 0 12px}section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0}p{line-height:1.5;color:var(--muted)}button,select{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:9px 12px;margin:4px 8px 4px 0}button{cursor:pointer}button.primary{border-color:var(--accent);color:var(--accent)}button:disabled,select:disabled{opacity:.55;cursor:not-allowed}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.notice{border-left:3px solid var(--accent);padding:10px 14px}.error{color:#e8a13c}.pill{display:inline-block;padding:4px 8px;border:1px solid var(--line);border-radius:12px;margin:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace}label{display:block}#message{min-height:24px}code{overflow-wrap:anywhere}@media(max-width:500px){main{padding:10px}section{padding:12px}button{width:100%;margin:5px 0}}li.warn{color:#e8a13c}`;
function browserMain() {
  const root = document.getElementById('owner-ui')!,
    parentOrigin = document.body.dataset.parent!,
    hostInstance = document.body.dataset.instance!,
    documentId = 'document-' + crypto.randomUUID().replace(/-/g, ''),
    frameNonce = 'frame-' + crypto.randomUUID().replace(/-/g, '');
  let launchCode = new URLSearchParams(location.hash.slice(1)).get('launch');
  history.replaceState(null, '', location.pathname);
  let connectionHealthy = true,
    sessionLost = false;
  let words: Record<string, any> = {},
    register = 'professional',
    cap = '',
    view: any = null,
    readOnly = true,
    stopped = false,
    confirmation: any = null;
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
      connectionHealthy = true;
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
  /** A confirmation is offered only on a live, writable view of a healthy session. */
  const writes = () => {
    const writable = connectionHealthy && !sessionLost && view?.mode === 'live' && view?.sync === null && !readOnly;
    for (const e of document.querySelectorAll<HTMLButtonElement>('button[data-effect]')) e.disabled = !writable;
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
  const RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  // What the parent page may ask of this panel: a read pass, a scan, a run control, a pipeline check. Each is only a
  // request: this panel previews it and the owner confirms it here, or nothing happens.
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      !event.data ||
      ![
        'sentinel-owner-read-request',
        'sentinel-owner-scan',
        'sentinel-owner-control',
        'sentinel-owner-pipeline',
        'sentinel-owner-pipeline-withdraw',
      ].includes(event.data.type) ||
      event.data.frameNonce !== frameNonce ||
      event.data.documentId !== documentId
    )
      return;
    if (event.data.type === 'sentinel-owner-read-request') {
      void handPass().catch(() => {});
      return;
    }
    if (!cap || sessionLost) return;
    if (event.data.type === 'sentinel-owner-scan')
      // The parent's Scan button: preview a fresh capture for the owner's confirmation, then the start it prepared.
      void run(async () => {
        scanFlow = true;
        notice(text('previewPending'));
        showPreview(await call('/preview'));
      });
    else if (event.data.type === 'sentinel-owner-control') {
      // The parent's Start, Pause or Cancel on one scan, by its run id: previewed here, confirmed here.
      const { action, runId } = event.data;
      if (!['start', 'pause', 'cancel'].includes(action) || typeof runId !== 'string' || !RUN.test(runId)) return;
      void run(async () => {
        scanFlow = false;
        notice(text('previewPending'));
        showPreview(await call('/control-preview', { action, runId }));
      });
    } else if (event.data.type === 'sentinel-owner-pipeline-withdraw') withdrawPipeline();
    else {
      // The parent's edited pipeline: this panel has the service check it and preview it, and the owner confirms the
      // write here. What comes back to the parent is the service's answer, never a capability or a receipt.
      const { pipeline, expectDigest, draftDigest } = event.data;
      if (
        !pipeline ||
        typeof pipeline !== 'object' ||
        Array.isArray(pipeline) ||
        !(expectDigest === null || (typeof expectDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(expectDigest))) ||
        typeof draftDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(draftDigest)
      )
        return;
      void run(async () => {
        notice(text('pipelineChecking'));
        withdrawPipeline(false);
        // this check's own token: a withdrawal or any newer check — even of the same bytes — drops its answer
        const token = ++checkSeq;
        pendingCheck = token;
        try {
          // The page names the draft by the digest of the bytes it would write; the panel confirms exactly those.
          if ((await textDigest(JSON.stringify(pipeline, null, 2) + '\n')) !== draftDigest)
            throw Object.assign(Error('changed'), { code: 'sentinel.ownerUi.changed' });
          const answer = await call('/pipeline-preview', { pipeline, expectDigest });
          if (pendingCheck !== token) return;
          pendingCheck = 0;
          showPipeline(answer, draftDigest);
        } catch (error: any) {
          if (pendingCheck !== token) return;
          pendingCheck = 0;
          tellPipeline({ state: 'failed', reasonCode: error?.code ?? 'sentinel.ownerUi.failed', draftDigest });
          throw error;
        }
      });
    }
  });
  let scanFlow = false;
  /** After a Scan's preparation is confirmed: wait for it to be prepared, then preview its start. */
  async function continueScan() {
    for (let i = 0; scanFlow && i < 240; i++) {
      const response = await call('/status');
      const phase = response.status?.found ? response.status.phase : null;
      if (phase === 'prepared') {
        scanFlow = false;
        showPreview(await call('/control-preview', { action: 'start' }));
        return;
      }
      if (['interrupted', 'failed', 'canceled'].includes(phase)) {
        notice(text(response.status?.reasonCode || 'failed'), true);
        break;
      }
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
  /** The sha256 of a text, as the page names a draft by the bytes it would write. */
  async function textDigest(value: string) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return 'sha256:' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  /** The draft a pipeline confirmation here is for; the page's later edit withdraws it. */
  let pipelineDraft: string | null = null,
    /** The check still out with the service, by its own token (0: none); its answer counts only while it is current. */
    pendingCheck = 0,
    checkSeq = 0;
  /** The page withdrew its check (an edit, a discard): a pending check is dropped and an offered confirmation goes. */
  function withdrawPipeline(say = true) {
    const had = pipelineDraft !== null || pendingCheck !== 0;
    pendingCheck = 0;
    if (pipelineDraft !== null) {
      pipelineDraft = null;
      confirmation = null;
      document.getElementById('preview')?.replaceChildren();
    }
    if (had && say) notice(text('pipelineWithdrawn'));
  }
  /** What the parent page may know of a pipeline check or write: the service's own answer, in its own words. */
  function tellPipeline(answer: {
    state: 'checked' | 'refused' | 'written' | 'failed';
    draftDigest: string;
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
        draftDigest: answer.draftDigest,
        reasonCode: typeof answer.reasonCode === 'string' ? answer.reasonCode : null,
        detail: typeof answer.detail === 'string' ? answer.detail.slice(0, 240) : null,
        problems: Array.isArray(answer.problems) ? answer.problems : [],
        preview: answer.preview && typeof answer.preview === 'object' ? answer.preview : null,
        written: answer.written && typeof answer.written === 'object' ? answer.written : null,
      },
      parentOrigin,
    );
  }
  /** Tells the parent the outcome of a confirmed run action, in the service's own words. */
  function tellAction(outcome: string | null, reasonCode: string | null) {
    parent.postMessage(
      { type: 'sentinel-owner-action-result', frameNonce, documentId, hostInstance, outcome, reasonCode },
      parentOrigin,
    );
  }
  function showPipeline(answer: any, draft: string) {
    const e = document.getElementById('preview')!;
    e.replaceChildren();
    // offered a confirmation, the answer is { preview: <the service's answer>, confirmation }; refused, it is the answer
    const checked = answer.confirmation ? answer.preview : answer;
    if (answer.unavailable || !answer.confirmation) {
      notice(detailed(checked.reasonCode || 'pipelineRefused', checked.detail), true);
      tellPipeline({
        state: 'refused',
        draftDigest: draft,
        reasonCode: checked.reasonCode,
        detail: checked.detail,
        problems: checked.problems,
        preview: checked.preview,
      });
      return;
    }
    tellPipeline({ state: 'checked', draftDigest: draft, problems: checked.problems, preview: checked.preview });
    notice(text('pipelineReady'));
    confirmation = answer.confirmation;
    pipelineDraft = draft;
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
        // a confirmation for exactly the draft the page checked; an edit there since withdrew it
        if (!current || pipelineDraft !== draft) return;
        confirmation = null;
        pipelineDraft = null;
        confirm.remove();
        notice(text('actionPending'));
        const done = await call('/confirm', { id: current.id, revision: current.revision });
        if (done.outcome === 'prepared' && done.facts?.written) {
          notice(text('pipelineWritten'));
          tellPipeline({
            state: 'written',
            draftDigest: draft,
            problems: done.facts.problems,
            preview: done.facts.preview,
            written: { fileDigest: done.facts.fileDigest, digest: done.facts.digest, trust: done.facts.trust },
          });
        } else {
          notice(detailed(done.reasonCode || 'failed', done.facts?.detail), true);
          tellPipeline({
            state: 'refused',
            draftDigest: draft,
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
      scanFlow = false;
      return;
    }
    notice(text('previewReady'));
    confirmation = answer.confirmation;
    if (answer.preview.mode) element('p', 'prepareSeparate', e).className = 'notice';
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
    // here with one receipt for the start and one for each model's budget (ADR 48, owner-panel amendment).
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
      preparing ? 'confirmPrepare' : 'confirmControl',
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
        tellAction(answer.outcome ?? null, answer.reasonCode ?? null);
        if (scanFlow && accepted && preparing) await continueScan();
        else scanFlow = false;
      },
      true,
    );
    confirm.id = 'confirm';
    confirm.className = 'primary';
    writes();
    e.scrollIntoView({ block: 'nearest' });
  }
  async function events() {
    while (!stopped && cap) {
      try {
        const event = await call('/events');
        if (event.challenge) {
          const context = await parentContext();
          await call('/ack', { id: event.challenge, view: context });
        }
        if (!connectionHealthy && !sessionLost) {
          connectionHealthy = true;
          notice('');
          writes();
        }
      } catch (error) {
        connectionFailure(error);
        if (!stopped) await new Promise((r) => setTimeout(r, 1000));
      }
    }
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
    sessionStorage.setItem('sentinel-owner-reload', active.reloadToken);
    void handPass().catch(() => {});
    notice(text('confirmHere'));
    const readonly = element('p', 'readOnly', root);
    readonly.id = 'readonly';
    readonly.className = 'notice';
    const preview = element('div', undefined, root);
    preview.id = 'preview';
    writes();
    void events();
  }
  window.addEventListener('pagehide', () => {
    stopped = true;
  });
  void run(main);
}
export function ownerUiScript() {
  return `(${browserMain.toString()})();`;
}
