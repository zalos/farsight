import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, PARSER_VERSION } from '../dist/index.js';
import { tsJsAdapter } from '../dist/tsjs.js';
import { javaAdapter } from '../dist/java/index.js';
import { canonicalJson, serializeGraph, deserializeGraph, indexGraph, reachable } from '@farsight/graph';

const parser = createParser({ adapters: [tsJsAdapter, javaAdapter] });
function fixture(files: Record<string, string>, action: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'code-parser-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text);
  }
  return action(root).finally(() => rmSync(root, { recursive: true, force: true }));
}
const sample = {
  'src/main.ts': 'import { save } from "./save.js"; export function submit(ok: boolean) { if (ok) { save(); save(); } save(); }',
  'src/save.ts': 'export function save() { return 1; }',
};

test('explicit instances preserve repeated same-line call sites and conditions in a portable graph', async () => {
  await fixture(sample, async root => {
    const result = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.equal(result.analysis.complete, true, canonicalJson(result.analysis.diagnostics));
    assert.equal(result.analysis.files.filter(f => f.status === 'analyzed').length, 2);
    const call = result.graph.edges.find(e => e.kind === 'calls')!;
    assert.equal(call.occurrences?.length, 3);
    assert.equal(new Set(call.occurrences?.map(o => o.span?.start)).size, 3);
    assert.equal(call.occurrences?.filter(o => o.conditions?.includes('ok')).length, 2);
    const loaded = deserializeGraph(serializeGraph(result.graph));
    assert.deepEqual(loaded.graph, result.graph);
    assert.equal(reachable(indexGraph(loaded.graph), [call.from], { kinds: ['calls'] }).length, 2);
    assert.ok(Object.isFrozen(result.graph.edges));
    assert.throws(() => { result.graph.edges.push(call); }, TypeError);
    assert.equal(result.analysis.parser.version, PARSER_VERSION);
  });
});

test('equivalent relocated inputs and different mtimes produce byte-identical artifacts', async () => {
  await fixture(sample, async a => fixture(sample, async b => {
    utimesSync(join(b, 'src/main.ts'), new Date('2001-01-01'), new Date('2001-01-01'));
    const first = await parser.parseRepository({ root: a, sourceId: 'sample' });
    const second = await parser.parseRepository({ root: b, sourceId: 'sample' });
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.ok(!canonicalJson(first).includes(a));
  }));
});

test('fingerprint includes source, alias configuration, dependency manifests, options and adapter versions', async () => {
  await fixture({ ...sample, 'package.json': '{"dependencies":{"react":"1.0.0"}}', 'tsconfig.json': '{"compilerOptions":{}}' }, async root => {
    const run = () => parser.parseRepository({ root, sourceId: 'sample' });
    const a = await run();
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"src"}}');
    const b = await run(); assert.notEqual(a.analysis.fingerprint, b.analysis.fingerprint);
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"react":"2.0.0"}}');
    const c = await run(); assert.notEqual(b.analysis.fingerprint, c.analysis.fingerprint);
    writeFileSync(join(root, 'src/save.ts'), 'export function save() { return 2; }');
    const d = await run(); assert.notEqual(c.analysis.fingerprint, d.analysis.fingerprint);
    const e = await parser.parseRepository({ root, sourceId: 'sample', setup: ['save'] });
    assert.notEqual(d.analysis.fingerprint, e.analysis.fingerprint);
    const changed = createParser({ adapters: [{ ...tsJsAdapter, version: 'next' }, javaAdapter] });
    assert.notEqual((await changed.parseRepository({ root, sourceId: 'sample' })).analysis.fingerprint, d.analysis.fingerprint);
  });
});

test('include and exclude constrain source files without controlling enrichment', async () => {
  await fixture({ ...sample, 'other/ignored.ts': 'export function ignored() {}', 'other/legacy.py': 'print(1)', 'src/check.test.ts': 'export function testHelper() {}' }, async root => {
    const r = await parser.parseRepository({ root, sourceId: 'sample', include: ['src/**'], exclude: ['**/save.ts'] });
    assert.ok(!r.graph.nodes.some(n => n.name === 'ignored' || n.name === 'save'));
    assert.ok(r.graph.nodes.some(n => n.name === 'testHelper'));
    assert.equal(r.analysis.complete, true, canonicalJson(r.analysis.diagnostics));
    assert.ok(!r.analysis.files.some(f => f.path === 'other/legacy.py'));
    const withoutTests = await parser.parseRepository({ root, sourceId: 'sample', testFiles: 'exclude' });
    assert.ok(!withoutTests.graph.nodes.some(n => n.name === 'testHelper'));
    assert.ok(withoutTests.analysis.files.some(f => f.path === 'src/check.test.ts' && f.reason === 'test-file'));
    const empty = await parser.parseRepository({ root, sourceId: 'sample', include: [] });
    assert.equal(empty.graph.nodes.length, 0);
    assert.equal(empty.analysis.complete, true);
  });
});

