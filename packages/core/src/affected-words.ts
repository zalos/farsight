// The affected set and the readiness brief in words (round 2026-10-10, proposal 6): the lines the CLI
// prints, the pull-request comment carries (markdown) and MCP `affected` answers with — one printer, so the
// three cannot word one document three ways. Hybrid register words, from the catalog; numbers via countedText.
import { t } from './strings.js';
import { countedText } from './counts.js';
import type { AffectedV1 } from './affected.js';
import type { Readiness } from './readiness.js';

const R = 'professional' as const;
const say = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key, R));

const day = (at: string | null | undefined) => (at ? at.slice(0, 10) : '—');

/** The document in words — `md` writes the comment's markdown. */
export function affectedLines(doc: AffectedV1, md = false): string[] {
  const out: string[] = [];
  const b = (s: string) => (md ? `**${s}**` : s.toUpperCase());
  const code = (s: string) => (md ? `\`${s.replace(/`/g, "'")}\`` : s);
  const cap = md ? 25 : 60;
  const id = doc.identity;
  const head = doc.range.pr
    ? `${say('affected.title.pr')} · #${doc.range.pr.number}${doc.range.pr.title ? ` ${doc.range.pr.title}` : ''}`
    : `${say('affected.title.range')} · ${doc.range.from?.slice(0, 7)}..${doc.range.to?.slice(0, 7)}`;
  out.push(md ? `### ${head}` : head);
  out.push(`${doc.range.repo}${id.sync != null ? ` · sync ${id.sync}` : ''}${id.source_commit ? ` · commit ${id.source_commit.slice(0, 7)}` : ''} · ${id.farsight}`);
  out.push(`${countedText(doc.counted.commits, { scope: false })} · ${countedText(doc.counted.files, { scope: false })} · ${countedText(doc.counted.changed, { scope: false })}${doc.bound === 'floor' ? ' · a floor' : ''}`);
  out.push('');
  out.push(`${b(say('affected.head.journeys'))} — ${countedText(doc.counted.journeys)} · ${countedText(doc.counted.screens, { scope: false })}`);
  if (!doc.journeys.length) out.push(`  ${say('affected.none.journeys')}`);
  for (const j of doc.journeys.slice(0, cap)) {
    const where = j.storylines.map((s) => (s.branch_of
      ? say('affected.storyline.branch', { name: doc.journeys.find((x) => x.id === s.branch_of)?.name ?? s.branch_of.split('::').pop()! }) + ` · ${s.name}`
      : say('affected.storyline.step', { n: s.step, m: s.of, name: s.name }))).join(' · ');
    const screens = j.screens.map((s) => s.name).filter((x, i, arr) => arr.indexOf(x) === i).join(', ');
    out.push(`${md ? '- ' : '  '}${md ? `**${j.name}**` : j.name} · ${j.hop === 0 ? say('affected.hop.self') : say('affected.hop.far', { n: j.hop })}${where ? ` · ${where}` : ''}${screens ? ` · ${screens}` : ''}`);
  }
  if (doc.journeys.length > cap) out.push(`  ${say('affected.more', { n: doc.journeys.length - cap })}`);
  out.push('');
  out.push(b(say('affected.head.path')));
  if (!doc.gates.length && !doc.writes.length && !doc.contracts.length) out.push(`  ${say('affected.none.path')}`);
  if (doc.gates.length) out.push(`${md ? '- ' : '  '}${say('affected.head.gates')} (${countedText(doc.counted.gates, { scope: false })}): ${doc.gates.slice(0, 12).map((g) => code(g.name)).join(' · ')}${doc.gates.length > 12 ? ' ' + say('affected.more', { n: doc.gates.length - 12 }) : ''}`);
  for (const w of doc.writes.slice(0, 12)) {
    const moves = w.moves.length
      ? w.moves.map((m) => (m.from ? say('affected.moves', { from: m.from, to: m.to, writer: code(w.writer_name) }) : say('affected.movesAny', { to: m.to, writer: code(w.writer_name) }))).join(' · ')
      : say('affected.writes', { writer: code(w.writer_name) });
    out.push(`${md ? '- ' : '  '}${say('affected.head.writes')}: ${code(w.name)}${w.store ? ` (${w.store})` : ''} · ${moves}`);
  }
  if (doc.contracts.length) out.push(`${md ? '- ' : '  '}${say('affected.head.calls')}: ${doc.contracts.slice(0, 12).map((c) => `${code(c.name)}${c.contract ? ` · ${c.contract}` : ''}`).join(' · ')}${doc.contracts.length > 12 ? ' ' + say('affected.more', { n: doc.contracts.length - 12 }) : ''}`);
  out.push('');
  out.push(`${b(say('affected.head.tests'))} — ${countedText(doc.counted.tests)}`);
  if (!doc.tests.length) out.push(`  ${say('affected.none.tests')}`);
  if (md && doc.tests.length) { out.push('', '| case | where | its own last run |', '|---|---|---|'); }
  for (const x of doc.tests.slice(0, cap)) {
    const where = `${x.file}${x.line != null ? `:${x.line}` : ''}`;
    const run = x.status ? `${x.status} ${day(x.at)}` : t('count.part.noRun', R).replace('{n} ', '');
    out.push(md ? `| ${x.title.replace(/\|/g, '/')} | \`${where}\` | ${run}${x.inactive ? ' · .skip' : ''} |` : `  ${where.padEnd(52)} ${x.title.slice(0, 60).padEnd(60)} ${run}`);
  }
  if (doc.tests.length > cap) out.push(`${md ? '\n' : '  '}${say('affected.more', { n: doc.tests.length - cap })}`);
  out.push('');
  const v = doc.verdict;
  out.push(v.last_run
    ? say('affected.verdict', { passed: v.passed, skipped: v.skipped, failed: v.failed, date: day(v.last_run), since: v.commits_since ?? '?' })
    : say('affected.verdict.noRun'));
  return out;
}

export function readinessLines(r: Readiness): string[] {
  const out: string[] = [];
  out.push(`${r.storyline.name} · ${countedText(r.counted.steps)}`);
  out.push(`${countedText(r.counted.ship, { scope: false })} · ${countedText(r.counted.hold, { scope: false })} · ${countedText(r.counted.skipped, { scope: false })} · ${countedText(r.counted.unreached, { scope: false })}`);
  out.push('');
  for (const x of r.rows) {
    const verdict = x.verdict ? t(x.verdict.word.key, R) : '—';
    out.push(`${x.label.padEnd(4)} ${x.name}${x.branchOf ? ` (branch of ${x.branchOf.name} · ${x.branchOf.when})` : ''}`);
    out.push(`     built ${x.built.n} of ${x.built.of} · ${verdict} · last run ${day(x.lastRun)} · ${x.skipped} skipped · ${x.unrun} never run · gates no test is known to reach ${x.gates.unreached.length} of ${x.gates.n} · commits since green ${x.commitsSince ?? '—'}`);
    out.push(`     ${x.ship ? 'SHIP' : 'HOLD — ' + x.hold.map((h) => t(`readiness.hold.${h}`, R)).join(' · ')}`);
  }
  out.push('');
  out.push(countedText(r.counted.rules));
  for (const g of r.rules) out.push(`  ${g.name.padEnd(40)} ${(g.words ?? '—').slice(0, 60).padEnd(60)} ${g.screens} screens · ${g.tests} cases · ${g.owners.join(', ') || 'owner not declared'}`);
  return out;
}

