// ESLint checks correctness; Prettier owns formatting (eslint-config-prettier switches off any rule that would
// disagree). An error rule's existing violations are frozen in eslint-suppressions.json: a new violation fails, an
// old one is fixed deliberately and then pruned (`pnpm lint --prune-suppressions`).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    files: ['packages/*/{src,test,scripts}/**', 'scripts/**', 'e2e/**', 'tools/**', '*.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },

  prettier,
]);
