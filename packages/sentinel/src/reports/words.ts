// Words for the renderers, read only from the report document's own definitions, so a rendering never consults the
// live catalog or the product: what a recipient reads is what the document pinned.
import type { ReportCount, ReportEnvelope } from '../contracts/index.js';

/** Which of a definition's two texts to read. */
export type Register = 'business' | 'code';

/**
 * The document's own text for a catalog key in one register, or the key itself when the document does not define it.
 */
export function wordOf(doc: ReportEnvelope, key: string, register: Register): string {
  const d = doc.definitions?.find((x) => x.key === key);
  return d ? d.text[register] : key;
}

/** The document's own definition of a catalog key, when it carries one. */
export function defineOf(doc: ReportEnvelope, key: string): string | undefined {
  return doc.definitions?.find((x) => x.key === key)?.define;
}

/** A count in words: the unit with {n} (and {m} for a denominator), then its scope, then its parts. */
export function countText(doc: ReportEnvelope, c: ReportCount, register: Register): string {
  const plural = register === 'business' && c.bizUnit ? c.bizUnit : c.unit;
  const unit = c.n === 1 && doc.definitions?.some((d) => d.key === `${plural}One`) ? `${plural}One` : plural;
  const fill = (t: string, n: number) => t.replace('{n}', String(n)).replace('{m}', String(c.of ?? ''));
  let text = fill(wordOf(doc, unit, register), c.n);
  if (!/\{n\}/.test(wordOf(doc, unit, register)) && !text.includes(String(c.n))) text = `${c.n} ${text}`;
  if (c.of !== undefined && !wordOf(doc, unit, register).includes('{m}')) text += ` of ${c.of}`;
  const parts = (c.breakdown ?? []).map((p) => fill(wordOf(doc, p.key, register), p.n));
  return `${text} ${wordOf(doc, c.scope, register)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** The counts every rendering prints, in one order, so their numbers are the document's. */
export const COUNT_ORDER = [
  'findings',
  'observations',
  'coverageGaps',
  'plannedChecks',
  'seenByNoStage',
  'unknownScopeBoundaries',
  'historical',
  'controlAnswers',
  'pathQueries',
  'reviewObservations',
] as const;

/** Catalog keys are camel-case: `changed-evidence` → `changedEvidence`. */
export const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
/** The catalog key of a comparison label's word. */
export const labelKey = (label: string) => `sentinel.compare.label.${camel(label)}`;
/** The catalog key of a comparison label's count part. */
export const labelPartKey = (label: string) => `sentinel.count.part.${camel(label)}`;
