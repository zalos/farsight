// surfaces/sentinel.js — the Sentinel ladder: SCANS · PIPELINE · STAGE (Sentinel v2 §4, lane L-UX U-2).
//
// The same shape as the Map: a chrome that holds still (row 1 the five stops, the LAYOUT slot and the tools; row 2 the
// crumb and the verdict chips), the stop drawn under it, one dock on the right. ENTRY POINTS and PATH are drawn greyed,
// *not yet built*. Every number arrives as a Counted from the read model and prints with its tip (lib/counted.js).
//
// Where the data comes from (ADR 18: Farsight's server imports no Sentinel code): Sentinel's own loopback companion
// serves the read model (packages/sentinel/src/transport/http/). This page reads it cross-origin with a **read pass**
// the paired owner frame hands it after the frame's own launch pairing — a pass that reads retained scans and nothing
// else. This host never receives the owner capability, a reload token or a receipt: writes stay in the frame, which
// is the owner panel the dock shows when the reader presses Scan (the existing browser preview-and-confirm flow).
//
// The PIPELINE stop's edit mode (`#/sentinel?edit=1`, lane L-UX U-3) edits the workspace's declared pipeline as plain
// data in this page (lib/sentinel-editor-model.js) and hands the whole object to the paired frame, which has the owner
// service check and preview it and asks the owner to confirm the write there. The page learns the service's answer
// (problems by stage, what would rerun, written or not) and nothing that confirms: adoption stays the owner CLI's.
import { t, def } from '../strings.js';
import { S, esc, currentLens } from '../store.js';
import { tipAttrs, registerTip, sourceText } from '../lib/tooltip.js';
import { countedHtml, defAttrs } from '../lib/counted.js';
import { readOnlyWhy } from '../lib/read-only.js';
import {
  SENTINEL_STOPS,
  SENTINEL_LAYOUTS,
  sentinelPlace,
  sentinelHash,
  durationWords,
  bytesWords,
  costWords,
  statusClass,
  statusKey,
  reviewState,
  policyClass,
  kindChip,
  whereKey,
  shortDigest,
  imageWords,
  provenanceParts,
  ladderRows,
  pickedStage,
  cardOutputs,
  scanLive,
  scanState,
  doorState,
} from '../lib/sentinel-model.js';
import {
  STAGE_KINDS,
  STAGE_FIELDS,
  SHARED_FIELDS,
  editStage,
  changeKind,
  addStageAfter,
  removeStage,
  problemsByStage,
  changedStages,
  choiceKey,
  stageName,
  pipelineText,
} from '../lib/sentinel-editor-model.js';

/**
 * Whether a browser may start a scan, as the last read of the SCANS answer said it, bound to the companion and the
 * host session it was read under and to when: `{ action, origin, instance, at }`. The Settings door goes live only
 * after it has checked again that this same companion is still there and this same session still runs (the SCANS
 * stop re-reads the answer before any press). A companion lost or a session changed forgets it.
 */
let lastScanAction = null;
const SCAN_ACTION_TTL_MS = 10 * 60 * 1000;
function rememberScanAction(action) {
  if (action && SN.origin)
    lastScanAction = { action, origin: SN.origin, instance: S.VERSION?.session?.instance ?? null, at: Date.now() };
}
function forgetScanAction() {
  lastScanAction = null;
}

const SN = {
  el: null,
  /** the companion's origin, once `/api/sentinel/companion` named one and the page was served to frame it */
  origin: null,
  companion: false,
  /**
   * When this server has no companion under the origin the page was opened at, but has one for the same port under
   * the other loopback spelling (`localhost` ⇄ `127.0.0.1`): that origin, to send the reader there. Never framed.
   */
  pairedWith: null,
  frame: null,
  /** the frame's identity, learned from its context request */
  child: null,
  revision: 1,
  /** the frame's mode and sync the revision was last raised for */
  mode: null,
  sync: null,
  pass: null,
  passWaiters: [],
  place: null,
  scans: null,
  scan: null,
  stage: null,
  /** the check or review the STAGE stop has open (the read model's unit answer) */
  unit: null,
  error: null,
  loading: false,
  timer: null,
  dockTab: 'stage',
  generation: 0,
  /** the edit mode: the read model's pipeline answer, the edited copy (null until a field changes), the file digest
   * the edit started from, and the frame's last answer for it */
  config: null,
  draft: null,
  draftBase: undefined,
  check: null,
  checking: false,
};

// ── the owner frame: pairing, the read pass, and the confirmations it alone can make ─────────────────────────────

function context() {
  const session = S.VERSION?.session,
    sync = location.hash.match(/@sync:([1-9][0-9]*)/);
  return {
    frameNonce: SN.child.frameNonce,
    documentId: SN.child.documentId,
    revision: SN.revision,
    hostInstance: session?.instance,
    mode:
      !SN.frame || !session || typeof session.readOnly !== 'boolean'
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
  if (!SN.frame?.contentWindow || !SN.origin || !SN.child) return;
  SN.frame.contentWindow.postMessage(
    {
      type: 'sentinel-owner-context',
      id,
      frameNonce: SN.child.frameNonce,
      documentId: SN.child.documentId,
      context: context(),
      presentation: presentation(),
    },
    SN.origin,
  );
}
const HEX64 = /^[a-f0-9]{64}$/;
function fromFrame(event) {
  return !!SN.frame && event.source === SN.frame.contentWindow && event.origin === SN.origin;
}
function message(event) {
  if (!fromFrame(event)) return;
  const v = event.data;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return;
  if (v.type === 'sentinel-owner-read') {
    // A read pass, from the exact paired frame this page answered: it reads retained scans and nothing else.
    if (
      Object.keys(v).sort().join(',') !== 'documentId,expiresAt,frameNonce,hostInstance,pass,type' ||
      !SN.child ||
      v.frameNonce !== SN.child.frameNonce ||
      v.documentId !== SN.child.documentId ||
      v.hostInstance !== S.VERSION?.session?.instance ||
      typeof v.pass !== 'string' ||
      !HEX64.test(v.pass)
    )
      return;
    const first = !SN.pass;
    SN.pass = v.pass;
    SN.passWaiters.splice(0).forEach((w) => w(v.pass));
    if (first) void load();
    return;
  }
  if (v.type === 'sentinel-owner-action-result') {
    // A run action the owner confirmed in the panel: read the scans again, whatever the outcome.
    if (
      SN.child &&
      v.frameNonce === SN.child.frameNonce &&
      v.documentId === SN.child.documentId &&
      v.hostInstance === S.VERSION?.session?.instance
    )
      void load();
    return;
  }
  if (v.type === 'sentinel-owner-pipeline-result') {
    // The service's answer for the pipeline this page handed the frame: problems, what would rerun, written or not.
    if (
      !SN.child ||
      v.frameNonce !== SN.child.frameNonce ||
      v.documentId !== SN.child.documentId ||
      v.hostInstance !== S.VERSION?.session?.instance ||
      !['checked', 'refused', 'written', 'failed'].includes(v.state)
    )
      return;
    void pipelineResult(v);
    return;
  }
  if (
    Object.keys(v).sort().join(',') !== 'documentId,frameNonce,hostInstance,id,type' ||
    v.type !== 'sentinel-owner-context-request' ||
    typeof v.id !== 'string' ||
    !HEX64.test(v.id) ||
    typeof v.frameNonce !== 'string' ||
    !/^frame-[a-f0-9]{32}$/.test(v.frameNonce) ||
    typeof v.documentId !== 'string' ||
    !/^document-[a-f0-9]{32}$/.test(v.documentId) ||
    v.hostInstance !== S.VERSION?.session?.instance
  )
    return;
  if (!SN.child || SN.child.documentId !== v.documentId || SN.child.frameNonce !== v.frameNonce) {
    SN.child = { documentId: v.documentId, frameNonce: v.frameNonce };
    SN.revision = 1;
    const now = context();
    SN.mode = now.mode;
    SN.sync = now.sync;
  }
  post(v.id);
}
window.addEventListener('message', message);
new MutationObserver(() => post(null)).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

/** A fresh read pass from the frame (the old one expired or was replaced). */
function askPass() {
  return new Promise((resolve, reject) => {
    if (!SN.frame?.contentWindow || !SN.child) {
      reject(Object.assign(Error('pass'), { code: 'sentinel.viewer.notPaired' }));
      return;
    }
    const timer = setTimeout(() => reject(Object.assign(Error('pass'), { code: 'sentinel.viewer.notPaired' })), 8000);
    SN.passWaiters.push((pass) => {
      clearTimeout(timer);
      resolve(pass);
    });
    SN.frame.contentWindow.postMessage(
      { type: 'sentinel-owner-read-request', frameNonce: SN.child.frameNonce, documentId: SN.child.documentId },
      SN.origin,
    );
  });
}

/** One read of the read model; an expired pass is renewed once. */
async function read(path, again = true) {
  if (!SN.pass) throw Object.assign(Error('pass'), { code: 'sentinel.viewer.notPaired' });
  const r = await fetch(SN.origin + '/api/sentinel/' + path, {
    headers: { authorization: 'Bearer ' + SN.pass },
    cache: 'no-store',
    credentials: 'omit',
  });
  if (r.status === 401 && again) {
    await askPass();
    return read(path, false);
  }
  const value = await r.json();
  // The owner panel's view moved between the read and its context (a theme or a register switch): read once more.
  if (!r.ok && again && ['sentinel.ownerUi.changed', 'sentinel.ownerUi.readOnly'].includes(value.error)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return read(path, false);
  }
  if (!r.ok) throw Object.assign(Error(value.error || 'read'), { code: value.error });
  return value;
}

// ── the stops' data ───────────────────────────────────────────────────────────────────────────────────────────────

async function load() {
  if (!SN.el || !SN.pass) return;
  const place = SN.place,
    gen = ++SN.generation;
  clearTimeout(SN.timer);
  SN.loading = true;
  draw();
  try {
    const at = place.scan ? 'scans/' + encodeURIComponent(place.scan) : '';
    if (place.edit) SN.config = await read('pipeline');
    else if (place.stop === 'scans') {
      SN.scans = await read(place.before ? 'scans/before/' + place.before : 'scans');
      if (SN.scans?.scanAction) rememberScanAction(SN.scans.scanAction);
    } else if (place.stop === 'pipeline') SN.scan = await read(at);
    else {
      const stageAt = at + '/stages/' + encodeURIComponent(place.stage);
      const [scan, stage] = await Promise.all([read(at), read(stageAt)]);
      SN.scan = scan;
      SN.stage = stage;
      // The open check or review, read on its own: its tries, what ran, what it left and every exchange's words.
      const k = Math.min(Math.max(place.unit || 1, 1), stage.units.length || 1);
      SN.unit = stage.units.length ? await read(stageAt + '/units/' + k) : null;
    }
    if (place.stop !== 'scans' && !SN.scans) SN.scans = await read('scans').catch(() => null);
    if (SN.scans?.scanAction) rememberScanAction(SN.scans.scanAction);
    SN.error = null;
  } catch (e) {
    SN.error = (e && e.code) || 'sentinel.ownerUi.failed';
    // what the failed read was for is not drawn from an older answer
    if (place.stop === 'stage') {
      SN.stage = null;
      SN.unit = null;
    }
    if (place.stop !== 'scans') SN.scan = SN.scan && SN.scan.scan.id === place.scan ? SN.scan : null;
  }
  if (gen !== SN.generation) return;
  SN.loading = false;
  draw();
  // A door asked for a scan (`#/sentinel?do=scan`): once, and only through the same greyed-or-not Scan button.
  if (place.act === 'scan' && place.stop === 'scans' && SN.scans) {
    history.replaceState(null, '', sentinelHash({}));
    SN.place = sentinelPlace(location.hash);
    const button = SN.el?.querySelector('.snt-scan');
    if (button) scan(button);
  }
  // A scan still moving is read again: the ladder fills in as it runs.
  const row = place.edit ? null : place.stop === 'scans' ? SN.scans?.scans?.find(scanLive) : SN.scan?.scan;
  if (row && scanLive(row) && !SN.error) SN.timer = setTimeout(() => void load(), 2000);
}

// ── drawing ───────────────────────────────────────────────────────────────────────────────────────────────────────

const API = '/api/sentinel';
const lensNow = () => currentLens();
const biz = () => lensNow() === 'business';
const chip = (cls, words, tip) =>
  '<span class="snt-chip ' + esc(cls || '') + '"' + (tip || '') + '>' + words + '</span>';
const word = (key) => esc(t(key));
const keyChip = (cls, key, extra = '') => chip(cls, word(key) + extra, defAttrs(key));
const cnt = (c, opts) => countedHtml(c, API, opts);
/** A size: the reader's words (`5.4 KiB`), the exact count and its scope in the tip; outside business only. */
const bytesHtml = (c) => (c && !biz() ? cnt(c, { words: bytesWords(c.n) }) : '');
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t(key));
function whenWords(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toISOString().slice(0, 10),
    today = new Date().toISOString().slice(0, 10);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (day === today ? t('sentinel.viewer.when.today') : day) + ' ' + hm;
}

