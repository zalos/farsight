import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import type { EchoContext } from './types.js';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stable(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

/** One immutable binding per host session, shared by every profile in the same configuration directory. */
export async function bindSession(ctx: EchoContext, host: 'claude' | 'codex', sessionId: string): Promise<void> {
  if (!['claude', 'codex'].includes(host) || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024 || /[\x00-\x1f\x7f]/.test(sessionId)) throw new Error(echoConfigWord('echo.session.invalid'));
  const fingerprint = hash(stable({
    configPath: ctx.configPath, profileId: ctx.profileId, dataDirectory: ctx.dataDirectory,
    identity: ctx.profile.identity, backend: ctx.profile.backend, model: ctx.profile.model,
  }));
  const directory = join(ctx.directory, 'sessions');
  const destination = join(directory, `${hash(`${host}:${sessionId}`)}.json`);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
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
