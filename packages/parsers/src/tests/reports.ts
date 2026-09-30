/**
 * Observed evidence: reading test reports that were produced elsewhere
 * (docs/proposals/tests-surface.md §3.2 step 5). Farsight never runs tests —
 * it reads what a run left behind, fail-soft, and says how fresh it is.
 *
 * Attribution honesty (swarm review 2026-09-14 §3-C.2): istanbul coverage has
 * no per-test attribution, so its edges hang off a synthetic run-level `test`
 * node and every consumer says *reached by the unit run*, never *by this test*.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { TestRun } from '@farsight/core';
import { testGlobToRegExp } from './cases.js';

const SKIP = new Set(['node_modules', '.git', '.nx', 'dist', 'build', 'target', 'tmp']);
const MAX_BYTES = 64 * 1024 * 1024;

/** Files under the repo matching a repo-relative glob. Descends into `coverage/` and `test-results/`, which the source walk skips. */
export function findReports(repoRoot: string, glob: string): string[] {
  const re = testGlobToRegExp(glob.replace(/^\.\//, ''));
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const abs = join(dir, entry);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (!entry.startsWith('.') || entry === '.coverage') visit(abs, depth + 1); continue; }
      if (re.test(relative(repoRoot, abs))) out.push(abs);
    }
  };
  visit(repoRoot, 0);
  return out.sort();
}

/** One case as a report recorded it. `fullName` is what joins it to a `test` node. */
export interface ObservedCase {
  file?: string;
  suite: string[];
  title: string;
  fullName: string;
  status: TestRun['status'];
  durationMs?: number;
  /** the runner's project (Playwright project, Nx/vitest project) — one row per case per project */
  project?: string;
  /** retries the reporter recorded before this verdict (Playwright: results.length - 1) */
  retries?: number;
}

/** One function/component a coverage report saw execute. */
export interface CoverageHit {
  /** repo-relative source path */
  path: string;
  name: string;
  /** declaration line, 1-based */
  line: number;
  /** statements/lines recorded as hit inside it */
  lines: number;
}

export interface ReadReport {
  /** repo-relative report path */
  path: string;
  kind: 'results' | 'coverage';
  runId: string;
  at?: string;
  mtime: string;
  /** only a reporter-recorded digest can prove the source is unchanged (§3-C.1) */
  sourceDigest?: string;
  /** the commit HEAD named when the stamp was written (`farsight.commit`), when it recorded one */
  sourceCommit?: string;
  /**
   * how many cases the report's own header counted as skipped/pending/todo
   * (vitest: `numPendingTests + numTodoTests`). The join compares it with the
   * rows it actually attached, so a swallowed row is a stated gap, not a silence.
   */
  reportedSkipped?: number;
  cases: ObservedCase[];
  hits: CoverageHit[];
  /**
   * coverage reports only: every source file the report contained, hit or not,
   * repo-relative. A report proves a *file* was measured — the whole-scope
   * exactness rule reads this to tell "no test reaches it" from "no report
   * looked" (03 §3.3).
   */
  files?: string[];
}

function digestOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** A reporter-recorded source digest, if the report carries one. mtime is never treated as proof. */
function recordedDigest(doc: Record<string, unknown>): string | undefined {
  for (const key of ['sourceDigest', 'farsightSourceDigest']) {
    const v = doc[key];
    if (typeof v === 'string' && v) return v;
  }
  const fs = doc['farsight'];
  if (fs && typeof fs === 'object' && typeof (fs as Record<string, unknown>)['sourceDigest'] === 'string') {
    return (fs as Record<string, string>)['sourceDigest'];
  }
  return undefined;
}

/** The commit a Farsight stamp recorded beside the digest, if any. */
function recordedCommit(doc: Record<string, unknown>): string | undefined {
  const fs = doc['farsight'];
  if (fs && typeof fs === 'object' && typeof (fs as Record<string, unknown>)['commit'] === 'string') {
    return (fs as Record<string, string>)['commit'] || undefined;
  }
  return undefined;
}

const STATUS: Record<string, TestRun['status']> = {
  passed: 'passed', pass: 'passed', ok: 'passed', expected: 'passed',
  failed: 'failed', fail: 'failed', unexpected: 'failed', timedOut: 'failed', interrupted: 'failed',
  skipped: 'skipped', pending: 'skipped', todo: 'skipped', disabled: 'skipped',
  // a retried case that ended green is `flaky`, never `passed` — it prints as its own word (03 §3.2)
  flaky: 'flaky',
};
const statusOf = (s: unknown): TestRun['status'] => STATUS[String(s)] ?? 'unknown';

