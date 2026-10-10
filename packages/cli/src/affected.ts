// `farsight affected` and `farsight readiness` (round 2026-10-10, proposal 6).
//
// affected: a commit range (`--from <sha> --to <sha>`, read with git in the source's checkout) or a pull
// request (`--pr <n>`, read from the code host) → core `affectedRange()` → the frozen `farsight-affected v1`
// document (`--json`), the words (hybrid, from the catalog), a stamped picture (`--png`), and with `--post`
// ONE comment (updated in place, found by its marker line) and ONE check (a commit status) on the pull
// request — through the three verdicts every write passes (policy · the host · the credential); exit 2
// while a person has not confirmed (`--confirm`), like `farsight work comment`.
//
// readiness: core `readiness()` for one storyline with commits from the spine — words, `--json`, `--csv`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GraphStore, buildIndex, setFreshnessMeta, journeyTree, affectedRange, countedText, readinessCsvRows, buildLine, t,
  hunksOfPatch, unknownStorylineText,
} from '@farsight/core';
import type { AffectedV1, TestsMatrixIdentity, RangeFile, RangeCommit, AffectedRangeSpec, Readiness } from '@farsight/core';
import { loadCodeHostSources, openGitHub, decidePost, codeHostPolicy, type CodeHostSource, type PullRequest } from '@farsight/work';
import { readinessOf } from '@farsight/server';

const R = 'professional' as const;
const say = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key, R));
/** The marker line the comment is found by on later runs — never shown, one per repository's source. */
export const COMMENT_MARKER = '<!-- farsight:affected -->';

