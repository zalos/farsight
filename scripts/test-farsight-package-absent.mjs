#!/usr/bin/env node
// farsight-cli with no Sentinel package in the workspace at all: copies this checkout's tracked and
// untracked-but-not-ignored files, minus packages/sentinel/, into a temporary workspace (not a Git
// checkout, so no hooks are installed), installs it from the pnpm store, builds only the CLI's
// closure, packs, and runs scripts/test-farsight-package.mjs there (clean npm consumer, ingest,
// read-only serve). The present-but-unbuilt case runs against the checkout itself.
//
//   pnpm test:cli:package:absent
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean);
const scratch = mkdtempSync(join(tmpdir(), 'farsight-absent-sentinel-'));
const copy = join(scratch, 'workspace');
let status = 1;
try {
  let copied = 0;
  for (const file of files) {
    if (file === 'packages/sentinel' || file.startsWith('packages/sentinel/')) continue;
    const from = join(root, file);
    if (!existsSync(from)) continue; // deleted in the working tree
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(from, join(copy, file));
    copied++;
  }
  if (existsSync(join(copy, 'packages/sentinel'))) throw new Error('packages/sentinel was copied');
  console.log(`absent-sentinel workspace: ${copied} files, no packages/sentinel`);
  // the lockfile may name the Sentinel importer; this throwaway copy may resolve without it
  const step = (command, args) => {
    const run = spawnSync(command, args, { cwd: copy, stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in the absent-sentinel workspace`);
  };
  step('pnpm', ['install', '--no-frozen-lockfile', '--prefer-offline']);
  step('pnpm', ['pack:cli']);
  if (existsSync(join(copy, 'packages/sentinel'))) throw new Error('packages/sentinel appeared during install or build');
  step(process.execPath, ['scripts/test-farsight-package.mjs']);
  console.log('farsight package ok with Sentinel absent from the workspace');
  status = 0;
} catch (error) {
  console.error(`test-farsight-package-absent: ${error.message}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
