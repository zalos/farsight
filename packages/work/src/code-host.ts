// Code hosts as a source (round 2026-10-10, proposal 6): a pull request's commits and diff are read from the
// host, and `farsight affected --post` writes ONE comment (updated in place, found by a marker line) and ONE
// check (a commit status) on it — through the same three verdicts a tracker write passes (gate.ts):
//   1. policy   — the `code-host` source in .farsight/settings.json grants the action (`allow.people` /
//                 `allow.agents`), default deny, and only an `edit` source writes (decideGrants, shared);
//   2. tracker  — the host answers: the pull request exists and is open, and the repository lets this
//                 credential write (the host's own permission flag);
//   3. credential — the token behind `auth.secret` (`keychain:farsight/github-<org>`), read in this process by
//                 secrets.ts and never printed; or, only when the person passes `--via gh`, the GitHub CLI's
//                 own login.
// GitHub is built. Azure DevOps has the same shape in settings and is refused with words (not built yet).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict, Verdicts } from './contract.js';
import { decideGrants, type GrantDecision } from './gate.js';
import { resolveSecret, SecretUnavailable } from './secrets.js';

export const CODE_HOST_ACTIONS = ['read', 'comment', 'check'] as const;
export type CodeHostAction = typeof CODE_HOST_ACTIONS[number];
export const CODE_HOSTS = ['github', 'azure-devops'] as const;

/** One `sources[]` entry of `.farsight/settings.json` with `type: 'code-host'`. */
export interface CodeHostSource {
  id: string;
  type: 'code-host';
  host: typeof CODE_HOSTS[number];
  /** `owner/name` on GitHub */
  repo: string;
  /** the graph source this repository is (default: the repo's name after the slash) */
  source?: string;
  /** API base, default https://api.github.com */
  api?: string;
  auth?: { secret?: string };
  /** default read-only: nothing is posted */
  mode?: 'read-only' | 'edit';
  /** what people and agents may do; nothing listed = nothing allowed */
  allow?: { people?: CodeHostAction[]; agents?: CodeHostAction[] };
  /** a person must confirm: 'always' (the default for posts), 'agent', 'never' */
  confirm?: 'always' | 'agent' | 'never';
  enabled?: boolean;
}

/** Every enabled code-host source the workspace declares. */
export function loadCodeHostSources(workspace: string): CodeHostSource[] {
  const file = join(workspace, '.farsight', 'settings.json');
  if (!existsSync(file)) return [];
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as { sources?: Record<string, unknown>[] };
    return (s.sources ?? []).filter((x) => x.type === 'code-host' && x.enabled !== false) as unknown as CodeHostSource[];
  } catch {
    return [];
  }
}

/** Verdict 1 for a code host: the source's `allow` lists as grants, decided by the shared gate. */
export function codeHostPolicy(src: CodeHostSource | undefined, action: CodeHostAction, who: 'human' | 'agent'): GrantDecision<unknown> {
  if (!src) return { verdict: { allowed: false, reason: 'no code-host source in .farsight/settings.json names this repository' }, requiresConfirmation: false };
  if (action !== 'read' && (src.mode ?? 'read-only') !== 'edit') {
    return { verdict: { allowed: false, reason: 'this code-host source is read-only' }, requiresConfirmation: false };
  }
  const confirm = src.confirm ?? (action === 'read' ? 'never' : 'always');
  const grants = [
    ...(src.allow?.people?.length ? [{ actions: [...src.allow.people], principals: ['human' as const], confirm }] : []),
    ...(src.allow?.agents?.length ? [{ actions: [...src.allow.agents], principals: ['agent' as const], confirm }] : []),
  ];
  return decideGrants(grants, action, who, { agentWrites: action === 'read' ? 'allow' : 'confirm' });
}

/** Whether any code-host source lets an agent read — MCP registers `affected` only then. */
export function agentsMayRead(sources: CodeHostSource[]): boolean {
  return sources.some((s) => codeHostPolicy(s, 'read', 'agent').verdict.allowed);
}

// ── the host ───────────────────────────────────────────────────────────────

export interface PullRequest {
  number: number; title: string; url: string; state: string; draft: boolean;
  base: string; head: string; headSha: string; baseSha: string;
}
export interface PullCommit { sha: string; subject: string; at: string; author?: string }
export interface PullFile { path: string; status: string; ranges: [number, number][] }

