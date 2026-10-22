// Readable inspection lines from the canonical, already disclosed report section. No new verdict or coverage fold.
import type { ReportEnvelope } from '../contracts/index.js';
import { wordOf } from './words.js';
export function inspectionText(doc: ReportEnvelope): Array<{ source: string; lines: string[] }> {
  const word = (key: string) => wordOf(doc, key, 'business');
  const text = (key: string, values: Record<string, string>) => word(key).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) => Object.hasOwn(values, name) ? values[name]! : token);
  return (doc.inspections ?? []).map(i => ({ source: i.sourceId, lines: [word(i.limitationKey),
    ...i.libraries.map(l => text('sentinel.controls.libraryLine', { framework: l.framework, versions: l.versions.filter(v => v !== null).join(', ') || word('sentinel.controls.noVersion'), supported: Object.entries(l.supportedScope.versions).map(([framework, version]) => text('sentinel.controls.versionItem', { framework, version })).join('; ') || word('sentinel.controls.noVersion') })),
    ...i.checks.map(c => text('sentinel.controls.checkLine', { check: c.familyId, state: c.state, reasons: c.reasons.map(word).join('; ') })),
    ...i.rows.map(r => text('sentinel.controls.answerLine', { surface: r.surfaceId, property: r.property, answer: r.verdict ?? r.state, reason: r.reasonCode ? word(r.reasonCode) : '' })),
    ...i.frontiers.map(f => text('sentinel.controls.frontierLine', { scope: f.scopeId, reason: word(f.reasonCode) })),
  ] }));
}
