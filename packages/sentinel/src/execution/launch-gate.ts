// The launch gate: the first code a built-in worker process runs (`node --import <this> <adapter> …`), before the
// adapter module is loaded. It reads exactly one authorization line from stdin, `sentinel-launch <token>\n` naming
// the token in its own argument list, and only then lets the adapter load. End of stdin, a wrong line or no token
// exits at once, with nothing written and the adapter never loaded.
//
// The supervisor writes that line only after the worker's identity with its process id is durable in the worker
// journal. So a process whose journal record has no pid can never be authorized: the coordinator that would have
// written the line is dead (recovery holds its store lock) and no other process ever writes it. That holds however
// late the process starts. A child that was still between fork and exec when its coordinator died, and execs
// afterwards, blocks or reads end of stream here; it never runs adapter code. This is the invariant recovery relies
// on, not any timing, and not the adapter keeping the worker protocol.
//
// Reads are blocking and exact-length (libuv hands a child its stdio in blocking mode), so the gate never consumes a
// protocol byte; the coordinator writes no frame before the adapter's hello in any case.
import { readSync } from 'node:fs';

const PREFIX = 'sentinel-launch ';
const TOKEN_ARG = /^--sentinel-token=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const REFUSED = 78;

function readExactly(length: number): Buffer | null {
  const buf = Buffer.alloc(length);
  let have = 0;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (have < length) {
    let n: number;
    try {
      n = readSync(0, buf, have, length - have, null);
    } catch (e) {
      // Liveness only: a non-blocking descriptor waits and retries; it can never authorize anything by itself.
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      return null;
    }
    if (n === 0) return null;
    have += n;
  }
  return buf;
}

const token = TOKEN_ARG.exec(process.argv.at(-1) ?? '')?.[1];
const expected = token ? Buffer.from(`${PREFIX}${token}\n`) : null;
const got = expected ? readExactly(expected.length) : null;
if (!expected || !got || !got.equals(expected)) process.exit(REFUSED);