/** How the host is called: with a token (the keychain), the GitHub CLI (`--via gh`), or with nothing (public reads). */
export type HostVia = 'token' | 'gh' | 'none';

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

function ghCall(): Call {
  return (method, path, body) => new Promise((resolve, reject) => {
    const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path.replace(/^\//, ''), ...(body ? ['--input', '-'] : [])];
    const child = execFile('gh', args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        const code = (err as NodeJS.ErrnoException).code;
        reject(new Error(code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : `gh api ${method} ${path} failed`));
        return;
      }
      let json: unknown = null;
      try { json = stdout ? JSON.parse(String(stdout)) : null; } catch { /* not JSON */ }
      resolve({ status: err ? 400 : 200, json });
    });
    if (body) { child.stdin?.write(JSON.stringify(body)); child.stdin?.end(); }
  });
}

function fetchCall(api: string, token: string | undefined): Call {
  return async (method, path, body) => {
    const r = await fetch(api.replace(/\/$/, '') + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'farsight', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, json };
  };
}

/** `@@ -a,b +c,d @@` lines of one file's patch → new-side changed ranges. */
export function rangesOfFilePatch(patch: string | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (const line of String(patch ?? '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!h) continue;
    const from = Number(h[1]);
    const len = h[2] == null ? 1 : Number(h[2]);
    out.push(len === 0 ? [Math.max(1, from), Math.max(1, from)] : [from, from + len - 1]);
  }
  return out;
}

const STATUS_LETTER: Record<string, string> = { added: 'A', modified: 'M', removed: 'D', renamed: 'R', copied: 'C', changed: 'M' };

export interface GitHubHost {
  via: HostVia;
  /** the login the credential acts as, once asked */
  who(): Promise<string | null>;
  pr(n: number): Promise<PullRequest>;
  commits(n: number): Promise<PullCommit[]>;
  files(n: number): Promise<PullFile[]>;
  /** the repository lets this credential write (push), as the host says */
  canWrite(): Promise<Verdict>;
  /** one comment carrying `marker`, created or edited in place → its url */
  upsertComment(n: number, marker: string, body: string): Promise<{ url: string; updated: boolean }>;
  /** a commit status on the head (the check) */
  status(sha: string, state: 'success' | 'failure' | 'pending' | 'error', description: string, context: string, url?: string): Promise<void>;
}

/** A GitHub host for `owner/name`. The token is only ever passed in from secrets.ts. */
export function githubHost(repo: string, opts: { via: HostVia; token?: string; api?: string }): GitHubHost {
  const call = opts.via === 'gh' ? ghCall() : fetchCall(opts.api ?? 'https://api.github.com', opts.via === 'token' ? opts.token : undefined);
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} answered ${r.status}${(r.json as { message?: string })?.message ? `: ${(r.json as { message: string }).message}` : ''}`);
    return r.json as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const paged = async (path: string) => {
    const out: unknown[] = [];
    for (let page = 1; page <= 30; page++) {
      const rows = await ok('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`) as unknown[];
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return {
    via: opts.via,
    async who() {
      if (opts.via === 'none') return null;
      try { return String((await ok('GET', '/user')).login ?? '') || null; } catch { return null; }
    },
    async pr(n) {
      const p = await ok('GET', `/repos/${repo}/pulls/${n}`);
      return {
        number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state, draft: !!p.draft,
        base: p.base?.ref, head: p.head?.ref, headSha: p.head?.sha, baseSha: p.base?.sha,
      };
    },
    async commits(n) {
      return (await paged(`/repos/${repo}/pulls/${n}/commits`)).map((c) => ({
        sha: c.sha, subject: String(c.commit?.message ?? '').split('\n')[0]!, at: c.commit?.committer?.date ?? c.commit?.author?.date ?? '',
        ...(c.author?.login ? { author: c.author.login } : c.commit?.author?.name ? { author: c.commit.author.name } : {}),
      }));
    },
    async files(n) {
      return (await paged(`/repos/${repo}/pulls/${n}/files`)).map((f) => ({
        path: f.filename, status: STATUS_LETTER[f.status] ?? 'M', ranges: rangesOfFilePatch(f.patch),
      }));
    },
    async canWrite() {
      try {
        const r = await ok('GET', `/repos/${repo}`);
        const p = r.permissions ?? {};
        return p.push || p.admin || p.maintain
          ? { allowed: true, reason: `the host lets this credential write to ${repo}` }
          : { allowed: false, reason: `the host does not let this credential write to ${repo}` };
      } catch (err) {
        return { allowed: false, reason: `the host did not answer for ${repo}: ${(err as Error).message}` };
      }
    },
    async upsertComment(n, marker, body) {
      const all = await paged(`/repos/${repo}/issues/${n}/comments`);
      const mine = all.find((c) => String(c.body ?? '').includes(marker));
      if (mine) {
        const r = await ok('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body });
        return { url: r.html_url, updated: true };
      }
      const r = await ok('POST', `/repos/${repo}/issues/${n}/comments`, { body });
      return { url: r.html_url, updated: false };
    },
    async status(sha, state, description, context, url) {
      await ok('POST', `/repos/${repo}/statuses/${sha}`, { state, description: description.slice(0, 140), context, ...(url ? { target_url: url } : {}) });
    },
  };
}

