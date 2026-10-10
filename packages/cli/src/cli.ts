#!/usr/bin/env node
import { resolve, join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import {
  GraphStore, buildIndex, setFreshnessMeta,
  SnapshotDb, SnapshotUnavailable, diffGraphs, parsePolicy, applyPolicy, toSarif, toMarkdown, changeSentence,
  stitchHttp, apiSurface, graphToSpec, reconcile, driftMarkdown,
  storybookLive,
  designSurface, reconcileDesign, designDriftMarkdown, isDesignManifest, buildLine, buildInfo, installState, currencyAdvice,
  testsSurface, formatMetric, testsMatrixV1, testsMatrixRows, testsMatrixCsv, countedLine, breakdownText, countedText, storyCounts, t as word,
  search, impactOf, impactTestsV1, impactTestsReaching, nodesInHunks, IMPACT_MAX_HOPS,
  packagesOf, importersOf, resolvePackage, configFilesText,
  journeyTree, pickJourneys, journeyTreeLines, unknownStorylineText,
  attributeDiffOver, spineRowNote, spineSentences, parseSyncRef as parseSyncRefValue, INCOMPLETE_SENTENCE,
} from '@farsight/core';
import type {
  SourceStat, GraphDiff, GraphNode, GraphEdge, TestsMeta, TestsMatrixIdentity, TestMatrixCell, ImpactNode, ImpactReport,
  CommitInput, FileStatus,
} from '@farsight/core';
import {
  ingestRepo, ingestSpec, isSpecUrl, readSpecSource, specToYaml, ingestDesign, readManifestSource,
  importReports, repoContentDigest, gitHead, gitLog, commitInputsOf, gitTags, gitShallow, gitHeadRef, gitPrefix, DEFAULT_MAX_COMMITS,
  GIT_ABSENT_WORD, headTitle, shallowFloorSentence,
} from '@farsight/parsers';
import type { GitCommit, GitFileStatus } from '@farsight/parsers';
import { serveGraph, writeSpine, resolveCommitNodes, syncWork, workSourcesOf, keyOptionsOf, keyDetector } from '@farsight/server';
import type { WorkSettingsSource } from '@farsight/server';
import type { Settings } from '@farsight/server';
import { runMcpServer } from '@farsight/mcp';
import { runWork } from './work.js';
import { runAffected, runReadiness } from './affected.js';

const [, , command, ...rest] = process.argv;

function flag(name: string, fallback?: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
}
/** A flag that takes no value, so the word after it is a positional (`serve --read-only graph.json`). */
const BOOL_FLAGS = new Set(['--read-only', '--json', '--post', '--confirm', '--csv']);
function hasFlag(name: string): boolean { return rest.includes(`--${name}`); }
const positional = rest.filter((a, i) => !a.startsWith('--') && (rest[i - 1]?.startsWith('--') !== true || BOOL_FLAGS.has(rest[i - 1] ?? '')));

const USAGE = `farsight — see your software the way you think about it
${buildLine()}

usage:
  farsight version | --version | -v                            which build this is: version · built · commit
  farsight status [--port 4477] [--graph graph.json]           is anything out of date: the installed build vs the server on
                                                               the port vs the build that wrote the graph, with the steps to
                                                               check / update / restart / re-ingest; exit 1 when action is needed
  farsight ingest [dirs|specs...] [--repo name] [--out graph.json] [--exclude "examples/**,**/*.test.ts"]
                                                               parse repo(s) into a semantic graph; a positional that is an
                                                               OpenAPI file or URL is ingested as a spec-only source
                                                               (also records a snapshot in .farsight/farsight.db)
  farsight serve [graph.json] [--port 4477] [--as-of sync:N] [--read-only]   explore the graph in the HUD (--read-only, and every --as-of, refuses settings, syncs and work writes)
  farsight mcp [--graph graph.json] [--as-of sync:N]           feed the graph to LLM agents (MCP/stdio)
  farsight snapshots [--limit 20] [--pin sync:N] [--prune 10]  list snapshot history (pin / prune retention)
  farsight history [--repo name] [<path>] [--since <date>] [--max 2000] [--releases] [--json]
                                                               read a repository's git log into the snapshot spine: what each sync
                                                               swept up, and how many of those commits no sync ever ingested
                                                               (--releases proposes the tags it found; a release is declared, never found)
  farsight diff --from sync:39 [--to sync:41] [--format json|sarif|md] [--attribute [--repo name]]
                                                               what changed between two snapshots (farsight-diff v1);
                                                               --attribute adds each change's file-level attribution: the commits
                                                               in that range that touched the file its subject lives in — the
                                                               file's history, not proof that any of them changed the node
  farsight gate --policy compliance.yml [--from sync:N] [--to sync:M]
                                                               apply a repo-owned policy to the diff; exit 1 on fail
  farsight api list [--graph graph.json]                       every API surface in the graph (spec-backed or implied)
  farsight api spec --repo <name> [--out openapi.yaml] [--format yaml|json]
                                                               generate an OpenAPI 3.1 document from the code (inferences marked)
  farsight api diff --spec <path|url> [--repo <name>] [--format json|md] [--strict]
                                                               a proposed spec vs the code: not implemented / undocumented /
                                                               mismatched; --strict exits 1 on any drift
  farsight deps list [--repo name] [--project name] [--third-party | --workspace] [--hops N] [--json]
                                                               every package the code imports: third-party or a workspace
                                                               library, the range each package.json declares, the files that
                                                               import it and the journeys it reaches (--json: farsight-deps v0,
                                                               not a frozen contract yet)
  farsight deps where <package|id> [--repo name] [--json]      every file that imports one package, grouped by project or
                                                               source, with the line, the specifier and the code that uses it
  farsight tests list [--level unit|e2e] [--scope a,b]         every test suite in the graph with its last run and freshness
  farsight tests matrix [--format table|csv|json]              journeys x tests: declared / reached / observed, coverage, gaps
                                                               (json|csv = farsight-tests-matrix v1, one row per flow/node/test)
  farsight tests import --results <file> [--coverage <file>] [--repo name] [--level unit|integration|e2e]
                        [--stamp [digest]] [--force-stamp] [--strict]
                                                               attach a report produced elsewhere (CI) to the existing graph;
                                                               --stamp writes the checkout's content digest into each JSON report
                                                               that carries none (exit 2 when a named digest is not this tree's);
                                                               --strict exits 1 on a glob that matched nothing, an unreadable
                                                               report, or a report that joined no case and produced no edge
  farsight impact <id|name> [--hops N] [--direction upstream|downstream] [--tests] [--flows]
                            [--include-setup] [--include-deferred] [--expand-shared] [--cap N]
                            [--changed <path[:from-to]>...] [--format text|json | --json]
                                                               what uses this, by distance: hop 1 is what uses it directly, hop 2
                                                               what reaches it through those, and so on to \`--hops 5\`. The hops are
                                                               never added together and every count is a floor while anything was
                                                               cut, capped, unstamped or resolved at run time. --changed turns
                                                               changed file ranges into seeds; --format json prints the report, or
                                                               farsight-impact-tests v1 with --tests (which tests a CI job can run,
                                                               and when it must run everything instead)
  farsight digest --repo <name> [--json] [--graph graph.json]  the content digest of that repo's checkout, computed the way ingest
                                                               computes it — what \`tests import --stamp\` must equal
  farsight stories [--graph graph.json] [--repo name] [--node <id>] [--json]
                                                               the repo Storybooks the graph found, whether each is running now,
                                                               and how its index maps onto components: matched by story id,
                                                               component file or title, and each entry that matched nothing
                                                               with its reason; exit 1 when a running index has unmatched entries.
                                                               Read-only: Farsight never starts a Storybook
  farsight affected --pr <n> | --from <sha> --to <sha> [--repo name] [--host-repo owner/name] [--hops N]
                    [--json] [--png <path>] [--post [--confirm] [--via gh]] [--graph graph.json]
                                                               what a pull request or a commit range touches: the parts its
                                                               changed lines sit in, the journeys that run them (with their
                                                               storyline step), the gates, record writes and calls on the changed
                                                               path, and each test case that reaches it once, with its own last
                                                               run (--json: the frozen farsight-affected v1). A pull request is
                                                               read from GitHub with the code-host source's keychain credential
                                                               (keychain:farsight/github-<org>), or with the GitHub CLI's own
                                                               login only when you pass --via gh. --post writes one comment
                                                               (updated in place) and one check on the pull request through the
                                                               three verdicts (your policy · the host · the credential); exit 0
                                                               posted, 1 not posted, 2 waiting for --confirm. --png draws the
                                                               stamped picture when Playwright's browser is installed
  farsight readiness --storyline <id> [--json | --csv] [--graph graph.json]
                                                               the release readiness brief: one row per step and branch of the
                                                               storyline — built, its own verdict and last run, skipped and never
                                                               run, gates no test is known to reach, commits since its last green
                                                               run (from the history), ship or hold with the reason; then the
                                                               rules register (gate · its words · screens · cases · owner)
  farsight work sync [--source id]                             copy the work items of every work source in .farsight/settings.json
                                                               (Jira, Azure DevOps) into .farsight/work.db: full first, then
                                                               incremental from the stored cursor
  farsight work list [--source id] [--state todo|in-progress|done|removed] [--assignee who] [--json]
                                                               the cached items with each source's freshness; --json is the
                                                               frozen farsight-work v1 list document
  farsight work status [--source id]                           each work source: mode, freshness, what it can do, last sync,
                                                               items, writes waiting for a person, writes in conflict
  farsight work show <key> [--source id] [--json]              one item: state, people, body, comments, history
  farsight work links <key> [--source id]                      what the item is joined to: graph links and linked items
  farsight work comment <key> <text> | assign <key> <person|none> | move <key> <todo|in-progress|done|removed> [--name s]
               | edit <key> <field>=<value>... | link <key> <kind> <other-key>   [--source id] [--confirm]   (flags last)
                                                               write to the tracker (edit-mode sources only): prints the three
                                                               verdicts (your policy · the tracker · the credential), the
                                                               tracker's dry run when it has one, and the outcome; exit 0
                                                               written, 1 not written, 2 waiting for --confirm
  farsight config list [--graph graph.json] [--repo name] [--json]
                                                               every farsight.config.json per source: the root file and the ones
                                                               scoped to a folder, the fields each gives and any it ignored, then
                                                               the conflicts between them and the notes (--json: per source
                                                               { files, conflicts, notes })
  farsight journeys [--repo name] [--persona p] [--group g] [--storyline s] [--json] [--graph graph.json]
                                                               the storylines (named chains of journeys, in order), then the journeys
                                                               by persona, then by group, in the order the manifests and
                                                               farsight.config.json declare: status, screens built, the way in
                                                               and the node id of each; a storyline's branches (when · back to)
                                                               sit indented under the step they leave from; --storyline keeps one
                                                               storyline and its journeys (an unknown one names those there are;
                                                               --json: the JourneyTree, as /api/journeys)
  farsight design list [--graph graph.json]                    every design source (screens manifest) with designed / built counts
  farsight design diff --manifest <path|url> [--repo <name>] [--format json|md] [--strict]
                                                               a proposed screens manifest vs the code: not built / undesigned /
                                                               operation drift; --strict exits 1 on any drift

Snapshot history lives in .farsight/farsight.db (override: --db <path>); graph.json always carries the latest sync.
Put a farsight.config.json at a repo root to add tag rules, a business glossary, declared guards/entrypoints,
\`openapi: [{ path | url }]\` entries for spec documents discovery would not find, and \`design: [{ manifest }]\`
for screens manifests (docs/design/screens.json — see docs/proposals/design-source.md). More files in folders
below it (an NX app's own farsight.config.json) speak only for the code under their folder, and their paths
are relative to it; projects and tooling are root-only. A positional that is a screens manifest is ingested as
a design-only source.`;

// version never mutates either — a consumer checks what it is talking to before anything runs
if (['version', '--version', '-v'].includes(command ?? '') || rest.includes('--version')) {
  console.log(buildLine());
  process.exit(0);
}
// `work --help`, `work help` and a bare `work` print only the work section of
// the usage — no banner, no settings read, no work.db created, no git
if (command === 'work' && (!rest[0] || ['help', '--help', '-h'].includes(rest[0]) || rest.includes('--help') || rest.includes('-h'))) {
  const lines = USAGE.split('\n');
  const from = lines.findIndex((l) => l.startsWith('  farsight work '));
  const to = lines.findIndex((l, i) => i > from && /^ {2}farsight (?!work )/.test(l));
  console.log(['usage:', ...lines.slice(from, to)].join('\n'));
  process.exit(rest[0] ? 0 : 1);
}
// --help must never mutate: bail before any command dispatch (an
// `ingest --help` once wrote graph.json into a consumer's repo root)
if (!command || ['help', '--help', '-h'].includes(command) || rest.includes('--help') || rest.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

/** Default snapshot-db path — workspace-relative, like .farsight/settings.json. */
function dbPath(): string {
  return resolve(flag('db', join('.farsight', 'farsight.db'))!);
}

/** Open the snapshot store, or fail with the honest degraded-mode message. */
function openDb(): SnapshotDb {
  try {
    return new SnapshotDb(dbPath());
  } catch (err) {
    if (err instanceof SnapshotUnavailable) fail(err.message);
    throw err;
  }
}

/** "sync:41" | "41" | "latest" → snapshot ref. The grammar itself lives in core, so `--from sync:3` and `/api/diff?from=sync:3` cannot drift. */
function parseSyncRef(value: string, flagName: string): number | 'latest' {
  const ref = parseSyncRefValue(value);
  if (ref === null) fail(`--${flagName} expects sync:<N> or latest (got "${value}")`);
  return ref;
}

/**
 * The workspace source that names this repo, when `.farsight/settings.json` has one.
 * Its `exclude` globs are what ingest applied, so a digest computed without them
 * would describe a different file set than the graph was built from.
 */
function workspaceSource(repo: string): { path: string; exclude?: string[] } | undefined {
  try {
    const s = JSON.parse(readFileSync(resolve(join('.farsight', 'settings.json')), 'utf8')) as Settings;
    const src = (s.sources ?? []).find((x) => x.name === repo) ?? (s.sources ?? []).find((x) => x.id === repo);
    if (!src || src.type !== 'local') return undefined;
    return { path: src.path, ...(src.exclude?.length ? { exclude: src.exclude } : {}) };
  } catch {
    return undefined; // no workspace settings here: the graph's roots are the only source of truth
  }
}

/**
 * Where a repo's code is and what ingest skipped in it — the pair `digest` and
 * `tests import --stamp` both need, resolved the same way so the digest they
 * compare can never be computed over two different file sets.
 */
function repoCheckout(store: GraphStore | undefined, repo: string, pathArg?: string): { root: string; exclude?: string[] } {
  const source = workspaceSource(repo);
  const root = pathArg ? resolve(pathArg) : store?.roots[repo] ?? (source ? resolve(source.path) : undefined);
  if (!root) {
    fail(`no checkout recorded for "${repo}" — the graph records no root for it and no local source in .farsight/settings.json names it (pass the path: \`farsight ${command} --repo ${repo} <path>\`)`);
  }
  if (!existsSync(root)) fail(`the checkout recorded for "${repo}" is not there: ${root}`);
  return { root, ...(source?.exclude?.length ? { exclude: source.exclude } : {}) };
}

/**
 * Write the digest of the tree the run saw into each JSON report that carries none
 * (03 §3.6). The reporters have no hook for it, so `tests import --stamp` is the
 * moment of record. A report that already names a digest is never overwritten — a
 * CI job may own it — and JUnit XML has nowhere to put one, so its `no-digest`
 * entry stands and says why. The key is appended last, after the existing ones, so
 * the istanbul sniff (parsers reports.ts: first object value) still lands on a
 * coverage entry; the text around it is untouched, so a 30 MB report is not
 * reformatted to add twelve hex characters.
 */
function stampReports(root: string, reports: TestsMeta['reports'], digest: string, repo: string): string[] {
  const written: string[] = [];
  const stampedAt = new Date().toISOString();
  // the commit beside the digest: a later digest mismatch on this same commit is a
  // working tree that differs from HEAD, not a new commit (TestRun.changedBy)
  const commit = gitHead(root);
  for (const r of reports) {
    // 'ok' / 'digest-changed' already carry a digest; 'no-match' / 'unreadable' / 'empty' have nothing to stamp
    if (!r.path || r.reason !== 'no-digest') continue;
    const abs = resolve(join(root, r.path));
    let text: string;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (/^\s*</.test(text)) continue; // JUnit XML: no place for the key — the blind spot says so
    const end = text.lastIndexOf('}');
    if (end < 0) continue;
    const head = text.slice(0, end);
    const block = `${/[^\s{]\s*$/.test(head) ? ',' : ''}"farsight":${JSON.stringify({ sourceDigest: digest, stampedAt, repo, ...(commit ? { commit } : {}) })}`;
    const next = head + block + text.slice(end);
    try { JSON.parse(next); } catch {
      console.error(`  ⚠ ${r.path}: not a JSON object this build can extend — left unstamped`);
      continue;
    }
    writeFileSync(abs, next);
    written.push(r.path);
  }
  return written;
}

/**
 * `meta.tests[repo]` counts read back off the fragment the import just changed,
 * never copied from what was there before (03 §3.6): a re-import that replaced a
 * report's evidence must not leave the old totals standing.
 */
function countTests(repo: string, nodes: GraphNode[], edges: GraphEdge[]): { cases: number; files: number; edges: TestsMeta['edges']; runs: number } {
  const mine = (id: string) => id.startsWith(`${repo}::`);
  const counts = { declared: 0, static: 0, observed: 0 };
  const files = new Set<string>();
  const tests = new Set<string>();
  let cases = 0;
  let runs = 0;
  for (const n of nodes) {
    if (n.kind !== 'test' || !mine(n.id)) continue;
    tests.add(n.id);
    if (n.test?.runLevel) continue; // the synthetic node a coverage report hangs off is not a case
    cases++;
    if (n.test?.file) files.add(n.test.file);
    runs += n.test?.runs?.length ?? (n.test?.run ? 1 : 0);
  }
  for (const e of edges) {
    if (e.kind !== 'covers' || !tests.has(e.from)) continue;
    const cls = String(e.meta?.evidence ?? 'declared');
    if (cls === 'static' || cls === 'observed') counts[cls]++; else counts.declared++;
  }
  return { cases, files: files.size, edges: counts, runs };
}

/** repo → the content digest of the code a document describes (the matrix identity, 03 §2.7). */
function repoDigests(store: GraphStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const repo of new Set([...Object.keys(store.roots), ...Object.keys(store.meta.repos ?? {})])) {
    const d = store.repoMeta(repo)?.sourceDigest;
    if (d) out[repo] = d;
  }
  return out;
}

/** Materialize an --as-of snapshot next to the db so serve/mcp (which read a graph file) can use it. */
function materializeAsOf(asOf: string): string {
  const db = openDb();
  const ref = parseSyncRef(asOf, 'as-of');
  const { store, ref: snap } = db.read(ref);
  const path = resolve(join('.farsight', `graph@sync-${snap.sync}.json`));
  // not store.save(): that would stamp generatedAt=now and misrepresent an as-of read as fresh
  writeFileSync(path, JSON.stringify(store.toJSON(), null, 1));
  console.error(`as-of sync:${snap.sync} (${snap.at} ${snap.tz}${snap.commit ? ` · ${snap.commit.slice(0, 7)}` : ''}) → ${path}`);
  return path;
}

/** Resolve --from/--to into two stores + their changedBetween rows (defaults: latest-1 → latest). */
function loadDiffEnds(): { base: ReturnType<SnapshotDb['read']>; head: ReturnType<SnapshotDb['read']>; db: SnapshotDb } {
  const db = openDb();
  const toRef = parseSyncRef(flag('to', 'latest')!, 'to');
  const head = db.read(toRef);
  const fromFlag = flag('from');
  const base = db.read(fromFlag ? parseSyncRef(fromFlag, 'from') : previousSync(db, head.ref.sync));
  return { base, head, db };
}

function previousSync(db: SnapshotDb, before: number): number {
  // SnapshotDb.previous() is the one "the sync before this one" rule, shared with /api/diff
  const prev = db.previous(before);
  if (prev === undefined) fail(`no snapshot before sync:${before} to diff against — pass --from sync:<N>`);
  return prev;
}

function renderDiff(diff: GraphDiff, format: string): string {
  if (format === 'json') return JSON.stringify(diff, null, 2);
  if (format === 'sarif') return JSON.stringify(toSarif(diff), null, 2);
  if (format === 'md') return toMarkdown(diff);
  return fail(`unknown --format "${format}" (json|sarif|md)`);
}


// ── history: git as a lens on the snapshot spine (change-history-2026-09.md) ──

/**
 * git's `--raw` status letter → the word `commit_file.status` stores. `B` is
 * git's own "pairing Broken", and `FileStatus` has no word for it: calling it
 * `modified` would assert the continuity git just said it could not establish,
 * so it lands on `unknown`, the one word that claims nothing.
 */
const GIT_STATUS_WORD: Record<GitFileStatus, FileStatus> = {
  A: 'added', C: 'copied', D: 'deleted', M: 'modified',
  R: 'renamed', T: 'typechange', U: 'unmerged', B: 'unknown', X: 'unknown',
};

/**
 * The seam between the reader (`parsers/shared/git.ts`) and the tables
 * (`SnapshotDb.writeCommits`): unix seconds → ISO 8601, status letter → status
 * word. `GitFileChange.binary` has no column — a `commit_file` row carries
 * counts or NULL — so a binary file arrives with `added`/`deleted` **absent**
 * rather than a stand-in zero, which is the same claim `binary: true` made.
 */
function commitInputs(commits: readonly GitCommit[]): CommitInput[] {
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
  }));
}

