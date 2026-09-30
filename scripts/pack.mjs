#!/usr/bin/env node
/**
 * Builds the publishable `farsight-cli` package: bundles the CLI (workspace
 * packages inlined) into build/farsight-cli/ with the viewer assets and a
 * standalone package.json, then `npm pack`s it into a tarball.
 *
 *   pnpm build && node scripts/pack.mjs
 *   npm install -g ./build/farsight-cli-*.tgz
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'farsight-cli');
const workspaceVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// the git facts, by the rule the workspace build stamps with (core's gitIdentity:
// HEAD, the last commit that touched the code, and whether the code is dirty) —
// so a server run from the workspace and this tarball, built from one clean
// commit, are one build to `farsight status` however many seconds apart they were
// compiled. Needs `pnpm build` first, as the usage above says.
const { gitIdentity } = await import(join(root, 'packages', 'core', 'dist', 'version.js'));
const git = gitIdentity(root);
const commit = git.commit;
// the build identity every consumer can read back: `farsight --version`, MCP graph_overview, /api/version, the HUD sync chip
const buildIdentity = {
  version: workspaceVersion, built: new Date().toISOString(),
  ...(commit ? { commit } : {}),
  ...(git.codeCommit ? { codeCommit: git.codeCommit } : {}),
  ...(git.codeCommit && typeof git.dirty === 'boolean' ? { dirty: git.dirty } : {}),
};
rmSync(join(root, 'build'), { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

await build({
  entryPoints: [join(root, 'packages/cli/src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(out, 'dist/farsight.mjs'),
  // native/WASM and SDK deps stay external; everything @farsight/* is inlined
  // entry's own shebang is preserved by esbuild (tree-sitter grammars resolve
  // from the installed @vscode/tree-sitter-wasm package at runtime)
  external: ['oxc-parser', '@vscode/tree-sitter-wasm', '@modelcontextprotocol/sdk', 'zod'],
  // inlined CommonJS deps (e.g. `yaml`) call require() for node builtins; an
  // ESM bundle has no require, so give it one — otherwise the CLI dies at load
  // with "Dynamic require of "process" is not supported"
  banner: {
    js: "import { createRequire as __farsightCreateRequire } from 'node:module';\nconst require = __farsightCreateRequire(import.meta.url);",
  },
  // packages/core/src/version.ts reads this constant; a workspace build derives the same facts at runtime
  define: { __FARSIGHT_BUILD__: JSON.stringify(buildIdentity) },
});

// the same identity, readable from disk: a running server compares the bundle it
// holds in memory with the one installed now (core installState → sameBuild), so a
// re-pack of the same clean commit is not "restart", and a new one is
writeFileSync(join(out, 'dist', 'build-stamp.json'), JSON.stringify(buildIdentity, null, 2) + '\n');
cpSync(join(root, 'packages/server/public'), join(out, 'public'), { recursive: true });
cpSync(join(root, 'README.md'), join(out, 'README.md'));

writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'farsight-cli',
      version: workspaceVersion,
      description: 'Parse codebases into a semantic graph; explore it in a game-inspired HUD or feed it to LLM agents via MCP.',
      license: 'MIT',
      type: 'module',
      bin: { farsight: 'dist/farsight.mjs' },
      files: ['dist', 'public', 'README.md'],
      dependencies: {
        'oxc-parser': '^0.138.0',
        '@vscode/tree-sitter-wasm': '^0.3.1',
        '@modelcontextprotocol/sdk': '^1.12.0',
        zod: '^3.24.0',
      },
      engines: { node: '>=20' },
    },
    null,
    2,
  ) + '\n',
);

execSync('npm pack --pack-destination ..', { cwd: out, stdio: 'inherit' });
console.log('\npackaged: build/farsight-cli-' + workspaceVersion + '.tgz  (built ' + buildIdentity.built + (commit ? ', commit ' + commit : '') + (buildIdentity.dirty ? ', with uncommitted changes' : '') + ')');
console.log('install:  npm install -g ./build/farsight-cli-' + workspaceVersion + '.tgz');
