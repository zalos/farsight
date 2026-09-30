/**
 * Git history reader — the one place a `git` process is launched for history.
 *
 * History is *not* graph content (see docs/proposals/change-history-2026-09.md §1):
 * a commit is a fact about the repository, at file granularity. This module
 * reads those facts and hands them to `core/history.ts`, which folds them
 * beside the snapshot spine. It lives in `shared/` because it is
 * language-agnostic, exactly like `files.ts` (freshness, content digests) and
 * `tags.ts` (path normalization) next to it.
 *
 * **Every function returns a value that says which absence it hit; none throws
 * for an environment fact.** A directory that is not a repository, a missing
 * `git` binary, a repository with no commits, a log too large to buffer — each
 * comes back as `{ available: false, reason, detail }`. A caller can therefore
 * tell *"no history here"* from *"history we did not read"*, which is the whole
 * point: an absence is a word, never a silent empty list.
 *
 * Two boundaries the callers own rather than this module:
 * - **Shallow clones.** `gitShallow()` is separate; when it says `true` the
 *   oldest commit `gitLog()` returned is a graft boundary, so "first seen in"
 *   is a *floor* (at or before `<sha>`), not an exact answer.
 * - **Monorepo paths.** `commit_file.path` here is repo-root-relative; a node's
 *   `loc.path` is source-root-relative. Joining them needs the source's own
 *   prefix, which only the consumer knows — `core/history.ts` (H4) does that
 *   join. Skipping it makes attribution return nothing, which reads like
 *   "no commits touched this".
 */
import { execFileSync } from 'node:child_process';
import { mergeSubjectBranch, commitKeysOf } from '@farsight/core';
import type { CommitInput, FileStatus, KeyDetectOptions, KeyDetector } from '@farsight/core';

/** Why no history came back. Each maps to a sentence a surface can render. */
export type GitAbsentReason =
  /** The `git` binary is not on PATH. */
  | 'no-git'
  /** The directory exists but is not a git repository (or does not exist). */
  | 'not-a-repo'
  /** A repository with no commits yet — git itself has nothing to walk. */
  | 'no-commits'
  /** The log exceeded the read buffer: lower `max` or pass `since`. */
  | 'too-large'
  /** git ran and refused; `detail` carries what it said. */
  | 'git-failed';

/**
 * One sentence per absence, so "no history" is always *which* no-history it is.
 * An empty commit list with no sentence would read as "no commits touched this",
 * which is the one thing none of these mean. It lives beside the reason type so
 * that every consumer — `farsight history`, `farsight diff --attribute`,
 * `/api/history`, `/api/diff` — renders the same words for the same fact.
 */
export const GIT_ABSENT_WORD: Record<GitAbsentReason, string> = {
  'no-git': 'no `git` binary on PATH — history is read by running git, so none can be read here',
  'not-a-repo': 'not a git repository — the code is here, its history is not',
  'no-commits': 'a git repository with no commits yet — git itself has nothing to walk',
  'too-large': 'the log exceeded the read buffer — narrow it with `--since`, or lower `--max`',
  'git-failed': 'git ran and refused to walk this history',
};

/** The absence half of every result here. */
export interface GitAbsent {
  available: false;
  reason: GitAbsentReason;
  /** git's own stderr (trimmed, first line), so the reason can be shown verbatim. */
  detail?: string;
}

/** Present-or-absent, so a caller destructures one shape for both. */
export type GitFact<T> = ({ available: true } & T) | GitAbsent;

/** git's `--raw` status letters. `X` is git's own word for "unknown". */
export type GitFileStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'B' | 'X';

/** One file touched by one commit — a `commit_file` row. */
export interface GitFileChange {
  /** Repo-root-relative, forward slashes (see the monorepo note above). */
  path: string;
  status: GitFileStatus;
  /** Where the file came from, for `R`/`C` only — what `-M` detected. */
  oldPath?: string;
  /** Similarity percentage from the status letter (`R085` → 85), `R`/`C` only. */
  similarity?: number;
  /** Lines added; **undefined when `binary`** — never a stand-in zero. */
  added?: number;
  /** Lines deleted; undefined when `binary`. */
  deleted?: number;
  /** numstat reported `-` for this file: counts are not knowable, not zero. */
  binary: boolean;
}

