// lib/counted.js — print a typed count (core/counts.ts `Counted`) and give it
// its tip, the way docs/COUNTS.md §1 says to.
//
// A `Counted` arrives from the fold with its words, its scope and the field it
// came from, so a surface never chooses them: this module only picks the lens's
// words (`bizUnit` in the business lens — and when a count has none there, the
// business lens does not print it), fills the number in, and hands the rest to
// `numberTip()` — what it counts, over what, from where, and the breakdown whose
// parts add up to it. Numbers that are not typed yet (APIs, Changes, the code
// map) go through `plainTip()` with the same four answers written out.

import { S, esc, currentLens } from '../store.js';
import { t } from '../strings.js';
import { tipAttrs, tipSource } from './tooltip.js';

/** The singular key when the count is one and the catalog has one (`{key}One`). */
export function countKey(key, n) {
  return n === 1 && S.STRINGS && S.STRINGS[key + 'One'] ? key + 'One' : key;
}

/** `{n}`/`{m}` filled into a key's words in the register on screen. */
export function countWords(key, n, m) {
  return t(countKey(key, n)).split('{n}').join(String(n)).split('{m}').join(String(m != null ? m : ''));
}

/** The unit key the lens prints: `bizUnit` in business (absent → not printed there), `unit` elsewhere. */
export function countedUnit(c, lens) {
  if (!c) return '';
  return (lens || currentLens()) === 'business' ? (c.bizUnit || '') : c.unit;
}

/** The count in words for the lens on screen — `''` where the business lens does not print it. */
export function countedText(c, lens) {
  const key = countedUnit(c, lens);
  return key ? countWords(key, c.n, c.of) : '';
}

/**
 * The rows of a breakdown: one per part, the part's words without its number,
 * then the number in a cell of its own — so a reader (and a test) can add the
 * column up and meet the total.
 */
export function partRows(parts) {
  return (parts || []).map((p) => {
    const w = countWords(p.key, p.n).replace(String(p.n), '').replace(/\s{2,}/g, ' ').trim();
    return [p.label ? p.label + (w ? ' · ' + w : '') : w, p.n];
  });
}

/** `numberTip()` arguments for a `Counted`, from the endpoint that carried it. */
export function countedTipArgs(c, api) {
  const lens = currentLens();
  const of = countedUnit(c, lens) || c.unit;
  const src = tipSource(api);
  // the field it was read from is a developer's fact: the code and hybrid lenses carry it
  if (lens !== 'business' && c.source) src.note = c.source;
  const args = { count: c.n, of, vars: { m: c.of != null ? c.of : '' }, scope: c.scope, source: src };
  if (c.breakdown && c.breakdown.length) args.breakdown = { rows: partRows(c.breakdown) };
  return args;
}

/** The trigger attributes for a `Counted` — `tipAttrs({ number })`. */
export function countedAttrs(c, api, tipKey) {
  return tipAttrs({ number: countedTipArgs(c, api), tipKey });
}

/**
 * A `Counted` as a span that carries its tip, or `''` where the lens does not
 * print it. `words` overrides the printed words (a caption that already says
 * the unit, e.g. a tile's big number) while the tip keeps the count's own.
 */
export function countedHtml(c, api, opts = {}) {
  if (!c) return '';
  const words = opts.words != null ? opts.words : countedText(c);
  if (!words && words !== 0) return '';
  return '<span class="' + esc(opts.cls || 'cnt-n') + '"' + countedAttrs(c, api, opts.tipKey) + '>' + esc(String(words)) + '</span>';
}

/**
 * A detail's tip: the catalog word, its define and its Grammar Book entry — the
 * rich `defTip`, for a chip or a label a reader may not know (`verified · stale`,
 * `declared`, `floor`, an absence word, a kind badge). Replaces a `title`.
 */
export function defAttrs(key, tipKey) {
  return tipAttrs({ id: 'def', args: { key }, tipKey });
}

// `unCode()` — a fold's sentence with the code said in words — lives in store.js
// beside `bizName()`, which needs it too; this module hands it on to the surfaces.
export { unCode } from '../store.js';

/**
 * A number that is not typed yet, with the same four answers written out: the
 * catalog key that prints it (its define is *what it counts*), the scope key,
 * the endpoint, optional breakdown rows `[[words, n], …]`, the Grammar Book
 * entry, and any other placeholders the words carry (`{ m: 11 }`).
 */
export function plainTip(count, of, scope, api, rows, grammarKey, vars) {
  const args = { count, of, scope, source: tipSource(api) };
  if (vars) args.vars = vars;
  if (rows && rows.length) args.breakdown = { rows };
  if (grammarKey) args.grammarKey = grammarKey;
  return tipAttrs({ number: args });
}
