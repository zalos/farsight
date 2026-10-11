import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ECHO_HOOK_STRINGS } from '@farsight/core/dist/strings-echo-hooks.js';
import type { EchoContext } from './types.js';

export type HookHost = 'claude' | 'codex' | 'vscode';

/** Events shared by the verified command-hook formats of both hosts. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop'] as const;

function words(key: string, values: Record<string, string> = {}): string {
  return ECHO_HOOK_STRINGS[key]!.professional.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function save(path: string, value: string | object, executable = false): Promise<void> {
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: executable ? 0o700 : 0o600 });
  await chmod(path, executable ? 0o700 : 0o600);
}

/**
 * Prepare local reviewable files only. The caller owns the explicit opt-in;
 * this helper never edits host settings or invokes host installation commands.
 */
export async function prepareHooks(ctx: EchoContext, host: HookHost, executable: string): Promise<{ directory: string; instructions: string }> {
  if (!['claude', 'codex', 'vscode'].includes(host)) throw new Error(words('echo.hooks.invalidHost'));
  if (process.platform === 'win32') throw new Error(words('echo.hooks.platform'));
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ctx.profileId)) throw new Error(words('echo.hooks.invalidProfile'));
  if (![ctx.configPath, ctx.directory, executable].every(isAbsolute)) throw new Error(words('echo.hooks.absolutePaths'));
  if (!(await stat(executable).catch(() => undefined))?.isFile()) throw new Error(words('echo.hooks.missingExecutable'));

  const directory = join(ctx.directory, 'plugins', ctx.profileId, host);
  if (host === 'vscode') {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const command = [process.execPath, executable, 'hook', '--config', ctx.configPath, '--profile', ctx.profileId, '--host', host].map(shellQuote).join(' ');
    await save(join(directory, 'echo.json'), { hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ type: 'command', command, timeout: 5 }]])) });
    const instructions = [words('echo.hooks.prepared'), words('echo.hooks.vscode'), words('echo.hooks.behavior'), words('echo.hooks.singleProfile'), words('echo.hooks.keepPaths')].join('\n\n');
    await save(join(directory, 'README.txt'), `${instructions}\n`);
    return { directory, instructions };
  }
  const manifestDirectory = join(directory, host === 'claude' ? '.claude-plugin' : '.codex-plugin');
  for (const folder of [manifestDirectory, join(directory, 'hooks'), join(directory, 'scripts')]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  }

  // Read the documented root variable inside Node rather than interpolating a
  // user-controlled path into shell syntax. This also survives host cache copies.
  const rootVariable = host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT';
  const launcher = `const root=process.env.${rootVariable};if(!root)process.exit(1);import(require('node:url').pathToFileURL(require('node:path').join(root,'scripts','echo-hook.mjs')).href).catch(()=>process.exit(1));`;
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(launcher)}`;
  const hooks = Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]]));
  const name = `echo-${ctx.profileId.toLowerCase().replaceAll('_', '-')}-${createHash('sha256').update(ctx.profileId).digest('hex').slice(0, 8)}`;
  await save(join(manifestDirectory, 'plugin.json'), {
    name, version: '0.0.1', description: words('echo.hooks.description'), author: { name: 'Farsight' },
    // Claude adds explicit hook files to default discovery. Omitting this field
    // avoids registering hooks/hooks.json twice. Codex replaces the default.
    ...(host === 'codex' ? { hooks: './hooks/hooks.json' } : {}),
  });
  await save(join(directory, 'hooks', 'hooks.json'), { hooks });
  const args = [executable, 'hook', '--config', ctx.configPath, '--profile', ctx.profileId, '--host', host];
  await save(join(directory, 'scripts', 'echo-hook.mjs'), `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst result = spawnSync(process.execPath, ${JSON.stringify(args)}, { stdio: 'inherit', timeout: 4000, windowsHide: true });\nprocess.exit(result.status ?? 1);\n`, true);

  if (host === 'codex') {
    const catalogDirectory = join(directory, '.agents', 'plugins');
    await mkdir(catalogDirectory, { recursive: true, mode: 0o700 });
    await save(join(catalogDirectory, 'marketplace.json'), {
      name: `${name}-local`, plugins: [{
        name, source: { source: 'local', path: './' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      }],
    });
  }

  const loadCommand = host === 'claude'
    ? `claude --plugin-dir ${shellQuote(directory)}`
    : `codex plugin marketplace add ${shellQuote(directory)}`;
  const instructions = [
    words('echo.hooks.prepared'), words(`echo.hooks.${host}`, { command: loadCommand }),
    words('echo.hooks.behavior'), words('echo.hooks.singleProfile'), words('echo.hooks.keepPaths'),
  ].join('\n\n');
  await save(join(directory, 'README.txt'), `${instructions}\n`);
  return { directory, instructions };
}
