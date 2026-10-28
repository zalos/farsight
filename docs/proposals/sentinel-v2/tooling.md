# Phase 0 reference — formatter, linter, hooks and the no-change proof

The exact files the phase-0 PR adds, from the 2026-10-23 tooling audit (versions verified against the npm registry that day). The plan ([README.md](README.md) §7) explains the choices; [tasks.md](tasks.md) phase 0 sequences them. `ast-equivalence.mjs` beside this file is the tested prototype of the no-functional-change checker.

## 6. Files to add

### 6.1 `package.json` (root)

```jsonc
  "scripts": {
    // …existing…
    "format": "prettier --write --cache .",
    "format:check": "prettier --check --cache .",
    "lint": "eslint --cache --cache-location node_modules/.cache/eslint/ --quiet .",
    "lint:report": "eslint --cache --cache-location node_modules/.cache/eslint/ .",
    "verify:format": "node scripts/ast-equivalence.mjs",
    "prepare": "node scripts/install-hooks.mjs"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@modelcontextprotocol/sdk": "^1.32.0",
    "@playwright/test": "1.62.1",
    "@types/node": "^26.1.0",
    "esbuild": "^0.28.1",
    "eslint": "10.13.0",
    "eslint-config-prettier": "10.1.8",
    "globals": "17.13.0",
    "lefthook": "2.2.2",
    "prettier": "3.9.10",
    "ts-json-schema-generator": "2.9.0",
    "typescript": "^5.5.0",
    "typescript-eslint": "8.72.0"
  },
```

### 6.2 `prettier.config.mjs`

```js
// Prettier formats JavaScript and TypeScript only for now (see .prettierignore). Each option matches what most of
// the repository already writes, so a formatting PR changes spacing and line breaks, never the program.
/** @type {import('prettier').Config} */
export default {
  printWidth: 120, // the width the clean packages already use (p90 ≈ 121 outside Sentinel)
  singleQuote: true, // 94–100 % today; several tests match source text with single quotes
  semi: true,
  trailingComma: 'all', // every multi-line literal already ends with a comma
  arrowParens: 'always', // Prettier's default; what core, server, the viewer and e2e write
  quoteProps: 'preserve', // never turn 'a': into a: — keeps a formatting PR AST-identical
  objectWrap: 'preserve',
  embeddedLanguageFormatting: 'off', // never touch code inside template literals (worker sources, HTML)
  endOfLine: 'lf',
};
```

### 6.3 `.prettierignore`

```gitignore
# Generated, rewritten byte for byte and drift-checked in CI (graph-schema --check, sentinel schemas:check)
packages/graph/src/schema.ts
packages/sentinel/src/schemas.generated.ts

# Inputs whose bytes or line numbers tests, scanners or retained evidence assert
examples/
prototypes/
**/fixtures/
packages/sentinel/rules/
# the PR 01 feasibility harness: sha256-pinned in docs/proposals/farsight-sentinel/evidence/
scripts/sentinel-feasibility.mjs
scripts/sentinel-feasibility-*.mjs
scripts/sentinel-feasibility/

# String catalogs: one key per line by design
packages/core/src/strings.ts
packages/core/src/strings-*.ts

# Build output and local state (.claude/worktrees is ignored only by .git/info/exclude, which Prettier does not read)
**/dist/
build/
coverage/
graph.json
.farsight/
.echo/
.claude/worktrees/
.agents/
.private/
.pnpm-store/
_to_delete/
e2e/test-results/
e2e/.playwright-report/
e2e/perf/test-results/
pnpm-lock.yaml
eslint-suppressions.json

# This phase formats JavaScript and TypeScript only
*.json
*.jsonc
*.json5
*.md
*.yml
*.yaml
*.html
*.css

# Not formatted yet: each style PR deletes its line; delete the block when it is empty
packages/sentinel/
scripts/
packages/core/
packages/server/
packages/parsers/
packages/code-parser/
packages/mcp/
packages/cli/
packages/echo/
packages/graph/
packages/work/
packages/work-azdo/
packages/work-jira/
packages/work-fixture/
packages/app/
e2e/
tools/
```

### 6.4 `eslint.config.mjs`