/** One commit — a `commit` row plus the files it touched. */
export interface GitCommit {
  sha: string;
  /** Parent shas in git's order; empty for a root commit. */
  parents: string[];
  /** Author time, unix seconds. */
  at: number;
  author: string;
  email: string;
  subject: string;
  /** The message body after the subject (`%b`), trimmed; empty when there is none. */
  body: string;
  /** More than one parent. A merge carries no `files` — see `gitLog`. */
  merge: boolean;
  /**
   * Branches whose name passed `GitLogOptions.keyRefs` and that carry this
   * commit as their own: `via: 'branch'` — the ref reaches it and the default
   * branch does not; `via: 'merge'` — a merge commit naming that branch in its
   * subject brought it in (`M^1..M^2`), so the branch's name survives the merge
   * even after the ref is deleted. Absent when `keyRefs` was not asked for.
   */
  branches?: { ref: string; via: 'branch' | 'merge' }[];
  /** Empty for a merge and for an empty commit; both are facts, not failures. */
  files: GitFileChange[];
}

/** How a tag spells its version, so `--releases` can report the scheme it saw. */
export type GitTagScheme = 'v-prefixed' | 'bare-semver' | 'other';

/** A tag, dereferenced to the commit it names. */
export interface GitTag {
  name: string;
  /** The commit sha — annotated tags are dereferenced, so this is never a tag object. */
  sha: string;
  /** The commit's committer time, unix seconds; undefined if git did not give one. */
  at?: number;
  annotated: boolean;
  scheme: GitTagScheme;
}

export interface GitLogOptions {
  /** Passed to `git log --since=`; any date expression git accepts. */
  since?: string;
  /** Hard cap on commits walked. Default 2000 — history must never be unbounded. */
  max?: number;
  /** Walk only `<after>..HEAD`: the commits since one already read (an incremental read). */
  after?: string;
  /**
   * Attribute commits to the branches whose name passes this test (a work-item
   * key detector): see {@link GitCommit.branches}. Costs one `for-each-ref` and
   * one bounded `rev-list` per matching ref or merge.
   */
  keyRefs?: (name: string) => boolean;
}

/** What `gitLog` found. */
export interface GitLogResult {
  commits: GitCommit[];
  /** `max` was reached, so older commits exist and were **not read**. */
  truncated: boolean;
  /** The cap actually applied, so a surface can say what bounded it. */
  max: number;
  /**
   * With `keyRefs`: the default branches (space-separated) branch attribution was measured against,
   * or why none could be (then `via: 'branch'` attributes nothing; merges still do).
   */
  branchBase?: { ref: string } | { none: string };
}

/** What `gitHeadRef` found. */
export interface GitHeadResult {
  sha: string;
  /** The branch HEAD points at; absent when detached. */
  ref?: string;
  /** No symbolic ref: `git log` walks one ancestry, so titles say *ancestry of `<sha>`*. */
  detached: boolean;
}

/** Commits walked when a caller names no cap — bounded by design (§8). */
export const DEFAULT_MAX_COMMITS = 2000;

/** Record separator in the `--format`; a token starting with it begins a commit. */
const MARKER = '\x01';
/** sha1 (40) or sha256 (64) object names. */
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** `added \t deleted \t path` — either count may be `-` for a binary file. */
const NUMSTAT = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

const REV_TIMEOUT_MS = 10_000;
const LOG_TIMEOUT_MS = 60_000;
/** a 59-commit repository's history are 318 KB of `--raw --numstat`; 2000 could be ~10 MB. */
const LOG_MAX_BUFFER = 128 * 1024 * 1024;

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string;
}

/**
 * Run git and never throw: a failure comes back as `ok:false` with git's own
 * stderr. stdin/stderr are piped rather than inherited so a probe cannot print
 * `fatal:` noise into a CLI's output.
 */
function run(root: string, args: string[], timeout: number, maxBuffer = 1024 * 1024): GitRun {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      timeout,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'buffer',
    });
    return { ok: true, stdout: out.toString('utf8'), stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; code?: string | number };
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString('utf8') : '',
      stderr: e.stderr ? e.stderr.toString('utf8') : '',
      code: typeof e.code === 'string' ? e.code : undefined,
    };
  }
}

/** git's complaint as one line, for the `detail` a surface can quote. */
function firstLine(stderr: string): string | undefined {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line || undefined;
}

