// Every rendering reads the same authenticated and privacy-projected section; no additional search or verdict fold.
import type { ReportEnvelope } from '../contracts/index.js';
import { wordOf, camel } from './words.js';
export function structuralText(doc: ReportEnvelope): Array<{ source: string; lines: string[] }> {
  const word = (key: string) => wordOf(doc, key, 'business');
  const text = (key: string, values: Record<string, string>) =>
    word(key).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) =>
      Object.hasOwn(values, key) ? values[key]! : token,
    );
  return (doc.structuralPaths ?? []).map((p) => ({
    source: p.sourceId,
    lines: [
      word(p.statementKey),
      word(p.limitationKey),
      ...(p.detailLoss ? [word(p.detailLoss)] : []),
      ...p.evidence.results.flatMap((r) => [
        text('sentinel.paths.report.queryLine', {
          from: r.from,
          to: r.to,
          outcome: word(`sentinel.paths.report.${camel(r.outcome)}`),
        }),
        ...r.frontierReasons.map(word),
        ...r.paths.flatMap((path) =>
          path.steps.map((step) =>
            text('sentinel.paths.report.stepLine', {
              from: step.from,
              to: step.to,
              kind: step.kind,
              sites: step.sites.map((s) => `${s.relativePath}:${s.span.startByte}-${s.span.endByte}`).join('; '),
            }),
          ),
        ),
      ]),
    ],
  }));
}