```js
// ESLint checks correctness; Prettier owns formatting (eslint-config-prettier switches off any rule that would
// disagree). An error rule's existing violations are frozen in eslint-suppressions.json: a new violation fails, an
// old one is fixed deliberately and then pruned (`pnpm lint --prune-suppressions`).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unused = {
  args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
  destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true,
};

export default defineConfig([
  globalIgnores([
    '**/dist/', 'build/', 'coverage/', '.claude/worktrees/', '.agents/', '.private/', '.pnpm-store/', '_to_delete/',
    'e2e/test-results/', 'e2e/.playwright-report/', 'e2e/perf/test-results/',
    'examples/', 'prototypes/', '**/fixtures/', 'packages/sentinel/rules/',
    'packages/graph/src/schema.ts', 'packages/sentinel/src/schemas.generated.ts',
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
  { files: ['packages/server/public/**/*.js', 'packages/echo/public/**/*.js'], languageOptions: { globals: globals.browser } },
  {
    files: ['packages/*/{src,test,scripts}/**', 'scripts/**', 'e2e/**', 'tools/**', '*.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },

  prettier,
]);
```

Then, once, in the tooling PR: `pnpm exec eslint . --suppress-all` → commit `eslint-suppressions.json` (counts per
file per rule, so later reformatting does not invalidate it). Record the per-rule totals in the PR body.

### 6.5 `lefthook.yml`

```yaml
# Git hooks for this clone: `pnpm install` runs scripts/install-hooks.mjs, which runs `lefthook install`.
# Every linked worktree of this repository shares one hooks directory, so:
#  - never add a Git LFS hook here (pre-push, post-checkout, post-commit, post-merge): lefthook would take it over
#    and run `git lfs` itself, but only in worktrees whose branch has this file — the others would skip LFS;
#  - no_auto_install: a commit in one worktree must not rewrite the hooks that every other worktree runs.
# Skip once with LEFTHOOK=0; CI checks the same things on every pull request.
min_version: 2.2.2
no_auto_install: true
glob_matcher: doublestar

pre-commit:
  jobs:
    - name: no commits on main
      run: |
        if [ "$(git symbolic-ref --short -q HEAD)" = main ] && [ -z "$FARSIGHT_ALLOW_MAIN_COMMIT" ]; then
          echo "pre-commit: main takes no direct commits; create a branch and open a PR" >&2
          exit 1
        fi
    - name: prettier
      glob: '**/*.{js,mjs,cjs,ts,mts,cts}'
      run: node_modules/.bin/prettier --write --ignore-unknown --no-error-on-unmatched-pattern {staged_files}
      stage_fixed: true
    - name: eslint
      glob: '**/*.{js,mjs,cjs,ts,mts,cts}'
      run: node_modules/.bin/eslint --quiet --no-warn-ignored --pass-on-unpruned-suppressions {staged_files}

commit-msg:
  jobs:
    - name: conventional commit
      run: node scripts/lint-commits.mjs --file {1} --any-scope
```

Jobs run in order (Prettier writes before ESLint reads). A worktree without `pnpm install` fails the prettier job with
"not found" — the fix is `pnpm install`, which the worktree needs anyway.

### 6.6 `scripts/install-hooks.mjs` (replaces the copy-from-`.githooks` installer; delete `.githooks/`)

```js
#!/usr/bin/env node
// Installs this clone's Git hooks with lefthook (lefthook.yml) and the commit template. Run by `pnpm install`
// (root `prepare`); a no-op in CI and outside a Git checkout. Linked worktrees share the main clone's hooks
// directory. lefthook writes only the hooks lefthook.yml names, so the Git LFS hooks there stay as they are.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.CI) { console.log('install-hooks: CI, nothing to install'); process.exit(0); }
let hooksDir;
try {
  hooksDir = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
} catch { console.log('install-hooks: not a git checkout, nothing to install'); process.exit(0); }

// The commit-msg hook this script used to copy from .githooks/. A pre-lefthook branch's `pnpm install` may copy it
// back; remove that exact file so lefthook does not keep it as commit-msg.old. Any other hook is lefthook's to rename.
const LEGACY = new Set(['fc435bb843c74a874ab5ed8888f5f8f18807400bb15eeb811b1809f1cd3c7e3f']);
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const name of ['commit-msg']) { const p = join(hooksDir, name); if (existsSync(p) && LEGACY.has(sha(p))) rmSync(p); }

try {
  const bin = createRequire(import.meta.url).resolve('lefthook/bin/index.js');
  execFileSync(process.execPath, [bin, 'install'], { cwd: root, stdio: 'inherit' });
} catch (err) {
  // A hook left as <name>.old by an earlier install blocks a rename; say how to fix it, never fail the install.
  console.warn(`install-hooks: lefthook install failed (${err.message}); look in ${hooksDir} for *.old files`);
}
const config = (k, v) => { try { execFileSync('git', ['config', '--local', k, v], { cwd: root, stdio: 'ignore' }); } catch {} };
config('commit.template', '.gitmessage');
// git blame fails when blame.ignoreRevsFile names a missing file, so set it only once the file exists.
if (existsSync(join(root, '.git-blame-ignore-revs'))) config('blame.ignoreRevsFile', '.git-blame-ignore-revs');
```

