import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateEnvelope, parseEnvelope, schemaOf, negotiateProtocol, policyResultOf, POLICY_EXIT_CODES,
  ENVELOPES, ENVELOPE_KINDS, MAX_ENVELOPE_BYTES,
  RUN_STATES, RUN_OUTCOMES, POLICY_RESULTS, WORK_STATES, STAGE_KINDS, ATTEMPT_STATES, USAGE_CERTAINTIES,
  IDENTITY_SOURCES, CAPTURE_MODES, COVERAGE_STATUSES, COVERAGE_GRANULARITIES, COVERAGE_BASES,
  DISPOSITION_DECISIONS, DECISION_CHANNELS, ASSERTION_TRUSTS, COMPARISON_LABELS, PROTOCOL_MESSAGE_TYPES,
} from '../dist/index.js';
import type { EnvelopeKind, HelloMessage } from '../dist/index.js';
import { MAX_REPORTED_ERRORS } from '../dist/index.js';
import { counted, countedProblems } from '@farsight/core/dist/counts.js';
import { Ajv } from 'ajv';
import { isCalendarTimestamp, isSafeRelativePath } from '../dist/index.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VALID = here('./contracts/valid/');
const pkg = here('../');
const kindOf = (file: string) => file.replace(/\.json$/, '').split('-')[0] as EnvelopeKind;
const load = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8'));
const validFiles = readdirSync(VALID).filter(f => f.endsWith('.json')).sort();

test('every valid fixture validates as its kind, and every kind has one', () => {
  for (const file of validFiles) {
    const result = validateEnvelope(kindOf(file), JSON.parse(readFileSync(VALID + file, 'utf8')));
    assert.ok(result.ok, `${file}: ${JSON.stringify(!result.ok && result.errors)}`);
  }
  assert.deepEqual([...new Set(validFiles.map(kindOf))].sort(), [...ENVELOPE_KINDS].sort());
});

test('valid fixtures reach every union branch', () => {
  const all = validFiles.map(f => [kindOf(f), JSON.parse(readFileSync(VALID + f, 'utf8'))] as const);
  const seen = (kind: string, pick: (v: any) => unknown[]) => new Set(all.filter(([k]) => k === kind).flatMap(([, v]) => pick(v)));
  assert.deepEqual([...seen('protocol', v => [v.type])].sort(), [...PROTOCOL_MESSAGE_TYPES].sort());
  assert.deepEqual([...seen('coverage', v => [v.basis.kind])].sort(), [...COVERAGE_BASES].sort());
  assert.deepEqual([...seen('attempt', v => [v.worker.kind])].sort(), ['external-claim', 'owned-child', 'owned-container']);
  assert.deepEqual([...seen('observation', v => [v.producer.kind])].sort(), ['framework-pack', 'imported', 'model-review', 'scanner']);
  assert.deepEqual([...seen('disposition', v => [v.state])].sort(), ['approved', 'proposed']);
  for (const s of ['pending', 'running', 'leased', 'blocked', 'satisfied-by-reuse']) assert.ok(seen('work', v => [v.state]).has(s), s);
  assert.ok(seen('run', v => [v.state]).has('completed') && seen('run', v => [v.state]).has('running'));
  assert.ok(seen('attempt', v => [v.state]).has('running') && seen('attempt', v => [v.state]).has('succeeded'));
  const entries = seen('snapshot', v => v.entries.map((e: any) => `${e.kind}:${e.disposition === 'included' ? 'included' : 'recorded'}`));
  assert.deepEqual([...entries].sort(), ['directory-boundary:recorded', 'file:included', 'file:recorded', 'symlink:recorded']);
  assert.deepEqual([...seen('snapshot', v => v.frameworkVersions.map((f: any) => f.state))].sort(), ['resolved', 'unknown']);
  assert.deepEqual([...seen('report', v => v.findings.flatMap((f: any) => f.evidence.map((e: any) => e.state)))].sort(), ['embedded', 'withheld']);
});

