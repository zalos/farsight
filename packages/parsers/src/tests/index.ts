/**
 * The tests post-pass over a repo fragment (docs/proposals/tests-surface.md
 * §3.2). Runs from `ingestRepo()` after the language adapters and after the
 * OpenAPI + design passes — resolving `@covers SCR-07` needs the design
 * screens, and `@covers POST /invoices` needs the routes a spec may have added.
 *
 * Three evidence classes, one edge kind:
 *   declared — an `@covers` claim by the test author
 *   static   — what the test's own code imports, renders, or opens
 *   observed — what a coverage/results report saw run
 *
 * It never runs a test and never fails an ingest. What it could not read
 * becomes a sentence in `meta.tests.blindSpots`.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { GraphFragment, GraphNode, GraphEdge, TestRef, TestRun, TestsMeta, TestsConfigBlock, TestReportConfig } from '@farsight/core';
import { stringList } from '@farsight/core';
import { loadWorkspaceConfig, type WorkspaceConfig } from '../shared/config-files.js';
import { walk, isNode, lineIndex, type AstNode } from '../walk.js';
import { collectFiles } from '../shared/files.js';
import { createAliasResolver } from '../aliases.js';
import type { IngestOptions } from '../types.js';
import { extractCases, isTestFile, DEFAULT_TEST_GLOBS, type TestGlobs } from './cases.js';
import { CoverTargets, fileSignals, staticResolution, type StaticSignal } from './covers.js';
import { findReports, readReport, freshnessOf, changedByOf, eachTitleMatches, type ReadReport, type ObservedCase } from './reports.js';
import { gitHeadAt } from '../shared/git.js';

export { isTestFile, DEFAULT_TEST_GLOBS, extractCases, runnerOf, levelOf, classifyCall, fileHeaderDoc } from './cases.js';
export type { TestCase, ExtractedFile, TestGlobs } from './cases.js';
export { CoverTargets, routeKey, fileSignals } from './covers.js';
export { findReports, readReport, freshnessOf, changedByOf, eachTitleToRegExp, eachTitleMatches } from './reports.js';
export type { ReadReport, ObservedCase, CoverageHit } from './reports.js';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];
const LEVELS = ['unit', 'integration', 'e2e'] as const;

/** One blind spot as data: what could not be read, at which level, naming the artefact (03 §3.4). */
export type TestsGap = NonNullable<TestsMeta['gaps']>[number];
type ReportEntry = TestsMeta['reports'][number];

/**
 * The order blind spots are read in (03 §3.4): what is missing before what is
 * unreadable, before what was read but proves nothing. Stable inside a kind, so
 * two runs over the same repo produce the same list.
 */
const GAP_ORDER: TestsGap['kind'][] = [
  'missing-artefact', 'unreadable', 'empty', 'unresolved-claim', 'unjoined-each', 'no-digest', 'digest-changed', 'no-config',
];

export function orderGaps(gaps: TestsGap[]): TestsGap[] {
  return gaps
    .map((gap, i) => ({ gap, i }))
    .sort((a, b) => (GAP_ORDER.indexOf(a.gap.kind) - GAP_ORDER.indexOf(b.gap.kind)) || (a.i - b.i))
    .map(({ gap }) => gap);
}

/**
 * `blindSpots` is derived from `gaps`, never written twice: one sentence per
 * gap, except that gaps of the same kind and level fold into one sentence
 * carrying `×n` and the first three artefacts it names (03 §3.4 — the reference app's 16
 * "records no source digest" lines become one).
 */
export function foldGaps(gaps: TestsGap[]): string[] {
  const groups = new Map<string, TestsGap[]>();
  for (const gap of orderGaps(gaps)) {
    const key = `${gap.kind}|${gap.level ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(gap);
  }
  const out: string[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    if (group.length === 1) { out.push(first.text); continue; }
    const named = group.map((g) => g.paths[0] ?? g.glob).filter((s): s is string => !!s);
    const shown = named.slice(0, 3).map((s) => `\`${s}\``).join(', ');
    out.push(`${first.text} ×${group.length}${shown ? ` — ${shown}${named.length > 3 ? ', …' : ''}` : ''}`);
  }
  return out;
}

/** The `tests` block of a repo's farsight.config.json files (the root's, with every nested file's rebased and unioned), or nothing. */
export function testsConfigOf(repoRoot: string, options: IngestOptions = {}): TestsConfigBlock | undefined {
  return loadWorkspaceConfig(repoRoot, options).merged.tests;
}

/** The blocks one level names: one, or one per config file that gave the level. */
export function levelBlocks(config: TestsConfigBlock, level: TestRef['level']): TestReportConfig[] {
  const v = config[level];
  return (Array.isArray(v) ? v : v ? [v] : []).filter((b): b is TestReportConfig => !!b && typeof b === 'object');
}

