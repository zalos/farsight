// PR 05: portable parser evidence over a captured snapshot. Real capture, a real store, the public parser and its
// built-in TS/JS and Java adapters; synthetic fixtures only. The original checkout is deleted before parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import {
  parseSnapshot, retainSnapshotAnalysis, reconcileAnalysisInputs, joinFileOutcomes, fingerprintTree, treeDigest,
  assertParserInputSafe, ParserError, PARSER_RESULT_SCHEMA,
} from '../dist/snapshot/parser.js';
import { commitRepo, needsStore, openCaptureStore, scratch, unlock, writeTree } from './snapshot-helpers.ts';
import { attemptEnvelope, runEnvelope, workEnvelope } from './store-helpers.ts';

const hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const LIMITS = { maxFiles: 200, maxFileBytes: 4096, maxTotalBytes: 1024 * 1024, maxEntries: 10_000, maxDurationMs: 60_000 };
const SELECT = { gitignore: true, testFiles: 'include' as const };

const FILES: Record<string, string> = {
  'src/ok.ts': "import { helper } from './helper';\nimport { gone } from './absent-module';\nexport function ok() {\n  return helper() + gone;\n}\n",
  'src/helper.ts': 'export function helper() {\n  return 1;\n}\n',
  'src/bad.ts': 'export function (\n',
  'src/main/java/App.java': 'package app;\npublic class App {\n  public int run() { return 1; }\n}\n',
  'src/main/java/Broken.java': 'package app;\npublic class Broken {\n  void x( {\n',
  '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
  'tsconfig.json': '{ "extends": "./missing-base.json" }\n',
  'huge.ts': `export const big = "${'x'.repeat(5000)}";\n`,
  'ignored.ts': 'export const ignored = 1;\n',
  '.gitignore': 'ignored.ts\n',
  'farsight.config.json': '{ "guards": [{ "match": "ok", "label": "claims to guard" }] }\n',
  'run.sh': '#!/bin/sh\necho hi\n',
};

async function captured(t: any) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, FILES);
  chmodSync(join(root, 'run.sh'), 0o755);
  writeTree(root, { 'node_modules/dep/index.js': 'module.exports = 1;\n', 'big.bin': Buffer.alloc(10_000) });
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy',
    sources: [{ sourceId: 'app', repositoryId: 'example/app', root }], policy: { maxFileBytes: 2048 * 4 } });
  // No live checkout: the original is gone before anything is parsed.
  unlock(root);
  rmSync(root, { recursive: true, force: true });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  return { dir, work, fx, snapshot };
}

const entry = (r: any, path: string) => r.entries.find((e: any) => e.path === path);

test('a failed Java file, a parsed TS file and an unparsed workflow, from the store alone', needsStore, async t => {
  const { work, fx, snapshot } = await captured(t);
  const analysis = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT, limits: LIMITS });
  const [{ artifact, result, index }] = analysis.sources;
  assert.equal(result.schema, PARSER_RESULT_SCHEMA);
  // The demo, and the rest of the inventory, each joined without changing the capture.
  assert.equal(entry(result, 'src/main/java/Broken.java').class, 'parse-failed');
  assert.ok(entry(result, 'src/main/java/Broken.java').diagnostics >= 1);
  assert.equal(entry(result, 'src/main/java/App.java').class, 'parsed');
  assert.equal(entry(result, 'src/ok.ts').class, 'parsed');
  assert.equal(entry(result, 'src/bad.ts').class, 'parse-failed');
  assert.equal(entry(result, '.github/workflows/ci.yml').class, 'not-selected');
  assert.equal(entry(result, 'farsight.config.json').class, 'not-selected');
  assert.deepEqual([entry(result, 'huge.ts').class, entry(result, 'huge.ts').parser.reason], ['parser-skipped', 'resource-limit']);
  assert.equal(entry(result, 'ignored.ts').class, 'not-selected', 'gitignore pinned on: ignored source stays visible as not selected');
  assert.equal(entry(result, 'node_modules').class, 'unknown-scope');
  assert.equal(result.counts.unknownScopeDescendants, null, 'unknown descendants are never zero');
  assert.equal(result.counts['not-selected'] >= 3, true);
  const total = Object.entries(result.counts).filter(([k]) => k !== 'unknownScopeDescendants').reduce((a, [, v]) => a + (v as number), 0);
  assert.equal(total, snapshot.entries.length, 'every captured entry is joined exactly once');
  // The parser's selection flag is not coverage, and syntax evidence clears nothing.
  assert.equal(result.parserComplete, false);
  assert.equal(result.clearsChecks, false);
  assert.ok(!artifact.analysis.inputs.some((i: any) => i.path === 'farsight.config.json' && i.kind === 'content'),
    'application configuration is listed during discovery but its bytes are never read');
  // Diagnostics keep the lines the parser gave; a limit diagnostic has none, and none is added.
  const limit = artifact.analysis.diagnostics.find((d: any) => d.code === 'resource-limit' && d.path === 'huge.ts');
  assert.ok(limit && limit.line === undefined);
  // Every recorded input reconciled, including a verified-absent resolution candidate.
  assert.equal(result.inputs.length, artifact.analysis.inputs.length);
  const outcomes = new Map(result.inputs.map((i: any) => [`${i.kind}:${i.path}`, i.outcome]));
  assert.equal(outcomes.get('content:src/ok.ts'), 'content-captured');
  assert.equal(outcomes.get('directory:.'), 'directory-listed');
  assert.equal(outcomes.get('missing:src/absent-module.ts'), 'missing-verified-absent', 'an unresolved import candidate');
  // The tree did not change, and the parser read only non-executable files.
  assert.equal(result.tree.before, result.tree.after);
  // The complete artifact is kept, occurrences included, and the index cites captured bytes.
  assert.ok(artifact.graph.edges.some((e: any) => e.occurrences?.length), 'call-site occurrences are retained');
  const okNode = index.nodes.find((n: any) => n.path === 'src/ok.ts' && /ok$/.test(n.nodeId));
  assert.ok(okNode, 'the TS function is indexed');
  const bytes = await fx.store.readArtifact(okNode.content);
  assert.equal(okNode.content, `sha256:${hex(bytes)}`);
  assert.match(bytes.subarray(okNode.byteSpan.startByte, okNode.byteSpan.endByte).toString('utf8'), /export function ok\(\)/);
  for (const o of index.occurrences) assert.ok(o.byteSpan.endByte >= o.byteSpan.startByte);
});

