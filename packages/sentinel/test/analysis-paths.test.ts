// PR 18: bounded static call paths and attested deep-analysis import, over original fixtures: capture → public
// parser → analysis. Synthetic sources only; nothing is built or run, and no deep engine exists or is invoked. A call
// path is shown beside an imported flow so the two are never confused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import {
  boundedCallPaths, importDeepAnalysis, DEEP_ANALYSIS_SUPPORT, DEEP_REASON_CODES, PATH_REASON_CODES, PathError,
} from '../dist/analysis/index.js';
import { validateEnvelope } from '../dist/index.js';
import { capability } from '../dist/capabilities.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { PATHS_APP } from './paths-fixtures.ts';

const LIMITS = { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 };
const id = (path: string, name: string) => `app::${path}::${name}`;

async function setup(t: any, files: Record<string, string> = PATHS_APP) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, files);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const parsed = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: { gitignore: true, testFiles: 'include' }, limits: LIMITS });
  const analysis = parsed.sources[0]!;
  const readContent = (c: string) => fx.store.readArtifact(c);
  const paths = (queries: { from: string; to: string }[], bounds?: any) => boundedCallPaths({ snapshotId: snapshot.id, analysis, queries, readContent, ...(bounds ? { bounds } : {}) });
  return { fx, snapshot, analysis, readContent, paths };
}
const outcome = (env: any, i = 0) => [env.results[i].outcome, ...env.results[i].frontierReasons.map((r: string) => r.replace('sentinel.paths.', ''))];