/**
 * A measure's tip (a duration, a price, a CPU share): the words shown, what it measures, the scope it is over and
 * where the read model took it from — a number's tip, for a quantity that is not a count.
 */
registerTip('sentinel-measure', (_el, a) => {
  const rows = [
    ['sentinel.viewer.tip.measures', a && a.define ? def(a.define) : ''],
    ['tip.scope', a && a.scope ? t(a.scope) : ''],
    ['tip.source', a ? sourceText(a.source) : ''],
  ].filter((r) => r[1]);
  return (
    '<div class="tip-h"><b class="tip-n">' +
    esc((a && a.words) || '') +
    '</b></div>' +
    (rows.length
      ? '<dl class="tip-dl">' +
        rows.map((r) => '<dt>' + word(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') +
        '</dl>'
      : '')
  );
});

/** The tip attributes of a measure the read model supplied with its `scope` and `source`. */
function measureAttrs(m, words, define) {
  // where it came from: the field it was read from is a developer's fact; the business lens names the record in words
  const source = biz()
    ? { api: '', sync: null, note: 'sentinel.viewer.source.store' }
    : { api: API, sync: null, note: m.source || 'sentinel.viewer.source.store' };
  return tipAttrs({ id: 'sentinel-measure', args: { words, define, scope: m.scope, source }, noFocus: true });
}

function costHtml(cost) {
  if (!cost) return '';
  const w = costWords(cost);
  const words = (w.amount ? w.amount + ' · ' : '') + t(w.key);
  return '<span class="snt-cost"' + measureAttrs(cost, words, w.key) + '>' + esc(words) + '</span>';
}

function durationHtml(d, define = 'sentinel.viewer.measure.duration') {
  if (!d) return '';
  const words = durationWords(d.ms);
  return '<span class="snt-dur"' + measureAttrs(d, words, define) + '>' + esc(words) + '</span>';
}

function statusChip(status, scan, extra = '') {
  return keyChip('snt-st ' + statusClass(status), statusKey(status, scan), extra);
}

/**
 * A review's chip: its work's status, except that finished work whose review the record calls unfinished says
 * *unfinished* with its turns (*3 of 3 turns*), and a stage whose reviews disagree says how many are unfinished.
 */
function outcomeChip(status, review, turns) {
  const said = reviewState(status, review && review.outcome);
  if (!said) return statusChip(status);
  if (said === 'mixed') return chip('snt-st warn', cnt(review.unfinished));
  return keyChip('snt-st warn', 'sentinel.viewer.review.unfinished') + (turns ? chip('plain', cnt(turns)) : '');
}

function chromeHtml() {
  const p = SN.place;
  const at = SENTINEL_STOPS.findIndex((s) => s.id === p.stop);
  const stops = SENTINEL_STOPS.map((s, i) => {
    const reach =
      s.built && (s.id === 'scans' || (s.id === 'pipeline' && (p.scan || p.edit)) || (s.id === 'stage' && p.stage));
    const tip = s.built ? defAttrs(s.key) : tipAttrs({ key: 'sentinel.viewer.stop.notBuilt', noFocus: true });
    return (
      '<button type="button" data-stop="' +
      s.id +
      '" class="' +
      (i === at ? 'on' : '') +
      '" aria-pressed="' +
      (i === at) +
      '"' +
      (reach ? '' : ' aria-disabled="true"') +
      tip +
      '>' +
      word(s.key) +
      '</button>'
    );
  }).join('');
  // the edit mode draws the pipeline file as its ladder only
  const usable = (l) => l.built && (!p.edit || l.id === 'ladder');
  const layouts = (SENTINEL_LAYOUTS[p.stop] || [])
    .map(
      (l) =>
        '<button type="button" data-layout="' +
        l.id +
        '" class="' +
        (l.id === p.layout ? 'on' : '') +
        '" aria-pressed="' +
        (l.id === p.layout) +
        '"' +
        (usable(l) ? '' : ' aria-disabled="true"') +
        (usable(l)
          ? defAttrs(l.key)
          : tipAttrs({
              key: l.built ? 'sentinel.viewer.edit.ladderOnly' : 'sentinel.viewer.stop.notBuilt',
              noFocus: true,
            })) +
        '>' +
        word(l.key) +
        '</button>',
    )
    .join('');
  const scan = scanState({
    readOnly: !!readOnlyWhy(),
    companion: SN.companion,
    paired: !!SN.pass,
    action: SN.scans?.scanAction,
  });
  return (
    '<div class="snt-row1">' +
    '<div class="map-lvls snt-stops" role="group" aria-label="' +
    word('sentinel.viewer.stops') +
    '">' +
    stops +
    '</div>' +
    '<span class="snt-label">' +
    word('sentinel.viewer.layout.label') +
    '</span>' +
    '<div class="map-lvls snt-layouts" role="group" aria-label="' +
    word('sentinel.viewer.layout.label') +
    '">' +
    layouts +
    '</div>' +
    '<div class="snt-tools">' +
    toolsHtml() +
    '<button type="button" class="map-tb snt-scan' +
    (scan.on ? ' primary' : '') +
    '" data-act="scan"' +
    (scan.on ? '' : ' aria-disabled="true"') +
    tipAttrs({ key: scan.why, noFocus: true }) +
    '>' +
    word('sentinel.viewer.tool.scan') +
    '</button>' +
    '<button type="button" class="map-tb" data-act="refresh"' +
    tipAttrs({ key: 'sentinel.viewer.tool.refresh', noFocus: true }) +
    '>' +
    word('sentinel.viewer.tool.refresh') +
    '</button>' +
    '</div></div>' +
    '<div class="snt-row2"><div class="snt-crumb">' +
    crumbHtml() +
    '</div><div class="snt-verdicts">' +
    verdictsHtml() +
    '</div></div>'
  );
}

function crumbHtml() {
  const p = SN.place;
  const ws = SN.scans?.workspace || SN.scan?.workspace || '';
  const sep = '<span class="snt-sep">›</span>';
  const dot = '<span class="snt-sep">·</span>';
  let h = ws ? '<b>' + esc(ws) + '</b>' : '';
  if (p.edit) {
    h += (h ? sep : '') + word('sentinel.viewer.edit.crumb');
    if (SN.config) {
      if (!biz()) h += dot + '<span class="mono">' + esc('.farsight/sentinel/pipeline.json') + '</span>';
      const trust = SN.config.trust === 'not-adopted' ? 'notAdopted' : SN.config.trust || 'missing';
      h += dot + keyChip(trust === 'adopted' ? 'ok' : 'warn', 'sentinel.viewer.edit.trust.' + trust);
      if (SN.draft) h += dot + keyChip('warn', 'sentinel.viewer.edit.draft');
    }
    return h;
  }
  if (p.stop === 'scans') {
    h += (h ? sep : '') + word('sentinel.viewer.crumb.scans');
    if (SN.scans) h += dot + cnt(SN.scans.counts.shown);
    return h;
  }
  const row = SN.scan?.scan?.id === p.scan ? SN.scan.scan : null;
  h +=
    (h ? sep : '') +
    '<a href="' +
    esc(sentinelHash({ scan: p.scan })) +
    '">' +
    esc(row ? fill('sentinel.viewer.crumb.scan', { n: row.number }) : t('sentinel.viewer.crumb.scans')) +
    '</a>';
  if (row) {
    h += dot + esc(whenWords(row.createdAt));
    if (!biz() && row.source?.commit)
      h +=
        dot +
        word('sentinel.viewer.crumb.source') +
        ' <span class="mono">' +
        esc(row.source.commit.slice(0, 8)) +
        (row.source.dirty ? '*' : '') +
        '</span>';
    // the planner's capability profile is an internal name (not the profile the pipeline came from): code only
    if (lensNow() === 'code')
      h += dot + word('sentinel.viewer.crumb.profile') + ' <span class="mono">' + esc(row.pipeline.profile) + '</span>';
    h += dot + cnt(row.counts.stages);
  }
  if (p.stop === 'stage' && SN.stage) {
    const st = SN.stage.stage;
    const k = kindChip(st.kind);
    h +=
      sep +
      esc(fill('sentinel.viewer.crumb.stage', { n: st.number, m: SN.scan?.stages?.length ?? st.number })) +
      ' <b>' +
      word(st.name) +
      '</b>' +
      dot +
      keyChip(k.cls, k.key);
  }
  return h;
}

function verdictsHtml() {
  if (SN.place.edit) {
    if (SN.checking) return keyChip('', 'sentinel.viewer.edit.checking');
    const c = SN.check;
    if (!c) return '';
    if (c.state === 'checked') return keyChip('ok', 'sentinel.viewer.edit.checked');
    if (c.state === 'written') return keyChip('ok', 'sentinel.viewer.edit.written');
    if (c.state === 'writtenEarlier') return keyChip('warn', 'sentinel.viewer.edit.writtenEarlier');
    return detailChip('err', c.reasonCode || 'sentinel.viewer.edit.refused', c.detail);
  }
  const row = SN.place.stop === 'scans' ? null : SN.scan?.scan;
  if (!row) return '';
  const c = row.counts;
  return (
    (c.coverage ? chip('', cnt(c.coverage)) : '') +
    (c.findings ? chip('warn', cnt(c.findings)) : '') +
    (c.modelObservations && c.agentic.n ? chip('k-agent', cnt(c.modelObservations)) : '') +
    keyChip(policyClass(row.policy.word), row.policy.word)
  );
}

function scansHtml() {
  const s = SN.scans;
  if (!s) return '';
  const head =
    '<h1 class="snt-h1">' +
    esc(fill('sentinel.viewer.scans.title', { w: s.workspace })) +
    '</h1><p class="snt-sub">' +
    word('sentinel.viewer.scans.sub') +
    '</p>';
  if (!s.scans.length) return head + '<div class="snt-empty">' + word('sentinel.viewer.scans.none') + '</div>';
  const rows = s.scans
    .map((r) => {
      const c = r.counts;
      const line2 = [
        cnt(c.stages),
        cnt(c.agentic),
        costHtml(r.cost),
        r.duration ? durationHtml(r.duration) : statusChip(r.state, true),
      ]
        .filter(Boolean)
        .join('<span class="snt-sep">·</span>');
      const meta = [esc(whenWords(r.createdAt))];
      if (!biz() && r.source?.commit) meta.push('<span class="mono">' + esc(r.source.commit.slice(0, 8)) + '</span>');
      if (r.parent?.number) meta.push(esc(fill('sentinel.viewer.scans.rerunOf', { n: r.parent.number })));
      return (
        '<a class="snt-scan-row" href="' +
        esc(sentinelHash({ scan: r.id })) +
        '"><span class="snt-num">#' +
        r.number +
        '</span><span class="snt-when">' +
        meta.join('<span class="snt-sep">·</span>') +
        '</span><span class="snt-v">' +
        (c.findings
          ? chip('warn', cnt(c.findings))
          : keyChip('', r.absent.findings || 'sentinel.viewer.absent.notRecorded')) +
        (c.modelObservations && c.agentic.n ? chip('k-agent', cnt(c.modelObservations)) : '') +
        keyChip(policyClass(r.policy.word), r.policy.word) +
        '</span><span class="snt-line2">' +
        line2 +
        '</span></a>'
      );
    })
    .join('');
  // The list pages backwards by scan number: older scans are a door, never silently dropped.
  const pages = [
    SN.place.before
      ? '<a class="map-tb" href="' +
        esc(sentinelHash({})) +
        '"' +
        defAttrs('sentinel.viewer.scans.newest') +
        '>' +
        word('sentinel.viewer.scans.newest') +
        '</a>'
      : '',
    s.page?.older
      ? '<a class="map-tb" href="' +
        esc(sentinelHash({ before: s.page.older })) +
        '"' +
        defAttrs('sentinel.viewer.scans.older') +
        '>' +
        word('sentinel.viewer.scans.older') +
        '</a>'
      : '',
  ].join('');
  return (
    head + '<div class="snt-scans">' + rows + '</div>' + (pages ? '<div class="snt-pages">' + pages + '</div>' : '')
  );
}

function ioHtml(stage) {
  const chipOf = (io) =>
    chip(
      'plain' + (io.key === 'sentinel.viewer.io.observations' && stage.kind === 'agent' ? ' k-agent' : ''),
      word(io.key) + (io.count ? ' (' + cnt(io.count, { words: String(io.count.n) }) + ')' : ''),
      defAttrs(io.key),
    );
  const ins = stage.reads.map(chipOf).join('');
  const outs = cardOutputs(stage.produces).map(chipOf).join('');
  return (
    '<div class="snt-io">' +
    (ins ? '<span class="snt-label">' + word('sentinel.viewer.io.in') + '</span>' + ins : '') +
    (outs ? '<span class="snt-label">' + word('sentinel.viewer.io.out') + '</span>' + outs : '') +
    '</div>'
  );
}

function cardHtml(stage, compact) {
  const k = kindChip(stage.kind);
  const prov = provenanceParts(stage, lensNow());
  const sel = pickedStage(SN.scan, SN.place.pick)?.id === stage.id;
  const counts = [
    stage.counts.findings ? chip('warn', cnt(stage.counts.findings)) : '',
    stage.counts.modelObservations ? chip('k-agent', cnt(stage.counts.modelObservations)) : '',
  ].join('');
  return (
    '<div class="snt-card ' +
    esc(k.cls) +
    (sel ? ' sel' : '') +
    (compact ? ' compact' : '') +
    '" data-stage="' +
    esc(stage.id) +
    '" tabindex="0" role="button" aria-label="' +
    esc(t(stage.name)) +
    '">' +
    '<div class="snt-nm">' +
    word(stage.name) +
    ' ' +
    keyChip(k.cls, k.key) +
    '</div>' +
    (prov.length ? '<div class="snt-prov">' + esc(prov.join(' · ')) + '</div>' : '') +
    '<div class="snt-stc">' +
    outcomeChip(stage.status, stage.review, stage.counts.turns) +
    durationHtml(stage.duration) +
    counts +
    (stage.cost.basis !== 'none' ? costHtml(stage.cost) : '') +
    '</div>' +
    ioHtml(stage) +
    '</div>'
  );
}

function ladderHtml() {
  const scan = SN.scan;
  if (!scan) return '';
  const rows = ladderRows(scan)
    .map((row) => {
      const st = row.find((s) => s.status === 'running') || row.find((s) => s.status === 'failed') || row[0];
      return (
        '<div class="snt-step ' +
        esc(statusClass(st.status)) +
        '"><div class="snt-rail"><span class="snt-n">' +
        row[0].number +
        (row.length > 1 ? '–' + row[row.length - 1].number : '') +
        '</span></div>' +
        (row.length > 1
          ? '<div class="snt-par" style="--cols:' +
            Math.min(row.length, 4) +
            '">' +
            row.map((s) => cardHtml(s, true)).join('') +
            '</div>'
          : cardHtml(row[0], false)) +
        '</div>'
      );
    })
    .join('');
  return (
    '<div class="snt-ladder">' +
    rows +
    '</div><div class="snt-foot">' +
    ['builtin', 'tool', 'agent']
      .map(
        (k) =>
          '<span class="snt-lg"><i class="snt-sw k-' + k + '"></i>' + word('sentinel.viewer.legend.' + k) + '</span>',
      )
      .join('') +
    '<span class="snt-foot-note">' +
    word('sentinel.viewer.legend.note') +
    '</span></div>'
  );
}

function pipelineTableHtml() {
  const scan = SN.scan;
  if (!scan) return '';
  const head = ['number', 'stage', 'kind', 'status', 'took', 'tries', 'findings', 'cost']
    .map((c) => '<th>' + word('sentinel.viewer.col.' + c) + '</th>')
    .join('');
  const rows = scan.stages
    .map((s) => {
      const k = kindChip(s.kind);
      return (
        '<tr data-stage="' +
        esc(s.id) +
        '" tabindex="0"><td>' +
        s.number +
        '</td><td>' +
        word(s.name) +
        '</td><td>' +
        keyChip(k.cls, k.key) +
        '</td><td>' +
        statusChip(s.status) +
        '</td><td>' +
        durationHtml(s.duration) +
        '</td><td>' +
        cnt(s.counts.attempts, { words: String(s.counts.attempts.n) }) +
        '</td><td>' +
        (s.counts.findings ? cnt(s.counts.findings, { words: String(s.counts.findings.n) }) : '') +
        '</td><td>' +
        costHtml(s.cost) +
        '</td></tr>'
      );
    })
    .join('');
  return '<table class="snt-table"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function kv(key, value) {
  return value ? '<dt' + defAttrs(key) + '>' + word(key) + '</dt><dd>' + value + '</dd>' : '';
}

const mono = (text) => '<span class="mono">' + esc(text) + '</span>';

/** A CPU share, in its words, with its scope's tip (a measure, not a count: it need not be whole). */
function measureHtml(m) {
  if (!m) return '';
  const words = fill(m.unit, { n: m.value });
  return '<span class="snt-dur"' + measureAttrs(m, words, m.unit) + '>' + esc(words) + '</span>';
}

/**
 * What one try ran, from its authenticated invocation record (code and hybrid registers only): the image actually
 * run, the command with host paths and tokens already scrubbed by the read model, the environment names (never
 * values) and the limits; or why there is none to show.
 */
function invocationKv(inv, absent) {
  if (!inv) return kv('sentinel.viewer.field.ran', word(absent || 'sentinel.viewer.absent.notRecorded'));
  const limits = inv.limits
    ? [
        bytesHtml(inv.limits.memory),
        measureHtml(inv.limits.cpus),
        cnt(inv.limits.processes),
        durationHtml(inv.limits.timeout, 'sentinel.viewer.measure.timeLimit'),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    kv('sentinel.viewer.field.ran', esc(fill('sentinel.viewer.dock.fromTry', { n: inv.attempt }))) +
    (inv.operation ? kv('sentinel.viewer.field.operation', mono(inv.operation)) : '') +
    (inv.image ? kv('sentinel.viewer.field.image', mono(imageWords(inv.image))) : '') +
    (inv.argv.length ? kv('sentinel.viewer.field.command', mono(inv.argv.join(' '))) : '') +
    (inv.environmentNames.length
      ? kv('sentinel.viewer.field.environment', mono(inv.environmentNames.join(', ')))
      : '') +
    kv('sentinel.viewer.field.limits', limits)
  );
}

function ioList(list) {
  return (
    list
      .map((io) =>
        chip(
          'plain',
          word(io.key) + (io.count ? ' (' + cnt(io.count, { words: String(io.count.n) }) + ')' : ''),
          defAttrs(io.key),
        ),
      )
      .join('') || '—'
  );
}

/** A runner's words: the editor's, with the HTTP runner named for where its model server was (here or hosted). */
function runnerKey(r) {
  return choiceKey('agentRunner', r.id === 'hosted-api' && r.local ? 'ollama' : r.id);
}

function stageDockHtml(stage) {
  if (!stage) return '<p class="snt-sub">' + word('sentinel.viewer.dock.pick') + '</p>';
  const p = stage.provenance;
  const k = kindChip(stage.kind);
  const code = !biz();
  const impl = p.implementation;
  // a model's id, a skill's name and a prompt's text are a developer's: the business register says what, not which
  const model =
    !p.model && !p.provider
      ? ''
      : !code
        ? word('sentinel.viewer.dock.aModel')
        : p.model
          ? esc(fill('sentinel.viewer.dock.modelWords', { a: p.model.requested || '—', b: p.model.reported || '—' }))
          : esc(p.provider.model);
  const tokens = [stage.counts.tokensIn, stage.counts.tokensOut]
    .filter(Boolean)
    .map((c) => cnt(c))
    .join(' · ');
  // a model stage's runner is the command line or service it ran through and how (the report's words); the adopted
  // provider entry it was bound to is an identifier, on its own row in the code registers
  const runner = p.runner
    ? word(runnerKey(p.runner)) +
      ' · ' +
      word(choiceKey('mode', p.runner.mode)) +
      (code ? ' <span class="mono">' + esc(p.runner.id) + '</span>' : '')
    : p.provider
      ? ''
      : code && impl.adapter
        ? esc(impl.adapter + (impl.version ? ' ' + impl.version : ''))
        : '';
  return (
    '<h2>' +
    word(stage.name) +
    '</h2><div class="snt-row">' +
    keyChip(k.cls, k.key) +
    outcomeChip(stage.status, stage.review, stage.counts.turns) +
    durationHtml(stage.duration) +
    chip('', esc(fill('sentinel.viewer.dock.position', { n: stage.number, m: SN.scan?.stages?.length ?? '' }))) +
    '</div><dl class="snt-kv">' +
    kv('sentinel.viewer.field.where', word(whereKey(p.where))) +
    kv('sentinel.viewer.field.runner', runner) +
    (code && p.provider
      ? kv('sentinel.viewer.field.provider', '<span class="mono">' + esc(p.provider.id) + '</span>')
      : '') +
    kv('sentinel.viewer.field.model', model) +
    (code && p.prompt
      ? kv(
          'sentinel.viewer.field.prompt',
          esc(p.prompt.name + ' · ' + fill('sentinel.viewer.dock.revision', { n: p.prompt.revision })) +
            ' <span class="mono">' +
            esc(shortDigest(p.prompt.digest)) +
            '…</span>',
        )
      : '') +
    (p.skills
      ? kv(
          'sentinel.viewer.field.skills',
          !p.skills.length
            ? word('sentinel.viewer.dock.noSkills')
            : code
              ? esc(p.skills.map((s) => s.name + '/' + s.revision).join(', '))
              : word('sentinel.viewer.dock.skillsGiven'),
        )
      : '') +
    kv('sentinel.viewer.field.turns', stage.counts.turns ? cnt(stage.counts.turns) : '') +
    (code ? kv('sentinel.viewer.field.tokens', tokens) : '') +
    kv('sentinel.viewer.field.cost', costHtml(stage.cost)) +
    kv('sentinel.viewer.field.tries', cnt(stage.counts.attempts)) +
    kv('sentinel.viewer.field.inputs', stage.counts.inputs.n ? cnt(stage.counts.inputs) : '') +
    kv('sentinel.viewer.field.inspected', stage.counts.inspected ? cnt(stage.counts.inspected) : '') +
    (code ? invocationKv(p.invocation, p.invocationAbsent) : '') +
    (code
      ? kv(
          'sentinel.viewer.field.implementation',
          '<span class="mono">' +
            esc(shortDigest(impl.digest)) +
            '…</span> ' +
            keyChip('', 'sentinel.viewer.registry.' + impl.registry),
        )
      : '') +
    (stage.heldBy ? kv('sentinel.viewer.field.held', word(stage.heldBy)) : '') +
    (stage.errors.length ? kv('sentinel.viewer.field.errors', stage.errors.map(word).join('<br>')) : '') +
    '</dl>' +
    '<h3>' +
    word('sentinel.viewer.field.read') +
    '</h3><div class="snt-row">' +
    ioList(stage.reads) +
    '</div><h3>' +
    word('sentinel.viewer.field.produced') +
    '</h3><div class="snt-row">' +
    ioList(stage.produces) +
    '</div>' +
    (stage.kind === 'agent' ? '<div class="snt-note">' + word('sentinel.viewer.dock.observationNote') + '</div>' : '') +
    '<div class="snt-acts">' +
    (SN.place.stop !== 'stage'
      ? '<a class="map-tb primary" href="' +
        esc(sentinelHash({ scan: SN.place.scan, stage: stage.id })) +
        '">' +
        word('sentinel.viewer.dock.open') +
        '</a>'
      : '<a class="map-tb" href="' +
        esc(sentinelHash({ scan: SN.place.scan, pick: stage.id })) +
        '">' +
        word('sentinel.viewer.dock.back') +
        '</a>') +
    '<button type="button" class="map-tb" aria-disabled="true"' +
    tipAttrs({ key: 'sentinel.viewer.dock.rerunCli', noFocus: true }) +
    '>' +
    word('sentinel.viewer.dock.rerun') +
    '</button></div>' +
    // a stage reruns as a linked child of the scan once the owner adopts the pipeline: from the owner CLI for now
    '<div class="snt-note">' +
    word('sentinel.viewer.dock.rerunCli') +
    (code
      ? '<pre class="snt-cli">farsight-sentinel pipeline adopt --confirm\nfarsight-sentinel rerun ' +
        esc(SN.place.scan || '') +
        ' --stage ' +
        esc(stage.id) +
        ' --confirm</pre>'
      : '') +
    '</div>'
  );
}

function placeWords(x) {
  if (biz() || !x.path) return '';
  return ' · <span class="mono">' + esc(x.path + (x.lines ? ':' + x.lines.join('–') : '')) + '</span>';
}

/** An exchange's retained words, verbatim and bounded (code and hybrid registers; the business register reads the gist). */
function wordsHtml(part) {
  if (!part || biz()) return '';
  return (
    '<details class="snt-words"><summary>' +
    word('sentinel.viewer.turn.words') +
    (part.truncated ? ' · ' + word('sentinel.viewer.turn.cut') : '') +
    '</summary><pre class="snt-pre">' +
    esc(part.text) +
    '</pre></details>'
  );
}

/** ` · ` and the part, or nothing when the part prints nothing in the register on screen. */
const andThen = (html) => (html ? ' · ' + html : '');

function turnHtml(turn) {
  const sent = turn.sent
    ? word(turn.sent.key) + andThen(cnt(turn.sent.files)) + placeWords(turn.sent)
    : word('sentinel.viewer.absent.notRecorded');
  const reply = turn.reply
    ? word(turn.reply.key) +
      placeWords(turn.reply) +
      (turn.reply.verdict && !biz() ? ' · ' + esc(turn.reply.verdict) : '') +
      andThen(cnt(turn.reply.claims))
    : word('sentinel.viewer.absent.notRecorded');
  const tok = (c) => (c && !biz() ? cnt(c) : '');
  return (
    '<div class="snt-turn"><div class="snt-who"><b>' +
    esc(fill('sentinel.viewer.turn.sentHead', { n: turn.number })) +
    '</b><span class="snt-tk">' +
    tok(turn.counts.tokensIn) +
    '</span></div><div class="snt-msg">' +
    sent +
    wordsHtml(turn.text?.sent) +
    '</div></div>' +
    '<div class="snt-turn model"><div class="snt-who"><b>' +
    esc(fill('sentinel.viewer.turn.replyHead', { n: turn.number })) +
    '</b><span class="snt-tk">' +
    tok(turn.counts.tokensOut) +
    '</span></div><div class="snt-msg">' +
    reply +
    wordsHtml(turn.text?.reply) +
    '</div></div>'
  );
}

/** What the open review's record concluded: its outcome with its turns, and the files the model read of those given. */
function reviewHeadHtml(step) {
  return (
    '<div class="snt-row">' +
    outcomeChip(step.status, step.review, step.counts.turns) +
    (reviewState(step.status, step.review.outcome)
      ? ''
      : step.counts.turns
        ? chip('plain', cnt(step.counts.turns))
        : '') +
    (step.counts.inspected ? chip('plain', cnt(step.counts.inspected)) : '') +
    '</div>'
  );
}

function reviewHtml(r) {
  const prompt = SN.stage.prompt;
  const promptHtml = prompt
    ? '<div class="snt-turn sys"><div class="snt-who"><b>' +
      word('sentinel.viewer.turn.system') +
      '</b>' +
      (!biz()
        ? '<span class="snt-tk">' +
          esc(prompt.name + '/' + prompt.revision + ' · ' + shortDigest(prompt.digest)) +
          '…</span>'
        : '') +
      '</div><div class="snt-msg">' +
      (biz()
        ? word('sentinel.viewer.turn.promptHidden')
        : prompt.text
          ? '<details><summary>' +
            word('sentinel.viewer.turn.readPrompt') +
            '</summary><pre class="snt-pre">' +
            esc(prompt.text) +
            '</pre></details>'
          : word('sentinel.viewer.absent.notRecorded')) +
      '</div></div>'
    : '';
  const obs = r.observations
    .map(
      (o) =>
        '<div class="snt-obs"><h4>' +
        esc(fill('sentinel.viewer.obs.head', { s: o.severity })) +
        '</h4><p>' +
        (biz() ? word('sentinel.viewer.obs.hidden') : esc(o.message)) +
        '</p><div class="snt-row">' +
        (biz()
          ? cnt(o.counts.citations)
          : o.citations.map((c) => chip('cite', esc(c.path + ' · ' + c.startByte + '–' + c.endByte))).join('')) +
        '</div></div>',
    )
    .join('');
  return (
    promptHtml +
    r.turns.map(turnHtml).join('') +
    obs +
    '<p class="snt-sub">' +
    word('sentinel.viewer.obs.note') +
    '</p>'
  );
}

function attemptsHtml(step) {
  const rows = step.attempts
    .map(
      (a) =>
        '<tr><td>' +
        a.ordinal +
        '</td><td>' +
        statusChip(a.state === 'succeeded' ? 'done' : a.state === 'running' ? 'running' : 'failed') +
        '</td><td>' +
        word(whereKey(a.where)) +
        '</td><td>' +
        durationHtml(a.duration) +
        '</td><td>' +
        word(a.accepted ? 'sentinel.viewer.attempt.accepted' : 'sentinel.viewer.attempt.notAccepted') +
        '</td><td>' +
        (a.error ? word(a.error) : '') +
        '</td></tr>',
    )
    .join('');
  return (
    '<table class="snt-table"><thead><tr>' +
    ['try', 'status', 'where', 'took', 'accepted', 'error']
      .map((c) => '<th>' + word('sentinel.viewer.col.' + c) + '</th>')
      .join('') +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table>'
  );
}

function taskLabel(st) {
  const r = st.reviewed;
  if (r && r.kind === 'rule')
    return biz() ? word('sentinel.viewer.reviewed.rule') : mono(r.rule + (r.path ? ' · ' + r.path : ''));
  // a general review reads a set of files: its count, never just the first file's name
  if (r && r.kind === 'files') return cnt(r.files);
  return st.label && !biz() ? mono(st.label) : cnt(st.counts.files);
}

/**
 * What the open check or review left, from the unit answer: what its try ran (code and hybrid), then each retained
 * output with its size and, where its class and the scan allow, its text verbatim behind a disclosure.
 */
function unitDetailHtml(open) {
  const outs = open.outputs
    .map((o) => {
      const head =
        word(o.key) + (o.size && !biz() ? ' · ' + bytesHtml(o.size) : '') + (!biz() ? ' · ' + mono(o.schema) : '');
      if (o.text === null || biz())
        return '<div class="snt-out">' + head + (o.withheld ? ' · ' + keyChip('warn', o.withheld) : '') + '</div>';
      return (
        '<details class="snt-out"><summary>' +
        head +
        (o.truncated ? ' · ' + word('sentinel.viewer.turn.cut') : '') +
        '</summary><pre class="snt-pre">' +
        esc(o.text) +
        '</pre></details>'
      );
    })
    .join('');
  return (
    (!biz() && !open.unit.review
      ? '<h3>' +
        word('sentinel.viewer.field.ran') +
        '</h3><dl class="snt-kv">' +
        invocationKv(open.invocation, open.invocationAbsent) +
        '</dl>'
      : '') +
    (outs ? '<h3>' + word('sentinel.viewer.field.left') + '</h3>' + outs : '') +
    (open.outputsMore ? '<p class="snt-sub">' + word('sentinel.viewer.unit.more') + '</p>' : '')
  );
}

function stageStopHtml() {
  const s = SN.stage;
  if (!s) return '';
  const steps = s.units;
  const unitKey = s.stage.kind === 'agent' ? 'sentinel.viewer.unit.review' : 'sentinel.viewer.unit.check';
  if (SN.place.layout === 'table')
    return (
      '<table class="snt-table"><thead><tr>' +
      [s.stage.kind === 'agent' ? 'review' : 'check', 'status', 'took', 'tries', 'cost']
        .map((c) => '<th>' + word('sentinel.viewer.col.' + c) + '</th>')
        .join('') +
      '</tr></thead><tbody>' +
      steps
        .map(
          (st) =>
            '<tr><td>' +
            esc(fill(unitKey, { n: st.number })) +
            ' · ' +
            taskLabel(st) +
            '</td><td>' +
            outcomeChip(st.status, st.review, st.counts.turns) +
            '</td><td>' +
            durationHtml(st.duration) +
            '</td><td>' +
            cnt(st.counts.attempts, { words: String(st.counts.attempts.n) }) +
            '</td><td>' +
            costHtml(st.cost) +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table>'
    );
  const at = Math.min(Math.max(SN.place.unit || 1, 1), steps.length || 1);
  const open = SN.unit && SN.unit.unit.number === at ? SN.unit : null;
  const list = steps
    .map(
      (st) =>
        '<button type="button" class="snt-ent' +
        (st.number === at ? ' sel' : '') +
        '" data-step="' +
        st.number +
        '"><span class="snt-ent-m">' +
        esc(fill(unitKey, { n: st.number })) +
        '</span><span class="snt-ent-p">' +
        taskLabel(st) +
        '</span><span class="snt-ent-c">' +
        (st.counts.modelObservations?.n
          ? chip('k-agent', cnt(st.counts.modelObservations, { words: String(st.counts.modelObservations.n) }))
          : outcomeChip(st.status, st.review)) +
        '</span></button>',
    )
    .join('');
  const step = open ? open.unit : steps.find((x) => x.number === at);
  return (
    '<div class="snt-cols"><div class="snt-list"><div class="snt-label">' +
    cnt(s.stage.counts.units) +
    '</div>' +
    list +
    (s.more ? '<p class="snt-sub">' + word('sentinel.viewer.unit.more') + '</p>' : '') +
    '</div><div class="snt-turns">' +
    (s.review === 'withheld'
      ? '<div class="snt-note warn">' + word('sentinel.viewer.absent.withheld') + '</div>'
      : '') +
    (step ? (step.review ? reviewHeadHtml(step) + reviewHtml(step.review) : attemptsHtml(step)) : '') +
    (open ? unitDetailHtml(open) : '') +
    '</div></div>'
  );
}

/**
 * The companion is paired with this server's other loopback spelling: the line says so and links there, at the
 * same Sentinel address. The companion stays pinned to its exact origin (ADR 48); this page only points to it.
 */
function pairedWithHtml() {
  const href = SN.pairedWith + '/' + (location.hash || '#/sentinel');
  const [before, after = ''] = t('sentinel.viewer.pairedWith').split('{origin}');
  return (
    '<div class="snt-empty" data-paired-with="' +
    esc(SN.pairedWith) +
    '">' +
    esc(before) +
    '<a href="' +
    esc(href) +
    '"' +
    defAttrs('sentinel.viewer.pairedWith') +
    '>' +
    esc(SN.pairedWith) +
    '</a>' +
    esc(after) +
    '</div>'
  );
}

/** The other loopback spelling of this page's own origin, when the companion lookup named exactly that; else null. */
function pairedWithOf(value) {
  if (typeof value?.pairedWith !== 'string') return null;
  try {
    const u = new URL(value.pairedWith),
      here = new URL(location.href);
    const loopback = ['127.0.0.1', 'localhost'];
    return u.protocol === 'http:' &&
      u.origin === value.pairedWith &&
      loopback.includes(u.hostname) &&
      loopback.includes(here.hostname) &&
      u.hostname !== here.hostname &&
      u.port === here.port
      ? u.origin
      : null;
  } catch {
    return null;
  }
}

function bodyHtml() {
  const p = SN.place;
  const empty = (key, cls = '') => '<div class="snt-empty ' + cls + '">' + word(key) + '</div>';
  if (SN.error) return empty(SN.error, 'err');
  if (!SN.companion && SN.pairedWith) return pairedWithHtml();
  if (!SN.companion) return empty('sentinel.ownerUi.launch');
  if (!SN.pass) return empty('sentinel.viewer.pairing');
  if (p.stop === 'scans') return SN.scans ? scansHtml() : empty('sentinel.viewer.loading');
  if (p.edit) return SN.config ? editHtml() : empty('sentinel.viewer.loading');
  if (p.stop === 'pipeline') {
    if (!SN.scan) return empty('sentinel.viewer.loading');
    return p.layout === 'table' ? pipelineTableHtml() : ladderHtml();
  }
  return SN.stage ? stageStopHtml() : empty('sentinel.viewer.loading');
}

/** The dock's tabs and the active one: the picked stage (below the SCANS stop), and the owner panel. */
function dockTabs() {
  const tabs = [];
  if (SN.place.edit) tabs.push(['stage', 'sentinel.viewer.dock.edit']);
  else if (SN.place.stop !== 'scans' && SN.scan) tabs.push(['stage', 'sentinel.viewer.dock.stage']);
  tabs.push(['owner', 'sentinel.viewer.dock.owner']);
  const active = tabs.some(([id]) => id === SN.dockTab) ? SN.dockTab : tabs[0][0];
  return { tabs, active };
}

function tabsHtml({ tabs, active }) {
  return tabs
    .map(
      ([id, key]) =>
        '<button type="button" role="tab" data-tab="' +
        id +
        '" class="' +
        (id === active ? 'on' : '') +
        '" aria-selected="' +
        (id === active) +
        '">' +
        word(key) +
        '</button>',
    )
    .join('');
}

function draw() {
  const root = SN.el?.querySelector('.snt');
  if (!root) return;
  const p = SN.place;
  root.dataset.stop = p.stop;
  root.querySelector('.snt-chrome').innerHTML = chromeHtml();
  root.querySelector('.snt-stage').innerHTML = bodyHtml();
  // The dock: its tabs and the stage pane are redrawn; the owner pane is built once and only shown or hidden, because
  // moving an iframe reloads it — and the owner frame's page is its pairing.
  const dock = dockTabs();
  root.querySelector('.snt-tabs').innerHTML = tabsHtml(dock);
  const stagePane = root.querySelector('[data-pane="stage"]');
  stagePane.hidden = dock.active !== 'stage';
  const stage =
    p.stop === 'stage' ? SN.stage?.stage : p.stop === 'pipeline' && SN.scan ? pickedStage(SN.scan, p.pick) : null;
  stagePane.innerHTML = dock.active !== 'stage' ? '' : p.edit ? editorDockHtml(p.pick) : stageDockHtml(stage);
  const owner = root.querySelector('[data-pane="owner"]');
  owner.hidden = dock.active !== 'owner';
  owner.querySelector('.snt-sub').textContent = SN.companion
    ? t('sentinel.viewer.dock.ownerNote')
    : SN.pairedWith
      ? t('sentinel.viewer.pairedWith').split('{origin}').join(SN.pairedWith)
      : t('sentinel.ownerUi.launch');
  if (SN.frame && SN.frame.parentNode !== owner) owner.appendChild(SN.frame);
  root.classList.toggle('busy', SN.loading);
}

// ── the edit mode: the workspace's pipeline, edited here, checked and written through the owner frame ───────────

/** The pipeline on screen: the edited copy, else the file as the read model served it. */
function working() {
  return SN.draft ?? SN.config?.pipeline ?? null;
}

/**
 * The draft's identity between this page and the owner frame: the sha256 of exactly the text the CLI writes for it.
 * A check names it, the frame confirms only those bytes, and every answer comes back with it.
 */
async function draftDigest(pipeline) {
  const bytes = new TextEncoder().encode(pipelineText(pipeline));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'sha256:' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The page's last check no longer speaks for what it shows (an edit, a discard): the frame drops the check if it is
 * still out with the service, and the confirmation if it offers one.
 */
function withdrawCheck() {
  if ((SN.checking || SN.check?.state === 'checked') && SN.frame?.contentWindow && SN.child)
    SN.frame.contentWindow.postMessage(
      { type: 'sentinel-owner-pipeline-withdraw', frameNonce: SN.child.frameNonce, documentId: SN.child.documentId },
      SN.origin,
    );
}

/**
 * An edit: the page's copy changes, and the last check no longer speaks for it. A confirmation the frame still offers
 * for the earlier copy is withdrawn, so what the owner confirms is always what the page shows.
 */
function edited(next) {
  if (!SN.draft) SN.draftBase = SN.config?.fileDigest ?? null;
  withdrawCheck();
  SN.draft = next;
  SN.check = null;
  SN.checking = false;
  draw();
}

/** A run's controls and the states that allow each (contracts/run.ts); the service still decides at its preview. */
const RUN_CONTROLS = [
  // a prepared scan is recorded as running before its checks start: Start is offered while nothing is running
  {
    action: 'start',
    key: 'sentinel.viewer.tool.start',
    when: (row, stages) =>
      ['planned', 'paused'].includes(row.state) ||
      (row.state === 'running' && !stages.some((st) => st.status === 'running')),
  },
  { action: 'pause', key: 'sentinel.viewer.tool.pause', when: (row) => row.state === 'running' },
  {
    action: 'cancel',
    key: 'sentinel.viewer.tool.cancel',
    when: (row) => ['planned', 'running', 'pausing', 'paused'].includes(row.state),
  },
];

/**
 * Start, pause or cancel one scan: the owner panel previews it and the owner confirms it there, with the panel's own
 * control receipt — the same preview and confirmation the Scan flow uses. This page only asks.
 */
function control(action) {
  if (readOnlyWhy() || !SN.frame?.contentWindow || !SN.child || !SN.place.scan) return;
  SN.dockTab = 'owner';
  draw();
  SN.frame.contentWindow.postMessage(
    {
      type: 'sentinel-owner-control',
      frameNonce: SN.child.frameNonce,
      documentId: SN.child.documentId,
      action,
      runId: SN.place.scan,
    },
    SN.origin,
  );
}

/** The tools beside Scan: edit the pipeline, or (in the edit mode) check and discard; a finished scan's reports. */
function toolsHtml() {
  const p = SN.place;
  const off = (why) => ' aria-disabled="true"' + tipAttrs({ key: why, noFocus: true });
  if (p.edit) {
    const why = readOnlyWhy()
      ? 'sys.readonly.control'
      : !SN.pass || !SN.child
        ? 'sentinel.viewer.pairing'
        : !SN.draft
          ? 'sentinel.viewer.edit.nothingToCheck'
          : SN.checking
            ? 'sentinel.viewer.edit.checking'
            : null;
    return (
      '<button type="button" class="map-tb' +
      (why ? '' : ' primary') +
      '" data-act="echeck"' +
      (why ? off(why) : tipAttrs({ key: 'sentinel.viewer.edit.check', noFocus: true })) +
      '>' +
      word('sentinel.viewer.edit.check') +
      '</button>' +
      '<button type="button" class="map-tb" data-act="ediscard"' +
      (SN.draft
        ? tipAttrs({ key: 'sentinel.viewer.edit.discard', noFocus: true })
        : off('sentinel.viewer.edit.nothingToCheck')) +
      '>' +
      word('sentinel.viewer.edit.discard') +
      '</button>'
    );
  }
  const row = p.stop !== 'scans' && SN.scan?.scan?.id === p.scan ? SN.scan.scan : null;
  // A scan's run controls: what its state allows, previewed and confirmed in the owner panel, never here.
  const offPair = readOnlyWhy() ? 'sys.readonly.control' : !SN.pass || !SN.child ? 'sentinel.viewer.pairing' : null;
  const controls = !row
    ? ''
    : RUN_CONTROLS.filter((c) => c.when(row, SN.scan?.stages || []))
        .map(
          (c) =>
            '<button type="button" class="map-tb" data-act="control" data-action="' +
            c.action +
            '"' +
            (offPair ? off(offPair) : tipAttrs({ key: c.key, noFocus: true })) +
            '>' +
            word(c.key) +
            '</button>',
        )
        .join('');
  const reports =
    row && !scanLive(row)
      ? ['html', 'md']
          .map(
            (f) =>
              '<button type="button" class="map-tb" data-act="report" data-format="' +
              f +
              '"' +
              tipAttrs({ key: 'sentinel.viewer.report.' + f, noFocus: true }) +
              '>' +
              word('sentinel.viewer.report.' + f) +
              '</button>',
          )
          .join('')
      : '';
  return (
    controls +
    reports +
    '<button type="button" class="map-tb" data-act="edit"' +
    tipAttrs({ key: 'sentinel.viewer.edit.open', noFocus: true }) +
    '>' +
    word('sentinel.viewer.edit.open') +
    '</button>'
  );
}

/**
 * A service word with its `{detail}` filled: the safe detail the service gave (stage ids, field paths), in the code
 * registers; the business register drops a parenthesised detail, which can name a scanner or a rule by its id.
 */
function detailWords(key, detail) {
  const text = t(key);
  if (!text.includes('{detail}')) return text;
  const d = typeof detail === 'string' ? detail.slice(0, 240) : '';
  const paren = /\s*\(\{detail\}\)/;
  if (!d || biz()) return text.replace(paren, '').split('{detail}').join(d);
  return text.split('{detail}').join(d);
}
const detailChip = (cls, key, detail) => chip(cls, esc(detailWords(key, detail)), defAttrs(key));

/**
 * A declared stage's name in the register on screen: the catalog's words (or the name the owner declared) in
 * business, those words beside the id in hybrid, the id in code.
 */
function stageText(stage) {
  const n = stageName(stage);
  const words = n.key ? t(n.key) : n.declared;
  return biz() ? words : lensNow() === 'code' ? String(stage.id) : words + ' · ' + stage.id;
}
function stageNameHtml(stage) {
  const n = stageName(stage);
  const words = esc(n.key ? t(n.key) : n.declared);
  if (biz()) return words;
  if (lensNow() === 'code') return '<span class="mono">' + esc(stage.id) + '</span>';
  return words + ' ' + chip('plain', esc(stage.id));
}

/** What the last check said would happen to a stage: reused, run again, added, changed. */
function changeOf(id) {
  return SN.check?.preview?.stages?.find((x) => x.id === id) || null;
}

function editRowHtml(stage, i, problems, touched) {
  const k = kindChip(stage.kind);
  const sel = SN.place.pick === stage.id;
  const change = changeOf(stage.id);
  const runner =
    stage.kind === 'agent'
      ? stage.runner
      : stage.kind === 'script'
        ? stage.runner
        : stage.kind === 'tool'
          ? stage.adapter
          : stage.operation;
  return (
    '<div class="snt-erow ' +
    esc(k.cls) +
    (sel ? ' sel' : '') +
    '" data-estage="' +
    esc(stage.id) +
    '" tabindex="0" role="button" aria-label="' +
    esc(stageText(stage)) +
    '"><span class="snt-n">' +
    (i + 1) +
    '</span><span class="snt-enm">' +
    stageNameHtml(stage) +
    '</span>' +
    keyChip(k.cls, k.key) +
    (!biz() && runner && typeof runner === 'string' ? chip('plain', esc(runner)) : '') +
    (change ? keyChip('', whereKey(change.where)) : '') +
    (touched ? keyChip('warn', 'sentinel.viewer.edit.edited') : '') +
    (problems?.length ? keyChip('err', 'sentinel.viewer.edit.problem') : '') +
    '<span class="snt-ech">' +
    (change ? keyChip(change.change === 'unchanged' ? 'ok' : 'warn', 'sentinel.ownerUi.change.' + change.change) : '') +
    '</span></div>'
  );
}

function addHereHtml(afterId) {
  return (
    '<div class="snt-eadd"><span>' +
    word('sentinel.viewer.edit.addHere') +
    '</span>' +
    STAGE_KINDS.map(
      (k) =>
        '<button type="button" class="map-tb" data-eadd="' +
        esc(afterId) +
        '" data-enew="' +
        k +
        '"' +
        defAttrs('sentinel.viewer.kind.' + k) +
        '>' +
        word('sentinel.viewer.kind.' + k) +
        '</button>',
    ).join('') +
    '</div>'
  );
}

/** The edit mode's stage area: the pipeline file as its ladder, the picked stage's JSON beneath, nothing run. */
function editHtml() {
  const pipe = working();
  if (!pipe || !Array.isArray(pipe.stages))
    return (
      '<div class="snt-empty">' +
      word('sentinel.viewer.edit.noFile') +
      (biz() ? '' : ' <span class="mono">farsight-sentinel init</span>') +
      '</div>'
    );
  const problems = problemsByStage(SN.check?.problems?.length ? SN.check.problems : SN.config?.problems);
  const touched = new Set(SN.draft ? changedStages(SN.config?.pipeline, SN.draft) : []);
  const own = problems.get('') || [];
  const removed = SN.check?.preview?.removed || [];
  const picked = pipe.stages.find((x) => x.id === SN.place.pick);
  return (
    (own.length
      ? '<div class="snt-eprob">' + own.map((x) => problemHtml(x)).join('') + '</div>'
      : SN.check?.state === 'refused' || SN.check?.state === 'failed'
        ? '<div class="snt-eprob">' +
          detailChip('err', SN.check.reasonCode || 'sentinel.viewer.edit.refused', SN.check.detail) +
          '</div>'
        : '') +
    (SN.check?.state === 'writtenEarlier'
      ? '<div class="snt-note warn">' + esc(def('sentinel.viewer.edit.writtenEarlier')) + '</div>'
      : '') +
    (SN.check?.state === 'written'
      ? '<div class="snt-note">' +
        word('sentinel.viewer.edit.adoptNote') +
        (biz() ? '' : ' <span class="mono">farsight-sentinel pipeline adopt --confirm</span>') +
        '</div>'
      : '') +
    '<div class="snt-eladder">' +
    pipe.stages
      .map(
        (stage, i) =>
          editRowHtml(stage, i, problems.get(stage.id), touched.has(stage.id)) +
          (stage.id === SN.place.pick ? addHereHtml(stage.id) : ''),
      )
      .join('') +
    removed
      .map(
        (id) =>
          '<div class="snt-erow gone"><span class="snt-enm">' +
          esc(biz() ? String(id).replace(/-/g, ' ') : id) +
          '</span>' +
          keyChip('warn', 'sentinel.ownerUi.change.removed') +
          '</div>',
      )
      .join('') +
    (SN.place.pick ? '' : addHereHtml(pipe.stages[pipe.stages.length - 1]?.id ?? '')) +
    '</div>' +
    (picked && !biz()
      ? '<pre class="snt-json"><span class="snt-jc">' +
        esc('// ' + t('sentinel.viewer.edit.writes') + ' · .farsight/sentinel/pipeline.json') +
        '</span>\n' +
        esc(JSON.stringify(picked, null, 2)) +
        '</pre>'
      : '') +
    '<div class="snt-foot"><span class="snt-foot-note">' +
    word('sentinel.viewer.edit.footNote') +
    '</span></div>'
  );
}

function problemHtml(x) {
  const key = typeof x.code === 'string' && x.code.startsWith('sentinel.') ? x.code : 'sentinel.viewer.edit.problem';
  return '<div class="snt-pr">' + detailChip(x.class === 'refused' ? 'err' : 'warn', key, x.detail) + '</div>';
}

const listText = (v) =>
  Array.isArray(v)
    ? v.some((x) => x && typeof x === 'object')
      ? JSON.stringify(v)
      : v.join(', ')
    : v == null
      ? ''
      : String(v);
function listValue(text) {
  const s = String(text).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : s;
    } catch {
      return s; // the service says what is wrong with it
    }
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function fieldHtml(stage, f) {
  const label = 'sentinel.viewer.edit.field.' + f.key;
  const v = stage[f.key];
  let input;
  // an identifier, a pack reference, a model name or a wiring: the business register names the field and says where
  // it is edited, and prints no value
  if (f.technical && biz())
    return (
      '<dt' +
      defAttrs(label) +
      '>' +
      word(label) +
      '</dt><dd class="snt-fld snt-sub"' +
      defAttrs('sentinel.viewer.edit.inCode') +
      '>' +
      word('sentinel.viewer.edit.inCode') +
      '</dd>'
    );
  if (f.key === 'required') {
    input = [true, false]
      .map(
        (b) =>
          '<button type="button" class="map-tb' +
          (v === b ? ' on' : '') +
          '" data-efield="required" data-evalue="' +
          b +
          '">' +
          word(b ? 'sentinel.viewer.edit.yes' : 'sentinel.viewer.edit.no') +
          '</button>',
      )
      .join('');
  } else if (f.choices) {
    input = f.choices
      .map(
        (c) =>
          '<button type="button" class="map-tb' +
          (v === c ? ' on' : '') +
          '" data-efield="' +
          f.key +
          '" data-evalue="' +
          esc(c) +
          '"' +
          defAttrs(choiceKey(f.words, c)) +
          '>' +
          word(choiceKey(f.words, c)) +
          '</button>',
      )
      .join('');
  } else if (f.key === 'budget') {
    const b = v && typeof v === 'object' ? v : {};
    input = ['turns', 'tokens', 'usd', 'seconds']
      .map(
        (k) =>
          '<label class="snt-bud"><span>' +
          word('sentinel.viewer.edit.budget.' + k) +
          '</span><input data-ebudget="' +
          k +
          '" value="' +
          esc(b[k] == null ? '' : String(b[k])) +
          '" inputmode="decimal" size="7"></label>',
      )
      .join('');
  } else {
    input =
      '<input data-efield="' +
      f.key +
      '"' +
      (f.list ? ' data-elist="1"' : '') +
      ' value="' +
      esc(f.list ? listText(v) : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)) +
      '" spellcheck="false">';
  }
  return '<dt' + defAttrs(label) + '>' + word(label) + '</dt><dd class="snt-fld">' + input + '</dd>';
}

/** The editor drawer: one stage's fields, its kind's own and the shared ones, and what the service last said of it. */
function editorDockHtml(id) {
  const pipe = working();
  const at = pipe?.stages?.findIndex((x) => x.id === id) ?? -1;
  if (!pipe || at < 0) return '<p class="snt-sub">' + word('sentinel.viewer.edit.pick') + '</p>';
  const stage = pipe.stages[at];
  const k = kindChip(stage.kind);
  const problems =
    problemsByStage(SN.check?.problems?.length ? SN.check.problems : SN.config?.problems).get(stage.id) || [];
  const change = changeOf(stage.id);
  return (
    '<h2>' +
    esc(fill('sentinel.viewer.edit.stageTitle', { n: at + 1 })) +
    ' · ' +
    esc(stageText(stage)) +
    '</h2><div class="snt-row">' +
    keyChip(k.cls, k.key) +
    (change ? keyChip('', whereKey(change.where)) : '') +
    '</div><dl class="snt-kv snt-form"><dt' +
    defAttrs('sentinel.viewer.edit.field.kind') +
    '>' +
    word('sentinel.viewer.edit.field.kind') +
    '</dt><dd class="snt-fld">' +
    STAGE_KINDS.map(
      (kind) =>
        '<button type="button" class="map-tb' +
        (stage.kind === kind ? ' on' : '') +
        '" data-ekind="' +
        kind +
        '"' +
        defAttrs('sentinel.viewer.kind.' + kind) +
        '>' +
        word('sentinel.viewer.kind.' + kind) +
        '</button>',
    ).join('') +
    '</dd>' +
    (STAGE_FIELDS[stage.kind] || []).map((f) => fieldHtml(stage, f)).join('') +
    SHARED_FIELDS.map((f) => fieldHtml(stage, f)).join('') +
    '</dl>' +
    (problems.length ? '<div class="snt-eprob">' + problems.map((x) => problemHtml(x)).join('') + '</div>' : '') +
    '<div class="snt-acts">' +
    '<button type="button" class="map-tb primary" data-act="echeck"' +
    (SN.draft && !readOnlyWhy() && SN.pass && !SN.checking
      ? tipAttrs({ key: 'sentinel.viewer.edit.check', noFocus: true })
      : ' aria-disabled="true"' + tipAttrs({ key: 'sentinel.viewer.edit.nothingToCheck', noFocus: true })) +
    '>' +
    word('sentinel.viewer.edit.check') +
    '</button><button type="button" class="map-tb" data-act="eremove"' +
    tipAttrs({ key: 'sentinel.viewer.edit.remove', noFocus: true }) +
    '>' +
    word('sentinel.viewer.edit.remove') +
    '</button></div>' +
    '<div class="snt-note">' +
    word('sentinel.viewer.edit.writeNote') +
    '</div>'
  );
}

/** A click inside the edit mode: a row picks its stage, a choice sets its field, a kind changes, a stage is added. */
function editClick(target) {
  const add = target.closest('[data-eadd]');
  if (add) {
    const out = addStageAfter(working(), add.dataset.eadd, add.dataset.enew);
    edited(out.pipeline);
    go({ edit: true, pick: out.id });
    return true;
  }
  const kind = target.closest('[data-ekind]');
  if (kind && SN.place.pick) {
    edited(changeKind(working(), SN.place.pick, kind.dataset.ekind));
    return true;
  }
  const choice = target.closest('[data-efield][data-evalue]');
  if (choice && SN.place.pick) {
    const raw = choice.dataset.evalue;
    edited(
      editStage(working(), SN.place.pick, choice.dataset.efield, raw === 'true' ? true : raw === 'false' ? false : raw),
    );
    return true;
  }
  const row = target.closest('[data-estage]');
  if (row) {
    SN.dockTab = 'stage';
    go({ edit: true, pick: row.dataset.estage });
    return true;
  }
  return false;
}

/** A typed field: a list is comma-separated (or JSON, for wired outputs), a budget part a number or a decimal. */
function onChange(e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target || !SN.place.edit || !SN.place.pick) return;
  const stage = working()?.stages?.find((x) => x.id === SN.place.pick);
  if (!stage) return;
  if (target.matches('[data-ebudget]')) {
    const key = target.dataset.ebudget,
      raw = String(target.value).trim();
    const budget = { ...(stage.budget || {}) };
    if (!raw) delete budget[key];
    else budget[key] = key === 'usd' || !/^[0-9]+$/.test(raw) ? raw : Number(raw);
    edited(editStage(working(), stage.id, 'budget', Object.keys(budget).length ? budget : undefined));
    return;
  }
  if (target.matches('[data-efield]')) {
    const key = target.dataset.efield;
    edited(
      editStage(working(), stage.id, key, target.dataset.elist ? listValue(target.value) : String(target.value).trim()),
    );
  }
}

/** Check: the frame has the service check and preview the edited pipeline, and asks the owner to confirm the write. */
async function checkPipeline() {
  if (!SN.draft || readOnlyWhy() || !SN.frame?.contentWindow || !SN.child) return;
  const draft = SN.draft;
  SN.checking = true;
  SN.check = null;
  SN.dockTab = 'owner';
  draw();
  const digest = await draftDigest(draft);
  if (SN.draft !== draft || !SN.frame?.contentWindow || !SN.child) return; // edited meanwhile: that edit withdrew it
  SN.frame.contentWindow.postMessage(
    {
      type: 'sentinel-owner-pipeline',
      frameNonce: SN.child.frameNonce,
      documentId: SN.child.documentId,
      pipeline: draft,
      expectDigest: SN.draftBase ?? null,
      draftDigest: digest,
    },
    SN.origin,
  );
}

/**
 * The frame's answer, for the draft it names. An answer for an earlier copy than the one on screen is not this draft's:
 * a check of it is dropped, and a write of it leaves the newer draft here, on top of the file it wrote.
 */
async function pipelineResult(v) {
  if (typeof v.draftDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.draftDigest)) return;
  // the draft on screen when the comparison is made: an edit during the digest's await is compared, never cleared
  let draft, current;
  do {
    draft = SN.draft;
    current = draft ? await draftDigest(draft) : null;
  } while (draft !== SN.draft);
  // (a write after the draft was discarded is simply the file's new state)
  if (current !== v.draftDigest && !(v.state === 'written' && !SN.draft)) {
    if (v.state !== 'written') return;
    SN.checking = false;
    SN.draftBase = typeof v.written?.fileDigest === 'string' ? v.written.fileDigest : SN.draftBase;
    SN.check = { state: 'writtenEarlier', reasonCode: null, detail: null, problems: [], preview: null };
    void load();
    return;
  }
  SN.checking = false;
  SN.check = {
    state: v.state,
    reasonCode: typeof v.reasonCode === 'string' ? v.reasonCode : null,
    detail: typeof v.detail === 'string' ? v.detail : null,
    problems: Array.isArray(v.problems) ? v.problems.filter((x) => x && typeof x === 'object') : [],
    preview: v.preview && Array.isArray(v.preview.stages) ? v.preview : null,
  };
  if (v.state === 'written') {
    // the file now holds what the owner confirmed: read it again, and the edit is done
    SN.draft = null;
    SN.draftBase = undefined;
    SN.dockTab = 'stage';
    void load();
    return;
  }
  if (v.state !== 'checked') SN.dockTab = 'stage';
  draw();
}

/** A finished scan's report, read with the pass and saved as a file; the page keeps nothing of it. */
async function download(format, again = true) {
  if (!SN.pass || !SN.place.scan || !['html', 'md'].includes(format)) return;
  try {
    const r = await fetch(
      SN.origin + '/api/sentinel/scans/' + encodeURIComponent(SN.place.scan) + '/report/' + format,
      {
        headers: { authorization: 'Bearer ' + SN.pass },
        cache: 'no-store',
        credentials: 'omit',
      },
    );
    if (r.status === 401 && again) {
      await askPass();
      return download(format, false);
    }
    if (!r.ok) {
      const value = await r.json().catch(() => ({}));
      throw Object.assign(Error('report'), { code: value.error || 'sentinel.ownerUi.failed' });
    }
    const name =
      /filename="([A-Za-z0-9._-]{1,80})"/.exec(r.headers.get('content-disposition') || '')?.[1] ||
      'sentinel-report.' + format;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    SN.error = (e && e.code) || 'sentinel.ownerUi.failed';
    draw();
  }
}

// ── input ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function go(place) {
  const h = sentinelHash(place);
  if (location.hash !== h) location.hash = h;
}

function onClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const stop = target.closest('.snt-stops [data-stop]');
  if (stop) {
    if (stop.getAttribute('aria-disabled') === 'true') return;
    const id = stop.dataset.stop;
    if (id === 'scans') go({});
    else if (id === 'pipeline' && SN.place.scan) go({ scan: SN.place.scan, pick: SN.place.stage });
    return;
  }
  const layout = target.closest('[data-layout]');
  if (layout) {
    if (layout.getAttribute('aria-disabled') !== 'true') go({ ...SN.place, layout: layout.dataset.layout });
    return;
  }
  const act = target.closest('[data-act]');
  if (act) {
    if (act.getAttribute('aria-disabled') === 'true') return;
    const a = act.dataset.act;
    if (a === 'refresh') void load();
    if (a === 'scan') scan(act);
    if (a === 'edit') go({ edit: true, pick: SN.place.pick || SN.place.stage });
    if (a === 'report') void download(act.dataset.format);
    if (a === 'control' && ['start', 'pause', 'cancel'].includes(act.dataset.action)) control(act.dataset.action);
    if (a === 'echeck') void checkPipeline();
    if (a === 'ediscard') {
      withdrawCheck();
      SN.checking = false;
      SN.draft = null;
      SN.draftBase = undefined;
      SN.check = null;
      draw();
    }
    if (a === 'eremove' && SN.place.pick) {
      edited(removeStage(working(), SN.place.pick));
      go({ edit: true });
    }
    return;
  }
  if (SN.place.edit && editClick(target)) return;
  const tab = target.closest('[data-tab]');
  if (tab) {
    SN.dockTab = tab.dataset.tab;
    draw();
    return;
  }
  const step = target.closest('[data-step]');
  if (step) {
    go({ ...SN.place, unit: Number(step.dataset.step) });
    return;
  }
  const card = target.closest('[data-stage]');
  if (card && SN.place.stop === 'pipeline') {
    SN.dockTab = 'stage';
    if (e.detail >= 2) go({ scan: SN.place.scan, stage: card.dataset.stage });
    else go({ scan: SN.place.scan, layout: SN.place.layout, pick: card.dataset.stage });
  }
}

