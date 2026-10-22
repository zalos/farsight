// The minimal preview report (PR 09): a run's shared Counted totals as JSON and Markdown, each with the scope it
// counts over and the command that re-checks it. It is labelled a foundation preview: it says nothing about scanner
// or framework coverage, and its limitations are printed with it. Rendering is pure: a report regenerates from its
// stored document alone, with no ledger, scan or source read. The full report arrives in PR 19.
import { SENTINEL_REPORT_STRINGS } from '@farsight/core/dist/strings-sentinel-report.js';
import { SENTINEL_SERVICE_STRINGS } from '@farsight/core/dist/strings-sentinel-service.js';
import type { ReportCount } from '../contracts/index.js';

export const PREVIEW_REPORT_SCHEMA = 'sentinel-preview-report/draft-1';

/** The scopes a preview report's counts may carry (core COUNT_SCOPES' Sentinel entries). */
const SCOPES = new Set(['sentinel.scope.report', 'sentinel.scope.inventory', 'sentinel.scope.finding']);
/** Always printed with a preview, whatever its counts say. */
export const PREVIEW_LIMITATIONS = Object.freeze(['sentinel.report.previewOnly', 'sentinel.report.noScannerCoverage'] as const);

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

export class ReportError extends Error {
  constructor(readonly code: 'sentinel.report.invalid', readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ReportError';
  }
}

const word = (key: string): string | undefined => SENTINEL_REPORT_STRINGS[key]?.professional ?? SENTINEL_SERVICE_STRINGS[key]?.professional;

/** Checks a preview document: its label, scopes, words and that every breakdown sums to its count. */
export function checkPreviewReport(doc: PreviewReport): PreviewReport {
  const bad = (d: string): never => { throw new ReportError('sentinel.report.invalid', d); };
  if (doc?.schema !== PREVIEW_REPORT_SCHEMA || doc.label !== 'foundation-preview') bad('not a preview report');
  if (!Number.isSafeInteger(doc.ledgerSequence) || doc.ledgerSequence < 0) bad('ledger sequence');
  for (const l of PREVIEW_LIMITATIONS) if (!doc.limitations.includes(l)) bad(`missing limitation ${l}`);
  for (const [i, c] of doc.counts.entries()) {
    if (!Number.isSafeInteger(c.n) || c.n < 0) bad(`count ${i}: n`);
    if (!SCOPES.has(c.scope)) bad(`count ${i}: scope ${c.scope}`);
    if (!word(c.unit) || !word(c.scope)) bad(`count ${i}: unit or scope has no catalog words`);
    if (c.of !== undefined && (!Number.isSafeInteger(c.of) || c.of < c.n)) bad(`count ${i}: of`);
    if (c.breakdown && c.breakdown.reduce((n, p) => n + p.n, 0) !== c.n) bad(`count ${i}: breakdown does not sum`);
    if (!c.recheck?.cli) bad(`count ${i}: no recheck command`);
  }
  return doc;
}

const fill = (template: string, values: Record<string, number | string>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? String(values[k]) : m));

function countLine(c: ReportCount): string {
  const singular = c.n === 1 ? word(`${c.unit}One`) : undefined;
  const text = fill(singular ?? word(c.unit)!, { n: c.n, m: c.of ?? '' });
  const parts = (c.breakdown ?? []).map(p => fill(word(p.key) ?? p.key, { n: p.n }));
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
    ...doc.limitations.map(l => `- ${word(l) ?? l}`),
    '',
  ].join('\n');
}
