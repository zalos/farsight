#!/usr/bin/env node
/**
 * Builds the publishable `farsight-cli` package: bundles the CLI (workspace
 * packages inlined) into build/farsight-cli/ with the viewer assets and a
 * standalone package.json, then `npm pack`s it into a tarball.
 *
 *   pnpm build && node scripts/pack.mjs
 *   npm install -g ./build/farsight-cli-*.tgz
 *   node scripts/pack.mjs --check   # preflight and a full staged bundle; replaces nothing
 *
 * Everything is built in a staging directory under build/. Only when the bundle and the
 * tarball both succeed are build/farsight-cli and build/farsight-cli-*.tgz replaced; other
 * packages' outputs in build/ (echo, sentinel, parser) are left alone, and a failure leaves
 * every prior artifact in place.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTarball, missingBuildOutputs, npmPackEnv } from './pack-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
const workspacePkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspaceVersion = workspacePkg.version;
// the git facts, by the rule the workspace build stamps with (core's gitIdentity:
// HEAD, the last commit that touched the code, and whether the code is dirty) —
// so a server run from the workspace and this tarball, built from one clean
// commit, are one build to `farsight status` however many seconds apart they were
// compiled. Needs `pnpm build` first, as the usage above says.
const versionModule = join(root, 'packages', 'core', 'dist', 'version.js');
// Only the CLI's own workspace dependency closure must be built: an optional package
// outside it (Sentinel, Echo) may be absent or unbuilt. Checked before build/ is touched.
const missing = missingBuildOutputs(root, '@farsight/cli', [versionModule]);
if (missing.length) {
  console.error('pack: compiled packages are missing. Run `pnpm build && node scripts/pack.mjs` from the repository root.');
  for (const path of missing) console.error('  missing: ' + (isAbsolute(path) ? relative(root, path) : path));
  process.exit(1);
}
const check = process.argv.includes('--check');
const { gitIdentity } = await import(versionModule);
const git = gitIdentity(root);
const commit = git.commit;
// the build identity every consumer can read back: `farsight --version`, MCP graph_overview, /api/version, the HUD sync chip
const buildIdentity = {
  version: workspaceVersion, built: new Date().toISOString(),
  ...(commit ? { commit } : {}),
  ...(git.codeCommit ? { codeCommit: git.codeCommit } : {}),
  ...(git.codeCommit && typeof git.dirty === 'boolean' ? { dirty: git.dirty } : {}),
};
mkdirSync(buildDir, { recursive: true });
const stage = mkdtempSync(join(buildDir, '.stage-farsight-cli-'));
const out = join(stage, 'farsight-cli');
const tarball = `farsight-cli-${workspaceVersion}.tgz`;
try {
  mkdirSync(join(out, 'dist'), { recursive: true });

  await build({
    logLevel: 'silent',
    entryPoints: [join(root, 'packages/cli/src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
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
        // npm's provenance check requires the package to name the repository it was built from
        ...(workspacePkg.repository ? { repository: workspacePkg.repository } : {}),
        type: 'module',
        bin: { farsight: 'dist/farsight.mjs' },
        files: ['dist', 'public', 'README.md'],
        dependencies: {
          'oxc-parser': '^0.138.0',
          '@vscode/tree-sitter-wasm': '^0.3.1',
          '@modelcontextprotocol/sdk': '^1.32.0',
          zod: '^3.25.0',
        },
        // the workspace's own runtime floor (node:sqlite history needs Node 24), not a looser claim
        engines: { node: workspacePkg.engines?.node ?? '>=24' },
      },
      null,
      2,
    ) + '\n',
  );

  if (!check) {
    execSync('npm pack --pack-destination ..', { cwd: out, stdio: 'inherit', env: npmPackEnv() });
    assertTarball(join(stage, tarball)); // before anything prior is removed
  }
} catch (error) {
  rmSync(stage, { recursive: true, force: true });
  const detail = error?.errors?.length ? error.errors.map((e) => `${e.location?.file ?? ''} ${e.text}`.trim()).join('\n  ') : error?.message;
  console.error(`pack: the bundle or the tarball failed; prior artifacts in build/ are unchanged. Run \`pnpm build\` and retry.\n  ${detail}`);
  process.exit(1);
}
if (check) {
  rmSync(stage, { recursive: true, force: true });
  console.log('pack: build prerequisites present and the bundle resolves; nothing was replaced');
  process.exit(0);
}
// publish: only this package's outputs are replaced (an old version's tarball would match the install glob)
rmSync(join(buildDir, 'farsight-cli'), { recursive: true, force: true });
for (const name of readdirSync(buildDir)) if (/^farsight-cli-.+\.tgz$/.test(name)) rmSync(join(buildDir, name));
renameSync(out, join(buildDir, 'farsight-cli'));
renameSync(join(stage, tarball), join(buildDir, tarball));
rmSync(stage, { recursive: true, force: true });
console.log('\npackaged: build/farsight-cli-' + workspaceVersion + '.tgz  (built ' + buildIdentity.built + (commit ? ', commit ' + commit : '') + (buildIdentity.dirty ? ', with uncommitted changes' : '') + ')');
console.log('install:  npm install -g ./build/farsight-cli-' + workspaceVersion + '.tgz');
