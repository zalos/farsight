// Structural task data is exact and bounded before store access; it grants no authority (ADR 45).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathRequestOf, parsePathRequest, PathRequestError, MAX_PATH_REQUEST_BYTES, MAX_PATH_REQUEST_QUERIES } from '../dist/analysis/paths/request.js';
import { validateEnvelope, parseEnvelope } from '../dist/validate.js';
import { digestOf } from '../dist/store/ledger-json.js';

const fixture = () => JSON.parse(readFileSync(new URL('./contracts/valid/pathrequest.json', import.meta.url), 'utf8'));
const invalid = (f: () => unknown) => assert.throws(f, (e: any) => e instanceof PathRequestError && e.reason === 'invalid');

test('canonical request identity ignores JSON formatting and seals a detached copy, never adding a grant', () => {
  const input = fixture(), original = structuredClone(input);
  const a = pathRequestOf(input), b = parsePathRequest(JSON.stringify(input, null, 4));
  assert.equal(a.id, digestOf(original)); assert.equal(a.id, b.id);
  input.queries[0].to = 'changed'; input.bounds.maxDepth = 1;
  assert.deepEqual(a.value, original);
  assert.ok(Object.isFrozen(a.value) && Object.isFrozen(a.value.queries) && Object.isFrozen(a.value.bounds));
  assert.deepEqual(Object.keys(a).sort(), ['id', 'value']);
});

test('schema rejects broader edges, unknown fields, duplicate or unordered tuples, same-node queries and invalid bounds', () => {
  const mutations = [
    (v: any) => v.bounds.edgeKinds.push('validates'),
    (v: any) => v.bounds.edgeKinds.push('calls'),
    (v: any) => v.bounds.edgeKinds.unshift('renders'),
    (v: any) => v.queries.push(structuredClone(v.queries[0])),
    (v: any) => v.queries.unshift({ from: 'z', to: 'zz' }),
    (v: any) => v.queries[0].to = v.queries[0].from,
    (v: any) => v.queries = [],
    (v: any) => v.authorization = { who: 'human', approved: true },
    (v: any) => v.bounds.maxDepth = 0,
    (v: any) => v.bounds.maxDepth = 65,
    (v: any) => v.bounds.maxFanout = 4097,
    (v: any) => v.bounds.maxVisited = 1_000_001,
    (v: any) => v.ancestor.revision = 0,
  ];
  for (const mutate of mutations) { const v = fixture(); mutate(v); invalid(() => pathRequestOf(v)); }
  const v = fixture(); v.bounds = { edgeKinds: ['calls', 'http', 'renders'], maxDepth: 64, maxFanout: 4096, maxVisited: 1_000_000 };
  assert.equal(validateEnvelope('pathrequest', v).ok, true, 'the exact library maxima are supported');
});

test('byte and count bounds reject before parsing or inspecting query elements; malformed UTF-8 never substitutes bytes', () => {
  assert.throws(() => parsePathRequest(' '.repeat(MAX_PATH_REQUEST_BYTES + 1)), (e: any) => e.reason === 'too-large');
  const generic = parseEnvelope('pathrequest', ' '.repeat(MAX_PATH_REQUEST_BYTES + 1));
  assert.equal(generic.ok, false);
  if (!generic.ok) assert.equal(generic.errors[0]!.code, 'sentinel.contract.tooLarge', 'the general facade also bounds before parsing');
  invalid(() => parsePathRequest(Uint8Array.of(0xc3, 0x28)));
  const v = fixture(); v.queries = new Array(MAX_PATH_REQUEST_QUERIES + 1);
  Object.defineProperty(v.queries, 0, { get() { throw new Error('element must not be read'); } });
  invalid(() => pathRequestOf(v));
  const long = fixture(); long.queries = Array.from({ length: 1000 }, (_, n) => ({ from: `${String(n).padStart(4, '0')}${'a'.repeat(1000)}`, to: 'b'.repeat(1024) }));
  invalid(() => pathRequestOf(long));
});

test('bootstrap rejects a request pin, while old canonical plan bytes still validate unchanged', () => {
  for (const name of ['plan-bootstrap', 'plan-analysis']) {
    const before = readFileSync(new URL(`./contracts/valid/${name}.json`, import.meta.url), 'utf8');
    const plan = JSON.parse(before);
    assert.equal(validateEnvelope('plan', plan).ok, true);
    assert.equal(plan.pins.pathRequest, undefined);
    assert.equal(JSON.stringify(plan), JSON.stringify(JSON.parse(before)), 'validation adds no default pin');
    if (name === 'plan-bootstrap') {
      plan.pins.pathRequest = pathRequestOf(fixture()).id;
      const { digest: _digest, ...body } = plan; plan.digest = digestOf(body);
      const checked = validateEnvelope('plan', plan);
      assert.equal(checked.ok, false);
      if (!checked.ok) assert.ok(checked.errors.some(e => e.path === '/pins/pathRequest'));
    }
  }
});

