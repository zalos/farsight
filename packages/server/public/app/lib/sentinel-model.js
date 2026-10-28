// lib/sentinel-model.js — the Sentinel surface's pure half (Sentinel v2 §4, lane L-UX U-2).
//
// No imports and no DOM: the surface (surfaces/sentinel.js) calls these with `location.hash` and the answers Sentinel's
// loopback host serves (packages/sentinel/src/transport/http/read-model.ts), and packages/server/test calls them with
// literals. Words are catalog keys here, never prose: the surface prints them with t() in the register on screen.
//
// The address: `#/sentinel` (SCANS; `before=<n>` an older page) · `#/sentinel/<run id>` (PIPELINE of that scan) ·
// `#/sentinel/<run id>/<stage>` (STAGE; `unit=<k>` the check or review opened), with `layout=` the stop's layout and
// `pick=` the stage the PIPELINE dock shows. A scan is addressed by its run id, as the read model addresses it; its
// number (#n) is a display ordinal the answers carry. ENTRY POINTS and PATH are drawn greyed, *not yet built*, with no
// address of their own.

/** The five stops, in order; the last two are not built yet. */
export const SENTINEL_STOPS = Object.freeze([
  { id: 'scans', key: 'sentinel.viewer.stop.scans', built: true },
  { id: 'pipeline', key: 'sentinel.viewer.stop.pipeline', built: true },
  { id: 'stage', key: 'sentinel.viewer.stop.stage', built: true },
  { id: 'entries', key: 'sentinel.viewer.stop.entries', built: false },
  { id: 'path', key: 'sentinel.viewer.stop.path', built: false },
]);

/** Each stop's layouts, the first the default; a choice with `built: false` is drawn greyed. */
export const SENTINEL_LAYOUTS = Object.freeze({
  scans: [
    { id: 'list', key: 'sentinel.viewer.layout.list', built: true },
    { id: 'compare', key: 'sentinel.viewer.layout.compare', built: false },
  ],
  pipeline: [
    { id: 'ladder', key: 'sentinel.viewer.layout.ladder', built: true },
    { id: 'table', key: 'sentinel.viewer.layout.table', built: true },
  ],
  stage: [
    { id: 'detail', key: 'sentinel.viewer.layout.detail', built: true },
    { id: 'table', key: 'sentinel.viewer.layout.table', built: true },
  ],
});

