// Build identity — "which Farsight am I talking to, and how old is it".
// Consumers (the HUD chrome, MCP graph_overview, `farsight --version`,
// /api/version) all print the same three facts: version, build time, commit.
// A packed CLI (scripts/pack.mjs) inlines them at pack time via esbuild
// `define`; a workspace build derives them at runtime — the version from the
// root package.json, the build time from the compiled module's mtime (the
// moment `pnpm build` last wrote it), and the git facts from the stamp the
// core build writes beside it (`dist/build-stamp.json`, scripts/stamp-build.mjs)
// — read when the code was compiled, not when a process started, because only
// the former says which code the dist holds.
// Nothing here guesses: a fact that cannot be read is simply absent.
import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

declare const __FARSIGHT_BUILD__: { version: string; built: string; commit?: string; codeCommit?: string; dirty?: boolean } | undefined;

export interface BuildInfo {
  /** semver of the farsight-cli package / workspace */
  version: string;
  /** ISO timestamp: when this build was produced (pack time, or the last `pnpm build`) */
  built: string;
  /** short git commit (HEAD) the build came from, when known — printed, so a reader can find the source */
  commit?: string;
  /**
   * The last commit on this line of history that touched the code (`BUILD_PATHS`,
   * first parent) — what `sameBuild()` compares. A docs-only commit moves `commit`
   * and leaves this where it was, so it cannot make two identical builds differ.
   */
  codeCommit?: string;
  /**
   * Whether this build may differ from its commit: true when `BUILD_PATHS` had
   * uncommitted or untracked changes when it was compiled. `false` is a claim
   * that the build is exactly `codeCommit`; absent means unknown (a build from
   * before this field, no git, or a dist compiled without its stamp), and
   * unknown is never taken for clean.
   */
  dirty?: boolean;
  /** packed = the installable farsight-cli tarball · workspace = running from the monorepo's dist/ */
  source: 'packed' | 'workspace';
}

let cached: BuildInfo | undefined;

/**
 * The compiled module's mtime **when this process loaded it** — read once, at
 * import, so the running build's `built` is the code this process holds even
 * if `buildInfo()` is first asked after a rebuild rewrote the file on disk.
 */
const LOADED_MTIME_MS: number = (() => {
  try { return statSync(fileURLToPath(import.meta.url)).mtimeMs; } catch { return 0; }
})();

/** The file the core build writes beside `dist/version.js` (scripts/stamp-build.mjs). */
export const BUILD_STAMP_FILE = 'build-stamp.json';

/** The running Farsight's identity (memoized; fail-soft — never throws). */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  if (typeof __FARSIGHT_BUILD__ !== 'undefined' && __FARSIGHT_BUILD__) {
    cached = { ...__FARSIGHT_BUILD__, source: 'packed' };
    return cached;
  }
  let version = '0.0.0', built = new Date(0).toISOString();
  let here = '', mtime = 0;
  try { here = dirname(fileURLToPath(import.meta.url)); } catch { /* not a file URL: keep the defaults */ }
  try {
    // packages/core/dist/version.js → ../../../package.json (the workspace root)
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch { /* no workspace package.json in reach */ }
  if (LOADED_MTIME_MS) { mtime = LOADED_MTIME_MS; built = new Date(mtime).toISOString(); } /* else keep the epoch: "unknown" reads honestly as 1970 */
  const git = workspaceStamp(here, mtime) ?? { commit: here ? gitIdentity(here).commit : undefined };
  cached = {
    version, built,
    ...(git.commit ? { commit: git.commit } : {}),
    ...(git.codeCommit ? { codeCommit: git.codeCommit } : {}),
    ...(git.codeCommit && typeof git.dirty === 'boolean' ? { dirty: git.dirty } : {}),
    source: 'workspace',
  };
  return cached;
}

/**
 * The git facts recorded when this dist was compiled, or null when there is no
 * stamp or it belongs to another compile — a `tsc` run by hand rewrites
 * version.js without restamping, and a stamp older than the module it describes
 * would vouch for code it never saw. Without a stamp the build still has a
 * commit (HEAD, read now) but no `codeCommit` or `dirty`, so it can only be
 * matched by its build time.
 */