/**
 * A `.each` title is a template, not a name: the reporter writes one expanded
 * title per row, so the node and the rows can only meet through a pattern
 * (03 §3.1). Printf tokens `%s %d %i %f %j %o %#` and the interpolations
 * `${…}` / `$name` (with `$name.path` and `$#`) stand for one row's value and
 * become `.+?`; `%%` is a literal per cent; everything else is matched
 * verbatim and the whole thing is anchored, so an unrelated title in the same
 * file can never be joined to the template.
 */
const EACH_TOKEN = /%[sdifjo#%]|\$\{[^}]*\}|\$#|\$[A-Za-z_][\w$]*(?:\.[\w$]+)*/g;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function eachTitleToRegExp(template: string): RegExp {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  EACH_TOKEN.lastIndex = 0;
  while ((m = EACH_TOKEN.exec(template))) {
    out += escapeRe(template.slice(last, m.index));
    out += m[0] === '%%' ? '%' : '.+?';
    last = m.index + m[0].length;
  }
  out += escapeRe(template.slice(last));
  return new RegExp(`^${out}$`);
}

/** Does this expanded report title come from that `.each` template? */
export function eachTitleMatches(template: string, reported: string): boolean {
  return eachTitleToRegExp(template).test(reported);
}

/** The project a vitest/jest row belongs to, when the reporter names one at all — case, file, or run level. */
function vitestProject(...from: (Record<string, unknown> | undefined)[]): string | undefined {
  for (const obj of from) {
    if (!obj) continue;
    for (const key of ['projectName', 'project']) {
      const v = obj[key];
      if (typeof v === 'string' && v) return v;
    }
  }
  return undefined;
}

/** Vitest/Jest `json` reporter — per-case status, duration, project, and the run timestamp. */
function readVitestJson(doc: Record<string, unknown>, repoRoot: string): { cases: ObservedCase[]; at?: string; reportedSkipped?: number } {
  const cases: ObservedCase[] = [];
  const files = (doc['testResults'] as Record<string, unknown>[]) ?? [];
  for (const f of files) {
    const file = typeof f['name'] === 'string' ? relative(repoRoot, f['name'] as string) : undefined;
    for (const a of (f['assertionResults'] as Record<string, unknown>[]) ?? []) {
      const suite = ((a['ancestorTitles'] as string[]) ?? []).filter((x) => typeof x === 'string');
      const title = String(a['title'] ?? '');
      const project = vitestProject(a, f, doc);
      // a skipped/todo row is kept: the case ran nowhere, which is a fact about it
      cases.push({
        ...(file ? { file } : {}),
        suite, title,
        fullName: typeof a['fullName'] === 'string' ? (a['fullName'] as string) : [...suite, title].join(' '),
        status: statusOf(a['status']),
        ...(typeof a['duration'] === 'number' ? { durationMs: a['duration'] as number } : {}),
        ...(project ? { project } : {}),
      });
    }
  }
  const start = doc['startTime'];
  const pending = ['numPendingTests', 'numTodoTests']
    .map((k) => (typeof doc[k] === 'number' ? (doc[k] as number) : undefined))
    .filter((n): n is number => n != null);
  return {
    cases,
    ...(typeof start === 'number' ? { at: new Date(start).toISOString() } : {}),
    ...(pending.length ? { reportedSkipped: pending.reduce((a, b) => a + b, 0) } : {}),
  };
}

/**
 * Playwright `json` reporter — nested suites; each spec carries its file, line
 * and one `tests[]` entry **per project**, so a case run under two projects is
 * two rows here, each naming its project (03 §3.1). `flaky` stays flaky, with
 * the retries the reporter recorded; a skipped row is kept like any other.
 */