function onKey(e) {
  const row = e.target instanceof Element ? e.target.closest('[data-estage]') : null;
  if (row && e.key === 'Enter') {
    go({ edit: true, pick: row.dataset.estage });
    return;
  }
  const card = e.target instanceof Element ? e.target.closest('[data-stage]') : null;
  if (card && SN.place.stop === 'pipeline' && e.key === 'Enter') go({ scan: SN.place.scan, stage: card.dataset.stage });
}

/**
 * Scan: the owner panel does it, in the frame, with its own preview and its own confirmation — the receipt flow this
 * page cannot hold. The call shape is the facade's `scan` (README §3.5: preview, then confirm), carried today by the
 * panel's preparation and start until P-4's facade lands. Off, it is greyed with its reason and a press does nothing.
 */
function scan(button) {
  if (button.getAttribute('aria-disabled') === 'true' || readOnlyWhy()) return;
  if (!SN.frame?.contentWindow || !SN.child) return;
  SN.dockTab = 'owner';
  draw();
  SN.frame.contentWindow.postMessage(
    { type: 'sentinel-owner-scan', frameNonce: SN.child.frameNonce, documentId: SN.child.documentId },
    SN.origin,
  );
}

/**
 * The door a Settings source row may carry (the shell draws it): it opens the SCANS stop and starts a scan there, the
 * same way the Scan button does — greyed with its reason when it cannot, never a dead click.
 */