/**
 * The html report a run links to: the block's only one, or — when a block names several — the one
 * sharing the longest folder with the results file that produced the run.
 */
export function reportLinkOf(block: TestReportConfig, resultsPath: string): string | undefined {
  const reports = stringList(block.report);
  if (reports.length <= 1) return reports[0];
  const shared = (a: string) => {
    const x = a.split('/').slice(0, -1);
    const y = resultsPath.split('/').slice(0, -1);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  return [...reports].sort((a, b) => shared(b) - shared(a))[0];
}

/** The claim globs for a repo: the defaults plus whatever its config adds. */
export function testGlobsOf(config: TestsConfigBlock | undefined): TestGlobs {
  return { ...(config?.include ? { include: config.include } : {}), ...(config?.exclude ? { exclude: config.exclude } : {}) };
}

function parse(abs: string, source: string): AstNode | null {
  try {
    const result = parseSync(abs, source);
    // oxc returns `program` as an object or a JSON string depending on version
    return (typeof result.program === 'string' ? JSON.parse(result.program) : result.program) as AstNode;
  } catch {
    return null;
  }
}

/** Top-level function name → the goto/request literals inside it, so a test that calls a helper inherits its endpoints (one level). */
function helperSignals(program: AstNode, source: string, abs: string, repoRoot: string, resolveAlias: (a: string, s: string) => string | null): Map<string, StaticSignal[]> {
  const line = lineIndex(source);
  const spans: { name: string; start: number; end: number }[] = [];
  walk(program, (n, parents) => {
    if (parents.length > 4) return;
    if (n.type === 'FunctionDeclaration' && isNode(n.id)) {
      spans.push({ name: String((n.id as AstNode).name), start: n.start ?? 0, end: n.end ?? 0 });
      return;
    }
    if (n.type === 'VariableDeclarator' && isNode(n.id) && (n.id as AstNode).type === 'Identifier' && isNode(n.init)) {
      const init = n.init as AstNode;
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        spans.push({ name: String((n.id as AstNode).name), start: n.start ?? 0, end: n.end ?? 0 });
      }
    }
  });
  const { signals } = fileSignals(program, source, abs, repoRoot, resolveAlias);
  const byName = new Map<string, StaticSignal[]>();
  for (const sig of signals) {
    if (sig.kind !== 'goto' && sig.kind !== 'request') continue;
    // signal lines are 1-based; spans are offsets — re-derive the span line range
    for (const sp of spans) {
      if (sig.line >= line(sp.start) && sig.line <= line(sp.end)) {
        if (!byName.has(sp.name)) byName.set(sp.name, []);
        byName.get(sp.name)!.push(sig);
      }
    }
  }
  return byName;
}

/** Stable, readable id for a test case: repo::test::<file>::<full title>, deduped. */
function testId(repo: string, file: string, fullTitle: string, seen: Set<string>): string {
  const base = `${repo}::test::${file}::${fullTitle}`;
  if (!seen.has(base)) { seen.add(base); return base; }
  for (let i = 2; ; i++) {
    const candidate = `${base}#${i}`;
    if (!seen.has(candidate)) { seen.add(candidate); return candidate; }
  }
}

/**
 * Discover + read the repo's tests into the fragment (in place). Never throws;
 * unreadable reports and unmatched claims are reported, not fatal.
 */
