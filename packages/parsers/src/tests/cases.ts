/**
 * Claiming test files and pulling the cases out of them
 * (docs/proposals/tests-surface.md §3.2 steps 1–2).
 *
 * A file is a test when its path matches a test glob OR it imports a known
 * runner. Claimed files stop producing `function` nodes in the TS/JS adapter —
 * that is what removes today's stray spec-file symbols and lets a repo drop its
 * `e2e/**` exclude.
 *
 * Nothing here runs a test. Everything is syntax.
 */
import { walk, isNode, lineIndex, stringValue, memberChain, type AstNode } from '../walk.js';

import { parseDoc, docCommentAbove, type ParsedDoc } from '../shared/docs.js';
import type { TestRef } from '@farsight/core';

/**
 * Glob → RegExp for test paths. `shared/files.ts` has its own, but its `**` /
 * `*` rewrite order collapses `**​/` into a single-segment match, which a claim
 * glob like `**​/*.spec.ts` cannot live with. Tokenized here instead.
 */
export function testGlobToRegExp(glob: string): RegExp {
  let out = '';
  const chars = [...glob];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '*') {
      if (chars[i + 1] === '*') {
        i++;
        if (chars[i + 1] === '/') { i++; out += '(?:[^/]+/)*'; } else out += '.*';
      } else out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}(?:/.*)?$`);
}

/** The default claim globs. Line comments only in this file — a `*​/` inside a block comment ends it. */
export const DEFAULT_TEST_GLOBS = [
  '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx', '**/*.test.mts', '**/*.test.mjs',
  '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx', '**/*.spec.mts', '**/*.spec.mjs',
  '**/__tests__/**',
  'e2e/**',
  'test/**',
  'tests/**',
];

/** Import specifiers that make a file a test whatever it is called. */
const RUNNER_SPECIFIERS: Record<string, TestRef['runner']> = {
  'vitest': 'vitest',
  '@jest/globals': 'jest',
  'jest': 'jest',
  'node:test': 'node:test',
  '@playwright/test': 'playwright',
  'playwright/test': 'playwright',
  'cypress': 'cypress',
};

const RUNNER_IMPORT_RE = /(?:^|\n)\s*(?:import[\s\S]{0,200}?from\s*|import\s*|(?:const|let|var)[\s\S]{0,120}?=\s*require\s*\(\s*)['"]([^'"]+)['"]/g;

export interface TestGlobs {
  include?: string[];
  exclude?: string[];
}

/** Every runner specifier a file imports (cheap text scan — no AST needed to claim a file). */
export function runnerImports(source: string): TestRef['runner'][] {
  const out: TestRef['runner'][] = [];
  RUNNER_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUNNER_IMPORT_RE.exec(source))) {
    const runner = RUNNER_SPECIFIERS[m[1]!];
    if (runner && !out.includes(runner)) out.push(runner);
  }
  return out;
}

/**
 * Is this repo-relative path a test file? Globs first (cheap), then the runner
 * import sniff. `globs.exclude` un-claims what the defaults would have taken.
 */
export function isTestFile(rel: string, source?: string, globs: TestGlobs = {}): boolean {
  const path = rel.replace(/^\.\//, '');
  if ((globs.exclude ?? []).some((g) => testGlobToRegExp(g).test(path))) return false;
  const include = [...DEFAULT_TEST_GLOBS, ...(globs.include ?? [])];
  if (include.some((g) => testGlobToRegExp(g).test(path))) return true;
  return !!source && runnerImports(source).length > 0;
}

/** Which runner a claimed file uses — its imports, else a guess from its name. */
export function runnerOf(rel: string, source: string): TestRef['runner'] {
  const imported = runnerImports(source)[0];
  if (imported) return imported;
  if (/\.pw\.spec\./.test(rel) || /(^|\/)e2e\//.test(rel)) return 'playwright';
  if (/\.cy\./.test(rel) || /(^|\/)cypress\//.test(rel)) return 'cypress';
  return 'other';
}

/** unit · integration · e2e — from the runner, the path, and the filename convention. */
export function levelOf(rel: string, runner: TestRef['runner']): TestRef['level'] {
  if (runner === 'playwright' || runner === 'cypress') return 'e2e';
  if (/(^|\/)e2e\//.test(rel) || /\.e2e\./.test(rel)) return 'e2e';
  if (/\.integration\./.test(rel) || /(^|\/)integration\//.test(rel)) return 'integration';
  return 'unit';
}

const LIFECYCLE = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll', 'use', 'extend', 'configure', 'setTimeout', 'info', 'expect', 'slow', 'fail']);
const SUITE_HEADS = new Set(['describe', 'suite', 'context']);
const CASE_HEADS = new Set(['it', 'test', 'specify']);

interface CallShape {
  kind: 'suite' | 'case' | 'step' | null;
  /** .skip / .only / .each / .todo / .failing / … as written */
  mods: string[];
}

/** What a `describe(…)` / `it.each(…)(…)` / `test.step(…)` call is, from its callee chain. */
export function classifyCall(chain: string[]): CallShape {
  const head = chain[0];
  if (!head) return { kind: null, mods: [] };
  if (!SUITE_HEADS.has(head) && !CASE_HEADS.has(head)) return { kind: null, mods: [] };
  const rest = chain.slice(1);
  if (rest.some((r) => LIFECYCLE.has(r))) return { kind: null, mods: [] };
  if (rest.includes('describe')) return { kind: 'suite', mods: rest.filter((r) => r !== 'describe') };
  if (rest.includes('step')) return { kind: 'step', mods: [] };
  if (SUITE_HEADS.has(head)) return { kind: 'suite', mods: rest };
  return { kind: 'case', mods: rest };
}

/** One extracted test case — the raw material for a `test` node. */
export interface TestCase {
  /** describe path, outermost first */
  suite: string[];
  title: string;
  /** the title came from a template literal or `.each` row — it is a shape, not the exact reported name */
  heuristicTitle: boolean;
  line: number;
  endLine: number;
  /** .skip / .only / .todo / .each / .failing as written */
  mods: string[];
  /** `.skip`/`.todo` on the case or on any describe above it — the case exists but ran nowhere */
  inactive: boolean;
  /** `@covers` values from the case's own doc comment */
  declares: string[];
  /** `test.step('…')` titles inside the case */
  steps: string[];
  docs?: string;
}

export interface ExtractedFile {
  runner: TestRef['runner'];
  level: TestRef['level'];
  /** `@covers` values from the file header doc comment — they apply to every case in the file */
  fileDeclares: string[];
  fileDocs?: string;
  cases: TestCase[];
}

/** The file's leading doc block (`/** … *​/` with nothing but whitespace or line comments before it). */
export function fileHeaderDoc(source: string): ParsedDoc | null {
  const head = source.slice(0, 16000);
  // the header region is everything before the first case/suite call — a block after
  // that belongs to one case, not to the file
  const firstCase = head.search(/^\s*(?:export\s+)?(?:test|it|describe|suite)\s*[.(]/m);
  const limit = firstCase >= 0 ? firstCase : head.length;
  const blocks: string[] = [];
  // `(?:(?!\*\/)[\s\S])*` so a block can never swallow the `*` + `/` that ends it
  // and run on into the rest of the file (this is what once ate a whole spec)
  const re = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    if (m.index >= limit) break;
    blocks.push(m[1]!);
    if (blocks.length >= 12) break;
  }
  if (!blocks.length) return null;
  const chosen = blocks.find((b) => /(^|\n)\s*\*?\s*@covers\b/.test(b)) ?? blocks[blocks.length - 1]!;
  return parseDoc(chosen.replace(/^\s*\*\s?/gm, '').trim());
}