export function sentinelScanDoorHtml() {
  if (readOnlyWhy()) return doorHtml({ on: false, why: 'sys.readonly.control' });
  if (!lastScanAction) return doorHtml({ on: false, why: 'sentinel.viewer.scan.unknown' });
  // the answer is the last read's: greyed until this same companion and session are confirmed still there
  setTimeout(() => void verifyDoors(), 0);
  return doorHtml({ on: false, why: 'sentinel.viewer.scan.checking' }, true);
}

function doorHtml(door, pending = false) {
  if (!door.on)
    return (
      '<span class="map-tb snt-door" style="margin-right:6px;opacity:.45" aria-disabled="true"' +
      (pending ? ' data-door="pending"' : '') +
      tipAttrs({ key: door.why, noFocus: true }) +
      '>' +
      word('sentinel.viewer.tool.scan') +
      '</span>'
    );
  return (
    '<a class="map-tb snt-door" style="margin-right:6px" href="' +
    esc('#/sentinel?do=scan') +
    '"' +
    tipAttrs({ key: door.why, noFocus: true }) +
    '>' +
    word('sentinel.viewer.tool.scan') +
    '</a>'
  );
}

/** Checks the remembered answer against the companion and the session now, then settles every pending door. */
async function verifyDoors() {
  const cached = lastScanAction;
  if (!cached) return;
  let why = null;
  try {
    const [companion, version] = await Promise.all([
      fetch('/api/sentinel/companion', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    if (
      !companion?.available ||
      companion.ownerOrigin !== cached.origin ||
      document.body.dataset.sentinelOwnerOrigin !== cached.origin
    )
      why = 'sentinel.ownerUi.launch';
    else if ((version?.session?.instance ?? null) !== cached.instance || Date.now() - cached.at > SCAN_ACTION_TTL_MS)
      why = 'sentinel.viewer.scan.unknown';
  } catch {
    why = 'sentinel.ownerUi.hostUnavailable';
  }
  if (lastScanAction !== cached) return; // a newer read answered meanwhile; its own doors settle themselves
  if (why) forgetScanAction();
  const door = why ? { on: false, why } : doorState({ readOnly: !!readOnlyWhy(), action: cached.action });
  for (const el of document.querySelectorAll('.snt-door[data-door="pending"]')) el.outerHTML = doorHtml(door);
}

// ── the surface ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function mountSentinel(_route, el) {
  installStyle();
  SN.el = el;
  SN.place = sentinelPlace(location.hash);
  SN.scans = null;
  SN.scan = null;
  SN.stage = null;
  SN.unit = null;
  SN.error = null;
  SN.dockTab = 'stage';
  // an edit in progress survives leaving the page; the file it started from is read again
  SN.config = null;
  SN.check = null;
  SN.checking = false;
  el.innerHTML =
    '<div class="snt"><div class="snt-chrome"></div><div class="snt-body"><div class="snt-stage"></div>' +
    '<aside class="snt-dock" aria-label="' +
    word('sentinel.viewer.dock.title') +
    '"><div class="snt-tabs" role="tablist"></div><div class="snt-pane" data-pane="stage"></div>' +
    '<div class="snt-pane snt-owner" data-pane="owner" hidden><p class="snt-sub"></p></div></aside></div></div>';
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  el.addEventListener('change', onChange);
  draw();
  try {
    const response = await fetch('/api/sentinel/companion', { cache: 'no-store' }),
      value = await response.json();
    if (SN.el !== el) return;
    if (!value.available || typeof value.ownerOrigin !== 'string') {
      SN.companion = false;
      SN.pairedWith = pairedWithOf(value);
      forgetScanAction();
      draw();
      return;
    }
    const u = new URL(value.ownerOrigin);
    if (
      u.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.origin !== value.ownerOrigin ||
      !u.port ||
      document.body.dataset.sentinelOwnerOrigin !== u.origin
    )
      throw Error('origin');
    SN.origin = u.origin;
    SN.companion = true;
    SN.pairedWith = null;
    // The owner panel: pairs itself, hands this page its read pass, and confirms what this page cannot.
    if (!SN.frame) {
      SN.frame = document.createElement('iframe');
      SN.frame.title = t('nav.sentinel');
      SN.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      SN.frame.referrerPolicy = 'no-referrer';
      SN.frame.className = 'snt-frame';
      SN.frame.src = SN.origin + '/frame';
    }
    draw();
  } catch {
    if (SN.el !== el) return;
    SN.companion = false;
    SN.pairedWith = null;
    forgetScanAction();
    SN.error = 'sentinel.ownerUi.hostUnavailable';
    draw();
  }
}

export function sentinelUpdate(reason) {
  if (!SN.el) return;
  // The frame's view changes only when what it may confirm changes (a pinned sync, a read-only session): moving along
  // the ladder keeps its revision, so a Scan preview open in the owner panel survives the reader looking around.
  if (SN.frame && SN.child) {
    const now = context();
    if (now.mode !== SN.mode || now.sync !== SN.sync) {
      SN.revision++;
      SN.mode = now.mode;
      SN.sync = now.sync;
    }
    post(null);
  }
  const place = sentinelPlace(location.hash);
  const moved = JSON.stringify(place) !== JSON.stringify(SN.place);
  SN.place = place;
  if (moved || reason === 'sync') void load();
  else draw();
}

export function unmountSentinel() {
  clearTimeout(SN.timer);
  SN.generation++;
  if (SN.frame && SN.child) {
    SN.revision++;
    SN.frame.contentWindow?.postMessage(
      {
        type: 'sentinel-owner-context',
        id: null,
        frameNonce: SN.child.frameNonce,
        documentId: SN.child.documentId,
        context: { ...context(), mode: 'unavailable', sync: null },
        presentation: presentation(),
      },
      SN.origin,
    );
  }
  SN.el?.removeEventListener('click', onClick);
  SN.el?.removeEventListener('keydown', onKey);
  SN.el?.removeEventListener('change', onChange);
  SN.frame = null;
  SN.child = null;
  SN.pass = null;
  SN.passWaiters.splice(0);
  SN.origin = null;
  SN.companion = false;
  SN.pairedWith = null;
  SN.el = null;
}

// ── the look: the HUD tokens, the mocks' ladder, the Map's chrome classes (map-lvls, map-tb) reused as they are ──

function installStyle() {
  if (document.getElementById('snt-style')) return;
  const style = document.createElement('style');
  style.id = 'snt-style';
  style.textContent = SENTINEL_CSS;
  document.head.appendChild(style);
}

const SENTINEL_CSS = `
body.surface-sentinel .surface{overflow:hidden}
.snt{--k-builtin:var(--fn);--k-script:var(--fn);--k-tool:var(--pkg);--k-agent:var(--auth);display:flex;flex-direction:column;height:100%;min-height:0}
.snt-chrome{flex:none;border-bottom:1px solid var(--line-soft)}
.snt-row1{display:flex;align-items:center;gap:10px;padding:8px 16px;min-width:0}
.snt-row2{display:flex;align-items:center;gap:12px;padding:6px 16px;min-height:34px;background:var(--panel);border-top:1px solid var(--line-soft)}
.snt-stops button[aria-disabled=true],.snt-layouts button[aria-disabled=true]{opacity:.45;cursor:default}
.snt-label{font:10.5px var(--hud);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.snt-tools{margin-left:auto;display:flex;gap:6px;flex:none}
.snt .map-tb.primary{background:var(--accent);color:var(--ground);border-color:var(--accent)}
.snt .map-tb[aria-disabled=true]{opacity:.45;cursor:default}
.snt-crumb{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);min-width:0;flex:1 1 auto;flex-wrap:wrap}
.snt-crumb b{color:var(--ink);font-weight:600}
.snt-crumb a{color:var(--ink)}
.snt-sep{color:var(--line);margin:0 2px}
.snt-verdicts{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end;max-width:55%}
.snt-chip{display:inline-flex;align-items:center;gap:5px;font:10.5px var(--hud);letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border:1px solid var(--line);border-radius:4px;color:var(--muted);background:var(--panel);white-space:nowrap}
.snt-chip .cnt-n{font:inherit;color:inherit}
.snt-chip.ok{color:var(--ok);border-color:rgba(111,207,142,.4)}
.snt-chip.warn{color:var(--warn);border-color:rgba(232,161,60,.45)}
.snt-chip.err{color:var(--err);border-color:rgba(224,108,95,.45)}
.snt-chip.run{color:var(--cyan);border-color:rgba(91,200,221,.45)}
.snt-chip.wait{border-style:dashed}
.snt-chip.k-builtin,.snt-chip.k-script{color:var(--k-builtin);border-color:rgba(216,194,122,.45)}
.snt-chip.k-tool{color:var(--k-tool);border-color:rgba(227,154,114,.45)}
.snt-chip.k-agent{color:var(--k-agent);border-color:rgba(167,139,224,.5)}
.snt-chip.plain{text-transform:none;letter-spacing:0;font:11.5px var(--mono);gap:0}
.snt-chip.cite{color:var(--cyan);text-transform:none;letter-spacing:0;font:11px var(--mono)}
.snt-body{display:flex;flex:1;min-height:0}
.snt-stage{flex:1;min-width:0;overflow:auto;padding:16px 20px 24px;position:relative}
.snt.busy .snt-stage{cursor:progress}
.snt-dock{width:380px;flex:none;border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
@media (max-width:1360px){.snt-dock{width:330px}}
.snt-tabs{display:flex;border-bottom:1px solid var(--line);flex:none}
.snt-tabs button{font:10.5px var(--hud);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);padding:10px 12px;background:none;border:0;cursor:pointer}
.snt-tabs button.on{color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}
.snt-pane{flex:1;padding:12px 16px;overflow:auto;display:flex;flex-direction:column;gap:9px;min-height:0}
.snt-pane[hidden]{display:none}
.snt-pane h2{margin:0;font:600 15px var(--body);color:var(--ink)}
.snt-pane h3{margin:4px 0 0;font:10.5px var(--hud);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.snt-owner{padding:0;gap:0}
.snt-owner .snt-sub{padding:10px 14px 6px}
.snt-frame{width:100%;flex:1;min-height:480px;border:0;background:var(--ground)}
.snt-kv{display:grid;grid-template-columns:104px 1fr;gap:4px 10px;font-size:12px;margin:0}
.snt-kv dt{color:var(--dim);font:10.5px var(--hud);letter-spacing:.08em;text-transform:uppercase;padding-top:2px}
.snt-kv dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.snt-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.snt-note{font-size:12px;color:var(--muted);border-left:2px solid var(--line);padding:4px 10px}
.snt-note.warn{border-color:var(--warn)}
.snt-acts{display:flex;gap:6px;margin-top:auto;padding:8px 0 2px;flex-wrap:wrap;position:sticky;bottom:-12px;background:var(--panel)}
.snt-h1{margin:0 0 4px;font:600 19px var(--body);color:var(--ink)}
.snt-sub{margin:0 0 10px;font-size:12px;color:var(--muted)}
.snt-empty{padding:24px;color:var(--muted);font-size:13px}
.snt-empty.err{color:var(--warn)}
.snt-scans{display:flex;flex-direction:column;gap:5px;max-width:1000px}
.snt-scan-row{display:grid;grid-template-columns:54px minmax(0,1fr) auto;gap:2px 12px;padding:9px 12px;border:1px solid var(--line-soft);border-radius:6px;background:var(--panel);align-items:center;color:inherit;text-decoration:none}
.snt-scan-row:hover,.snt-scan-row:focus-visible{border-color:var(--accent)}
.snt-num{grid-column:1;grid-row:1/3;font:600 13px var(--mono);color:var(--ink)}
.snt-when{grid-column:2;grid-row:1;font-size:11.5px;color:var(--muted);display:flex;gap:4px;flex-wrap:wrap}
.snt-line2{grid-column:2;grid-row:2;font-size:12px;color:var(--muted);display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.snt-v{grid-column:3;grid-row:1/3;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.snt-ladder{display:flex;flex-direction:column;max-width:1040px}
.snt-step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:0 10px}
.snt-rail{position:relative}
.snt-rail::before{content:'';position:absolute;left:13px;top:0;bottom:0;width:2px;background:var(--line)}
.snt-n{position:absolute;left:1px;top:10px;min-width:24px;height:24px;padding:0 5px;white-space:nowrap;box-sizing:border-box;border-radius:12px;background:var(--panel);border:2px solid var(--line);font:10.5px var(--hud);display:flex;align-items:center;justify-content:center;color:var(--muted)}
.snt-step.ok .snt-n{border-color:var(--ok);color:var(--ok)}
.snt-step.run .snt-n{border-color:var(--cyan);color:var(--cyan);box-shadow:0 0 0 4px var(--accent-dim)}
.snt-step.wait .snt-n{border-style:dashed}
.snt-step.warn .snt-n,.snt-step.err .snt-n{border-color:var(--warn);color:var(--warn)}
.snt-card{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--k-builtin);border-radius:6px;padding:7px 12px;margin:4px 0;display:flex;flex-direction:column;gap:4px;cursor:pointer;min-width:0}
.snt-card.k-tool{border-left:4px double var(--k-tool)}
.snt-card.k-agent{border-left-color:var(--k-agent)}
.snt-card.sel{outline:1px solid var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
.snt-card:focus-visible{outline:2px solid var(--accent)}
.snt-nm{font:600 13px var(--body);color:var(--ink);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.snt-prov{font:11.5px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.snt-stc{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.snt-cost,.snt-dur{font:11px var(--mono);color:var(--dim)}
.snt-io{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.snt-par{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:8px}
.snt-foot{margin-top:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--dim);padding:8px 0;max-width:1040px}
.snt-lg{display:inline-flex;align-items:center;gap:6px}
.snt-sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.snt-sw.k-builtin{background:var(--k-builtin)}
.snt-sw.k-tool{background:repeating-linear-gradient(45deg,var(--k-tool) 0 3px,transparent 3px 5px);border:1px solid var(--k-tool)}
.snt-sw.k-agent{background:var(--k-agent)}
.snt-foot-note{margin-left:auto}
.snt-eladder{display:flex;flex-direction:column;gap:6px;max-width:1040px}
.snt-erow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--k-builtin);border-radius:6px;padding:9px 12px;cursor:pointer;min-width:0}
.snt-erow.k-tool{border-left:4px double var(--k-tool)}
.snt-erow.k-agent{border-left-color:var(--k-agent)}
.snt-erow.sel{outline:1px solid var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
.snt-erow:focus-visible{outline:2px solid var(--accent)}
.snt-erow.gone{opacity:.6;border-style:dashed;cursor:default}
.snt-erow .snt-n{position:static;flex:none}
.snt-enm{font:600 13px var(--body);color:var(--ink);overflow-wrap:anywhere}
.snt-ech{margin-left:auto;display:flex;gap:6px}
.snt-eadd{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px dashed var(--line);border-radius:6px;padding:6px 12px;font:10.5px var(--hud);letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.snt-eprob{display:flex;flex-direction:column;gap:4px;margin:0 0 8px}
.snt-pr{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px}
.snt-json{margin:12px 0 0;max-width:1040px;padding:10px 14px;background:var(--panel);border:1px solid var(--line);border-radius:6px;font:12px var(--mono);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
.snt-jc{color:var(--dim)}
.snt-cli{margin:6px 0 0;font:11.5px var(--mono);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
.snt-form dd.snt-fld{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.snt-form .map-tb.on{border-color:var(--accent);color:var(--ink);box-shadow:inset 0 0 0 1px var(--accent)}
.snt-form input{min-width:0;flex:1 1 140px;background:var(--ground);border:1px solid var(--line);border-radius:4px;color:var(--ink);font:12px var(--mono);padding:4px 6px}
.snt-bud{display:inline-flex;flex-direction:column;gap:2px;font:10px var(--hud);letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.snt-bud input{flex:none;width:76px}
.snt-table{border-collapse:collapse;font-size:12px;min-width:min(100%,760px)}
.snt-table th{font:10.5px var(--hud);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
.snt-table td{padding:6px 10px;border-bottom:1px solid var(--line-soft);color:var(--ink);vertical-align:top}
.snt-table tr[data-stage]{cursor:pointer}
.snt-cols{display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px}
@media (max-width:1360px){.snt-cols{grid-template-columns:220px minmax(0,1fr)}}
.snt-list{display:flex;flex-direction:column;gap:4px;min-width:0}
.snt-ent{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:7px 10px;border:1px solid var(--line-soft);border-radius:5px;background:var(--panel);text-align:left;cursor:pointer;color:inherit;font:inherit}
.snt-ent.sel{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
.snt-ent-m{font:600 11px var(--hud);letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}
.snt-ent-p{font-size:11.5px;color:var(--muted);grid-column:1;overflow-wrap:anywhere}
.snt-ent-c{grid-column:2;grid-row:1/3;align-self:center}
.snt-turns{display:flex;flex-direction:column;gap:8px;min-width:0}
.snt-turn{display:grid;grid-template-columns:120px minmax(0,1fr);gap:0 14px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.snt-turn.model{margin-top:-4px}
.snt-who{padding:9px 12px;border-right:1px solid var(--line-soft);display:flex;flex-direction:column;gap:5px}
.snt-who b{font:10.5px var(--hud);letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.snt-turn.sys .snt-who b{color:var(--k-agent)}
.snt-tk{font:11px var(--mono);color:var(--muted)}
.snt-msg{padding:9px 12px 9px 0;font-size:12.5px;color:var(--ink);min-width:0;overflow-wrap:anywhere}
.snt-pre{white-space:pre-wrap;font:11.5px/1.5 var(--mono);color:var(--muted);max-height:360px;overflow:auto}
.snt-obs{border:1px solid rgba(167,139,224,.5);border-left:3px solid var(--k-agent);border-radius:6px;background:rgba(167,139,224,.06);padding:9px 12px}
.snt-obs h4{margin:0 0 4px;font:10.5px var(--hud);letter-spacing:.1em;text-transform:uppercase;color:var(--k-agent)}
.snt-obs p{margin:0 0 6px;font-size:12.5px}
.snt .mono{font-family:var(--mono)}
.snt-pages{display:flex;gap:6px;margin-top:10px}
.snt-out{font-size:12px;color:var(--ink);padding:5px 0;border-bottom:1px solid var(--line-soft);overflow-wrap:anywhere}
.snt-out summary,.snt-words summary{cursor:pointer;color:var(--muted)}
.snt-words{margin-top:4px}
`;
