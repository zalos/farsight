import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateEnvelope,
  parseEnvelope,
  schemaOf,
  negotiateProtocol,
  policyResultOf,
  POLICY_EXIT_CODES,
  ENVELOPES,
  ENVELOPE_KINDS,
  MAX_ENVELOPE_BYTES,
  RUN_STATES,
  RUN_OUTCOMES,
  POLICY_RESULTS,
  WORK_STATES,
  STAGE_KINDS,
  ATTEMPT_STATES,
  USAGE_CERTAINTIES,
  IDENTITY_SOURCES,
  CAPTURE_MODES,
  COVERAGE_STATUSES,
  COVERAGE_GRANULARITIES,
  COVERAGE_BASES,
  DISPOSITION_DECISIONS,
  DECISION_CHANNELS,
  ASSERTION_TRUSTS,
  COMPARISON_LABELS,
  PROTOCOL_MESSAGE_TYPES,
  BUILTIN_PLAN_STAGES,
  REVIEW_PLAN_STAGES,
  PIPELINE_STAGE_KINDS,
  WORK_STAGE_KIND_OF,
  BUILTIN_OPERATIONS,
  STAGE_OUTPUT_TYPES,
  STAGE_FAN_OUTS,
  AGENT_RUNNERS,
  AGENT_MODES,
  EXECUTION_SITES,
  COST_UNOBSERVED_REASONS,
  FEATURE_FLAG_NAMES,
} from '../dist/index.js';
import { createGenerator } from 'ts-json-schema-generator';
import type { EnvelopeKind, HelloMessage } from '../dist/index.js';
import { MAX_REPORTED_ERRORS } from '../dist/index.js';
import { counted, countedProblems } from '@farsight/core/dist/counts.js';
import { Ajv } from 'ajv';
import { isCalendarTimestamp, isSafeRelativePath, compareTimestamps } from '../dist/index.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VALID = here('./contracts/valid/');
const pkg = here('../');
const kindOf = (file: string) => file.replace(/\.json$/, '').split('-')[0] as EnvelopeKind;
const load = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8'));
const validFiles = readdirSync(VALID)
  .filter((f) => f.endsWith('.json'))
  .sort();

test('every valid fixture validates as its kind, and every kind has one', () => {
  for (const file of validFiles) {
    const result = validateEnvelope(kindOf(file), JSON.parse(readFileSync(VALID + file, 'utf8')));
    assert.ok(result.ok, `${file}: ${JSON.stringify(!result.ok && result.errors)}`);
  }
  assert.deepEqual([...new Set(validFiles.map(kindOf))].sort(), [...ENVELOPE_KINDS].sort());
});

test('valid fixtures reach every union branch', () => {
  const all = validFiles.map((f) => [kindOf(f), JSON.parse(readFileSync(VALID + f, 'utf8'))] as const);
  const seen = (kind: string, pick: (v: any) => unknown[]) =>
    new Set(all.filter(([k]) => k === kind).flatMap(([, v]) => pick(v)));
  assert.deepEqual([...seen('protocol', (v) => [v.type])].sort(), [...PROTOCOL_MESSAGE_TYPES].sort());
  assert.deepEqual([...seen('coverage', (v) => [v.basis.kind])].sort(), [...COVERAGE_BASES].sort());
  assert.deepEqual([...seen('attempt', (v) => [v.worker.kind])].sort(), [
    'external-claim',
    'owned-child',
    'owned-container',
  ]);
  assert.deepEqual([...seen('observation', (v) => [v.producer.kind])].sort(), [
    'framework-pack',
    'imported',
    'model-review',
    'scanner',
  ]);
  assert.deepEqual([...seen('disposition', (v) => [v.state])].sort(), ['approved', 'proposed']);
  for (const s of ['pending', 'running', 'leased', 'blocked', 'satisfied-by-reuse'])
    assert.ok(seen('work', (v) => [v.state]).has(s), s);
  assert.ok(seen('run', (v) => [v.state]).has('completed') && seen('run', (v) => [v.state]).has('running'));
  assert.ok(seen('attempt', (v) => [v.state]).has('running') && seen('attempt', (v) => [v.state]).has('succeeded'));
  const entries = seen('snapshot', (v) =>
    v.entries.map((e: any) => `${e.kind}:${e.disposition === 'included' ? 'included' : 'recorded'}`),
  );
  assert.deepEqual([...entries].sort(), [
    'directory-boundary:recorded',
    'file:included',
    'file:recorded',
    'symlink:recorded',
  ]);
  assert.deepEqual([...seen('snapshot', (v) => v.frameworkVersions.map((f: any) => f.state))].sort(), [
    'resolved',
    'unknown',
  ]);
  assert.deepEqual(
    [...seen('report', (v) => v.findings.flatMap((f: any) => f.evidence.map((e: any) => e.state)))].sort(),
    ['embedded', 'withheld'],
  );
});