/** Turn a failed run into the absence it actually is. */
function absent(r: GitRun, fallback: GitAbsentReason = 'git-failed'): GitAbsent {
  const detail = firstLine(r.stderr);
  if (r.code === 'ENOENT' && !detail) return { available: false, reason: 'no-git' };
  if (r.code === 'ENOBUFS') return { available: false, reason: 'too-large', ...(detail ? { detail } : {}) };
  const said = (detail ?? '').toLowerCase();
  if (said.includes('not a git repository') || said.includes('cannot change to')) {
    return { available: false, reason: 'not-a-repo', ...(detail ? { detail } : {}) };
  }
  if (said.includes('does not have any commits') || said.includes('needed a single revision')) {
    return { available: false, reason: 'no-commits', ...(detail ? { detail } : {}) };
  }
  return { available: false, reason: fallback, ...(detail ? { detail } : {}) };
}

/**
 * Is there a repository here at all, and does it have a commit to walk?
 * `--git-dir` (not `--is-inside-work-tree`) so a bare repository counts, and
 * `--verify HEAD` so an initialized-but-empty repository says `no-commits`
 * rather than looking like a broken log.
 */
function repoCheck(root: string): GitAbsent | undefined {
  const dir = run(root, ['rev-parse', '--git-dir'], REV_TIMEOUT_MS);
  if (!dir.ok) return absent(dir, 'not-a-repo');
  const head = run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], REV_TIMEOUT_MS);
  if (!head.ok || !head.stdout.trim()) return { available: false, reason: 'no-commits' };
  return undefined;
}

/**
 * Repo-root-relative with forward slashes, the way the rest of the parser
 * spells a path (`relative(repoRoot, abs)` in `tsjs.ts:239`, `java/index.ts:87`).
 * `tags.ts`'s `normalizePath` is a *route* normalizer (`/x/:id` → `/x/:param`)
 * and must not be applied to a file path; this is the file-path sibling.
 * Git already emits repo-relative forward-slash paths under `-z` (no octal
 * quoting), so this only guards against a caller's own spelling.
 */
export function normalizeRepoPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/** `1.2.3` vs `v1.2.3` vs everything else — one real repository carries the first two at once. */
function tagScheme(name: string): GitTagScheme {
  if (/^v\d+\.\d+/.test(name)) return 'v-prefixed';
  if (/^\d+\.\d+/.test(name)) return 'bare-semver';
  return 'other';
}

/**
 * Read commits with the files each touched.
 *
 * `--raw` **and** `--numstat` together, NUL-delimited: `--numstat` carries the
 * add/delete counts but no status letter and no similarity score, while `--raw`
 * carries `A`/`M`/`D`/`R085` and the rename's old path. One pass gives both, and
 * `-M` is what pairs a rename at all. `-z` is what makes the parse safe — a
 * subject containing a quote or a tab, or a path with a space, cannot shift a
 * field, because fields are NUL-terminated and paths are never octal-quoted.
 * `--no-diff-merges` pins the default so a workspace's `log.diffMerges` config
 * cannot silently start attributing a merge's whole combined diff to it: a merge
 * comes back with `files: []`, as does an empty commit. That flag is git ≥ 2.31
 * (2021); an older git returns `{available:false, reason:'git-failed'}` carrying
 * its own "unknown option" line, which is the honest outcome — better than
 * quietly reading merges under whatever the machine's config says.
 *
 * Bounded by design: `max` defaults to {@link DEFAULT_MAX_COMMITS} and
 * `truncated` says when older commits went unread. Never call this from
 * `ingest`. `POST /api/sync` calls it since the work-items pass (2026-09-30)
 * only incrementally (`after` = the newest commit already recorded) and under a
 * smaller cap, fail-soft, so a slow history degrades the sync's status line
 * rather than the sync.
 */