/** A release as §3 defines it: written down by a person, never discovered. */
interface DeclaredRelease { name: string; commit?: string; tag?: string; at?: string; repo?: string }

/**
 * The releases a workspace **declares** (§3). Read structurally rather than
 * through `Settings` — the server's type carries no `releases` field yet
 * (`server/src/index.ts:35-45`) — and read only: `farsight history` proposes
 * tags, it never writes a release row, because declaring one is a person's act.
 *
 * §3 spells an entry `{ name, commit | tag, at? }` with no repo, which a
 * multi-source workspace cannot resolve; so an entry naming a `repo` belongs to
 * that repo and one naming none is reported for every source.
 */
function declaredReleases(repo: string): DeclaredRelease[] {
  try {
    const s = JSON.parse(readFileSync(resolve(join('.farsight', 'settings.json')), 'utf8')) as { releases?: DeclaredRelease[] };
    return (s.releases ?? []).filter((r) => r && r.name && (!r.repo || r.repo === repo));
  } catch {
    return []; // no workspace settings here — nothing is declared, which is not the same as none existing
  }
}

/** Every enabled local source the workspace declares, by the name ingest records as the repo. */
/** The workspace's settings sources (work sources included), or none when there is no settings file. */
function settingsSources(): WorkSettingsSource[] {
  try {
    const s = JSON.parse(readFileSync(resolve(join('.farsight', 'settings.json')), 'utf8')) as { sources?: WorkSettingsSource[] };
    return s.sources ?? [];
  } catch {
    return [];
  }
}