test('a cross-file call path is call reachability, cited at each call site, and never a data flow', needsStore, async t => {
  const { fx, paths } = await setup(t);
  const env = await paths([
    { from: id('src/routes.ts', 'getUser'), to: id('src/db.ts', 'query') },
    { from: id('src/routes.ts', 'getCount'), to: id('src/db.ts', 'query') },
  ]);
  assert.equal(validateEnvelope('paths', env).ok, true);
  assert.equal(env.establishes, 'call-reachability');
  assert.ok(env.limitationKeys.includes('sentinel.paths.notDataFlow') && env.limitationKeys.includes('sentinel.paths.graphOnly'));
  // Both reach the query function: one passes request input into SQL, the other a constant. A path cannot tell them apart.
  assert.deepEqual(outcome(env, 0), ['reached']);
  assert.deepEqual(outcome(env, 1), ['reached']);
  const user = env.results[0].paths[0];
  assert.deepEqual(user.steps.map((s: any) => [s.from.split('::').pop(), s.to.split('::').pop(), s.resolution]),
    [['getUser', 'findUser', 'resolved'], ['findUser', 'query', 'resolved']]);
  // Each step cites the captured call site: across two files.
  const cited = await Promise.all(user.steps.map(async (s: any) => (await fx.store.readArtifact(s.sites[0].content)).subarray(s.sites[0].span.startByte, s.sites[0].span.endByte).toString('utf8')));
  assert.match(cited[0]!, /^findUser\(req\.query\.id\)/);
  assert.match(cited[1]!, /^query\(`select/);
  assert.deepEqual([...new Set(user.steps.flatMap((s: any) => s.sites.map((x: any) => x.relativePath)))], ['src/routes.ts', 'src/service.ts']);
  // Nothing about guards, validation or protection is derived: those edges are never traversed.
  assert.ok(!JSON.stringify(env).includes('"guards"'));
});

test('cycles terminate and are reported; a search with nothing unaccounted for is complete only over the graph', needsStore, async t => {
  const { paths } = await setup(t);
  const env = await paths([
    { from: id('src/cycle.ts', 'ping'), to: id('src/db.ts', 'query') },
    { from: id('src/cycle.ts', 'ping'), to: id('src/routes.ts', 'getUser') },
  ]);
  assert.deepEqual(outcome(env, 0), ['reached']);
  assert.deepEqual(env.results[0].paths[0].cyclic.map((n: string) => n.split('::').pop()), ['ping', 'pong']);
  assert.deepEqual(env.cycles.map((c: any) => c.members.map((n: string) => n.split('::').pop())), [['ping', 'pong']]);
  assert.deepEqual(outcome(env, 1), ['not-reached-complete']);
});

test('dynamic calls, functions handed on as values and unresolved calls are frontiers, never absence', needsStore, async t => {
  const { paths } = await setup(t);
  const env = await paths([
    { from: id('src/dynamic.ts', 'dispatch'), to: id('src/db.ts', 'query') },
    { from: id('src/dynamic.ts', 'pick'), to: id('src/db.ts', 'query') },
    { from: id('src/dynamic.ts', 'logged'), to: id('src/db.ts', 'query') },
  ]);
  // handlers[name]() and obj.run() leave no edge: the graph does not account for them.
  assert.deepEqual(outcome(env, 0), ['not-reached-bounded', 'unrecordedCall']);
  // flush is returned as a value: whoever calls it later is not in the graph.
  assert.deepEqual(outcome(env, 1), ['not-reached-bounded', 'functionAsValue']);
  // A global call (console.log) is not a recorded edge either.
  assert.deepEqual(outcome(env, 2), ['not-reached-bounded', 'unrecordedCall']);
});

test('depth, fan-out and visit bounds are frontiers; unknown nodes and invalid requests are refused or bounded', needsStore, async t => {
  const { paths, snapshot, analysis, readContent } = await setup(t);
  const deep = await paths([{ from: id('src/chain.ts', 'a1'), to: id('src/chain.ts', 'a4') }], { maxDepth: 2 });
  assert.deepEqual(outcome(deep), ['not-reached-bounded', 'depthLimit']);
  const enough = await paths([{ from: id('src/chain.ts', 'a1'), to: id('src/chain.ts', 'a4') }], { maxDepth: 3 });
  assert.deepEqual(outcome(enough), ['reached']);
  const fan = await paths([{ from: id('src/chain.ts', 'hub'), to: id('src/chain.ts', 'c3') }], { maxFanout: 2 });
  assert.deepEqual(outcome(fan), ['not-reached-bounded', 'fanoutLimit']);
  const visits = await paths([{ from: id('src/chain.ts', 'a1'), to: id('src/chain.ts', 'a4') }], { maxVisited: 2 });
  assert.deepEqual(outcome(visits), ['not-reached-bounded', 'visitLimit']);
  const missing = await paths([{ from: id('src/chain.ts', 'a1'), to: 'app::src/nowhere.ts::x' }]);
  assert.deepEqual(outcome(missing), ['not-reached-bounded', 'unknownNode']);
  await assert.rejects(paths([{ from: id('src/chain.ts', 'a1'), to: id('src/chain.ts', 'a1') }]), (e: any) => e instanceof PathError && e.code === 'sentinel.paths.invalidInput');
  await assert.rejects(paths([{ from: 'a', to: 'b' }], { maxDepth: 0 }), (e: any) => e.code === 'sentinel.paths.invalidInput');
  await assert.rejects(boundedCallPaths({ snapshotId: 'another-snapshot', analysis, queries: [], readContent }), (e: any) => e.code === 'sentinel.paths.unbound');
  // The envelope is keyed by the graph read and the bounds.
  assert.notEqual(deep.boundsDigest, enough.boundsDigest);
  assert.equal(deep.graphDigest, enough.graphDigest);
  assert.equal(deep.snapshotId, snapshot.id);
});

// ---- imported deep-analysis results ----

const TERMS = `sha256:${createHash('sha256').update('example analyzer licence terms').digest('hex')}`;
const TRUST = { trustedAttesters: ['security-team@example.com'], acceptedTerms: [{ tool: 'example-analyzer', termsDigest: TERMS }] };

async function importFixture(t: any) {
  const { fx, snapshot, readContent } = await setup(t);
  const entry = (p: string) => snapshot.entries.find((e: any) => e.relativePath === p && e.kind === 'file');
  const spanOf = async (p: string, needle: string) => {
    const bytes = Buffer.from(await fx.store.readArtifact(entry(p).content));
    const start = bytes.indexOf(Buffer.from(needle));
    assert.ok(start >= 0, needle);
    return { relativePath: p, content: entry(p).content, span: { startByte: start, endByte: start + Buffer.byteLength(needle) } };
  };
  const read = ['src/routes.ts', 'src/service.ts', 'src/db.ts', 'src/reports.ts'];
  const doc = {
    schema: 'sentinel-deep-import/draft-1',
    tool: { name: 'example-analyzer', version: '9.9.9', distributionDigest: `sha256:${'a'.repeat(64)}` },
    attestation: {
      license: { identifier: 'LicenseRef-example', termsDigest: TERMS, acceptedBy: 'owner@example.com', acceptedAt: '2026-10-22T09:00:00Z' },
      provenance: { obtainedFrom: 'customer-internal-mirror', attestedBy: 'security-team@example.com', attestedAt: '2026-10-22T09:05:00Z' },
    },
    binding: { snapshotId: snapshot.id, sourceId: 'app', files: read.map(p => ({ relativePath: p, content: entry(p).content })),
      configurationDigest: `sha256:${'b'.repeat(64)}`, mode: 'source-only-no-build', buildPerformed: false },
    flows: [{
      toolRuleId: 'example/sql-injection', message: 'request input reaches a SQL string', originalSeverity: 'high',
      source: await spanOf('src/routes.ts', 'req.query.id'),
      steps: [await spanOf('src/service.ts', 'id: string')],
      sink: await spanOf('src/service.ts', '`select * from users where id = \'${id}\'`'),
    }],
  };
  const run = (d: unknown, trust = TRUST) => importDeepAnalysis({ document: typeof d === 'string' ? d : JSON.stringify(d), snapshot, trust, readContent, importedAt: '2026-10-22T10:00:00Z' });
  return { doc, run, snapshot, spanOf, entry };
}

