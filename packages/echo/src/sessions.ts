import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import { submindSettings, validateModelSettings } from './config.js';
import type { EchoContext } from './types.js';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stable(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

/** Identity of the immutable store/model selection shared by sessions and local memory access. */
export function contextFingerprint(ctx: EchoContext): string {
  return hash(stable({
    configPath: ctx.configPath, profileId: ctx.profileId, dataDirectory: ctx.dataDirectory,
    identity: ctx.profile.identity, backend: ctx.profile.backend,
    model: { ...validateModelSettings(ctx.profile.model), allowInsecureHttp: ctx.profile.model.allowInsecureHttp ?? false },
    budget: ctx.profile.budget, submind: submindSettings(ctx.profile),
  }));
}

/** One immutable binding per host session, shared by every profile in the same configuration directory. */
export async function bindSession(ctx: EchoContext, host: 'claude' | 'codex' | 'vscode', sessionId: string, options: { workspace?: string } = {}): Promise<void> {
  if (!['claude', 'codex', 'vscode'].includes(host) || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024 || /[\x00-\x1f\x7f]/.test(sessionId)) throw new Error(echoConfigWord('echo.session.invalid'));
  // The workspace registry survives switching between separate configuration
  // directories, so reconnecting cannot change memory/model scope mid-session.
  if (options.workspace !== undefined) {
    try {
      if (!isAbsolute(options.workspace)) throw new Error();
      const workspace = await realpath(options.workspace);
      if (!(await lstat(workspace)).isDirectory()) throw new Error();
      const local = join(workspace, '.echo');
      const info = await lstat(local).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error();
      await mkdir(local, { recursive: true, mode: 0o700 });
      if (resolve(local) !== resolve(ctx.directory)) await bindAt(ctx, host, sessionId, join(local, 'sessions'));
    } catch (error) {
      if (error instanceof Error && error.message === echoConfigWord('echo.session.conflict')) throw error;
      throw new Error(echoConfigWord('echo.session.store'));
    }
  }
  await bindAt(ctx, host, sessionId, join(ctx.directory, 'sessions'));
}

async function bindAt(ctx: EchoContext, host: 'claude' | 'codex' | 'vscode', sessionId: string, directory: string): Promise<void> {
  const fingerprint = contextFingerprint(ctx);
  const destination = join(directory, `${hash(`${host}:${sessionId}`)}.json`);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ version: 1, fingerprint, host, profileId: ctx.profileId, createdAt: new Date().toISOString() })}\n`);
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error();
      const existing = JSON.parse(await readFile(destination, 'utf8')) as Record<string, unknown>;
      if (existing.version !== 1 || typeof existing.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(existing.fingerprint)) throw new Error();
      if (existing.fingerprint !== fingerprint) throw new SessionConflict();
    }
  } catch (error) {
    if (error instanceof SessionConflict) throw new Error(echoConfigWord('echo.session.conflict'));
    throw new Error(echoConfigWord('echo.session.store'));
  } finally { await unlink(temporary).catch(() => {}); }
}

class SessionConflict extends Error {}