export interface CliArgs {
  flag: (name: string) => string | undefined;
  has: (name: string) => boolean;
  workspace: string;
  fail: (msg: string) => never;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function loadGraph(a: CliArgs) {
  const file = resolve(a.flag('graph') ?? 'graph.json');
  if (!existsSync(file)) a.fail(`no graph at ${file} — run \`farsight ingest\` first`);
  const store = GraphStore.load(file);
  const { nodes, edges } = store.toJSON();
  const index = buildIndex(nodes, edges);
  setFreshnessMeta(index, store.meta);
  return { store, index, tree: journeyTree(index, store.meta.journeys) };
}

/** `owner/name` from a git remote URL (https or ssh). */
export function hostRepoOf(url: string): string | undefined {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

/** A date as the day it fell on (UTC), or the dash. */
const day = (at: string | null | undefined) => (at ? at.slice(0, 10) : '—');

// ── the words ──────────────────────────────────────────────────────────────

/** The document in words — the hybrid register's lines, shared by the terminal and the comment (`md`). */
export function affectedLines(doc: AffectedV1, md = false): string[] {
  const out: string[] = [];
  const b = (s: string) => (md ? `**${s}**` : s.toUpperCase());
  const code = (s: string) => (md ? `\`${s.replace(/`/g, "'")}\`` : s);
  const cap = md ? 25 : 60;
  const id = doc.identity;
  const head = doc.range.pr
    ? `${say('affected.title.pr')} · #${doc.range.pr.number}${doc.range.pr.title ? ` ${doc.range.pr.title}` : ''}`
    : `${say('affected.title.range')} · ${doc.range.from?.slice(0, 7)}..${doc.range.to?.slice(0, 7)}`;
  out.push(md ? `### ${head}` : head);
  out.push(`${doc.range.repo}${id.sync != null ? ` · sync ${id.sync}` : ''}${id.source_commit ? ` · commit ${id.source_commit.slice(0, 7)}` : ''} · ${id.farsight}`);
  out.push(`${countedText(doc.counted.commits, { scope: false })} · ${countedText(doc.counted.files, { scope: false })} · ${countedText(doc.counted.changed)}${doc.bound === 'floor' ? ' · a floor' : ''}`);
  out.push('');
  out.push(`${b(say('affected.head.journeys'))} — ${countedText(doc.counted.journeys)} · ${countedText(doc.counted.screens, { scope: false })}`);
  if (!doc.journeys.length) out.push(`  ${say('affected.none.journeys')}`);
  for (const j of doc.journeys.slice(0, cap)) {
    const where = j.storylines.map((s) => (s.branch_of
      ? say('affected.storyline.branch', { name: doc.journeys.find((x) => x.id === s.branch_of)?.name ?? s.branch_of.split('::').pop()! }) + ` · ${s.name}`
      : say('affected.storyline.step', { n: s.step, m: s.of, name: s.name }))).join(' · ');
    const screens = j.screens.map((s) => s.name).filter((x, i, arr) => arr.indexOf(x) === i).join(', ');
    out.push(`${md ? '- ' : '  '}${md ? `**${j.name}**` : j.name} · ${j.hop === 0 ? say('affected.hop.self') : say('affected.hop.far', { n: j.hop })}${where ? ` · ${where}` : ''}${screens ? ` · ${screens}` : ''}`);
  }
  if (doc.journeys.length > cap) out.push(`  ${say('affected.more', { n: doc.journeys.length - cap })}`);
  out.push('');
  out.push(b(say('affected.head.path')));
  if (!doc.gates.length && !doc.writes.length && !doc.contracts.length) out.push(`  ${say('affected.none.path')}`);
  if (doc.gates.length) out.push(`${md ? '- ' : '  '}${say('affected.head.gates')} (${countedText(doc.counted.gates, { scope: false })}): ${doc.gates.slice(0, 12).map((g) => code(g.name)).join(' · ')}${doc.gates.length > 12 ? ' ' + say('affected.more', { n: doc.gates.length - 12 }) : ''}`);
  for (const w of doc.writes.slice(0, 12)) {
    const moves = w.moves.length
      ? w.moves.map((m) => (m.from ? say('affected.moves', { from: m.from, to: m.to, writer: code(w.writer_name) }) : say('affected.movesAny', { to: m.to, writer: code(w.writer_name) }))).join(' · ')
      : say('affected.writes', { writer: code(w.writer_name) });
    out.push(`${md ? '- ' : '  '}${say('affected.head.writes')}: ${code(w.name)}${w.store ? ` (${w.store})` : ''} · ${moves}`);
  }
  if (doc.contracts.length) out.push(`${md ? '- ' : '  '}${say('affected.head.calls')}: ${doc.contracts.slice(0, 12).map((c) => `${code(c.name)}${c.contract ? ` · ${c.contract}` : ''}`).join(' · ')}${doc.contracts.length > 12 ? ' ' + say('affected.more', { n: doc.contracts.length - 12 }) : ''}`);
  out.push('');
  out.push(`${b(say('affected.head.tests'))} — ${countedText(doc.counted.tests)}`);
  if (!doc.tests.length) out.push(`  ${say('affected.none.tests')}`);
  if (md && doc.tests.length) { out.push('', '| case | where | its own last run |', '|---|---|---|'); }
  for (const x of doc.tests.slice(0, cap)) {
    const where = `${x.file}${x.line != null ? `:${x.line}` : ''}`;
    const run = x.status ? `${x.status} ${day(x.at)}` : t('count.part.noRun', R).replace('{n} ', '');
    out.push(md ? `| ${x.title.replace(/\|/g, '/')} | \`${where}\` | ${run}${x.inactive ? ' · .skip' : ''} |` : `  ${where.padEnd(52)} ${x.title.slice(0, 60).padEnd(60)} ${run}`);
  }
  if (doc.tests.length > cap) out.push(`${md ? '\n' : '  '}${say('affected.more', { n: doc.tests.length - cap })}`);
  out.push('');
  const v = doc.verdict;
  out.push(v.last_run
    ? say('affected.verdict', { passed: v.passed, skipped: v.skipped, failed: v.failed, date: day(v.last_run), since: v.commits_since ?? '?' })
    : say('affected.verdict.noRun'));
  return out;
}

/** The comment's body: the marker, the words, how it was made, and the command that prints it as JSON. */
export function commentBody(doc: AffectedV1, cmd: string): string {
  return [
    COMMENT_MARKER,
    ...affectedLines(doc, true),
    '',
    `<sub>${say('affected.footnote', { sync: doc.identity.sync ?? '—' })} ${say('affected.rerun')}: <code>${cmd}</code></sub>`,
  ].join('\n');
}