export function applyTests(fragment: GraphFragment, repoRoot: string, options: IngestOptions = {}, workspace?: WorkspaceConfig): { errors: string[]; meta: TestsMeta } {
  const repo = fragment.repo;
  const config = (workspace ?? loadWorkspaceConfig(repoRoot, options)).merged.tests;
  const globs = testGlobsOf(config);
  const errors: string[] = [];
  const gaps: TestsGap[] = [];
  const targets = new CoverTargets(fragment.nodes, repo);
  const resolveAlias = createAliasResolver(repoRoot);

  let edgeSeq = 0;
  const addEdge = (from: string, to: string, meta: GraphEdge['meta'], resolution: GraphEdge['resolution']) => {
    fragment.edges.push({ id: `test-e${edgeSeq++}`, kind: 'covers', from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });
  };

  // ── 1. claim the test files ────────────────────────────────────
  const all = collectFiles(repoRoot, EXTS, options, (name) => name.endsWith('.d.ts')).sort();
  const claimed: { abs: string; file: string; source: string }[] = [];
  for (const abs of all) {
    const file = relative(repoRoot, abs);
    let source: string;
    try { source = readFileSync(abs, 'utf8'); } catch { continue; }
    if (isTestFile(file, source, globs)) claimed.push({ abs, file, source });
  }

  // ── 2. cases → test nodes; 3/4. declared + static covers edges ──
  const seenIds = new Set<string>();
  const byFullName = new Map<string, GraphNode[]>();
  const helperCache = new Map<string, Map<string, StaticSignal[]>>();
  const counts = { declared: 0, static: 0, observed: 0 };
  let cases = 0;
  let runs = 0;

  for (const { abs, file, source } of claimed) {
    const program = parse(abs, source);
    if (!program) { errors.push(`tests ${file}: could not be parsed`); continue; }
    const extracted = extractCases(program, source, file);
    const signals = fileSignals(program, source, abs, repoRoot, resolveAlias);

    // helpers this file calls: one level down, for their route literals
    const inherited: StaticSignal[] = [];
    for (const [local, target] of signals.imports) {
      if (!signals.called.has(local)) continue;
      const helperAbs = resolve(repoRoot, target.file);
      if (claimed.some((c) => c.abs === helperAbs)) continue; // another test file, not a helper
      let map = helperCache.get(helperAbs);
      if (!map) {
        let helperSource = '';
        try { helperSource = readFileSync(helperAbs, 'utf8'); } catch { continue; }
        const helperProgram = parse(helperAbs, helperSource);
        map = helperProgram ? helperSignals(helperProgram, helperSource, helperAbs, repoRoot, resolveAlias) : new Map();
        helperCache.set(helperAbs, map);
      }
      for (const sig of map.get(target.name) ?? []) inherited.push({ ...sig, viaHelper: local });
    }

    for (const c of extracted.cases) {
      cases++;
      const fullTitle = [...c.suite, c.title].join(' › ');
      const id = testId(repo, file, fullTitle, seenIds);
      const declares = [...new Set([...extracted.fileDeclares, ...c.declares])];
      const remarks = c.steps.length ? `Steps: ${c.steps.join(' → ')}.` : '';
      const docsText = [c.docs, extracted.fileDocs, remarks].filter(Boolean).join(' ');
      const test: TestRef = {
        level: extracted.level,
        runner: extracted.runner,
        suite: c.suite,
        file,
        ...(declares.length ? { declares } : {}),
        // `.skip`/`.todo`, on the case or on a describe above it: the case exists and ran nowhere
        ...(c.inactive ? { inactive: true } : {}),
      };
      const node: GraphNode = {
        id, kind: 'test', name: c.title, lang: /\.tsx?$/.test(file) || /\.mts$/.test(file) ? 'ts' : 'js',
        loc: { repo, path: file, line: c.line, endLine: c.endLine },
        ...(docsText ? { docs: docsText } : {}),
        ...(c.suite.length ? { signature: c.suite.join(' › ') } : {}),
        group: file,
        tags: [
          'test', `test:${extracted.level}`, `runner:${extracted.runner}`,
          ...c.mods.filter((m) => m === 'skip' || m === 'only' || m === 'todo' || m === 'each').map((m) => `test:${m}`),
          ...(c.heuristicTitle ? ['test:title-heuristic'] : []),
        ],
        test,
      };
      fragment.nodes.push(node);
      const key = fullTitle.replace(/ › /g, ' ');
      if (!byFullName.has(key)) byFullName.set(key, []);
      byFullName.get(key)!.push(node);

      // ── declared ──
      const unresolved: string[] = [];
      const linked = new Set<string>();
      for (const value of declares) {
        const hit = targets.declared(value);
        if (!hit.nodeId) {
          unresolved.push(value);
          continue;
        }
        // one edge per target, but a claim about a numbered step keeps which step it
        // was about — two steps of one screen are two claims, not a duplicate
        const key = hit.step ? `${hit.nodeId}#${hit.step}` : hit.nodeId;
        if (linked.has(key)) continue;
        linked.add(key);
        counts.declared++;
        addEdge(id, hit.nodeId, { evidence: 'declared', declared: value, ...(hit.step ? { step: hit.step } : {}) },
          { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note: `@covers ${value}${hit.step ? ` — step ${hit.step} of this screen` : ''}` });
      }
      if (unresolved.length) {
        test.unresolved = unresolved;
        const text = `\`${file}\` declares ${unresolved.map((u) => `\`${u}\``).join(', ')}, which nothing in the graph matches`;
        if (!gaps.some((g) => g.text === text)) gaps.push({ kind: 'unresolved-claim', level: extracted.level, paths: [file], text });
      }

      // ── static ──
      // a signal belongs to this case when it sits inside its span; a symbol the file
      // imports but never calls (line 0) belongs to every case in the file, at MEDIUM
      const inRange = (s: StaticSignal) => s.line === 0 || (s.line >= c.line && s.line <= c.endLine);
      for (const sig of [...signals.signals.filter(inRange), ...inherited]) {
        let target: string | undefined;
        let exact = true;
        if (sig.kind === 'symbol' && sig.target) {
          target = targets.exported(sig.target.file, sig.target.name);
        } else if (sig.kind === 'render') {
          const imported = signals.imports.get(sig.value);
          if (imported) target = targets.exported(imported.file, imported.name);
        } else if (sig.kind === 'goto') {
          exact = !sig.value.includes(':param');
          target = targets.page(sig.value);
        } else if (sig.kind === 'request') {
          const [method, path] = sig.value.split(' ');
          exact = !(path ?? '').includes(':param');
          target = targets.route(method!, path ?? '/');
        }
        if (!target || linked.has(target) || target === id) continue;
        const kindOf = targets.node(target)?.kind;
        // a test importing a type-only or unrelated module is noise; keep to things a journey walks
        if (sig.kind === 'symbol' && !(kindOf === 'function' || kindOf === 'component' || kindOf === 'guard' || kindOf === 'rule' || kindOf === 'route')) continue;
        linked.add(target);
        counts.static++;
        // a `.skip`/`.todo` case still says what it would reach, but the edge says it ran nowhere
        addEdge(id, target, {
          evidence: 'static', signal: sig.kind,
          ...(sig.viaHelper ? { helper: sig.viaHelper } : {}),
          ...(sig.line ? { line: sig.line } : {}),
          ...(c.inactive ? { inactive: true } : {}),
        }, staticResolution(sig, exact));
      }
    }
  }

  // ── 5. observed: what the configured reports saw run ────────────
  const imported = importReports(fragment, repoRoot, config ?? {}, addEdge);
  counts.observed += imported.edges;
  runs += imported.runs;
  gaps.push(...imported.gaps);
  errors.push(...imported.errors);
  const reportsMeta = imported.reports;
  if (!config) {
    gaps.push({ kind: 'no-config', paths: [], text: 'No `tests` block in farsight.config.json; declared and static evidence only (docs/proposals/tests-surface.md §3.2)' });
  }

  const ordered = orderGaps(gaps);
  const meta: TestsMeta = {
    files: claimed.length, cases, edges: counts, runs, reports: reportsMeta, gaps: ordered, blindSpots: foldGaps(ordered),
    // what a report must stamp for its runs to read `unchanged` — recorded so a later
    // `tests import --stamp` can be refused when it names a different checkout
    ...(fragment.meta?.sourceDigest ? { sourceDigest: fragment.meta.sourceDigest } : {}),
  };
  if (fragment.meta) fragment.meta.tests = meta;
  else fragment.meta = { files: claimed.length, sourceHash: 'empty', tests: meta };
  return { errors, meta };
}

/**
 * Read every report a `tests` config block points at and fold it into the
 * fragment: per-case status/duration onto the test nodes, and run-level
 * `covers` edges from an istanbul report. Exported so `farsight tests import`
 * can attach a report produced in CI to an existing graph without re-ingesting.
 */
export function importReports(
  fragment: GraphFragment,
  repoRoot: string,
  config: TestsConfigBlock,
  addEdge?: (from: string, to: string, meta: GraphEdge['meta'], resolution: GraphEdge['resolution']) => void,
): { reports: TestsMeta['reports']; edges: number; runs: number; gaps: TestsGap[]; blindSpots: string[]; errors: string[] } {
  const reports: ReportEntry[] = [];
  const gaps: TestsGap[] = [];
  const errors: string[] = [];
  let edgeCount = 0;
  let runs = 0;

  // what this import is about to read, resolved once: the same file list decides
  // which prior evidence is replaced (03 §3.6) and which globs found nothing
  const planned: { level: TestRef['level']; kind: 'results' | 'coverage'; block: TestReportConfig; glob: string; files: string[] }[] = [];
  for (const level of LEVELS) {
    for (const block of levelBlocks(config, level)) {
      for (const kind of ['results', 'coverage'] as const) {
        for (const glob of stringList(block[kind])) planned.push({ level, kind, block, glob, files: findReports(repoRoot, glob) });
      }
    }
  }
  // re-importing the same reports must not double anything up: drop the run-level
  // nodes and observed edges these files produced last time, and the `runs[]` rows
  // they wrote, before reading them again (03 §3.6)
  clearPriorImport(fragment, repoRoot, planned);

  let seq = fragment.edges.length;
  const add = addEdge ?? ((from, to, meta, resolution) => {
    fragment.edges.push({ id: `test-import-e${seq++}`, kind: 'covers', from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });
  });

  const byFullName = new Map<string, GraphNode[]>();
  // `.each` cases: the node's name is the title template the reporter expanded per row
  const eachNodes: GraphNode[] = [];
  const nodesByPath = new Map<string, GraphNode[]>();
  for (const n of fragment.nodes) {
    if (n.kind === 'test' && n.test && !n.test.runLevel) {
      const key = [...n.test.suite, n.name].join(' ');
      if (!byFullName.has(key)) byFullName.set(key, []);
      byFullName.get(key)!.push(n);
      if (n.tags.includes('test:each')) eachNodes.push(n);
      continue;
    }
    if (n.kind === 'test' || !n.loc) continue;
    if (!nodesByPath.has(n.loc.path)) nodesByPath.set(n.loc.path, []);
    nodesByPath.get(n.loc.path)!.push(n);
  }
  const source = { sourceDigest: fragment.meta?.sourceDigest, sourceHash: fragment.meta?.sourceHash };

  // asked once, and only when a report's digest differs: a new commit, or the working tree?
  let head: { sha: string; at?: string } | undefined | null = null;
  const headOnce = () => (head === null ? (head = gitHeadAt(repoRoot)) : head);

  const levelsWithResults = new Set<TestRef['level']>();
  const eachJoinedAnywhere = new Set<GraphNode>();

  for (const { level, kind, block, glob, files } of planned) {
    const runner = block.runner ?? 'other';
    if (!files.length) {
      // the artefact is named: which glob, under which repo, for which level and kind (01 §3.2)
      reports.push({ kind, runner, level, glob, matched: 0, reason: 'no-match', freshness: 'unknown' });
      gaps.push({
        kind: 'missing-artefact', level, reportKind: kind, glob, paths: [],
        text: `\`${glob}\` matched 0 files under ${fragment.repo} — no ${level} ${kind} report; declared and static evidence only`,
      });
      continue;
    }
    for (const abs of files) {
      const path = relative(repoRoot, abs);
      const report = readReport(repoRoot, abs);
      if (!report) {
        // an empty `{}` / `[]` is a run that recorded nothing (a package with no source under test) — a blind spot, not a broken file
        let empty = false;
        try { empty = /^\s*(\{\s*\}|\[\s*\])\s*$/.test(readFileSync(abs, 'utf8')); } catch { /* unreadable: the generic message below */ }
        reports.push({ path, kind, runner, level, glob, matched: files.length, reason: empty ? 'empty' : 'unreadable', freshness: 'unknown' });
        if (empty) {
          gaps.push({ kind: 'empty', level, reportKind: kind, glob, paths: [path], text: `\`${path}\` is an empty report — the run recorded nothing there, so it adds no observed evidence` });
        } else {
          gaps.push({ kind: 'unreadable', level, reportKind: kind, glob, paths: [path], text: `\`${path}\` is not a report format this build reads, so nothing in it became evidence` });
          errors.push(`tests ${path}: not a report format this build reads`);
        }
        continue;
      }
      const freshness = freshnessOf(report, source);
      const changedBy = freshness === 'changed' ? changedByOf(report, headOnce()) : undefined;
      const entry: ReportEntry = {
        path: report.path, kind: report.kind, runner, level, mtime: report.mtime, runId: report.runId, freshness, glob, matched: files.length,
        reason: freshness === 'unknown' ? 'no-digest' : freshness === 'changed' ? 'digest-changed' : 'ok',
        ...(changedBy ? { changedBy } : {}),
      };
      reports.push(entry);
      if (freshness === 'unknown') {
        gaps.push({
          kind: 'no-digest', level, reportKind: report.kind, glob, paths: [report.path],
          text: `\`${report.path}\` records no source digest, so "unchanged since the run" cannot be proven — the file's own mtime is not evidence`,
        });
      } else if (freshness === 'changed') {
        gaps.push({
          kind: 'digest-changed', level, reportKind: report.kind, glob, paths: [report.path],
          text: changedBy === 'working-tree'
            ? `\`${report.path}\` was produced on the commit this code is on, and the files differ — the working tree differs from HEAD, not a new commit — so it is evidence of the past, not of now`
            : `\`${report.path}\` was produced against a different checkout — the code changed since the run, so it is evidence of the past, not of now`,
        });
      }
      if (report.kind === 'results') {
        levelsWithResults.add(level);
        const joinedReport = attachRuns(report, byFullName, eachNodes, freshness, block, level, changedBy);
        entry.joined = joinedReport.joined;
        entry.rows = report.cases.length;
        entry.unjoined = joinedReport.unjoined;
        entry.eachJoined = joinedReport.eachJoined;
        entry.eachUnjoined = joinedReport.eachUnjoined;
        runs += joinedReport.joined;
        gaps.push(...joinedReport.gaps);
        for (const node of joinedReport.eachTouched) eachJoinedAnywhere.add(node);
      } else {
        entry.edges = observeCoverage(report, fragment, fragment.repo, nodesByPath, level, block, freshness, add, changedBy);
        edgeCount += entry.edges;
      }
    }
  }

  // a parametrised case no report of its level expanded: said once, after every
  // report of that level has had its chance (03 §3.1)
  for (const node of eachNodes) {
    const level = node.test!.level;
    if (!levelsWithResults.has(level) || eachJoinedAnywhere.has(node)) continue;
    const at = `${node.test!.file}:${node.loc?.line ?? 0}`;
    gaps.push({
      kind: 'unjoined-each', level, reportKind: 'results', paths: [at],
      text: `\`${at}\` is a parametrised case (\`${node.name}\`) no row in the ${level} results report matched — its rows joined nothing`,
    });
  }

  const ordered = orderGaps(gaps);
  return { reports, edges: edgeCount, runs, gaps: ordered, blindSpots: foldGaps(ordered), errors };
}

