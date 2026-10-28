import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { EchoContext } from './types.js';

const run = promisify(execFile);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export interface MemoryOrigin {
  workspace: string;
  commit: string | null;
}
export interface MemoryProvenance extends MemoryOrigin {
  savedAt: string;
}

export function validOrigin(value: unknown): value is MemoryOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every((key) => key === 'workspace' || key === 'commit') &&
    typeof row.workspace === 'string' &&
    row.workspace.length <= 4096 &&
    isAbsolute(row.workspace) &&
    !/[\0\r\n]/.test(row.workspace) &&
    (row.commit === null || revision(row.commit))
  );
}

export function validProvenance(value: unknown): value is MemoryProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { savedAt, ...origin } = value as Record<string, unknown>;
  return (
    validOrigin(origin) &&
    typeof savedAt === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(savedAt) &&
    Number.isFinite(Date.parse(savedAt))
  );
}

/** Derive historical attribution; never accept a caller's claimed commit or date. */
export async function captureMemoryOrigin(cwd = process.cwd()): Promise<MemoryOrigin> {
  const directory = await realpath(cwd);
  if (!(await lstat(directory)).isDirectory()) throw new Error('origin');
  // Ambient Git overrides must not attribute this directory to a different repo.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (path: string, ...flags: string[]): Promise<string> =>
    (await run('git', ['-C', path, 'rev-parse', ...flags], { env, timeout: 1000, maxBuffer: 8192 })).stdout.trim();
  let workspace = directory;
  let commit: string | null = null;
  try {
    workspace = await realpath(await git(directory, '--show-toplevel'));
  } catch {}
  try {
    const head = await git(workspace, '--verify', 'HEAD');
    if (revision(head)) commit = head;
  } catch {}
  return { workspace, commit };
}

export async function verifyMemoryOrigin(value: unknown): Promise<MemoryOrigin | undefined> {
  if (!validOrigin(value)) return undefined;
  try {
    const actual = await captureMemoryOrigin(value.workspace);
    return actual.workspace === value.workspace && actual.commit === value.commit ? actual : undefined;
  } catch {
    return undefined;
  }
}

async function directory(ctx: EchoContext, create: boolean): Promise<string> {
  const path = join(ctx.dataDirectory, 'provenance');
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error('provenance');
  return path;
}

/** Upstream has no custom origin field. A private record binds attribution to its exact saved content. */
export async function saveMemoryProvenance(
  ctx: EchoContext,
  id: string,
  content: string,
  origin: MemoryOrigin,
): Promise<void> {
  const path = join(await directory(ctx, true), `${digest(id)}.json`);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(
      JSON.stringify({ version: 1, id, contentHash: digest(content), ...origin, savedAt: new Date().toISOString() }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Legacy records and replaced/modified upstream rows have unknown provenance. */
export async function readMemoryProvenance(
  ctx: EchoContext,
  id: string,
  content: string,
): Promise<MemoryProvenance | undefined> {
  try {
    const file = await open(
      join(await directory(ctx, false), `${digest(id)}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192)
        return undefined;
      const row = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
      const { version, id: savedId, contentHash, ...provenance } = row;
      if (version !== 1 || savedId !== id || contentHash !== digest(content) || !validProvenance(provenance))
        return undefined;
      return provenance;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
