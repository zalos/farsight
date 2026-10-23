// The offline HTML rendering of a report document (PR 19, ADR 38). One self-contained file: inline styles, no script,
// no external resource of any kind, and a content security policy that refuses every load and script anyway, so the
// report reads the same with JavaScript disabled, with no network, without the source tree and without either product.
// Every untrusted string is escaped; navigation is internal anchors; a print stylesheet lays it out on paper; withheld
// evidence shows its reason in place, so a redacted report stays readable. Both registers are shown together.
import type { FindingPlace, ReportEnvelope, ReportEvidence } from '../contracts/index.js';
import { inspectionText } from './inspection.js';
import { COUNT_ORDER, countText, defineOf, wordOf, labelKey } from './words.js';

export function esc(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const anchor = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

// Only directives a <meta> policy honours: frame-ancestors, report-uri and sandbox are ignored there and make the
// browser log an error on every open, which a recipient would read as a broken file.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

const STYLE = `
:root{--ink:#14181f;--muted:#5b6473;--line:#d7dce4;--panel:#f5f7fa;--accent:#0b6e8a;--warn:#9a5b00}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#fff}
header,main,nav{max-width:1000px;margin:0 auto;padding:0 20px}header{padding-top:24px}h1{font-size:24px;margin:0 0 4px}
h2{font-size:19px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:16px;margin:0 0 6px}
.meta,.code{color:var(--muted)}.code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
nav ul{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0}nav a,a{color:var(--accent)}
.card{border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:12px 0;background:#fff;break-inside:avoid}
.sev{display:inline-block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:4px;background:var(--panel)}
.sev-critical,.sev-high{color:#a3271f}.sev-medium{color:var(--warn)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:8px 0}dt{color:var(--muted)}dd{margin:0}
pre{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.withheld{border:1px dashed var(--line);border-radius:4px;padding:6px 8px;color:var(--muted);background:var(--panel)}
ul.counts{padding-left:18px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);text-align:left;padding:4px 6px;vertical-align:top}
@media print{nav{display:none}body{font-size:11pt}a{color:inherit;text-decoration:none}.card{border-color:#999}h2{break-after:avoid}pre{white-space:pre-wrap}}
`;

function placeHtml(doc: ReportEnvelope, p: FindingPlace): string {
  const limits = p.limitationKeys.map(k => `<li>${esc(wordOf(doc, k, 'business'))} <span class="code">${esc(k)}</span></li>`).join('');
  const rows = [
    ...p.screens.map(s => `<li>Screen: ${esc(s.label.business)} <span class="code">${esc(s.label.code)}</span> — ${s.via === 'direct-use' ? 'uses it directly' : 'may be affected'}</li>`),
    ...p.journeys.map(j => `<li>Journey: ${esc(j.label.business)} <span class="code">${esc(j.label.code)}</span></li>`),
    ...p.personas.map(r => `<li>Person: ${esc(r.label.business)}${r.declared ? '' : ' (not declared)'}</li>`),
  ].join('');
  return `<dt>Placement</dt><dd>${esc(p.binding)}${rows ? `<ul>${rows}</ul>` : ''}${limits ? `<ul class="meta">${limits}</ul>` : ''}`
    + `<div class="meta">${esc(countText(doc, p.counts.screens, 'business'))}; ${esc(countText(doc, p.counts.journeys, 'business'))}; ${esc(countText(doc, p.counts.personas, 'business'))}</div></dd>`;
}

function evidenceHtml(doc: ReportEnvelope, e: ReportEvidence): string {
  const where = e.location ? `${esc(e.location.relativePath)}:${e.location.startLine}${e.location.endLine !== e.location.startLine ? `–${e.location.endLine}` : ''}` : 'location withheld';
  if (e.state === 'withheld') return `<div class="withheld" id="${anchor('evidence', e.id)}">Evidence <span class="code">${esc(e.id)}</span> at <span class="code">${where}</span> is withheld: ${esc(wordOf(doc, e.reasonCode, 'business'))}</div>`;
  return `<div id="${anchor('evidence', e.id)}"><div class="meta">Evidence <span class="code">${esc(e.id)}</span> at <span class="code">${where}</span></div><pre>${esc(e.excerpt)}</pre></div>`;
}

export function renderHtml(doc: ReportEnvelope): string {
  const counts = COUNT_ORDER.map(k => doc.counts[k]).filter(c => !!c).map(c => { const b = countText(doc, c!, 'business'), k = countText(doc, c!, 'code'); return `<li>${esc(b)}${k !== b ? `<div class="code">${esc(k)}</div>` : ''}</li>`; }).join('');
  const findings = doc.findings.map(f => `
<section class="card" id="${anchor('finding', f.id)}">
<h3><span class="sev sev-${esc(f.severity)}">${esc(wordOf(doc, `sentinel.report.severity.${f.severity}`, 'business'))}</span> ${esc(f.title.business)}</h3>
<div class="code">${esc(f.title.code)}</div>
<dl>
<dt>What it means</dt><dd>${esc(f.explanation.business)}</dd>
<dt>In code</dt><dd class="code">${esc(f.explanation.code)}</dd>
<dt>Rule family</dt><dd class="code">${esc(f.ruleFamilyId)}</dd>
${f.comparison ? `<dt>Against the baseline</dt><dd>${esc(wordOf(doc, labelKey(f.comparison), 'business'))}${f.comparisonReason ? ` — ${esc(wordOf(doc, f.comparisonReason, 'business'))}` : ''}${f.match ? ` <span class="code">${esc(f.match.kind)} match: ${f.match.baselineFindingIds.map(esc).join(', ')}</span>` : ''}</dd>` : ''}
<dt>Observations</dt><dd class="code">${f.observationIds.map(esc).join(', ')}</dd>
${placeHtml(doc, f.place)}
</dl>
${f.evidence.map(e => evidenceHtml(doc, e)).join('\n')}
</section>`).join('\n');
  const historical = doc.historical ? `<h2 id="historical">Baseline findings not continued</h2>${doc.historical.length ? '' : '<p>Every baseline finding is continued by a current finding.</p>'}${doc.historical.map(h => `
<section class="card" id="${anchor('historical', h.baselineFindingId)}">
<h3><span class="sev sev-${esc(h.severity)}">${esc(wordOf(doc, `sentinel.report.severity.${h.severity}`, 'business'))}</span> ${esc(h.title.business)}</h3>
<div class="code">${esc(h.title.code)}</div>
<dl><dt>Outcome</dt><dd>${esc(wordOf(doc, labelKey(h.label), 'business'))} — ${esc(wordOf(doc, h.reasonCode, 'business'))}</dd>
<dt>Rule family</dt><dd class="code">${esc(h.ruleFamilyId)}</dd>${placeHtml(doc, h.place)}</dl></section>`).join('\n')}` : '';
  const gaps = doc.gaps.length
    ? `<table><thead><tr><th>Check</th><th>Status</th><th>Why</th></tr></thead><tbody>${doc.gaps.map(g => `<tr id="${anchor('gap', g.checkId)}"><td class="code">${esc(g.checkId)}</td><td>${esc(g.status)}</td><td>${esc(g.explanation.business)}<div class="code">${esc(g.explanation.code)}</div></td></tr>`).join('')}</tbody></table>`
    : doc.completeness === 'complete' ? '<p>Every planned check covered its scope.</p>' : '<p>Every planned check recorded its scope, but some captured files were seen by no check or some folders were never listed: read the counts.</p>';
  const toc = doc.findings.map(f => `<li><a href="#${anchor('finding', f.id)}">${esc(f.title.business)}</a></li>`).join('');
  const definitions = (doc.definitions ?? []).map(d => `<tr id="${anchor('word', d.key)}"><td>${esc(d.text.business.replace('{n}', 'n').replace('{m}', 'm'))}<div class="code">${esc(d.key)}</div></td><td>${esc(defineOf(doc, d.key) ?? '')}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel report ${esc(doc.id)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Sentinel report</h1>
<div class="meta">Report <span class="code">${esc(doc.id)}</span> · run <span class="code">${esc(doc.run.id)}</span> · snapshot <span class="code">${esc(doc.run.snapshotId)}</span> · plan revision ${doc.run.planRevision} · as of ${esc(doc.evaluatedAt)} · ledger sequence ${doc.ledgerSequence}</div>
<div class="meta">Disclosure: ${esc(doc.disclosure.profile)} · completeness: ${esc(doc.completeness)}${doc.baseline ? ` · compared with <span class="code">${esc(doc.baseline.reportId)}</span>` : ''}</div>
</header>
<nav><ul><li><a href="#counts">Counts</a></li><li><a href="#findings">Findings</a></li>${doc.historical ? '<li><a href="#historical">Baseline findings</a></li>' : ''}<li><a href="#gaps">Gaps</a></li><li><a href="#words">Words</a></li></ul></nav>
<main>
<h2 id="counts">Counts</h2>
<ul class="counts">${counts}</ul>
<h2 id="findings">Findings</h2>
${doc.findings.length ? `<ul>${toc}</ul>${findings}` : '<p>No findings. Read the counts and gaps: no finding is not proof that nothing was missed.</p>'}
${historical}
${(doc.decisionEvaluation||doc.decisions.some(d=>d.evaluator==='sentinel-decision-evaluation/2'))?'<h2 id="decisions">'+esc(wordOf(doc,'sentinel.decision.reportHeading','business'))+'</h2><p>'+esc(wordOf(doc,'sentinel.decision.sourceOnly','business'))+'</p>'+(doc.decisionEvaluation?'<p>'+esc(wordOf(doc,doc.decisionEvaluation.reasonCode,'business'))+'</p>':'')+'<ul>'+doc.decisions.filter(d=>d.evaluator).map(d=>'<li>'+esc(d.dispositionId)+': '+esc(wordOf(doc,d.reasonCode!,'business'))+' ('+esc(d.validity)+')'+(d.rationale!==null&&d.rationale!==undefined?' — '+esc(d.rationale):'')+'</li>').join('')+'</ul>':''}
${doc.inspections?.length ? `<h2 id="inspections">${esc(wordOf(doc,'sentinel.controls.reportHeading','business'))}</h2>${inspectionText(doc).map(i=>`<section class="card"><h3>${esc(i.source)}</h3><ul>${i.lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul></section>`).join('')}` : ''}
<h2 id="gaps">Gaps in the checks</h2>
${gaps}
<h2 id="words">Words used in this report</h2>
<table><tbody>${definitions}</tbody></table>
</main>
</body>
</html>
`;
}
