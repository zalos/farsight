/**
 * `farsight impact` — the command, driven as a consumer drives it: the built
 * `dist/cli.js` against a *copy* of `examples/invoice-app` in a temp directory.
 *
 * Three things are under test, and only the first is about the command.
 *
 * 1. **Every printed number is the fold's.** `impactOf` is computed here in
 *    process and compared against what the CLI printed. A second
 *    implementation inside the printer would show up as a mismatch that names
 *    the number.
 * 2. **The honesty rules of the design (§2, §3.5).** No total is printed
 *    anywhere; hop counts are never added; a floor says it is a floor and why;
 *    a capped hop prints *found*, *listed* and what stands behind; *behind* and
 *    *direct* are never swapped; the boot and deferred work are named apart.
 * 3. **The frozen contract.** `--tests --format json` is
 *    `farsight-impact-tests v1`, validated against
 *    `schemas/farsight-impact-tests-v1.schema.json`, with `fallback` and
 *    `unselectable` as the document defines them.
 *
 * Nothing here touches the workspace graph, the fixture on disk, any real
 * snapshot store, or ports 4477 / 4478 (the live dogfood servers).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, impactOf, IMPACT_MAX_HOPS, type GraphEdge, type GraphIndex, type GraphNode } from '@farsight/core';
import { validate } from '../../core/test/validate.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');
const SCHEMA = () => JSON.parse(readFileSync(join(repoRoot, 'schemas/farsight-impact-tests-v1.schema.json'), 'utf8'));

const TABLE = 'invoice-app::table::invoices';

let work: string;
let repo: string;
let graph: string;
let index: GraphIndex;

function run(args: string[], cwd = work) {
  const r = spawnSync(process.execPath, [cli, ...args, '--graph', graph], { cwd, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

before(() => {
  // realpath: macOS /tmp is a symlink, and the CLI compares resolved paths
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-impact-')));
  repo = join(work, 'invoice-app');
  graph = join(work, 'graph.json');
  cpSync(join(repoRoot, 'examples/invoice-app'), repo, { recursive: true });
  const ingest = spawnSync(process.execPath, [cli, 'ingest', repo, '--repo', 'invoice-app', '--out', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(ingest.status, 0, ingest.stderr);
  const data = JSON.parse(readFileSync(graph, 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[] };
  index = buildIndex(data.nodes, data.edges);
});

after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

describe('farsight impact — the text form', () => {
  test('every hop count printed is the fold\'s, and no line adds them up', () => {
    const report = impactOf(index, TABLE, { hops: 3 });
    const r = run(['impact', TABLE, '--hops', '3']);
    assert.equal(r.status, 0, r.err);

    // the headline says each distance once, in the fold's own numbers
    const [hop1, hop2, hop3] = report.hops.map((h) => h.found);
    assert.match(r.out, new RegExp(`${hop1} use it directly · ${hop2} more reach it through those · ${hop3} more at 3 hops`));

    // and every hop's own header carries the same number
    for (const h of report.hops) {
      assert.match(r.out, new RegExp(`hop ${h.hop} — [^(]+\\(${h.found}: `), `hop ${h.hop} header should say ${h.found}`);
      for (const n of h.nodes.slice(0, 3)) assert.ok(r.out.includes(n.name.slice(0, 40)), `${n.name} is missing from the printed hop ${h.hop}`);
    }

    // the sum is the number this design exists to stop printing: it must appear nowhere
    const total = hop1! + hop2! + hop3!;
    assert.ok(!new RegExp(`\\b${total}\\b`).test(r.out), `the printer must never sum the hops (${total} appeared)`);
    assert.ok(!/\btotal\b/i.test(r.out), 'no line may call anything a total');
  });

  test('a floor says so and says why; the reason is the fold\'s own sentence', () => {
    const report = impactOf(index, TABLE, { hops: 2 });
    assert.equal(report.bound, 'floor');
    const r = run(['impact', TABLE, '--hops', '2']);
    assert.match(r.out, /≥ a floor: /);
    assert.ok(r.out.includes(report.uncertainty!.note), 'the printed reason must be the fold\'s note, not a second wording');
  });

  test('the edge\'s own verb, its call site and how it was resolved — never a verb of consequence', () => {
    const report = impactOf(index, TABLE, { hops: 1 });
    const r = run(['impact', TABLE, '--hops', '1']);
    const first = report.hops[0]!.nodes[0]!;
    assert.match(r.out, new RegExp(`${first.via.kind}\\s+${first.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(r.out.includes(`${first.via.loc!.path}:${first.via.loc!.line}`), 'the call site is part of the claim');
    assert.ok(r.out.includes(`${first.via.resolution!.technique} ${first.via.resolution!.confidence}`));
    // §2: reachability is not consequence
    for (const word of ['breaks', 'will break', 'is affected by', 'depends on']) {
      assert.ok(!r.out.toLowerCase().includes(word), `"${word}" claims a change travels; the graph only saw an edge`);
    }
  });

  test('the boot and deferred work are named apart, never counted as dependents', () => {
    const report = impactOf(index, TABLE, { hops: 3 });
    assert.ok(report.excluded.setup.length, 'the fixture must have a setup-origin edge for this to mean anything');
    assert.ok(report.excluded.deferred.length, 'the fixture must have a deferred edge for this to mean anything');
    const r = run(['impact', TABLE, '--hops', '3']);
    for (const n of report.excluded.setup) assert.match(r.out, new RegExp(`start-up, once\\s+${n.name}`));
    for (const n of report.excluded.deferred) assert.match(r.out, new RegExp(`afterwards\\s+${n.name}`));
    const listed = report.hops.flatMap((h) => h.nodes.map((n) => n.nodeId));
    for (const n of [...report.excluded.setup, ...report.excluded.deferred]) {
      assert.ok(!listed.includes(n.nodeId), `${n.name} is an aside, not a hop`);
    }
  });

  test('a capped hop prints found, listed and what stands behind — never a shortened list', () => {
    const full = impactOf(index, TABLE, { hops: 1 });
    const capped = impactOf(index, TABLE, { hops: 1, perHopCap: 3 });
    assert.equal(capped.hops[0]!.found, full.hops[0]!.found, 'a cap hides nothing from the count');
    assert.equal(capped.hops[0]!.nodes.length, 3);
    const r = run(['impact', TABLE, '--hops', '1', '--cap', '3']);
    assert.match(r.out, new RegExp(`${capped.hops[0]!.found} found here, 3 listed`));
    const cut = capped.cutPoints.find((c) => c.reason === 'cap')!;
    assert.match(r.out, new RegExp(`over the cap\\s+${cut.behind} dependent\\(s\\) at hop 1`));
  });

  test('behind and direct are two numbers, and the shared line never swaps them', () => {
    // a rendered UI primitive: the walk meets it, lists it, and does not open it
    const SEED = 'invoice-app::src/ui/fields.tsx::MoneyField';
    const shared = impactOf(index, SEED, { hops: 3 }).cutPoints.filter((c) => c.reason === 'shared');
    assert.ok(shared.length, 'the fixture must have a shared stop for this to mean anything');
    const r = run(['impact', SEED, '--hops', '3']);
    assert.equal(r.status, 0, r.err);
    for (const c of shared) {
      assert.notEqual(c.direct, c.behind, 'the fixture\'s shared stop must have different first-ring and closure counts');
      assert.match(r.out, new RegExp(`shared\\s+${c.name!} — used by ${c.direct}, not opened \\(${c.behind} node`));
      // the one number that must never carry the other's words
      assert.ok(!r.out.includes(`used by ${c.behind}`), '`used by` is the first ring, never the closure');
    }
    // and the stopped node is still listed as a dependent — stopping is not hiding
    assert.ok(r.out.includes(shared[0]!.name!));
    assert.ok(/shared — listed, not opened/.test(r.out));
  });

  test('nothing uses it: an empty answer is an answer, and it uses the absence word', () => {
    const leaf = [...index.byId.values()].find((n) => n.kind === 'test');
    assert.ok(leaf, 'the fixture has test nodes, which nothing depends on');
    const r = run(['impact', leaf!.id]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /none indexed — nothing in this graph uses it/);
  });

  test('downstream asks the same question the other way', () => {
    const r = run(['impact', 'invoice-app::route::POST /invoices', '--direction', 'downstream', '--hops', '1']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /it uses directly/);
  });
});

describe('farsight impact — refusals and resolution', () => {
  test(`a budget past ${IMPACT_MAX_HOPS} hops is refused with a sentence, and exit 1 is usage only`, () => {
    const r = run(['impact', TABLE, '--hops', '9']);
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`--hops takes a whole number from 1 to ${IMPACT_MAX_HOPS}`));
    assert.match(r.err, /describes the application rather than a dependency/);
  });

  test('a name resolves to one node and says what else matched', () => {
    const r = run(['impact', 'invoices', '--hops', '1']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^invoices — invoice-app::table::invoices/m);
  });

  test('a query nothing matches is an error, not a guess', () => {
    const r = run(['impact', 'zzz-nothing-here-zzz']);
    assert.equal(r.status, 1);
    assert.match(r.err, /nothing in the graph matches/);
  });
});

describe('farsight impact --changed', () => {
  test('a changed file becomes every node defined in it, each with its own answer', () => {
    const r = run(['impact', '--changed', 'src/server/invoiceService.ts', '--hops', '1']);
    assert.equal(r.status, 0, r.err);
    const inFile = [...index.byId.values()].filter((n) => n.loc?.path === 'src/server/invoiceService.ts');
    assert.ok(inFile.length > 1, 'the fixture file holds several nodes');
    for (const n of inFile) assert.ok(r.out.includes(`${n.name} — ${n.id}`), `${n.id} should be a seed of its own`);
    assert.ok(r.out.includes('changed in src/server/invoiceService.ts'));
  });

  test('a line range takes only what starts inside it', () => {
    const inFile = [...index.byId.values()].filter((n) => n.loc?.path === 'src/server/invoiceService.ts').sort((a, b) => a.loc!.line - b.loc!.line);
    const first = inFile[0]!;
    const r = run(['impact', '--changed', `src/server/invoiceService.ts:${first.loc!.line}-${first.loc!.line}`, '--hops', '1']);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.out.includes(`${first.name} — ${first.id}`));
    for (const other of inFile.slice(1)) assert.ok(!r.out.includes(`${other.name} — ${other.id}`), `${other.name} starts outside the range`);
  });

  test('a path the graph holds nothing for is said out loud, not silently dropped', () => {
    const r = run(['impact', '--changed', 'src/server/invoiceService.ts', 'docs/nothing-here.md', '--hops', '1']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /nothing in the graph is defined in docs\/nothing-here\.md/);
  });
});

describe('farsight impact --format json', () => {
  test('the bare report is the fold, key for key, and carries no total', () => {
    const r = run(['impact', TABLE, '--hops', '2', '--format', 'json']);
    assert.equal(r.status, 0, r.err);
    const doc = JSON.parse(r.out);
    const report = impactOf(index, TABLE, { hops: 2 });
    assert.deepEqual(Object.keys(doc).sort(), Object.keys(report).sort());
    assert.deepEqual(doc.hops.map((h: { hop: number; found: number }) => [h.hop, h.found]), report.hops.map((h) => [h.hop, h.found]));
    assert.equal('total' in doc, false);
    assert.equal(doc.bound, report.bound);
  });

  test('--json is the same document as --format json', () => {
    const a = JSON.parse(run(['impact', TABLE, '--hops', '1', '--json']).out);
    const b = JSON.parse(run(['impact', TABLE, '--hops', '1', '--format', 'json']).out);
    assert.deepEqual(a.hops, b.hops);
  });

  test('--tests emits farsight-impact-tests v1, valid against its schema', () => {
    const r = run(['impact', TABLE, '--hops', '2', '--tests', '--format', 'json']);
    assert.equal(r.status, 0, r.err);
    const doc = JSON.parse(r.out);
    assert.equal(doc.schema, 'farsight-impact-tests v1');
    assert.deepEqual(validate(doc, SCHEMA()), []);
    // the envelope's identity is the matrix's, so an artefact from each can be joined
    assert.ok(doc.identity.farsight.startsWith('farsight '));
    assert.equal(doc.identity.source_digest['invoice-app'].length, 12);
    // `select` is what a job can run; `bound` says whether it may be trusted as complete
    assert.ok(Object.keys(doc.select).length, 'the fixture has runnable tests');
    assert.equal(doc.bound, 'floor');
  });

  test('fallback is never implied: run-all comes with the sentence that earned it', () => {
    const r = run(['impact', TABLE, '--hops', '1', '--tests', '--format', 'json']);
    const doc = JSON.parse(r.out);
    if (doc.unselectable.length) {
      assert.equal(doc.fallback, 'run-all');
      assert.match(doc.fallback_reason, /run the whole suite: /);
      for (const u of doc.unselectable) {
        assert.ok(['no covers edge', 'declared only', 'inactive', 'run-level only'].includes(u.reason), `${u.reason} is not one of the closed words`);
      }
    } else {
      assert.equal(doc.fallback, null);
      assert.equal(doc.fallback_reason, null);
    }
  });

  test('several changed files fold into one envelope with one hop list', () => {
    const r = run(['impact', '--changed', 'src/server/invoiceService.ts', 'src/server/routes.ts', '--hops', '1', '--tests', '--format', 'json']);
    assert.equal(r.status, 0, r.err);
    const doc = JSON.parse(r.out);
    assert.deepEqual(validate(doc, SCHEMA()), []);
    assert.ok(doc.seeds.length > 2, 'both files contribute seeds');
    for (const s of doc.seeds) assert.equal(s.from, 'hunk');
    // a node is listed once, at its nearest distance
    const ids = doc.hops.flatMap((h: { nodes: { id: string }[] }) => h.nodes.map((n) => n.id));
    assert.equal(ids.length, new Set(ids).size, 'a node appears at one hop only');
  });
});
