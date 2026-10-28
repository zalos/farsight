// The minimal preview report (PR 09): a run's shared Counted totals as JSON and Markdown, each with the scope it
// counts over and the command that re-checks it. It is labelled a foundation preview: it says nothing about scanner
// or framework coverage, and its limitations are printed with it. Rendering is pure: a report regenerates from its
// stored document alone, with no ledger, scan or source read. The full report arrives in PR 19.
import { countedProblems } from '@farsight/core/dist/counts.js';
import { STRINGS } from '@farsight/core/dist/strings.js';
import type { ReportCount } from '../contracts/index.js';

/** The schema id of the minimal preview report. */
export const PREVIEW_REPORT_SCHEMA = 'sentinel-preview-report/draft-1';

/** The scopes a preview report's counts may carry (core COUNT_SCOPES' Sentinel entries). */
const SCOPES = new Set(['sentinel.scope.report', 'sentinel.scope.inventory', 'sentinel.scope.finding']);
/** Always printed with a preview, whatever its counts say. */
export const PREVIEW_LIMITATIONS = Object.freeze([
  'sentinel.report.previewOnly',
  'sentinel.report.noScannerCoverage',
] as const);

/**
 * The minimal preview report: a run's Counted totals at one committed ledger sequence, labelled a foundation preview,
 * with the limitations always printed with it.
 */
export interface PreviewReport {
  readonly schema: typeof PREVIEW_REPORT_SCHEMA;
  readonly label: 'foundation-preview';
  readonly runId: string;
  readonly snapshotId: string;
  /** The committed ledger sequence the counts were read at. */
  readonly ledgerSequence: number;
  readonly generatedAt: string;
  readonly counts: readonly ReportCount[];
  readonly limitations: readonly string[];
}

/**
 * A preview document `checkPreviewReport` refuses: code `sentinel.report.invalid`, with the failing check as its
 * detail.
 */
export class ReportError extends Error {
  constructor(
    readonly code: 'sentinel.report.invalid',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ReportError';
  }
}

// The same catalog countedProblems checks against, so a count it accepts always has its words.
const word = (key: string): string | undefined => STRINGS[key]?.professional;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const KNOWN_LIMITATIONS = new Set<string>(PREVIEW_LIMITATIONS);

/**
 * Checks a preview document before anything renders from it, stored or new: its exact fields and label, its
 * limitations, and every count through core's own `countedProblems` (catalog words with {n}, a known scope, a
 * source, a breakdown of catalog parts that sums) plus whole, non-negative parts. Anything else is refused.
 */
export function checkPreviewReport(doc: PreviewReport): PreviewReport {
  const bad = (d: string): never => {
    throw new ReportError('sentinel.report.invalid', d);
  };
  if (!isRecord(doc)) bad('not an object');
  const only = (o: Record<string, unknown>, keys: string[], what: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${what} has an unknown field ${k}`);
  };
  only(
    doc as unknown as Record<string, unknown>,
    ['schema', 'label', 'runId', 'snapshotId', 'ledgerSequence', 'generatedAt', 'counts', 'limitations'],
    'the report',
  );
  if (doc.schema !== PREVIEW_REPORT_SCHEMA || doc.label !== 'foundation-preview') bad('not a preview report');
  if (typeof doc.runId !== 'string' || typeof doc.snapshotId !== 'string' || typeof doc.generatedAt !== 'string')
    bad('identity');
  if (!Number.isSafeInteger(doc.ledgerSequence) || doc.ledgerSequence < 0) bad('ledger sequence');
  if (
    !Array.isArray(doc.limitations) ||
    doc.limitations.some((l) => typeof l !== 'string' || !KNOWN_LIMITATIONS.has(l))
  )
    bad('limitations');
  for (const l of PREVIEW_LIMITATIONS) if (!doc.limitations.includes(l)) bad(`missing limitation ${l}`);
  if (!Array.isArray(doc.counts) || doc.counts.length > 64) bad('counts');
  doc.counts.forEach((c, i) => {
    if (!isRecord(c)) bad(`count ${i} is not an object`);
    only(
      c as unknown as Record<string, unknown>,
      ['n', 'of', 'unit', 'bizUnit', 'scope', 'source', 'breakdown', 'recheck'],
      `count ${i}`,
    );
    if (!SCOPES.has(c.scope)) bad(`count ${i}: scope ${String(c.scope)}`);
    if (c.breakdown !== undefined) {
      if (!Array.isArray(c.breakdown)) bad(`count ${i}: breakdown`);
      c.breakdown.forEach((p, j) => {
        if (!isRecord(p) || typeof p.key !== 'string' || !Number.isSafeInteger(p.n) || p.n < 0)
          bad(`count ${i}: part ${j} is not a whole, non-negative part`);
        only(p as unknown as Record<string, unknown>, ['key', 'n', 'label'], `count ${i} part ${j}`);
      });
    }
    const problems = countedProblems(c as never, `count ${i}`);
    if (problems.length) bad(problems[0]!);
    if (!isRecord(c.recheck) || typeof c.recheck.cli !== 'string' || !c.recheck.cli)
      bad(`count ${i}: no recheck command`);
  });
  return doc;
}

const fill = (template: string, values: Record<string, number | string>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? String(values[k]) : m));

function countLine(c: ReportCount): string {
  const singular = c.n === 1 ? word(`${c.unit}One`) : undefined;
  const text = fill(singular ?? word(c.unit)!, { n: c.n, m: c.of ?? '' });
  const parts = (c.breakdown ?? []).map((p) => fill(word(p.key) ?? p.key, { n: p.n }));
  return `- ${text} ${word(c.scope)}${parts.length ? ` (${parts.join(', ')})` : ''} — re-check: \`${c.recheck!.cli}\``;
}

/** The JSON form: the document itself, after checking. */
export function renderPreviewJson(doc: PreviewReport): string {
  return `${JSON.stringify(checkPreviewReport(doc), null, 2)}\n`;
}

/** The Markdown form, readable without Sentinel: the preview label and limitations first, then each count. */
export function renderPreviewMarkdown(doc: PreviewReport): string {
  checkPreviewReport(doc);
  return [
    `# ${word('sentinel.report.previewTitle')}`,
    '',
    `> ${word('sentinel.report.previewOnly')}`,
    '',
    `- run \`${doc.runId}\` · snapshot \`${doc.snapshotId}\` · ledger sequence ${doc.ledgerSequence} · ${doc.generatedAt}`,
    '',
    `## ${word('sentinel.report.countsHeading')}`,
    '',
    ...doc.counts.map(countLine),
    '',
    `## ${word('sentinel.report.limitationsHeading')}`,
    '',
    ...doc.limitations.map((l) => `- ${word(l) ?? l}`),
    '',
  ].join('\n');
}
