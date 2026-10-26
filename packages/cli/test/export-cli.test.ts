import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGraph, deserializeGraph } from '@farsight/graph';

test('CLI exports a saved merged graph for independent consumers without changing its source or history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'export-cli-'));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  try {
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(cwd, name));
      writeFileSync(join(cwd, name, 'main.ts'), 'export function save() {} export function run() { save(); save(); }');
    }
    const ingest = run(['ingest', 'alpha', 'beta']);
    assert.equal(ingest.status, 0, ingest.stderr);
    const saved = readFileSync(join(cwd, 'graph.json'), 'utf8');
    assert.ok(JSON.parse(saved).edges.every((edge: any) => !edge.occurrences));
    const db = join(cwd, '.farsight/farsight.db'),
      before = statSync(db);
    const exported = run(['export', '--source-id', 'both']);
    assert.equal(exported.status, 0, exported.stderr);
    const document = deserializeGraph(exported.stdout);
    assert.equal(document.graph.repo, 'both');
    assert.equal(validateGraph(document).valid, true);
    assert.deepEqual(
      document.sources?.map((source) => source.repo),
      ['alpha', 'beta'],
    );
    assert.equal(document.graph.nodes.length, JSON.parse(saved).nodes.length);
    assert.equal(document.graph.edges.length, JSON.parse(saved).edges.length);
    assert.ok(!exported.stdout.includes(cwd));
    const file = run(['export', '--out', 'portable-graph.json', '--source-id', 'both']);
    assert.equal(file.status, 0, file.stderr);
    assert.equal(readFileSync(join(cwd, 'portable-graph.json'), 'utf8'), exported.stdout);
    linkSync(join(cwd, 'graph.json'), join(cwd, 'alias.json'));
    for (const out of ['graph.json', 'alias.json']) assert.notEqual(run(['export', '--out', out]).status, 0);
    assert.equal(readFileSync(join(cwd, 'graph.json'), 'utf8'), saved);
    assert.equal(statSync(db).mtimeMs, before.mtimeMs);
    assert.equal(statSync(db).size, before.size);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