function readPlaywrightJson(doc: Record<string, unknown>): { cases: ObservedCase[]; at?: string } {
  const cases: ObservedCase[] = [];
  const walkSuite = (suite: Record<string, unknown>, titles: string[]) => {
    const file = typeof suite['file'] === 'string' ? (suite['file'] as string) : undefined;
    const here = suite['title'] && suite['title'] !== file ? [...titles, String(suite['title'])] : titles;
    for (const spec of (suite['specs'] as Record<string, unknown>[]) ?? []) {
      const title = String(spec['title'] ?? '');
      for (const t of (spec['tests'] as Record<string, unknown>[]) ?? []) {
        const results = (t['results'] as Record<string, unknown>[]) ?? [];
        const last = results[results.length - 1];
        const retries = results.length - 1;
        const project = [t['projectName'], t['projectId']].find((v) => typeof v === 'string' && v) as string | undefined;
        cases.push({
          ...(file || spec['file'] ? { file: String(spec['file'] ?? file) } : {}),
          suite: here, title,
          fullName: [...here, title].join(' '),
          status: statusOf(t['status'] ?? last?.['status']),
          ...(typeof last?.['duration'] === 'number' ? { durationMs: last['duration'] as number } : {}),
          ...(project ? { project } : {}),
          ...(retries > 0 ? { retries } : {}),
        });
      }
    }
    for (const child of (suite['suites'] as Record<string, unknown>[]) ?? []) walkSuite(child, here);
  };
  for (const s of (doc['suites'] as Record<string, unknown>[]) ?? []) walkSuite(s, []);
  const stats = doc['stats'] as Record<string, unknown> | undefined;
  const at = stats && typeof stats['startTime'] === 'string' ? (stats['startTime'] as string) : undefined;
  return { cases, ...(at ? { at } : {}) };
}

/** JUnit XML — the interchange format other stacks emit. Deliberately regex-shallow: one `<testcase>` per case. */
function readJunitXml(text: string): { cases: ObservedCase[]; at?: string } {
  const cases: ObservedCase[] = [];
  const caseRe = /<testcase\b([^>]*?)\s*(\/>|>([\s\S]*?)<\/testcase>)/g;
  // the attribute name has to start where an attribute starts, or `name=` matches
  // inside `classname="…"` and every case is called after its suite
  const attr = (s: string, name: string) => s.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(text))) {
    const attrs = m[1]!;
    const body = m[3] ?? '';
    const title = attr(attrs, 'name') ?? '';
    const classname = attr(attrs, 'classname') ?? '';
    const suite = classname ? classname.split(/[.>]/).filter(Boolean) : [];
    const time = Number(attr(attrs, 'time'));
    cases.push({
      suite, title, fullName: [...suite, title].join(' '),
      status: /<failure|<error/.test(body) ? 'failed' : /<skipped/.test(body) ? 'skipped' : 'passed',
      ...(Number.isFinite(time) ? { durationMs: Math.round(time * 1000) } : {}),
    });
  }
  const at = text.match(/timestamp="([^"]*)"/)?.[1];
  return { cases, ...(at ? { at } : {}) };
}

/**
 * Istanbul `coverage-final.json` — `fnMap` + `f` counts give the functions a
 * run reached; `statementMap` + `s` give how many statements inside each fired.
 * Zero-count functions are left out: we record what ran, not what did not.
 */
function readIstanbul(doc: Record<string, unknown>, repoRoot: string): { hits: CoverageHit[]; files: string[] } {
  const hits: CoverageHit[] = [];
  const files = new Set<string>();
  for (const [key, raw] of Object.entries(doc)) {
    if (!raw || typeof raw !== 'object') continue;
    const file = raw as Record<string, unknown>;
    const abs = typeof file['path'] === 'string' ? (file['path'] as string) : key;
    // an istanbul entry, not the `farsight` stamp block or another stray key
    if (!file['fnMap'] && !file['statementMap']) continue;
    const path = abs.startsWith('/') ? relative(repoRoot, abs) : abs;
    if (path.startsWith('..')) continue; // outside the repo — not our graph
    // the report *looked* at this file, whatever it found there
    files.add(path);
    if (!file['fnMap'] || typeof file['fnMap'] !== 'object') continue;
    const fnMap = file['fnMap'] as Record<string, Record<string, unknown>>;
    const f = (file['f'] as Record<string, number>) ?? {};
    const statementMap = (file['statementMap'] as Record<string, Record<string, { line?: number }>>) ?? {};
    const s = (file['s'] as Record<string, number>) ?? {};
    for (const [id, fn] of Object.entries(fnMap)) {
      if (!(f[id] ?? 0)) continue;
      const decl = (fn['decl'] ?? fn['loc']) as { start?: { line?: number }; end?: { line?: number } } | undefined;
      const loc = (fn['loc'] ?? fn['decl']) as { start?: { line?: number }; end?: { line?: number } } | undefined;
      const line = decl?.start?.line ?? 0;
      const from = loc?.start?.line ?? line;
      const to = loc?.end?.line ?? line;
      let lines = 0;
      for (const [sid, stmt] of Object.entries(statementMap)) {
        const at = (stmt as unknown as { start?: { line?: number } }).start?.line ?? 0;
        if (at >= from && at <= to && (s[sid] ?? 0) > 0) lines++;
      }
      hits.push({ path, name: String(fn['name'] ?? '(anonymous)'), line, lines });
    }
  }
  return { hits, files: [...files].sort() };
}