type Op = { set: string; value: unknown } | { delete: string } | { append: string; from: string };
const segs = (p: string) =>
  p
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
function at(root: any, path: string): [any, string] {
  const parts = segs(path);
  const last = parts.pop()!;
  let node = root;
  for (const p of parts) node = node[p];
  return [node, last];
}
function apply(value: any, ops: Op[]) {
  for (const op of ops) {
    if ('set' in op) {
      const [n, k] = at(value, op.set);
      n[k] = structuredClone(op.value);
    } else if ('delete' in op) {
      const [n, k] = at(value, op.delete);
      if (Array.isArray(n)) n.splice(Number(k), 1);
      else delete n[k];
    } else {
      const [n, k] = at(value, op.from);
      const [list, key] = at(value, op.append);
      list[key].push(structuredClone(n[k]));
    }
  }
  return value;
}

const cases = JSON.parse(readFileSync(here('./contracts/invalid/cases.json'), 'utf8')) as Array<{
  name: string;
  base: string;
  ops: Op[];
  expect: string;
  path?: string;
}>;

test('every invalid case is refused with its stated code (and location)', () => {
  assert.ok(cases.length >= 100);
  for (const c of cases) {
    const value = apply(load(c.base), c.ops);
    const result = validateEnvelope(kindOf(c.base), value);
    assert.equal(result.ok, false, `accepted: ${c.name}`);
    if (result.ok) continue;
    assert.ok(
      result.errors.some((e) => e.code === c.expect),
      `${c.name}: wanted ${c.expect}, got ${JSON.stringify(result.errors.slice(0, 3))}`,
    );
    if (c.path !== undefined)
      assert.ok(
        result.errors.some((e) => e.code === c.expect && e.path === c.path),
        `${c.name}: wanted path ${c.path}, got ${result.errors.map((e) => e.path).join(', ')}`,
      );
  }
});

