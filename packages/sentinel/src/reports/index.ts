// Sentinel reports (PR 19, ADR 38): a pinned application context with its source-binding receipt, placement through
// Farsight's core folds, one versioned report document, and its JSON, Markdown, offline HTML and SARIF renderings.
// `generateReport` is the integration hook a CLI or service calls; it needs no Farsight server, bridge or network.
import { buildReport, type ReportInput } from './document.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { toSarif } from './sarif.js';
import { canonicalJson } from '@farsight/graph';

export { pinApplicationContext, contextPinIntent, PROJECTION_VERSION } from './context.js';
export type {
  ContextGraph,
  ContextInput,
  ContextRequest,
  ContextBinding,
  PinnedContext,
  PlaceReason,
} from './context.js';
export { placeFiles, placeNodes, unplaced } from './place.js';
export { buildReport, findingsOf, DISCLOSURE_PROFILES, REPORT_SOURCE, ReportError } from './document.js';
export type { BaselineFindingSummary, DisclosureProfile, PlannedCheck, ReportBuild, ReportInput } from './document.js';
export { renderMarkdown, md } from './markdown.js';
export { renderHtml, esc } from './html.js';
export { toSarif, SARIF_LIMITS } from './sarif.js';
export { countText, COUNT_ORDER } from './words.js';

/** Every rendering of one report, from one document. JSON is the document's canonical serialization. */
export async function generateReport(input: ReportInput) {
  const build = await buildReport(input);
  const { document } = build;
  return {
    ...build,
    json: canonicalJson(document),
    markdown: renderMarkdown(document),
    html: renderHtml(document),
    sarif: toSarif(document),
  };
}
