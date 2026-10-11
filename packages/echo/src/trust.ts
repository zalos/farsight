import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { echoConfigWord } from '@farsight/core/dist/strings-echo-config.js';
import type { EchoConfig } from './types.js';

type Kind = 'configs' | 'connections' | 'credentials';
function fail(): never { throw new Error(echoConfigWord('echo.config.trust')); }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** User-owned receipts live outside the discovered workspace configuration. */
export function trustDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state'), 'farsight-echo');
}
function privateDirectory(path: string, create: boolean): void {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) fail();
}
function receiptPath(kind: Kind, subject: string, create = false): string {
  const root = trustDirectory();
  privateDirectory(root, create);
  const directory = join(root, kind);
  privateDirectory(directory, create);
  return join(directory, `${digest(subject)}.json`);
}
function readReceipt(kind: Kind, subject: string): { version: number; subject: string; value: string } | undefined {
  let fd: number | undefined;
  try {
    const path = receiptPath(kind, subject);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) fail();
    const receipt = JSON.parse(readFileSync(fd, 'utf8'));
    if (receipt.version !== 1 || receipt.subject !== subject || typeof receipt.value !== 'string' || Object.keys(receipt).length !== 3) fail();
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail();
  } finally { if (fd !== undefined) closeSync(fd); }
}
function writeReceipt(kind: Kind, subject: string, value: string): void {
  const path = receiptPath(kind, subject, true);
  // Validate an existing receipt before replacing it; never adopt a symlink.
  readReceipt(kind, subject);
  const temporary = join(dirname(path), `.trust-${randomUUID()}`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, subject, value })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch {} }
}
function subjectPath(path: string): string { return realpathSync(resolve(path)); }

export function recordFileTrust(kind: 'configs' | 'connections', path: string, contents: string): void {
  writeReceipt(kind, subjectPath(path), digest(contents));
}
export function requireFileTrust(kind: 'configs' | 'connections', path: string, contents: string): void {
  if (readReceipt(kind, subjectPath(path))?.value !== digest(contents)) fail();
}
export function forgetFileTrust(kind: 'configs' | 'connections', path: string): void {
  const subject = subjectPath(path);
  if (readReceipt(kind, subject)) unlinkSync(receiptPath(kind, subject));
}

/** A credential reference is permanently tied to one exact origin in user state. */
export function pinCredentialOrigin(ref: string, origin: string): void {
  const value = new URL(origin).origin;
  const existing = readReceipt('credentials', ref);
  if (existing) {
    if (existing.value !== value) throw new Error(echoConfigWord('echo.secret.origin'));
    return;
  }
  const path = receiptPath('credentials', ref, true);
  try { writeFileSync(path, `${JSON.stringify({ version: 1, subject: ref, value })}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readReceipt('credentials', ref)?.value !== value) throw new Error(echoConfigWord('echo.secret.origin'));
  }
}
export function requireCredentialOrigin(ref: string, origin?: string): void {
  if (!origin || readReceipt('credentials', ref)?.value !== new URL(origin).origin) throw new Error(echoConfigWord('echo.secret.origin'));
}
export function pinConfigCredentials(config: EchoConfig): void {
  for (const profile of Object.values(config.profiles)) {
    if (profile.model.secretRef) pinCredentialOrigin(profile.model.secretRef, profile.model.baseUrl);
    if (profile.backend.secretRef) pinCredentialOrigin(profile.backend.secretRef, profile.backend.url);
  }
}
