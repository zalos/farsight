// `farsight-sentinel init`: create the workspace's private settings file and its declared pipeline from a profile,
// once each. It never overwrites a file that exists (a second run leaves its bytes untouched and says which profile
// they hold), stores no credential value (settings hold keychain references only, and the defaults hold none),
// downloads nothing, starts no scan, and trusts nothing: the files grant only once their owner adopts these exact
// bytes (`settings adopt --confirm` adopts both).
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as FS,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_SETTINGS, MAX_SETTINGS_BYTES, parseSettings, SETTINGS_PATH } from '../policy/index.js';
import {
  PATTERN_SUPPORTED_RULES,
  OSV_SUPPORTED_RULES,
  TRIVY_SUPPORTED_RULES,
  ZIZMOR_SUPPORTED_RULES,
  GITLEAKS_SUPPORTED_RULES,
} from '../adapters/drivers/index.js';
import { PREVIEW_RULE } from '../adapters/preview-detector.js';
import { PIPELINE_PATH, parsePipeline } from '../app/pipeline.js';
import { profilePipeline } from '../app/pipeline-profiles.js';

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
  return {
    ...DEFAULT_SETTINGS,
    mandatoryRules:
      profile === 'scanners'
        ? [
            ...PATTERN_SUPPORTED_RULES,
            ...OSV_SUPPORTED_RULES,
            ...TRIVY_SUPPORTED_RULES,
            ...ZIZMOR_SUPPORTED_RULES,
            ...GITLEAKS_SUPPORTED_RULES,
          ].map((r) => r.familyId)
        : profile === 'secrets'
          ? GITLEAKS_SUPPORTED_RULES.map((r) => r.familyId)
          : profile === 'agentic'
            ? [...GITLEAKS_SUPPORTED_RULES, ...PATTERN_SUPPORTED_RULES].map((r) => r.familyId)
            : [PREVIEW_RULE],
    grants: [
      {
        actions: ['capture.source', 'run.start', 'run.pause', 'run.cancel'],
        principals: ['human'],
        scope: { profiles: ['static'] },
      },
      { actions: ['rule.promote', 'tool.acquire', 'context.pin'], principals: ['human'] },
    ],
  };
}

/**
 * The scan profiles init describes: the foundation preview, the five pinned scanners, the secret scan alone, and the
 * plan's agentic example (the secret and pattern scanners, the walkthrough, a brokered Copilot review and a native
 * Claude triage).
 */
export const PROFILES = ['static', 'scanners', 'secrets', 'agentic'] as const;

/** The rule packs a profile's owner promotes before planning: the packs this package ships, by name. */
export const PROFILE_PACKS: Readonly<Record<(typeof PROFILES)[number], readonly string[]>> = Object.freeze({
  static: ['foundation-preview'],
  scanners: ['pattern', 'advisories', 'infrastructure', 'ci', 'secrets'],
  secrets: ['secrets'],
  agentic: ['secrets', 'pattern'],
});

export type InitErrorCode =
  | 'sentinel.init.workspaceUnsafe'
  | 'sentinel.init.settingsUnsafe'
  | 'sentinel.init.pipelineUnsafe'
  | 'sentinel.init.profileUnknown';

export class InitError extends Error {
  constructor(
    readonly code: InitErrorCode,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'InitError';
  }
}

/** One file init writes once: what it did and what the file is now. */
export interface InitFile {
  /** `prepared`: the file was written now; `kept`: it already existed and was not touched. */
  readonly outcome: 'prepared' | 'kept';
  readonly path: string;
  /** SHA-256 of the file's bytes as they are now. */
  readonly digest: string;
  /** Whether the file parses as what it should be (settings, a pipeline); it is reported, never repaired. */
  readonly recognised: boolean;
  /** The profile whose defaults these exact bytes are; null for a file that was edited or came from elsewhere. */
  readonly holds: string | null;
}

export interface InitResult {
  /** `prepared` when either file was written now; `kept` when both were already there. */
  readonly outcome: 'prepared' | 'kept';
  /** The settings file (kept at the top level, as before the pipeline existed). */
  readonly path: string;
  readonly digest: string;
  /** The profile asked for. */
  readonly profile: string;
  readonly recognised: boolean;
  readonly settings: InitFile;
  readonly pipeline: InitFile;
}

const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const settingsBytes = (profile: string) =>
  Buffer.from(`${JSON.stringify(initialSettings(profile), null, 2)}\n`, 'utf8');
const pipelineBytes = (profile: string) =>
  Buffer.from(`${JSON.stringify(profilePipeline(profile), null, 2)}\n`, 'utf8');
/** The profile whose bytes these are exactly, or null. */
const holds = (bytes: Buffer, of: (profile: string) => Buffer) => PROFILES.find((p) => of(p).equals(bytes)) ?? null;

function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new InitError('sentinel.init.workspaceUnsafe', `cannot create ${path}`);
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new InitError('sentinel.init.workspaceUnsafe', `${path} is not a real folder`);
  if (UID !== undefined && st.uid !== UID)
    throw new InitError('sentinel.init.workspaceUnsafe', `${path} belongs to another user`);
}

