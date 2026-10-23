// The SARIF 2.1.0 projection of a report document (PR 19, ADR 38). Findings only: the stable rule family is the
// `ruleId`, Sentinel's versioned issue fingerprint sits under its own `partialFingerprints` key (never GitHub's
// line hash), and producer observations stay attributable through properties. Withheld locations are not emitted;
// excerpts are never copied in. Platform limits are explicit: more results than a consumer accepts is a refusal,
// never a silent cut, and the complete report document stays authoritative.
import type { ReportEnvelope } from '../contracts/index.js';
import { ReportError } from './document.js';
import { wordOf, labelKey } from './words.js';

export const SARIF_LIMITS = Object.freeze({ maxResults: 25_000, displayedByGitHub: 5_000 });
const LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' } as const;

export function toSarif(doc: ReportEnvelope, options: { maxResults?: number } = {}): Record<string, unknown> {
  const max = options.maxResults ?? SARIF_LIMITS.maxResults;
  if (doc.findings.length > max) {
    throw new ReportError('sentinel.report.tooLarge', `${doc.findings.length} findings exceed the SARIF limit of ${max}; split the export or use the report document`);
  }
  const rules = [...new Set(doc.findings.map(f => f.ruleFamilyId))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Farsight Sentinel', informationUri: 'https://github.com/zalos/farsight', rules: rules.map(id => ({ id, shortDescription: { text: id } })) } },
      automationDetails: { id: `sentinel/${doc.run.id}` },
      results: doc.findings.map(f => {
        const located = f.evidence.filter(e => e.location);
        const loc = (e: (typeof located)[number]) => ({
          physicalLocation: {
            artifactLocation: { uri: e.location!.relativePath.split('/').map(encodeURIComponent).join('/'), uriBaseId: 'SRCROOT' },
            region: { startLine: e.location!.startLine, endLine: e.location!.endLine, byteOffset: e.location!.startByte, byteLength: e.location!.endByte - e.location!.startByte },
          },
        });
        return {
          ruleId: f.ruleFamilyId,
          ruleIndex: rules.indexOf(f.ruleFamilyId),
          level: LEVEL[f.severity],
          message: { text: `${f.title.code}: ${f.explanation.code}` },
          ...(located.length ? { locations: [loc(located[located.length - 1]!)] } : {}),
          ...(located.length > 1 ? { relatedLocations: located.slice(0, -1).map((e, i) => ({ id: i, ...loc(e) })) } : {}),
          ...(f.fingerprint ? { partialFingerprints: { 'sentinelIssue/exact/v1': f.fingerprint.exact, 'sentinelIssue/probable/v1': f.fingerprint.probable } } : {}),
          ...(f.comparison ? { baselineState: f.comparison === 'new' ? 'new' : f.comparison === 'persistent' ? 'unchanged' : 'updated' } : {}),
          properties: {
            sentinelFindingId: f.id, observationIds: f.observationIds, severity: f.severity,
            ...(f.comparison ? { comparison: f.comparison, comparisonText: wordOf(doc, labelKey(f.comparison), 'code') } : {}),
            ...(f.match ? { match: f.match } : {}),
            withheldEvidence: f.evidence.filter(e => e.state === 'withheld').length,
          },
        };
      }),
      properties: { ...(doc.decisions.length?{ownerDecisions:doc.decisions}:{}),reportId: doc.id, disclosure: doc.disclosure.profile, completeness: doc.completeness, coverageGaps: doc.gaps.length, ...(doc.inspections ? { inspections: doc.inspections, controlAnswers: doc.counts.controlAnswers } : {}), limits: SARIF_LIMITS },
    }],
  };
}