test('selection and limits are explicit, pinned in the result, and change the outcome', needsStore, async t => {
  const { work, fx, snapshot } = await captured(t);
  const on = (await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT, limits: LIMITS })).sources[0];
  const off = (await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work,
    selection: { ...SELECT, gitignore: false }, limits: LIMITS })).sources[0];
  assert.equal(entry(on.result, 'ignored.ts').class, 'not-selected');
  assert.equal(entry(off.result, 'ignored.ts').class, 'parsed');
  assert.notEqual(on.result.analysisFingerprint, off.result.analysisFingerprint);
  assert.deepEqual(off.result.selection, { ...SELECT, gitignore: false });
  assert.ok(on.artifact.analysis.inputs.some((i: any) => i.path === '.gitignore' && i.kind === 'content'), 'the ignore rule is a recorded input');
  const tight = (await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT,
    limits: { ...LIMITS, maxFiles: 1 } })).sources[0];
  assert.ok(tight.result.entries.some((e: any) => e.parser?.reason === 'maxFiles'), 'a parser limit is reported per file');
});

test('requests that leave selection or limits implicit, or ask for enrichment, are refused', needsStore, async t => {
  const { work, fx, snapshot } = await captured(t);
  const bad = (over: any) => parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT, limits: LIMITS, ...over });
  const code = (c: string) => (e: unknown) => e instanceof ParserError && e.code === c;
  await assert.rejects(bad({ selection: { testFiles: 'include' } }), code('sentinel.parse.invalidRequest'));
  await assert.rejects(bad({ selection: { ...SELECT, externals: [] } }), code('sentinel.parse.invalidRequest'));
  await assert.rejects(bad({ selection: { ...SELECT, plumbing: ['x'] } }), code('sentinel.parse.invalidRequest'));
  await assert.rejects(bad({ limits: { maxFiles: 1 } }), code('sentinel.parse.invalidRequest'));
  const alias = join(work, '..', 'alias');
  symlinkSync(work, alias);
  await assert.rejects(bad({ workDir: alias }), code('sentinel.parse.invalidRequest'));
  await assert.rejects(bad({ workDir: 'relative' }), code('sentinel.parse.invalidRequest'));
  await assert.rejects(bad({ sources: ['elsewhere'] }), code('sentinel.parse.invalidRequest'));
});