/** The check: failure when a listed case failed on its own last run; success otherwise — the words say the rest. */
export function checkOf(doc: AffectedV1): { state: 'success' | 'failure'; description: string } {
  const v = doc.verdict;
  return {
    state: v.failed > 0 ? 'failure' : 'success',
    description: say('affected.check.desc', { tests: doc.tests.length, passed: v.passed, skipped: v.skipped, failed: v.failed }),
  };
}

// ── the picture ────────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A self-contained HUD card of the document: the picture `--png` stamps (no server, no network). */
export function cardHtml(doc: AffectedV1): string {
  const lines = affectedLines(doc, false);
  const foot = `affected · ${doc.journeys.length} journeys · stamped${doc.identity.sync != null ? ` sync ${doc.identity.sync}` : ''}${doc.identity.source_commit ? ` · ${doc.identity.source_commit.slice(0, 7)}` : ''} · ${doc.identity.generated_at.slice(0, 10)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#0A0D14;color:#DCE4F5;font:12.5px/1.55 "SF Mono",Menlo,monospace}
.c{padding:22px 26px;width:980px;box-sizing:border-box}
.l{white-space:pre-wrap}.h{color:#F0B44E;font:600 13px "Avenir Next Condensed",Futura,sans-serif;letter-spacing:.12em;margin-top:6px}
.t{color:#5BC8DD;font:600 16px "Avenir Next Condensed",Futura,sans-serif;letter-spacing:.06em}
.f{margin-top:14px;padding-top:8px;border-top:1px solid #232C42;color:#99A3BA}
</style></head><body><div class="c">${lines.map((l, i) => `<div class="${i === 0 ? 't' : /^[A-Z ]{6,}/.test(l) ? 'h' : 'l'}">${esc(l) || '&nbsp;'}</div>`).join('')}<div class="f">${esc(foot)}</div></div></body></html>`;
}

async function writePng(doc: AffectedV1, path: string): Promise<string> {
  let chromium: { launch: () => Promise<any> } | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const name = '@playwright/test';
    chromium = (await import(name)).chromium;
  } catch { /* not installed with this build */ }
  if (!chromium) return say('affected.png.none');
  let browser;
  try { browser = await chromium.launch(); } catch { return say('affected.png.none'); }
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.setContent(cardHtml(doc));
    await (await page.$('.c')).screenshot({ path });
    return say('affected.png.done', { path });
  } finally {
    await browser.close();
  }
}

// ── affected ───────────────────────────────────────────────────────────────