type Op ={ set: string; value: unknown } | { delete: string } | { append: string; from: string };
const segs = (p: string) => p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
function at(root: any, path: string): [any, string] {
  const parts = segs(path);
  const last = parts.pop()!;
  let node = root;
  for (const p of parts) node = node[p];
  return [node, last];
}
function apply(value: any, ops: Op[]) {
  for (const op of ops) {
    if ('set' in op) { const [n, k] = at(value, op.set); n[k] = structuredClone(op.value); }
    else if ('delete' in op) { const [n, k] = at(value, op.delete); if (Array.isArray(n)) n.splice(Number(k), 1); else delete n[k]; }
    else { const [n, k] = at(value, op.from); const [list, key] = at(value, op.append); list[key].push(structuredClone(n[k])); }
  }
  return value;
}

const cases = JSON.parse(readFileSync(here('./contracts/invalid/cases.json'), 'utf8')) as Array<{
  name: string; base: string; ops: Op[]; expect: string; path?: string;
}>;

test('every invalid case is refused with its stated code (and location)', () => {
  assert.ok(cases.length >= 100);
  for (const c of cases) {
    const value = apply(load(c.base), c.ops);
    const result = validateEnvelope(kindOf(c.base), value);
    assert.equal(result.ok, false, `accepted: ${c.name}`);
    if (result.ok) continue;
    assert.ok(result.errors.some(e => e.code === c.expect), `${c.name}: wanted ${c.expect}, got ${JSON.stringify(result.errors.slice(0, 3))}`);
    if (c.path !== undefined) assert.ok(result.errors.some(e => e.code === c.expect && e.path === c.path), `${c.name}: wanted path ${c.path}, got ${result.errors.map(e => e.path).join(', ')}`);
  }
});

test('version mismatch names the supported version and never coerces', () => {
  const value = load('run-active');
  value.schema = 'sentinel-run/draft-2';
  const before = structuredClone(value);
  const result = validateEnvelope('run', value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, [{
    code: 'sentinel.contract.unsupportedVersion', path: '/schema', message: 'this build does not read that version',
    supported: ['sentinel-run/draft-1'],
  }]);
  assert.deepEqual(value, before, 'validation never mutates its input');
  const unknown = validateEnvelope('ledger' as EnvelopeKind, value);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.errors[0]!.code, 'sentinel.contract.unknownKind');
  for (const bad of [null, [], 'text', 3]) {
    const r = validateEnvelope('snapshot', bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'sentinel.contract.missingVersion');
  }
});

test('bounds hold exactly at the limit and fail one past it', () => {
  const at = (mut: (v: any) => void, base = 'snapshot') => { const v = load(base); mut(v); return validateEnvelope(kindOf(base), v).ok; };
  const path4096 = 'a/'.repeat(2047) + 'bc';
  assert.equal(path4096.length, 4096);
  assert.equal(at(v => { v.entries[0].relativePath = path4096; }), true);
  assert.equal(at(v => { v.entries[0].relativePath = path4096 + 'd'; }), false);
  assert.equal(at(v => { v.message = 'x'.repeat(4000); }, 'observation-scanner'), true);
  assert.equal(at(v => { v.message = 'x'.repeat(4001); }, 'observation-scanner'), false);
  assert.equal(at(v => { v.id = 'r'.repeat(128); }, 'run-active'), true);
  assert.equal(at(v => { v.requestedScope.sourceIds = Array.from({ length: 64 }, (_, i) => `s${i}`); }, 'run-active'), true);
  assert.equal(at(v => { v.requestedScope.sourceIds = Array.from({ length: 65 }, (_, i) => `s${i}`); }, 'run-active'), false);
  assert.equal(at(v => { v.resources.memoryBytes = 2147483648; v.resources.maxPids = 128; v.resources.deadlineMs = 120000; }, 'work-running'), true);
  assert.equal(at(v => { v.entries[0].bytes = Number.MAX_SAFE_INTEGER; }), true);
  assert.equal(at(v => { v.entries[0].bytes = Number.MAX_SAFE_INTEGER + 2; }), false);
  // Leading-dot names are ordinary paths; only `.`/`..` segments are refused.
  assert.equal(at(v => { v.entries[0].relativePath = '.github/..hidden/.env.example'; }), true);
});

test('serialized input is size-checked before it is parsed', () => {
  const big = parseEnvelope('report', ' '.repeat(MAX_ENVELOPE_BYTES + 1));
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.errors[0]!.code, 'sentinel.contract.tooLarge');
  const bad = parseEnvelope('report', '{"schema":');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.errors[0]!.code, 'sentinel.contract.malformedJson');
  const ok = parseEnvelope('report', readFileSync(`${VALID}report.json`, 'utf8'));
  assert.equal(ok.ok, true);
});

