// ESLint checks correctness; Prettier owns formatting (eslint-config-prettier switches off any rule that would
// disagree). An error rule's existing violations are frozen in eslint-suppressions.json: a new violation fails, an
// old one is fixed deliberately and then pruned (`pnpm lint --prune-suppressions`).
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = fileURLToPath(new URL('.', import.meta.url));

// Sentinel's layers (docs/proposals/sentinel-v2/README.md §6): imports point down only, a layer may import its own
// layer and the ones below it. Each key is a folder or a root file of packages/sentinel/src; `review/providers` is
// the future `providers/` and is listed before `review` so its files are not also `review`. `app`, `stages` and
// `providers` are folders the plan adds. The rule is an error. Every upward import that existed when it arrived is
// frozen in eslint-suppressions.json, file by file with its count, so a new one anywhere fails `pnpm lint`, inside a
// folder pair that already has debt too; an import that is removed leaves its suppression unused until it is pruned
// (`pnpm lint --prune-suppressions`); `pnpm lint:boundaries` prints them all. The import-matrix test in
// packages/sentinel/test checks what a count cannot: the exact set of upward imports (one replaced by another
// fails), that this table names every folder, that the rule reports exactly the imports the table says point up,
// and that the import cycle gains no member.
export const SENTINEL_LAYERS = Object.freeze({
  kernel: 0,
  contracts: 1,
  'validate.ts': 1,
  'schemas.generated.ts': 1,
  store: 2,
  snapshot: 3,
  rules: 3,
  policy: 3,
  planner: 3,
  findings: 3,
  reports: 3,
  imports: 3,
  evidence: 3,
  analysis: 3,
  frameworks: 3,
  execution: 4,
  adapters: 5,
  review: 5,
  stages: 5,
  'review/providers': 6,
  providers: 6,
  service: 7,
  app: 7,
  'capabilities.ts': 7,
  transport: 8,
  cli: 8,
  'cli.ts': 8,
  'owner-ui': 8,
  'index.ts': 8,
});
const SENTINEL_SRC = 'packages/sentinel/src';
const sentinelElements = Object.keys(SENTINEL_LAYERS)
  .sort((a, b) => b.split('/').length - a.split('/').length) // nested folders before their parents
  .map((name) =>
    name.endsWith('.ts')
      ? { type: name, pattern: `${SENTINEL_SRC}/${name}`, mode: 'file' }
      : { type: name, pattern: `${SENTINEL_SRC}/${name}`, partialMatch: false },
  );
const namesUpTo = (layer) => Object.keys(SENTINEL_LAYERS).filter((name) => SENTINEL_LAYERS[name] <= layer);
const sentinelPolicies = Object.keys(SENTINEL_LAYERS).map((name) => ({
  from: { element: { type: name } },
  allow: { to: { element: { types: { anyOf: namesUpTo(SENTINEL_LAYERS[name]) } } } },
}));
/** The message the import-matrix test parses: keep `sentinel layers: <from> → <to>` at its start. */
export const SENTINEL_LAYER_MESSAGE =
  'sentinel layers: {{from.type}} → {{to.type}} points up; imports point down only (docs/proposals/sentinel-v2/README.md §6, the debt it found is frozen in eslint-suppressions.json)';

const unused = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'none',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
};

export default defineConfig([
  globalIgnores([
    '**/dist/',
    'build/',
    'coverage/',
    '.claude/worktrees/',
    '.agents/',
    '.private/',
    '.pnpm-store/',
    '_to_delete/',
    'e2e/test-results/',
    'e2e/.playwright-report/',
    'e2e/perf/test-results/',
    'examples/',
    'prototypes/',
    '**/fixtures/',
    'packages/sentinel/rules/',
    'packages/graph/src/schema.ts',
    'packages/sentinel/src/schemas.generated.ts',
  ]),
  { linterOptions: { reportUnusedDisableDirectives: 'warn' } },

  // Every JS and TS file: the recommended correctness rules, plus three with zero violations today.
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', unused],
      'prefer-const': ['error', { destructuring: 'all' }],
      // Structure: reported, never failing; promoted to errors package by package during the refactor.
      complexity: ['warn', 25],
      'max-depth': ['warn', 5],
      'max-params': ['warn', 5],
      'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
      'no-nested-ternary': 'warn',
    },
  },

  // TypeScript, without type information (fast, and test folders have no tsconfig yet).
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.recommended],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unused],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Where the code runs.
  {
    files: ['packages/server/public/**/*.js', 'packages/echo/public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'packages/*/{src,test,scripts}/**',
      'scripts/**',
      'e2e/**',
      'tools/**',
      '.claude/**/*.{js,mjs}',
      '*.config.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },

  // Sentinel's layers; today's upward imports are frozen as known debt (see SENTINEL_LAYERS).
  {
    files: [`${SENTINEL_SRC}/**/*.ts`],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': root,
      'boundaries/elements': sentinelElements,
      'boundaries/elements-single-match': true,
      // `mode: 'file'` is the only way 7.2.0 classifies a single root file; it is deprecated, not removed.
      'boundaries/legacy-warnings': false,
      'import/resolver': { [fileURLToPath(new URL('./scripts/eslint-resolve-ts.cjs', import.meta.url))]: {} },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        { default: 'disallow', policies: sentinelPolicies, message: SENTINEL_LAYER_MESSAGE },
      ],
    },
  },

  prettier,
]);