test('every recorded input reconciles by kind, or the parse fails integrity', needsStore, async t => {
  const { work, fx, snapshot } = await captured(t);
  const { sources: [s] } = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT, limits: LIMITS });
  // Rebuild the materialized tree's rows the same way the parse saw them.
  const tree = join(work, 'probe');
  mkdirSync(tree);
  for (const e of snapshot.entries) {
    if (e.kind !== 'file' || e.disposition !== 'included') continue;
    const p = join(tree, ...e.relativePath.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, await fx.store.readArtifact(e.content));
  }
  const rows = fingerprintTree(tree);
  const mat = { sources: [{ sourceId: 'app', gitlinks: [] }] } as any;
  const run = (inputs: any[]) => reconcileAnalysisInputs(inputs, rows, 'app', snapshot, mat);
  const ok = (path: string, kind: string, digest: string) => ({ path, kind, digest });
  const unavailable = hex('unavailable');
  assert.deepEqual(run([ok('big.bin', 'missing', unavailable)]).map(r => [r.outcome, r.explainedBy?.disposition]),
    [['missing-recorded-refusal', 'too-large']]);
  assert.deepEqual(run([ok('node_modules/dep/index.js', 'missing', unavailable)]).map(r => [r.outcome, r.explainedBy?.path]),
    [['missing-under-boundary', 'node_modules']]);
  assert.deepEqual(run([ok('src/nowhere/deeper.ts', 'missing', unavailable)]).map(r => r.outcome), ['missing-verified-absent']);
  const failing: [string, any][] = [
    ['escaping path', ok('../outside.ts', 'content', hex('x'))],
    ['absolute path', ok('/etc/passwd', 'content', hex('x'))],
    ['content bytes differ', ok('src/ok.ts', 'content', hex('other'))],
    ['content of an uncaptured path', ok('nope.ts', 'content', hex('x'))],
    ['directory listing differs', ok('src', 'directory', hex('[]'))],
    ['metadata kind differs', ok('src', 'metadata', hex('file'))],
    ['missing with another encoding', ok('gone.ts', 'missing', hex('absent'))],
    ['missing but present', ok('src/ok.ts', 'missing', unavailable)],
    ['missing below a file', ok('src/ok.ts/x', 'missing', unavailable)],
    ['unknown kind', ok('src/ok.ts', 'read', hex('x'))],
  ];
  for (const [name, input] of failing) {
    assert.throws(() => run([input]), (e: unknown) => e instanceof ParserError && e.code === 'sentinel.parse.integrity', name);
  }
  // A parser that reports a file the snapshot did not capture fails integrity too.
  const forged = { ...s.artifact, analysis: { ...s.artifact.analysis, files: [...s.artifact.analysis.files, { path: 'invented.ts', status: 'analyzed' }] } };
  assert.throws(() => joinFileOutcomes(forged as any, 'app', snapshot), (e: unknown) => e instanceof ParserError && e.code === 'sentinel.parse.integrity');
  // Writable or executable parser input is refused (the materialization is made read-only and non-executable).
  assert.throws(() => assertParserInputSafe(rows), (e: unknown) => e instanceof ParserError && e.code === 'sentinel.parse.integrity');
  // A changed tree has a different fingerprint.
  const before = treeDigest(rows);
  writeFileSync(join(tree, 'src', 'ok.ts'), 'changed');
  assert.notEqual(treeDigest(fingerprintTree(tree)), before);
});

test('the complete analysis, its index and its result are retained through one publication', needsStore, async t => {
  const { work, fx, snapshot } = await captured(t);
  const analysis = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: SELECT, limits: LIMITS });
  const e = fx.store.epoch;
  const W = { id: 'work-parse', revision: 1 };
  fx.store.ledger.createRun(runEnvelope(e, { id: 'run-parse', snapshotId: snapshot.id }) as never);
  // Roots the ledger keeps must be stored bytes: the snapshot manifest stands in for the stage's influence manifest.
  fx.store.ledger.createWork(workEnvelope(e, { ...W, runId: 'run-parse', influenceManifest: fx.store.ledger.getSnapshot(snapshot.id)!.manifest }) as never);
  const attempt: any = attemptEnvelope(e, { id: 'att-parse', ordinal: 1, work: W });
  delete attempt.invocation;
  fx.store.ledger.startAttempt(attempt as never);
  const { receipt, sources } = await retainSnapshotAnalysis(fx.store, { work: W, attemptId: 'att-parse', stageId: 'stage-parse',
    endedAt: new Date().toISOString() }, analysis);
  assert.deepEqual(receipt.work, W);
  const kept = JSON.parse((await fx.store.readArtifact(sources[0].artifact)).toString('utf8'));
  assert.deepEqual(kept, JSON.parse(JSON.stringify(analysis.sources[0].artifact)), 'the artifact is kept whole');
  const result = JSON.parse((await fx.store.readArtifact(sources[0].result)).toString('utf8'));
  assert.deepEqual([result.artifact, result.index], [sources[0].artifact, sources[0].index]);
  const report = await fx.store.inspect();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.ok(report.reachable.includes(sources[0].artifact) && report.reachable.includes(sources[0].index));
});

test('the parser module uses only the public parser, never application ingestion or the server', () => {
  const source = readFileSync(new URL('../src/snapshot/parser.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/(?:from|import\()\s*'([^']+)'/g)].map(m => m[1]!).filter(s => !s.startsWith('.'));
  assert.deepEqual([...new Set(imports)].sort(), [
    '@farsight/code-parser', '@farsight/code-parser/adapters/java', '@farsight/code-parser/adapters/tsjs', '@farsight/graph',
    'node:crypto', 'node:fs', 'node:path',
  ]);
  assert.doesNotMatch(source, /@farsight\/(core|server|parsers|mcp|cli)/, 'no application ingestion, enrichment or server module');
});