test('planner pins queries in only their source path-unit fingerprint; other sources and deep-flow requirements stay unavailable', async () => {
  const { createAdapterRegistry } = await import('../dist/execution/registry.js');
  const { planAnalysis, createCapabilityTable, influenceManifestOf } = await import('../dist/planner/index.js');
  const { included, snapshotView, analysisView, lockedRules, policyView } = await import('./planner-helpers.ts');
  const { fileURLToPath } = await import('node:url');
  const module = fileURLToPath(new URL('./fixtures/workers/hostile-worker.mjs', import.meta.url));
  const registry = createAdapterRegistry([
    { id: 'bounded-paths', kind: 'built-in', isolation: 'child', version: '1', module },
    { id: 'sentinel-pattern', kind: 'built-in', isolation: 'child', version: '1', module },
  ]);
  const facts = [
    { capability: 'source-bytes', adapterId: 'bounded-paths', evidence: 'original pure planner fixture' },
    { capability: 'call-occurrence', adapterId: 'bounded-paths', evidence: 'original pure planner fixture', perFileParse: true },
    { capability: 'pattern-match', adapterId: 'sentinel-pattern', evidence: 'original pure planner fixture' },
  ];
  const profile = { id: 'paths-fixture', registry, capabilities: createCapabilityTable(registry, facts), permits: facts.map(f => f.capability) };
  const entries = [included('example', 'src/entry.ts'), included('example', 'src/sink.ts'), included('other', 'src/other.ts')];
  const snapshot = snapshotView(['example', 'other'], entries, [], 'snapshot-example');
  const rules = lockedRules([
    { familyId: 'sentinel.paths.call-reachability', adapterId: 'bounded-paths', scopeKind: 'repository', requires: ['source-bytes', 'call-occurrence'] },
    { familyId: 'sentinel.paths.unavailable-deep', adapterId: 'bounded-paths', scopeKind: 'repository', requires: ['interprocedural-flow'] },
    { familyId: 'sentinel.ts.fixture' },
  ]);
  const args = { runId: 'run-path-query', bootstrap: [{ id: 'inventory-parent', revision: 1 }], profile,
    snapshot: snapshot.view, analyses: ['example', 'other'].map(sourceId => analysisView(sourceId, entries.filter(e => e.sourceId === sourceId).map(e => ({ path: e.relativePath, class: 'parsed', content: e.content })), [], `fp-${sourceId}`, snapshot.envelope.id)),
    lock: rules.view, policy: policyView(rules.view.rules.map(r => r.familyId)).view };
  const original = planAnalysis(args), explicitlyAbsent = planAnalysis({ ...args, pathRequest: undefined });
  assert.deepEqual(original, explicitlyAbsent, 'no optional pin means byte-identical old planner output');
  assert.equal(original.pins.pathRequest, undefined);
  const request = fixture(), changed = fixture(); changed.bounds.maxDepth++;
  const a = planAnalysis({ ...args, pathRequest: request }), b = planAnalysis({ ...args, pathRequest: changed });
  assert.equal(a.pins.pathRequest, pathRequestOf(request).id);
  const pathUnit = a.units.find(u => u.adapterId === 'bounded-paths')!;
  assert.ok(pathUnit); assert.equal(pathUnit.sourceId, 'example');
  assert.deepEqual(pathUnit.inputs.map(i => i.relativePath), ['src/entry.ts', 'src/sink.ts']);
  assert.notEqual(pathUnit.inputFingerprint, b.units.find(u => u.adapterId === 'bounded-paths')!.inputFingerprint);
  assert.equal(influenceManifestOf(a, pathUnit).pins.pathRequest, a.pins.pathRequest);
  assert.equal(a.checks.find(c => c.sourceId === 'other' && c.familyId === 'sentinel.paths.call-reachability')!.state, 'scope-unavailable');
  assert.ok(a.checks.filter(c => c.familyId === 'sentinel.paths.unavailable-deep').every(c => c.state === 'unsupported'), 'a path request is not deep-flow capability');
  for (const unit of a.units.filter(u => u.adapterId !== 'bounded-paths')) assert.equal(unit.inputFingerprint, b.units.find(u => u.id === unit.id)!.inputFingerprint);
  assert.ok(original.checks.filter(c => c.familyId === 'sentinel.paths.call-reachability').every(c => c.state === 'scope-unavailable'));
  for (const mutate of [(v: any) => v.snapshotId = 'another', (v: any) => v.sourceId = 'missing', (v: any) => v.ancestor.runId = args.runId]) {
    const bad = fixture(); mutate(bad); assert.throws(() => planAnalysis({ ...args, pathRequest: bad }), (e: any) => e.code === 'sentinel.plan.pinMismatch');
  }
});

test('request and generation identity changes for changed exact queries, bounds, terms or terminal generation', async () => {
  const { pathRequestRunId } = await import('../dist/analysis/paths/request.js');
  const terms = { ruleLockDigest: `sha256:${'1'.repeat(64)}`, policyDigest: `sha256:${'2'.repeat(64)}`, profileDigest: `sha256:${'3'.repeat(64)}` } as const;
  const original = fixture(), id = pathRequestRunId(original, terms);
  assert.equal(pathRequestRunId(JSON.parse(JSON.stringify(original)), terms), id);
  assert.notEqual(pathRequestRunId(original, terms, 1), id);
  const query = fixture(); query.queries[0].to = 'example::src/sink.ts::another'; assert.notEqual(pathRequestRunId(query, terms), id);
  const bounds = fixture(); bounds.bounds.maxDepth++; assert.notEqual(pathRequestRunId(bounds, terms), id);
  assert.notEqual(pathRequestRunId(original, { ...terms, policyDigest: `sha256:${'4'.repeat(64)}` }), id);
  invalid(() => pathRequestRunId(original, terms, -1));
  assert.equal(pathRequestRunId(original, { ...terms, structuralPaths: 'ignored' } as any), id, 'extra caller fields cannot override the request digest');
  invalid(() => pathRequestRunId(original, { ...terms, policyDigest: { toString: () => terms.policyDigest } } as any));
});