test('producer text is kept as data, not interpreted or stripped', () => {
  const r = validateEnvelope('observation', load('observation-model'));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.message, '<script>alert(1)</script> is kept as data.');
});

// Pinned enum sets: the explicit literal list, the exported constant and the generated schema must agree.
function schemaEnum(kind: EnvelopeKind, def: string, prop?: string): string[] {
  const defs = (schemaOf(kind) as any).definitions;
  let d = defs[def];
  if (prop) d = d.properties[prop];
  if (d.$ref) d = defs[d.$ref.split('/').pop()];
  if (d.enum) return [...d.enum];
  return d.anyOf ? d.anyOf.flatMap((a: any) => a.const !== undefined ? [a.const] : a.enum) : [d.const];
}
const PINS: Array<[string, readonly string[], string[], string[]]> = [
  ['run states', RUN_STATES, ['planned', 'running', 'pausing', 'paused', 'canceling', 'canceled', 'completed'], schemaEnum('run', 'RunEnvelope', 'state')],
  ['run outcomes', RUN_OUTCOMES, ['complete-coverage', 'partial-coverage', 'execution-failure'], schemaEnum('run', 'RunOutcome')],
  ['policy results', POLICY_RESULTS, ['satisfied', 'finding-policy-failed', 'required-coverage-incomplete', 'configuration-failure', 'awaiting-confirmation'], schemaEnum('run', 'PolicyResult')],
  ['work states', WORK_STATES, ['pending', 'ready', 'published', 'failed', 'running', 'leased', 'blocked', 'disabled-by-policy', 'satisfied-by-reuse'], schemaEnum('work', 'WorkEnvelope', 'state')],
  ['stage kinds', STAGE_KINDS, ['coded', 'agentic', 'external-tool'], schemaEnum('work', 'StageKind')],
  ['attempt states', ATTEMPT_STATES, ['running', 'succeeded', 'failed', 'interrupted', 'canceled', 'canceled-after-spend'], schemaEnum('attempt', 'AttemptEnvelope', 'state')],
  ['usage certainty', USAGE_CERTAINTIES, ['confirmed', 'unknown', 'not-applicable'], schemaEnum('attempt', 'UsageCertainty')],
  ['identity sources', IDENTITY_SOURCES, ['provider-response', 'local-weight-digest', 'host-reported', 'self-reported', 'unknown'], schemaEnum('attempt', 'IdentitySource')],
  ['capture modes', CAPTURE_MODES, ['committed-tree', 'working-copy-stability-checked'], schemaEnum('snapshot', 'CaptureMode')],
  ['coverage statuses', COVERAGE_STATUSES, ['complete', 'partial', 'unsupported', 'not-run', 'error'], schemaEnum('coverage', 'CoverageStatus')],
  ['coverage granularity', COVERAGE_GRANULARITIES, ['per-file-per-rule', 'per-file', 'aggregate'], schemaEnum('coverage', 'CoverageGranularity')],
  ['coverage basis', COVERAGE_BASES, ['executed', 'reused', 'imported', 'unavailable'], schemaEnum('coverage', 'CoverageBasis', 'kind')],
  ['decisions', DISPOSITION_DECISIONS, ['accepted-risk', 'false-positive', 'mitigated', 'deferred'], schemaEnum('disposition', 'DispositionDecision')],
  ['decision channels', DECISION_CHANNELS, ['owner-cli', 'mcp', 'http-bridge', 'model'], schemaEnum('disposition', 'DecisionChannel')],
  ['assertion trust', ASSERTION_TRUSTS, ['asserted', 'imported-config', 'runtime-observed'], schemaEnum('disposition', 'AssertionTrust')],
  ['comparison labels', COMPARISON_LABELS, ['new', 'persistent', 'changed-evidence', 'changed-detection', 'reopened', 'reopened-disposition-expired', 'resolved-by-comparable-check', 'removed-surface', 'unassessed-in-current-scope', 'incomparable-conditions'], schemaEnum('report', 'ComparisonLabel')],
  ['protocol messages', PROTOCOL_MESSAGE_TYPES, ['hello', 'welcome', 'refuse', 'start', 'cancel', 'progress', 'checkpoint', 'heartbeat', 'diagnostic', 'cancel-ack', 'result'], schemaEnum('protocol', 'ProtocolMessage', 'type')],
];