test('version mismatch names the supported version and never coerces', () => {
  const value = load('run-active');
  value.schema = 'sentinel-run/draft-2';
  const before = structuredClone(value);
  const result = validateEnvelope('run', value);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.deepEqual(result.errors, [
      {
        code: 'sentinel.contract.unsupportedVersion',
        path: '/schema',
        message: 'this build does not read that version',
        supported: ['sentinel-run/draft-1'],
      },
    ]);
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
  const at = (mut: (v: any) => void, base = 'snapshot') => {
    const v = load(base);
    mut(v);
    return validateEnvelope(kindOf(base), v).ok;
  };
  const path4096 = 'a/'.repeat(2047) + 'bc';
  assert.equal(path4096.length, 4096);
  assert.equal(
    at((v) => {
      v.entries[0].relativePath = path4096;
    }),
    true,
  );
  assert.equal(
    at((v) => {
      v.entries[0].relativePath = path4096 + 'd';
    }),
    false,
  );
  assert.equal(
    at((v) => {
      v.message = 'x'.repeat(4000);
    }, 'observation-scanner'),
    true,
  );
  assert.equal(
    at((v) => {
      v.message = 'x'.repeat(4001);
    }, 'observation-scanner'),
    false,
  );
  assert.equal(
    at((v) => {
      v.id = 'r'.repeat(128);
    }, 'run-active'),
    true,
  );
  assert.equal(
    at((v) => {
      v.requestedScope.sourceIds = Array.from({ length: 64 }, (_, i) => `s${i}`);
    }, 'run-active'),
    true,
  );
  assert.equal(
    at((v) => {
      v.requestedScope.sourceIds = Array.from({ length: 65 }, (_, i) => `s${i}`);
    }, 'run-active'),
    false,
  );
  assert.equal(
    at((v) => {
      v.resources.memoryBytes = 2147483648;
      v.resources.maxPids = 128;
      v.resources.deadlineMs = 120000;
    }, 'work-running'),
    true,
  );
  assert.equal(
    at((v) => {
      v.entries[0].bytes = Number.MAX_SAFE_INTEGER;
    }),
    true,
  );
  assert.equal(
    at((v) => {
      v.entries[0].bytes = Number.MAX_SAFE_INTEGER + 2;
    }),
    false,
  );
  // Leading-dot names are ordinary paths; only `.`/`..` segments are refused.
  assert.equal(
    at((v) => {
      v.entries[0].relativePath = '.github/..hidden/.env.example';
    }),
    true,
  );
  // Observation evidence holds at most 256 citations of either shape, ordinary or withheld, or a mix.
  for (const base of ['observation-scanner', 'observation-withheld']) {
    const one = (v: any) => v.evidence[0];
    assert.equal(
      at((v) => {
        v.evidence = Array.from({ length: 256 }, () => ({ ...one(v) }));
      }, base),
      true,
      `${base}: 256 citations`,
    );
    assert.equal(
      at((v) => {
        v.evidence = Array.from({ length: 257 }, () => ({ ...one(v) }));
      }, base),
      false,
      `${base}: 257 citations`,
    );
  }
  const ordinary = load('observation-scanner').evidence[0];
  const withheld = load('observation-withheld').evidence[0];
  const mixed = (n: number) => (v: any) => {
    v.evidence = Array.from({ length: n }, (_, i) => ({ ...(i % 2 ? withheld : ordinary), snapshotId: v.snapshotId }));
  };
  assert.equal(at(mixed(256), 'observation-scanner'), true, 'a mix of 256');
  assert.equal(at(mixed(257), 'observation-scanner'), false, 'a mix of 257');
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
  return d.anyOf ? d.anyOf.flatMap((a: any) => (a.const !== undefined ? [a.const] : a.enum)) : [d.const];
}
const PINS: Array<[string, readonly string[], string[], string[]]> = [
  [
    'run states',
    RUN_STATES,
    ['planned', 'running', 'pausing', 'paused', 'canceling', 'canceled', 'completed'],
    schemaEnum('run', 'RunEnvelope', 'state'),
  ],
  [
    'run outcomes',
    RUN_OUTCOMES,
    ['complete-coverage', 'partial-coverage', 'execution-failure'],
    schemaEnum('run', 'RunOutcome'),
  ],
  [
    'policy results',
    POLICY_RESULTS,
    [
      'satisfied',
      'finding-policy-failed',
      'required-coverage-incomplete',
      'configuration-failure',
      'awaiting-confirmation',
    ],
    schemaEnum('run', 'PolicyResult'),
  ],
  [
    'work states',
    WORK_STATES,
    [
      'pending',
      'ready',
      'published',
      'failed',
      'running',
      'leased',
      'blocked',
      'disabled-by-policy',
      'satisfied-by-reuse',
    ],
    schemaEnum('work', 'WorkEnvelope', 'state'),
  ],
  ['stage kinds', STAGE_KINDS, ['coded', 'agentic', 'external-tool', 'script'], schemaEnum('work', 'StageKind')],
  [
    'built-in plan stages',
    BUILTIN_PLAN_STAGES,
    ['capture', 'parse', 'inventory', 'check'],
    schemaEnum('plan', 'BuiltinPlanStage'),
  ],
  [
    'built-in review stages',
    REVIEW_PLAN_STAGES,
    ['review-guided', 'review-general'],
    schemaEnum('plan', 'ReviewPlanStage'),
  ],
  [
    'attempt states',
    ATTEMPT_STATES,
    ['running', 'succeeded', 'failed', 'interrupted', 'canceled', 'canceled-after-spend'],
    schemaEnum('attempt', 'AttemptEnvelope', 'state'),
  ],
  [
    'usage certainty',
    USAGE_CERTAINTIES,
    ['confirmed', 'unknown', 'not-applicable'],
    schemaEnum('attempt', 'UsageCertainty'),
  ],
  [
    'identity sources',
    IDENTITY_SOURCES,
    ['provider-response', 'local-weight-digest', 'host-reported', 'self-reported', 'unknown'],
    schemaEnum('attempt', 'IdentitySource'),
  ],
  [
    'capture modes',
    CAPTURE_MODES,
    ['committed-tree', 'working-copy-stability-checked'],
    schemaEnum('snapshot', 'CaptureMode'),
  ],
  [
    'coverage statuses',
    COVERAGE_STATUSES,
    ['complete', 'partial', 'unsupported', 'not-run', 'error'],
    schemaEnum('coverage', 'CoverageStatus'),
  ],
  [
    'coverage granularity',
    COVERAGE_GRANULARITIES,
    ['per-file-per-rule', 'per-file', 'aggregate'],
    schemaEnum('coverage', 'CoverageGranularity'),
  ],
  [
    'coverage basis',
    COVERAGE_BASES,
    ['executed', 'reused', 'imported', 'unavailable'],
    schemaEnum('coverage', 'CoverageBasis', 'kind'),
  ],
  [
    'decisions',
    DISPOSITION_DECISIONS,
    ['accepted-risk', 'false-positive', 'mitigated', 'deferred'],
    schemaEnum('disposition', 'DispositionDecision'),
  ],
  [
    'decision channels',
    DECISION_CHANNELS,
    ['owner-cli', 'mcp', 'http-bridge', 'model', 'local-service', 'owner-ui'],
    schemaEnum('disposition', 'DecisionChannel'),
  ],
  [
    'assertion trust',
    ASSERTION_TRUSTS,
    ['asserted', 'imported-config', 'runtime-observed'],
    schemaEnum('disposition', 'AssertionTrust'),
  ],
  [
    'comparison labels',
    COMPARISON_LABELS,
    [
      'new',
      'persistent',
      'changed-evidence',
      'changed-detection',
      'reopened',
      'reopened-disposition-expired',
      'resolved-by-comparable-check',
      'removed-surface',
      'unassessed-in-current-scope',
      'incomparable-conditions',
    ],
    schemaEnum('report', 'ComparisonLabel'),
  ],
  [
    'protocol messages',
    PROTOCOL_MESSAGE_TYPES,
    [
      'hello',
      'welcome',
      'refuse',
      'start',
      'cancel',
      'progress',
      'checkpoint',
      'heartbeat',
      'diagnostic',
      'cancel-ack',
      'result',
    ],
    schemaEnum('protocol', 'ProtocolMessage', 'type'),
  ],
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
  assert.deepEqual(files, ENVELOPE_KINDS.map((k) => `${ENVELOPES[k].schema.replace('/', '.')}.schema.json`).sort());
  for (const kind of ENVELOPE_KINDS) {
    const file = JSON.parse(
      readFileSync(`${pkg}schemas/${ENVELOPES[kind].schema.replace('/', '.')}.schema.json`, 'utf8'),
    );
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
      if (Array.isArray(value)) value.forEach((v) => visit(def, v));
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
        assert.ok(
          'workRevision' in props && node.required?.includes('workRevision'),
          `${kind} ${def}: workId without a required workRevision`,
        );
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
  for (const analysis of [
    'coverage',
    'stageCoverage',
    'status',
    'outcome',
    'parsed',
    'observations',
    'findings',
    'seenByNoStage',
    'workId',
    'attemptId',
  ]) {
    assert.ok(!props.has(analysis), `snapshot carries ${analysis}`);
  }
  const snapshot = load('snapshot');
  snapshot.entries[0].coverage = 'complete';
  assert.equal(
    validateEnvelope('snapshot', snapshot).ok,
    false,
    'stage coverage cannot be written into a capture entry',
  );
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
  assert.ok(
    process.memoryUsage().heapUsed - before < 64 * 1024 * 1024,
    'validation allocates far less than the reported regression',
  );
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
  'a\n/../../outside',
  'a\r/../outside',
  'a\r\n/../outside',
  'a\u2028/../outside',
  'a\u2029/../outside',
  'src\n/',
  'a\n//b',
  'x\n/./y',
  '\n/../x',
  'a/b\n/..',
];

test('a line break in a name cannot hide a parent, dot or empty segment, in the schema alone or at runtime', () => {
  // The published schema on its own, as any other consumer would run it (no Sentinel invariants).
  const plain = new Ajv({ strict: true, allowUnionTypes: true }).addFormat('date-time', {
    type: 'string',
    validate: isCalendarTimestamp,
  });
  const schemaOnly = plain.compile(schemaOf('snapshot'));
  const withPath = (p: string) => {
    const v = load('snapshot');
    v.entries[0].relativePath = p;
    return v;
  };
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
  const ok = (t: string) => {
    const v = load('snapshot');
    v.createdAt = t;
    return validateEnvelope('snapshot', v).ok;
  };
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
    ...[...report.findings, ...report.gaps].flatMap((row: any, i: number) =>
      Object.entries(row.place.counts).map(([k, c]) => [`place ${i} ${k}`, c] as const),
    ),
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

test('timestamps compare at full nanosecond precision, never through millisecond Date.parse', () => {
  assert.equal(compareTimestamps('2026-10-21T12:05:00.250000001Z', '2026-10-21T12:05:00.250000002Z'), -1);
  assert.equal(compareTimestamps('2026-10-21T12:05:00.250000002Z', '2026-10-21T12:05:00.250000001Z'), 1);
  assert.equal(compareTimestamps('2026-10-21T12:05:00.25Z', '2026-10-21T12:05:00.250000000Z'), 0);
  assert.equal(compareTimestamps('2026-10-21T12:05:00Z', '2026-10-21T12:05:00.000000001Z'), -1);
  assert.equal(compareTimestamps('0001-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), -1);

  // Report decisions against the pinned clock, one nanosecond apart.
  const report = load('report');
  report.evaluatedAt = '2026-10-21T12:05:00.250000001Z';
  report.decisions[0].expiresAt = '2026-10-21T12:05:00.250000002Z';
  assert.ok(validateEnvelope('report', report).ok, 'expires one nanosecond after the report time: still valid');
  report.decisions[0].expiresAt = '2026-10-21T12:05:00.250000001Z';
  assert.equal(validateEnvelope('report', report).ok, false, 'expires exactly at the report time: expired');
  report.decisions[0].expiresAt = '2026-10-21T12:05:00.2500000Z';
  assert.equal(validateEnvelope('report', report).ok, false, 'one nanosecond before, written with fewer digits');

  // Run and attempt ordering one nanosecond apart; equal instants are allowed.
  const run = load('run-completed');
  run.createdAt = '2026-10-21T12:00:00.000000002Z';
  run.completedAt = '2026-10-21T12:00:00.000000001Z';
  assert.equal(validateEnvelope('run', run).ok, false, 'completed one nanosecond before creation');
  run.completedAt = '2026-10-21T12:00:00.000000002Z';
  assert.ok(validateEnvelope('run', run).ok, 'completed at the same instant');
  const attempt = load('attempt-ended');
  attempt.startedAt = '2026-10-21T12:00:00.123456789Z';
  attempt.endedAt = '2026-10-21T12:00:00.123456788Z';
  assert.equal(validateEnvelope('attempt', attempt).ok, false, 'ended one nanosecond before it started');
  attempt.startedAt = '2026-10-21T12:00:00.1Z';
  attempt.endedAt = '2026-10-21T12:00:00.100000000Z';
  assert.ok(validateEnvelope('attempt', attempt).ok, 'ended at the same instant, written with more digits');

  // A disposition must expire strictly after creation.
  const disp = load('disposition-proposed');
  disp.createdAt = '2026-10-21T12:00:00.000000001Z';
  disp.expiresAt = '2026-10-21T12:00:00.000000002Z';
  assert.ok(validateEnvelope('disposition', disp).ok);
  disp.expiresAt = '2026-10-21T12:00:00.000000001Z';
  assert.equal(validateEnvelope('disposition', disp).ok, false);
});

test('calendar years are real proleptic ISO years from 0000 to 9999', () => {
  assert.equal(
    isCalendarTimestamp('0000-02-29T00:00:00Z'),
    true,
    'year 0000 is a leap year (Date.UTC would read it as 1900)',
  );
  assert.equal(isCalendarTimestamp('0004-02-29T00:00:00Z'), true);
  assert.equal(isCalendarTimestamp('0100-02-29T00:00:00Z'), false, 'a century year not divisible by 400');
  assert.equal(isCalendarTimestamp('0099-02-29T00:00:00Z'), false);
  assert.equal(isCalendarTimestamp('2000-02-29T00:00:00Z'), true);
  assert.equal(isCalendarTimestamp('1900-02-29T00:00:00Z'), false);
  assert.equal(isCalendarTimestamp('9999-12-31T23:59:59.999999999Z'), true);
  const snap = load('snapshot');
  snap.createdAt = '0000-02-29T00:00:00Z';
  assert.ok(validateEnvelope('snapshot', snap).ok, 'schema and validator agree on the accepted years');
  snap.createdAt = '0100-02-29T00:00:00Z';
  assert.equal(validateEnvelope('snapshot', snap).ok, false);
});

test("a report decision is judged against the report's own clock; invalidation stays the service's word", () => {
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
  const f = {
    configurationFailure: false,
    awaitingConfirmation: false,
    requiredCoverageIncomplete: false,
    findingPolicyFailed: false,
  };
  assert.equal(policyResultOf(f), 'satisfied');
  assert.equal(policyResultOf({ ...f, findingPolicyFailed: true }), 'finding-policy-failed');
  assert.equal(
    policyResultOf({ ...f, findingPolicyFailed: true, requiredCoverageIncomplete: true }),
    'required-coverage-incomplete',
  );
  assert.equal(
    policyResultOf({ ...f, findingPolicyFailed: true, requiredCoverageIncomplete: true, configurationFailure: true }),
    'configuration-failure',
  );
  assert.equal(policyResultOf({ ...f, awaitingConfirmation: true }), 'awaiting-confirmation');
  assert.equal(
    policyResultOf({ ...f, awaitingConfirmation: true, configurationFailure: true }),
    'configuration-failure',
  );
  assert.throws(
    () => policyResultOf({ ...f, awaitingConfirmation: true, findingPolicyFailed: true }),
    /precedes admission/,
  );
  assert.deepEqual(POLICY_EXIT_CODES, {
    'satisfied': 0,
    'finding-policy-failed': 1,
    'required-coverage-incomplete': 2,
    'configuration-failure': 3,
    'awaiting-confirmation': 4,
  });
});

test('protocol negotiation selects the shared draft or refuses explicitly', () => {
  const hello = load('protocol-hello') as HelloMessage;
  assert.deepEqual(negotiateProtocol(hello), {
    protocol: 'sentinel-worker/draft-1',
    type: 'welcome',
    selected: 'sentinel-worker/draft-1',
  });
  const refused = negotiateProtocol({ ...hello, supported: ['sentinel-worker/draft-2', 'sentinel-worker/v1'] });
  assert.equal(refused.type, 'refuse');
  assert.ok(validateEnvelope('protocol', refused).ok);
  assert.ok(validateEnvelope('protocol', negotiateProtocol(hello)).ok);
});

// ---- the declared pipeline (README §3) ----
// A plan unit's stage widened from the closed built-in enums to a stage id. The built-in ids keep their own enums, so
// every retained plan still validates, and the schema accepts a declared stage id. (The plan's cross-field invariants
// still know only the built-in stages; declared planning is what teaches them more.)
test('a plan unit stage is a stage id with the built-in ids kept', () => {
  const ajv = new Ajv({ allErrors: false, strict: true, allowUnionTypes: true }).addFormat('date-time', {
    type: 'string',
    validate: isCalendarTimestamp,
  });
  const schemaOnly = ajv.compile(schemaOf('plan'));
  for (const file of ['plan-bootstrap', 'plan-analysis']) {
    const plan = load(file);
    assert.ok(schemaOnly(plan), `${file}: ${JSON.stringify(schemaOnly.errors)}`);
    for (const stage of new Set(plan.units.map((u: any) => u.stage)))
      assert.ok([...BUILTIN_PLAN_STAGES, ...REVIEW_PLAN_STAGES].includes(stage as never), `${file}: ${stage}`);
  }
  const unit = (stage: unknown) => {
    const plan = load('plan-analysis');
    plan.units[0].stage = stage;
    return schemaOnly(plan);
  };
  for (const stage of [...BUILTIN_PLAN_STAGES, ...REVIEW_PLAN_STAGES, 'secrets', 'triage', 'lint-notes', 'a1'])
    assert.equal(unit(stage), true, stage);
  for (const stage of ['', 'Capture', 'farsight.journeys', '-x', 'x-', 'a--b', 'a_b', 'x'.repeat(65), 3, null])
    assert.equal(unit(stage), false, String(stage));
  // A work envelope may record the new script kind; every old kind still validates.
  for (const kind of STAGE_KINDS) {
    const work = load('work-running');
    work.stage.kind = kind;
    assert.ok(validateEnvelope('work', work).ok, kind);
  }
  const work = load('work-running');
  work.stage.kind = 'builtin';
  assert.equal(validateEnvelope('work', work).ok, false, 'a pipeline kind is not a work stage kind');
});

test('settings carry the host-scripts setting as an optional boolean', () => {
  const settings = load('settings');
  assert.ok(validateEnvelope('settings', settings).ok);
  for (const value of [true, false]) assert.ok(validateEnvelope('settings', { ...settings, hostScripts: value }).ok);
  for (const value of ['true', 1, null])
    assert.equal(validateEnvelope('settings', { ...settings, hostScripts: value }).ok, false, String(value));
});

// The pipeline contracts are types until pipeline.json is adopted as its own envelope. Their schemas come from the same
// generator with the same options as scripts/generate-schemas.mjs, so what is pinned here is what will be published.
const pipelineSchemaOf = (() => {
  const generator = createGenerator({
    path: `${pkg}src/contracts/*.ts`,
    tsconfig: `${pkg}tsconfig.json`,
    type: '*',
    additionalProperties: false,
    expose: 'export',
    topRef: true,
    jsDoc: 'extended',
    skipTypeCheck: true,
  });
  const cache = new Map<string, any>();
  return (type: string) => {
    if (!cache.has(type)) cache.set(type, generator.createSchema(type));
    return cache.get(type);
  };
})();
const pipelineAjv = () =>
  new Ajv({ allErrors: false, strict: true, allowUnionTypes: true }).addFormat('date-time', {
    type: 'string',
    validate: isCalendarTimestamp,
  });
const pipelineEnum = (root: string, def: string, prop?: string) => {
  const defs = pipelineSchemaOf(root).definitions;
  let d = defs[def];
  if (prop) d = d.properties[prop];
  if (d.$ref) d = defs[d.$ref.split('/').pop()];
  return d.enum ? [...d.enum] : d.anyOf.flatMap((a: any) => (a.const !== undefined ? [a.const] : a.enum));
};
const PIPELINE_FIXTURES = here('./fixtures/pipeline/');
const pipelineFixture = (name: string) => JSON.parse(readFileSync(`${PIPELINE_FIXTURES}${name}.json`, 'utf8'));

test('the pipeline enums are pinned to an explicit list and to the generated schema', () => {
  const pins: Array<[string, readonly string[], string[], string[]]> = [
    [
      'pipeline stage kinds',
      PIPELINE_STAGE_KINDS,
      ['builtin', 'tool', 'script', 'agent'],
      pipelineEnum('PipelineDefinition', 'StageDefinition', 'kind'),
    ],
    [
      'built-in operations',
      BUILTIN_OPERATIONS,
      ['capture', 'parse', 'inventory', 'walkthrough', 'framework-controls', 'report'],
      pipelineEnum('PipelineDefinition', 'BuiltinOperation'),
    ],
    [
      'stage output types',
      STAGE_OUTPUT_TYPES,
      ['source', 'parse', 'inventory', 'findings', 'coverage', 'observations', 'walkthrough-md', 'report'],
      pipelineEnum('PipelineDefinition', 'StageOutputType'),
    ],
    [
      'fan-out',
      STAGE_FAN_OUTS,
      ['per-run', 'per-source', 'per-entry', 'per-check'],
      pipelineEnum('PipelineDefinition', 'StageFanOut'),
    ],
    [
      'agent runners',
      AGENT_RUNNERS,
      ['claude-cli', 'copilot-cli', 'hosted-api'],
      pipelineEnum('PipelineDefinition', 'AgentRunnerId'),
    ],
    ['agent modes', AGENT_MODES, ['brokered', 'native'], pipelineEnum('PipelineDefinition', 'AgentMode')],
    [
      'execution sites',
      EXECUTION_SITES,
      ['in-process', 'child', 'container', 'host', 'sandboxed-cli'],
      pipelineEnum('StageRun', 'ExecutionSite'),
    ],
    [
      'unobserved cost reasons',
      COST_UNOBSERVED_REASONS,
      ['subscription', 'usage-unknown', 'no-rates'],
      pipelineEnum('StageRun', 'CostUnobservedReason'),
    ],
    [
      'a model stage cost',
      ['rates', 'unobserved'],
      ['rates', 'unobserved'],
      pipelineSchemaOf('StageRun').definitions.StageCost.properties.basis.enum,
    ],
    ['stage run states', WORK_STATES, [...WORK_STATES], pipelineEnum('StageRun', 'StageRun', 'state')],
    [
      'feature flags',
      FEATURE_FLAG_NAMES,
      ['stage.host-scripts', 'runner.claude-cli', 'runner.copilot-cli', 'review.hosted-api'],
      Object.keys(pipelineSchemaOf('PipelineDefinition').definitions.PipelineFlags.properties),
    ],
  ];
  for (const [name, exported, literal, schema] of pins) {
    assert.deepEqual([...exported], literal, `${name}: exported constant`);
    assert.deepEqual([...schema].sort(), [...literal].sort(), `${name}: schema`);
  }
  // The four pipeline kinds map onto the work contract's stage kinds, one to one.
  assert.deepEqual(WORK_STAGE_KIND_OF, {
    builtin: 'coded',
    tool: 'external-tool',
    script: 'script',
    agent: 'agentic',
  });
  assert.deepEqual(Object.values(WORK_STAGE_KIND_OF).sort(), [...STAGE_KINDS].sort());
});

test('the example pipeline and stage runs validate, and each bound refuses one past it', () => {
  const ajv = pipelineAjv();
  const pipeline = ajv.compile(pipelineSchemaOf('PipelineDefinition'));
  const stageRun = ajv.compile(pipelineSchemaOf('StageRun'));
  const example = pipelineFixture('example');
  assert.ok(pipeline(example), JSON.stringify(pipeline.errors));
  assert.deepEqual([...new Set(example.stages.map((s: any) => s.kind))].sort(), [...PIPELINE_STAGE_KINDS].sort());
  const runs = pipelineFixture('stage-runs');
  for (const run of runs) assert.ok(stageRun(run), `${run.stage}: ${JSON.stringify(stageRun.errors)}`);
  assert.deepEqual(
    [...new Set(runs.flatMap((r: any) => r.provenance.map((p: any) => p.kind)))].sort(),
    [...PIPELINE_STAGE_KINDS].sort(),
    'the fixtures reach every provenance branch',
  );
  const refused = (mut: (v: any) => void, base = example, check = pipeline) => {
    const v = structuredClone(base);
    mut(v);
    return !check(v);
  };
  const stage = (id: string) => (v: any) => v.stages.find((s: any) => s.id === id);
  const cases: Array<[string, (v: any) => void]> = [
    ['the settings alias is not a pipeline flag', (v) => (v.flags = { hostScripts: true })],
    ['an unknown flag', (v) => (v.flags = { 'stage.anything': true })],
    ['money as a binary float', (v) => (stage('triage')(v).budget.usd = 0.5)],
    ['zero turns', (v) => (stage('review')(v).budget.turns = 0)],
    ['65 turns', (v) => (stage('review')(v).budget.turns = 65)],
    ['an unknown runner', (v) => (stage('review')(v).runner = 'ollama')],
    ['an unknown mode', (v) => (stage('review')(v).mode = 'free')],
    ['an unknown kind', (v) => (stage('report')(v).kind = 'plugin')],
    ['an unknown operation', (v) => (stage('report')(v).operation = 'paths')],
    ['a tool stage with no rules', (v) => (stage('secrets')(v).rules = [])],
    ['a rule pack that is not a selector', (v) => (stage('patterns')(v).rules = 'builtin:pattern')],
    ['a pack revision of zero', (v) => (stage('review')(v).prompt = 'stages/review@0#prompt.md')],
    ['a pack file that climbs', (v) => (stage('review')(v).prompt = 'stages/review@3#../prompt.md')],
    ['a skill outside a skill pack', (v) => (stage('review')(v).skills = ['prompt.md'])],
    ['17 skills', (v) => (stage('review')(v).skills = Array.from({ length: 17 }, (_, i) => `skills/s${i}@1`))],
    ['a context input that is not graph context', (v) => (stage('triage')(v).needs = ['other.journeys'])],
    ['an output reference without an output', (v) => (stage('triage')(v).needs = [{ stage: 'review' }])],
    ['a custom output without a schema', (v) => (stage('triage')(v).produces = [{ name: 'triage' }])],
    ['a custom schema id without a version', (v) => (stage('triage')(v).produces[0].schema = 'sentinel.triage')],
    ['a script runner that is not host or container', (v) => (stage('lint-notes')(v).runner = 'remote')],
    ['a stage field of another kind', (v) => (stage('secrets')(v).model = 'gpt-6-luna')],
    ['no stages', (v) => (v.stages = [])],
    [
      '65 stages',
      (v) => (v.stages = Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, kind: 'builtin', operation: 'parse' }))),
    ],
    ['the v2 example version string', (v) => (v.schema = 'sentinel-pipeline/1')],
  ];
  for (const [name, mut] of cases) assert.ok(refused(mut), name);
  assert.equal(
    refused(
      (v) => (v.stages = Array.from({ length: 64 }, (_, i) => ({ id: `s${i}`, kind: 'builtin', operation: 'parse' }))),
    ),
    false,
    '64 stages',
  );
  const run = runs.find((r: any) => r.kind === 'agent');
  const runCases: Array<[string, (v: any) => void]> = [
    ['a zero cost that is really unobserved', (v) => (v.provenance[0].cost = { basis: 'unobserved', amount: '0' })],
    [
      'an agent cost that is neither a price nor unobserved',
      (v) => (v.provenance[0].cost = { basis: 'not-applicable' }),
    ],
    ['an agent run with no cost at all', (v) => delete v.provenance[0].cost],
    ['an unknown unobserved reason', (v) => (v.provenance[0].cost = { basis: 'unobserved', reason: 'free' })],
    ['rates without a currency', (v) => (v.provenance[0].cost = { basis: 'rates', amount: '0.09' })],
    ['an environment value instead of a name', (v) => (v.provenance[0].environmentNames = ['PATH=/bin'])],
    ['an unknown execution site', (v) => (v.provenance[0].where = 'cloud')],
    ['an unknown input state', (v) => (v.io.inputs[0].state = 'stale')],
  ];
  for (const [name, mut] of runCases) assert.ok(refused(mut, run, stageRun), name);
  const rated = structuredClone(run);
  rated.provenance[0].cost = { basis: 'rates', amount: '0.09', currency: 'USD' };
  assert.ok(stageRun(rated), JSON.stringify(stageRun.errors));
});
