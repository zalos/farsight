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
