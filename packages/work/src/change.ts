// What a change is, read once for every consumer (round 2026-10-10, proposal 6): a commit range read with
// git in the source's checkout, or a pull request read from the code host — its commits, its files with the
// new-side line ranges that changed (paths made relative to the source root), and the head's history for
// *commits since the last run*. `farsight affected` and MCP `affected` both call this, so a terminal and an
// agent cannot read the same pull request two ways.
import { execFileSync } from 'node:child_process';
import { codeHostPolicy, openGitHub, type CodeHostSource, type PullRequest, type GitHubHost } from './code-host.js';
import type { Verdict } from './contract.js';

export interface ChangeFile { path: string; status?: string; ranges: [number, number][]; repo?: string }
export interface ChangeCommit { sha: string; subject: string; at: string; author?: string }
export type ChangeRange =
  | { kind: 'commits'; from: string; to: string }
  | { kind: 'pr'; number: number; title?: string; url?: string; base?: string; head?: string; host?: string };

export interface ReadChange {
  range: ChangeRange;
  commits: ChangeCommit[];
  files: ChangeFile[];
  history?: { sha: string; at: string }[];
  pr?: PullRequest;
  /** the host, opened, when a pull request was read (posting reuses it) */
  opened?: { host: GitHubHost; credential: Verdict };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `owner/name` from a git remote URL (https or ssh). */
export function hostRepoOf(url: string): string | undefined {
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** The GitHub repository a checkout pushes to (`origin`), when it is on GitHub. */
export function originRepo(root: string): string | undefined {
  try { return hostRepoOf(git(root, ['remote', 'get-url', 'origin'])); } catch { return undefined; }
}

/** `@@` headers of a unified diff → changed new-side ranges per file (the same rule as core hunksOfPatch). */
function hunks(patch: string): ChangeFile[] {
  const out: ChangeFile[] = [];
  let cur: ChangeFile | undefined;
  for (const line of patch.split('\n')) {
    const f = /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
    if (f) { cur = f[1] === '/dev/null' ? undefined : { path: f[1]!.replace(/\t.*$/, ''), ranges: [] }; if (cur) out.push(cur); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) { const from = Number(h[1]); const len = h[2] == null ? 1 : Number(h[2]); cur.ranges.push(len === 0 ? [Math.max(1, from), Math.max(1, from)] : [from, from + len - 1]); }
  }
  return out;
}

const logRows = (out: string) => out.trim().split('\n').filter(Boolean).map((l) => { const [sha, at] = l.split('\t'); return { sha: sha!, at: at! }; });

/**
 * Read a change. Throws an Error with a sentence when git or the host cannot answer, or the policy of the
 * code-host source does not let `who` read.
 */
export async function readChange(o: {
  root: string;
  ask: { pr: number } | { from: string; to: string };
  host?: CodeHostSource;
  hostRepo?: string;
  viaGh?: boolean;
  who?: 'human' | 'agent';
  /**
   * The graph sources nested under the checkout's source (`rel` = their folder relative to it, '' for the
   * source itself). A changed file belongs to the deepest one whose folder holds it, its path made relative
   * to that folder; a file under none is left out.
   */
  sources?: { name: string; rel: string }[];
}): Promise<ReadChange> {
  const prefix = (() => { try { return git(o.root, ['rev-parse', '--show-prefix']).trim(); } catch { return ''; } })();
  const homes = (o.sources?.length ? o.sources : [{ name: '', rel: '' }])
    .map((x) => ({ name: x.name, at: prefix + (x.rel ? x.rel.replace(/\/+$/, '') + '/' : '') }))
    .sort((a, b) => b.at.length - a.at.length);
  const homeOf = (p: string) => homes.find((h) => !h.at || p.startsWith(h.at));
  const place = <F extends { path: string }>(f: F): (F & { repo?: string }) | null => {
    const h = homeOf(f.path);
    if (!h) return null;
    return { ...f, path: f.path.slice(h.at.length), ...(h.name ? { repo: h.name } : {}) };
  };
  if ('pr' in o.ask) {
    const n = o.ask.pr;
    const repo = o.hostRepo ?? o.host?.repo ?? originRepo(o.root);
    if (!repo) throw new Error('no host repository: add a code-host source to .farsight/settings.json, pass the owner/name, or run inside a checkout whose origin is on GitHub');
    if (o.host && o.host.host !== 'github') throw new Error(`reading pull requests from ${o.host.host} is not built yet (GitHub only)`);
    if (o.host || o.who === 'agent') {
      const d = codeHostPolicy(o.host, 'read', o.who ?? 'human');
      if (!d.verdict.allowed) throw new Error(`reading is not allowed: ${d.verdict.reason}`);
    }
    const opened = await openGitHub(o.host, repo, { viaGh: !!o.viaGh });
    let pr: PullRequest, commits: ChangeCommit[], files: ChangeFile[];
    try {
      pr = await opened.host.pr(n);
      commits = await opened.host.commits(n);
      files = (await opened.host.files(n)).map(place).filter((f) => f !== null) as ChangeFile[];
    } catch (err) {
      throw new Error(`could not read pull request #${n} of ${repo}: ${(err as Error).message}${o.viaGh ? '' : ' (a private repository needs a credential: auth.secret on the code-host source, or --via gh)'}`);
    }
    let history: { sha: string; at: string }[];
    try { history = logRows(git(o.root, ['log', '-n', '500', '--format=%H%x09%cI', pr.headSha])); } catch { history = commits.map((c) => ({ sha: c.sha, at: c.at })).reverse(); }
    return { range: { kind: 'pr', number: n, title: pr.title, url: pr.url, base: pr.base, head: pr.head, host: 'github' }, commits, files, history, pr, opened };
  }
  const { from, to } = o.ask;
  try {
    const commits = git(o.root, ['log', '--reverse', '--format=%H%x09%cI%x09%an%x09%s', `${from}..${to}`]).trim().split('\n').filter(Boolean)
      .map((l) => { const [sha, at, author, ...s] = l.split('\t'); return { sha: sha!, at: at!, author: author!, subject: s.join('\t') }; });
    const status = new Map(git(o.root, ['diff', '--name-status', '-M', from, to]).trim().split('\n').filter(Boolean)
      .map((l) => { const p = l.split('\t'); return [p[p.length - 1]!, p[0]!.charAt(0)] as const; }));
    const hs = hunks(git(o.root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', from, to]));
    const seen = new Set(hs.map((h) => h.path));
    for (const p of status.keys()) if (!seen.has(p)) hs.push({ path: p, ranges: [] });
    const files = hs.map((h) => place({ path: h.path, ranges: h.ranges, ...(status.get(h.path) ? { status: status.get(h.path)! } : {}) })).filter((f): f is ChangeFile => !!f);
    const history = logRows(git(o.root, ['log', '-n', '500', '--format=%H%x09%cI', to]));
    return { range: { kind: 'commits', from, to }, commits, files, history };
  } catch (err) {
    throw new Error(`git could not read ${from}..${to} in ${o.root}: ${String((err as Error).message).split('\n')[0]}`);
  }
}
