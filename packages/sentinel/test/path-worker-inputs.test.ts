// Original inert sources are captured and parsed, never executed. These are byte/protocol tests; only the
// future admission seam can establish a genuine accepted producer chain for a worker invocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@farsight/graph';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { inspectPathInputs, parsePathsJob, PATHS_JOB_SCHEMA } from '../dist/analysis/paths/protocol.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { PATHS_APP } from './paths-fixtures.ts';

const hash = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
async function setup(t: any) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, PATHS_APP);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const work = join(dir, 'work'); mkdirSync(work);
  const parsed = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work,
    selection: { gitignore: true, testFiles: 'include' },
    limits: { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 } });
  const source = parsed.sources[0]!;
  const values = new Map<string, Uint8Array>();
  const add = (value: unknown) => { const bytes = Buffer.from(canonicalJson(value)); const id = hash(bytes); values.set(id, bytes); return id; };
  for (const e of snapshot.entries) if (e.kind === 'file' && e.disposition === 'included') values.set(e.content, await fx.store.readArtifact(e.content));
  const artifact = add(source.artifact), index = add(source.index);
  const resultValue = { ...source.result, artifact, index };
  const requestValue = { schema: 'sentinel-path-request/draft-1',
    ancestor: { runId: 'retained-parent', revision: 2, planDigest: `sha256:${'1'.repeat(64)}` },
    snapshotId: snapshot.id, sourceId: 'app',
    queries: [{ from: 'app::src/routes.ts::getUser', to: 'app::src/db.ts::query' }],
    bounds: { edgeKinds: ['calls'], maxDepth: 12, maxFanout: 256, maxVisited: 50_000 } };
  const job = { schema: PATHS_JOB_SCHEMA, request: add(requestValue), snapshot: add(snapshot), analysis: { artifact, index, result: add(resultValue) } };
  const run = async (candidate: any = job, omit: string[] = [], reader?: (id: string) => Promise<Uint8Array>) => {
    const id = add(candidate), bytes = values.get(id)!;
    const inputs = [...values.keys()].filter(id => !omit.includes(id));
    return inspectPathInputs(bytes, inputs, reader ?? (async id => { const bytes = values.get(id); assert.ok(bytes); return bytes; }));
  };
  rmSync(root, { recursive: true });
  return { values, add, run, job, requestValue, resultValue, snapshot };
}

test('paths job is a closed bounded protocol without path, function or authority fields', () => {
  const id = `sha256:${'1'.repeat(64)}`;
  const job = { schema: PATHS_JOB_SCHEMA, request: id, snapshot: id, analysis: { artifact: id, result: id, index: id } };
  assert.deepEqual(parsePathsJob(Buffer.from(JSON.stringify(job))), job);
  for (const extra of [{ worker: '/tmp/other.mjs' }, { export: 'arbitrary' }, { confirmed: true }, { ancestor: {} }]) {
    assert.throws(() => parsePathsJob(Buffer.from(JSON.stringify({ ...job, ...extra }))));
  }
  assert.throws(() => parsePathsJob(Buffer.alloc(4097, 32)));
  assert.throws(() => parsePathsJob(Buffer.from([0xff])));
  return assert.rejects(inspectPathInputs(Buffer.from(JSON.stringify(job)), [], async () => { throw new Error('must not read'); }));
});

test('sealed retained bytes produce the original call-path evidence after source removal', needsStore, async t => {
  const { run, job, values } = await setup(t);
  const out = await run();
  assert.equal(out.request, job.request);
  assert.equal(out.ancestor.revision, 2);
  assert.equal(out.evidence.establishes, 'call-reachability');
  assert.equal(out.evidence.results[0].outcome, 'reached');
  assert.deepEqual(out.evidence.results[0].paths[0].steps.map(s => s.to.split('::').pop()), ['findUser', 'query']);
  assert.ok(out.evidence.limitationKeys.includes('sentinel.paths.notDataFlow'));
  assert.equal('coveredChecks' in out, false);
  assert.ok(out.actualReadSet.every(id => values.has(id)));
  assert.ok(out.actualReadSet.includes(job.analysis.result));
});

test('unsealed, substituted and malformed retained inputs refuse rather than return empty paths', needsStore, async t => {
  const { run, job, values, add } = await setup(t);
  await assert.rejects(run(job, [job.analysis.artifact]));
  await assert.rejects(run(job, [], async id => id === job.analysis.index ? Buffer.from('{}') : values.get(id)!));
  const broken = add({ schema: 'sentinel-parser-index/draft-1' });
  await assert.rejects(run({ ...job, analysis: { ...job.analysis, index: broken } }));
  const body = [...values.entries()].find(([, bytes]) => Buffer.from(bytes).toString().startsWith('import { findUser }'))!;
  await assert.rejects(run(job, [body[0]]));
  await assert.rejects(run(job, [], async id => id === body[0] ? Buffer.from('different captured body') : values.get(id)!));
});

test('job/request/result/source crossbinding is exact even when every substituted object has a valid digest', needsStore, async t => {
  const { run, job, add, requestValue, resultValue, snapshot } = await setup(t);
  for (const changed of [{ ...requestValue, snapshotId: 'another-capture' }, { ...requestValue, sourceId: 'other' }]) {
    await assert.rejects(run({ ...job, request: add(changed) }));
  }
  for (const changed of [{ ...resultValue, sourceId: 'other' }, { ...resultValue, snapshotId: 'other' },
    { ...resultValue, index: job.analysis.artifact }, { ...resultValue, analysisFingerprint: 'foreign-analysis' }]) {
    await assert.rejects(run({ ...job, analysis: { ...job.analysis, result: add(changed) } }));
  }
  await assert.rejects(run({ ...job, snapshot: add({ ...snapshot, entries: [] }) }));
});


test('a changed request is reported exactly and an unknown endpoint stays a bounded frontier', needsStore, async t => {
  const { run, job, add, requestValue } = await setup(t);
  const changed = { ...requestValue, queries: [{ from: 'app::src/routes.ts::getUser', to: 'app::src/missing.ts::unknown' }] };
  const request = add(changed);
  const out = await run({ ...job, request });
  assert.equal(out.request, request);
  assert.notEqual(out.request, job.request);
  assert.deepEqual(out.ancestor, requestValue.ancestor);
  assert.equal(out.evidence.results[0].to, changed.queries[0].to);
  assert.equal(out.evidence.results[0].outcome, 'not-reached-bounded');
  assert.ok(out.evidence.results[0].frontierReasons.includes('sentinel.paths.unknownNode'));
  assert.equal('clearedChecks' in out, false);
});