export function gitLog(root: string, options: GitLogOptions = {}): GitFact<GitLogResult> {
  const bad = repoCheck(root);
  if (bad) return bad;
  const max = Math.max(1, Math.floor(options.max ?? DEFAULT_MAX_COMMITS));
  const args = [
    '-c', 'log.showSignature=false',
    'log',
    '-z',
    '--raw',
    '--numstat',
    '-M',
    '--no-diff-merges',
    // One over the cap, so `truncated` is exact: a repo with exactly `max`
    // commits must not claim there is more history than it has.
    `--max-count=${max + 1}`,
    `--format=${MARKER}%H%x00%P%x00%at%x00%an%x00%ae%x00%s%x00%b`,
  ];
  if (options.since) args.push(`--since=${options.since}`);
  // with keyRefs the walk covers the key-bearing branches too, not only HEAD's ancestry:
  // a feature branch nobody merged yet is exactly where a work item's commits are
  const keyRefNames = options.keyRefs ? keyBearingRefs(root, options.keyRefs) : [];
  if (options.after || keyRefNames.length) {
    if (options.after) args.push(`^${options.after}`);
    args.push('HEAD', ...keyRefNames, '--');
  }
  const r = run(root, args, LOG_TIMEOUT_MS, LOG_MAX_BUFFER);
  if (!r.ok) return absent(r);
  const walked = parseLog(r.stdout);
  const truncated = walked.length > max;
  const commits = truncated ? walked.slice(0, max) : walked;
  if (!options.keyRefs) return { available: true, commits, truncated, max };
  const branchBase = attributeBranches(root, commits, options.keyRefs, max);
  return { available: true, commits, truncated, max, branchBase };
}

/** Refs walked per read, so a repository with thousands of branches cannot stall a sync. */
const MAX_KEY_REFS = 200;

/**
 * The branches every other branch is measured against: origin/HEAD's target and
 * every local or remote main/master that exists. All of them, not the first
 * found: a local main ahead of origin (commits not pushed yet) would otherwise
 * hand its own commits to every branch cut from it.
 */
function defaultBranches(root: string): string[] {
  const out: string[] = [];
  const sym = run(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], REV_TIMEOUT_MS);
  if (sym.ok && sym.stdout.trim()) out.push(sym.stdout.trim());
  for (const name of ['main', 'master', 'origin/main', 'origin/master']) {
    if (out.includes(name)) continue;
    if (run(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], REV_TIMEOUT_MS).ok) out.push(name);
  }
  return out;
}

/**
 * Fill `branches` on the commits read: each key-bearing ref's own commits
 * (`<ref> --not <every default branch>`), and each key-bearing merge's brought-in commits
 * (`M^1..M^2`). A branch that was fast-forwarded into the default branch and
 * deleted leaves no trace here — git keeps none — which is why the key in the
 * subject is the stronger signal.
 */
function attributeBranches(root: string, commits: GitCommit[], keep: (name: string) => boolean, max: number): { ref: string } | { none: string } {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const tag = (sha: string, ref: string, via: 'branch' | 'merge') => {
    const c = bySha.get(sha);
    if (!c) return;
    c.branches ??= [];
    if (!c.branches.some((b) => b.ref === ref && b.via === via)) c.branches.push({ ref, via });
  };
  const revs = (...range: string[]): string[] => {
    const r = run(root, ['rev-list', `--max-count=${max}`, ...range], REV_TIMEOUT_MS, LOG_MAX_BUFFER);
    return r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter((l) => SHA.test(l)) : [];
  };
  for (const c of commits) {
    if (!c.merge || c.parents.length < 2) continue;
    const ref = mergeSubjectBranch(c.subject);
    if (!ref || !keep(ref)) continue;
    for (const sha of revs(`${c.parents[0]}..${c.parents[1]}`)) tag(sha, ref, 'merge');
  }
  const bases = defaultBranches(root);
  if (!bases.length) return { none: 'no origin/HEAD, main or master to measure branches against' };
  for (const ref of keyBearingRefs(root, keep).filter((n) => !bases.includes(n))) {
    for (const sha of revs(ref, '--not', ...bases)) tag(sha, ref, 'branch');
  }
  return { ref: bases.join(' ') };
}

/** Local and remote branches whose name passes `keep`, at most {@link MAX_KEY_REFS}. */
function keyBearingRefs(root: string, keep: (name: string) => boolean): string[] {
  const refs = run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], REV_TIMEOUT_MS);
  if (!refs.ok) return [];
  return refs.stdout.split('\n').map((l) => l.trim()).filter((n) => n && !n.endsWith('/HEAD') && n !== 'origin' && keep(n)).slice(0, MAX_KEY_REFS);
}

/**
 * One commit's patch, as `git show` prints it with no context lines — what the
 * work diff route serves and what hunks → nodes reads. `paths` confines it to
 * those repo-relative files. Bounded like the log.
 */