function workspaceRepos(): string[] {
  try {
    const s = JSON.parse(readFileSync(resolve(join('.farsight', 'settings.json')), 'utf8')) as Settings;
    return (s.sources ?? [])
      .filter((x) => x.type === 'local' && x.enabled !== false)
      .map((x) => x.name || x.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Thousands separators on every count, so 1690 and 16900 cannot be misread at a glance. */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

// ── attribution: file-level provenance on the frozen diff (§2, chunk H4) ─────

/**
 * `farsight diff --attribute` — join the history rows onto a **copy** of the
 * diff (`attributeChanges` in core's `history.ts`), never inside `diffGraphs`,
 * which reads no git and must keep emitting the frozen document byte for byte.
 *
 * Three things this is careful about, all of them §2's honesty and none of them
 * cosmetic:
 *
 * 1. **File-level.** These are the commits that touched the *file* a change's
 *    subject lives in. Every line printed here says so, because the one thing a
 *    reader must never take away is "commit X changed this function".
 * 2. **The range, not the whole history.** `historyRows({ shas })` narrows the
 *    file rows to the commits between the two syncs, so attribution answers "in
 *    this range" — the question the diff asked. The commit list stays whole: it
 *    is what says which repositories have a history at all, and which of the
 *    attributing commits no sync ever ingested.
 * 3. **The monorepo prefix (§8).** `commit_file.path` is repository-root-
 *    relative, `loc.path` source-root-relative. `git rev-parse --show-prefix`
 *    at the checkout is the join; when it cannot be read the header says the
 *    paths were joined without one, because the silent failure mode is an empty
 *    commit list that reads as "nothing touched this file". The checkout comes
 *    from the graph on disk or the workspace source — never from the snapshots,
 *    which carry no `roots` by design.
 */
function attributeDiff(diff: GraphDiff, db: SnapshotDb, live: GraphStore | undefined, base: number, head: number): GraphDiff {
  const named = flag('repo');
  // `live` is the graph on disk, not a snapshot read: `roots` are per-machine
  // checkout paths and are deliberately not persisted in history (snapshots.ts:272)
  const { diff: attributed, header, notes } = attributeDiffOver(diff, db, {
    base,
    head,
    ...(named ? { repos: [named] } : {}),
    checkout: (repo) => {
      const source = workspaceSource(repo);
      const root = live?.roots[repo] ?? (source ? resolve(source.path) : undefined);
      if (!root || !existsSync(root)) return { kind: 'missing', ...(root ? { root } : {}) };
      const p = gitPrefix(root);
      return p.available ? { kind: 'prefix', prefix: p.prefix } : { kind: 'unreadable', root, reason: GIT_ABSENT_WORD[p.reason] };
    },
  });

  // stderr: whatever --format renders, stdout stays the contract document
  console.error(header);
  for (const n of notes) console.error(`  ${n.level === 'warn' ? '⚠ ' : ''}${n.text}`);
  return attributed;
}

switch (command) {
  case 'status': {
    // which build is installed (this CLI), which is running on the port, which wrote the graph — and what to do about it
    const port = Number(flag('port', '4477'));
    const running = buildInfo();
    let server: { port: number; reachable: boolean; farsight?: typeof running; install?: ReturnType<typeof installState> } = { port, reachable: false };
    let graphMeta: { farsight?: typeof running; generatedAt?: string; sync?: number; workspace?: string; graphPath?: string } | undefined;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const v = await r.json() as { farsight?: typeof running; install?: ReturnType<typeof installState>; graph?: typeof graphMeta };
        server = { port, reachable: true, farsight: v.farsight, install: v.install };
        graphMeta = v.graph;
      }
    } catch { /* nothing listening, or an older server without /api/version: reported below */ }
    const graphFile = resolve(flag('graph', positional[0]) ?? 'graph.json');
    if (!graphMeta && existsSync(graphFile)) {
      const m = GraphStore.load(graphFile).meta;
      graphMeta = { farsight: m.farsight, generatedAt: m.generatedAt, sync: m.sync, workspace: m.workspace, graphPath: graphFile };
    }
    const bl = (b?: { version: string; built: string; commit?: string }) => b ? `${b.version} · built ${b.built}${b.commit ? ` · commit ${b.commit}` : ''}` : 'unknown';
    console.log(`installed: ${buildLine()}`);
    console.log(server.reachable
      ? `server:    port ${port} · ${bl(server.farsight)}${server.install ? ` · started ${server.install.startedAt}${server.install.newerInstalled ? ' · NEWER BUILD ON DISK' : ''}` : ''}`
      : `server:    nothing answered on port ${port}`);
    console.log(graphMeta
      ? `graph:     ${graphMeta.graphPath ?? graphFile}${graphMeta.workspace ? ` · workspace "${graphMeta.workspace}"` : ''} · written by ${bl(graphMeta.farsight)} · generated ${graphMeta.generatedAt ?? 'unknown'}${graphMeta.sync != null ? ` · sync:${graphMeta.sync}` : ''}`
      : `graph:     none at ${graphFile}`);
    const a = currencyAdvice({ role: 'cli', running, install: installState(), ...(graphMeta ? { graph: graphMeta } : {}), server });
    console.log('');
    console.log(a.ok ? 'up to date: the installed build, the server and the graph agree.' : `${a.findings.length} thing(s) to do:`);
    for (const f of a.findings) console.log(`  ⚠ ${f}`);
    console.log('');
    a.steps.forEach((st, i) => console.log(`  ${i + 1}. ${st}`));
    process.exit(a.ok ? 0 : 1);
  }
  case 'ingest': {
    const dirs = positional.length ? positional : ['.'];
    const out = resolve(flag('out', 'graph.json')!);
    const started = performance.now();
    const store = new GraphStore();
    const sources: SourceStat[] = [];
    for (const dir of dirs) {
      // a spec / a screens manifest as a source of its own: a file that parses as one, or a URL
      if (isSpecUrl(dir) || (/\.(ya?ml|json)$/i.test(dir) && existsSync(resolve(dir)) && !statIsDir(resolve(dir)))) {
        const isDesign = /\.json$/i.test(dir) && !isSpecUrl(dir) && (() => { try { return isDesignManifest(JSON.parse(readFileSync(resolve(dir), 'utf8'))); } catch { return false; } })();
        const fragment = isDesign
          ? await ingestDesign(dir, { repoName: dirs.length === 1 ? flag('repo') : undefined })
          : await ingestSpec(dir, { repoName: dirs.length === 1 ? flag('repo') : undefined });
        store.addFragment(fragment);
        const what = isDesign ? 'design' : 'spec';
        sources.push({ name: fragment.repo, files: 1, status: `ok: ${fragment.nodes.length} nodes, ${fragment.edges.length} edges (${what})` });
        console.log(`  + ${fragment.repo}: ${fragment.nodes.length} nodes, ${fragment.edges.length} edges (${what}: ${dir})`);
        continue;
      }
      const repoPath = resolve(dir);
      if (!existsSync(repoPath)) fail(`no such directory: ${dir}`);
      const fragment = await ingestRepo(repoPath, {
        repoName: dirs.length === 1 ? flag('repo') : undefined,
        exclude: flag('exclude')?.split(',').map((s) => s.trim()).filter(Boolean),
      });
      store.roots[fragment.repo] = repoPath;
      store.addFragment(fragment);
      sources.push({
        name: fragment.repo,
        commit: gitHead(repoPath),
        files: fragment.meta?.files,
        status: `ok: ${fragment.nodes.length} nodes, ${fragment.edges.length} edges`,
      });
      console.log(`  + ${fragment.repo}: ${fragment.nodes.length} nodes, ${fragment.edges.length} edges${fragment.configApplied ? ' (config applied)' : ''}`);
      for (const err of fragment.specErrors ?? []) console.error(`    ⚠ ${err}`);
    }
    // cross-source HTTP stitching: unresolved fetch stubs → routes any source declares
    const stitched = stitchHttp(store);
    if (stitched.resolved || stitched.ambiguous) console.log(`  stitched ${stitched.resolved} HTTP call(s) across sources${stitched.ambiguous ? `, ${stitched.ambiguous} ambiguous` : ''}`);
    store.meta.workspace = basename(process.cwd());
    // record the snapshot BEFORE save so graph.json carries sync/digest/commit/tz
    try {
      const db = new SnapshotDb(dbPath());
      // work items (work-items-sync.md §9), as POST /api/sync does but offline and only when the
      // workspace names a work source: each checkout's commit spine with the keys its commits name,
      // then the work cache's items joined into the graph — no tracker is called here (`farsight
      // work sync` does that). Without a work source, ingest still walks no log (§8).
      const workSources = workSourcesOf(process.cwd(), settingsSources());
      if (workSources.length) {
        const keys = keyOptionsOf(workSources);
        for (const [name, dir] of Object.entries(store.roots)) {
          const said = writeSpine(db, store, { name, dir }, keys);
          if (said) console.log(`    ${name}: ${said}`);
        }
        const w = await syncWork(process.cwd(), workSources, store, db, { pull: false });
        console.log(`  work items from the cache: ${w.nodes} node${w.nodes === 1 ? '' : 's'}, ${w.edges} tracks edge${w.edges === 1 ? '' : 's'}${w.unmatched.length ? `, ${w.unmatched.length} declared key${w.unmatched.length === 1 ? '' : 's'} unmatched` : ''}`);
      }
      const ref = db.write(store, { commit: gitHead(process.cwd()) ?? sources[0]?.commit, sources });
      console.log(`  snapshot sync:${ref.sync} · digest ${ref.digest} → ${dbPath()}`);
    } catch (err) {
      if (!(err instanceof SnapshotUnavailable)) throw err;
      console.error(`  ${err.message}`);
    }
    store.save(out);
    const stats = store.stats();
    const ms = Math.round(performance.now() - started);
    console.log(`ingested ${dirs.length} repo${dirs.length > 1 ? 's' : ''} in ${ms}ms → ${out}`);
    console.log(`  ${stats.nodes} nodes, ${stats.edges} edges`);
    console.log('  ' + Object.entries(stats.byKind).map(([k, v]) => `${k}:${v}`).join('  '));
    break;
  }
  case 'serve': {
    const asOf = flag('as-of');
    const graph = asOf ? materializeAsOf(asOf) : resolve(positional[0] ?? 'graph.json');
    if (!existsSync(graph)) fail(`no graph at ${graph} — run \`farsight ingest\` first`);
    // an --as-of snapshot is history: it is served read-only, and --read-only asks for the same on today's graph
    const readOnly = asOf ? 'as-of' as const : hasFlag('read-only') ? 'flag' as const : null;
    serveGraph(graph, Number(flag('port', '4477')), process.cwd(), { readOnly });
    break;
  }
  case 'mcp': {
    const asOf = flag('as-of');
    await runMcpServer(asOf ? materializeAsOf(asOf) : flag('graph', positional[0]));
    break;
  }
  case 'snapshots': {
    const db = openDb();
    const pin = flag('pin');
    if (pin) {
      const ref = parseSyncRef(pin, 'pin');
      if (ref === 'latest') fail('--pin expects sync:<N>');
      db.pin(ref);
      console.log(`pinned sync:${ref} — retention keeps it`);
    }
    const prune = flag('prune');
    if (prune) {
      const keep = Number(prune);
      if (!Number.isInteger(keep) || keep < 1) fail(`--prune expects how many snapshots to keep (got "${prune}")`);
      const pruned = db.prune({ keep, keepPinned: true });
      console.log(`pruned ${pruned} snapshot${pruned === 1 ? '' : 's'} (kept newest ${keep} + pinned)`);
    }
    const rows = db.list(Number(flag('limit', '20')));
    if (!rows.length) {
      console.log(`no snapshots yet in ${dbPath()} — run \`farsight ingest\``);
      break;
    }
    console.log('  SYNC  WHEN                      TZ                 COMMIT   DIGEST        NODES  EDGES');
    for (const s of rows) {
      const pinMark = s.pinned ? ' *' : '  ';
      console.log(
        `${pinMark}${String(s.sync).padStart(4)}  ${s.at}  ${s.tz.padEnd(17)}  ${(s.commit?.slice(0, 7) ?? '-').padEnd(7)}  ${s.digest}  ${String(s.nodes).padStart(5)}  ${String(s.edges).padStart(5)}`,
      );
    }
    break;
  }
  case 'history': {
    // git as a lens on the snapshot spine (docs/proposals/change-history-2026-09.md).
    // Reads git, writes the three commit tables, and touches no node or edge row.
    // Its own command by design (§8) for the full read. Since the work-items pass
    // `POST /api/sync` (always) and `ingest` (when a work source is configured) also walk a
    // log, bounded to 500 commits and incremental (server work.ts writeSpine).
    const graphFile = resolve(flag('graph', 'graph.json')!);
    const store = existsSync(graphFile) ? GraphStore.load(graphFile) : undefined;
    const asJson = rest.includes('--json');
    const wantTags = rest.includes('--releases');
    const since = flag('since');
    const maxFlag = flag('max');
    const max = maxFlag === undefined ? DEFAULT_MAX_COMMITS : Number(maxFlag);
    if (!Number.isInteger(max) || max < 1) fail(`--max expects how many commits to walk (got "${maxFlag}")`);

    const named = flag('repo');
    const repos = named
      ? [named]
      : [...new Set([...Object.keys(store?.roots ?? {}), ...workspaceRepos()])].sort();
    if (!repos.length) {
      fail(`farsight history needs --repo <source name>: there is no graph at ${graphFile} and .farsight/settings.json declares no local source`);
    }

    const db = openDb();
    const docs: Record<string, unknown>[] = [];
    for (const repo of repos) {
      // a path positional only makes sense for a single named repo (as `digest` takes one)
      const { root } = repoCheckout(store, repo, named ? positional[0] : undefined);
      const head = gitHeadRef(root);
      const shallow = gitShallow(root);
      // with work sources configured, the read also records the keys each commit names and the
      // key-bearing branches that carry it (work-items-sync.md §9); nodes resolve against the graph
      const keys = keyOptionsOf(workSourcesOf(process.cwd(), settingsSources()));
      const detect = keyDetector(keys.orgs);
      const wantKeys = (keys.projects?.length ?? 0) > 0 || !!keys.ado;
      const log = gitLog(root, { ...(since ? { since } : {}), max, ...(wantKeys ? { keyRefs: (n: string) => detect(n, 'branch', keys).length > 0 } : {}) });
      const written = log.available
        ? db.writeCommits(repo, wantKeys ? commitInputsOf(log.commits, { opts: keys, detect }) : commitInputs(log.commits))
        : undefined;
      if (written && wantKeys && store) resolveCommitNodes(db, store, { name: repo, dir: root });
      // the spine is folded over what the *database* knows, which a bounded read
      // (`--max`, `--since`) may not have refreshed in full — `truncated` says so
      const spine = db.commitSpine(repo);
      const tags = wantTags ? gitTags(root) : undefined;
      const declared = declaredReleases(repo);

      docs.push({
        repo,
        root,
        git: log.available
          ? { available: true, read: log.commits.length, truncated: log.truncated, max: log.max, ...(since ? { since } : {}) }
          : { available: false, reason: log.reason, ...(log.detail ? { detail: log.detail } : {}) },
        head: head.available ? { sha: head.sha, ...(head.ref ? { ref: head.ref } : {}), detached: head.detached } : null,
        // null, never false: a shallow check that could not run has not said "not shallow"
        shallow: shallow.available ? shallow.shallow : null,
        written: written ?? null,
        commits: spine.commits,
        unindexed: spine.unindexed,
        syncs: spine.rows.length,
        distinct: spine.distinct,
        reindexed: spine.reindexed,
        // syncs that recorded no commit *for this source* — an absence with a count,
        // never a zero standing in for "this repository had no commits then"
        withoutCommit: spine.withoutCommit,
        // of those, how many did not include this source at all (H5's third row state)
        notInSync: spine.notInSync,
        // has any commit been read for this repository? Without one, nothing about
        // containment is sayable and every count here is a floor, not a measurement
        historyRead: spine.historyRead,
        bound: spine.bound,
        withoutHistory: spine.withoutHistory,
        unverified: spine.unverified,
        before: spine.before.length,
        after: spine.after.length,
        spine: spine.rows.map((r) => ({
          sync: r.sync,
          at: r.at,
          ...(r.commit ? { commit: r.commit } : {}),
          // 'source' = this source's own recorded sha; 'workspace' = the workspace root's,
          // folded only because this repository's history contains it; absent = no commit
          ...(r.commitFrom ? { commitFrom: r.commitFrom } : {}),
          // true/false = this sync did / did not walk this source; absent = the sync
          // recorded no source rows at all, so the question has no answer here
          ...(r.inSync === undefined ? {} : { inSync: r.inSync }),
          // the workspace root's sha, neither folded as this repository's nor ruled
          // out, because no history has been read to check it against
          ...(r.commitUnverified ? { commitUnverified: r.commitUnverified } : {}),
          // one word for what is known: recorded · not-in-history · below-floor ·
          // history-unread · none · not-in-sync
          commitState: r.commitState,
          // true / false / null — null is "the question could not be asked"
          commitKnown: r.commitKnown,
          reindexed: r.reindexed,
          // null, not 0: a sync whose commit is absent from the history swept an
          // unknown number of commits — "0" would be a number the data does not carry
          swept: r.commitKnown === true ? r.commits.length : null,
          unindexed: r.commitKnown === true ? r.unindexed : null,
          commits: r.commits.map((c) => c.sha),
        })),
        releases: declared,
        ...(tags
          ? {
              tags: tags.available
                ? {
                    found: tags.tags.length,
                    schemes: tags.tags.reduce<Record<string, number>>((acc, t) => {
                      acc[t.scheme] = (acc[t.scheme] ?? 0) + 1;
                      return acc;
                    }, {}),
                    // proposed, never applied: §3 makes a release a declaration
                    proposed: tags.tags.map((t) => ({
                      name: t.name,
                      sha: t.sha,
                      ...(t.at ? { at: new Date(t.at * 1000).toISOString() } : {}),
                      annotated: t.annotated,
                      scheme: t.scheme,
                    })),
                  }
                : { available: false, reason: tags.reason, ...(tags.detail ? { detail: tags.detail } : {}) },
            }
          : {}),
      });

      if (asJson) continue;

      // ── the text spine ───────────────────────────────────────────────────
      const title = headTitle(head);
      console.log(`${repo} · ${root}${title ? ` · ${title}` : ''}`);
      if (!log.available) {
        console.log(`  ${GIT_ABSENT_WORD[log.reason]}${log.detail ? ` — git said: ${log.detail}` : ''}`);
        console.log('  the snapshot spine below is unchanged; every commit it cannot name reads "not indexed"');
      } else {
        console.log(`  read ${num(log.commits.length)} commit${log.commits.length === 1 ? '' : 's'}${since ? ` since ${since}` : ''} · ${num(written!.files)} file changes · ${num(spine.commits)} in the history for this source`);
      }
      // every sentence about the spine comes from one fold, shared with /api/history
      // (core `spineSentences`), so the command and the endpoint cannot word the
      // same fact differently. The unindexed count is printed first: a history
      // containing commits no sync ingested says so before any row is drawn, or a
      // row is read as a complete account of what happened.
      const said = spineSentences(spine);
      const say = (x?: { level: 'note' | 'warn'; text: string }) => { if (x) console.log(`  ${x.level === 'warn' ? '⚠ ' : ''}${x.text}`); };
      say(said.historyUnread);
      say(said.unindexed);
      if (log.available && log.truncated) {
        console.log(`  ⚠ --max ${num(log.max)} bounded the walk — older commits exist in the repository and were not read, so the ancestry below is partial`);
      }
      if (shallow.available && shallow.shallow) {
        const oldest = log.available ? log.commits[log.commits.length - 1]?.sha : undefined;
        console.log(`  ⚠ ${shallowFloorSentence(oldest)}`);
      }
      // A sync records this repository's commit when the ingest that wrote it stamped one for
      // this source; the workspace root's sha counts only when this repository's own history
      // contains it (a sha names one commit globally). Rows written before per-source stamping
      // therefore read *no commit recorded for this repository* — an absence, never another
      // repository's sha.
      say(said.syncs);
      say(said.noneRecorded);
      say(said.unanchored);
      say(said.outsideReach);
      say(said.belowFloor);
      say(said.noSnapshots);
      if (spine.rows.length) {
        say(said.borrowed);
        console.log('    SYNC  WHEN                      COMMIT   SWEPT  NOT INDEXED  NOTE');
        for (const r of spine.rows) {
          // one fold, shared with /api/history: re-indexed · not in this sync ·
          // no commit recorded · a commit this history does not contain · the subject.
          // A row only carries a sha this source stamped, or one the workspace
          // stamped that this repository's own history contains — never another source's.
          const rowNote = spineRowNote(r);
          const note = rowNote.kind === 'subject' ? rowNote.text.slice(0, 52) : rowNote.text;
          // strictly `true`: a null commitKnown is "unaskable", which earns an em dash
          // for the same reason a false one does — no number is available
          const swept = r.commitKnown === true ? String(r.commits.length) : '—';
          const notIndexed = r.commitKnown === true ? String(r.unindexed) : '—';
          console.log(
            `  ${String(r.sync).padStart(6)}  ${r.at.padEnd(24)}  ${(r.commit?.slice(0, 7) ?? '-').padEnd(7)}  ${swept.padStart(5)}  ${notIndexed.padStart(11)}  ${note}`,
          );
        }
      }
      if (tags) {
        console.log('');
        console.log(
          declared.length
            ? `  ${num(declared.length)} release${declared.length === 1 ? '' : 's'} declared in .farsight/settings.json: ${declared.map((d) => d.name).join(', ')}`
            : '  no releases declared in .farsight/settings.json — Changes groups by sync until one is',
        );
        if (!tags.available) {
          console.log(`  tags: ${GIT_ABSENT_WORD[tags.reason]}${tags.detail ? ` — git said: ${tags.detail}` : ''}`);
        } else if (!tags.tags.length) {
          console.log('  no tags in this repository — nothing to propose; a release is declared, so a repository without tags is not a repository without releases');
        } else {
          const schemes = new Map<string, number>();
          for (const t of tags.tags) schemes.set(t.scheme, (schemes.get(t.scheme) ?? 0) + 1);
          const spelling = [...schemes].map(([s, n]) => `${s} ${n}`).join(' · ');
          console.log(`  ${num(tags.tags.length)} tag${tags.tags.length === 1 ? '' : 's'} found in ${schemes.size} naming scheme${schemes.size === 1 ? '' : 's'} (${spelling}) — proposed, not releases:`);
          console.log('    a release is declared, never discovered. Accept one by adding it to .farsight/settings.json:');
          console.log(`    "releases": [{ "name": "${tags.tags[0]!.name}", "tag": "${tags.tags[0]!.name}", "repo": "${repo}" }]`);
          for (const t of tags.tags.slice(0, 50)) {
            const when = t.at ? new Date(t.at * 1000).toISOString().slice(0, 10) : 'unknown date';
            console.log(`    ${t.name.padEnd(18)}  ${t.sha.slice(0, 7)}  ${when}  ${(t.annotated ? 'annotated' : 'lightweight').padEnd(11)}  ${t.scheme}`);
          }
          if (tags.tags.length > 50) console.log(`    +${num(tags.tags.length - 50)} more`);
        }
      }
      console.log('');
    }
    db.close();
    if (asJson) {
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), max, ...(since ? { since } : {}), repos: docs }, null, 2));
    }
    break;
  }
  case 'diff': {
    const { base, head, db } = loadDiffEnds();
    const diff = diffGraphs(base.store, head.store, {
      changes: db.changedBetween(base.ref.sync, head.ref.sync),
      ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
    });
    // --attribute adds the optional field the frozen contract permits; without it this
    // document is byte for byte what the command has emitted since July (§2, H4)
    const graphFile = resolve(flag('graph', 'graph.json')!);
    const attributed = rest.includes('--attribute')
      // the graph on disk, for its `roots`: the two snapshots carry none (snapshots.ts:272)
      ? attributeDiff(diff, db, existsSync(graphFile) ? GraphStore.load(graphFile) : undefined, base.ref.sync, head.ref.sync)
      : diff;
    console.log(renderDiff(attributed, flag('format', 'json')!));
    break;
  }
  case 'gate': {
    const policyPath = resolve(flag('policy', 'compliance.yml')!);
    if (!existsSync(policyPath)) fail(`no policy file at ${policyPath} — \`farsight gate --policy compliance.yml\``);
    const policy = parsePolicy(readFileSync(policyPath, 'utf8'), policyPath);
    const { base, head, db } = loadDiffEnds();
    // the gate judges every change: no truncation of the change list here
    const diff = applyPolicy(
      diffGraphs(base.store, head.store, {
        changes: db.changedBetween(base.ref.sync, head.ref.sync),
        limit: Number.MAX_SAFE_INTEGER,
      }),
      policy,
    );
    const gate = diff.gate!;
    if (flag('format') === 'json') {
      console.log(JSON.stringify(diff, null, 2));
    } else {
      console.log(`gate ${gate.result.toUpperCase()} — ${diff.base} → ${diff.head} (${gate.policy})`);
      for (const r of gate.rules) {
        const mark = r.result === 'fail' ? '✗' : r.result === 'warn' ? '⚠' : '✓';
        console.log(`  ${mark} ${r.rule}: ${r.result}${r.changes.length ? ` — ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}` : ''}`);
        for (const id of r.changes) {
          const change = diff.changes.find((c) => c.id === id)!;
          console.log(`      ${id}: ${changeSentence(change)}${change.loc ? ` (${change.loc.path}:${change.loc.line})` : ''}`);
        }
      }
    }
    process.exit(gate.exit);
  }
  case 'api': {
    const sub = positional[0];
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const { nodes, edges } = store.toJSON();
    const index = buildIndex(nodes, edges);
    setFreshnessMeta(index, store.meta);
    if (sub === 'list' || !sub) {
      const apis = apiSurface(index);
      if (!apis.length) { console.log('no HTTP routes in the graph — nothing to list'); break; }
      console.log('  API                                       REPO             OPS  DECL  IMPL  NOT-IMPL  UNDOC  CONSUMERS  DRIFT  SOURCE');
      for (const a of apis) {
        const c = a.counts;
        console.log(`  ${a.name.slice(0, 40).padEnd(40)}  ${a.repo.slice(0, 15).padEnd(15)}  ${String(c.operations).padStart(3)}  ${String(c.declared).padStart(4)}  ${String(c.implemented).padStart(4)}  ${String(c.notImplemented).padStart(8)}  ${String(c.undocumented).padStart(5)}  ${String(c.consumers).padStart(9)}  ${String(c.drift).padStart(5)}  ${a.kind === 'spec' ? a.specPath : '(implied from code — no spec on file)'}${a.specSource ? '  [spec-only source]' : ''}`);
      }
      console.log('\n  ops = routes on this surface · decl = named in the spec · impl = with source · not-impl = in the spec, not the code (not a gap for a spec-only source) · undoc = in the code, not the spec');
      break;
    }
    if (sub === 'spec') {
      const repo = flag('repo');
      if (!repo) fail('api spec needs --repo <source name> (see `farsight api list`)');
      const doc = graphToSpec(index, { repo, meta: store.meta, ...(flag('title') ? { title: flag('title') } : {}) });
      if (!Object.keys(doc.paths ?? {}).length) fail(`no implemented routes for repo "${repo}"`);
      const format = flag('format', flag('out')?.endsWith('.json') ? 'json' : 'yaml');
      const text = format === 'json' ? JSON.stringify(doc, null, 2) + '\n' : specToYaml(doc);
      const out = flag('out');
      if (out) { writeFileSync(resolve(out), text); console.error(`wrote ${Object.keys(doc.paths!).length} path(s) → ${out}`); }
      else process.stdout.write(text);
      break;
    }
    if (sub === 'diff') {
      const specRef = flag('spec');
      if (!specRef) fail('api diff needs --spec <path|url>');
      const parsed = await readSpecSource(specRef);
      const repo = flag('repo');
      const result = reconcile(parsed.doc, index, { repo: repo ?? 'proposed', path: specRef, lineOf: parsed.lineOf }, repo ? { repo } : {});
      if (flag('format', 'md') === 'json') console.log(JSON.stringify(result, null, 2));
      else console.log(driftMarkdown(result));
      if (rest.includes('--strict') && result.counts.drift > 0) process.exit(1);
      break;
    }
    fail(`unknown api subcommand: ${sub} (list | spec | diff)`);
  }
  case 'deps': {
    // packages as nodes (docs/proposals/dependencies-and-nx.md §2.1, §2.3): the same folds
    // GET /api/deps and describe_node print. --json is `farsight-deps v0` — said in the
    // document, because nothing pins it yet and a consumer must not treat it as frozen.
    const sub = positional[0] ?? 'list';
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const { nodes, edges } = store.toJSON();
    const index = buildIndex(nodes, edges);
    setFreshnessMeta(index, store.meta);
    const repo = flag('repo');
    const hopsArg = flag('hops');
    const hops = hopsArg != null ? Number(hopsArg) : undefined;
    if (hops != null && !(Number.isInteger(hops) && hops >= 1 && hops <= IMPACT_MAX_HOPS)) fail(`--hops must be a whole number from 1 to ${IMPACT_MAX_HOPS}`);
    const json = rest.includes('--json');
    const header = { format: 'farsight-deps', version: 0, frozen: false, note: 'not a frozen contract yet: fields may change' };
    if (!nodes.some((n) => n.kind === 'package')) {
      const msg = 'no package nodes in this graph — it was written before imports were read as packages, or the code imports none; re-ingest to see them';
      if (json) { console.log(JSON.stringify({ ...header, rows: [], note: msg }, null, 2)); break; }
      console.log(msg);
      break;
    }
    if (sub === 'list') {
      const scope = rest.includes('--third-party') ? 'third-party' as const : rest.includes('--workspace') ? 'workspace' as const : undefined;
      const list = packagesOf(index, { ...(repo ? { repo } : {}), ...(flag('project') ? { project: flag('project') } : {}), ...(scope ? { scope } : {}), ...(hops != null ? { hops } : {}) });
      if (json) { console.log(JSON.stringify({ ...header, ...list, meta: store.meta.packages ?? {} }, null, 2)); break; }
      if (!list.rows.length) { console.log('no package matches those filters'); break; }
      console.log(`${countedText(list.packages)} (${breakdownText(list.packages)})\n`);
      console.log('  PACKAGE                                  SOURCE           SCOPE        RANGE          FILES  JOURNEYS');
      for (const r of list.rows) {
        const range = r.version ?? (r.scope === 'workspace' ? '(alias)' : '(undeclared)');
        console.log(`  ${r.name.slice(0, 40).padEnd(40)} ${r.repo.slice(0, 15).padEnd(15)}  ${r.scope.padEnd(11)}  ${(range + (r.dev ? ' dev' : '')).slice(0, 13).padEnd(13)}  ${String(r.importers.n).padStart(5)}  ${String(r.journeys.n).padStart(8)}`);
        if (new Set(r.versions.map((v) => v.range)).size > 1) console.log(`      ranges: ${r.versions.map((v) => `${v.where} ${v.range}`).join(' · ')}`);
        if (r.note) console.log(`      ⚠ ${r.note}`);
      }
      const builtins = Object.entries(store.meta.packages ?? {}).filter(([rp]) => !repo || rp === repo)
        .flatMap(([rp, m]) => (m.builtins ?? []).map((b) => `${b.spec}${Object.keys(store.meta.packages ?? {}).length > 1 ? ` (${rp})` : ''}`));
      console.log(`\n  files = source files that import it (test and story files are not read) · journeys = journeys whose path passes through code that uses it, within ${hops ?? 2} uses — a floor`);
      if (builtins.length) console.log(`  the runtime's own modules, never counted as packages: ${builtins.join(', ')}`);
      break;
    }
    if (sub === 'where') {
      const ref = positional[1];
      if (!ref) fail('deps where needs a package name or id (see `farsight deps list`)');
      const found = resolvePackage(index, ref, repo);
      if (!found.hit) fail(found.candidates.length ? `${found.candidates.length} sources import a package named ${ref} — pass its id or --repo: ${found.candidates.join(', ')}` : `no package ${ref} in this graph (see \`farsight deps list\`)`);
      const where = importersOf(index, found.hit.id, hops != null ? { hops } : {})!;
      if (json) { console.log(JSON.stringify({ ...header, ...where }, null, 2)); break; }
      const r = where.package;
      console.log(`${r.name} · ${r.scope}${r.version ? ` · ${r.version}` : ''}${r.project ? ` · project ${r.project}` : ''} · ${r.repo}`);
      console.log(`${countedText(where.importers)} · ${countedText(r.journeys, { scope: false })}${r.journeyRefs.length ? ` — ${r.journeyRefs.map((j) => j.name).join(', ')}` : ''}`);
      for (const v of r.versions) console.log(`  declared ${v.range} in ${v.declaredIn} (${v.field}${v.where ? ` · ${v.where}` : ''})`);
      if (r.note) console.log(`  ⚠ ${r.note}`);
      for (const g of where.groups) {
        console.log(`\n  ${g.by === 'project' ? 'project' : 'source'} ${g.key} — ${countedText(g.count, { scope: false })}`);
        for (const i of g.importers) {
          console.log(`    ${i.path}:${i.line}  ${i.specifier}${i.typeOnly ? '  (type only)' : ''}${i.form && i.form !== 'import' ? `  (${i.form})` : ''}`);
          for (const u of i.users) console.log(`      used by ${u.name} (${u.kind})${u.line != null ? ` at line ${u.line}` : ''}`);
        }
      }
      break;
    }
    fail(`unknown deps subcommand: ${sub} (list | where)`);
  }
  case 'config': {
    // every farsight.config.json per source, as ingest recorded them on meta.config — the same
    // fold the MCP config_files tool and graph_overview print (core config-files.ts)
    const sub = positional[0] ?? 'list';
    if (sub !== 'list') fail(`unknown config subcommand: ${sub} (list)`);
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const repo = flag('repo');
    const metas = store.meta.config ?? {};
    if (rest.includes('--json')) {
      console.log(JSON.stringify(Object.fromEntries(Object.entries(metas).filter(([r]) => !repo || r === repo)), null, 2));
      break;
    }
    console.log(configFilesText(metas, repo).join('\n'));
    break;
  }
  case 'digest': {
    // the content digest of a checkout, computed exactly the way ingest computes it
    // (same adapters, same file set, same workspace excludes) — the number a test
    // report must record for "unchanged since the run" to be provable (03 §2.6).
    const graphFile = resolve(flag('graph', 'graph.json')!);
    const store = existsSync(graphFile) ? GraphStore.load(graphFile) : undefined;
    const pathArg = positional[0];
    const repo = flag('repo') ?? (pathArg ? basename(resolve(pathArg)) : undefined);
    if (!repo) fail('farsight digest needs --repo <source name> (or a path to a checkout)');
    const { root, exclude } = repoCheckout(store, repo, pathArg);
    const digest = repoContentDigest(root, exclude ? { exclude } : {});
    // the file count ingest recorded for this repo — the digest itself is re-walked now,
    // so the two disagree exactly when files have been added or removed since that ingest
    const files = store?.repoMeta(repo)?.files;
    if (rest.includes('--json')) {
      console.log(JSON.stringify({ repo, root, sourceDigest: digest, files: files ?? null, exclude: exclude ?? [] }, null, 2));
    } else {
      // the digest alone on stdout, so `--stamp "$(farsight digest --repo r)"` works
      console.error(`${repo} · ${root}${exclude ? ` · excludes ${exclude.join(', ')}` : ''}${files != null ? ` · ${files} files at last ingest` : ''}`);
      console.log(digest);
    }
    break;
  }
  case 'impact': {
    // What uses this, by distance — one fold over the graph, answered per hop and
    // never summed (docs/proposals/dependency-impact.md §4.2). The text form is a
    // reader's table; `--format json` is the machine's: the bare `ImpactReport`,
    // or `farsight-impact-tests v1` when `--tests` asks which tests to run.
    //
    // Reachability is not consequence: every row names the edge's own verb, and
    // nothing here promotes it to "breaks".
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const { nodes, edges } = store.toJSON();
    const index = buildIndex(nodes, edges);
    setFreshnessMeta(index, store.meta);

    // `--changed a.ts b.ts` takes every following token, so the generic positional
    // reader (which only skips one value per flag) cannot be used here
    const changed: string[] = [];
    const free: string[] = [];
    const VALUED = new Set(['hops', 'direction', 'graph', 'format', 'cap', 'repo']);
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (!tok.startsWith('--')) { free.push(tok); continue; }
      const name = tok.slice(2);
      if (name === 'changed') { while (i + 1 < rest.length && !rest[i + 1]!.startsWith('--')) changed.push(rest[++i]!); continue; }
      if (VALUED.has(name)) i++;
    }

    const hops = Number(flag('hops', '2'));
    if (!Number.isInteger(hops) || hops < 1 || hops > IMPACT_MAX_HOPS) {
      fail(`--hops takes a whole number from 1 to ${IMPACT_MAX_HOPS} (got "${flag('hops', '2')}") — past ${IMPACT_MAX_HOPS} hops, "reaches it through others" describes the application rather than a dependency`);
    }
    const direction = flag('direction', 'upstream')!;
    if (direction !== 'upstream' && direction !== 'downstream') fail(`--direction takes upstream or downstream (got "${direction}")`);
    const wantTests = rest.includes('--tests');
    const format = rest.includes('--json') ? 'json' : flag('format', 'text')!;
    if (format !== 'text' && format !== 'json') fail(`--format takes text or json (got "${format}")`);
    const capArg = flag('cap');
    const opts = {
      hops, direction,
      ...(capArg ? { perHopCap: Number(capArg) } : {}),
      ...(rest.includes('--include-setup') ? { includeSetup: true } : {}),
      ...(rest.includes('--include-deferred') ? { includeDeferred: true } : {}),
      ...(rest.includes('--expand-shared') ? { expandShared: true } : {}),
      ...(wantTests ? { tests: true } : {}),
      // one journey walk per flow (~60-81 ms on ten flows): never on unless asked for
      ...(rest.includes('--flows') ? { flows: true } : {}),
    } as const;

    // ── the seeds ─────────────────────────────────────────────────────────
    // `--changed` resolves file hunks to nodes by `loc`, at file-and-line
    // granularity: a node whose definition *starts* inside the range. The graph
    // records no end line, so this is a floor and the printer says so.
    type Seed = { node: GraphNode; from: 'node' | 'hunk'; hunk?: string };
    const seeds: Seed[] = [];
    const unmatched: string[] = [];
    if (changed.length) {
      // one rule, in core, so the MCP's `impact_of changed:` resolves a diff to the same seeds
      const hunks = nodesInHunks(nodes, changed);
      unmatched.push(...hunks.unmatched);
      for (const h of hunks.seeds) seeds.push({ node: h.node, from: 'hunk', hunk: h.hunk });
    } else {
      const query = free[0];
      if (!query) fail('farsight impact needs a node id or name (or --changed <path…>)');
      const direct = index.byId.get(query);
      const found = direct ? [direct] : search(index, query, { limit: 5 });
      if (!found.length) fail(`nothing in the graph matches "${query}"`);
      seeds.push({ node: found[0]!, from: 'node' });
      if (!direct && found.length > 1) {
        console.error(`"${query}" matched ${found.length} nodes; answering for ${found[0]!.id}`);
        for (const other of found.slice(1)) console.error(`  also: ${other.id}`);
      }
    }
    for (const u of unmatched) console.error(`  ⚠ nothing in the graph is defined in ${u} — it is not in the answer`);
    if (!seeds.length) fail('no node in the graph matches any of those changes — nothing to report');

    // ── the bound's fourth cause: does this graph still describe the checkout ──
    // unknown is not false: a repo with no resolvable checkout passes nothing.
    const digestMatches = (repo: string): boolean | undefined => {
      const recorded = store.repoMeta(repo)?.sourceDigest;
      if (!recorded) return undefined;
      try {
        const source = workspaceSource(repo);
        const root = store.roots[repo] ?? (source ? resolve(source.path) : undefined);
        if (!root || !existsSync(root)) return undefined;
        return repoContentDigest(root, source?.exclude?.length ? { exclude: source.exclude } : {}) === recorded;
      } catch { return undefined; }
    };
    const digestByRepo = new Map<string, boolean | undefined>();
    const asOfFor = (repo: string) => {
      if (!digestByRepo.has(repo)) digestByRepo.set(repo, digestMatches(repo));
      const dm = digestByRepo.get(repo);
      return {
        ...(store.meta.sync != null ? { sync: store.meta.sync } : {}),
        ...(store.meta.commit ? { commit: store.meta.commit } : {}),
        farsight: buildLine(),
        ...(dm === undefined ? {} : { digestMatches: dm }),
      };
    };

    const reports = seeds.map((s) => {
      const repo = s.node.loc?.repo ?? s.node.id.split('::')[0] ?? '';
      return { seed: s, report: impactOf(index, s.node.id, { ...opts, asOf: asOfFor(repo) }) };
    });

    if (format === 'json') {
      if (wantTests) {
        const identity: TestsMatrixIdentity = {
          ...(store.meta.sync != null ? { sync: store.meta.sync } : {}),
          ...(store.meta.commit ? { source_commit: store.meta.commit } : {}),
          source_digest: repoDigests(store),
          farsight: buildLine(),
          generated_at: new Date().toISOString(),
        };
        const stale = [...digestByRepo.values()].some((v) => v === false);
        console.log(JSON.stringify(impactTestsV1(
          index,
          reports.map(({ seed, report }) => ({ report, from: seed.from, ...(seed.hunk ? { hunk: seed.hunk } : {}) })),
          identity,
          stale ? { digestMatches: false } : {},
        ), null, 2));
        break;
      }
      // the bare report: one seed prints the object, several print the array
      console.log(JSON.stringify(reports.length === 1 ? reports[0]!.report : reports.map((r) => r.report), null, 2));
      break;
    }

    // ── the reader's form ─────────────────────────────────────────────────
    const EVIDENCE_WORD = { declared: 'declared', static: 'reached', observed: 'observed' } as const;
    const place = (l: ImpactNode['loc']): string => (l ? `${l.path}:${l.line}` : '(no source location)');
    /** Names clip on the right, paths on the left: a truncated `pg.ts:545` that loses its line number is worse than no column. */
    const clip = (s: string, n: number): string => (s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`);
    const clipPath = (s: string, n: number): string => (s.length <= n ? s.padEnd(n) : `…${s.slice(-(n - 1))}`);
    const byKindWords = (m: Record<string, number>): string =>
      Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${n} ${k}`).join(' · ');

    /** The edge's own provenance, then the path's silences. Never a single ladder (§10.2). */
    const howWeKnow = (n: ImpactNode): string => {
      const r = n.via.resolution;
      const head = r ? `${r.technique} ${r.confidence}` : 'not recorded';
      const rest: string[] = [];
      if (n.hop > 1 && n.strength.unstamped) rest.push(`${n.strength.unstamped} on this path record nothing`);
      if (n.oneOf) rest.push(`one of several — the code chooses ${n.oneOf.chosen} at run time and sets aside ${n.oneOf.alternatives.length}`);
      if (n.shared) rest.push('shared — listed, not opened');
      if (n.declaredOnly) rest.push('not built');
      return [head, ...rest].join(' · ');
    };

    const printImpact = (report: ImpactReport, hunk?: string): void => {
      const s = report.seed;
      console.log(`${s.name} — ${s.id}${hunk ? ` · changed in ${hunk}` : ''}`);

      // one clause per distance, never a sum: the type carries no total and neither does this
      const clauses = report.hops.map((h) => h.hop === 1
        ? `${h.found} ${report.direction === 'upstream' ? 'use it directly' : 'it uses directly'}`
        : h.hop === 2 ? `${h.found} more reach it through those`
        : `${h.found} more at ${h.hop} hops`);
      console.log(clauses.length
        ? `  ${clauses.join(' · ')} — read one at a time; they are never added together`
        : `  none indexed — nothing in this graph ${report.direction === 'upstream' ? 'uses it' : 'it uses'}`);
      console.log(report.bound === 'floor'
        ? `  ≥ a floor: ${report.uncertainty?.note ?? 'something about this answer is incomplete'}`
        : '  exact: nothing was cut, every path records how it was resolved, and the graph still matches the checkout');
      const dm = digestByRepo.get(s.repo);
      console.log(`  as of ${report.asOf.sync != null ? `sync ${report.asOf.sync}` : 'an unnumbered sync'}${report.asOf.commit ? ` · ${report.asOf.commit.slice(0, 7)}` : ''}`
        + `${dm === true ? ' · the checkout still matches this graph' : dm === false ? ' · ⚠ the checkout no longer matches this graph' : ' · whether the checkout still matches is unknown'}`);

      for (const h of report.hops) {
        const head = h.hop === 1 ? 'uses it directly' : h.hop === 2 ? 'reaches it through those' : `reaches it through ${h.hop - 1} others`;
        console.log(`\n  hop ${h.hop} — ${head} (${h.found}: ${byKindWords(h.byKind)})`);
        console.log(`    EDGE       ${'DEPENDENT'.padEnd(46)}  ${'WHERE'.padEnd(42)}  HOW WE KNOW`);
        for (const n of h.nodes) {
          console.log(`    ${n.via.kind.padEnd(9)}  ${clip(n.name, 46)}  ${clipPath(place(n.via.loc ?? n.loc), 42)}  ${howWeKnow(n)}`);
        }
        // found · listed · behind are three numbers: a capped hop says all three rather
        // than shortening the list and letting the header's count look like the answer
        if (h.found > h.nodes.length) console.log(`    … ${h.found} found here, ${h.nodes.length} listed — the ${h.found - h.nodes.length} over the cap are counted in this hop's kinds and stand under "not walked"`);
        if (opts.tests) {
          // the union over hops 1..h, each test once (core `impactTestsReaching`) — the
          // same set the MCP and the viewer print under the same words, so it can only
          // stay level or grow from one distance to the next
          const reach = impactTestsReaching(report, h.hop);
          const label = h.hop === 1 ? 'hop 1' : `hops 1–${h.hop}, each test once`;
          const per = Object.fromEntries(Object.entries(reach.byEvidence).map(([k, v]) => [EVIDENCE_WORD[k as keyof typeof EVIDENCE_WORD] ?? k, v]));
          console.log(reach.total
            ? `    tests reaching ${label}: ${reach.total} — ${byKindWords(per)}`
            : `    tests reaching ${label}: none indexed`);
        }
        if (opts.flows) {
          const flows = new Map(h.nodes.flatMap((n) => n.flows ?? []).map((f) => [f.flowId, f]));
          const actions = h.nodes.flatMap((n) => n.flows ?? []).reduce((a, f) => a + f.actions.length, 0);
          console.log(flows.size
            ? `    journeys at hop ${h.hop}: ${flows.size} — ${[...flows.values()].map((f) => f.name).join(' · ')} (${actions} action reference(s))`
            : `    journeys at hop ${h.hop}: not involved`);
        }
      }

      // ── what it did not walk. Never a sum: each count answers "behind this one". ──
      const lines: string[] = [];
      const hopCuts = report.cutPoints.filter((c) => c.reason === 'hops');
      if (hopCuts.length) {
        // one ring past the budget, counted once as a set — a second fold, not an addition
        const ring = hops < IMPACT_MAX_HOPS
          ? impactOf(index, s.id, { ...opts, hops: hops + 1, asOf: asOfFor(s.repo) }).hops[hops]?.found ?? 0
          : null;
        lines.push(ring != null
          ? `    ${`past the ${hops}-hop edge`.padEnd(20)} ${ring} more node(s) one hop further out, behind ${hopCuts.length} stop(s)`
          : `    ${`past the ${hops}-hop edge`.padEnd(20)} ${hopCuts.length} stop(s) — ${IMPACT_MAX_HOPS} hops is as far as this answer goes`);
      }
      for (const c of report.cutPoints.filter((x) => x.reason === 'shared')) {
        lines.push(`    ${'shared'.padEnd(20)} ${c.name} — used by ${c.direct}, not opened (${c.behind} node(s) behind it)`);
      }
      for (const c of report.cutPoints.filter((x) => x.reason === 'cap')) {
        lines.push(`    ${'over the cap'.padEnd(20)} ${c.behind} dependent(s) at hop ${c.hop} were found and not listed`);
      }
      for (const n of report.excluded.setup) lines.push(`    ${'start-up, once'.padEnd(20)} ${n.name} — reached only through container construction`);
      for (const n of report.excluded.deferred) lines.push(`    ${'afterwards'.padEnd(20)} ${n.name} — registered here, run later by something else`);
      if (lines.length) { console.log('\n  not walked'); for (const l of lines) console.log(l); }
      console.log('');
    };

    for (const { seed, report } of reports) printImpact(report, seed.hunk);
    break;
  }
  case 'tests': {
    // the tests catalogue, the P9 CSV artifact, and a way to attach a CI report
    // without re-ingesting (docs/proposals/tests-surface.md §3.4)
    const sub = positional[0];
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);

    if (sub === 'import') {
      const repo = flag('repo') ?? Object.keys(store.roots)[0];
      if (!repo) fail('tests import needs --repo <source name> (the graph records no roots)');
      const level = (flag('level', 'unit') ?? 'unit') as 'unit' | 'integration' | 'e2e';
      const results = flag('results');
      const coverage = flag('coverage');
      if (!results && !coverage) fail('tests import needs --results <file> and/or --coverage <file>');
      const strict = rest.includes('--strict');
      const { root, exclude } = repoCheckout(store, repo);

      // ── the stamp is decided before anything is read or written ──
      // the import is the moment of record (03 §3.6): the reporters have no hook, so
      // the digest of the tree the run saw is written here. A named digest that is not
      // this checkout's is refused — evidence must never be attached to other code.
      const stamping = rest.includes('--stamp');
      const named = (() => { const v = flag('stamp'); return v && !v.startsWith('--') ? v : undefined; })();
      let stamp: string | undefined;
      if (stamping) {
        const actual = repoContentDigest(root, exclude ? { exclude } : {});
        if (named && named !== actual && !rest.includes('--force-stamp')) {
          console.error(`--stamp ${named} is not the content digest of ${root} — that tree is ${actual}.`);
          console.error('  the reports would be stamped for a checkout this is not. Re-run the tests here, or pass --force-stamp when you know the digest is right.');
          process.exit(2);
        }
        stamp = named ?? actual;
      }

      const { nodes, edges } = store.toJSON();
      // the repo's own freshness, not the whole graph's fold: `freshnessOf` compares a
      // report's recorded digest against `meta.sourceDigest`, and a multi-repo graph's
      // folded digest is nothing any single checkout can ever equal (A2.2)
      const rm = store.repoMeta(repo);
      const fragment = {
        repo, nodes, edges,
        meta: {
          files: rm?.files ?? store.meta.files ?? 0,
          sourceHash: rm?.sourceHash ?? store.meta.sourceHash ?? '',
          ...(rm?.sourceDigest ? { sourceDigest: rm.sourceDigest } : {}),
        },
      };
      // a glob stays as written (it is matched repo-relative); a real path is made repo-relative
      const rel = (p: string) => (p.includes('*') ? p : resolve(p).startsWith(resolve(root)) ? resolve(p).slice(resolve(root).length + 1) : resolve(p));
      const config = {
        [level]: {
          ...(flag('runner') ? { runner: flag('runner') as 'vitest' } : {}),
          ...(results ? { results: rel(results) } : {}),
          ...(coverage ? { coverage: rel(coverage) } : {}),
        },
      };
      // every edge importReports adds is an observed one from a coverage report, in
      // report order — so the match quality of each report's edges can be sliced out of
      // this list by the per-report `edges` counts and printed where it was earned
      const matches: string[] = [];
      let seq: number | null = null;
      const addEdge = (from: string, to: string, meta: GraphEdge['meta'], resolution: GraphEdge['resolution']) => {
        if (seq === null) seq = fragment.edges.length;
        fragment.edges.push({ id: `test-import-e${seq++}`, kind: 'covers', from, to, ...(meta ? { meta } : {}), ...(resolution ? { resolution } : {}) });
        matches.push(String(meta?.match ?? ''));
      };
      const runImport = () => { matches.length = 0; seq = null; return importReports(fragment, root, config, addEdge); };

      let imported = runImport();
      const stamped = stamp ? stampReports(root, imported.reports, stamp, repo) : [];
      // read the reports back after stamping, so what is saved says `digest matches`
      // rather than the `no source digest` that was true a moment ago (the second read
      // is the idempotency guarantee exercising itself)
      if (stamped.length) imported = runImport();

      const out = new GraphStore();
      out.roots = store.roots;
      out.addFragment(fragment);
      // the graph's own meta is an ingest fact an import does not change; assigning it
      // after addFragment also undoes the per-repo fold that re-adding one repo's
      // fragment would otherwise stamp over a multi-repo graph's totals
      out.meta = { ...store.meta };
      const counted = countTests(repo, fragment.nodes, fragment.edges);
      const prior = out.meta.tests?.[repo];
      // an import speaks only for the level it read: the e2e report that is still
      // missing, and a claim that still resolves to nothing, are facts about this graph
      // that this run did not look at and must not erase
      const aboutThisLevel = (g: NonNullable<TestsMeta['gaps']>[number]) => g.reportKind != null && g.level === level;
      const dropped = (prior?.gaps ?? []).filter(aboutThisLevel);
      const keptGaps = (prior?.gaps ?? []).filter((g) => !aboutThisLevel(g));
      // a folded sentence begins with its group's first gap text, so a dropped gap takes
      // its sentence with it; an older graph with no `gaps` cannot be filtered, and its
      // sentences give way to what was just read rather than being doubled up
      const keptBlind = prior?.gaps ? (prior.blindSpots ?? []).filter((b) => !dropped.some((g) => b.startsWith(g.text))) : [];
      out.meta.tests = {
        ...out.meta.tests,
        [repo]: {
          files: prior?.files ?? counted.files,
          cases: counted.cases,
          edges: counted.edges,
          runs: counted.runs,
          reports: [...(prior?.reports ?? []).filter((r) => r.level !== level), ...imported.reports],
          gaps: [...keptGaps, ...imported.gaps],
          blindSpots: [...keptBlind, ...imported.blindSpots],
          ...(fragment.meta.sourceDigest ? { sourceDigest: fragment.meta.sourceDigest } : {}),
          ...(imported.head ?? prior?.head ? { head: (imported.head ?? prior?.head)! } : {}),
        },
      };
      out.save(graphFile);

      console.log(`imported ${imported.reports.filter((r) => r.path).length} report(s) into ${repo}: ${imported.runs} case run(s) joined, ${imported.edges} observed covers edge(s) → ${graphFile}`);
      for (const line of reportLines(imported.reports, matches)) console.log(line);
      console.log(`  ${repo}: ${counted.cases} case(s) · covers declared ${counted.edges.declared} · reached ${counted.edges.static} · observed ${counted.edges.observed} · ${counted.runs} run row(s)`);
      for (const path of stamped) console.log(`  stamped ${path} with sourceDigest ${stamp}`);
      for (const b of imported.blindSpots) console.error(`  ⚠ ${b}`);
      for (const e of imported.errors) console.error(`  ⚠ ${e}`);

      if (strict) {
        const bad: string[] = [];
        for (const r of imported.reports) {
          if (r.reason === 'no-match') bad.push(`\`${r.glob}\` matched 0 files — no ${r.level} ${r.kind} report`);
          else if (r.reason === 'unreadable') bad.push(`\`${r.path}\` is not a report format this build reads`);
          else if ((r.joined ?? 0) === 0 && (r.edges ?? 0) === 0) bad.push(`\`${r.path}\` joined 0 cases and produced 0 covers edges`);
        }
        if (bad.length) {
          console.error('');
          console.error(`--strict: ${bad.length} report(s) proved nothing —`);
          for (const b of bad) console.error(`  ✗ ${b}`);
          process.exit(1);
        }
      }
      break;
    }

    const { nodes, edges } = store.toJSON();
    const index = buildIndex(nodes, edges);
    setFreshnessMeta(index, store.meta);
    const scopeFlag = flag('scope');
    const scope = scopeFlag && scopeFlag !== 'all' ? new Set(scopeFlag.split(',').map((x) => x.trim()).filter(Boolean)) : null;
    const surfaceAll = testsSurface(index, scope, store.meta.tests);
    const surface = surfaceAll;

    if (sub === 'matrix') {
      const format = flag('format', 'table')!;
      // both machine formats are the one fold (farsight-tests-matrix v1): the JSON is the
      // document, the CSV is its rows — so a CI artifact and a screen cannot disagree
      const identity: Partial<TestsMatrixIdentity> = {
        ...(store.meta.sync != null ? { sync: store.meta.sync } : {}),
        ...(store.meta.commit ? { source_commit: store.meta.commit } : {}),
        source_digest: repoDigests(store),
        farsight: buildLine(),
      };
      if (format === 'json') { console.log(JSON.stringify(testsMatrixV1(index, surface, identity), null, 2)); break; }
      // the same bytes `GET /api/tests/matrix?format=csv` serves: one printer in core
      if (format === 'csv') { console.log(testsMatrixCsv(testsMatrixRows(index, surface, identity))); break; }
      if (!surface.journeys.length) { console.log('no flows in the graph — add a screens manifest (docs/proposals/design-source.md) and re-ingest'); break; }
      console.log('  JOURNEY                                   COVERAGE       E2E  DECL  REACH   OBS  EVIDENCE · THEIR OWN LAST RUNS  GAP');
      for (const r of surface.journeys) {
        // the end-to-end word, never a tick: a header-only `@covers` is a claim, not evidence. The
        // evidence column is the cell's one verdict (core testVerdict) — the word the HUD prints — and
        // the cases' own runs beside it as a count, never as a second verdict (swarm 2026-10-05)
        const v = r.coverage.verdict;
        const runs = v.runs.breakdown?.filter((p) => p.n) ?? [];
        const evidence = `${v.word.cls === 'none' ? 'nothing reaches it' : word(v.word.key, 'professional')} · ${v.runs.n} case(s)${runs.length ? ` (${breakdownText({ ...v.runs, breakdown: runs })})` : ''}`;
        console.log(`  ${r.name.slice(0, 40).padEnd(40)}  ${formatMetric(r.coverage.metric).padStart(8)}  ${r.e2e.padStart(8)}  ${String(r.declared.length).padStart(4)}  ${String(r.inferred.length).padStart(5)}  ${String(r.observed.length).padStart(4)}  ${evidence}  ${r.gap}`);
      }
      console.log(`\n  coverage is ${formatMetric(surface.metric)} of ${surface.metric.scopeLabel} — declared = an @covers claim · reached = what the test imports or opens · observed = a run reached it`);
      console.log('  e2e = the end-to-end word for the journey: observed (a run saw it) · reached (a test body reaches a route or screen on it) · declared (claimed only) · none');
      if (surface.metric.bound === 'floor') console.log(`  the value is a floor: ${surface.metric.uncertainty?.note}`);
      break;
    }

    if (sub === 'list' || !sub) {
      const level = flag('level');
      // --level holds every count to that level, not only the rows below (docs/COUNTS.md)
      const lv = level === 'unit' || level === 'integration' || level === 'e2e' ? level : undefined;
      const surface = lv ? testsSurface(index, scope, store.meta.tests, { level: lv }) : surfaceAll;
      if (!surface.counts.cases) {
        console.log('no tests in the graph — check the source excludes, then re-ingest');
        for (const b of surface.blindSpots) console.log(`  ⚠ ${b}`);
        break;
      }
      console.log(`  ${surface.counted ? countedLine([surface.counted.cases, surface.counted.files, surface.counted.sources]) : `${surface.counts.cases} case(s) in ${surface.counts.files} file(s)`} · ${surface.counts.covers} covers edge(s): declared ${surface.counts.declared}${surface.counts.declaredPassed ? ` (${surface.counts.declaredPassed} by an end-to-end case that passed — observed, by its own declaration)` : ''} · reached ${surface.counts.static} · observed ${surface.counts.observed}`);
      console.log(`  coverage ${formatMetric(surface.metric)} of ${surface.metric.scopeLabel}\n`);
      console.log('  SOURCE            LEVEL        RUNNER       FILES  CASES  FRESHNESS');
      for (const c of surface.sources) {
        if (level && c.level !== level) continue;
        const verdict = c.counted?.cases.breakdown?.filter((p) => p.n).length ? ` (${breakdownText({ ...c.counted.cases, breakdown: c.counted.cases.breakdown.filter((p) => p.n) })})` : '';
        console.log(`  ${c.repo.slice(0, 16).padEnd(16)}  ${c.level.padEnd(11)}  ${c.runner.padEnd(11)}  ${String(c.files).padStart(5)}  ${String(c.cases).padStart(5)}  ${c.freshness}${verdict}`);
        // why the source's passed cases are not the number a journey counts: what each declares
        if (c.counted?.passedByDeclaration) console.log(`  ${''.padEnd(16)}  ${countedText(c.counted.passedByDeclaration, { scope: false })}: ${breakdownText(c.counted.passedByDeclaration)}`);
      }
      console.log('');
      for (const s of surface.suites) {
        if (level && s.level !== level) continue;
        const verdict = `${s.counts.passed} passed${s.counts.failed ? `, ${s.counts.failed} failed` : ''}${s.counts.flaky ? `, ${s.counts.flaky} flaky` : ''}${s.counts.skipped ? `, ${s.counts.skipped} skipped` : ''}${s.counts.unknown ? `, ${s.counts.unknown} not run` : ''}`;
        console.log(`      ${s.repo}/${s.file} — ${s.counts.cases} case(s) · ${verdict}${s.lastRun ? ` · last run ${s.lastRun.at.slice(0, 10)}${s.lastRun.stale ? ' ⚠ stale' : ''}` : ''}`);
      }
      if (surface.orphans.length) {
        console.log(`\n  ${surface.orphans.length} orphan(s):`);
        for (const o of surface.orphans.slice(0, 20)) {
          console.log(`      ${o.file}${o.line ? `:${o.line}` : ''} — ${o.reason === 'unresolved-claim' ? `declares ${o.declares?.join(', ')}, which nothing in the graph matches` : 'covers nothing the graph knows'}`);
        }
      }
      if (surface.blindSpots.length) {
        console.log('');
        for (const b of surface.blindSpots) console.log(`  ⚠ ${b}`);
      }
      break;
    }
    fail(`unknown tests subcommand: ${sub} (list | matrix | import)`);
  }
  case 'stories': {
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const repo = flag('repo');
    const answer = await storybookLive(store.allNodes(), store.meta.stories, { repos: repo ? new Set([repo]) : null, fresh: true });
    const nodeId = flag('node');
    // a node's three numbers, named apart: its own stories, its docs pages, its parts' stories
    const nodeCounts = nodeId ? (() => { const { partIds, ...c } = storyCounts(buildIndex(store.allNodes(), store.toJSON().edges), nodeId, answer.byNode); return { counts: c, parts: partIds }; })() : null;
    if (rest.includes('--json')) {
      console.log(JSON.stringify(nodeId ? { node: nodeId, stories: answer.byNode[nodeId] ?? [], storybooks: answer.storybooks, ...nodeCounts } : { meta: store.meta.stories ?? {}, ...answer }, null, 2));
    } else if (nodeId) {
      const list = answer.byNode[nodeId] ?? [];
      if (nodeCounts) console.log(countedLine([nodeCounts.counts.own, nodeCounts.counts.docs, nodeCounts.counts.parts], { zeroes: true }));
      if (!list.length) console.log(`no stories for ${nodeId}`);
      for (const st of list) console.log(`  ${st.type.padEnd(5)}  ${st.name.slice(0, 30).padEnd(30)}  ${st.id.padEnd(50)}  ${st.frame ?? (st.live ? '' : 'not live')}`);
    } else {
      const metas = Object.entries(store.meta.stories ?? {}).filter(([r]) => !repo || r === repo);
      if (!metas.length) { console.log('no stories in the graph — no repo has a .storybook/main.* or *.stories.* files (or the graph predates the stories pass: re-ingest)'); break; }
      for (const [r, m] of metas) {
        console.log(`${r}: ${m.stories} stories over ${m.components} components from ${m.files} story file(s)`);
        for (const u of m.unresolved) console.log(`  ⚠ ${u.file}: ${u.reason}${u.component ? ` (${u.component})` : ''} — ${u.stories} stories`);
      }
      for (const b of answer.storybooks) {
        const where = b.url ?? 'no url recorded';
        console.log(`\nStorybook ${b.name ?? b.configDir} (${b.repo}) at ${where}${b.urlFrom ? ` [url from ${b.urlFrom}]` : ''}`);
        if (!b.reachable) { console.log(`  not reached (${b.error ?? 'unreachable'})${b.command ? ` — start it with: ${b.command}` : ''}`); continue; }
        const c = b.counts!;
        console.log(`  running · index: ${c.stories} stories + ${c.docs} docs · matched ${c.resolved} · matched nothing ${c.unresolved}`);
        console.log(`  matched by: ${Object.entries(c.via).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nothing'}`);
        for (const u of b.unresolved ?? []) console.log(`  ✗ ${u.type} ${u.id}  title "${u.title}"  ${u.path ? `componentPath → ${u.path}  ` : ''}${u.reason}${u.candidates?.length ? ` (${u.candidates.join(', ')})` : ''}`);
        if (b.notListed?.length) console.log(`  ${b.notListed.length} story(ies) in the files are not listed by the running index (it reads new files/globs on start): ${b.notListed.slice(0, 8).join(', ')}${b.notListed.length > 8 ? ' …' : ''}`);
      }
    }
    if (answer.storybooks.some((b) => b.reachable && (b.counts?.unresolved ?? 0) > 0)) process.exitCode = 1;
    break;
  }
  case 'affected': {
    await runAffected({ flag: (n) => flag(n), has: hasFlag, workspace: process.cwd(), fail });
    break;
  }
  case 'readiness': {
    runReadiness({ flag: (n) => flag(n), has: hasFlag, workspace: process.cwd(), fail });
    break;
  }
  case 'work': {
    await runWork({
      sub: positional[0], positional: positional.slice(1), workspace: process.cwd(), fail,
      flag: (n) => flag(n), has: (n) => rest.includes(`--${n}`),
    });
    break;
  }
  case 'journeys': {
    // persona → group → journeys (journey-organisation-and-config-files.md §4.4): the same core
    // journeyTree() GET /api/journeys and the MCP journeys tool answer with
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const { nodes, edges } = store.toJSON();
    const repo = flag('repo');
    const whole = journeyTree(buildIndex(nodes, edges), store.meta.journeys, repo ? new Set([repo]) : null);
    let tree = whole;
    const persona = flag('persona');
    const group = flag('group');
    const storyline = flag('storyline');
    if (persona || group || storyline) tree = pickJourneys(tree, { ...(persona ? { persona } : {}), ...(group ? { group } : {}), ...(storyline ? { storyline } : {}) });
    if (storyline && !tree.storylines.length) fail(unknownStorylineText(whole, storyline));
    if (rest.includes('--json')) { console.log(JSON.stringify(tree, null, 2)); break; }
    console.log(journeyTreeLines(tree).join('\n'));
    break;
  }
  case 'design': {
    const sub = positional[0];
    const graphFile = resolve(flag('graph', 'graph.json')!);
    if (!existsSync(graphFile)) fail(`no graph at ${graphFile} — run \`farsight ingest\` first`);
    const store = GraphStore.load(graphFile);
    const { nodes, edges } = store.toJSON();
    const index = buildIndex(nodes, edges);
    setFreshnessMeta(index, store.meta);
    if (sub === 'list' || !sub) {
      const designs = designSurface(index);
      if (!designs.length) { console.log('no design source in the graph — add docs/design/screens.json to a repo (docs/proposals/design-source.md) and re-ingest'); break; }
      console.log('  DESIGN                                    REPO             SCREENS  DESIGNED  BUILT  NOT-BUILT  UNDESIGNED  DRIFT  MANIFEST');
      for (const d of designs) {
        const c = d.counts;
        console.log(`  ${d.name.slice(0, 40).padEnd(40)}  ${d.repo.slice(0, 15).padEnd(15)}  ${String(c.screens).padStart(7)}  ${String(c.designed).padStart(8)}  ${String(c.built).padStart(5)}  ${String(c.designOnly).padStart(9)}  ${String(c.codeOnly).padStart(10)}  ${String(c.drift).padStart(5)}  ${d.manifestPath}`);
        for (const f of d.flows) {
          console.log(`      flow     ${f.name.slice(0, 28).padEnd(28)} ${f.screens.join(' → ').slice(0, 28).padEnd(28)} ${`${f.built} of ${f.total} built`.padEnd(20)}${f.docs.length ? ` docs ${f.docs.join(', ')}` : ''}${f.drift.length ? ` · drift ${f.drift.map((x) => x.kind).join(', ')}` : ''}`);
        }
        for (const sc of d.screens) {
          const status = sc.status === 'both' ? 'designed + built' : sc.status === 'design-only' ? 'designed, not built' : 'built, not designed';
          console.log(`      ${(sc.designId ?? '-').padEnd(8)} ${sc.name.slice(0, 28).padEnd(28)} ${(sc.route ?? sc.name).padEnd(28)} ${status.padEnd(20)}${sc.operations.length ? ` uses ${sc.operations.join(', ')}` : ''}${sc.drift.length ? ` · drift ${sc.drift.map((x) => x.kind).join(', ')}` : ''}`);
        }
      }
      console.log('\n  designed = has a row in the manifest · built = a page/component exists at that route · not-built = designed only · undesigned = a page with no row · flow = a named feature: screens in order, runs as a journey');
      break;
    }
    if (sub === 'diff') {
      const ref = flag('manifest');
      if (!ref) fail('design diff needs --manifest <path|url>');
      const parsed = await readManifestSource(ref);
      const repo = flag('repo') ?? 'proposed';
      const result = reconcileDesign(parsed.manifest, index, { repo, path: ref, ...(parsed.lastModified ? { lastModified: parsed.lastModified, freshness: parsed.freshness } : {}) }, { repo, designId: `${repo}::design::${ref}` });
      if (flag('format', 'md') === 'json') console.log(JSON.stringify(result, null, 2));
      else console.log(designDriftMarkdown(result));
      if (rest.includes('--strict') && result.counts.drift > 0) process.exit(1);
      break;
    }
    fail(`unknown design subcommand: ${sub} (list | diff)`);
  }
  default:
    fail(`unknown command: ${command}\n\n${USAGE}`);
}

