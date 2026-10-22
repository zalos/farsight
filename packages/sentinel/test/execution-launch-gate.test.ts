// The launch gate: a built-in worker process runs no adapter code until it reads its authorization line, and the
// supervisor writes that line only after recording the worker's pid. These tests start the real gate with a marker
// adapter (it writes one file the moment it loads) and check the adapter never loads without the exact line, however
// late the process starts, including the review's case: a pid-less record that recovery has already settled.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntentFiles, launchAuthorization, recoverStore, tokenArgument, WorkerFiles } from '../dist/execution/recovery.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';

const GATE = new URL('../dist/execution/launch-gate.js', import.meta.url).href;
const roots: string[] = [];
after(() => roots.forEach(removeScratch));

function markerAdapter() {
  const s = scratch('gate');
  roots.push(s.root);
  const marker = join(s.root, 'adapter-ran');
  const module = join(s.root, 'adapter.mjs');
  writeFileSync(module, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  return { root: s.root, marker, module };
}
const launch = (module: string, token: string, input?: string) =>
  spawnSync(process.execPath, ['--import', GATE, module, tokenArgument(token)], { input: input ?? '', env: {}, timeout: 20_000 });

test('the exact authorization line loads the adapter', () => {
  const a = markerAdapter();
  const token = randomUUID();
  const r = launch(a.module, token, launchAuthorization(token));
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(existsSync(a.marker), 'the adapter ran');
});

test('end of stdin, a wrong token, a partial line or no token argument: refused before the adapter loads', () => {
  const token = randomUUID();
  for (const [what, input, arg] of [
    ['end of stdin', '', token],
    ['another token', launchAuthorization(randomUUID()), token],
    ['a partial line', launchAuthorization(token).slice(0, 20), token],
    ['no newline', launchAuthorization(token).trimEnd(), token],
  ] as const) {
    const a = markerAdapter();
    const r = launch(a.module, arg, input);
    assert.equal(r.status, 78, `${what}: refused`);
    assert.equal(existsSync(a.marker), false, `${what}: the adapter never loaded`);
    assert.equal(r.stdout.byteLength, 0, `${what}: nothing written to the protocol stream`);
  }
  const a = markerAdapter();
  const r = spawnSync(process.execPath, ['--import', GATE, a.module], { input: launchAuthorization(token), env: {}, timeout: 20_000 });
  assert.equal(r.status, 78, 'no token argument: refused');
  assert.equal(existsSync(a.marker), false);
});

test('a write end held open but never written (a stopped sibling): the process waits in the gate, adapter never loaded', async () => {
  const a = markerAdapter();
  const token = randomUUID();
  const child = spawn(process.execPath, ['--import', GATE, a.module, tokenArgument(token)], { stdio: ['pipe', 'ignore', 'ignore'], env: {} });
  const exited = new Promise(r => child.on('close', r));
  // The bytes before the line, and a line for another token, do not open the gate either.
  child.stdin.write('sentinel-launch ');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'still waiting in the gate');
  assert.equal(existsSync(a.marker), false, 'the adapter has not loaded');
  child.kill('SIGKILL');
  await exited;
  assert.equal(existsSync(a.marker), false);
});

test('review case: recovery settles a pid-less record, then a late child for it execs; it never runs adapter code', async () => {
  const a = markerAdapter();
  const store = await storeIn(a.root);
  const token = randomUUID();
  try {
    // Journaled before spawn and never given its pid; its coordinator (another epoch) is gone.
    new WorkerFiles(store.storePath).record({ attempt: 'att-prespawn', store: store.storeId, epoch: 'epoch-earlier', pid: 0, token, kernelStart: '' });
    const report = await recoverStore(store, { intents: new IntentFiles(store.storePath), workers: new WorkerFiles(store.storePath) });
    assert.equal(report.clean, true);
    assert.deepEqual(new WorkerFiles(store.storePath).list().records, [], 'settled: no process carried the token');
  } finally { store.close(); }
  // Only now does the delayed child exec, carrying the token. Nobody alive can write its authorization.
  const r = launch(a.module, token);
  assert.equal(r.status, 78);
  assert.equal(existsSync(a.marker), false, 'the late child ran no adapter code');
});