/** `repo::test::run:<level>:<project>` — the synthetic node a coverage report's edges hang off. */
function runNodeId(repo: string, level: TestRef['level'], reportPath: string): string {
  const project = reportPath.replace(/\/[^/]+$/, '').replace(/^coverage\/?/, '') || repo;
  return `${repo}::test::run:${level}:${project}`;
}

/**
 * Idempotent re-import (03 §3.6): before a report is read again, everything the
 * *same* report wrote last time goes — the run-level node of that level and
 * project with its observed edges, and the `runs[]` rows whose `report` names one
 * of the files about to be read. Evidence from any other report is untouched, so
 * importing twice leaves identical node and edge counts.
 */
function clearPriorImport(
  fragment: GraphFragment,
  repoRoot: string,
  planned: { level: TestRef['level']; kind: 'results' | 'coverage'; block: TestReportConfig; files: string[] }[],
): void {
  const runIds = new Set<string>();
  const reportPaths = new Set<string>();
  for (const { level, kind, block, files } of planned) {
    if (kind === 'results') for (const r of stringList(block.report)) reportPaths.add(r);
    for (const abs of files) {
      const path = relative(repoRoot, abs);
      if (kind === 'coverage') runIds.add(runNodeId(fragment.repo, level, path));
      else reportPaths.add(path);
    }
  }
  if (runIds.size) {
    for (let i = fragment.edges.length - 1; i >= 0; i--) {
      const edge = fragment.edges[i]!;
      if (edge.kind === 'covers' && runIds.has(edge.from)) fragment.edges.splice(i, 1);
    }
    for (let i = fragment.nodes.length - 1; i >= 0; i--) {
      if (runIds.has(fragment.nodes[i]!.id)) fragment.nodes.splice(i, 1);
    }
  }
  if (!reportPaths.size) return;
  for (const node of fragment.nodes) {
    const ref = node.test;
    if (node.kind !== 'test' || !ref?.runs?.length) continue;
    const kept = ref.runs.filter((r) => !(r.report && reportPaths.has(r.report)));
    if (kept.length === ref.runs.length) continue;
    if (kept.length) { ref.runs = kept; ref.run = foldRuns(kept); }
    else { delete ref.runs; delete ref.run; }
  }
}

