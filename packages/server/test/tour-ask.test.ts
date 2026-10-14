/**
 * Walk me through it, and ask (round 2026-10-10, proposal 8): core `tourOf()`, `ask()` and `pathBetween()` on the
 * invoice-app fixture — every clause cites node ids the graph holds, a clause with a number carries its `Counted`, a
 * clause with an evidence word carries the one verdict — and `GET /api/tour` / `GET /api/ask`, which serve the same
 * folds. Ingests `examples/invoice-app` into a temp directory and serves it on an ephemeral loopback port — never the
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
import { GraphStore, stitchHttp, buildIndex, countedProblems, tourOf, tourLines, ask, askLines, askShapeOf, askExample, suggestQuestions, pathBetween, ASK_SHAPES, COUNT_SCOPES, STRINGS, type GraphIndex, type GraphMeta, type TourClause } from '@farsight/core';
import { ingestRepo } from '@farsight/parsers';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDist = pathToFileURL(join(repoRoot, 'packages/server/dist/index.js')).href;
const fixture = join(repoRoot, 'examples/invoice-app');

let work: string;
let graphPath: string;
let port: number;
let child: ChildProcessWithoutNullStreams;
let childLog = '';
let index: GraphIndex;
let meta: GraphMeta;

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
    } catch (err) { last = (err as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server never answered on port ${port} (${last}):\n${childLog}`);
}

before(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-tour-ask-')));
  graphPath = join(work, 'graph.json');
  const store = new GraphStore();
  const fragment = await ingestRepo(fixture, { repoName: 'invoice-app' });
  store.roots[fragment.repo] = fixture;
  store.addFragment(fragment);
  stitchHttp(store);
  store.save(graphPath);
  const { nodes, edges } = store.toJSON();
  index = buildIndex(nodes, edges);
  meta = store.meta;
  port = await freePort();
  const boot = `const { serveGraph } = await import(${JSON.stringify(serverDist)});\n`
    + `serveGraph(${JSON.stringify(graphPath)}, ${port}, ${JSON.stringify(work)});\n`;
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

/* eslint-disable @typescript-eslint/no-explicit-any */
async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: JSON.parse(await r.text()) };
}