test('an attested, trusted and bound import becomes imported observations beside the structural path', needsStore, async t => {
  const { doc, run, snapshot } = await importFixture(t);
  const result: any = await run(doc);
  assert.equal(result.status, 'imported');
  assert.equal(result.observations.length, 1);
  const o = result.observations[0];
  assert.equal(validateEnvelope('observation', o).ok, true);
  assert.deepEqual(o.producer, { kind: 'imported', provenanceArtifact: result.documentDigest });
  assert.equal(o.producerRuleId, 'example/sql-injection');
  assert.deepEqual(o.evidence.map((e: any) => e.relativePath), ['src/routes.ts', 'src/service.ts', 'src/service.ts']);
  assert.ok(o.limitationKeys.includes('sentinel.deep.importedNotExecuted') && o.limitationKeys.includes('sentinel.deep.toolScopeOnly'));
  assert.deepEqual(result.scope, { sourceId: 'app', files: ['src/db.ts', 'src/reports.ts', 'src/routes.ts', 'src/service.ts'],
    configurationDigest: doc.binding.configurationDigest, mode: 'source-only-no-build', buildPerformed: false });
  assert.equal(o.snapshotId, snapshot.id);
  // The analyzer's own mode name is recorded, never read as a capability; a stated build is a limitation.
  const built: any = await run({ ...doc, binding: { ...doc.binding, buildPerformed: true, mode: 'no-build' } });
  assert.ok(built.limitationKeys.includes('sentinel.deep.buildStated'));
  // Deep checks stay unsupported: no engine, and the capability says so.
  assert.equal(DEEP_ANALYSIS_SUPPORT.engine, null);
  assert.equal(capability('interprocedural-flow')?.state, 'unavailable');
  assert.equal(capability('interprocedural-flow')?.reasonCode, 'sentinel.capability.noQualifiedEngine');
});

test('an untrusted attester or unaccepted terms yield nothing', needsStore, async t => {
  const { doc, run } = await importFixture(t);
  const other: any = await run({ ...doc, attestation: { ...doc.attestation, provenance: { ...doc.attestation.provenance, attestedBy: 'someone@example.com' } } });
  assert.deepEqual([other.status, other.reasonCode], ['untrusted', 'sentinel.deep.untrustedAttestation']);
  assert.equal(other.observations, undefined);
  const terms: any = await run({ ...doc, attestation: { ...doc.attestation, license: { ...doc.attestation.license, termsDigest: `sha256:${'c'.repeat(64)}` } } });
  assert.deepEqual([terms.status, terms.reasonCode], ['untrusted', 'sentinel.deep.termsNotAccepted']);
  const noTrust: any = await run(doc, { trustedAttesters: [], acceptedTerms: [] });
  assert.equal(noTrust.status, 'untrusted');
});

