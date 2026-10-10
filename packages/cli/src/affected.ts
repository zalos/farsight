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
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  GraphStore, buildIndex, setFreshnessMeta, journeyTree, affectedRange, countedText, readinessCsvRows, buildLine, t,
  unknownStorylineText,
} from '@farsight/core';
import type { AffectedV1, TestsMatrixIdentity, Readiness } from '@farsight/core';
import { loadCodeHostSources, openGitHub, decidePost, readChange, originRepo, type CodeHostSource, type ReadChange } from '@farsight/work';
import { readinessOf } from '@farsight/server';
import { affectedLines, readinessLines } from '@farsight/core';

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

function loadGraph(a: CliArgs) {
  const file = resolve(a.flag('graph') ?? 'graph.json');
  if (!existsSync(file)) a.fail(`no graph at ${file} — run \`farsight ingest\` first`);
  const store = GraphStore.load(file);
  const { nodes, edges } = store.toJSON();
  const index = buildIndex(nodes, edges);
  setFreshnessMeta(index, store.meta);
  const trees = new Map<string, ReturnType<typeof journeyTree>>();
  // one tree per source: two sources may declare a storyline of one id (journeyTree keeps the first workspace-wide)
  const treeOf = (repo: string) => { if (!trees.has(repo)) trees.set(repo, journeyTree(index, store.meta.journeys, new Set([repo]))); return trees.get(repo)!; };
  return { store, index, tree: journeyTree(index, store.meta.journeys), treeOf };
}

/** A date as the day it fell on (UTC), or the dash. */
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
  const { store, index, treeOf } = loadGraph(a);
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
  // the checkout git reads (prefix, history, a commit range): the graph's root for the source, or --checkout
  const root = resolve(a.flag('checkout') ?? store.roots[repo] ?? process.cwd());
  const host: CodeHostSource | undefined = hosts.find((h) => (hostArg ? h.repo === hostArg : (h.source ?? h.repo.split('/').pop()) === repo)) ?? (hosts.length === 1 ? hosts[0] : undefined);
  const viaGh = a.flag('via') === 'gh';
  if (prArg && (!Number.isInteger(Number(prArg)) || Number(prArg) < 1)) a.fail(`--pr takes a pull request number (got "${prArg}")`);
  let change: ReadChange;
  try {
    // sources nested under this one in the same repository (an example app inside the repo) take their own files
    const home = store.roots[repo];
    const sources = home ? repos.filter((r) => store.roots[r]).map((r) => ({ name: r, rel: relative(home, store.roots[r]!) }))
      .filter((x) => !x.rel.startsWith('..') && !isAbsolute(x.rel)) : [];
    change = await readChange({ root, ask: prArg ? { pr: Number(prArg) } : { from: from!, to: to! }, ...(host ? { host } : {}), ...(hostArg ? { hostRepo: hostArg } : {}), viaGh, ...(sources.length ? { sources } : {}) });
  } catch (err) {
    return a.fail((err as Error).message);
  }
  const { range, commits, files, history, pr } = change;
  const open = async () => change.opened ?? openGitHub(host, hostArg ?? host?.repo ?? originRepo(root)!, { viaGh });

  const hops = Number(a.flag('hops') ?? '2');
  const identity: TestsMatrixIdentity = {
    ...(store.meta.sync != null ? { sync: store.meta.sync } : {}),
    ...(store.meta.commit ? { source_commit: store.meta.commit } : {}),
    source_digest: Object.fromEntries(repos.map((r) => [r, store.repoMeta(r)?.sourceDigest]).filter((x): x is [string, string] => !!x[1])),
    farsight: buildLine(),
    generated_at: new Date().toISOString(),
  };
  const doc = affectedRange(index, { repo, range, commits, files, ...(history ? { history } : {}), hops, tree: treeOf, identity });

  if (a.has('json')) console.log(JSON.stringify(doc, null, 2));
  else console.log(affectedLines(doc).join('\n'));
  const png = a.flag('png');
  if (png) console.error(await writePng(doc, resolve(png)));

  if (!a.has('post')) return;
  if (!pr) a.fail('--post needs --pr <n>: a commit range has no pull request to post on');
  const cmd = `farsight affected --pr ${pr.number} --json`;
  const d = await decidePost(host, 'human', open, async () => pr!);
  const verdictLine = (k: string, v: { allowed: boolean; reason: string }) => console.error(`  ${t(k, R)}: ${t(v.allowed ? 'work.verdict.yes' : 'work.verdict.no', R)} — ${v.reason}`);
  verdictLine('affected.verdict.policy', d.verdicts.policy);
  verdictLine('affected.verdict.host', d.verdicts.tracker);
  verdictLine('affected.verdict.credential', d.verdicts.credential);
  if (!d.allowed) { console.error(say('affected.post.denied')); process.exitCode = 1; return; }
  if (d.requiresConfirmation && !a.has('confirm')) { console.error(say('affected.post.waiting')); process.exitCode = 2; return; }
  const gh = d.host!;
  const posted = await gh.upsertComment(pr.number, COMMENT_MARKER, commentBody(doc, cmd));
  const check = checkOf(doc);
  await gh.status(pr.headSha, check.state, check.description, say('affected.check.context'), posted.url);
  console.error(say('affected.post.done', { url: posted.url }));
}

// ── readiness ──────────────────────────────────────────────────────────────

export function runReadiness(a: CliArgs): void {
  const id = a.flag('storyline');
  const { index, tree: all, treeOf } = loadGraph(a);
  const tree = a.flag('repo') ? treeOf(a.flag('repo')!) : all;
  if (!id) a.fail(`usage: farsight readiness --storyline <id> [--json|--csv] — storylines: ${tree.storylines.map((s) => s.id).join(', ') || 'none declared'}`);
  const { brief } = readinessOf(index, tree, id!, a.workspace, a.flag('repo'));
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

