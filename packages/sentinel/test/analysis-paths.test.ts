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
  boundedCallPaths, importDeepAnalysis, deepImportIntent, DEEP_ANALYSIS_SUPPORT, DEEP_REASON_CODES, PATH_REASON_CODES, PathError,
} from '../dist/analysis/index.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
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
  const paths = (queries: { from: string; to: string }[], bounds?: any) => boundedCallPaths({ snapshot, analysis, queries, readContent, ...(bounds ? { bounds } : {}) });
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
  await assert.rejects(boundedCallPaths({ snapshot: { ...snapshot, id: 'another-snapshot' }, analysis, queries: [], readContent }), (e: any) => e.code === 'sentinel.paths.unbound');
  // The envelope is keyed by the graph read and the bounds.
  assert.notEqual(deep.boundsDigest, enough.boundsDigest);
  assert.equal(deep.graphDigest, enough.graphDigest);
  assert.equal(deep.snapshotId, snapshot.id);
});

// ---- imported deep-analysis results ----

const TERMS = `sha256:${createHash('sha256').update('example analyzer licence terms').digest('hex')}`;
const STATE = `sha256:${'5'.repeat(64)}`;
const POLICY = `sha256:${'6'.repeat(64)}`;
/** The owner's local CLI confirms one intent; the coordinator spends the receipt. */
function ownerConfirms(t: any, intent: any) {
  const book = new ReceiptBook(join(scratch(t, 'sentinel-trust-'), 'receipts'));
  const now = new Date('2026-10-22T09:30:00Z');
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, { intent, stateDigest: STATE, policyRevision: POLICY }, { now, ttlMs: 600_000 });
  return book.consume(r.id, { intent, stateDigest: STATE, policyRevision: POLICY }, now);
}

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
  const text = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d));
  // By default the owner confirmed exactly the document being imported, so the binding checks are what is tested.
  const run = (d: unknown, authorization: unknown = 'confirm') => importDeepAnalysis({ document: text(d), snapshot, readContent, importedAt: '2026-10-22T10:00:00Z',
    authorization: authorization === 'confirm' ? (deepImportIntent(text(d), snapshot.id) ? ownerConfirms(t, deepImportIntent(text(d), snapshot.id)) : undefined) : authorization });
  return { doc, run, snapshot, spanOf, entry, text };
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