test('enum sets are pinned to an explicit list and to the generated schema', () => {
  for (const [name, exported, literal, schema] of PINS) {
    assert.deepEqual([...exported], literal, `${name}: exported constant`);
    assert.deepEqual([...schema].sort(), [...literal].sort(), `${name}: schema`);
  }
  assert.deepEqual(Object.keys(POLICY_EXIT_CODES).sort(), [...POLICY_RESULTS].sort());
});

test('the published schemas are generated from the types and carry their version', () => {
  const r = spawnSync(process.execPath, [`${pkg}scripts/generate-schemas.mjs`, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(`${pkg}schemas`).sort();
  assert.deepEqual(files, ENVELOPE_KINDS.map(k => `${ENVELOPES[k].schema.replace('/', '.')}.schema.json`).sort());
  for (const kind of ENVELOPE_KINDS) {
    const file = JSON.parse(readFileSync(`${pkg}schemas/${ENVELOPES[kind].schema.replace('/', '.')}.schema.json`, 'utf8'));
    assert.deepEqual(file, schemaOf(kind), `${kind}: file and bundled module agree`);
    assert.equal(file.title, ENVELOPES[kind].schema);
    assert.equal(file.$ref, `#/definitions/${ENVELOPES[kind].type}`);
    assert.match(file.$id, /^https:\/\/github\.com\/zalos\/farsight\//);
    assert.match(ENVELOPES[kind].schema, /\/draft-1$/, 'drafts until independent review approves a freeze');
  }
});

// Every JSON object node in a schema, with its definition name (properties, nested objects, array items, branches).
function objectNodes(kind: EnvelopeKind): Array<{ def: string; node: any }> {
  const out: Array<{ def: string; node: any }> = [];
  const visit = (def: string, node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) out.push({ def, node });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(v => visit(def, v));
      else if (value && typeof value === 'object') visit(def, value);
    }
  };
  for (const [def, node] of Object.entries((schemaOf(kind) as any).definitions)) visit(def, node);
  return out;
}
const refName = (s: any): string | undefined => s?.$ref?.split('/').pop() ?? s?.items?.$ref?.split('/').pop();

test('every reference that names work carries its revision (the plan, not the legacy StageResult)', () => {
  let workRefs = 0;
  for (const kind of ENVELOPE_KINDS) {
    for (const { def, node } of objectNodes(kind)) {
      const props = node.properties as Record<string, any>;
      if ('workId' in props) {
        assert.ok('workRevision' in props && node.required?.includes('workRevision'), `${kind} ${def}: workId without a required workRevision`);
      }
      for (const [name, schema] of Object.entries(props)) {
        if (['work', 'publication', 'dependencies'].includes(name)) {
          assert.equal(refName(schema), 'WorkRef', `${kind} ${def}.${name} must be a WorkRef`);
          workRefs++;
        }
      }
    }
  }
  const workRef = (schemaOf('work') as any).definitions.WorkRef;
  assert.deepEqual(workRef.required, ['id', 'revision']);
  assert.ok(workRefs >= 6, `found ${workRefs} work references`);
  // The worker result binds the work revision too: the legacy StageResult's bare workId is not accepted.
  const result = load('protocol-result');
  delete result.work.revision;
  assert.equal(validateEnvelope('protocol', result).ok, false);
});

test('a snapshot holds capture facts only; analysis outcomes live in their own envelopes', () => {
  const props = new Set(objectNodes('snapshot').flatMap(({ node }) => Object.keys(node.properties)));
  for (const analysis of ['coverage', 'stageCoverage', 'status', 'outcome', 'parsed', 'observations', 'findings', 'seenByNoStage', 'workId', 'attemptId']) {
    assert.ok(!props.has(analysis), `snapshot carries ${analysis}`);
  }
  const snapshot = load('snapshot');
  snapshot.entries[0].coverage = 'complete';
  assert.equal(validateEnvelope('snapshot', snapshot).ok, false, 'stage coverage cannot be written into a capture entry');
});

test('a large broken record produces a bounded error list, not one error per element', () => {
  // 10,000 empty entries: Ajv stops at the first failure instead of building 250,000 errors.
  const snap = load('snapshot');
  snap.entries = Array.from({ length: 10_000 }, () => ({}));
  const before = process.memoryUsage().heapUsed;
  const r = validateEnvelope('snapshot', snap);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.length <= 8, `${r.errors.length} errors`);
    assert.ok(JSON.stringify(r.errors).length < 8_192, `${JSON.stringify(r.errors).length} bytes`);
  }
  assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024, 'validation allocates far less than the reported regression');
  // Schema-valid input that breaks an invariant everywhere: collection stops at the limit and says so.
  const dup = load('snapshot');
  dup.entries = Array.from({ length: 20_000 }, () => structuredClone(dup.entries[0]));
  const d = validateEnvelope('snapshot', dup);
  assert.equal(d.ok, false);
  if (!d.ok) {
    assert.equal(d.errors.length, MAX_REPORTED_ERRORS + 1);
    assert.equal(d.errors.at(-1)!.code, 'sentinel.contract.errorLimit');
  }
});

