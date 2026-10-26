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