test('only the owner\'s spent receipt for this exact document and snapshot trusts an import; self-asserted attestation counts for nothing', needsStore, async t => {
  const { doc, run, snapshot, text } = await importFixture(t);
  const untrusted = (r: any) => [r.status, r.reasonCode, r.observations];
  const NOT = ['untrusted', 'sentinel.deep.notOwnerConfirmed', undefined];
  // No receipt at all: the attester name the owner would recognise is just a string in the document.
  assert.deepEqual(untrusted(await run(doc, null)), NOT);
  // A receipt-shaped object that this package's receipt book did not spend authorizes nothing.
  assert.deepEqual(untrusted(await run(doc, { receipt: { action: 'evidence.import', intentDigest: 'x' }, digest: 'y' })), NOT);
  // The owner confirmed the original document; a fabricated one copying its attester with another tool version,
  // distribution, origin or configuration is a different document.
  const confirmed = ownerConfirms(t, deepImportIntent(text(doc), snapshot.id));
  for (const [name, forged] of [
    ['another tool version', { ...doc, tool: { ...doc.tool, version: '10.0.0' } }],
    ['another distribution', { ...doc, tool: { ...doc.tool, distributionDigest: `sha256:${'f'.repeat(64)}` } }],
    ['another origin', { ...doc, attestation: { ...doc.attestation, provenance: { ...doc.attestation.provenance, obtainedFrom: 'somewhere-else' } } }],
    ['another configuration', { ...doc, binding: { ...doc.binding, configurationDigest: `sha256:${'c'.repeat(64)}` } }],
    ['an extra flow', { ...doc, flows: [...doc.flows, doc.flows[0]] }],
  ] as const) assert.deepEqual(untrusted(await run(forged, confirmed)), NOT, name);
  // The same document confirmed for another snapshot, or under another owner action, does not authorize this one.
  assert.deepEqual(untrusted(await run(doc, ownerConfirms(t, deepImportIntent(text(doc), 'snapshot-elsewhere')))), NOT);
  assert.deepEqual(untrusted(await run(doc, ownerConfirms(t, { ...deepImportIntent(text(doc), snapshot.id)!, action: 'tool.acquire' }))), NOT);
  // The exact confirmation imports.
  assert.equal((await run(doc, confirmed) as any).status, 'imported');
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
  const bad: any = await importDeepAnalysis({ document: Buffer.from([0x7b, 0xff, 0x7d]), snapshot: { id: 'x', entries: [] }, authorization: undefined, readContent: async () => new Uint8Array(), importedAt: '2026-10-22T10:00:00Z' });
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

// ---- review round 1 (SOL, f8d98b1): Unicode and keyword calls, lexical shadowing, analysis identity ----

test('round 1: a Unicode-named call and a call to a property named like a keyword are unrecorded calls, never absence', needsStore, async t => {
  const { paths } = await setup(t, { ...PATHS_APP, 'src/unicode.ts': `import { query } from './db.js';

export function π() {
  return query('select 1');
}

export function dispatchπ(λ: () => void) {
  λ();
}

export function viaKeyword(obj: { return(): void }) {
  obj.return();
}
` });
  const env = await paths([
    { from: id('src/unicode.ts', 'dispatchπ'), to: id('src/db.ts', 'query') },
    { from: id('src/unicode.ts', 'viaKeyword'), to: id('src/db.ts', 'query') },
  ]);
  for (const i of [0, 1]) {
    assert.equal(env.results[i].outcome, 'not-reached-bounded', String(i));
    assert.ok(env.results[i].frontierReasons.includes('sentinel.paths.unrecordedCall'), String(i));
  }
});

test('round 1: a parameter or local named like a top-level function shadows it; the parser\'s edge is not followed', needsStore, async t => {
  const { paths } = await setup(t, { ...PATHS_APP, 'src/shadow.ts': `import { query } from './db.js';

export function sink() {
  return query('drop');
}

export function dispatch(sink: () => void) {
  sink();
}

export function local() {
  const sink = () => 0;
  return sink();
}

export function direct() {
  return sink();
}
` });
  const env = await paths([
    { from: id('src/shadow.ts', 'dispatch'), to: id('src/shadow.ts', 'sink') },
    { from: id('src/shadow.ts', 'local'), to: id('src/shadow.ts', 'sink') },
    { from: id('src/shadow.ts', 'direct'), to: id('src/shadow.ts', 'sink') },
  ]);
  assert.deepEqual(outcome(env, 0).slice(0, 1), ['not-reached-bounded']);
  assert.notEqual(env.results[0].outcome, 'reached', 'never reached through a shadowed name');
  assert.notEqual(env.results[1].outcome, 'reached');
  // Near neighbour: the same call without a local binding is followed.
  assert.deepEqual(outcome(env, 2), ['reached']);
});

test('round 1: an index from another analysis than the artifact is refused, and the envelope names the artifact\'s own fingerprint', needsStore, async t => {
  const { snapshot, analysis, readContent } = await setup(t);
  const spoofed = { ...analysis, index: { ...analysis.index, analysisFingerprint: `sha256:${'9'.repeat(64)}` } };
  await assert.rejects(boundedCallPaths({ snapshot, analysis: spoofed, queries: [], readContent }), (e: any) => e.code === 'sentinel.paths.unbound');
  const env = await boundedCallPaths({ snapshot, analysis, queries: [], readContent });
  assert.equal(env.analysisFingerprint, analysis.artifact.analysis.fingerprint);
});

test('round 2: an artifact, an index, a snapshot and a reader from different captures never mix, and caches never cross them', needsStore, async t => {
  const start = (body: string) => ({ ...PATHS_APP, 'src/start.ts': `import { query } from './db.js';\n\nexport function start() {\n  ${body}\n}\n` });
  const a = await setup(t, start('return query(\'select 1\');'));
  const b = await setup(t, start('return 0;'));
  const q = [{ from: id('src/start.ts', 'start'), to: id('src/db.ts', 'query') }];
  // Warm A's caches first.
  assert.deepEqual(outcome(await a.paths(q)), ['reached']);
  // A's artifact with B's untouched index and snapshot: refused, never B's identity with A's reach.
  await assert.rejects(boundedCallPaths({ snapshot: b.snapshot, analysis: { ...b.analysis, artifact: a.analysis.artifact }, queries: q, readContent: b.readContent }),
    (e: any) => e.code === 'sentinel.paths.unbound');
  // A's parser evidence with B's snapshot: the index cites bytes B did not capture.
  await assert.rejects(boundedCallPaths({ snapshot: { ...b.snapshot, id: a.snapshot.id }, analysis: a.analysis, queries: q, readContent: b.readContent }),
    (e: any) => e.code === 'sentinel.paths.unbound');
  // A reader for another store cannot supply a body.
  await assert.rejects(boundedCallPaths({ snapshot: a.snapshot, analysis: a.analysis, queries: q, readContent: async () => Buffer.from('export function start() {}\n') }),
    (e: any) => e.code === 'sentinel.paths.unbound');
  // B, asked in its own right after A was warmed, answers from B alone.
  const own = await b.paths(q);
  assert.equal(own.snapshotId, b.snapshot.id);
  assert.notEqual(own.results[0].outcome, 'reached');
});

test('round 2: returning a Unicode-named function hands it on as a value: a frontier, never absence', needsStore, async t => {
  const { paths } = await setup(t, { ...PATHS_APP, 'src/value.ts': `import { query } from './db.js';

export function ƒlush() {
  return query('select 1');
}

export function pickUnicode() {
  return [ƒlush];
}
` });
  const env = await paths([{ from: id('src/value.ts', 'pickUnicode'), to: id('src/db.ts', 'query') }]);
  assert.deepEqual(outcome(env), ['not-reached-bounded', 'functionAsValue']);
});

// ---- review round 3 (SOL, 5047b42): escaped identifiers, distant parameter lists, mutated inputs, unverified bytes ----

test('round 3: an escaped identifier makes a function opaque, a distant parameter list still shadows, and a mutated input is rebuilt', needsStore, async t => {
  const { paths } = await setup(t, { ...PATHS_APP, 'src/escape.ts': `import { query } from './db.js';

export function sink() {
  return query('drop');
}

export function pickEscaped() {
  return \\u0073ink;
}

export function callEscaped() {
  return \\u{73}ink();
}

export function dispatch(sink: () => void): void /* ${'x'.repeat(600)} */ {
  sink();
}
` });
  const env = await paths([
    { from: id('src/escape.ts', 'pickEscaped'), to: id('src/db.ts', 'query') },
    { from: id('src/escape.ts', 'callEscaped'), to: id('src/escape.ts', 'sink') },
    { from: id('src/escape.ts', 'dispatch'), to: id('src/escape.ts', 'sink') },
  ]);
  assert.deepEqual(outcome(env, 0), ['not-reached-bounded', 'escapedIdentifier']);
  assert.notEqual(env.results[1].outcome, 'reached');
  assert.notEqual(env.results[2].outcome, 'reached');
  assert.ok(env.results[2].frontierReasons.includes('sentinel.paths.shadowedCall'));
});

test('round 3: parser evidence changed after it was cached is never served from the cache', needsStore, async t => {
  const start = (body: string) => ({ ...PATHS_APP, 'src/start.ts': `import { query } from './db.js';\n\nexport function start() {\n  ${body}\n}\n` });
  const a = await setup(t, start('return query(\'select 1\');'));
  const b = await setup(t, start('return 0;'));
  const q = [{ from: id('src/start.ts', 'start'), to: id('src/db.ts', 'query') }];
  // Mutable copies that a caller could change after caching.
  const analysis: any = { sourceId: 'app', artifact: structuredClone(a.analysis.artifact), index: structuredClone(a.analysis.index) };
  assert.deepEqual(outcome(await boundedCallPaths({ snapshot: a.snapshot, analysis, queries: q, readContent: a.readContent })), ['reached']);
  Object.assign(analysis.artifact, structuredClone(b.analysis.artifact));
  Object.assign(analysis.index, structuredClone(b.analysis.index));
  const env = await boundedCallPaths({ snapshot: b.snapshot, analysis, queries: q, readContent: b.readContent });
  assert.notEqual(env.results[0].outcome, 'reached');
  assert.equal(env.analysisFingerprint, b.analysis.artifact.analysis.fingerprint);
});

test('round 3: imported locations are checked against verified captured bytes, never a reader\'s length', needsStore, async t => {
  const { doc, run, entry, snapshot, text } = await importFixture(t);
  const routes = entry('src/routes.ts');
  const wide = { ...doc, flows: [{ ...doc.flows[0], source: { ...doc.flows[0]!.source, span: { startByte: 0, endByte: routes.bytes + 100 } } }] };
  const authorization = ownerConfirms(t, deepImportIntent(text(wide), snapshot.id));
  // A reader returning more, unrelated bytes cannot widen what a span may cover.
  const r: any = await importDeepAnalysis({ document: text(wide), snapshot, authorization, importedAt: '2026-10-22T10:00:00Z', readContent: async () => Buffer.alloc(100_000, 0) });
  assert.equal(r.observations.length, 0);
  assert.deepEqual(r.unknown.map((u: any) => u.reasonCode), ['sentinel.deep.contentUnverified']);
});