/** Weakest first: a case is only as green as its worst project (03 §3.2). */
const STATUS_RANK: TestRun['status'][] = ['failed', 'flaky', 'skipped', 'unknown', 'passed'];

/**
 * The fold over `runs[]` that `TestRef.run` is: the weakest status across the
 * projects, the latest timestamp, and no `project` once more than one ran it —
 * so a consumer that only reads `run` is never told a case passed when one
 * project failed it.
 */
export function foldRuns(runs: TestRun[]): TestRun | undefined {
  if (!runs.length) return undefined;
  if (runs.length === 1) return { ...runs[0]! };
  const weakest = [...runs].sort((a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status))[0]!;
  const latest = runs.reduce((a, b) => (b.at > a.at ? b : a));
  const fold: TestRun = { ...weakest, at: latest.at };
  delete fold.project;
  return fold;
}

/**
 * Join a results report's cases to the test nodes by full name — status,
 * duration, retries, freshness. One report row is one `TestRun`, kept per
 * project in `runs[]` (a row the same project and report already wrote is
 * replaced, so a re-import does not double up); `run` stays as the fold.
 */
function attachRuns(
  report: ReadReport,
  byFullName: Map<string, GraphNode[]>,
  eachNodes: GraphNode[],
  freshness: TestRun['freshness'],
  block: TestReportConfig,
  level: TestRef['level'],
  changedBy?: TestRun['changedBy'],
): { joined: number; unjoined: number; eachJoined: number; eachUnjoined: number; eachTouched: Set<GraphNode>; gaps: TestsGap[] } {
  let joined = 0;
  // rows that reached nothing — counted here because only this loop knows which
  // rows an exact match or a template claimed (03 §2.9; the Tests tab prints it)
  let unjoined = 0;
  let noFileUnjoined = 0;
  let skippedJoined = 0;
  const gaps: TestsGap[] = [];
  const sameFile = (node: GraphNode, c: ObservedCase): boolean =>
    !c.file || node.test!.file.endsWith(c.file) || c.file.endsWith(node.test!.file);
  const match = (c: ObservedCase): GraphNode[] => {
    const hits = byFullName.get(c.fullName) ?? byFullName.get([...c.suite, c.title].join(' ')) ?? [];
    // a JUnit row carries no file: it may only join when exactly one node has that
    // full name — attaching it to every hit would invent evidence (03 §3.1)
    if (!c.file) return hits.length === 1 ? hits : [];
    if (hits.length <= 1) return hits;
    // same title in two spec files: the report names the file, so use it
    const narrowed = hits.filter((n) => sameFile(n, c));
    return narrowed.length ? narrowed : hits;
  };
  // a row no exact name claimed may be one row of a `.each` template in the same
  // file and describe path — the reporter expanded the title, the node still holds it
  const template = (c: ObservedCase): GraphNode | undefined => {
    const hits = eachNodes.filter((n) => sameFile(n, c) && n.test!.suite.join(' ') === c.suite.join(' ') && eachTitleMatches(n.name, c.title));
    // without a file the pattern is all there is, so only a single candidate may take the row
    if (!c.file) return hits.length === 1 ? hits[0] : undefined;
    return hits[0];
  };

  const put = (node: GraphNode, run: TestRun, project?: string) => {
    const ref = node.test!;
    const runs = (ref.runs ?? []).filter((r) => !(r.project === run.project && r.report === run.report));
    runs.push(run);
    ref.runs = runs;
    ref.run = foldRuns(runs);
    if (project) ref.project = project;
    joined++;
  };
  const base = {
    id: report.runId,
    at: report.at ?? report.mtime,
    ...(report.sourceDigest ? { sourceDigest: report.sourceDigest } : {}),
    ...(report.sourceCommit ? { commit: report.sourceCommit } : {}),
    freshness,
    stale: freshness === 'changed',
    ...(changedBy ? { changedBy } : {}),
    report: reportLinkOf(block, report.path) ?? report.path,
  };

  // rows by template node, then by project — every row of one template is one run
  const byTemplate = new Map<GraphNode, Map<string, ObservedCase[]>>();
  for (const c of report.cases) {
    const exact = match(c);
    if (exact.length) {
      if (c.status === 'skipped') skippedJoined++;
      for (const node of exact) {
        put(node, {
          ...base,
          status: c.status,
          ...(c.durationMs != null ? { durationMs: c.durationMs } : {}),
          ...(c.retries != null ? { retries: c.retries } : {}),
          project: c.project ?? 'default',
          join: 'exact',
        }, c.project);
      }
      continue;
    }
    const node = template(c);
    // a row nothing claimed is named in the gaps list — never attached to a guess
    if (!node) {
      unjoined++;
      if (!c.file) noFileUnjoined++;
      continue;
    }
    if (c.status === 'skipped') skippedJoined++;
    let projects = byTemplate.get(node);
    if (!projects) { projects = new Map(); byTemplate.set(node, projects); }
    const key = c.project ?? 'default';
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key)!.push(c);
  }
  for (const [node, projects] of byTemplate) {
    for (const [project, rows] of projects) {
      // the template is as green as its worst row, and says how many rows it stands for
      const status = [...rows].sort((a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status))[0]!.status;
      const durations = rows.map((r) => r.durationMs).filter((d): d is number => d != null);
      const retries = rows.map((r) => r.retries).filter((n): n is number => n != null);
      put(node, {
        ...base,
        status,
        ...(durations.length ? { durationMs: durations.reduce((a, b) => a + b, 0) } : {}),
        ...(retries.length ? { retries: Math.max(...retries) } : {}),
        project,
        join: 'each-template',
        rows: rows.length,
      }, rows[0]!.project);
    }
  }

  if (noFileUnjoined) {
    // JUnit and friends: the row named a case, not a file — nearest gap kind is `unreadable`
    gaps.push({
      kind: 'unreadable', level, reportKind: 'results', paths: [report.path],
      text: `\`${report.path}\`: ${noFileUnjoined} row(s) without a file could not be joined — a row that names no file joins only when exactly one test has that full name`,
    });
  }
  if (report.reportedSkipped != null && report.reportedSkipped !== skippedJoined) {
    gaps.push({
      kind: 'unreadable', level, reportKind: 'results', paths: [report.path],
      text: `\`${report.path}\` counts ${report.reportedSkipped} skipped case(s) in its header but ${skippedJoined} joined — the difference reached no test node`,
    });
  }
  const eachTouched = new Set(byTemplate.keys());
  const eachOfLevel = eachNodes.filter((n) => n.test!.level === level);
  return {
    joined,
    unjoined,
    eachJoined: eachTouched.size,
    eachUnjoined: eachOfLevel.filter((n) => !eachTouched.has(n)).length,
    eachTouched,
    gaps,
  };
}