/** Identifier-shaped tokens — the e2e identifier walk's list (journey-numbers.pw.spec.ts). */
const IDENTIFIER = /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Z0-9]+_[A-Z0-9_]+\b|(?:^|[\s(])\/[\w.:{}-]+|\b(?:GET|POST|PUT|PATCH|DELETE)\b|\b[\w-]+\.(?:spec|test|pw)\b|\.(?:tsx?|jsx?|mjs|json)\b/;

/** What every clause owes its reader: real citations, its number's Counted, its evidence word's verdict. */
function clauseProblems(c: TourClause, where: string, opts: { cites?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.cites !== false && !c.cites.length) out.push(`${where}: cites nothing`);
  for (const id of c.cites) if (!index.byId.has(id)) out.push(`${where}: cites ${id}, which is not in the graph`);
  if (!STRINGS[c.key]) out.push(`${where}: ${c.key} is not in the catalog`);
  if (c.bizKey && !STRINGS[c.bizKey]) out.push(`${where}: ${c.bizKey} is not in the catalog`);
  // a number in the sentence is a Counted: the {count} fill is the Counted's own words, and the Counted is sound
  if ('count' in c.vars) {
    if (!c.counted) out.push(`${where}: prints {count} with no Counted`);
    else out.push(...countedProblems(c.counted, where));
  }
  // an evidence word in the sentence is the one verdict, with the cases it counts as a sound Counted
  if ('word' in c.vars && c.role === 'verdict') {
    if (!c.evidence) out.push(`${where}: prints an evidence word with no verdict`);
    else out.push(...countedProblems(c.evidence.runs, `${where}.evidence.runs`));
  }
  if (c.evidence) out.push(...countedProblems(c.evidence.runs, `${where}.evidence.runs`));
  if (/\{\w+\}/.test(c.text) || /\{\w+\}/.test(c.biz)) out.push(`${where}: an unfilled placeholder in "${c.text}"`);
  return out;
}

test('tourOf walks the storyline: a stop per screen (each once) and per hand-off, every clause cited', () => {
  const tour = tourOf(index, 'invoice', { metas: meta.journeys })!;
  assert.ok(tour, 'the fixture declares the invoice storyline');
  assert.equal(tour.derived, true);
  assert.deepEqual(tour.stops.map((s) => `${s.kind}:${s.kind === 'screen' ? s.screen.name : s.move!.status}`),
    ['screen:New invoice', 'handoff:draft', 'screen:Invoice list', 'handoff:open', 'screen:Discard draft']);
  assert.deepEqual(countedProblems(tour.counted.stops, 'stops'), []);
  assert.equal(tour.counted.stops.n, tour.stops.length);
  assert.equal(tour.counted.stops.scope, 'count.scope.storyline');
  const bad: string[] = [];
  for (const s of tour.stops) {
    assert.equal(s.prev, s.n > 1 ? s.n - 1 : null);
    assert.equal(s.next, s.n < tour.stops.length ? s.n + 1 : null);
    s.clauses.forEach((c, i) => bad.push(...clauseProblems(c, `stop ${s.n} clause ${i} (${c.key})`)));
    for (const id of s.referenced) assert.ok(tour.nodes[id], `stop ${s.n}: ${id} is named in nodes`);
    // the business register names no code
    for (const c of s.clauses) { const m = IDENTIFIER.exec(c.biz); if (m) bad.push(`stop ${s.n} (${c.key}): business prints "${m[0]}" — ${c.biz}`); }
    for (const w of [s.title.biz, s.sub.biz]) { const m = IDENTIFIER.exec(w); if (m) bad.push(`stop ${s.n} heading: business prints "${m[0]}"`); }
  }
  assert.deepEqual(bad, []);
  // the move to open checks nothing, and says so; a clause that refers back names the stop
  const open = tour.stops[3]!;
  assert.ok(open.clauses.some((c) => c.warn && c.key === 'tour.handoff.unchecked'));
  assert.equal(open.move!.checked, false);
  assert.ok(open.clauses.some((c) => c.role === 'need' && c.evidence), 'each precondition carries the gate card\'s verdict');
  const after = tour.stops[4]!.clauses.find((c) => c.key === 'tour.ref.after')!;
  assert.equal(after.refers, 4);
  assert.match(after.text, /\(stop 4\)/);
  // the business register prints the persona's word for a status
  assert.equal(open.title.biz, 'The invoice becomes Sent');
  assert.equal(open.title.text, 'The invoice becomes open');
  // a designed, not-built screen has no verdict
  assert.ok(tour.stops[4]!.clauses.some((c) => c.key === 'tour.screen.notBuilt'));
  // a journey alone walks too, scoped to the journey
  const one = tourOf(index, 'invoice-app::flow::new-invoice', { metas: meta.journeys })!;
  assert.equal(one.target.kind, 'flow');
  assert.equal(one.counted.stops.scope, 'journey.scopeAll');
  assert.equal(tourOf(index, 'no-such-thing', { metas: meta.journeys }), undefined);
  // the text form cites in backticks, and the business form not at all
  assert.match(tourLines(tour).join('\n'), /`invoice-app::src\/server\/invoiceService\.ts::finalizeInvoice`/);
  assert.equal(/`/.test(tourLines(tour, { business: true }).join('\n')), false);
});

test('pathBetween: the shortest chain the graph knows, hop by hop, or none', () => {
  const p = pathBetween(index, 'invoice-app::page::/invoices', 'invoice-app::table::invoices')!;
  assert.ok(p);
  assert.equal(p.hops.length, p.nodes.length - 1);
  assert.equal(p.counted.n, p.hops.length);
  assert.deepEqual(countedProblems(p.counted, 'path'), []);
  assert.equal(p.hops[0]!.kind, 'renders');
  assert.equal(p.hops.at(-1)!.kind, 'reads');
  for (const id of p.nodes) assert.ok(index.byId.has(id));
  // each hop is an edge of the graph
  for (const h of p.hops) assert.ok((index.out.get(h.from) ?? []).some((e) => e.to === h.to && e.kind === h.kind), `${h.from} ${h.kind} ${h.to}`);
  assert.equal(pathBetween(index, 'invoice-app::table::invoices', 'invoice-app::page::/invoices'), null, 'a record reaches no page');
  assert.equal(pathBetween(index, 'invoice-app::page::/invoices', 'nope'), null);
  assert.ok(COUNT_SCOPES.includes('count.scope.path'));
});

test('ask: the four shapes, from the graph, every line cited — and the shapes again for anything else', () => {
  assert.deepEqual([...ASK_SHAPES], ['set', 'guards', 'path', 'proves', 'who', 'configure', 'happens']);
  const all: [string, TourClause][] = [];
  const lines = (a: ReturnType<typeof ask>) => [...a.lead, ...a.sections.flatMap((s) => s.rows)];

  const set = ask(index, 'where is an invoice set to open, and what must be true first?', { metas: meta.journeys });
  assert.equal(set.shape, 'set');
  assert.equal(set.derived, true);
  assert.match(set.lead[0]!.text, /^open is written by finalizeInvoice at src\/server\/invoiceService\.ts:\d+\.$/);
  assert.match(set.lead[1]!.text, /Finalize invoice.*Invoice list/);
  const must = set.sections.find((s) => s.key === 'ask.sec.must')!.rows;
  assert.ok(must.some((c) => c.warn), 'the move checks nothing, and the answer says so');
  assert.ok(must.filter((c) => c.role === 'need').length >= 2, 'the scope and the line-item rule');
  const proven = set.sections.find((s) => s.key === 'ask.sec.proven')!.rows;
  assert.equal(proven[0]!.evidence!.skipped, 1, 'the one case was skipped, and the answer does not flatter it');
  assert.equal(proven[0]!.evidence!.runs.scope, 'count.scope.node');
  assert.ok(set.path && set.path.hops.length >= 4);
  assert.ok(set.doors.some((d) => d.kind === 'gate') && set.doors.some((d) => d.kind === 'map'));
  for (const c of lines(set)) all.push(['set', c]);

  const guards = ask(index, 'what guards Finalize invoice', { metas: meta.journeys });
  assert.equal(guards.shape, 'guards');
  assert.equal(guards.sections[0]!.rows.length, guards.lead[0]!.counted!.n);
  for (const c of lines(guards)) all.push(['guards', c]);

  const path = ask(index, 'how does Invoice list reach invoices?', { metas: meta.journeys });
  assert.equal(path.shape, 'path');
  assert.equal(path.path!.to, 'invoice-app::table::invoices');
  for (const c of lines(path)) all.push(['path', c]);

  const proves = ask(index, 'what proves Invoice list', { metas: meta.journeys });
  assert.equal(proves.shape, 'proves');
  assert.ok(proves.sections[0]!.rows.length >= 1);
  for (const c of lines(proves)) all.push(['proves', c]);

  const bad: string[] = [];
  all.forEach(([shape, c], i) => bad.push(...clauseProblems(c, `${shape} line ${i} (${c.key})`)));
  for (const [shape, c] of all) { const m = IDENTIFIER.exec(c.biz); if (m) bad.push(`${shape} (${c.key}): business prints "${m[0]}" — ${c.biz}`); }
  assert.deepEqual(bad, []);
  for (const a of [set, guards, path, proves]) for (const id of Object.keys(a.nodes)) assert.ok(index.byId.has(id));

  const other = ask(index, 'tell me a joke', { metas: meta.journeys });
  assert.equal(other.shape, 'unknown');
  assert.deepEqual(other.shapes, ASK_SHAPES.map((s) => `ask.shape.${s}`));
  assert.match(askLines(other).join('\n'), /how does <A> reach <B>/);
  assert.equal(askShapeOf('what proves the billing:admin scope')!.shape, 'proves');

  // the one extension point for a model: beside the cited lines, labelled, never instead of them
  const phrased = ask(index, 'what guards Finalize invoice', { metas: meta.journeys, phrase: (a) => `${a.lead.length} lines` });
  assert.deepEqual(phrased.phrased, { text: '1 lines', by: 'model' });
  assert.deepEqual(phrased.lead, guards.lead);
  assert.match(askLines(phrased).join('\n'), /phrased by a model/);
});

test('ask, swarm round 3: did you mean from the question’s nouns, the part it picked named beside the others, the example from this graph', () => {
  // a plain question in no shape: the nearest shape filled with its nouns, a status this graph declares
  const who = ask(index, 'opening invoices quickly', { metas: meta.journeys });
  assert.equal(who.shape, 'unknown');
  assert.equal(who.suggest![0], 'where is invoice set to open, and what must be true first?');
  assert.match(askLines(who).join('\n'), /Did you mean/);
  // outsider round (F7): a question in a shape's other words is read as that shape, and the reading printed first
  const opens = ask(index, 'who opens an invoice', { metas: meta.journeys });
  assert.equal(opens.shape, 'who');
  assert.equal(opens.reworded, 'who may open an invoice?');
  assert.match(askLines(opens).join('\n'), /I read that as: “who may open an invoice\?”[\s\S]*billing:admin/);
  // every suggestion is a question Ask answers
  for (const q of who.suggest!) assert.notEqual(ask(index, q, { metas: meta.journeys }).shape, 'unknown', q);
  // the record-and-status question in the guards shape is the set shape's question, never an action's checks
  const must = ask(index, 'what must be true before an invoice is open', { metas: meta.journeys });
  assert.equal(must.shape, 'set');
  // words that name two parts: the answer says which it read them as, and lists the other
  const twin = ask(index, 'which tests reach finalizeInvoice', { metas: meta.journeys });
  const picked = twin.lead.find((c) => c.key === 'ask.picked');
  assert.ok(picked, 'two finalizeInvoice functions: the answer names its pick');
  assert.equal(picked!.counted!.scope, 'count.scope.question');
  assert.ok(picked!.cites.length >= 2);
  // the example names a status the graph declares, and Ask answers it
  const ex = askExample(index)!;
  assert.match(ex, /^where is .+ set to .+, and what must be true first\?$/);
  assert.equal(ask(index, ex, { metas: meta.journeys }).shape, 'set');
  assert.deepEqual(suggestQuestions(index, 'zzz qqq'), []);
});

test('GET /api/tour and GET /api/ask serve the same folds', async () => {
  const t = await get('/api/tour?storyline=invoice');
  assert.equal(t.status, 200);
  assert.equal(t.body.tour.derived, true);
  assert.equal(t.body.tour.stops.length, 5);
  assert.equal((await get('/api/tour?flow=invoice-app::flow::new-invoice')).body.tour.target.kind, 'flow');
  assert.equal((await get('/api/tour?storyline=nope')).status, 404);
  assert.equal((await get('/api/tour')).status, 400);
  const a = await get('/api/ask?q=' + encodeURIComponent('where is an invoice set to open, and what must be true first?'));
  assert.equal(a.status, 200);
  assert.equal(a.body.answer.shape, 'set');
  assert.equal(a.body.answer.derived, true);
  assert.equal((await get('/api/ask')).status, 400);
  assert.equal((await get('/api/ask?example=1')).body.example, askExample(index));
});