export function gitShowPatch(root: string, sha: string, opts: { paths?: string[]; context?: number } = {}): GitFact<{ patch: string }> {
  if (!SHA.test(sha) && !/^[0-9a-f]{7,64}$/.test(sha)) return { available: false, reason: 'git-failed', detail: `not a commit id: ${sha}` };
  const bad = repoCheck(root);
  if (bad) return bad;
  const args = ['-c', 'log.showSignature=false', 'show', '--no-color', '--format=', '-M', `--unified=${opts.context ?? 0}`, '--first-parent', sha];
  if (opts.paths?.length) args.push('--', ...opts.paths);
  const r = run(root, args, LOG_TIMEOUT_MS, LOG_MAX_BUFFER);
  if (!r.ok) return absent(r);
  return { available: true, patch: r.stdout };
}

/** The last commit `after` can start from, when it is still in the history (a rewritten history makes it unknown). */
export function gitKnows(root: string, sha: string): boolean {
  return run(root, ['cat-file', '-e', `${sha}^{commit}`], REV_TIMEOUT_MS).ok;
}

/** A token that opens a commit record: the marker plus a full object name. */
function isMarker(token: string): boolean {
  return token.startsWith(MARKER) && SHA.test(token.slice(1));
}

/**
 * Split the NUL stream into commits. Header = the marker token plus exactly six
 * more (parents, time, author, email, subject, body), so no heuristic decides where a
 * subject ends; everything until the next marker is that commit's diff.
 */
function parseLog(out: string): GitCommit[] {
  const tokens = out.split('\0');
  const commits: GitCommit[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isMarker(tokens[i]!)) { i++; continue; }
    const sha = tokens[i]!.slice(1);
    const parents = (tokens[i + 1] ?? '').trim().split(/\s+/).filter(Boolean);
    const at = Number.parseInt((tokens[i + 2] ?? '').trim(), 10);
    const author = tokens[i + 3] ?? '';
    const email = tokens[i + 4] ?? '';
    const subject = tokens[i + 5] ?? '';
    const body = (tokens[i + 6] ?? '').trim();
    i += 7;
    const diff: string[] = [];
    while (i < tokens.length && !isMarker(tokens[i]!)) { diff.push(tokens[i]!); i++; }
    commits.push({
      sha,
      parents,
      at: Number.isFinite(at) ? at : 0,
      author,
      email,
      subject,
      body,
      merge: parents.length > 1,
      files: parseDiff(diff),
    });
  }
  return commits;
}

/**
 * Fold one commit's `--raw` entries (status, similarity, old path) and
 * `--numstat` entries (counts) into one row per file, keyed on the path the
 * file ended up at. git emits both sections in the same order, but keying
 * rather than zipping means a missing side degrades to a partial row instead of
 * mis-pairing two files.
 */
function parseDiff(tokens: string[]): GitFileChange[] {
  // The diff section is preceded by the newline git puts after the format output.
  const toks = tokens.length ? [tokens[0]!.replace(/^\n+/, ''), ...tokens.slice(1)] : [];
  const byPath = new Map<string, GitFileChange>();
  const at = (path: string): GitFileChange => {
    const key = normalizeRepoPath(path);
    let row = byPath.get(key);
    if (!row) { row = { path: key, status: 'X', binary: false }; byPath.set(key, row); }
    return row;
  };
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (!tok) { i++; continue; }
    if (tok.startsWith(':')) {
      // `:<srcmode> <dstmode> <srcsha> <dstsha> <STATUS>` then 1 path, or 2 for R/C.
      const field = tok.trim().split(/\s+/).pop() ?? '';
      const letter = (field[0] ?? 'X').toUpperCase();
      const score = Number.parseInt(field.slice(1), 10);
      const status = (['A', 'C', 'D', 'M', 'R', 'T', 'U', 'B'] as const).find((s) => s === letter) ?? 'X';
      if (status === 'R' || status === 'C') {
        const oldPath = toks[i + 1] ?? '';
        const newPath = toks[i + 2] ?? '';
        const row = at(newPath);
        row.status = status;
        row.oldPath = normalizeRepoPath(oldPath);
        if (Number.isFinite(score)) row.similarity = score;
        i += 3;
      } else {
        const row = at(toks[i + 1] ?? '');
        row.status = status;
        i += 2;
      }
      continue;
    }
    const m = NUMSTAT.exec(tok);
    if (m) {
      // An empty path field means the two paths of a rename follow as their own tokens.
      const path = m[3] ? m[3] : (toks[i + 2] ?? '');
      const row = at(path);
      if (!m[3]) {
        if (!row.oldPath) row.oldPath = normalizeRepoPath(toks[i + 1] ?? '');
        i += 3;
      } else {
        i += 1;
      }
      // `-` is git saying the counts are not knowable for a binary file.
      if (m[1] === '-' || m[2] === '-') {
        row.binary = true;
        delete row.added;
        delete row.deleted;
      } else {
        row.added = Number.parseInt(m[1]!, 10);
        row.deleted = Number.parseInt(m[2]!, 10);
      }
      continue;
    }
    i++; // a token we do not recognize is skipped, never guessed at
  }
  return [...byPath.values()];
}

