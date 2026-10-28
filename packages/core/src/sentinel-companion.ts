// Fixed read-only discovery shared by Farsight and its separately installed Sentinel companion.
// A descriptor is private process lookup data, never a browser capability or confirmation.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute, normalize, dirname } from 'node:path';
import { constants as FS, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
export interface SentinelCompanionDescriptor {
  readonly schema: 'farsight-sentinel-companion/1';
  readonly ownerOrigin: string;
  readonly farsightOrigin: string;
  readonly workspaceDigest: string;
  readonly processNonce: string;
  readonly hostInstance: string;
  readonly expiresAt: string;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function companionOrigin(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) ||
    !u.port ||
    u.origin !== value ||
    u.username ||
    u.password
  )
    throw Error('sentinel.ownerUi.invalid');
  return u.origin;
}
export function companionWorkspaceDigest(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync.native(path) !== path)
    throw Error('sentinel.ownerUi.invalid');
  const st = lstatSync(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('sentinel.ownerUi.invalid');
  return (
    'sha256:' + hash(JSON.stringify({ dev: String(st.dev), ino: String(st.ino), kind: 'sentinel-workspace/1', path }))
  );
}
export function companionDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const base =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? normalize(env.XDG_STATE_HOME)
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : join(home, '.local', 'state');
  return join(base, 'farsight', 'companions');
}
export function companionFilename(workspaceDigest: string, farsightOrigin: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(workspaceDigest)) throw Error('sentinel.ownerUi.invalid');
  companionOrigin(farsightOrigin);
  return hash(JSON.stringify({ farsightOrigin, workspaceDigest })) + '.json';
}
/** Shape/pair identity only, used by the explicit owner publisher to replace an expired descriptor safely. */
export function companionRecord(
  value: unknown,
  expected: { workspaceDigest: string; farsightOrigin: string },
): SentinelCompanionDescriptor {
  const v = value as SentinelCompanionDescriptor;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !==
      'expiresAt,farsightOrigin,hostInstance,ownerOrigin,processNonce,schema,workspaceDigest' ||
    ['schema', 'ownerOrigin', 'farsightOrigin', 'workspaceDigest', 'processNonce', 'hostInstance', 'expiresAt'].some(
      (k) => typeof (v as unknown as Record<string, unknown>)[k] !== 'string',
    ) ||
    v.schema !== 'farsight-sentinel-companion/1' ||
    v.workspaceDigest !== expected.workspaceDigest ||
    v.farsightOrigin !== expected.farsightOrigin ||
    !/^host-[a-f0-9]{32}$/.test(v.hostInstance) ||
    !/^sha256:[a-f0-9]{64}$/.test(v.workspaceDigest) ||
    !/^([a-f0-9]{64})$/.test(v.processNonce)
  )
    throw Error('sentinel.ownerUi.invalid');
  const end = Date.parse(v.expiresAt);
  if (
    !Number.isSafeInteger(end) ||
    new Date(end).toISOString() !== v.expiresAt ||
    companionOrigin(v.ownerOrigin) === companionOrigin(v.farsightOrigin)
  )
    throw Error('sentinel.ownerUi.invalid');
  return Object.freeze({ ...v });
}
export function checkedCompanion(
  value: unknown,
  expected: { workspaceDigest: string; farsightOrigin: string; hostInstance: string },
  now = Date.now(),
): SentinelCompanionDescriptor {
  const v = companionRecord(value, expected),
    end = Date.parse(v.expiresAt);
  if (v.hostInstance !== expected.hostInstance || end <= now || end > now + 3600000)
    throw Error('sentinel.ownerUi.invalid');
  return v;
}
/** No creation/repair; one nonblocking descriptor, checked before allocation and after the exact read. */
export function readCompanion(
  directory: string,
  expected: { workspaceDigest: string; farsightOrigin: string; hostInstance: string },
  now = Date.now(),
): SentinelCompanionDescriptor | null {
  try {
    if (realpathSync.native(directory) !== directory) return null;
    const dir = lstatSync(directory, { bigint: true });
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      Number(dir.mode) & 0o077 ||
      (process.getuid && Number(dir.uid) !== process.getuid())
    )
      return null;
    const path = join(directory, companionFilename(expected.workspaceDigest, expected.farsightOrigin));
    if (dirname(path) !== directory) return null;
    const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd, { bigint: true });
      if (
        !st.isFile() ||
        st.nlink !== 1n ||
        Number(st.mode) & 0o077 ||
        (process.getuid && Number(st.uid) !== process.getuid()) ||
        st.size < 1n ||
        st.size > 1024n
      )
        return null;
      const bytes = Buffer.alloc(Number(st.size));
      let n = 0;
      while (n < bytes.length) {
        const count = readSync(fd, bytes, n, bytes.length - n, n);
        if (!count) return null;
        n += count;
      }
      const after = fstatSync(fd, { bigint: true }),
        named = lstatSync(path, { bigint: true }),
        currentDir = lstatSync(directory, { bigint: true });
      if (
        currentDir.dev !== dir.dev ||
        currentDir.ino !== dir.ino ||
        currentDir.isSymbolicLink() ||
        readSync(fd, Buffer.alloc(1), 0, 1, n) ||
        after.size !== st.size ||
        after.nlink !== 1n ||
        named.nlink !== 1n ||
        after.mode !== st.mode ||
        after.uid !== st.uid ||
        after.ctimeNs !== st.ctimeNs ||
        after.mtimeNs !== st.mtimeNs ||
        named.dev !== st.dev ||
        named.ino !== st.ino ||
        named.isSymbolicLink()
      )
        return null;
      return checkedCompanion(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), expected, now);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
