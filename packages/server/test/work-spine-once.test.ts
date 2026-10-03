/**
 * KAN-8: a commit is listed once, however many syncs and sources read it.
 *
 * Two code sources read one checkout (the repository and a folder inside it, the
 * way the dogfood workspace reads examples/invoice-app beside the repo root), so
 * every commit is recorded under both repo names. Synced twice. The item answer
 * lists the commit once with the nodes of both sources, the list counts it once,
 * and the spine holds one key row per (repo, sha, key, via) — then a rewritten
 * history (an amend) makes the old commit stop naming the item.
 *
 * Temp workspace, its own loopback port; never 4477/4478 or the workspace graph.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, loadSqlite } from '@farsight/core';
import { INVOICE_APP_FIXTURE } from '@farsight/work-fixture';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const SRC = 'invoice-jira';
const id = (key: string) => `work::${SRC}::${key}`;

let work: string;
let app: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let log = '';
let inv3 = '';

function git(dir: string, args: string[], at?: string) {
  const env = { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) };
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
function write(rel: string, body: string) {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  writeFileSync(join(app, rel), body);
}
const fn = (name: string, body: string) => `/** ${name}. */\nexport function ${name}() {\n  return ${body};\n}\n`;

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const p = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => { const a = probe.address(); const n = typeof a === 'object' && a ? a.port : 0; probe.close(() => res(n)); });
    });
    if (p > 1024 && ![4477, 4478].includes(p)) return p;
  }
  throw new Error('no free loopback port');
}
const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, body: await r.json() as any }; };
const post = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json() as any };
};
function keyRows(key: string): { repo: string; sha: string }[] {
  const db = new (loadSqlite()!.DatabaseSync)(join(work, '.farsight', 'farsight.db'));
  try { return db.prepare('SELECT repo, sha FROM commit_key WHERE key = ? ORDER BY repo').all(key) as never; } finally { db.close(); }
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-work-once-')));
  app = join(work, 'app');
  cpSync(INVOICE_APP_FIXTURE, join(work, 'tracker'), { recursive: true });
  mkdirSync(app, { recursive: true });
  git(app, ['init', '-q', '-b', 'main']);
  git(app, ['config', 'user.name', 'Fixture']);
  git(app, ['config', 'user.email', 'f@example.com']);
  write('package.json', '{"name":"app"}\n');
  write('src/a.ts', fn('alpha', '1'));
  write('sub/package.json', '{"name":"sub"}\n');
  write('sub/src/b.ts', fn('beta', '1'));
  git(app, ['add', '-A']);
  git(app, ['commit', '-q', '-m', 'initial'], '2026-01-01T00:00:00Z');
  write('src/a.ts', fn('alpha', '2'));
  write('sub/src/b.ts', fn('beta', '2'));
  git(app, ['add', '-A']);
  git(app, ['commit', '-q', '-m', 'INV-3: both halves'], '2026-01-02T00:00:00Z');
  inv3 = git(app, ['rev-parse', 'HEAD']);

  mkdirSync(join(work, '.farsight'), { recursive: true });
  writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify({
    theme: 'dark', defaultLens: 'hybrid', collections: [],
    sources: [
      { id: 'app', name: 'app', type: 'local', path: 'app', exclude: ['sub/**'], enabled: true },
      { id: 'sub', name: 'sub', type: 'local', path: 'app/sub', enabled: true },
      { id: SRC, name: 'Invoice tracker', type: 'work', provider: 'fixture', path: 'tracker', enabled: true, scope: { projects: ['INV'] }, mode: 'read-only' },
    ],
  }, null, 2) + '\n');
  new GraphStore().save(join(work, 'graph.json'));

  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(join(work, 'graph.json'))}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work, env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited:\n${log}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/graph`); await r.arrayBuffer(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`server never answered:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let i = 0; i < 2; i++) assert.equal((await post('/api/sync')).status, 200);
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
});

test('KAN-8: two syncs, two sources over one checkout — the commit is listed and counted once', async () => {
  // the spine: one key row per (repo, sha, key, via), however many syncs wrote it
  assert.deepEqual(keyRows('INV-3').map((r) => `${r.repo} ${r.sha}`), [`app ${inv3}`, `sub ${inv3}`]);

  const { status, body } = await get(`/api/work/item/${encodeURIComponent(id('INV-3'))}`);
  assert.equal(status, 200);
  assert.equal(body.commits.length, 1, JSON.stringify(body.commits.map((c: any) => `${c.repo} ${c.sha}`)));
  assert.equal(body.commits[0].sha, inv3);
  assert.deepEqual(body.commits[0].nodes.sort(), ['app::src/a.ts::alpha', 'sub::src/b.ts::beta'], 'the nodes of both sources');
  assert.deepEqual(body.commits[0].files.map((f: any) => f.path), ['src/a.ts', 'sub/src/b.ts']);
  assert.equal(body.touched.n, 2);
  assert.ok(!body.findings.some((f: any) => /2 commits/.test(f.text)));

  const list = (await get('/api/work')).body;
  assert.equal(list.items.find((i: any) => i.key === 'INV-3').commits.n, 1);

  const diff = (await get(`/api/work/item/${encodeURIComponent(id('INV-3'))}/diff?sha=${inv3}`)).body;
  assert.equal(diff.error, undefined, JSON.stringify(diff));
  assert.deepEqual(diff.files.flatMap((f: any) => f.nodes).sort(), ['app::src/a.ts::alpha', 'sub::src/b.ts::beta']);
});

test('a rewritten history: a keyed commit no branch reaches stops naming the item on the next sync', async () => {
  git(app, ['commit', '-q', '--amend', '-m', 'both halves, no key'], '2026-01-03T00:00:00Z');
  const s = await post('/api/sync');
  assert.equal(s.status, 200);
  assert.match(s.body.results.app, /1 keyed commit no longer in the history, forgotten/, JSON.stringify(s.body.results));
  assert.deepEqual(keyRows('INV-3'), []);
  const { body } = await get(`/api/work/item/${encodeURIComponent(id('INV-3'))}`);
  assert.deepEqual(body.commits, []);
  assert.equal((await get('/api/work')).body.items.find((i: any) => i.key === 'INV-3').commits.n, 0);
});