export async function runAffected(a: CliArgs): Promise<void> {
  const prArg = a.flag('pr');
  const from = a.flag('from');
  const to = a.flag('to');
  if (!prArg && !(from && to)) a.fail('usage: farsight affected --pr <n> | --from <sha> --to <sha> [--repo name] [--json] [--png <path>] [--post [--confirm] [--via gh]]');
  const { store, index, tree } = loadGraph(a);
  const repos = [...new Set([...Object.keys(store.roots), ...Object.keys(store.meta.repos ?? {})])];
  const hosts = loadCodeHostSources(a.workspace);

  // which source, which checkout, which host repository
  const hostArg = a.flag('host-repo');
  const pickRepo = (): string => {
    const named = a.flag('repo');
    if (named) { if (!repos.includes(named)) a.fail(`no source "${named}" in the graph (there are: ${repos.join(', ')})`); return named; }
    const viaHost = hosts.find((h) => !hostArg || h.repo === hostArg);
    const guess = viaHost?.source ?? (hostArg ?? viaHost?.repo)?.split('/').pop();
    if (guess && repos.includes(guess)) return guess;
    if (repos.length === 1) return repos[0]!;
    return a.fail(`the graph holds ${repos.length} sources — name one with --repo (${repos.join(', ')})`);
  };
  const repo = pickRepo();
  const root = store.roots[repo] ?? process.cwd();
  const prefix = (() => { try { return git(root, ['rev-parse', '--show-prefix']).trim(); } catch { return ''; } })();
  const rel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const inSource = (p: string) => !prefix || p.startsWith(prefix);
  const host: CodeHostSource | undefined = hosts.find((h) => (hostArg ? h.repo === hostArg : (h.source ?? h.repo.split('/').pop()) === repo)) ?? (hosts.length === 1 ? hosts[0] : undefined);
  const hostRepo = hostArg ?? host?.repo ?? (() => { try { return hostRepoOf(git(root, ['remote', 'get-url', 'origin'])); } catch { return undefined; } })();
  const viaGh = a.has('via') && a.flag('via') === 'gh';

  let range: AffectedRangeSpec;
  let commits: RangeCommit[] = [];
  let files: RangeFile[] = [];
  let history: { sha: string; at: string }[] | undefined;
  let pr: PullRequest | undefined;
  let opened: Awaited<ReturnType<typeof openGitHub>> | undefined;
  const open = async () => (opened ??= await openGitHub(host, hostRepo!, { viaGh }));

  if (prArg) {
    const n = Number(prArg);
    if (!Number.isInteger(n) || n < 1) a.fail(`--pr takes a pull request number (got "${prArg}")`);
    if (!hostRepo) a.fail('no host repository: add a code-host source to .farsight/settings.json, pass --host-repo owner/name, or run inside a checkout whose origin is on GitHub');
    if (host && host.host !== 'github') a.fail(`reading pull requests from ${host.host} is not built yet (GitHub only)`);
    // reading is a read: the policy's `read` when a source exists; a public repository reads with no source at all
    if (host) { const d = codeHostPolicy(host, 'read', 'human'); if (!d.verdict.allowed) a.fail(`the code-host source ${host.id} does not let you read: ${d.verdict.reason}`); }
    const { host: gh } = await open();
    try {
      pr = await gh.pr(n);
      commits = await gh.commits(n);
      files = (await gh.files(n)).filter((f) => inSource(f.path)).map((f) => ({ ...f, path: rel(f.path) }));
    } catch (err) {
      a.fail(`could not read pull request #${n} of ${hostRepo}: ${(err as Error).message}${viaGh ? '' : ' (a private repository needs a credential: auth.secret on the code-host source, or --via gh)'}`);
    }
    range = { kind: 'pr', number: n, title: pr!.title, url: pr!.url, base: pr!.base, head: pr!.head, host: 'github' };
    try {
      history = git(root, ['log', '-n', '500', '--format=%H%x09%cI', pr!.headSha]).trim().split('\n').filter(Boolean).map((l) => { const [sha, at] = l.split('\t'); return { sha: sha!, at: at! }; });
    } catch { history = commits.map((c) => ({ sha: c.sha, at: c.at })).reverse(); }
  } else {
    range = { kind: 'commits', from: from!, to: to! };
    try {
      commits = git(root, ['log', '--reverse', '--format=%H%x09%cI%x09%an%x09%s', `${from}..${to}`]).trim().split('\n').filter(Boolean)
        .map((l) => { const [sha, at, author, ...s] = l.split('\t'); return { sha: sha!, at: at!, author: author!, subject: s.join('\t') }; });
      const patch = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', from!, to!]);
      const status = new Map(git(root, ['diff', '--name-status', '-M', from!, to!]).trim().split('\n').filter(Boolean)
        .map((l) => { const p = l.split('\t'); return [p[p.length - 1]!, p[0]!.charAt(0)] as const; }));
      const hunks = hunksOfPatch(patch);
      const seen = new Set(hunks.map((h) => h.path));
      for (const [p, s] of status) if (!seen.has(p)) hunks.push({ path: p, ranges: [] });
      files = hunks.filter((h) => inSource(h.path)).map((h) => ({ path: rel(h.path), ranges: h.ranges, ...(status.get(h.path) ? { status: status.get(h.path)! } : {}) }));
      history = git(root, ['log', '-n', '500', '--format=%H%x09%cI', to!]).trim().split('\n').filter(Boolean).map((l) => { const [sha, at] = l.split('\t'); return { sha: sha!, at: at! }; });
    } catch (err) {
      a.fail(`git could not read ${from}..${to} in ${root}: ${String((err as Error).message).split('\n')[0]}`);
    }
  }

  const hops = Number(a.flag('hops') ?? '2');
  const identity: TestsMatrixIdentity = {
    ...(store.meta.sync != null ? { sync: store.meta.sync } : {}),
    ...(store.meta.commit ? { source_commit: store.meta.commit } : {}),
    source_digest: Object.fromEntries(repos.map((r) => [r, store.repoMeta(r)?.sourceDigest]).filter((x): x is [string, string] => !!x[1])),
    farsight: buildLine(),
    generated_at: new Date().toISOString(),
  };
  const doc = affectedRange(index, { repo, range, commits, files, ...(history ? { history } : {}), hops, tree, identity });

  if (a.has('json')) console.log(JSON.stringify(doc, null, 2));
  else console.log(affectedLines(doc).join('\n'));
  const png = a.flag('png');
  if (png) console.error(await writePng(doc, resolve(png)));

  if (!a.has('post')) return;
  if (!pr) a.fail('--post needs --pr <n>: a commit range has no pull request to post on');
  const cmd = `farsight affected --pr ${pr.number} --json`;
  const d = await decidePost(host, 'human', open, async () => pr!);
  const verdictLine = (k: string, v: { allowed: boolean; reason: string }) => console.error(`  ${t(k, R)}: ${t(v.allowed ? 'work.verdict.yes' : 'work.verdict.no', R)} — ${v.reason}`);
  verdictLine('work.verdict.policy', d.verdicts.policy);
  verdictLine('work.verdict.tracker', d.verdicts.tracker);
  verdictLine('work.verdict.credential', d.verdicts.credential);
  if (!d.allowed) { console.error(say('affected.post.denied')); process.exitCode = 1; return; }
  if (d.requiresConfirmation && !a.has('confirm')) { console.error(say('affected.post.waiting')); process.exitCode = 2; return; }
  const gh = d.host!;
  const posted = await gh.upsertComment(pr.number, COMMENT_MARKER, commentBody(doc, cmd));
  const check = checkOf(doc);
  await gh.status(pr.headSha, check.state, check.description, say('affected.check.context'), posted.url);
  console.error(say('affected.post.done', { url: posted.url }));
}

