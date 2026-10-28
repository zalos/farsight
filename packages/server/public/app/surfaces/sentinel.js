// Display/navigation only. This host never receives an owner capability, reload token, nonce or receipt.
import { t } from '../strings.js';
import { S } from '../store.js';
let frame = null,
  origin = null,
  revision = 1,
  child = null,
  container = null;
function context() {
  const session = S.VERSION?.session,
    sync = location.hash.match(/@sync:([1-9][0-9]*)/);
  return {
    frameNonce: child.frameNonce,
    documentId: child.documentId,
    revision,
    hostInstance: session?.instance,
    mode:
      !frame || !session || typeof session.readOnly !== 'boolean'
        ? 'unavailable'
        : sync
          ? 'historical'
          : session.readOnly
            ? 'unavailable'
            : 'live',
    sync: sync ? Number(sync[1]) : null,
  };
}
function presentation() {
  return {
    theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    register: localStorage.getItem('fs-register') === 'hud' ? 'hud' : 'professional',
  };
}
function post(id) {
  if (!frame?.contentWindow || !origin || !child) return;
  frame.contentWindow.postMessage(
    {
      type: 'sentinel-owner-context',
      id,
      frameNonce: child.frameNonce,
      documentId: child.documentId,
      context: context(),
      presentation: presentation(),
    },
    origin,
  );
}
function message(event) {
  if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
  const v = event.data;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'documentId,frameNonce,hostInstance,id,type' ||
    v.type !== 'sentinel-owner-context-request' ||
    typeof v.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.id) ||
    typeof v.frameNonce !== 'string' ||
    !/^frame-[a-f0-9]{32}$/.test(v.frameNonce) ||
    typeof v.documentId !== 'string' ||
    !/^document-[a-f0-9]{32}$/.test(v.documentId) ||
    v.hostInstance !== S.VERSION?.session?.instance
  )
    return;
  if (!child || child.documentId !== v.documentId || child.frameNonce !== v.frameNonce) {
    child = { documentId: v.documentId, frameNonce: v.frameNonce };
    revision = 1;
  }
  post(v.id);
}
window.addEventListener('message', message);
new MutationObserver(() => post(null)).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});
window.addEventListener('hashchange', () => {
  if (frame && child) {
    revision++;
    post(null);
  }
});
export async function mountSentinel(_route, el) {
  container = el;
  const heading = document.createElement('h1');
  heading.textContent = t('nav.sentinel');
  el.append(heading);
  const note = document.createElement('p');
  note.textContent = t('sentinel.ownerUi.pairing');
  el.append(note);
  const reconnect = document.createElement('button');
  reconnect.textContent = t('sentinel.ownerUi.reconnect');
  reconnect.addEventListener('click', () => location.reload());
  el.append(reconnect);
  try {
    const response = await fetch('/api/sentinel/companion', { cache: 'no-store' }),
      value = await response.json();
    if (container !== el) return;
    if (!value.available || typeof value.ownerOrigin !== 'string') {
      note.textContent = t('sentinel.ownerUi.launch');
      return;
    }
    const u = new URL(value.ownerOrigin);
    if (
      u.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.origin !== value.ownerOrigin ||
      !u.port
    )
      throw Error();
    if (document.body.dataset.sentinelOwnerOrigin !== u.origin) {
      note.textContent = t('sentinel.ownerUi.reconnect');
      return;
    }
    origin = u.origin;
    frame = document.createElement('iframe');
    frame.title = t('nav.sentinel');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    frame.src = origin + '/frame';
    frame.style.cssText = 'width:100%;height:calc(100vh - 180px);min-height:600px;border:0;border-radius:10px';
    el.append(frame);
    note.remove();
  } catch {
    note.textContent = t('sentinel.ownerUi.hostUnavailable');
  }
}
export function sentinelUpdate() {
  if (frame && child) {
    revision++;
    post(null);
  }
}
export function unmountSentinel() {
  if (frame && child) {
    revision++;
    const old = frame;
    frame = null;
    old.contentWindow?.postMessage(
      {
        type: 'sentinel-owner-context',
        id: null,
        frameNonce: child.frameNonce,
        documentId: child.documentId,
        context: { ...context(), mode: 'unavailable', sync: null },
        presentation: presentation(),
      },
      origin,
    );
  }
  frame = null;
  child = null;
  origin = null;
  container = null;
}