/**
 * Tags, dereferenced to commits. Annotated and lightweight tags are both here —
 * one real repository carries 23 tags in *two* schemes (`1.1.0` and `v1.1.0`), which is
 * exactly why a release is declared rather than inferred from a tag (§3). The
 * `scheme` field is what `farsight history --releases` reports alongside its
 * proposal.
 */
export function gitTags(root: string): GitFact<{ tags: GitTag[] }> {
  const bad = repoCheck(root);
  if (bad) return bad;
  const fmt = [
    '%(refname:short)', '%(objecttype)', '%(objectname)',
    '%(*objectname)', '%(committerdate:unix)', '%(*committerdate:unix)',
  ].join('%00');
  const r = run(root, ['for-each-ref', `--format=${fmt}%01`, 'refs/tags'], REV_TIMEOUT_MS);
  if (!r.ok) return absent(r);
  const tags: GitTag[] = [];
  for (const record of r.stdout.split('\x01')) {
    const line = record.replace(/^\n+/, '');
    if (!line.trim()) continue;
    const [name = '', type = '', objectname = '', deref = '', date = '', derefDate = ''] = line.split('\0');
    const sha = deref || objectname; // an annotated tag's own sha is not a commit
    if (!name || !sha) continue;
    const at = Number.parseInt((derefDate || date).trim(), 10);
    tags.push({
      name,
      sha,
      ...(Number.isFinite(at) && at > 0 ? { at } : {}),
      annotated: type === 'tag',
      scheme: tagScheme(name),
    });
  }
  return { available: true, tags };
}

/**
 * Is this a shallow clone? Normal for a git source the server cloned
 * (`server/src/index.ts:76` clones `--depth 1`), and the reason "first seen in"
 * can only be a **floor**: the oldest commit `gitLog` returned is a graft
 * boundary, not the first commit that exists.
 */
export function gitShallow(root: string): GitFact<{ shallow: boolean }> {
  const r = run(root, ['rev-parse', '--is-shallow-repository'], REV_TIMEOUT_MS);
  if (!r.ok) return absent(r, 'not-a-repo');
  const said = r.stdout.trim();
  // Old git printed a path for `--is-shallow-repository`; only "false" is false.
  return { available: true, shallow: said !== 'false' && said !== '' };
}

/**
 * What HEAD is: its sha, the branch it points at, and whether it is detached.
 * A detached HEAD still has a sha (so a sync can record one, as `gitHead` does)
 * but no branch, and `git log` then walks one ancestry — surfaces title that
 * *ancestry of `<sha>`* rather than pretending it is a branch's history.
 */
export function gitHeadRef(root: string): GitFact<GitHeadResult> {
  const bad = repoCheck(root);
  if (bad) return bad;
  const sha = run(root, ['rev-parse', 'HEAD'], REV_TIMEOUT_MS);
  if (!sha.ok) return absent(sha);
  const ref = run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], REV_TIMEOUT_MS);
  const branch = ref.ok ? ref.stdout.trim() : '';
  return {
    available: true,
    sha: sha.stdout.trim(),
    ...(branch ? { ref: branch } : {}),
    detached: !branch,
  };
}

/**
 * HEAD sha of the git repo at dir, or undefined (not a repo, no git, …).
 *
 * Moved here from `cli.ts` (where it was at `:110-118`) so one module owns
 * every git invocation; the CLI re-exports nothing and calls this instead. The
 * `string | undefined` signature is deliberately unchanged — a sync stamps a
 * commit or it does not — and `gitHeadRef()` is the honest shape for anything
 * that needs to *say which* absence it hit.
 */
export function gitHead(dir: string): string | undefined {
  const head = gitHeadRef(dir);
  return head.available ? head.sha : undefined;
}

/**
 * HEAD's sha and its committer time — what a `changed` test report needs to
 * say whether a commit moved or only the working tree did
 * (`tests/reports.ts changedByOf`). Undefined when git cannot be asked.
 */