function workspaceStamp(here: string, mtime: number): { commit?: string; codeCommit?: string; dirty?: boolean } | null {
  if (!here || !mtime) return null;
  try {
    const st = JSON.parse(readFileSync(join(here, BUILD_STAMP_FILE), 'utf8')) as { commit?: string; codeCommit?: string; dirty?: boolean; moduleMtimeMs?: number };
    if (typeof st.moduleMtimeMs !== 'number' || Math.abs(st.moduleMtimeMs - mtime) > 1) return null;
    return st;
  } catch { return null; }
}

/**
 * The paths whose contents make up a build, relative to the repository root:
 * the packages (sources and the viewer's public files), the scripts that pack
 * them, and the manifests that pin their dependencies. A change anywhere else —
 * docs, the e2e results, a workspace's `.farsight/settings.json` — is not a
 * change to the code, and must not make a build look dirty or new.
 */
export const BUILD_PATHS = ['packages', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];

/**
 * The git facts a build identity carries, read from `cwd` at build time: HEAD,
 * the last first-parent commit that touched `BUILD_PATHS`, and whether those
 * paths differ from it (uncommitted or untracked; gitignored output such as
 * dist/ does not count). Shared by the core build's stamp and by
 * `scripts/pack.mjs`, so a workspace build and a packed one are stamped by one
 * rule. Never throws — a fact git cannot give is absent, and an absent `dirty`
 * is never taken for clean.
 */
