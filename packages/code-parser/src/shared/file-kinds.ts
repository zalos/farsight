import type { TestRef } from '@farsight/graph';
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
        if (chars[i + 1] === '/') {
          i++;
          out += '(?:[^/]+/)*';
        } else out += '.*';
      } else out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}(?:/.*)?$`);
}

/** The default claim globs. Line comments only in this file — a `*​/` inside a block comment ends it. */
export const DEFAULT_TEST_GLOBS = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.mts',
  '**/*.test.mjs',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/*.spec.mts',
  '**/*.spec.mjs',
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

const RUNNER_IMPORT_RE =
  /(?:^|\n)\s*(?:import[\s\S]{0,200}?from\s*|import\s*|(?:const|let|var)[\s\S]{0,120}?=\s*require\s*\(\s*)['"]([^'"]+)['"]/g;

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

export function isStoryFile(rel: string): boolean {
  return /\.(stories|story)\.[cm]?[jt]sx?$/.test(rel);
}