const BYPASS_PATHS = [
  'a\n/../../outside', 'a\r/../outside', 'a\r\n/../outside', 'a\u2028/../outside', 'a\u2029/../outside',
  'src\n/', 'a\n//b', 'x\n/./y', '\n/../x', 'a/b\n/..',
];

test('a line break in a name cannot hide a parent, dot or empty segment, in the schema alone or at runtime', () => {
  // The published schema on its own, as any other consumer would run it (no Sentinel invariants).
  const plain = new Ajv({ strict: true, allowUnionTypes: true }).addFormat('date-time', { type: 'string', validate: isCalendarTimestamp });
  const schemaOnly = plain.compile(schemaOf('snapshot'));
  const withPath = (p: string) => { const v = load('snapshot'); v.entries[0].relativePath = p; return v; };
  for (const p of BYPASS_PATHS) {
    assert.equal(schemaOnly(withPath(p)), false, `schema accepted ${JSON.stringify(p)}`);
    assert.equal(isSafeRelativePath(p), false, `runtime accepted ${JSON.stringify(p)}`);
    assert.equal(validateEnvelope('snapshot', withPath(p)).ok, false, JSON.stringify(p));
  }
  // A line break is a legal byte in a POSIX name: such a file is captured and listed honestly, not dropped.
  for (const p of ['dir\nname/file.ts', 'notes\r.txt', 'a/..\n', 'a/\n..', 'x\u2028y/z']) {
    assert.equal(schemaOnly(withPath(p)), true, `schema refused ${JSON.stringify(p)}`);
    assert.equal(isSafeRelativePath(p), true, JSON.stringify(p));
    assert.equal(validateEnvelope('snapshot', withPath(p)).ok, true, JSON.stringify(p));
  }
});

test('timestamps are real calendar instants', () => {
  const ok = (t: string) => { const v = load('snapshot'); v.createdAt = t; return validateEnvelope('snapshot', v).ok; };
  assert.equal(ok('2028-02-29T00:00:00Z'), true, 'a leap day');
  assert.equal(ok('2026-02-29T00:00:00Z'), false, 'not a leap year');
  assert.equal(ok('2026-04-31T00:00:00Z'), false);
  assert.equal(ok('2026-12-31T23:59:59.123456789Z'), true);
  assert.equal(ok('2026-99-99T99:99:99Z'), false);
  assert.equal(ok('2026-02-30T12:00:00Z'), false);
  assert.equal(isCalendarTimestamp('2026-02-30T12:00:00Z'), false);
});

test('report counts are core Counted values with registered catalog words', () => {
  const report = load('report');
  const counts = [
    ...Object.entries(report.counts).map(([k, c]) => [`counts.${k}`, c] as const),
    ...[...report.findings, ...report.gaps].flatMap((row: any, i: number) => Object.entries(row.place.counts).map(([k, c]) => [`place ${i} ${k}`, c] as const)),
  ];
  assert.ok(counts.length >= 12);
  for (const [where, c] of counts) assert.deepEqual(countedProblems(c as any, where), [], where);
  // Everything core's own constructor can produce — bizUnit, recheck, labelled parts — is accepted unchanged.
  const full = counted(1, 'sentinel.count.findings', 'sentinel.scope.report', 'sentinel report fold draft-1', {
    bizUnit: 'sentinel.count.issues',
    breakdown: [{ key: 'sentinel.count.part.high', n: 1, label: 'Invoice submission' }],
    recheck: { cli: 'farsight-sentinel report --run run-2 --json', mcp: 'sentinel_report' },
  });
  assert.deepEqual(countedProblems(full), []);
  report.counts.findings = full;
  const r = validateEnvelope('report', report);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  if (r.ok) assert.deepEqual(r.value.counts.findings, full);
});

