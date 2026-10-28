// The Markdown rendering of a report document (PR 19, ADR 38): the same scope, counts and facts as the document, both
// registers, every finding with its place, comparison and evidence, every gap, and the definitions. Untrusted text is
// escaped; excerpts are fenced with a fence longer than any backtick run inside them, so source cannot end the block.
import type { ReportEnvelope, ReportEvidence, FindingPlace, Provenance } from '../contracts/index.js';
import { structuralText } from './structural-paths.js';
import { inspectionText } from './inspection.js';
import { COUNT_ORDER, countText, wordOf, defineOf, labelKey } from './words.js';

/** Escapes Markdown control characters and strips anything that could start HTML. */
export function md(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- Strip controls that could alter Markdown rendering, preserving tabs and newlines.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/([\\`*_{}[\]()#+\-.!|>~])/g, '\\$1')
      .replace(/</g, '&lt;')
      .replace(/\r?\n/g, ' ')
  );
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  // eslint-disable-next-line no-control-regex -- Fenced report text strips nonprinting controls while retaining tabs and newlines.
  return `${f}text\n${text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')}\n${f}`;
}

const anchor = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

function placeLines(doc: ReportEnvelope, p: FindingPlace): string[] {
  const out = [
    `- **Placement:** ${md(p.binding)}${p.limitationKeys.length ? ` (${p.limitationKeys.map((k) => md(wordOf(doc, k, 'business'))).join('; ')})` : ''}`,
  ];
  for (const s of p.screens)
    out.push(
      `  - Screen: ${md(s.label.business)} (${md(s.label.code)}), ${s.via === 'direct-use' ? 'uses it directly' : 'may be affected'}`,
    );
  for (const j of p.journeys) out.push(`  - Journey: ${md(j.label.business)} (${md(j.label.code)})`);
  for (const r of p.personas) out.push(`  - Person: ${md(r.label.business)}${r.declared ? '' : ' (not declared)'}`);
  out.push(
    `  - ${md(countText(doc, p.counts.screens, 'business'))}; ${md(countText(doc, p.counts.journeys, 'business'))}; ${md(countText(doc, p.counts.personas, 'business'))}`,
  );
  return out;
}

function evidenceLines(doc: ReportEnvelope, e: ReportEvidence): string[] {
  const where = e.location
    ? `${md(e.location.relativePath)}:${e.location.startLine}${e.location.endLine !== e.location.startLine ? `-${e.location.endLine}` : ''}`
    : 'location withheld';
  if (e.state === 'withheld')
    return [`- Evidence ${md(e.id)} at ${where}: withheld (${md(wordOf(doc, e.reasonCode, 'business'))})`];
  return [`- Evidence ${md(e.id)} at ${where}:`, '', fence(e.excerpt), ''];
}

const short = (d: string | null | undefined) => (d ? d.replace(/^sha256:/, '').slice(0, 12) : 'unknown');

/** One provenance record as one line of words: what ran, where, for how long, and for a model its tokens and cost. */
export function provenanceLine(doc: ReportEnvelope, p: Provenance): string {
  const where = wordOf(doc, `sentinel.report.provenance.where.${p.where}`, 'business');
  const took = p.durationMs === null ? '' : ` · ${p.durationMs} ms`;
  const head = `${p.stage} (${p.unit.id}) · ${where}`;
  switch (p.kind) {
    case 'builtin':
      return `${head} · Sentinel ${p.operation} · module ${short(p.moduleDigest)} · ${p.sentinelVersion}${took}`;
    case 'tool':
      return `${head} · ${p.adapterId} ${p.adapterVersion}${p.image ? ` · image ${p.image.reference}` : ''}${p.rules.length ? ` · ${p.rules.length} rules` : ''}${took}`;
    case 'script':
      return `${head} · ${p.interpreter.name} ${p.interpreter.version} · entry ${short(p.entryDigest)} · ${p.argv.join(' ')}${p.outputSchema ? ` · output ${p.outputSchema.id}` : ''}${took}`;
    case 'agent': {
      const tokens =
        p.tokens.input === null && p.tokens.output === null
          ? 'tokens unknown'
          : `${p.tokens.input ?? '?'} tokens in · ${p.tokens.output ?? '?'} out (${p.tokens.certainty})`;
      const cost =
        p.cost.basis === 'rates'
          ? `${p.cost.amount} ${p.cost.currency} · ${wordOf(doc, 'sentinel.report.provenance.cost.rates', 'business')}`
          : wordOf(doc, `sentinel.report.provenance.cost.${p.cost.reason}`, 'business');
      return `${head} · ${p.runner} ${p.mode} · model ${p.model.requested}${p.model.reported && p.model.reported !== p.model.requested ? ` (reported ${p.model.reported})` : ''} · ${p.turns} turns · ${tokens} · ${cost}${took}`;
    }
  }
}

/** The severities a finding can carry; a model's claim carries none of them unless it was rated. */
export const RATED: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'info']);

/** The review section's lines for one observation, before its evidence. */
export function reviewLines(doc: ReportEnvelope, r: NonNullable<ReportEnvelope['reviews']>[number]): string[] {
  return [
    `${r.stage} · ${wordOf(doc, RATED.has(r.severity) ? `sentinel.report.severity.${r.severity}` : 'sentinel.report.review.unrated', 'business')} · ${wordOf(doc, 'sentinel.report.review.model', 'business')} ${r.model.requestedModel}${r.model.returnedModel && r.model.returnedModel !== r.model.requestedModel ? ` (reported ${r.model.returnedModel})` : ''} · ${r.model.source}`,
    ...(r.ruleFamilyId ? [`rule family ${r.ruleFamilyId}`] : []),
    ...(r.message !== undefined ? [r.message] : []),
    `observation ${r.id} · prompt ${short(r.promptDigest)}`,
  ];
}

/**
 * Renders a report document as Markdown with the document's counts, findings, comparison, decisions, inspections,
 * structural paths, gaps and definitions. Untrusted text is escaped and excerpts are fenced so source cannot end the
 * block.
 */
export function renderMarkdown(doc: ReportEnvelope): string {
  const lines: string[] = [];
  lines.push(`# Sentinel report ${md(doc.id)}`, '');
  lines.push(
    `Run ${md(doc.run.id)} of snapshot ${md(doc.run.snapshotId)}, plan revision ${doc.run.planRevision}, as of ${md(doc.evaluatedAt)} (ledger sequence ${doc.ledgerSequence}).`,
  );
  lines.push(
    `Disclosure: ${md(doc.disclosure.profile)}. Completeness: ${md(doc.completeness)}.${doc.baseline ? ` Compared with report ${md(doc.baseline.reportId)}.` : ''}`,
    '',
  );
  lines.push('## Counts', '');
  for (const k of COUNT_ORDER) {
    const c = doc.counts[k];
    if (c) lines.push(`- ${md(countText(doc, c, 'business'))}`);
  }
  lines.push('', '## Findings', '');
  if (!doc.findings.length)
    lines.push('No findings. Read the counts and gaps above: no finding is not proof that nothing was missed.', '');
  for (const f of doc.findings) {
    lines.push(`### <a id="${anchor('finding', f.id)}"></a>${md(f.title.business)}`, '');
    lines.push(
      `- **Code:** ${md(f.title.code)}`,
      `- **Severity:** ${md(wordOf(doc, `sentinel.report.severity.${f.severity}`, 'business'))}`,
      `- **Rule family:** ${md(f.ruleFamilyId)}`,
    );
    lines.push(`- **What it means:** ${md(f.explanation.business)}`, `- **In code:** ${md(f.explanation.code)}`);
    if (f.comparison)
      lines.push(
        `- **Compared with the baseline:** ${md(wordOf(doc, labelKey(f.comparison), 'business'))}${f.comparisonReason ? ` (${md(wordOf(doc, f.comparisonReason, 'business'))})` : ''}${f.match ? `; ${md(f.match.kind)} match with ${f.match.baselineFindingIds.map(md).join(', ')}` : ''}`,
      );
    lines.push(`- **Observations:** ${f.observationIds.map(md).join(', ')}`);
    lines.push(...placeLines(doc, f.place));
    for (const e of f.evidence) lines.push(...evidenceLines(doc, e));
    lines.push('');
  }
  if (doc.historical) {
    lines.push('## Baseline findings not continued', '');
    if (!doc.historical.length) lines.push('Every baseline finding is continued by a current finding.', '');
    for (const h of doc.historical) {
      lines.push(`### <a id="${anchor('historical', h.baselineFindingId)}"></a>${md(h.title.business)}`, '');
      lines.push(
        `- **Outcome:** ${md(wordOf(doc, labelKey(h.label), 'business'))} (${md(wordOf(doc, h.reasonCode, 'business'))})`,
        `- **Code:** ${md(h.title.code)}`,
        `- **Rule family:** ${md(h.ruleFamilyId)}`,
      );
      lines.push(...placeLines(doc, h.place), '');
    }
  }
  if (doc.decisionEvaluation || doc.decisions.some((d) => d.evaluator === 'sentinel-decision-evaluation/2')) {
    lines.push(
      '## ' + md(wordOf(doc, 'sentinel.decision.reportHeading', 'business')),
      '',
      md(wordOf(doc, 'sentinel.decision.sourceOnly', 'business')),
      '',
    );
    if (doc.decisionEvaluation) lines.push(md(wordOf(doc, doc.decisionEvaluation.reasonCode, 'business')), '');
    for (const d of doc.decisions)
      if (d.evaluator)
        lines.push(
          '- ' +
            md(d.dispositionId) +
            ': ' +
            md(wordOf(doc, d.reasonCode!, 'business')) +
            ' (' +
            md(d.validity) +
            ')' +
            (d.rationale !== null && d.rationale !== undefined ? ' — ' + md(d.rationale) : ''),
        );
    lines.push('');
  }
  if (doc.inspections?.length) {
    lines.push(`## ${md(wordOf(doc, 'sentinel.controls.reportHeading', 'business'))}`, '');
    for (const i of inspectionText(doc)) lines.push(`### ${md(i.source)}`, '', ...i.lines.map((l) => `- ${md(l)}`), '');
  }
  if (doc.structuralPaths?.length) {
    lines.push(`## ${md(wordOf(doc, 'sentinel.paths.report.heading', 'business'))}`, '');
    for (const p of structuralText(doc)) lines.push(`### ${md(p.source)}`, '', ...p.lines.map((l) => `- ${md(l)}`), '');
  }
  if (doc.reviews) {
    lines.push(`## ${md(wordOf(doc, 'sentinel.report.review.heading', 'business'))}`, '');
    lines.push(
      `${md(wordOf(doc, 'sentinel.report.review.proposed', 'business'))}.${doc.counts.reviewObservations ? ` ${md(countText(doc, doc.counts.reviewObservations, 'business'))}.` : ''}`,
      '',
    );
    for (const r of doc.reviews) {
      lines.push(`### <a id="${anchor('review', r.id)}"></a>${md(reviewLines(doc, r)[0]!)}`, '');
      for (const l of reviewLines(doc, r).slice(1)) lines.push(`- ${md(l)}`);
      for (const e of r.evidence) lines.push(...evidenceLines(doc, e));
      lines.push('');
    }
  }
  if (doc.provenance) {
    lines.push(`## ${md(wordOf(doc, 'sentinel.report.provenance.heading', 'business'))}`, '');
    for (const p of doc.provenance) lines.push(`- ${md(provenanceLine(doc, p))}`);
    lines.push('');
  }
  lines.push('## Gaps in the checks', '');
  if (!doc.gaps.length)
    lines.push(
      doc.completeness === 'complete'
        ? 'Every planned check covered its scope.'
        : 'Every planned check recorded its scope, but some captured files were seen by no check or some folders were never listed: read the counts.',
      '',
    );
  for (const g of doc.gaps)
    lines.push(
      `- <a id="${anchor('gap', g.checkId)}"></a>${md(g.checkId)}: ${md(g.status)}; ${md(g.explanation.business)}`,
    );
  lines.push('', '## Words used in this report', '');
  for (const d of doc.definitions ?? [])
    lines.push(
      `- **${md(d.text.business.replace('{n}', 'n').replace('{m}', 'm'))}** (${md(d.key)}): ${md(defineOf(doc, d.key) ?? '')}`,
    );
  lines.push('');
  return lines.join('\n');
}
