// `farsight-sentinel init`: create the workspace's private settings file from scrubbed defaults, once. It never
// overwrites a file that exists (a second run leaves its bytes untouched and says so), stores no credential value
// (settings hold keychain references only, and the defaults hold none), downloads nothing, starts no scan, and
// trusts nothing: the file only grants once its owner adopts these exact bytes (PR 06's adoption flow).
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The settings file's place in a workspace (PR 06 names it; its example ships beside it). */
export const SETTINGS_PATH = ['.farsight', 'sentinel', 'settings.json'] as const;

/**
 * The scrubbed defaults: no grants, no providers, agents wait for a person, findings from medium up fail and
 * required coverage must complete. Mirrors PR 06's `DEFAULT_SETTINGS` (policy/settings.ts on its branch) until it is
 * merged; then this is that constant.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  schema: 'sentinel-settings/draft-1',
  mandatoryRules: [] as string[],
  thresholds: Object.freeze({ failOnSeverity: 'medium', requireCompleteCoverage: true, requiredCapabilities: [] as string[] }),
  grants: [] as unknown[],
  agentActions: 'confirm',
  providers: [] as unknown[],
});

/** The one scan profile this build can describe; scanner coverage arrives with later packages. */
export const PROFILES = ['static'] as const;

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
  const profile = options.profile ?? 'static';
  if (!(PROFILES as readonly string[]).includes(profile)) throw new InitError('sentinel.init.profileUnknown', profile);
  if (!isAbsolute(options.workspace)) throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace path must be absolute');
  let workspace: string;
  try { workspace = realpathSync.native(options.workspace); } catch { throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace does not exist'); }
  if (!lstatSync(workspace).isDirectory()) throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace is not a folder');
  const farsightDir = join(workspace, SETTINGS_PATH[0]);
  const sentinelDir = join(farsightDir, SETTINGS_PATH[1]);
  // `.farsight` may already be Farsight's own folder; it is used as found. Sentinel's folder is private.
  try { mkdirSync(farsightDir, { mode: 0o755 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new InitError('sentinel.init.workspaceUnsafe', 'cannot create .farsight');
  }
  const fst = lstatSync(farsightDir);
  if (fst.isSymbolicLink() || !fst.isDirectory()) throw new InitError('sentinel.init.workspaceUnsafe', '.farsight is not a real folder');
  ensurePrivateDir(sentinelDir);
  const path = join(sentinelDir, SETTINGS_PATH[2]);

  const kept = (): InitResult => {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new InitError('sentinel.init.settingsUnsafe', 'the settings path is not a regular file');
    const bytes = readFileSync(path);
    let recognised = false;
    try { recognised = (JSON.parse(bytes.toString('utf8')) as { schema?: unknown })?.schema === DEFAULT_SETTINGS.schema; } catch { recognised = false; }
    return Object.freeze({ outcome: 'kept', path, digest: sha(bytes), profile, recognised });
  };
  try { lstatSync(path); return kept(); } catch (e) {
    if (e instanceof InitError) throw e;
  }
  const bytes = Buffer.from(`${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
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