test('invalid TS and Java, unsupported files, limits and cancellation are explicit gaps', async () => {
  await fixture({ ...sample, 'broken.ts': 'export function {', 'Broken.java': 'public class Broken { void x( }', 'legacy.py': 'print(1)' }, async root => {
    const r = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.equal(r.analysis.complete, false);
    assert.equal(r.analysis.files.filter(f => f.status === 'failed').length, 2);
    assert.ok(r.analysis.diagnostics.some(d => d.path === 'broken.ts' && d.code === 'parse-error'));
    assert.ok(r.analysis.diagnostics.some(d => d.path === 'Broken.java' && d.code === 'parse-error'));
    assert.ok(r.analysis.diagnostics.some(d => d.code === 'unsupported'));
    for (const limits of [{ maxFiles: 1 }, { maxFileBytes: 20 }, { maxTotalBytes: 30 }, { maxEntries: 1 }]) {
      const bounded = await parser.parseRepository({ root, sourceId: 'sample', limits });
      assert.equal(bounded.analysis.complete, false);
      assert.ok(bounded.analysis.diagnostics.some(d => d.code === 'resource-limit'), canonicalJson(bounded.analysis));
    }
    const cancelled = await parser.parseRepository({ root, sourceId: 'sample', signal: AbortSignal.abort() });
    assert.equal(cancelled.analysis.complete, false);
    assert.ok(cancelled.analysis.diagnostics.some(d => d.code === 'cancelled'));
  });
});

test('symlinks, cycles, and out-of-root config reads are refused without leaking checkout paths', async () => {
  await fixture(sample, async root => {
    symlinkSync(root, join(root, 'cycle'), 'dir');
    writeFileSync(join(root, 'tsconfig.json'), '{"extends":"../outside.json"}');
    const r = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.equal(r.analysis.complete, false);
    assert.ok(r.analysis.diagnostics.some(d => d.code === 'read-boundary'));
    assert.ok(!canonicalJson(r).includes(root));
    assert.ok(r.analysis.inputs.every(i => !i.path.startsWith('../')));
  });
});

test('Java call occurrences retain positions and repeat sites', async () => {
  await fixture({ 'Sample.java': 'class Sample { void save() {} void run(boolean ok) { if(ok) { save(); save(); } save(); } }' }, async root => {
    const r = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.equal(r.analysis.complete, true);
    const call = r.graph.edges.find(e => e.kind === 'calls')!;
    assert.equal(call.occurrences?.length, 3);
    assert.equal(new Set(call.occurrences?.map(o => o.span?.start)).size, 3);
    assert.equal(call.occurrences?.filter(o => o.conditions?.length).length, 2);
  });
});

test('registration and concurrent reads cannot leak across instances', async () => {
  const list = [tsJsAdapter];
  const isolated = createParser({ adapters: list });
  list.push(javaAdapter);
  await fixture({ ...sample, 'Sample.java': 'class Sample {}' }, async a => fixture(sample, async b => {
    const [first, second] = await Promise.all([
      isolated.parseRepository({ root: a, sourceId: 'first' }),
      parser.parseRepository({ root: b, sourceId: 'second' }),
    ]);
    assert.deepEqual(first.analysis.adapters.map(a => a.id), ['ts-js']);
    assert.ok(second.graph.nodes.every(n => n.id.startsWith('second::')));
    assert.ok(first.graph.nodes.every(n => n.id.startsWith('first::')));
    assert.ok(!second.analysis.files.some(f => f.path === 'Sample.java'));
  }));
});

test('adapter failures remain visible and do not erase other adapters', async () => {
  const failing = createParser({ adapters: [tsJsAdapter, { id: 'broken', version: '1', extensions: ['.broken'], async ingest() { throw new Error('private failure'); } }] });
  await fixture({ ...sample, 'x.broken': 'bad' }, async root => {
    const result = await failing.parseRepository({ root, sourceId: 'sample' });
    assert.ok(result.graph.nodes.length);
    assert.equal(result.analysis.complete, false);
    assert.ok(result.analysis.diagnostics.some(d => d.code === 'adapter-error' && d.adapter === 'broken'));
    assert.ok(!canonicalJson(result).includes('private failure'));
  });
});