Update `scripts/test/install-hooks.test.mjs` (worktree case: lefthook's commit-msg lands in the common hooks dir; a
legacy copy is removed; an LFS `pre-push` stays byte-identical).

### 6.7 CI job (`.github/workflows/ci.yml`) — no selector change needed

```yaml
  # Required. Runs whenever any runtime check is selected (code, config or dependency changes);
  # a documentation-only change skips it explicitly, which satisfies the required check.
  lint:
    name: lint
    needs: changes
    if: ${{ !cancelled() && (needs.changes.outputs.validate != 'false' || needs.changes.outputs.e2e != 'false' || needs.changes.outputs.echo != 'false' || needs.changes.outputs.sentinel != 'false' || needs.changes.outputs.isolation != 'false') }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the style-PR check reads the merge base; no LFS assets needed
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Formatting (Prettier)
        run: pnpm format:check
      - name: Lint (ESLint errors; existing ones are frozen in eslint-suppressions.json)
        run: pnpm lint
      - name: A style pull request changes no program (AST-identical to its merge base)
        if: ${{ github.event_name == 'pull_request' && startsWith(github.event.pull_request.title, 'style') }}
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: node scripts/ast-equivalence.mjs "$(git merge-base "$BASE_SHA" "$HEAD_SHA")" "$HEAD_SHA"
```

`scripts/ci-changes.mjs` needs no edit: docs-only selections are all `false`, so `lint` skips; anything else (incl.
`eslint.config.mjs`, `.prettierignore`, `lefthook.yml`, the lockfile) falls into the selector's "everything else →
all" branch. Missing outputs run the job (same fail-open rule as the other jobs). Cost ≈ 1.5–2.5 runner-minutes
(install from cache ~40 s, Prettier check of ~1,300 files / ~16 MB, untyped ESLint), parallel with validate/e2e.
After the first run, the owner adds `lint` to branch protection (required checks become seven) and updates
`docs/CI.md`, `CONTRIBUTING.md`, the `git-pr-flow` skill ("six required checks") and `AGENTS.md` (commands +
the LFS/stash/`no_auto_install` gotchas).

## 7. No-functional-change proof: `scripts/ast-equivalence.mjs`

Prototype written and tested ([tooling/ast-equivalence.mjs](tooling/ast-equivalence.mjs), ~100 lines, no new dependency; it uses the repo's
TypeScript). For every modified JS/TS file between two revisions it parses both versions and compares a trivia-free
token stream: node kinds; identifiers; **cooked** string values (quote style ignored); raw template text (byte-exact);
numeric values; regex body + sorted flags; meaning-bearing node flags (`let`/`const`/`using`, optional-chain extent,
namespaces); it unwraps `ParenthesizedExpression`/`ParenthesizedType`, ignores trailing commas, empty statements and
`;` class elements, treats an empty list as absent. Comments are compared as a separate normalised sequence (warning,
or failure with `--strict-comments`). Any added/deleted/renamed code file fails a style PR.

Self-test results:
- Re-printing 617 real files (Sentinel src, viewer, scripts, core) with TypeScript's own printer as a stand-in
  formatter → **0 AST differences** in 3.3 s (2 comment-placement warnings, printer quirks).
- Planted edits correctly flagged as **different**: `==`→`===`, `a && b || c`→`a && (b || c)`, `(a?.b).c`→`a?.b.c`,
  `let`→`const`, a changed template literal, `'a':`→`a:`, `x = (1, 2)`→`x = 1, 2`, the ASI hazard `a\n(b)`→`a;\n(b)`,
  added braces, `for (const` → `for (let`. Correctly **same**: quote swaps, trailing comma, `0x1F`/`31`, regex flag
  order, `new Foo`/`new Foo()`, `x =>`/`(x) =>`, spacing inside `${}`, `import{a}from'm'`→`import { a } from 'm';`,
  stray `;`, `1_000`/`1000`.
- On real history: the docs commit `HEAD~1..HEAD` → 0 files; a feature commit → 29 AST differences and 11 added files
  reported (it would refuse that as a "style" PR). Runtime < 1 s for 28 files.

(Copy [tooling/ast-equivalence.mjs](tooling/ast-equivalence.mjs) to `scripts/ast-equivalence.mjs` with a
`scripts/test/ast-equivalence.test.mjs` holding the planted cases.)

