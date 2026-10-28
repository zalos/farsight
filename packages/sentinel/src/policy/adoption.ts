// Owner adoption of `.farsight/sentinel/settings.json`. The file sits in a checkout, so its place there proves
// nothing: an adoption record in the owner's user state (outside every checkout) names the exact settings digest
// and the canonical workspace identity it was adopted for. A changed byte, a clone at another path, or the same path
// re-created as a new folder has no adoption, and the built-in defaults apply until the owner adopts again.
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type {
  ActionIntent,
  AdoptionEnvelope,
  RepoConfigEnvelope,
  SettingsEnvelope,
  SettingsTrust,
} from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { canonicalDigest, sha256Digest } from './digest.js';
import { PolicyError, policyFail } from './errors.js';
import { intentDigest, receiptAuthority, type ConsumedReceipt } from './receipts.js';
import { MAX_SETTINGS_BYTES, parseRepoConfig, parseSettings, type PolicyInputs } from './settings.js';
import {
  assertPrivateDir,
  ensurePrivateDir,
  overlaps,
  prospectiveCanonical,
  readCheckoutFile,
  readPrivateFile,
  writePrivateFileAtomic,
} from './user-state.js';

/** Where the settings file lives in a workspace. */
export const SETTINGS_PATH = '.farsight/sentinel/settings.json';
/** Where the repository's version-controlled scan intent lives. */
export const REPO_CONFIG_PATH = 'sentinel.config.json';

/**
 * The owner's trust folder: `$XDG_STATE_HOME/farsight/sentinel/trust` when that is set and absolute, else the
 * platform's user-state folder (`~/Library/Application Support/...` on macOS, `~/.local/state/...` elsewhere).
 */
export function trustDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return join(normalize(xdg), 'farsight', 'sentinel', 'trust');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'farsight', 'sentinel', 'trust');
  return join(home, '.local', 'state', 'farsight', 'sentinel', 'trust');
}

/** A workspace as Sentinel identifies it: its canonical path and a digest that also covers the folder's identity. */
export interface WorkspaceIdentity {
  /** The canonical path, as given (it must already be canonical). */
  readonly path: string;
  /** Digest over the path and the folder's device and inode: a re-created or moved folder is another workspace. */
  readonly digest: string;
}

/**
 * The identity of a workspace folder. Refuses, with a PolicyError `workspaceNotCanonical`, a path that is not
 * absolute and normalised, cannot be resolved, passes through a link or is not a folder.
 */
export function workspaceIdentity(workspace: string): WorkspaceIdentity {
  if (!isAbsolute(workspace) || normalize(workspace) !== workspace)
    policyFail('sentinel.policy.workspaceNotCanonical', 'the workspace path is absolute and normalised');
  let real: string;
  try {
    real = realpathSync.native(workspace);
  } catch (e) {
    return policyFail('sentinel.policy.workspaceNotCanonical', 'the workspace cannot be resolved', e);
  }
  if (real !== workspace)
    policyFail(
      'sentinel.policy.workspaceNotCanonical',
      'the workspace path passes through a link or is not its canonical spelling',
    );
  const st = lstatSync(workspace, { bigint: true });
  if (!st.isDirectory()) policyFail('sentinel.policy.workspaceNotCanonical', 'the workspace is not a folder');
  return Object.freeze({
    path: workspace,
    digest: canonicalDigest({
      kind: 'sentinel-workspace/1',
      path: workspace,
      dev: String(st.dev),
      ino: String(st.ino),
    }),
  });
}

function checkedTrustDir(trustDir: string, workspace: WorkspaceIdentity, readOnly = false): string {
  // Before anything is created: a trust folder that is, contains or lies inside the checkout is refused with the
  // checkout untouched.
  assertTrustOutside(trustDir, workspace.path);
  if (readOnly) assertPrivateDir(trustDir, 'sentinel.policy.trustDirUnsafe');
  else ensurePrivateDir(trustDir, 'sentinel.policy.trustDirUnsafe');
  const real = realpathSync.native(trustDir);
  if (real !== trustDir)
    policyFail(
      'sentinel.policy.trustDirUnsafe',
      'the trust folder passes through a link or is not its canonical spelling',
    );
  if (overlaps(real, workspace.path))
    policyFail('sentinel.policy.trustDirInsideWorkspace', 'the trust folder must be outside the checkout');
  return real;
}

/**
 * Refuses, creating nothing, a trust folder that would be, contain or lie inside a captured source. `sources` are
 * the canonical roots a caller actually captures; only a caller that knows both may decide this.
 */
export function assertTrustOutside(trustDir: string, ...sources: readonly string[]): void {
  const prospective = prospectiveCanonical(trustDir, 'sentinel.policy.trustDirUnsafe');
  if (sources.some((s) => overlaps(prospective, s)))
    policyFail('sentinel.policy.trustDirInsideWorkspace', 'the trust folder must be outside every captured source');
}

const adoptionFile = (workspace: WorkspaceIdentity) => `adoption-${workspace.digest.slice('sha256:'.length)}.json`;
const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');

