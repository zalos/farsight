#!/usr/bin/env node
// The installed tarballs must work with no workspace symlinks or Farsight application packages.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'packages/graph/package.json'), 'utf8')).version;
const scratch = mkdtempSync(join(tmpdir(), 'farsight-parser-consumer-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: scratch, stdio: 'pipe', encoding: 'utf8', timeout: 180_000, env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') } });
try {
  writeFileSync(join(scratch, 'package.json'), '{"private":true,"type":"module"}\n');
  const artifacts = ['graph', 'code-parser'].map(name => join(root, 'build/parser', `farsight-${name}-${version}.tgz`));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...artifacts]);
  assert.deepEqual(readdirSync(join(scratch, 'node_modules/@farsight')).sort(), ['code-parser', 'graph']);
  for (const name of ['graph', 'code-parser']) {
    const installed = join(scratch, 'node_modules/@farsight', name);
    assert.equal(lstatSync(installed).isSymbolicLink(), false);
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    assert.equal(pkg.license, 'MIT');
    assert.ok(!JSON.stringify(pkg.dependencies).includes('workspace:'));
    assert.ok(!Object.keys(pkg.dependencies ?? {}).some(n => /^@farsight\/(core|parsers|server|cli|mcp|work)$/.test(n)));
    assert.ok(readFileSync(join(installed, 'LICENSE'), 'utf8').includes('MIT License'));
    assert.ok(readFileSync(join(installed, 'README.md'), 'utf8').length);
  }
  mkdirSync(join(scratch, 'fixture'));
  writeFileSync(join(scratch, 'fixture/main.ts'), 'export function save() {} export function submit() { save(); save(); }');
  writeFileSync(join(scratch, 'fixture/Invoice.java'), 'class Invoice { void save() {} void submit() { save(); save(); } }');
  writeFileSync(join(scratch, 'consume.mjs'), `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { createParser } from '@farsight/code-parser';
    import { tsJsAdapter } from '@farsight/code-parser/adapters/tsjs';
    import { javaAdapter } from '@farsight/code-parser/adapters/java';
    import { serializeGraph, validateGraph, graphDocument } from '@farsight/graph';
    const result = await createParser({ adapters: [tsJsAdapter, javaAdapter] }).parseRepository({ root: './fixture', sourceId: 'consumer' });
    assert.equal(result.analysis.complete, true, JSON.stringify(result.analysis.diagnostics));
    assert.ok(result.graph.nodes.some(n => n.lang === 'java'));
    assert.ok(result.graph.nodes.some(n => n.name === 'submit'));
    assert.equal(result.graph.edges.filter(e => e.kind === 'calls' && e.occurrences?.length === 2).length, 2);
    assert.equal(validateGraph(graphDocument(result.graph)).valid, true);
    writeFileSync('saved-graph.json', serializeGraph(result.graph));
    writeFileSync('analysis.json', JSON.stringify(result));
  `);
  run(process.execPath, ['consume.mjs']);
  writeFileSync(join(scratch, 'query.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { deserializeGraph, indexGraph, reachable } from '@farsight/graph';
    const { graph } = deserializeGraph(readFileSync('saved-graph.json', 'utf8'));
    const entry = graph.nodes.find(n => n.name === 'submit');
    assert.equal(reachable(indexGraph(graph), [entry.id], { kinds: ['calls'] }).length, 2);
    assert.equal(graph.edges.filter(e => e.kind === 'calls').flatMap(e => e.occurrences).length, 4);
  `);
  run(process.execPath, ['query.mjs']);
  // Resolve types from the installed tarball, using only the compiler binary from this checkout.
  writeFileSync(join(scratch, 'consumer.mts'), `
    import { createParser, type AnalysisArtifact } from '@farsight/code-parser';
    import { tsJsAdapter } from '@farsight/code-parser/adapters/tsjs';
    import { javaAdapter } from '@farsight/code-parser/adapters/java';
    import { graphDocument, type GraphFragment, type EdgeOccurrence } from '@farsight/graph';
    const result: AnalysisArtifact = await createParser({ adapters: [tsJsAdapter, javaAdapter] }).parseRepository({root: '.', sourceId: 'types'});
    const graph: GraphFragment = { repo: 'types', nodes: result.graph.nodes, edges: result.graph.edges };
    const occurrences: EdgeOccurrence[] | undefined = graph.edges[0]?.occurrences;
    graphDocument(graph); void occurrences;
  `);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts']);
  console.log(`Parser tarballs verified outside workspace on ${process.platform}/${process.arch}: native Oxc, Java WASM, public types, serialization and independent traversal.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