/** Creates the settings and pipeline files that do not exist; reports the others unchanged. Never writes over a file. */
export function initWorkspace(options: { workspace: string; profile?: string }): InitResult {
  try {
    return initOnce(options);
  } catch (e) {
    if (e instanceof InitError) throw e;
    // Any other operating-system refusal is a typed one too; nothing has been written over.
    throw new InitError('sentinel.init.workspaceUnsafe', `${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

/**
 * Writes `bytes` to `path` unless a file is there. An existing file is read through one descriptor, opened without
 * following a link: what is checked is what is read. Unreadable, oversized or not a regular file: refused with a
 * reason, and never written over.
 */
function writeOnce(
  path: string,
  bytes: Buffer,
  options: {
    code: 'sentinel.init.settingsUnsafe' | 'sentinel.init.pipelineUnsafe';
    noun: string;
    maxBytes: number;
    recognise: (bytes: Buffer) => boolean;
    holds: (bytes: Buffer) => string | null;
  },
): InitFile {
  const { code, noun } = options;
  const kept = (): InitFile => {
    let fd: number;
    try {
      fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      throw new InitError(
        code,
        errno === 'ELOOP' ? `the ${noun} path is a link` : `the ${noun} file cannot be read (${errno ?? 'error'})`,
      );
    }
    let found: Buffer;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new InitError(code, `the ${noun} path is not a regular file`);
      if (st.size > options.maxBytes) throw new InitError(code, `the ${noun} file is larger than it may be`);
      found = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, found, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      found = found.subarray(0, off);
    } catch (e) {
      if (e instanceof InitError) throw e;
      throw new InitError(code, `the ${noun} file cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    } finally {
      closeSync(fd);
    }
    return Object.freeze({
      outcome: 'kept' as const,
      path,
      digest: sha(found),
      recognised: options.recognise(found),
      holds: options.holds(found),
    });
  };
  try {
    lstatSync(path);
    return kept();
  } catch (e) {
    if (e instanceof InitError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new InitError(
        code,
        `the ${noun} path cannot be inspected (${(e as NodeJS.ErrnoException).code ?? 'error'})`,
      );
  }
  if (!options.recognise(bytes)) throw new InitError(code, `the ${noun} defaults do not validate`);
  let fd: number;
  try {
    // O_EXCL: if another init created the file meanwhile, it is kept, not replaced.
    fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return kept();
    throw new InitError(code, `cannot create the ${noun} file`);
  }
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return Object.freeze({
    outcome: 'prepared' as const,
    path,
    digest: sha(bytes),
    recognised: true,
    holds: options.holds(bytes),
  });
}

const parses = (parse: (bytes: Buffer) => unknown) => (bytes: Buffer) => {
  try {
    parse(bytes);
    return true;
  } catch {
    return false;
  }
};

function initOnce(options: { workspace: string; profile?: string }): InitResult {
  const profile = options.profile ?? 'static';
  if (!(PROFILES as readonly string[]).includes(profile)) throw new InitError('sentinel.init.profileUnknown', profile);
  if (!isAbsolute(options.workspace))
    throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace path must be absolute');
  let workspace: string;
  try {
    workspace = realpathSync.native(options.workspace);
  } catch {
    throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace does not exist');
  }
  if (!lstatSync(workspace).isDirectory())
    throw new InitError('sentinel.init.workspaceUnsafe', 'the workspace is not a folder');
  const [farsightName, sentinelName, fileName] = SETTINGS_PATH.split('/') as [string, string, string];
  const farsightDir = join(workspace, farsightName);
  const sentinelDir = join(farsightDir, sentinelName);
  // `.farsight` may already be Farsight's own folder; it is used as found. Sentinel's folder is private.
  try {
    mkdirSync(farsightDir, { mode: 0o755 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new InitError('sentinel.init.workspaceUnsafe', 'cannot create .farsight');
  }
  const fst = lstatSync(farsightDir);
  if (fst.isSymbolicLink() || !fst.isDirectory())
    throw new InitError('sentinel.init.workspaceUnsafe', '.farsight is not a real folder');
  ensurePrivateDir(sentinelDir);
  // Recognised when what reads it would read it: the policy's settings parser, the pipeline parser.
  const settings = writeOnce(join(sentinelDir, fileName), settingsBytes(profile), {
    code: 'sentinel.init.settingsUnsafe',
    noun: 'settings',
    maxBytes: MAX_SETTINGS_BYTES,
    recognise: parses(parseSettings),
    holds: (b) => holds(b, settingsBytes),
  });
  // A foreign settings file is reported before anything else is written beside it.
  const pipeline = settings.recognised
    ? writeOnce(join(workspace, PIPELINE_PATH), pipelineBytes(profile), {
        code: 'sentinel.init.pipelineUnsafe',
        noun: 'pipeline',
        maxBytes: MAX_SETTINGS_BYTES,
        recognise: parses(parsePipeline),
        holds: (b) => holds(b, pipelineBytes),
      })
    : Object.freeze({
        outcome: 'kept' as const,
        path: join(workspace, PIPELINE_PATH),
        digest: '',
        recognised: false,
        holds: null,
      });
  return Object.freeze({
    outcome: settings.outcome === 'prepared' || pipeline.outcome === 'prepared' ? 'prepared' : 'kept',
    path: settings.path,
    digest: settings.digest,
    profile,
    recognised: settings.recognised,
    settings,
    pipeline,
  });
}