// ── readiness ──────────────────────────────────────────────────────────────

export function readinessLines(r: Readiness): string[] {
  const out: string[] = [];
  out.push(`${r.storyline.name} · ${countedText(r.counted.steps)}`);
  out.push(`${countedText(r.counted.ship, { scope: false })} · ${countedText(r.counted.hold, { scope: false })} · ${countedText(r.counted.skipped, { scope: false })} · ${countedText(r.counted.unreached, { scope: false })}`);
  out.push('');
  for (const x of r.rows) {
    const verdict = x.verdict ? t(x.verdict.word.key, R) : '—';
    out.push(`${x.label.padEnd(4)} ${x.name}${x.branchOf ? ` (branch of ${x.branchOf.name} · ${x.branchOf.when})` : ''}`);
    out.push(`     built ${x.built.n} of ${x.built.of} · ${verdict} · last run ${day(x.lastRun)} · ${x.skipped} skipped · ${x.unrun} never run · gates no test is known to reach ${x.gates.unreached.length} of ${x.gates.n} · commits since green ${x.commitsSince ?? '—'}`);
    out.push(`     ${x.ship ? 'SHIP' : 'HOLD — ' + x.hold.map((h) => t(`readiness.hold.${h}`, R)).join(' · ')}`);
  }
  out.push('');
  out.push(countedText(r.counted.rules));
  for (const g of r.rules) out.push(`  ${g.name.padEnd(40)} ${(g.words ?? '—').slice(0, 60).padEnd(60)} ${g.screens} screens · ${g.tests} cases · ${g.owners.join(', ') || 'owner not declared'}`);
  return out;
}

export function runReadiness(a: CliArgs): void {
  const id = a.flag('storyline');
  const { index, tree } = loadGraph(a);
  if (!id) a.fail(`usage: farsight readiness --storyline <id> [--json|--csv] — storylines: ${tree.storylines.map((s) => s.id).join(', ') || 'none declared'}`);
  const { brief } = readinessOf(index, tree, id!, a.workspace);
  if (!brief) a.fail(unknownStorylineText(tree, id!));
  if (a.has('json')) { console.log(JSON.stringify(brief, null, 2)); return; }
  if (a.has('csv')) {
    const { header, rows } = readinessCsvRows(brief!, (k) => t(k, R));
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    console.log([header, ...rows].map((r) => r.map(q).join(',')).join('\n'));
    return;
  }
  console.log(readinessLines(brief!).join('\n'));
}

