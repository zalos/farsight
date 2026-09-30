/**
 * Design shots per sync — chunk H8 of the change-history lane
 * (docs/proposals/change-history-2026-09.md §5, and §9's boundary).
 *
 * What is under test is the whole path a reader walks: a workspace that turned
 * the flag on syncs twice over a screen whose design image changed in between,
 * and both pictures come back from `/api/design/image?node=…&sync=N` — the
 * earlier one still the earlier one, byte for byte.
 *
 * Four honesty rules are asserted beside it, because each is a way this feature
 * could quietly lie:
 *
 *  1. **Flag off writes zero bytes.** No shots directory, no rows, and no
 *     `shots` key on the sync's own answer — so "the pass found nothing" and
 *     "the pass never ran" stay different facts.
 *  2. **An absent shot is absent.** A sync with no row answers 404 saying so,
 *     and explicitly does *not* serve today's image under that sync's name.
 *  3. **`?sync=` widens nothing.** The parameter is a number or a 400, and the
 *     bytes it reaches are named by the row's own digest inside the shots cache.
 *  4. **§9's line holds.** Nothing here renders the app or the HUD: every byte
 *     retained is a byte that was already in the repository.
 *
 * The fixture is a temp workspace with its own graph, settings and database.
 * Nothing touches the workspace graph, `examples/**`, any real store, or ports
 * 4477 / 4478 (the live dogfood servers).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SnapshotDb } from '@farsight/core';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;

let work: string;
let app: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';

/** A one-pixel PNG whose colour byte is the caller's — two calls, two different files. */
function png(seed: number): Buffer {
  // a real PNG header so the server's content type and the browser both behave; the
  // trailing byte is what makes two of these different pictures
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('farsight shot fixture '),
    Buffer.from([seed]),
  ]);
}

const MANIFEST = {
  name: 'Fixture — screens',
  screens: [
    { id: 'SCR-01', name: 'First screen', route: '/first', image: 'docs/design/screens/scr-01.png', description: 'The screen whose picture changes between the two syncs.' },
    { id: 'SCR-02', name: 'Second screen', route: '/second', description: 'A screen the manifest gives no image at all — it can never have a shot.' },
  ],
  flows: [{ id: 'first-flow', name: 'The one flow', screens: ['SCR-01', 'SCR-02'] }],
};

function writeSettings(designShots: boolean): void {
  writeFileSync(join(work, '.farsight', 'settings.json'), JSON.stringify({
    theme: 'dark', defaultLens: 'hybrid', collections: [],
    sources: [{ id: 'app', name: 'app', type: 'local', path: 'app', enabled: true }],
    ...(designShots ? { flags: { designShots: true } } : {}),
  }, null, 2) + '\n');
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const picked = await new Promise<number>((res, rej) => {
      const probe = createServer();
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        const p = typeof a === 'object' && a ? a.port : 0;
        probe.close(() => res(p));
      });
    });
    if (picked > 1024 && picked !== 4477 && picked !== 4478) return picked;
  }
  throw new Error('no free loopback port after 20 tries');
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = 'nothing answered';
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode}:\n${childLog}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/version`);
      await r.arrayBuffer();
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (err) { last = (err as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

/** Every byte under a directory, or 0 when it does not exist — the flag-off measurement. */
function bytesUnder(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    total += st.isDirectory() ? bytesUnder(p) : st.size;
  }
  return total;
}

const shotsDir = () => join(work, '.farsight', 'cache', 'shots');

async function sync(): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}/api/sync`, { method: 'POST' });
  const body = await r.text();
  assert.equal(r.status, 200, `POST /api/sync answered ${r.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
}

async function image(query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/design/image?${query}`);
}

before(async () => {
  // realpath: macOS /tmp is a symlink and the server resolves its workspace dir
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-shots-')));
  app = join(work, 'app');
  mkdirSync(join(app, 'docs', 'design', 'screens'), { recursive: true });
  mkdirSync(join(app, 'src'), { recursive: true });
  mkdirSync(join(work, '.farsight'), { recursive: true });
  writeFileSync(join(app, 'docs', 'design', 'screens.json'), JSON.stringify(MANIFEST, null, 2) + '\n');
  writeFileSync(join(app, 'docs', 'design', 'screens', 'scr-01.png'), png(1));
  writeFileSync(join(app, 'src', 'noop.ts'), 'export const noop = () => undefined;\n');
  writeSettings(false); // the flag starts OFF: the first measurement is the zero-bytes one

  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(join(work, 'graph.json'))}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { childLog += d; });
  child.stderr.on('data', (d: string) => { childLog += d; });
  await waitReady();
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
});

