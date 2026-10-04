// `farsight journeys` — the built dist/cli.js against a copy of examples/invoice-app in a temp
// directory: the text is core journeyTreeLines over journeyTree line for line, the filters narrow
// it, --json is the JourneyTree (the document GET /api/journeys and the MCP tool return), and
// the usage names the command. Nothing here touches the workspace graph or ports 4477 / 4478.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, journeyTree, journeyTreeLines, type JourneyTree } from '@farsight/core';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');

let work: string;
let graph: string;
let tree: JourneyTree;

function run(args: string[], g = graph) {
  const r = spawnSync(process.execPath, [cli, ...args, '--graph', g], { cwd: work, encoding: 'utf8' });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

before(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-journeys-')));
  const repo = join(work, 'invoice-app');
  graph = join(work, 'graph.json');
  cpSync(join(repoRoot, 'examples/invoice-app'), repo, { recursive: true });
  const ingest = spawnSync(process.execPath, [cli, 'ingest', repo, '--repo', 'invoice-app', '--out', graph], { cwd: work, encoding: 'utf8' });
  assert.equal(ingest.status, 0, ingest.stderr);
  const data = JSON.parse(readFileSync(graph, 'utf8'));
  tree = journeyTree(buildIndex(data.nodes, data.edges), data.meta.journeys, null);
});

after(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ } });

test('journeys: the fold as text, persona then group then journey, in declared order', () => {
  const r = run(['journeys']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trimEnd(), journeyTreeLines(tree).join('\n'));
  assert.match(r.out, /^## Billing — 3 journeys · 1 of 3 journeys built/m);
  assert.match(r.out, /^### Review and send — 1 journey/m);
});

test('journeys --persona / --group narrow it; --json is the JourneyTree', () => {
  const ops = run(['journeys', '--persona', 'ops']);
  assert.match(ops.out, /^1 journey · 1 persona · 1 group /);
  assert.ok(!ops.out.includes('## Billing'));
  const invoices = run(['journeys', '--group', 'Invoices']);
  assert.match(invoices.out, /^2 journeys · 1 persona · 1 group /);
  const json = JSON.parse(run(['journeys', '--json']).out);
  assert.deepEqual(json, JSON.parse(JSON.stringify(tree)));
  assert.equal(run(['journeys', '--repo', 'other']).out.trim(), 'no journeys in scope — a design manifest (docs/design/screens.json) declares them as flows; design_guide explains how');
});

test('the usage names the command, and a missing graph says so', () => {
  assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /farsight journeys \[--repo name\]/);
  const r = run(['journeys'], join(work, 'nope.json'));
  assert.equal(r.status, 1);
  assert.match(r.err, /no graph at/);
});