export function gitIdentity(cwd: string): { commit?: string; codeCommit?: string; dirty?: boolean } {
  const run = (args: string[], at = cwd) => execFileSync('git', args, { cwd: at, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  const out: { commit?: string; codeCommit?: string; dirty?: boolean } = {};
  let top = '';
  try { out.commit = run(['rev-parse', '--short', 'HEAD']) || undefined; top = run(['rev-parse', '--show-toplevel']); } catch { return out; }
  try { out.codeCommit = run(['log', '-1', '--first-parent', '--format=%h', '--', ...BUILD_PATHS], top) || undefined; } catch { /* keep the rest */ }
  try { out.dirty = run(['status', '--porcelain', '--', ...BUILD_PATHS], top).length > 0; } catch { /* unknown stays absent */ }
  return out;
}

/** One line for humans and agents: `farsight 0.1.0 · built 2026-09-06T03:10:00.000Z · commit ab12cd3 · workspace`. */
export function buildLine(): string {
  const b = buildInfo();
  return `farsight ${b.version} · built ${b.built}${b.commit ? ` · commit ${b.commit}` : ''}${b.dirty ? ' (uncommitted changes)' : ''} · ${b.source}`;
}

// ── keeping current: is a newer build installed than the one running, and does the graph match? ──

export interface InstallState {
  /** the file this process runs from: the packed bundle, or core's dist/version.js in a workspace */
  file?: string;
  /** when that file was last written */
  installedAt?: string;
  /** when this process started */
  startedAt: string;
  /**
   * The identity of the build on disk now, read the way the running one was
   * (`build-stamp.json` beside the file, plus its mtime in a workspace). Absent
   * when the file carries no readable stamp — an install from before pack.mjs
   * wrote one — and then `newerInstalled` falls back to the file's mtime.
   */
  installed?: Pick<BuildInfo, 'built'> & Partial<Pick<BuildInfo, 'version' | 'commit' | 'codeCommit' | 'dirty'>>;
  /** what `newerInstalled` was decided on: the two builds' identities (`sameBuild`), or only the file's mtime */
  basis?: 'build' | 'mtime';
  /**
   * The build on disk is not the build this process runs: restart it to run
   * what is installed. Decided by `sameBuild()` over the two identities, so a
   * rebuild of the same clean commit (`pnpm build`, a re-pack) is not a restart;
   * only without a stamp is it the mtime rule it used to be everywhere.
   */
  newerInstalled: boolean;
}

/**
 * The build identity of the file on disk, read now: for a packed bundle the
 * `build-stamp.json` pack.mjs writes beside it, for a workspace dist its mtime
 * and the stamp the core build wrote for that compile. Undefined when there is
 * nothing to read — never a guess.
 */
function installedBuild(file: string, mtimeMs: number): InstallState['installed'] | undefined {
  const dir = dirname(file);
  if (typeof __FARSIGHT_BUILD__ !== 'undefined' && __FARSIGHT_BUILD__) {
    try {
      const st = JSON.parse(readFileSync(join(dir, BUILD_STAMP_FILE), 'utf8')) as InstallState['installed'];
      return st && typeof st.built === 'string' ? st : undefined;
    } catch { return undefined; }
  }
  const st = workspaceStamp(dir, mtimeMs);
  if (!st) return undefined;
  return {
    built: new Date(mtimeMs).toISOString(),
    ...(st.commit ? { commit: st.commit } : {}),
    ...(st.codeCommit ? { codeCommit: st.codeCommit } : {}),
    ...(st.codeCommit && typeof st.dirty === 'boolean' ? { dirty: st.dirty } : {}),
  };
}

/**
 * Is the build on disk a different build from the one this process runs? Read
 * every time (not memoized) — an install can happen any moment. Never throws.
 *
 * It used to compare the file's mtime with the process start, so `pnpm build`
 * of unchanged code — or a re-pack of the same commit — lit RESTART on the HUD
 * and failed `farsight status` about a server already running that code. Now
 * the identities decide (`sameBuild`), and the mtime rule is only the fallback
 * for an install that carries no stamp.
 */
export function installState(): InstallState {
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  const out: InstallState = { startedAt: startedAt.toISOString(), basis: 'mtime', newerInstalled: false };
  try {
    const file = fileURLToPath(import.meta.url);
    const st = statSync(file);
    const m = st.mtime;
    out.file = file;
    out.installedAt = m.toISOString();
    // the float mtimeMs, exactly as buildInfo() read it: the Date rounds it, which
    // made the same file one millisecond "newer" than itself
    const installed = installedBuild(file, st.mtimeMs);
    if (installed) {
      out.installed = installed;
      out.basis = 'build';
      out.newerInstalled = !sameBuild(installed, buildInfo());
    } else {
      // a few seconds of slack: a build finishing as the process starts is not "newer"
      out.newerInstalled = m.getTime() > startedAt.getTime() + 5000;
    }
  } catch { /* not a file URL, or unreadable: nothing to compare against */ }
  return out;
}

/** What a consumer (server · MCP · CLI) knows about the builds in play, for `currencyAdvice()`. */
export interface CurrencyFacts {
  /** who is asking: the wording of the restart step differs */
  role: 'server' | 'mcp' | 'cli';
  /** the build of the process asking */
  running: BuildInfo;
  /** that process's file on disk */
  install?: InstallState;
  /** the graph in use: which build wrote it, when */
  graph?: { farsight?: Pick<BuildInfo, 'version' | 'built'> & Omit<BuildIdentity, 'built'>; generatedAt?: string; sync?: number };
  /** the CLI only: the HUD server it could reach on the workspace port */
  server?: { port: number; reachable: boolean; farsight?: BuildInfo; install?: InstallState };
}

export interface CurrencyAdvice {
  /** nothing to do */
  ok: boolean;
  /** what is out of date, one line each (empty when ok) */
  findings: string[];
  /** how to check, update, restart and re-ingest — always printed, so the recipe travels with every consumer */
  steps: string[];
}

/** The facts `sameBuild()` reads — a BuildInfo, or the stamp a graph or a server carries. */
export type BuildIdentity = { built?: string; commit?: string; codeCommit?: string; dirty?: boolean };

/**
 * Two builds are the same build when they run the same code. Two facts prove it,
 * either one enough:
 *
 * 1. **The same code commit, and both clean.** A build stamped `dirty: false` claims it
 *    is exactly its `codeCommit`, so two such builds of one commit are one program, however
 *    far apart they were compiled. This is the case `farsight status` used to cry
 *    wolf on: `pnpm build` writes the workspace dist, `node scripts/pack.mjs` stamps
 *    the tarball seconds later, and a server started from the workspace differed
 *    from the installed CLI by nothing but those seconds — exit 1, "restart the
 *    server", about a server that was already running the installed code.
 * 2. **The same build stamp.** `built` is the dist mtime in a workspace build and is
 *    inlined at pack time, so it moves if and only if the code was rebuilt. This is
 *    the only proof available for a dirty build, or one from before `dirty` existed
 *    (absent is unknown, and unknown is never clean) — there, a differing stamp is
 *    the one thing that can tell two builds apart, so it still fires.
 *
 * HEAD (`commit`) is NOT part of this comparison, and that is the fix for an earlier
 * defect: it was `git rev-parse HEAD` read at process start, so committing anything — a
 * docs file, this comment — makes a running server's commit differ from the CLI's
 * while both run byte-identical code. `farsight status` then exited 1 on both live
 * ports and told the reader to restart a server and re-ingest a graph that were
 * already current. The identity chip is the thing reviewers trusted most; a chip
 * that cries wolf teaches people to ignore it. The commit still prints, because it
 * says which source produced a build — it just cannot say whether one is stale.
 */
export function sameBuild(a?: BuildIdentity, b?: BuildIdentity): boolean {
  if (!a || !b) return false;
  if (a.codeCommit && a.codeCommit === b.codeCommit && a.dirty === false && b.dirty === false) return true;
  return !!a.built && a.built === b.built;
}

/**
 * The update recipe every consumer prints the same way: which build is
 * installed, running and wrote the graph; when they disagree, what to do.
 * Pure over the facts passed in — nothing here touches the network or disk.
 */
export function currencyAdvice(f: CurrencyFacts): CurrencyAdvice {
  const findings: string[] = [];
  const short = (b?: { version?: string } & BuildIdentity) => b ? `${b.version ?? ''} · built ${b.built ?? '?'}${b.commit ? ` · ${b.commit}` : ''}${b.dirty ? ' (uncommitted changes)' : ''}`.trim() : 'unknown';
  const me = f.role === 'server' ? 'this server' : f.role === 'mcp' ? 'this MCP process' : 'this CLI';
  if (f.install?.newerInstalled) {
    findings.push(f.install.basis === 'build' && f.install.installed
      ? `a newer build is installed (${short(f.install.installed)}) than ${me} runs (${short(f.running)}, started ${f.install.startedAt}) — restart it`
      : `a newer build is installed (${f.install.file ?? 'the install'} written ${f.install.installedAt}) than ${me} runs (started ${f.install.startedAt}) — restart it`);
  }
  if (f.server) {
    if (!f.server.reachable) findings.push(`no HUD server answered on port ${f.server.port} — start one with \`farsight serve\` in the workspace`);
    else {
      if (f.server.install?.newerInstalled) findings.push(f.server.install.basis === 'build' && f.server.install.installed
        ? `the server on port ${f.server.port} runs ${short(f.server.farsight)}, and ${short(f.server.install.installed)} is installed — restart it`
        : `the server on port ${f.server.port} runs an older build than is installed (started ${f.server.install.startedAt}, install written ${f.server.install.installedAt}) — restart it`);
      else if (f.server.farsight && !sameBuild(f.server.farsight, f.running)) findings.push(`the server on port ${f.server.port} is ${short(f.server.farsight)}; this CLI is ${short(f.running)} — restart the server`);
    }
  }
  const g = f.graph?.farsight;
  if (g && !sameBuild(g, f.running) && !(f.server?.farsight && sameBuild(g, f.server.farsight))) {
    findings.push(`the graph was written by ${short(g)}; ${me} is ${short(f.running)} — re-ingest so the graph carries what this build knows`);
  } else if (f.graph && !g) {
    findings.push('the graph carries no build stamp (written by an older Farsight) — re-ingest');
  }
  const restart = f.role === 'mcp'
    ? 'restart: reconnect this MCP server (Claude Code: /mcp → reconnect; it starts a fresh `farsight mcp` from the installed build)'
    : 'restart: stop the `farsight serve` process and run `farsight serve` again in the workspace (the running process keeps old code in memory; a reinstall only changes the files on disk)';
  const steps = [
    'check: `farsight status` (or `farsight --version` + GET /api/version on the server, or MCP graph_overview) — which build is installed, which is running, which wrote the graph',
    'update: `npm install -g <farsight-cli tarball>` (from a Farsight checkout: `node scripts/pack.mjs` builds it into build/)',
    restart,
    'reingest: MCP refresh_graph, or `curl -X POST localhost:4477/api/sync`, or `farsight ingest <dir>` — then reload the HUD page (it caches /graph from load time)',
  ];
  return { ok: findings.length === 0, findings, steps };
}