const between = /^\s*(?:export\s+)?(?:async\s+)?(?:const\s+)?\s*$/;

/** Modifiers that mean the case exists but did not run — on the case or on a describe above it. */
const INACTIVE_MODS = ['skip', 'todo'];

/**
 * Walk describe/it/test (and `.each`, `.skip`, `.only`, `test.describe`) into
 * flat cases with their describe path. `test.step` titles ride along on the
 * enclosing case as remarks.
 */
export function extractCases(program: AstNode, source: string, rel: string): ExtractedFile {
  const line = lineIndex(source);
  const runner = runnerOf(rel, source);
  const level = levelOf(rel, runner);
  const header = fileHeaderDoc(source);
  const cases: TestCase[] = [];

  // suite titles by AST node, so a case can read its describe path off `parents`
  const suiteTitle = new Map<AstNode, string>();
  // `describe.skip` / `describe.todo` — every case under it is inactive too
  const suiteMods = new Map<AstNode, string[]>();
  const stepsOf = new Map<AstNode, string[]>();

  walk(program, (n, parents) => {
    if (n.type !== 'CallExpression') return;
    // it.each(table)('…', fn): the callee is itself a call
    let calleeNode = n.callee;
    let each = false;
    if (isNode(calleeNode) && calleeNode.type === 'CallExpression') { calleeNode = calleeNode.callee; each = true; }
    const chain = memberChain(calleeNode);
    const shape = classifyCall(chain);
    if (!shape.kind) return;
    const args = (n.arguments as AstNode[]) ?? [];
    const titleArg = args[0];
    const raw = stringValue(titleArg);
    if (raw == null) return;
    const heuristicTitle = each || (isNode(titleArg) && titleArg.type === 'TemplateLiteral');
    const mods = each ? [...shape.mods, 'each'] : shape.mods;

    if (shape.kind === 'suite') { suiteTitle.set(n, raw); suiteMods.set(n, mods); return; }
    const enclosingCase = [...parents].reverse().find((p) => stepsOf.has(p));
    if (shape.kind === 'step') {
      if (enclosingCase) stepsOf.get(enclosingCase)!.push(raw);
      return;
    }
    const suite = parents.filter((p) => suiteTitle.has(p)).map((p) => suiteTitle.get(p)!);
    const inactive = INACTIVE_MODS.some((m) => mods.includes(m))
      || parents.some((p) => (suiteMods.get(p) ?? []).some((m) => INACTIVE_MODS.includes(m)));
    const doc = parseDoc(docCommentAbove(source, n.start ?? 0, between));
    const steps: string[] = [];
    stepsOf.set(n, steps);
    cases.push({
      suite,
      title: raw,
      heuristicTitle,
      line: line(n.start ?? 0),
      endLine: line(n.end ?? 0),
      mods,
      inactive,
      declares: doc.covers ?? [],
      steps,
      ...(doc.docs ? { docs: doc.docs } : {}),
    });
  });

  return {
    runner, level,
    fileDeclares: header?.covers ?? [],
    ...(header?.docs ? { fileDocs: header.docs } : {}),
    cases,
  };
}