const NUMBER = /^[1-9][0-9]{0,8}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STAGE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A path segment decoded, or null when it is not valid percent-encoding. */
function decoded(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/**
 * Where a hash puts the Sentinel surface: the stop, the scan number, the stage, the layout and the picked stage.
 * Anything this grammar does not read falls back to the SCANS stop, never to a guess.
 * @param {string} hash
 */
export function sentinelPlace(hash) {
  const h = String(hash || '');
  const out = { stop: 'scans', scan: null, stage: null, unit: null, before: null, layout: null, pick: null, act: null };
  if (!h.startsWith('#/sentinel')) return out;
  const qi = h.indexOf('?');
  const path = (qi >= 0 ? h.slice(0, qi) : h).replace(/@sync:\d+$/, '');
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  const segs = path.slice(2).split('/').filter(Boolean);
  if (segs[0] !== 'sentinel') return out;
  const run = segs[1] ? decoded(segs[1]) : null;
  if (run && RUN.test(run)) {
    out.scan = run;
    out.stop = 'pipeline';
    if (segs[2]) {
      const stage = decoded(segs[2]);
      if (stage && STAGE.test(stage)) {
        out.stage = stage;
        out.stop = 'stage';
        const unit = q.get('unit');
        if (unit && NUMBER.test(unit)) out.unit = Number(unit);
      }
    }
  }
  const layouts = SENTINEL_LAYOUTS[out.stop] || [];
  const layout = q.get('layout');
  out.layout = layouts.some((l) => l.id === layout && l.built) ? layout : layouts[0].id;
  const pick = q.get('pick');
  if (out.stop === 'pipeline' && pick && STAGE.test(pick)) out.pick = pick;
  // a door that asks for a scan (the Settings source row's): the SCANS stop opens the owner panel's preview once
  if (out.stop === 'scans' && q.get('do') === 'scan') out.act = 'scan';
  const before = q.get('before');
  if (out.stop === 'scans' && before && NUMBER.test(before)) out.before = Number(before);
  return out;
}

/** The hash for a place (the inverse of sentinelPlace); the default layout is left out of the address. */
export function sentinelHash(place) {
  let h = '#/sentinel';
  if (place.scan) {
    h += '/' + encodeURIComponent(place.scan);
    if (place.stage) h += '/' + encodeURIComponent(place.stage);
  }
  const stop = place.stage ? 'stage' : place.scan ? 'pipeline' : 'scans';
  const q = [];
  const first = (SENTINEL_LAYOUTS[stop] || [])[0];
  if (place.layout && first && place.layout !== first.id) q.push('layout=' + encodeURIComponent(place.layout));
  if (stop === 'pipeline' && place.pick) q.push('pick=' + encodeURIComponent(place.pick));
  if (stop === 'stage' && place.unit && place.unit > 1) q.push('unit=' + place.unit);
  if (stop === 'scans' && place.before) q.push('before=' + place.before);
  return h + (q.length ? '?' + q.join('&') : '');
}

/** A length of time in the words the mocks use: `4.1 s`, `48 s`, `2 m 10 s`, `1 h 05 m`. @param {number|null} ms */
export function durationWords(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return ms + ' ms';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + ' s';
  if (s < 60) return Math.round(s) + ' s';
  const m = Math.floor(s / 60),
    rs = Math.round(s - m * 60);
  if (m < 60) return m + ' m ' + String(rs).padStart(2, '0') + ' s';
  const hh = Math.floor(m / 60);
  return hh + ' h ' + String(m - hh * 60).padStart(2, '0') + ' m';
}

/**
 * A cost in its words: the catalog key that says its basis, and the amount (`$0.09`, `0.09 EUR`) when one was
 * recorded. `0` is printed only for a recorded zero price, never for an unobserved one.
 */
export function costWords(cost) {
  if (!cost) return { key: 'sentinel.viewer.absent.notRecorded', amount: '' };
  if (cost.basis === 'recorded') {
    const amount = cost.currency === 'USD' ? '$' + cost.amount : cost.amount + ' ' + cost.currency;
    return { key: 'sentinel.viewer.cost.recorded', amount };
  }
  return {
    key:
      cost.basis === 'unobserved'
        ? 'sentinel.viewer.cost.unobserved'
        : cost.basis === 'mixed'
          ? 'sentinel.viewer.cost.mixed'
          : 'sentinel.viewer.cost.none',
    amount: '',
  };
}

/** The chip class a stage or scan status draws with. */
export function statusClass(status) {
  return (
    {
      done: 'ok',
      completed: 'ok',
      reused: 'ok',
      running: 'run',
      pausing: 'run',
      canceling: 'run',
      planned: 'wait',
      waiting: 'wait',
      awaiting: 'wait',
      paused: 'wait',
      held: 'warn',
      'not-run': 'warn',
      canceled: 'warn',
      failed: 'err',
    }[status] || ''
  );
}

/** The status word's catalog key, for a stage or a scan. */
export function statusKey(status, scan = false) {
  if (scan) return 'sentinel.viewer.scanState.' + (status === 'awaiting' ? 'awaiting' : status);
  return 'sentinel.viewer.status.' + (status === 'not-run' ? 'notRun' : status);
}

/** The policy chip's class. */
export function policyClass(word) {
  return (
    {
      'sentinel.viewer.policy.notEvaluated': 'warn',
      'sentinel.viewer.policy.preview': 'warn',
      'sentinel.viewer.policy.incomplete': 'err',
      'sentinel.viewer.policy.failed': 'err',
      'sentinel.viewer.policy.inProgress': 'run',
      'sentinel.viewer.policy.stopped': 'warn',
    }[word] || ''
  );
}

/** The kind's chip: its word and the class that colours it (script amber, tool double copper, agent violet). */
export function kindChip(kind) {
  return { key: 'sentinel.viewer.kind.' + kind, cls: 'k-' + kind };
}

/** Where a stage ran, as its catalog key. */
export function whereKey(where) {
  return (
    {
      'in-process': 'sentinel.viewer.where.inProcess',
      child: 'sentinel.viewer.where.child',
      container: 'sentinel.viewer.where.container',
      external: 'sentinel.viewer.where.external',
      provider: 'sentinel.viewer.where.provider',
    }[where] || 'sentinel.viewer.where.notYet'
  );
}

/** The first 8 characters of a digest's hex (`sha256:1f…` → `1f…`); the business register never prints one. */
export function shortDigest(digest) {
  const m = /^(?:sha256:)?([0-9a-f]{8,})$/.exec(String(digest || ''));
  return m ? m[1].slice(0, 8) : '';
}

/**
 * A stage card's provenance line, as parts the surface joins with ` · `: plain text the code and hybrid registers
 * print (`[ {text}, … ]`). The business register prints none of it — a digest, an image, a model id and an adapter
 * are a developer's — and gets `[]`.
 */
export function provenanceParts(stage, lens) {
  if (lens === 'business' || !stage) return [];
  const p = stage.provenance || {};
  const impl = p.implementation || {};
  const parts = [];
  if (p.kind === 'agent') {
    if (p.provider) parts.push(p.provider.id);
    if (p.model) parts.push(p.model.reported || p.model.requested || '');
    else if (p.provider) parts.push(p.provider.model);
    if (p.prompt)
      parts.push('prompt ' + p.prompt.name + '/' + p.prompt.revision + ' (' + shortDigest(p.prompt.digest) + '…)');
    if (p.skills && p.skills.length) parts.push('skills ' + p.skills.map((s) => s.name + '/' + s.revision).join(', '));
  } else {
    if (impl.adapter) parts.push(impl.adapter + (impl.version ? ' ' + impl.version : ''));
    const image = p.invocation && p.invocation.image;
    if (image) parts.push(imageWords(image));
    else if (impl.digest) parts.push('digest ' + shortDigest(impl.digest));
  }
  return parts.filter(Boolean);
}

/**
 * A container image as its invocation record names it: the reference written, the image id actually run (shortened)
 * and its architecture — `ghcr.io/x/gitleaks:8.30.1 · 2f9c…  · arm64`.
 */
export function imageWords(image) {
  if (!image) return '';
  const id = shortDigest(image.id);
  return [image.reference, id ? id + '…' : '', image.architecture].filter(Boolean).join(' · ');
}

/** The stage ids of a scan answer by level, each level's stages in order; a level of two or more ran side by side. */
export function ladderRows(scan) {
  if (!scan || !Array.isArray(scan.stages)) return [];
  const byId = new Map(scan.stages.map((s) => [s.id, s]));
  return (scan.levels || []).map((ids) => ids.map((id) => byId.get(id)).filter(Boolean)).filter((row) => row.length);
}

/** The stage the PIPELINE dock shows: the picked one when the scan has it, else the running one, else the first agent, else the last. */
export function pickedStage(scan, pick) {
  const stages = (scan && scan.stages) || [];
  return (
    stages.find((s) => s.id === pick) ||
    stages.find((s) => s.status === 'running') ||
    stages.find((s) => s.kind === 'agent') ||
    stages[stages.length - 1] ||
    null
  );
}

/** Whether a scan answer is still moving (so the surface reads it again). */
export function scanLive(row) {
  return !!row && ['planned', 'running', 'pausing', 'canceling', 'awaiting'].includes(row.state);
}

/** The counts of a stage-status breakdown as `{ done, running, waiting, … }`. */
export function statusTally(counted) {
  const out = {};
  for (const p of (counted && counted.breakdown) || []) out[p.key.split('.').pop()] = p.n;
  return out;
}

/**
 * The Scan button's state, from the read model's `scanAction`, the session and the companion: `{ on, why }` where
 * `why` is the catalog key its tip says when it is off. Never a dead click: off is drawn greyed with its reason.
 */
export function scanState({ readOnly, companion, paired, action }) {
  if (readOnly) return { on: false, why: 'sys.readonly.control' };
  if (!companion) return { on: false, why: 'sentinel.ownerUi.launch' };
  if (!paired) return { on: false, why: 'sentinel.viewer.scan.pairing' };
  if (action && action.available === false)
    return { on: false, why: action.reasonCode || 'sentinel.viewer.scan.unavailable' };
  return { on: true, why: 'sentinel.viewer.scan.define' };
}

/** The outputs a ladder card shows: what a reader asks for (the snapshot, the graph, findings, coverage, observations). */
const PRIMARY_IO = new Set([
  'sentinel.viewer.io.snapshot',
  'sentinel.viewer.io.parsed',
  'sentinel.viewer.io.inventory',
  'sentinel.viewer.io.findings',
  'sentinel.viewer.io.coverage',
  'sentinel.viewer.io.observations',
  'sentinel.viewer.io.controls',
]);

/** A card's outputs: the primary ones when there are any, else everything; the dock lists all of them. */
export function cardOutputs(produces) {
  const list = produces || [];
  const primary = list.filter((io) => PRIMARY_IO.has(io.key));
  return primary.length ? primary : list;
}

/** The singular key for one, when the catalog has it (`{key}One`). */
export function pluralKey(key, n, has) {
  return n === 1 && has(key + 'One') ? key + 'One' : key;
}