export function gitHeadAt(dir: string): { sha: string; at?: string } | undefined {
  const sha = gitHead(dir);
  if (!sha) return undefined;
  const r = run(dir, ['show', '-s', '--format=%cI', sha], REV_TIMEOUT_MS);
  const at = r.ok ? r.stdout.trim() : '';
  return { sha, ...(at ? { at } : {}) };
}

/**
 * Where this directory sits **inside** its repository — `""` at the top level,
 * `"apps/web/"` for a source mounted in a monorepo. `git rev-parse
 * --show-prefix` answers it directly, with the trailing slash git prints.
 *
 * This is the monorepo join the attribution in `farsight-diff v1` needs
 * (change-history-2026-09.md §8): `commit_file.path` is repository-root-relative
 * while a node's `loc.path` is source-root-relative, so without this prefix a
 * source below its repository root attributes **nothing** — and an empty commit
 * list reads as "nothing touched this file", which would be a lie with no
 * evidence behind it. A `GitFact`, so a caller that cannot read it says so
 * rather than joining on a guess.
 */
export function gitPrefix(root: string): GitFact<{ prefix: string }> {
  const r = run(root, ['rev-parse', '--show-prefix'], REV_TIMEOUT_MS);
  if (!r.ok) return absent(r, 'not-a-repo');
  // `--show-prefix` prints an empty line at the top level, and a bare repository
  // has no work tree to be inside at all; both are honestly "no prefix".
  return { available: true, prefix: normalizeRepoPath(r.stdout.trim()) };
}

/**
 * What to call the history a `git log` from this HEAD walks — used as the title
 * of a spine (`farsight history`, `GET /api/history`). A detached HEAD walks one
 * ancestry and no branch, so it is titled as the ancestry it is rather than
 * dressed up as a branch's history (§8). Absent when HEAD could not be read.
 */
export function headTitle(head: GitFact<GitHeadResult>): string | undefined {
  if (!head.available) return undefined;
  const short = head.sha.slice(0, 7);
  return head.detached ? `ancestry of ${short} (detached HEAD)` : head.ref || short;
}

/**
 * The sentence a shallow clone earns (§8). The oldest commit reachable is a
 * graft boundary, not the first commit that exists, so *first seen in* is a
 * **floor** — the same `floor | exact` bound `computeMetric` uses. Pass the
 * oldest commit actually known when there is one; the floor stands without it.
 */
export function shallowFloorSentence(oldestSha?: string): string {
  return `shallow clone — the oldest commit read is a graft boundary, so "first seen in" is a floor${oldestSha ? `: at or before ${oldestSha.slice(0, 7)}` : ''}`;
}

/** git's `--raw` letters as the history tables spell them (the same map `farsight history` applies). */
export const GIT_STATUS_WORD: Record<GitFileStatus, FileStatus> = {
  A: 'added', C: 'copied', D: 'deleted', M: 'modified',
  R: 'renamed', T: 'typechange', U: 'unmerged', B: 'unknown', X: 'unknown',
};

/**
 * Commits as `SnapshotDb.writeCommits` takes them. With `keys`, each commit
 * also carries the work-item keys it names and how (`commitKeysOf`) and the
 * key-bearing branches that carry it; without, `keys`/`branches` stay absent
 * so a plain history read never erases what a keyed read recorded.
 */
export function commitInputsOf(commits: readonly GitCommit[], keys?: { opts: KeyDetectOptions; detect?: KeyDetector }): CommitInput[] {
  return commits.map((c) => ({
    sha: c.sha,
    at: new Date(c.at * 1000).toISOString(),
    author: c.author,
    email: c.email,
    subject: c.subject,
    parents: c.parents,
    merge: c.merge,
    files: c.files.map((f) => ({
      path: f.path,
      status: GIT_STATUS_WORD[f.status] ?? 'unknown',
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      ...(f.added === undefined ? {} : { added: f.added }),
      ...(f.deleted === undefined ? {} : { deleted: f.deleted }),
      ...(f.similarity === undefined ? {} : { similarity: f.similarity }),
    })),
    ...(keys
      ? {
        keys: commitKeysOf(c, c.branches ?? [], keys.opts, keys.detect),
        branches: [...new Set((c.branches ?? []).map((b) => b.ref))],
      }
      : {}),
  }));
}
