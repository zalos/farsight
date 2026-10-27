// Shared synthetic fixtures for the capture suites: real Git repositories built in temporary folders, and a real
// store (the PR 03 facade) with one running attempt per capture stage. No network, scanner or model is involved;
// the git CLI is used only by the tests to build fixtures, never by capture itself.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY, type SentinelStore } from '../dist/store/index.js';

const HOST = `${process.platform}-${process.arch}`;
const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, HOST, process.versions.sqlite ?? '') !== undefined;
/** Store-backed tests need a qualified host; on CI nothing skips (an unqualified CI host fails loudly). */
export const needsStore =
  QUALIFIED || process.env.CI
    ? {}
    : { skip: `${HOST} with SQLite ${process.versions.sqlite ?? 'none'} is not a qualified store host` };

/** A canonical private scratch folder, removed (permissions restored first) after the test. */
export function scratch(t: { after(fn: () => void): void }, prefix = 'sentinel-snap-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Restores owner permissions on a tree (restored snapshots are read-only; fixtures chmod 000 on purpose). */
export function unlock(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) unlock(p);
    else if (st.isFile()) chmodSync(p, 0o600);
  }
}

/** A hermetic git for building fixtures: no user or system config, no hooks, fixed identity and dates. */
export function git(cwd: string, args: string[], input?: string | Buffer): string {
  return gitBytes(cwd, args, input).toString('utf8');
}

/** The same, returning git's output bytes unchanged. */
export function gitBytes(cwd: string, args: string[], input?: string | Buffer): Buffer {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: cwd,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** A repository at `root` with `files` committed; returns the commit id. */
export function commitRepo(
  root: string,
  files: Record<string, string | Buffer>,
  options: { objectFormat?: 'sha256' } = {},
): string {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : [])]);
  writeTree(root, files);
  git(root, ['add', '--all', '--force']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

export interface CaptureFixture {
  readonly store: SentinelStore;
  readonly storePath: string;
}

/** Opens a real store at `<dir>/store` (or `storePath`); closed after the test. */
export async function openCaptureStore(
  t: { after(fn: () => void): void },
  dir: string,
  storePath = join(dir, 'store'),
): Promise<CaptureFixture> {
  const store = await openStore(storePath);
  t.after(() => store.close());
  return { store, storePath };
}

/** An independent walk: every non-folder path under `root`, and every folder that cannot be listed. */
export function observe(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      out.push(rel);
      return;
    }
    for (const name of names) {
      const path = rel === '' ? name : `${rel}/${name}`;
      if (skip(path)) continue;
      const st = lstatSync(join(abs, name));
      if (st.isDirectory()) walk(join(abs, name), path);
      else out.push(path);
    }
  };
  walk(root, '');
  return out.sort();
}
