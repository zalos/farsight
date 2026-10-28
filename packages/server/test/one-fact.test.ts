/**
 * The one-fact harness (lane moves, 2026-10-13; the qa proposal's F1 + F2): five surfaces asked one question — *what
 * moves an invoice to paid* — must give one answer. The invoice-app fixture holds the reference app's shape: the one
 * function that writes `paid` is called from two actions, and one call sits under `if (INTENT_MARKS_PAID)` where that
 * constant is `false`. Every surface credits the live action (*mark paid*), names the switched-off one as switched off,
 * and never the other way round: the lifecycle table (`/api/lifecycle`), Ask (`/api/ask`), the walk's hand-off
 * (`/api/tour`), the lanes' move pill (the viewer's `laneLayout` over `/api/journey`) and the gate card (`/api/gate`).
 * Ingests `examples/invoice-app` into a temp directory and serves it on an ephemeral loopback port — never the
 * workspace graph, never 4477 / 4478.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GraphStore, stitchHttp, buildIndex, type GraphIndex } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');
const { laneLayout } = await import(join(repoRoot, 'packages/server/public/app/lib/map-model.js'));

let work: string;
let graphPath: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let index: GraphIndex;

/** An OS-picked loopback port. 4477 / 4478 are live servers — never borrow them. */
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
      const r = await fetch(`http://127.0.0.1:${port}/graph`);
      await r.arrayBuffer();
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-one-fact-')));
  graphPath = join(work, 'graph.json');
  const store = new GraphStore();
  const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
  store.roots[fragment.repo] = fixture;
  store.addFragment(fragment);
  stitchHttp(store);
  store.save(graphPath);
  const { nodes, edges } = store.toJSON();
  index = buildIndex(nodes, edges);
  port = await freePort();
  const boot =
    `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n` +
    `serveGraph(${JSON.stringify(graphPath)}, ${port}, ${JSON.stringify(work)});\n`;
  child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: work,
    env: { ...process.env, MODELHUB_DIR: join(work, 'modelhub'), FIGMA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    childLog += d;
  });
  child.stderr.on('data', (d: string) => {
    childLog += d;
  });
  await waitReady();
});

after(async () => {
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* a temp dir that outlives the run is not a failure */
  }
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: JSON.parse(await r.text()) };
}

const FLOW = 'invoice-app::flow::get-paid';
const TABLE = 'invoice-app::table::invoices';
const LIVE_ROUTE = 'invoice-app::route::POST /invoices/:id/mark-paid';
const OFF_ROUTE = 'invoice-app::route::POST /invoices/:id/payment-intent';
const LIVE_FN = 'invoice-app::src/server/payments.ts::markInvoicePaid';
const OFF_FN = 'invoice-app::src/server/payments.ts::recordPaymentIntent';
const WRITER = 'invoice-app::src/server/payments.ts::settleInvoice';
const LIVE_LABEL = 'Mark the invoice paid once the bank confirms.';
const OFF_LABEL = 'Record how the invoice will be paid.';

test('the graph holds the shape: the call under the false constant is kept, marked inactive, and settleInvoice writes paid', () => {
  const off = (index.out.get(OFF_FN) ?? []).filter((e) => e.kind === 'calls' && e.to === WRITER);
  assert.equal(off.length, 1);
  assert.equal(off[0]!.meta?.inactive, true);
  assert.equal(off[0]!.meta?.whenFlag, 'INTENT_MARKS_PAID');
  const live = (index.out.get(LIVE_FN) ?? []).filter((e) => e.kind === 'calls' && e.to === WRITER);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.meta?.inactive, undefined);
  assert.ok(index.byId.get(TABLE)!.lifecycle!.transitions.some((x) => x.to === 'paid' && x.by === WRITER));
});

