// lib/compare-model.js — compare two syncs on a storyline, the pure part (round 2026-10-10, proposal 7).
//
// The Map's compare control, its chips and its panel read one answer, `GET /api/compare` (core storylineDiff over
// two syncs). Nothing here counts or compares: the deltas, their kinds, their sentences (catalog keys and their
// arguments), their doors and the per-journey chip counts all arrive typed from core. This module only reads the
// address (`?compare=<a>..<b>`), picks the chips a card or a stage carries, and turns a door into an address.

/** The five delta kinds, in the order core lists them (core storyline-diff.ts DELTA_KINDS). */
export const DELTA_KINDS = ['built', 'gate', 'writer', 'contract', 'verdict'];

/**
 * `?compare=<from>..<to>` → `{ from, to }`. `<to>` may be left out (`3..`, `last-green`): the served sync. `<from>`
 * is a sync, `previous`, a day, `tag:<name>` or `last-green`. null when the address names no comparison.
 * @param {string|null|undefined} raw the parameter's value
 */
export function parseCompare(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const at = v.indexOf('..');
  const from = (at < 0 ? v : v.slice(0, at)).trim() || 'previous';
  const to = (at < 0 ? '' : v.slice(at + 2)).trim() || 'now';
  return { from, to };
}

/** `{ from, to }` → the parameter's value; `now` is left out of the address. */
export function compareParam(spec) {
  if (!spec) return null;
  return spec.from + '..' + (spec.to && spec.to !== 'now' ? spec.to : '');
}

/** The value of `compare=` in a route's raw hash, or null. */
export function compareOfRaw(raw) {
  const m = /(?:^|[?&])compare=([^&]*)/.exec(String(raw || ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The query `/api/compare` is asked with. */
export function compareQuery(storyline, spec, repo) {
  const q = new URLSearchParams({ storyline, from: spec.from });
  if (spec.to && spec.to !== 'now') q.set('to', spec.to);
  if (repo) q.set('repo', repo);
  return '/api/compare?' + q.toString();
}

/**
 * The chips a journey's card carries: one per kind present, in kind order, each with the catalog key it prints with
 * (`compare.chip.*` in hybrid and code, `map.biz.compare.chip.*` in business), the number and the tone.
 * @param {{kinds:Record<string,{added:number,removed:number,changed:number}>, built?:{n:number,of:number}, verdict?:{from:string,to:string}}|undefined} entry
 * @param {boolean} biz
 * @returns {{kind:string, key:string, n:number, vars:Record<string,string|number>, tone:'up'|'down'|'warn'|'contract'}[]}
 */
export function chipsFor(entry, biz) {
  if (!entry) return [];
  const pre = biz ? 'map.biz.compare.chip.' : 'compare.chip.';
  const out = [];
  for (const kind of DELTA_KINDS) {
    const k = entry.kinds && entry.kinds[kind];
    if (!k) continue;
    if (kind === 'built') {
      const b = entry.built || { n: 0, of: 0 };
      out.push({
        kind,
        key: 'compare.chip.built.' + (k.added >= k.removed ? 'added' : 'removed'),
        n: k.added + k.removed,
        vars: { n: b.n, m: b.of },
        tone: k.added >= k.removed ? 'up' : 'down',
      });
    } else if (kind === 'verdict') {
      const v = entry.verdict || { from: '', to: '' };
      out.push({ kind, key: 'compare.chip.verdict', n: k.changed, vars: { from: v.from, to: v.to }, tone: 'warn' });
    } else {
      // gate · writer · contract: a chip for what was added and one for what was removed, a contract change apart
      if (k.added)
        out.push({
          kind,
          key: pre + kind + '.added' + (k.added === 1 ? 'One' : ''),
          n: k.added,
          vars: { n: k.added },
          tone: kind === 'contract' ? 'contract' : 'up',
        });
      if (k.removed)
        out.push({
          kind,
          key: pre + kind + '.removed' + (k.removed === 1 ? 'One' : ''),
          n: k.removed,
          vars: { n: k.removed },
          tone: 'down',
        });
      if (k.changed && kind === 'contract')
        out.push({ kind, key: pre + 'contract.changed', n: k.changed, vars: { n: k.changed }, tone: 'contract' });
    }
  }
  return out;
}

/**
 * The deltas a lanes stage card carries: those on its screen (the screen's name on that journey, else the name
 * alone — a lane draws a screen once), and a journey-wide delta (a verdict) on the journey's first stage.
 */
export function stageDeltas(diff, flow, name, firstOfJourney) {
  if (!diff) return [];
  return diff.deltas.filter((d) =>
    d.screen
      ? d.screen.name === name && (d.screen.flow === flow || d.journeys.includes(flow))
      : firstOfJourney && d.journeys.includes(flow),
  );
}

/** The per-kind count of a list of deltas, in the shape `chipsFor` reads (built and verdict carry what the card needs). */
export function entryOf(deltas, extra) {
  const kinds = {};
  for (const d of deltas) {
    const k = kinds[d.kind] || { added: 0, removed: 0, changed: 0 };
    k[d.change] += 1;
    kinds[d.kind] = k;
  }
  const v = deltas.find((d) => d.kind === 'verdict');
  return { kinds, ...(extra || {}), ...(v ? { verdict: v.chip || { from: v.from, to: v.to } } : {}) };
}

/**
 * A sentence in parts: the catalog template split at its placeholders, each argument marked when it is an
 * identifier (printed apart, in the code face). The business words carry no identifier by construction.
 * @param {string} template the template the catalog gave for the sentence's key
 * @param {{args:Record<string,string>, code?:string[]}} s
 * @returns {{text:string, code:boolean}[]}
 */
export function sentenceParts(template, s) {
  const parts = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(template))) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index), code: false });
    const v = s.args[m[1]];
    parts.push({ text: v == null ? '' : String(v), code: !!(s.code && s.code.includes(m[1])) });
    last = re.lastIndex;
  }
  if (last < template.length) parts.push({ text: template.slice(last), code: false });
  return parts.filter((p) => p.text);
}

/**
 * Where a delta's door opens, as a viewer address: the screen on its journey on the Map, the gate's card (the
 * code map selects the gate, whose card opens there), the writer on the code map, the journey's cases, the
 * operation on the APIs page.
 */
export function doorHref(door) {
  if (!door) return null;
  if (door.kind === 'screen' && door.flow)
    return '#/map/' + encodeURIComponent(door.flow) + '?screen=' + (door.screen || 1);
  if (door.kind === 'gate' && door.node) return '#/codemap?node=' + encodeURIComponent(door.node);
  if (door.kind === 'move' && door.node) return '#/codemap?node=' + encodeURIComponent(door.node);
  if (door.kind === 'cases' && door.flow) return '#/tests?flow=' + encodeURIComponent(door.flow);
  if (door.kind === 'contract' && door.node)
    return door.api
      ? '#/apis/' + encodeURIComponent(door.api) + '?op=' + encodeURIComponent(door.node)
      : '#/codemap?node=' + encodeURIComponent(door.node);
  return null;
}

/** The file-name subject of a saved comparison: `<storyline>-sync<a>-to-sync<b>`. */
export function compareSubject(storyline, from, to) {
  return (
    storyline +
    '-sync' +
    (from && from.sync != null ? from.sync : 'x') +
    '-to-sync' +
    (to && to.sync != null ? to.sync : 'x')
  );
}