test('placement uses canonical graph identities, not ledger ids', () => {
  const report = load('report');
  const long = `web::${'src/components/'.repeat(60)}Invoice.tsx::InvoiceForm`;
  assert.ok(long.length > 200 && long.length <= 1024);
  report.findings[0].place.nodeIds = [long, 'api::src/routes/invoice.ts::submit'];
  report.findings[0].place.screens[0].id = long;
  report.findings[0].place.journeys[0].screenIds = [long];
  report.findings[0].place.personas[0].screenIds = [long];
  const r = validateEnvelope('report', report);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  // The same identity is valid as SourceEvidence.nodeId, so a finding can cite what it is placed on.
  const obs = load('observation-scanner');
  obs.evidence[0].nodeId = long;
  assert.ok(validateEnvelope('observation', obs).ok);
  // Ledger ids stay opaque: a graph-shaped id is not a run id.
  const run = load('run-active');
  run.id = 'api::src/run';
  assert.equal(validateEnvelope('run', run).ok, false);
});

test('a report decision is judged against the report\'s own clock; invalidation stays the service\'s word', () => {
  const report = load('report');
  report.decisions[0].expiresAt = '2026-10-21T12:05:00.251Z';
  assert.ok(validateEnvelope('report', report).ok, 'not yet expired one millisecond after the report time');
  report.decisions[0].validity = 'expired';
  report.decisions[0].expiresAt = '2020-01-01T00:00:00Z';
  assert.ok(validateEnvelope('report', report).ok);
  for (const expiresAt of [null, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z']) {
    report.decisions[0].validity = 'invalidated';
    report.decisions[0].expiresAt = expiresAt;
    assert.ok(validateEnvelope('report', report).ok, `invalidated with expiry ${expiresAt}`);
  }
});

test('policy results fold with fixed precedence and exit codes', () => {
  const f = { configurationFailure: false, awaitingConfirmation: false, requiredCoverageIncomplete: false, findingPolicyFailed: false };
  assert.equal(policyResultOf(f), 'satisfied');
  assert.equal(policyResultOf({ ...f, findingPolicyFailed: true }), 'finding-policy-failed');
  assert.equal(policyResultOf({ ...f, findingPolicyFailed: true, requiredCoverageIncomplete: true }), 'required-coverage-incomplete');
  assert.equal(policyResultOf({ ...f, findingPolicyFailed: true, requiredCoverageIncomplete: true, configurationFailure: true }), 'configuration-failure');
  assert.equal(policyResultOf({ ...f, awaitingConfirmation: true }), 'awaiting-confirmation');
  assert.equal(policyResultOf({ ...f, awaitingConfirmation: true, configurationFailure: true }), 'configuration-failure');
  assert.throws(() => policyResultOf({ ...f, awaitingConfirmation: true, findingPolicyFailed: true }), /precedes admission/);
  assert.deepEqual(POLICY_EXIT_CODES, {
    'satisfied': 0, 'finding-policy-failed': 1, 'required-coverage-incomplete': 2, 'configuration-failure': 3, 'awaiting-confirmation': 4,
  });
});

test('protocol negotiation selects the shared draft or refuses explicitly', () => {
  const hello = load('protocol-hello') as HelloMessage;
  assert.deepEqual(negotiateProtocol(hello), { protocol: 'sentinel-worker/draft-1', type: 'welcome', selected: 'sentinel-worker/draft-1' });
  const refused = negotiateProtocol({ ...hello, supported: ['sentinel-worker/draft-2', 'sentinel-worker/v1'] });
  assert.equal(refused.type, 'refuse');
  assert.ok(validateEnvelope('protocol', refused).ok);
  assert.ok(validateEnvelope('protocol', negotiateProtocol(hello)).ok);
});