/**
 * Read one report file. Format is sniffed from the content, not the name, so a
 * junit.xml called results.xml and a vitest json called report.json both work.
 * Returns null for anything unreadable — a missing report is a blind spot, not
 * a failure.
 */
export function readReport(repoRoot: string, abs: string): ReadReport | null {
  let text: string;
  let mtime: string;
  try {
    if (statSync(abs).size > MAX_BYTES) return null;
    text = readFileSync(abs, 'utf8');
    mtime = statSync(abs).mtime.toISOString();
  } catch {
    return null;
  }
  const path = relative(repoRoot, abs);
  const runId = digestOf(text);
  const base = { path, runId, mtime, cases: [] as ObservedCase[], hits: [] as CoverageHit[] };
  if (/^\s*</.test(text)) {
    const { cases, at } = readJunitXml(text);
    return { ...base, kind: 'results', cases, ...(at ? { at } : {}) };
  }
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  const sourceDigest = recordedDigest(doc);
  const sourceCommit = sourceDigest ? recordedCommit(doc) : undefined;
  const digestField = sourceDigest ? { sourceDigest, ...(sourceCommit ? { sourceCommit } : {}) } : {};
  if (doc['testResults']) {
    const { cases, at, reportedSkipped } = readVitestJson(doc, repoRoot);
    return { ...base, kind: 'results', cases, ...digestField, ...(at ? { at } : {}), ...(reportedSkipped != null ? { reportedSkipped } : {}) };
  }
  if (doc['suites'] && doc['config']) {
    const { cases, at } = readPlaywrightJson(doc);
    return { ...base, kind: 'results', cases, ...digestField, ...(at ? { at } : {}) };
  }
  const first = Object.values(doc).find((v) => v && typeof v === 'object') as Record<string, unknown> | undefined;
  if (first && (first['fnMap'] || first['statementMap'])) {
    return { ...base, kind: 'coverage', ...readIstanbul(doc, repoRoot), ...digestField };
  }
  return null;
}

/**
 * The freshness verdict for a report. A recorded digest that matches is the only
 * thing that proves "unchanged since the run"; without one the answer is `unknown`,
 * never fresh (§3-C.1).
 *
 * The content digest (`sourceDigest`, files.ts contentDigest) is what a reporter
 * should stamp. A report stamped with the older mtime hash (`sourceHash`) is still
 * read as unchanged so graphs and CI artefacts from before the digest keep working;
 * anything else is `changed`.
 */
export function freshnessOf(
  report: ReadReport,
  source: { sourceDigest?: string | undefined; sourceHash?: string | undefined },
): TestRun['freshness'] {
  const recorded = report.sourceDigest;
  if (!recorded) return 'unknown';
  if (source.sourceDigest && recorded === source.sourceDigest) return 'unchanged';
  if (source.sourceHash && recorded === source.sourceHash) return 'unchanged'; // legacy stamp
  return 'changed';
}

/**
 * For a `changed` report: did a commit move, or only the working tree? The
 * stamp's own commit decides when it recorded one. Otherwise HEAD's commit time
 * does: a HEAD committed before the run was already there when the run ran, so
 * the files that differ are uncommitted edits — the working tree differs from
 * HEAD — and no commit list will show them. `undefined` when git cannot say.
 */
export function changedByOf(
  report: Pick<ReadReport, 'sourceCommit' | 'at' | 'mtime'>,
  head: { sha: string; at?: string } | undefined,
): TestRun['changedBy'] {
  if (!head) return undefined;
  if (report.sourceCommit) return report.sourceCommit === head.sha ? 'working-tree' : 'commit';
  const ranAt = report.at ?? report.mtime;
  if (!head.at || !ranAt) return undefined;
  return Date.parse(head.at) <= Date.parse(ranAt) ? 'working-tree' : 'commit';
}
