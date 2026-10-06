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
  assert.match(ops.out, /^1 journey · 1 storyline · 1 persona · 1 group /);
  assert.ok(!ops.out.includes('## Billing'));
  const invoices = run(['journeys', '--group', 'Invoices']);
  assert.match(invoices.out, /^2 journeys · 1 storyline · 1 persona · 1 group /);
  const json = JSON.parse(run(['journeys', '--json']).out);
  assert.deepEqual(json, JSON.parse(JSON.stringify(tree)));
  assert.equal(run(['journeys', '--repo', 'other']).out.trim(), 'no journeys in scope — a design manifest (docs/design/screens.json) declares them as flows; design_guide explains how');
});

test('journeys --storyline: that storyline\'s steps first, under the personas only its journeys; an unknown one fails', () => {
  const r = run(['journeys', '--storyline', 'invoice']);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^3 journeys · 1 storyline · /);
  assert.match(r.out, /^## Storylines — 1 storyline$/m);
  assert.match(r.out, /^### An invoice, end to end \(`invoice`\) — 3 journeys \(2 on the main path · 1 branch\) · /m);
  // the branch sits indented under the step it leaves from
  assert.match(r.out, /^1\. Start a new invoice — .*\n   ↳ Draft and send an invoice · branch of Start a new invoice · when Operations reviews the draft before it is sent · back to Billing cycle — /m);
  assert.match(r.out, /^1\. Start a new invoice — .*`invoice-app::flow::new-invoice`$/m);
  assert.match(r.out, /^2\. Billing cycle — /m);
  assert.ok(r.out.indexOf('## Storylines') < r.out.indexOf('## Billing'), 'the storylines come first');
  const json = JSON.parse(run(['journeys', '--storyline', 'An invoice, end to end', '--json']).out);
  assert.deepEqual(json.storylines.map((s: { id: string }) => s.id), ['invoice']);
  assert.deepEqual(json.storylines[0].journeys.map((j: { id: string; stepIndex: number }) => `${j.stepIndex}:${j.id}`), ['0:new-invoice', '1:billing-cycle']);
  const none = run(['journeys', '--storyline', 'nope']);
  assert.equal(none.status, 1);
  assert.match(none.err, /No storyline called “nope” is declared here\. Storylines declared here: invoice \(An invoice, end to end\)/);
});

test('the usage names the command, and a missing graph says so', () => {
  assert.match(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout, /farsight journeys \[--repo name\] \[--persona p\] \[--group g\] \[--storyline s\]/);
  const r = run(['journeys'], join(work, 'nope.json'));
  assert.equal(r.status, 1);
  assert.match(r.err, /no graph at/);
});
