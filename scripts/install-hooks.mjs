#!/usr/bin/env node
// Installs the repo's git hooks and the commit template into this clone. Run by
// `pnpm install` (the root `prepare` script) and harmless anywhere else: without a
// .git directory (a CI checkout of a tarball, a worktree whose hooks live in the
// main clone) it says so and exits 0. It copies into .git/hooks rather than
// setting core.hooksPath, so the Git LFS hooks that already live there stay.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '.githooks');
let hooksDir;
try {
  hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (!hooksDir) throw new Error('no hooks path');
  hooksDir = join(root, hooksDir);
} catch {
  console.log('install-hooks: not a git checkout, nothing to install');
  process.exit(0);
}
if (process.env.CI) { console.log('install-hooks: CI, nothing to install'); process.exit(0); }
mkdirSync(hooksDir, { recursive: true });
const installed = [];
for (const name of readdirSync(src)) {
  copyFileSync(join(src, name), join(hooksDir, name));
  chmodSync(join(hooksDir, name), 0o755);
  installed.push(name);
}
try {
  execFileSync('git', ['config', '--local', 'commit.template', '.gitmessage'], { cwd: root, stdio: 'ignore' });
  installed.push('commit.template=.gitmessage');
} catch { /* a read-only config is not worth failing an install over */ }
if (existsSync(join(root, '.gitmessage'))) console.log(`install-hooks: ${installed.join(', ')} → ${hooksDir}`);