test('package version matches adapter stamps', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PARSER_VERSION, pkg.version);
  assert.ok(tsJsAdapter.version.startsWith(`${pkg.version}+`));
  assert.ok(javaAdapter.version.startsWith(`${pkg.version}+`));
});

test('the fingerprint hashes the exact cached bytes parsed when files change during a run', async () => {
  await fixture(sample, async root => {
    const mutate = { id: 'editor-race', version: '1', extensions: ['.none'], async ingest(_root: string, options: any) {
      writeFileSync(join(root, 'src/save.ts'), 'export function changedOnDisk() {}');
      return { repo: options.repoName, nodes: [], edges: [] };
    } };
    const result = await createParser({ adapters: [mutate, tsJsAdapter] }).parseRepository({ root, sourceId: 'sample' });
    assert.ok(result.graph.nodes.some(n => n.name === 'save'));
    assert.ok(!result.graph.nodes.some(n => n.name === 'changedOnDisk'));
    const next = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.ok(next.graph.nodes.some(n => n.name === 'changedOnDisk'));
    assert.notEqual(next.analysis.inputs.find(i => i.kind === 'content' && i.path === 'src/save.ts')?.digest,
      result.analysis.inputs.find(i => i.kind === 'content' && i.path === 'src/save.ts')?.digest);
  });
});

test('flag folding retains inactive and live site evidence on one relationship', async () => {
  await fixture({ 'main.ts': 'const ENABLED = false; export function save() {} export function run(){ if(ENABLED) save(); save(); }' }, async root => {
    const result = await parser.parseRepository({ root, sourceId: 'sample' });
    const calls = result.graph.edges.filter(e => e.kind === 'calls');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.meta?.inactive, undefined);
    assert.equal(calls[0]!.occurrences?.length, 2);
    assert.equal(calls[0]!.occurrences?.filter(o => o.meta?.inactive === true).length, 1);
    assert.equal(calls[0]!.occurrences?.filter(o => o.resolution?.technique === 'flag-gate').length, 1);
  });
});

test('elapsed limits are checked after an adapter and do not report success', async () => {
  const slow = createParser({ adapters: [{ id: 'slow', version: '1', extensions: ['.slow'], async ingest(_root, opts) {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { repo: opts!.repoName!, nodes: [], edges: [] };
  } }] });
  await fixture({}, async root => {
    const result = await slow.parseRepository({ root, sourceId: 'sample', limits: { maxDurationMs: 10 } });
    assert.equal(result.analysis.complete, false);
    assert.ok(result.analysis.diagnostics.some(d => d.code === 'resource-limit'));
  });
});

test('timer cancellation is observed between source files', async () => {
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`part${i}.ts`, sample['src/main.ts']]));
  await fixture(files, async root => {
    const controller = new AbortController();
    const pending = parser.parseRepository({ root, sourceId: 'sample', signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 1);
    try {
      const result = await pending;
      assert.equal(result.analysis.complete, false);
      assert.ok(result.analysis.diagnostics.some(d => d.code === 'cancelled'));
    } finally { clearTimeout(timer); }
  });
});

test('invalid resolution configuration and bounded branch inspection are visible', async () => {
  await fixture({ ...sample, 'tsconfig.json': '{broken' }, async root => {
    const result = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.equal(result.analysis.complete, false);
    assert.ok(result.analysis.diagnostics.some(d => d.path === 'tsconfig.json'));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'branches.ts'), 'export function many(x: number) {' + Array.from({length: 30}, (_, i) => `if(x===${i}) return ${i};`).join('') + '}');
    const bounded = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.equal(bounded.analysis.complete, false);
    assert.ok(bounded.analysis.diagnostics.some(d => d.code === 'resource-limit'));
  });
});

test('portable output keeps dependency and store extraction evidence', async () => {
  await fixture({ 'main.ts': 'import pg from "pg"; import fs from "node:fs"; export function connect() { return pg.connect(); }', 'package.json': '{"dependencies":{"pg":"8.0.0"}}' }, async root => {
    const result = await parser.parseRepository({ root, sourceId: 'sample' });
    assert.deepEqual(result.graph.meta?.stores?.drivers, [{ spec: 'pg', files: 1 }]);
    assert.ok(result.graph.meta?.packages);
    assert.equal(result.graph.meta?.files, 1);
    assert.ok(!('sourceHash' in result.graph.meta!));
  });
});