/** Open the host the way the person asked: `--via gh`, else the keychain token, else no credential (public reads only). */
export async function openGitHub(src: CodeHostSource | undefined, repo: string, opts: { viaGh?: boolean } = {}): Promise<{ host: GitHubHost; credential: Verdict }> {
  if (opts.viaGh) {
    const host = githubHost(repo, { via: 'gh' });
    const login = await host.who();
    return { host, credential: login ? { allowed: true, reason: `the GitHub CLI's own login (${login}), because --via gh was passed` } : { allowed: false, reason: 'the GitHub CLI is not logged in (gh auth login)' } };
  }
  const ref = src?.auth?.secret;
  if (!ref) return { host: githubHost(repo, { via: 'none', ...(src?.api ? { api: src.api } : {}) }), credential: { allowed: false, reason: 'no credential: the code-host source names no auth.secret (keychain:farsight/github-<org>)' } };
  let token: string;
  try {
    token = await resolveSecret(ref);
  } catch (err) {
    const why = err instanceof SecretUnavailable ? err.message : 'the secret could not be read';
    return { host: githubHost(repo, { via: 'none', ...(src?.api ? { api: src.api } : {}) }), credential: { allowed: false, reason: why } };
  }
  const host = githubHost(repo, { via: 'token', token, ...(src?.api ? { api: src.api } : {}) });
  const login = await host.who();
  return { host, credential: login ? { allowed: true, reason: `the token in ${ref} acts as ${login}` } : { allowed: false, reason: `the token in ${ref} was refused by the host` } };
}

/** The three verdicts of one post, ANDed. The host is not asked when the policy already said no. */
export async function decidePost(
  src: CodeHostSource | undefined, who: 'human' | 'agent', open: () => Promise<{ host: GitHubHost; credential: Verdict }>, pr: () => Promise<PullRequest>,
): Promise<{ verdicts: Verdicts; allowed: boolean; requiresConfirmation: boolean; host?: GitHubHost }> {
  const policy = codeHostPolicy(src, 'comment', who);
  const check = codeHostPolicy(src, 'check', who);
  const pv: Verdict = policy.verdict.allowed && !check.verdict.allowed
    ? { allowed: false, reason: `comment granted, check not: ${check.verdict.reason}` }
    : policy.verdict;
  if (!pv.allowed) {
    const no = { allowed: false, reason: 'not asked — the policy denied it first' };
    return { verdicts: { policy: pv, tracker: no, credential: no }, allowed: false, requiresConfirmation: false };
  }
  if (src && src.host !== 'github') {
    const no = { allowed: false, reason: `posting to ${src.host} is not built yet (GitHub only)` };
    return { verdicts: { policy: pv, tracker: no, credential: no }, allowed: false, requiresConfirmation: false };
  }
  const { host, credential } = await open();
  let tracker: Verdict;
  try {
    const p = await pr();
    tracker = p.state !== 'open'
      ? { allowed: false, reason: `pull request #${p.number} is ${p.state}` }
      : await host.canWrite();
  } catch (err) {
    tracker = { allowed: false, reason: `the host did not answer: ${(err as Error).message}` };
  }
  const allowed = pv.allowed && tracker.allowed && credential.allowed;
  return { verdicts: { policy: pv, tracker, credential }, allowed, requiresConfirmation: allowed && (policy.requiresConfirmation || check.requiresConfirmation), host };
}
