// `farsight-sentinel init`: create the workspace's private settings file from scrubbed defaults, once. It never
// overwrites a file that exists (a second run leaves its bytes untouched and says so), stores no credential value
// (settings hold keychain references only, and the defaults hold none), downloads nothing, starts no scan, and
// trusts nothing: the file only grants once its owner adopts these exact bytes (PR 06's adoption flow).
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_SETTINGS, MAX_SETTINGS_BYTES, parseSettings, SETTINGS_PATH } from '../policy/index.js';
import { PATTERN_SUPPORTED_RULES, OSV_SUPPORTED_RULES, TRIVY_SUPPORTED_RULES, ZIZMOR_SUPPORTED_RULES } from '../adapters/drivers/index.js';
import { PREVIEW_RULE } from '../adapters/preview-detector.js';

/** The settings file's place in a workspace, and its scrubbed defaults: PR 06's own, so init writes what policy reads. */
export { SETTINGS_PATH, DEFAULT_SETTINGS };

/**
 * What init writes for a profile: PR 06's defaults plus two grants for the owner (a human, never an agent): capture,
 * run, pause and cancel that profile, and promote rule packs (an owner action, which still needs the owner's own
 * confirmation every time). No provider, no budget, no agent action; the file grants nothing until it is adopted.
 */
export function initialSettings(profile: string) {
  // The one rule this build can check, the foundation-preview rule, is what the owner's settings ask for; it is
  // planned only once the owner promotes its pack, and a run resting on it is never required coverage met.
  return { ...DEFAULT_SETTINGS, mandatoryRules: profile === 'scanners' ? [...PATTERN_SUPPORTED_RULES, ...OSV_SUPPORTED_RULES, ...TRIVY_SUPPORTED_RULES, ...ZIZMOR_SUPPORTED_RULES].map(r => r.familyId) : [PREVIEW_RULE], grants: [
    { actions: ['capture.source', 'run.start', 'run.pause', 'run.cancel'], principals: ['human'], scope: { profiles: ['static'] } },
    { actions: ['rule.promote', 'tool.acquire', 'context.pin'], principals: ['human'] },
  ] };
}

/** The one scan profile this build can describe; scanner coverage arrives with later packages. */
export const PROFILES = ['static', 'scanners'] as const;

export type InitErrorCode = 'sentinel.init.workspaceUnsafe' | 'sentinel.init.settingsUnsafe' | 'sentinel.init.profileUnknown';

export class InitError extends Error {
  constructor(readonly code: InitErrorCode, readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'InitError';
  }
}

export interface InitResult {
  /** `prepared`: the file was written now; `kept`: it already existed and was not touched. */
  readonly outcome: 'prepared' | 'kept';
  readonly path: string;
  /** SHA-256 of the file's bytes as they are now: what an owner adopts. */
  readonly digest: string;
  readonly profile: string;
  /** Whether the kept file parses as JSON with the settings schema; it is reported, never repaired. */
  readonly recognised: boolean;
}

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function ensurePrivateDir(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new InitError('sentinel.init.workspaceUnsafe', `cannot create ${path}`);
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new InitError('sentinel.init.workspaceUnsafe', `${path} is not a real folder`);
  if (UID !== undefined && st.uid !== UID) throw new InitError('sentinel.init.workspaceUnsafe', `${path} belongs to another user`);
}

/** Creates the settings file if it does not exist; otherwise reports it unchanged. Never writes over a file. */
export function initWorkspace(options: { workspace: string; profile?: string }): InitResult {
  try { return initOnce(options); } catch (e) {
    if (e instanceof InitError) throw e;
    // Any other operating-system refusal is a typed one too; nothing has been written over.
    throw new InitError('sentinel.init.workspaceUnsafe', `${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

function initOnce(options: { workspace: string; profile?: string }): InitResult {
  const profile = options.profile ?? 'static';
  if (!(PROFILES as readonly string[]).includes(profile)) throw new InitError('sentinel.init.profileUnknown', profile);
  if (!isAbsolute(options.workspace)) throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace path must be absolute');
  let workspace: string;
  try { workspace = realpathSync.native(options.workspace); } catch { throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace does not exist'); }
  if (!lstatSync(workspace).isDirectory()) throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace is not a folder');
  const [farsightName, sentinelName, fileName] = SETTINGS_PATH.split('/') as [string, string, string];
  const farsightDir = join(workspace, farsightName);
  const sentinelDir = join(farsightDir, sentinelName);
  // `.farsight` may already be Farsight's own folder; it is used as found. Sentinel's folder is private.
  try { mkdirSync(farsightDir, { mode: 0o755 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new InitError('sentinel.init.workspaceUnsafe', 'cannot create .farsight');
  }
  const fst = lstatSync(farsightDir);
  if (fst.isSymbolicLink() || !fst.isDirectory()) throw new InitError('sentinel.init.workspaceUnsafe', '.farsight is not a real folder');
  ensurePrivateDir(sentinelDir);
  const path = join(sentinelDir, fileName);

  // An existing file is read through one descriptor, opened without following a link: what is checked is what is
  // read. Unreadable, oversized or not a regular file: refused with a reason, and never written over.
  const kept = (): InitResult => {
    let fd: number;
    try { fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0)); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new InitError('sentinel.init.settingsUnsafe', code === 'ELOOP' ? 'the settings path is a link' : `the settings file cannot be read (${code ?? 'error'})`);
    }
    let bytes: Buffer;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new InitError('sentinel.init.settingsUnsafe', 'the settings path is not a regular file');
      if (st.size > MAX_SETTINGS_BYTES) throw new InitError('sentinel.init.settingsUnsafe', 'the settings file is larger than settings may be');
      bytes = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) { const n = readSync(fd, bytes, off, st.size - off, off); if (n === 0) break; off += n; }
      bytes = bytes.subarray(0, off);
    } catch (e) {
      if (e instanceof InitError) throw e;
      throw new InitError('sentinel.init.settingsUnsafe', `the settings file cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    } finally { closeSync(fd); }
    // Recognised when policy itself would read it: PR 06's parser (schema, bounds, no credential values).
    let recognised = false;
    try { parseSettings(bytes); recognised = true; } catch { recognised = false; }
    return Object.freeze({ outcome: 'kept', path, digest: sha(bytes), profile, recognised });
  };
  try { lstatSync(path); return kept(); } catch (e) {
    if (e instanceof InitError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new InitError('sentinel.init.settingsUnsafe', `the settings path cannot be inspected (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const bytes = Buffer.from(`${JSON.stringify(initialSettings(profile), null, 2)}\n`, 'utf8');
  parseSettings(bytes); // what init writes is what policy reads
  let fd: number;
  try {
    // O_EXCL: if another init created the file meanwhile, it is kept, not replaced.
    fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return kept();
    throw new InitError('sentinel.init.settingsUnsafe', 'cannot create the settings file');
  }
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return Object.freeze({ outcome: 'prepared', path, digest: sha(bytes), profile, recognised: true });
}