/**
 * Istanbul coverage → `covers` edges from a synthetic run-level `test` node.
 * The report has no per-test attribution, so the edges say *the run reached
 * this*, never *this test reached this* (§3-C.2 / §8 attribution honesty).
 */
function observeCoverage(
  report: ReadReport,
  fragment: GraphFragment,
  repo: string,
  nodesByPath: Map<string, GraphNode[]>,
  level: TestRef['level'],
  block: TestReportConfig,
  freshness: TestRun['freshness'],
  addEdge: (from: string, to: string, meta: GraphEdge['meta'], resolution: GraphEdge['resolution']) => void,
  changedBy?: TestRun['changedBy'],
): number {
  if (!report.hits.length) return 0;
  // the project is the report's own directory, which is how the reportsDirectory convention names it
  const project = report.path.replace(/\/[^/]+$/, '').replace(/^coverage\/?/, '') || repo;
  const runId = runNodeId(repo, level, report.path);
  const at = report.at ?? report.mtime;
  const existing = fragment.nodes.findIndex((n) => n.id === runId);
  const runNode: GraphNode = {
    id: runId, kind: 'test', name: `${level} run · ${project} · ${at.slice(0, 10)}`,
    docs: `Every function this ${level} run reached, from ${report.path}. Coverage is attributed to the run, not to individual tests — the report carries no per-test attribution.`,
    group: report.path,
    tags: ['test', `test:${level}`, `runner:${block.runner ?? 'other'}`, 'test:run-level'],
    test: {
      level, runner: (block.runner ?? 'other') as TestRef['runner'], suite: [`${level} run`, project], file: report.path, runLevel: true,
      // every file the report contained, hit or not: what the run actually measured
      ...(report.files?.length ? { files: report.files } : {}),
      run: {
        id: report.runId, at, status: 'unknown',
        ...(report.sourceDigest ? { sourceDigest: report.sourceDigest } : {}),
        ...(report.sourceCommit ? { commit: report.sourceCommit } : {}),
        freshness, stale: freshness === 'changed',
        ...(changedBy ? { changedBy } : {}),
        report: reportLinkOf(block, report.path) ?? report.path,
      },
    },
  };
  if (existing >= 0) fragment.nodes[existing] = runNode; else fragment.nodes.push(runNode);

  let added = 0;
  const linked = new Set<string>();
  for (const hit of report.hits) {
    const candidates = nodesByPath.get(hit.path) ?? [];
    if (!candidates.length) continue;
    // how well the row and the node agree is a fact about the edge, and it caps its
    // confidence: freshness alone never raises it (03 §3.7)
    let match: 'name+line' | 'name' | 'line±1' = 'name+line';
    let node = candidates.find((n) => n.name === hit.name && n.loc!.line === hit.line);
    if (!node) { node = candidates.find((n) => n.name === hit.name); if (node) match = 'name'; }
    if (!node) { node = candidates.find((n) => Math.abs(n.loc!.line - hit.line) <= 1); if (node) match = 'line±1'; }
    if (!node || node.kind === 'test' || linked.has(node.id)) continue;
    linked.add(node.id);
    added++;
    const confidence = match === 'line±1' ? 'LOW' : match === 'name' ? 'MEDIUM' : freshness === 'unchanged' ? 'HIGH' : 'MEDIUM';
    const note = match === 'line±1'
      ? 'matched by line ±1 — the name differs'
      : match === 'name'
        ? 'matched by name — the declaration line moved since the run'
        : freshness === 'unchanged' ? 'reached by the run; source unchanged since' : 'reached by the run; whether the source changed since is unknown';
    addEdge(runId, node.id, { evidence: 'observed', runId: report.runId, lines: hit.lines, match }, {
      status: 'resolved', technique: 'coverage-report', confidence, note,
    });
  }
  return added;
}
