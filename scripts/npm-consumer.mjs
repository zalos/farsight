// A clean npm consumer for package smokes: `npm init -y` in a temporary directory, then
// `npm install <tarball>` the way a user outside this pnpm workspace would. No workspace
// node_modules, no pnpm, user config and state redirected into the scratch directory.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function npmConsumer(prefix, tarballs) {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(scratch, 'consumer');
  mkdirSync(dir);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(scratch, 'user-config'), XDG_STATE_HOME: join(scratch, 'user-state'),
    npm_config_cache: join(scratch, 'npm-cache'), npm_config_update_notifier: 'false',
    npm_config_audit: 'false', npm_config_fund: 'false',
  };
  const npm = (args) => run('npm', args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8_000_000 });
  await npm(['init', '-y']);
  await npm(['install', ...tarballs]);
  return {
    scratch, dir, env,
    manifest: () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    bin: (name) => join(dir, 'node_modules', '.bin', name),
    exec: (file, args, options = {}) => run(file, args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8_000_000, ...options }),
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  };
}
