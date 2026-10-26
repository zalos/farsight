import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';

/** Serialize settings edits from independent workspace clients and the web view. */
export async function withSettingsLock<T>(configPath: string, action: () => Promise<T>): Promise<T> {
  const folder = dirname(resolve(configPath));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const path = join(await realpath(folder), '.echo-settings.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const file = await open(path, 'wx', 0o600);
      const owned = await file.stat();
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
        await file.close();
        return await action();
      } finally {
        await file.close().catch(() => {});
        const current = await lstat(path).catch(() => undefined);
        if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(path).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Recover only a well-formed lock whose owner is demonstrably gone. A
      // malformed or foreign file is never deleted as an assumed stale lock.
      try {
        const before = await lstat(path);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.size > 256 ||
          (process.getuid && before.uid !== process.getuid())
        )
          throw new Error();
        const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; nonce?: unknown };
        if (
          !Number.isSafeInteger(owner.pid) ||
          Number(owner.pid) <= 0 ||
          typeof owner.nonce !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(owner.nonce)
        ) {
          // Another writer may still be filling its newly created lock.
          if (Date.now() - before.mtimeMs > 5000) throw new Error();
        } else {
          let stopped = false;
          try {
            process.kill(Number(owner.pid), 0);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === 'ESRCH') stopped = true;
          }
          if (stopped) {
            const current = await lstat(path);
            if (current.ino === before.ino && current.dev === before.dev) await unlink(path);
            continue;
          }
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // An empty lock is possible between exclusive creation and its first
        // write. Retry within the same bounded interval without adopting it.
      }
      if (Date.now() >= deadline) throw new Error(echoConfigWord('echo.config.write'));
      await delay(15);
    }
  }
}