test('results bound to other bytes, another snapshot or out-of-range spans are unbound or unknown', needsStore, async t => {
  const { doc, run, entry } = await importFixture(t);
  const wrongSnapshot: any = await run({ ...doc, binding: { ...doc.binding, snapshotId: 'another-snapshot' } });
  assert.deepEqual([wrongSnapshot.status, wrongSnapshot.reasonCode], ['unbound', 'sentinel.deep.unbound']);
  const otherBytes = `sha256:${'d'.repeat(64)}`;
  const mismatch: any = await run({ ...doc, binding: { ...doc.binding, files: [...doc.binding.files.slice(1), { relativePath: 'src/routes.ts', content: otherBytes }] },
    flows: doc.flows.map(f => ({ ...f, source: { ...f.source, content: otherBytes } })) });
  assert.equal(mismatch.status, 'unbound');
  assert.deepEqual(mismatch.files, [{ relativePath: 'src/routes.ts', reasonCode: 'sentinel.deep.contentMismatch' }]);
  const notCaptured: any = await run({ ...doc, binding: { ...doc.binding, files: [...doc.binding.files, { relativePath: 'src/generated.ts', content: otherBytes }] } });
  assert.deepEqual(notCaptured.files, [{ relativePath: 'src/generated.ts', reasonCode: 'sentinel.deep.fileNotCaptured' }]);
  const routes = entry('src/routes.ts');
  const outOfRange: any = await run({ ...doc, flows: [...doc.flows, { ...doc.flows[0], sink: { relativePath: 'src/routes.ts', content: routes.content, span: { startByte: 0, endByte: routes.bytes + 10 } } }] });
  assert.equal(outOfRange.status, 'imported');
  assert.equal(outOfRange.observations.length, 1);
  assert.deepEqual(outOfRange.unknown, [{ flow: 1, reasonCode: 'sentinel.deep.locationOutOfRange' }]);
});

test('a malformed document is refused whole', needsStore, async t => {
  const { doc, run } = await importFixture(t);
  for (const [name, d] of [
    ['not JSON', '{ "schema": '],
    ['no attestation', (({ attestation: _a, ...rest }) => rest)(doc)],
    ['another schema version', { ...doc, schema: 'sentinel-deep-import/draft-2' }],
    ['a flow into a file the tool did not read', { ...doc, flows: [{ ...doc.flows[0], sink: { ...doc.flows[0]!.sink, relativePath: 'src/cycle.ts' } }] }],
    ['an empty span', { ...doc, flows: [{ ...doc.flows[0], sink: { ...doc.flows[0]!.sink, span: { startByte: 5, endByte: 5 } } }] }],
  ] as const) {
    const r: any = await run(d);
    assert.deepEqual([r.status, r.reasonCode], ['refused', 'sentinel.deep.malformed'], name);
  }
  const bad: any = await importDeepAnalysis({ document: Buffer.from([0x7b, 0xff, 0x7d]), snapshot: { id: 'x', entries: [] }, trust: TRUST, readContent: async () => new Uint8Array(), importedAt: '2026-10-22T10:00:00Z' });
  assert.deepEqual([bad.status, bad.reasonCode], ['refused', 'sentinel.deep.malformed']);
});

test('every reason code is a catalog entry, and the capabilities are drafts beside an unavailable deep engine', async () => {
  const { STRINGS } = await import('../../core/dist/strings.js');
  for (const code of [...PATH_REASON_CODES, ...DEEP_REASON_CODES, 'sentinel.paths.invalidInput', 'sentinel.paths.unbound']) {
    const e = (STRINGS as any)[code];
    assert.ok(e?.hud && e?.professional && e?.define, code);
  }
  assert.equal(capability('bounded-call-paths')?.state, 'available-draft');
  assert.equal(capability('deep-import')?.state, 'available-draft');
});
