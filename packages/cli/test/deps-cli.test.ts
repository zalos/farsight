// `farsight deps list` and `farsight deps where` — the built dist/cli.js against a copy of
// examples/invoice-app in a temp directory. Every printed number is the fold's (packagesOf /
// importersOf computed here in process), --json says it is farsight-deps v0 and not frozen, and a
// graph without package nodes, an unknown package and an unknown subcommand all say so.
// Nothing here touches the workspace graph, the fixture on disk or ports 4477 / 4478.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, packagesOf, importersOf, type GraphEdge, type GraphIndex, type GraphNode } from '@farsight/core';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');

let work: string;
let graph: string;
let index: GraphIndex;

function run(args: string[], g = graph) {
  const r = spawnSync(process.execPath, [cli, ...args, '--graph', g], { cwd: work, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

before(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-deps-')));
  const repo = join(work, 'invoice-app');
  graph = join(work, 'graph.json');
  cpSync(join(repoRoot, 'examples/invoice-app'), repo, { recursive: true });
  const ingest = spawnSync(process.execPath, [cli, 'ingest', repo, '--repo', 'invoice-app', '--out', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(ingest.status, 0, ingest.stderr);
  const data = JSON.parse(readFileSync(graph, 'utf8')) as { nodes: GraphNode[]; edges: GraphEdge[] };
  index = buildIndex(data.nodes, data.edges);
});

after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

test('deps list: the packages count with its split, one line per package with the fold’s numbers', () => {
  const r = run(['deps', 'list']);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^8 packages across every source in scope \(7 third-party · 1 from this workspace\)/);
  for (const row of packagesOf(index).rows) {
    const line = r.out.split('\n').find((l) => l.trimStart().startsWith(row.name + ' '))!;
    assert.ok(line, row.name);
    assert.match(line, new RegExp(`${row.importers.n}\\s+${row.journeys.n}$`), `${row.name}: ${line}`);
  }
  assert.match(r.out, /@invoice\/plumbing\s+invoice-app\s+workspace\s+\(alias\)/);
  assert.match(r.out, /the runtime's own modules, never counted as packages: node:fs, node:path, node:url/);
  const third = run(['deps', 'list', '--third-party']);
  assert.match(third.out, /^7 packages/);
  assert.ok(!third.out.includes('@invoice/plumbing'));
  assert.match(run(['deps', 'list', '--workspace']).out, /^1 package across/);
});

test('deps list --json is farsight-deps v0, says it is not frozen, and carries the fold', () => {
  const r = run(['deps', 'list', '--json']);
  assert.equal(r.status, 0, r.err);
  const doc = JSON.parse(r.out);
  assert.deepEqual([doc.format, doc.version, doc.frozen], ['farsight-deps', 0, false]);
  assert.deepEqual(doc.rows, JSON.parse(JSON.stringify(packagesOf(index).rows)));
  assert.equal(doc.packages.n, 8);
});

test('deps where: every importing file with its line and specifier, and the code that uses it', () => {
  const r = run(['deps', 'where', 'react']);
  assert.equal(r.status, 0, r.err);
  const fold = importersOf(index, 'invoice-app::package::react')!;
  assert.match(r.out, /^react · third-party · \^18\.3\.1 · invoice-app/);
  assert.match(r.out, new RegExp(`${fold.importers.n} files import it for this package · 4 journeys reach it — `));
  for (const i of fold.groups.flatMap((g) => g.importers)) assert.ok(r.out.includes(`${i.path}:${i.line}  react`), i.path);
  assert.match(r.out, /used by CreateInvoiceForm \(component\) at line 11/);
  const json = JSON.parse(run(['deps', 'where', 'date-fns', '--json']).out);
  assert.equal(json.format, 'farsight-deps');
  assert.equal(json.groups[0].importers[0].path, 'src/server/plumbing/format.ts');
});

test('an unknown package, an unknown subcommand and a graph with no package nodes each say what is wrong', () => {
  const unknown = run(['deps', 'where', 'left-pad']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /no package left-pad in this graph/);
  const sub = run(['deps', 'tree']);
  assert.equal(sub.status, 1);
  assert.match(sub.err, /unknown deps subcommand: tree \(list \| where\)/);
  const data = JSON.parse(readFileSync(graph, 'utf8'));
  data.nodes = data.nodes.filter((n: GraphNode) => n.kind !== 'package');
  const old = join(work, 'old.json');
  writeFileSync(old, JSON.stringify(data));
  const r = run(['deps', 'list'], old);
  assert.equal(r.status, 0);
  assert.match(r.out, /no package nodes in this graph/);
});
