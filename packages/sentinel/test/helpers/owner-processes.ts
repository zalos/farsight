// Spawns and drives real owner processes (owner-child.mjs) with bounded waits and owned cleanup only:
// every child is tracked and killed by its own handle, never by a command pattern.
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./owner-child.mjs', import.meta.url));
const probePath = fileURLToPath(new URL('./owner-probe.mjs', import.meta.url));
const execArgv = ['--disable-warning=ExperimentalWarning'];

export interface OwnerChild {
  child: ChildProcess;
  next(timeoutMs?: number): Promise<any>;
  send(message: object): void;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class OwnerProcesses {
  #children: OwnerChild[] = [];

  async spawn(storePath: string, waitMs = 250): Promise<OwnerChild> {
    const child = fork(childPath, [storePath, String(waitMs)], {
      execArgv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const inbox: any[] = [];
    const waiters: ((m: any) => void)[] = [];
    child.on('message', (m) => {
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const handle: OwnerChild = {
      child,
      exit,
      send: (m) => child.send(m),
      next: (timeoutMs = 10_000) =>
        inbox.length
          ? Promise.resolve(inbox.shift())
          : new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('owner child message deadline')), timeoutMs);
              const waiter = (m: any) => {
                clearTimeout(timer);
                resolve(m);
              };
              waiters.push(waiter);
              exit.then(() => {
                const i = waiters.indexOf(waiter);
                if (i >= 0) {
                  waiters.splice(i, 1);
                  clearTimeout(timer);
                  reject(new Error('owner child exited'));
                }
              });
            }),
    };
    this.#children.push(handle);
    const ready = await handle.next();
    if (ready.type !== 'ready') throw new Error(`owner child not ready: ${JSON.stringify(ready)}`);
    return handle;
  }

  async kill(handle: OwnerChild, signal: NodeJS.Signals = 'SIGKILL') {
    handle.child.kill(signal);
    return handle.exit;
  }

  async cleanup() {
    await Promise.all(
      this.#children.map((h) => {
        if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGKILL');
        return h.exit;
      }),
    );
    this.#children = [];
  }
}

/** Synchronously ask a fresh process whether it can acquire the store right now (waitMs 0). */
export function probeOwnership(storePath: string): { outcome: 'acquired' | 'refused'; code?: string; epoch?: number } {
  const out = spawnSync(process.execPath, [...execArgv, probePath, storePath], { encoding: 'utf8', timeout: 20_000 });
  if (out.status !== 0) throw new Error(`probe failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}