/** The node id of the screen with a picture — read off the graph the sync wrote. */
function screenNode(): string {
  const g = JSON.parse(readFileSync(join(work, 'graph.json'), 'utf8')) as { nodes: { id: string; design?: { id?: string; image?: unknown } }[] };
  const n = g.nodes.find((x) => x.design?.id === 'SCR-01' && x.design?.image);
  assert.ok(n, `the fixture manifest must produce a screen node with an image — nodes: ${g.nodes.map((x) => x.id).join(', ')}`);
  return n!.id;
}

function noImageNode(): string {
  const g = JSON.parse(readFileSync(join(work, 'graph.json'), 'utf8')) as { nodes: { id: string; design?: { id?: string } }[] };
  const n = g.nodes.find((x) => x.design?.id === 'SCR-02');
  assert.ok(n, 'the fixture manifest must produce the image-less screen too');
  return n!.id;
}

test('with the flag off a sync writes zero shot bytes and says nothing about shots', async () => {
  const out = await sync(); // sync 1
  assert.equal(out.shots, undefined, 'no shots key at all: the pass never ran, which is not the same as finding nothing');
  assert.equal(bytesUnder(shotsDir()), 0);
  assert.equal(existsSync(shotsDir()), false, 'not even an empty directory is created');

  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  assert.equal(db.shotsAt(1).rows.length, 0, 'and no row was written either');
  db.close();

  // and asking for that sync's picture says so rather than serving the live file
  const r = await image(`node=${encodeURIComponent(screenNode())}&sync=1`);
  assert.equal(r.status, 404);
  const body = JSON.parse(await r.text());
  assert.equal(body.absent, true);
  assert.equal(body.sync, 1);
  assert.match(body.error, /no design shot was kept/);
  assert.match(body.error, /not what that sync saw/);
});

test('two syncs, a changed screen PNG: two digests, both served, each the picture its sync saw', async () => {
  const node = screenNode();
  writeSettings(true); // the flag goes on

  const two = await sync(); // sync 2 — the original picture
  assert.equal(two.shots.screens, 1, 'one screen in this manifest carries an image');
  assert.equal(two.shots.captured, 1);
  assert.equal(two.shots.files, 1);
  assert.ok(two.shots.written > 0, 'the first capture of a picture writes it');

  writeFileSync(join(app, 'docs', 'design', 'screens', 'scr-01.png'), png(2)); // the design changes
  const three = await sync(); // sync 3 — the new picture
  assert.equal(three.shots.captured, 1);
  assert.ok(three.shots.written > 0, 'a changed picture is a second file');

  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  const a = db.shotAt(node, 2)!;
  const b = db.shotAt(node, 3)!;
  db.close();
  assert.ok(a && b, 'both syncs retained a shot');
  assert.notEqual(a.digest, b.digest, 'a changed picture is a changed content address');
  assert.equal(a.source, 'docs/design/screens/scr-01.png');
  assert.equal(a.kind, 'file');

  // both are served, and each is the bytes that sync saw
  const rA = await image(`node=${encodeURIComponent(node)}&sync=2`);
  const rB = await image(`node=${encodeURIComponent(node)}&sync=3`);
  assert.equal(rA.status, 200);
  assert.equal(rB.status, 200);
  assert.equal(rA.headers.get('content-type'), 'image/png');
  const bytesA = Buffer.from(await rA.arrayBuffer());
  const bytesB = Buffer.from(await rB.arrayBuffer());
  assert.deepEqual(bytesA, png(1), 'sync 2 still serves the picture sync 2 saw');
  assert.deepEqual(bytesB, png(2));
  assert.notDeepEqual(bytesA, bytesB);
  // the header names which picture this is, so a reader is never guessing — and it is ASCII,
  // because a header value is latin-1 on the wire and a HUD dot would arrive as mojibake
  const stamp = rA.headers.get('x-farsight-shot') ?? '';
  assert.equal(stamp, `${a.digest}; source="docs/design/screens/scr-01.png"`);
  assert.ok(!/[^\x20-\x7e]/.test(stamp), 'the stamp carries no byte a latin-1 header cannot hold');

  // exactly two files on disk for the two distinct pictures — content addressing, not per-sync copies
  assert.equal(readdirSync(shotsDir()).length, 2);
});