function adoptable(ws: WorkspaceIdentity): { settingsDigest: string; intent: ActionIntent } {
  const bytes = readCheckoutFile(
    join(ws.path, SETTINGS_PATH),
    MAX_SETTINGS_BYTES,
    'sentinel.policy.settingsUnreadable',
  );
  if (!bytes) return policyFail('sentinel.policy.settingsUnreadable', `${SETTINGS_PATH} does not exist`);
  parseSettings(bytes);
  const settingsDigest = sha256Digest(bytes);
  return {
    settingsDigest,
    intent: {
      action: 'settings.adopt',
      input: settingsDigest,
      effects: [],
      budget: { maxTokens: null, maxCost: null, currency: null },
      scope: { profile: null, provider: null, targets: [ws.digest] },
    },
  };
}

/** The exact intent an adoption receipt confirms: these settings bytes, for this workspace. */
export function adoptionIntent(workspace: string): { intent: ActionIntent; settingsDigest: string } {
  return adoptable(workspaceIdentity(workspace));
}

/**
 * Records the owner's adoption of the workspace's current settings bytes. The receipt must have been spent for
 * exactly `adoptionIntent(workspace)`: settings.adopt, these settings bytes, this workspace identity.
 */
export function adoptSettings(options: {
  workspace: string;
  trustDir: string;
  receipt: ConsumedReceipt;
  now: Date;
}): AdoptionEnvelope {
  const ws = workspaceIdentity(options.workspace);
  const dir = checkedTrustDir(options.trustDir, ws);
  const { settingsDigest, intent } = adoptable(ws);
  const authority = receiptAuthority(options.receipt);
  if (!authority || authority.action !== 'settings.adopt' || authority.intentDigest !== intentDigest(intent)) {
    return policyFail(
      'sentinel.policy.adoptionUnauthorized',
      'adoption needs the owner’s spent receipt for these settings in this workspace',
    );
  }
  const record: AdoptionEnvelope = {
    schema: 'sentinel-adoption/draft-1',
    workspaceIdentity: ws.digest,
    workspacePath: ws.path,
    settingsDigest,
    receipt: authority.digest,
    adoptedAt: stamp(options.now),
  };
  const checked = validateEnvelope('adoption', record);
  if (!checked.ok)
    policyFail(
      'sentinel.policy.adoptionUnauthorized',
      `the adoption record does not validate: ${checked.errors[0]?.message ?? 'invalid'}`,
    );
  writePrivateFileAtomic(dir, adoptionFile(ws), Buffer.from(JSON.stringify(record)), 'sentinel.policy.trustDirUnsafe');
  return Object.freeze(record);
}

/**
 * Reads the workspace's settings and repository intent and decides how far the settings are trusted. Only
 * `adopted` settings are returned; every other state yields `settings: null`, so the defaults apply.
 */
export function loadPolicyInputs(options: { workspace: string; trustDir: string }): PolicyInputs {
  return readPolicyInputs(options, false);
}

/** Internal preparation preflight, not the policy facade: existing adopted bytes only, no mkdir or alias repair. */
export function loadPolicyInputsReadOnly(options: { workspace: string; trustDir: string }): PolicyInputs {
  return readPolicyInputs(options, true);
}

function readPolicyInputs(options: { workspace: string; trustDir: string }, readOnly: boolean): PolicyInputs {
  const ws = workspaceIdentity(options.workspace);
  const dir = checkedTrustDir(options.trustDir, ws, readOnly);
  const repoBytes = readCheckoutFile(
    join(ws.path, REPO_CONFIG_PATH),
    MAX_SETTINGS_BYTES,
    'sentinel.policy.settingsUnreadable',
    { nonblocking: readOnly },
  );
  const repoConfig: RepoConfigEnvelope | null = repoBytes ? parseRepoConfig(repoBytes) : null;
  const repoConfigDigest = repoBytes ? sha256Digest(repoBytes) : null;
  const base = { repoConfig, repoConfigDigest };

  const bytes = readCheckoutFile(
    join(ws.path, SETTINGS_PATH),
    MAX_SETTINGS_BYTES,
    'sentinel.policy.settingsUnreadable',
    { nonblocking: readOnly },
  );
  if (!bytes) return { trust: 'missing', settings: null, settingsDigest: null, ...base };
  const digest = sha256Digest(bytes);
  const recordBytes = readPrivateFile(join(dir, adoptionFile(ws)), 64 * 1024, 'sentinel.policy.trustDirUnsafe', {
    repairTemporaryAliases: !readOnly,
  });
  let trust: SettingsTrust = 'not-adopted';
  if (recordBytes) {
    let record: unknown;
    try {
      record = JSON.parse(recordBytes.toString('utf8'));
    } catch {
      record = undefined;
    }
    const checked = validateEnvelope('adoption', record);
    if (checked.ok && checked.value.workspaceIdentity === ws.digest && checked.value.workspacePath === ws.path) {
      trust = checked.value.settingsDigest === digest ? 'adopted' : 'changed';
    }
  }
  if (trust !== 'adopted') return { trust, settings: null, settingsDigest: null, ...base };
  let settings: SettingsEnvelope;
  try {
    settings = parseSettings(bytes);
  } catch (e) {
    if (e instanceof PolicyError) return { trust: 'invalid', settings: null, settingsDigest: null, ...base };
    throw e;
  }
  return { trust, settings, settingsDigest: digest, ...base };
}
