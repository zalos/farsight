// A clean npm consumer for package smokes: `npm init -y` in a temporary directory, then
// `npm install <tarball>` the way a user outside this pnpm workspace would. Clean means: no
// workspace node_modules, no pnpm, and none of the caller's npm configuration. Inherited
// `npm_config_*` variables (pnpm sets many while running a script) are dropped, and npm's user
// and global config files, cache, and XDG config/state point into the scratch directory. HOME
// is left alone. Explicit FARSIGHT_NPM_REGISTRY selects a mirror/proxy. FARSIGHT_NPM_OFFLINE_CACHE selects
// an existing trusted npm cache with offline resolution and install scripts disabled. The scratch directory is removed on any failure.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The caller's environment without any npm configuration, plus the scratch-local settings. */
export function cleanNpmEnv(scratch, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^npm_/i.test(key)));
  const userconfig = join(scratch, 'npmrc'),
    globalconfig = join(scratch, 'global-npmrc');
  for (const file of [userconfig, globalconfig]) writeFileSync(file, '');
  return {
    ...env,
    XDG_CONFIG_HOME: join(scratch, 'user-config'),
    XDG_STATE_HOME: join(scratch, 'user-state'),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    // Explicit offline acceptance uses an already populated cache; npm itself still resolves installed dependencies.
    ...(base.FARSIGHT_NPM_OFFLINE_CACHE
      ? {
          npm_config_cache: base.FARSIGHT_NPM_OFFLINE_CACHE,
          npm_config_offline: 'true',
          npm_config_ignore_scripts: 'true',
        }
      : {}),
    ...(base.FARSIGHT_NPM_REGISTRY ? { npm_config_registry: base.FARSIGHT_NPM_REGISTRY } : {}),
  };
}

export async function npmConsumer(prefix, tarballs) {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const dir = join(scratch, 'consumer');
    mkdirSync(dir);
    const env = cleanNpmEnv(scratch);
    const npm = (args) =>
      run('npm', args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8_000_000 }).catch((error) => {
        throw new Error(`npm ${args[0]} failed in a clean consumer:\n${error.stderr || error.message}`);
      });
    await npm(['init', '-y']);
    await npm(['install', ...tarballs]);
    return {
      scratch,
      dir,
      env,
      cleanup,
      manifest: () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
      bin: (name) => join(dir, 'node_modules', '.bin', name),
      exec: (file, args, options = {}) =>
        run(file, args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8_000_000, ...options }),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