test('one fact, five surfaces: mark paid moves the invoice to paid; the payment intent is switched off', async () => {
  const answers: Record<string, { live: string; off: string[] }> = {};

  // 1 · the lifecycle table
  const lc = (await get(`/api/lifecycle?node=${encodeURIComponent(TABLE)}&flow=${encodeURIComponent(FLOW)}`)).body;
  const paid = lc.views[0].rows.find((r: any) => r.status === 'paid');
  assert.equal(paid.movers.length, 1, 'one writer of paid');
  answers.lifecycle = {
    live: paid.movers[0].at?.action,
    off: (paid.movers[0].switchedOff ?? []).map((o: any) => o.action),
  };

  // 2 · Ask
  const a = (await get(`/api/ask?q=${encodeURIComponent('where is an invoice set to paid')}`)).body.answer;
  const where = a.lead.find((l: any) => l.key === 'ask.set.where');
  assert.ok(where, a.lead.map((l: any) => l.text).join(' | '));
  const offLines = a.lead.filter((l: any) => l.key === 'switch.ask.off');
  answers.ask = {
    live: where.vars.action + (where.vars.action.endsWith('.') ? '' : '.'),
    off: offLines.map((l: any) => l.vars.action + '.'),
  };
  assert.ok(where.cites.includes(LIVE_ROUTE), `ask cites the live action: ${where.cites}`);
  assert.ok(!where.cites.includes(OFF_ROUTE));

  // 3 · the walk's hand-off
  const tour = (await get(`/api/tour?flow=${encodeURIComponent(FLOW)}`)).body.tour;
  const hand = tour.stops.filter(
    (s: any) => s.kind === 'handoff' && s.move?.table === TABLE && s.move?.status === 'paid',
  );
  assert.equal(hand.length, 1, 'one hand-off to paid');
  const offClauses = hand[0].clauses.filter((c: any) => c.key === 'switch.tour.off');
  answers.tour = {
    live: hand[0].action.label + (hand[0].action.label.endsWith('.') ? '' : '.'),
    off: offClauses.map((c: any) => c.vars.action + '.'),
  };
  assert.equal(hand[0].action.nodeId, LIVE_ROUTE);

  // 4 · the lanes' move pill (the viewer's model over the journey answer)
  const j = (await get(`/api/journey?entry=${encodeURIComponent(FLOW)}&steps=0`)).body;
  const tree = (await get('/api/journeys')).body.tree;
  const row = tree.personas
    .flatMap((p: any) => p.groups.flatMap((g: any) => g.journeys))
    .find((r: any) => r.nodeId === FLOW);
  const m = laneLayout({ kind: 'journey', journeys: [row], branches: [] }, [], tree, new Map([[FLOW, j]]), {});
  const pill = m.pills.find((p: any) => p.record.id === TABLE && p.status === 'paid');
  assert.ok(pill, 'a pill for paid');
  answers.lanes = { live: pill.action, off: (pill.switchedOff ?? []).map((o: any) => o.label) };
  assert.equal(pill.needs.action, LIVE_ROUTE, 'the pill reads what the move needs from the live action');

  // 5 · the gate card: the status check in front of the move sits on the live action, and the move's action names it
  const mo = j.summary.segments
    .flatMap((s: any) => s.moments)
    .find((x: any) => (x.preconditions?.moves ?? []).some((mv: any) => mv.table === TABLE && mv.to === 'paid'));
  const own = mo.preconditions.preconditions.find((p: any) => p.relation === 'own' && p.field === 'status');
  const card = (await get(`/api/gate?node=${encodeURIComponent(own.id)}`)).body;
  const sits = (card.card ?? card).sitsOn.map((x: any) => x.id);
  assert.ok(sits.includes(LIVE_FN), `the gate in front of paid sits on mark paid: ${sits}`);
  const offMo = j.summary.segments
    .flatMap((s: any) => s.moments)
    .find((x: any) => x.label === OFF_LABEL && x.preconditions);
  answers.gate = {
    live: mo.label,
    off: (offMo?.preconditions?.switchedOff ?? []).filter((x: any) => x.to === 'paid').map(() => offMo.label),
  };

  // one answer
  for (const [surface, ans] of Object.entries(answers)) {
    assert.equal(ans.live, LIVE_LABEL, `${surface} credits ${ans.live}`);
    assert.ok(ans.off.includes(OFF_LABEL), `${surface} names the switched-off path: ${JSON.stringify(ans.off)}`);
    assert.ok(!ans.off.includes(LIVE_LABEL), `${surface} never calls the live path switched off`);
  }
});

test('the writer reader takes the setter and the ternary: draft and open each gain a writer, void stays unwritten', () => {
  const life = index.byId.get(TABLE)!.lifecycle!;
  const into = (st: string) =>
    life.transitions
      .filter((x) => x.to === st)
      .map((x) => `${x.by.split('::').pop()}${x.when ? `?${x.when}` : ''}`)
      .sort();
  assert.deepEqual(into('draft'), ['createInvoice', 'rejectApproval?raisedInError', 'reopenInvoice']);
  assert.deepEqual(into('open'), ['finalizeInvoice', 'rejectApproval?not raisedInError']);
  assert.deepEqual(into('void'), []);
});
