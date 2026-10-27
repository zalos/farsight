// Starting the owner's background service: the one process the command line starts itself, outside execution's
// bounded runner (execution/processes.ts), because it must outlive the command. The invocation is captured here, not
// taken from the caller: this Node executable, this package's own executable and the fixed `serve` arguments for one
// canonical workspace, an argument list and never a shell, an explicit environment (only the names the service reads
// to find the owner's state, runtime folder and executables), stdio closed, detached. The caller gets back a handle
// to exactly that process, so a service that never answers is stopped by its own handle, never by a search.
import { spawn, type ChildProcess } from 'node:child_process';
import { ownExecutable } from './package-paths.js';

/** The only environment names the service is started with. Nothing else is inherited (no SENTINEL_*, no tokens). */
export const SERVICE_ENV = ['PATH', 'HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

export interface LaunchedService {
  readonly pid: number | undefined;
  /** Stops exactly the process this launch started, if it is still running. Never signals any other process. */
  stop(): void;
}

export function launchService(
  workspace: string,
  idleMs: number,
  env: NodeJS.ProcessEnv = process.env,
): LaunchedService {
  const given: Record<string, string> = {};
  for (const name of SERVICE_ENV) if (typeof env[name] === 'string') given[name] = env[name]!;
  const child: ChildProcess = spawn(
    process.execPath,
    [ownExecutable(), 'serve', '--workspace', workspace, '--idle-ms', String(idleMs)],
    {
      detached: true,
      stdio: 'ignore',
      env: given,
      cwd: workspace,
      shell: false,
    },
  );
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true; /* the caller sees no service answer and reports it */
  });
  child.unref();
  return Object.freeze({
    pid: child.pid,
    stop: () => {
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  });
}