/**
 * One line per report, as 03 §2.6 prints it: what the glob matched, what joined,
 * how many edges it produced and how well each one matched. The match breakdown is
 * sliced out of the edges the import added, in report order; if the two ever stop
 * lining up the count is printed without the breakdown rather than guessed at.
 */
function reportLines(reports: TestsMeta['reports'], matches: string[]): string[] {
  const freshnessWord: Record<string, string> = {
    unchanged: 'digest matches',
    changed: 'code changed since the run',
    unknown: 'no source digest',
  };
  const total = reports.reduce((n, r) => n + (r.edges ?? 0), 0);
  const aligned = total === matches.length;
  let at = 0;
  return reports.map((r) => {
    const bits: string[] = [`${r.kind} · ${r.runner} · ${r.level}`];
    if (!r.path) {
      bits.push(`matched 0 files (\`${r.glob}\`)`);
      return `  (no file)  ${bits.join(' · ')}`;
    }
    bits.push(`matched ${r.matched ?? 1}`);
    if (r.joined != null) bits.push(`joined ${r.joined}`);
    const each = (r.eachJoined ?? 0) + (r.eachUnjoined ?? 0);
    if (each) bits.push(`each ${r.eachJoined ?? 0}/${each}`);
    if (r.edges != null) {
      const slice = aligned ? matches.slice(at, at + r.edges) : [];
      at += r.edges;
      const by = new Map<string, number>();
      for (const m of slice) by.set(m || 'unnamed', (by.get(m || 'unnamed') ?? 0) + 1);
      const how = [...by].map(([k, v]) => `${k} ${v}`).join(' · ');
      bits.push(`edges ${r.edges}${how ? ` (${how})` : ''}`);
    }
    bits.push(r.freshness === 'changed' && r.changedBy === 'working-tree' ? 'working tree differs from HEAD' : freshnessWord[r.freshness] ?? r.freshness);
    if (r.reason === 'unreadable' || r.reason === 'empty') bits.push(r.reason === 'empty' ? 'empty report' : 'not a report format this build reads');
    return `  ${r.path}  ${bits.join(' · ')}`;
  });
}

function statIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
