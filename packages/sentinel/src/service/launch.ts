// Starting the owner's background service: the one process the command line starts itself, outside execution's
// bounded runner (execution/processes.ts), because it must outlive the command. It is this same executable with the
// fixed `serve` arguments: an absolute program, an argument list and never a shell, an explicit environment (only
// the names the service reads to find the owner's state, runtime folder and executables), stdio closed, detached.
import { spawn } from 'node:child_process';

/** The only environment names the service is started with. Nothing else is inherited (no SENTINEL_*, no tokens). */
export const SERVICE_ENV = ['PATH', 'HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

export function launchService(program: string, workspace: string, idleMs: number, env: NodeJS.ProcessEnv = process.env): void {
  const given: Record<string, string> = {};
  for (const name of SERVICE_ENV) if (typeof env[name] === 'string') given[name] = env[name]!;
  const child = spawn(process.execPath, [program, 'serve', '--workspace', workspace, '--idle-ms', String(idleMs)], {
    detached: true, stdio: 'ignore', env: given, cwd: workspace, shell: false,
  });
  child.on('error', () => { /* the caller sees no service answer and reports it */ });
  child.unref();
}