test('an unchanged picture across a further sync is a new row and no new bytes', async () => {
  const node = screenNode();
  const before = bytesUnder(shotsDir());
  const out = await sync(); // sync 4 — nothing about the design changed
  assert.equal(out.shots.captured, 1);
  assert.equal(out.shots.written, 0, 'the bytes were already stored under this digest');
  assert.equal(bytesUnder(shotsDir()), before);
  assert.equal(readdirSync(shotsDir()).length, 2);

  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  assert.equal(db.shotAt(node, 4)!.digest, db.shotAt(node, 3)!.digest, 'same picture, same address');
  assert.equal(db.shotsOf(node).length, 3, 'syncs 2, 3 and 4 each have their own row');
  db.close();
});

test('a screen the manifest gives no image has no shot, and is counted as no screen at all', async () => {
  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  assert.equal(db.shotAt(noImageNode(), 3), undefined);
  db.close();
  const r = await image(`node=${encodeURIComponent(noImageNode())}&sync=3`);
  // it never reaches the shot branch: the node has no design image to ask about
  assert.equal(r.status, 404);
  assert.match(JSON.parse(await r.text()).error, /no design image for this node/);
});

test('a sync that never captured is not lent the neighbouring sync\'s picture', async () => {
  const node = screenNode();
  const r = await image(`node=${encodeURIComponent(node)}&sync=1`);
  assert.equal(r.status, 404, 'sync 1 ran with the flag off, so it knows nothing');
  const body = JSON.parse(await r.text());
  assert.equal(body.absent, true);
  // a sync that does not exist at all is the same honest answer, not a crash
  const far = await image(`node=${encodeURIComponent(node)}&sync=9999`);
  assert.equal(far.status, 404);
  assert.equal(JSON.parse(await far.text()).absent, true);
});

test('?sync= widens nothing: it is a number or a 400, and it never falls through to the live file', async () => {
  const node = screenNode();
  for (const bad of ['latest', '../../etc/passwd', '2; DROP TABLE sync_shot', '-1', '', '2.5']) {
    const r = await image(`node=${encodeURIComponent(node)}&sync=${encodeURIComponent(bad)}`);
    const body = await r.text();
    assert.equal(r.status, 400, `sync=${JSON.stringify(bad)} answered ${r.status}: ${body.slice(0, 200)}`);
    assert.match(JSON.parse(body).error, /sync must be a sync number/);
  }
  // `sync:N` is accepted, because that is how every other surface spells a sync
  const ok = await image(`node=${encodeURIComponent(node)}&sync=sync:3`);
  assert.equal(ok.status, 200);
  // and with no sync at all the endpoint is exactly what it was before H8: today's file
  const live = await image(`node=${encodeURIComponent(node)}`);
  assert.equal(live.status, 200);
  assert.deepEqual(Buffer.from(await live.arrayBuffer()), png(2), 'the live branch reads the repository, not the cache');
});

test('a row whose file was pruned from the cache says that, rather than serving another screen', async () => {
  const node = screenNode();
  const db = new SnapshotDb(join(work, '.farsight', 'farsight.db'));
  const row = db.shotAt(node, 2)!;
  db.close();
  rmSync(join(shotsDir(), `${row.digest}.${row.ext}`));

  const r = await image(`node=${encodeURIComponent(node)}&sync=2`);
  assert.equal(r.status, 404);
  const body = JSON.parse(await r.text());
  assert.equal(body.absent, true);
  assert.equal(body.digest, row.digest);
  assert.match(body.error, /no longer in \.farsight\/cache\/shots/);
});
