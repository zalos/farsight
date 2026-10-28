// The viewer's read model (Sentinel v2 lane L-UX U-1): the pure fold over plain records, the HTTP route table, and
// the owner-ui read operations over genuine retained scans (preview check; mock-model review stages). No Docker, no
// live model and no forged accepted records: every genuine record is the owner service's own publication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { STRINGS } from '@farsight/core/dist/strings.js';
import { countedProblems } from '@farsight/core/dist/counts.js';
import {
  costOf,
  outputView,
  replyOf,
  scanAnswer,
  scansAnswer,
  scanRow,
  scrubArgv,
  scrubHostText,
  sentOf,
  stageAnswer,
  stageName,
  unitAnswer,
  READ_MODEL_LIMITS,
  READ_MODEL_SCHEMAS,
  type AttemptRecord,
  type InvocationRecordView,
  type ScanRecord,
  type UnitRecord,
} from '../dist/transport/http/read-model.js';
import { corsHeaders, preflightHeaders, readRoute, routeOperation } from '../dist/transport/http/routes.js';
import { needsStore } from './snapshot-helpers.ts';
import { by, completedPreviewScan, completedReviewScan } from './helpers/read-model-fixture.ts';

/**
 * Every Counted anywhere in a value passes core's own countedProblems (catalog words with {n}, a scope in
 * COUNT_SCOPES, `{m}` when it carries `of`, a breakdown that sums), and every measure names a catalog scope.
 */
function assertCountsSound(value: unknown, path = '$'): number {
  let seen = 0;
  if (Array.isArray(value)) value.forEach((v, i) => (seen += assertCountsSound(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    const v = value as Record<string, any>;
    if ((typeof v.ms === 'number' || typeof v.value === 'number' || 'basis' in v) && typeof v.scope === 'string')
      assert.ok(Object.hasOwn(STRINGS, v.scope), `${path}: measure scope ${v.scope} is not in the catalog`);
    if (typeof v.n === 'number' && typeof v.unit === 'string' && typeof v.scope === 'string') {
      seen++;
      assert.deepEqual(countedProblems(v as any, path), [], path);
      assert.ok(Number.isSafeInteger(v.n) && v.n >= 0, `${path}.n`);
      for (const k of [v.unit, v.bizUnit, v.scope].filter(Boolean))
        assert.ok(Object.hasOwn(STRINGS, k), `${path}: ${k} is not in the catalog`);
      assert.equal(typeof v.source, 'string', `${path}.source`);
      if (v.of !== undefined) assert.ok(v.n <= v.of, `${path}: n exceeds of`);
      if (v.breakdown) {
        assert.equal(
          v.breakdown.reduce((n: number, p: any) => n + p.n, 0),
          v.n,
          `${path}: the breakdown does not sum`,
        );
        for (const p of v.breakdown) assert.ok(Object.hasOwn(STRINGS, p.key), `${path}: part ${p.key}`);
      }
    }
    for (const [k, child] of Object.entries(v)) seen += assertCountsSound(child, `${path}.${k}`);
  }
  return seen;
}

/**
 * No ledger id or artifact handle in an answer but the run ids that address scans: a stage is its contract, a check
 * or review its place in the stage.
 */
function assertNoLedgerIds(value: unknown, runIds: readonly string[] = []) {
  // Retained text (an output, an exchange, a prompt) is the record as kept, verbatim; the answer's own fields are not.
  let text = JSON.stringify(value, (k, v) => (k === 'text' && typeof v === 'string' ? '<retained>' : v));
  for (const id of runIds) text = text.split(id).join('<run>');
  for (const pattern of [
    /run-[0-9a-f]{8}/,
    /work-[a-z]+-[0-9a-f]{8}/,
    /att-[0-9a-f]{8}/,
    /snap-[0-9a-f]{8}/,
    /delivery\./,
  ])
    assert.doesNotMatch(text, pattern);
}

const attempt = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  ordinal: 1,
  state: 'succeeded',
  startedAt: '2026-10-27T10:00:00.000Z',
  endedAt: '2026-10-27T10:00:02.000Z',
  worker: 'in-process',
  usage: { certainty: 'not-applicable' },
  accepted: true,
  error: null,
  ...over,
});
const output = (schema: string, privacy: 'metadata' | 'source-derived' | 'source' = 'source-derived', bytes = 120) => ({
  schema,
  privacy,
  bytes,
});
const gitleaksInvocation: InvocationRecordView = {
  attempt: 1,
  adapter: { id: 'secrets-gitleaks', version: '8.30.1', digest: 'sha256:' + '1'.repeat(64) },
  isolation: 'container',
  operation: null,
  image: { reference: 'ghcr.io/example/gitleaks:8.30.1', id: 'sha256:' + '2'.repeat(64), architecture: 'arm64' },
  argv: ['/bin/sh', '/input/' + '4'.repeat(64)],
  environmentNames: ['HOME', 'SENTINEL_INPUT'],
  limits: { memoryBytes: 536870912, cpus: 1.5, pids: 64, timeoutMs: 120000 },
};
const unit = (key: string, stage: string, over: Partial<UnitRecord> = {}): UnitRecord => ({
  key,
  planRevision: 1,
  stage,
  contract: `sentinel.stage.${stage}`,
  adapterId: `sentinel-${stage}`,
  implementationDigest: 'sha256:' + '1'.repeat(64),
  dependencies: [],
  checks: 0,
  scopes: [],
  inputs: 0,
  inputPaths: [],
  review: null,
  work: { state: 'published', reason: null, kind: 'coded', deadlineMs: 120000, reusedFrom: null },
  attempts: [attempt()],
  outputs: [output('application/json')],
  reviewed: null,
  ...over,
});
function synthetic(over: Partial<ScanRecord> = {}): ScanRecord {
  const capture = unit('c#1', 'capture', {
    outputs: [output('sentinel-bootstrap-capture/draft-1')],
    invocation: { absent: 'sentinel.viewer.invocation.none' },
  });
  const parse = unit('p#1', 'parse', {
    dependencies: ['c#1'],
    outputs: [output('sentinel-parser-result/draft-1'), output('farsight-analysis', 'source', 4096)],
  });
  const inventory = unit('i#1', 'inventory', {
    dependencies: ['p#1'],
    outputs: [output('sentinel-bootstrap-inventory/draft-1')],
  });
  const check = (key: string, adapter: string, scope: string, invocation?: InvocationRecordView) =>
    unit(key, 'check', {
      ...(invocation ? { invocation } : {}),
      planRevision: 2,
      contract: `sentinel.stage.check.${adapter}`,
      adapterId: adapter,
      dependencies: ['i#1'],
      checks: 1,
      scopes: [`workspace:${scope}`],
      inputs: 1,
      work: { state: 'published', reason: null, kind: 'external-tool', deadlineMs: 120000, reusedFrom: null },
      attempts: [attempt({ worker: 'container' })],
      outputs: [output('sentinel-driver-finding/draft-1'), output('sentinel-coverage/draft-1')],
    });
  const review = unit('r#2', 'review-general', {
    planRevision: 2,
    contract: 'sentinel.stage.review.general',
    adapterId: 'sentinel.review.general',
    dependencies: ['i#1', 'g#2'],
    scopes: ['workspace'],
    inputs: 2,
    review: { providerId: 'local-review', modelId: 'review' },
    reviewed: { kind: 'files' },
    inputPaths: ['src/a.ts', 'src/b.ts'],
    work: { state: 'published', reason: null, kind: 'agentic', deadlineMs: 120000, reusedFrom: null },
    attempts: [
      attempt({
        usage: { certainty: 'confirmed', inputTokens: 80, outputTokens: 6, monetaryCost: '0.0048', currency: 'USD' },
      }),
    ],
    outputs: [output('sentinel-review-record/draft-1'), output('sentinel-observation/draft-1')],
  });
  return {
    id: 'run-synthetic-three',
    number: 3,
    parent: null,
    state: 'completed',
    outcome: 'complete-coverage',
    createdAt: '2026-10-27T10:00:00.000Z',
    completedAt: '2026-10-27T10:04:50.000Z',
    planRevision: 2,
    profileId: 'static-scanners',
    deadlineMs: 600000,
    sources: [{ commit: 'a'.repeat(40), dirty: false }],
    units: [
      capture,
      parse,
      inventory,
      check('g#2', 'secrets-gitleaks', 'src/a.ts', gitleaksInvocation),
      check('s#2', 'pattern-semgrep', 'src/b.ts'),
      review,
    ],
    adapters: {
      'secrets-gitleaks': { version: '8.30.1', kind: 'external', registry: 'current' },
      'pattern-semgrep': { version: null, kind: 'external', registry: 'changed' },
    },
    report: {
      findings: {
        n: 3,
        unit: 'sentinel.count.findings',
        bizUnit: 'sentinel.count.issues',
        scope: 'sentinel.scope.report',
        source: 'sentinel report fold draft-1',
      },
      seenByNoStage: {
        n: 1,
        of: 4,
        unit: 'sentinel.count.seenByNoStage',
        scope: 'sentinel.scope.inventory',
        source: 'sentinel report fold draft-1',
      },
      findingsByAdapter: { 'secrets-gitleaks': 1, 'pattern-semgrep': 2 },
    },
    result: {
      outcome: 'required-coverage-incomplete',
      reasonCode: 'sentinel.service.policyNotEvaluated',
      requiredChecks: 2,
      requiredComplete: 2,
    },
    review: {
      status: 'available',
      units: [
        {
          unitKey: 'r#2',
          model: { requested: 'review-model:1', reported: 'review-model:1', source: 'host-reported' },
          prompt: {
            name: 'sentinel.review.general',
            revision: 1,
            digest: 'sha256:' + '3'.repeat(64),
            bytes: 20,
            text: 'You are reviewing.',
          },
          skills: [],
          verdict: 'finding',
          outcome: 'completed',
          totals: { steps: 2, toolCalls: 1, inputTokens: 80, outputTokens: 6, usage: 'confirmed' },
          turns: [
            {
              outcome: 'tool',
              inputTokens: 40,
              outputTokens: 3,
              inputBytes: 100,
              sent: '{"task":"general review","files":["src/a.ts","src/b.ts"]}',
              reply: '{"action":"read","path":"src/a.ts","startLine":1,"endLine":2}',
            },
            {
              outcome: 'final',
              inputTokens: 40,
              outputTokens: 3,
              inputBytes: 200,
              sent: '{"tool":"read","ok":true,"data":{"path":"src/a.ts","startLine":1,"endLine":2},"evidence":[{"text":"SECRET-LOOKING TEXT"}]}',
              reply: null,
            },
          ],
          observations: [
            {
              message: 'withTx opens no transaction.',
              severity: 'unrated',
              citations: [{ path: 'src/a.ts', startByte: 0, endByte: 10 }],
            },
          ],
          inspected: ['src/a.ts'],
        },
      ],
    },
    withheld: false,
    ...over,
  };
}

test('the fold draws parallel stages on one level, counts that sum and provenance per kind', () => {
  const answer = scanAnswer('example-app', synthetic());
  assert.equal(answer.schema, READ_MODEL_SCHEMAS.scan);
  assert.deepEqual(answer.levels, [
    ['sentinel.stage.capture'],
    ['sentinel.stage.parse'],
    ['sentinel.stage.inventory'],
    ['sentinel.stage.check.secrets-gitleaks', 'sentinel.stage.check.pattern-semgrep'],
    ['sentinel.stage.review.general'],
  ]);
  assert.deepEqual(
    answer.stages.map((s) => [s.number, s.kind, s.name]),
    [
      [1, 'builtin', 'sentinel.viewer.stage.capture'],
      [2, 'builtin', 'sentinel.viewer.stage.parse'],
      [3, 'builtin', 'sentinel.viewer.stage.inventory'],
      [4, 'tool', 'sentinel.viewer.stage.secrets'],
      [5, 'tool', 'sentinel.viewer.stage.patterns'],
      [6, 'agent', 'sentinel.viewer.stage.reviewGeneral'],
    ],
  );
  const secrets = answer.stages[3]!,
    patterns = answer.stages[4]!,
    review = answer.stages[5]!;
  // What ran is the try's own invocation record, never today's registry.
  assert.deepEqual(secrets.provenance.invocation!.image, gitleaksInvocation.image);
  assert.deepEqual(secrets.provenance.invocation!.argv, gitleaksInvocation.argv, 'container paths are its own');
  assert.equal(secrets.provenance.implementation.version, '8.30.1');
  assert.equal(secrets.provenance.implementation.versionFrom, 'invocation');
  assert.equal(secrets.provenance.invocation!.limits.memory.n, 536870912);
  assert.equal(secrets.provenance.invocation!.limits.cpus.value, 1.5);
  assert.equal(secrets.provenance.where, 'container');
  assert.equal(patterns.provenance.implementation.registry, 'changed');
  assert.equal(patterns.provenance.implementation.version, null, 'a changed adapter never lends its version');
  assert.equal(patterns.provenance.invocation, null);
  assert.equal(patterns.provenance.invocationAbsent, 'sentinel.viewer.invocation.notRead');
  assert.equal(answer.stages[0]!.provenance.invocationAbsent, 'sentinel.viewer.invocation.none');
  assert.equal(secrets.counts.findings!.n + patterns.counts.findings!.n, answer.scan.counts.findings!.n);
  assert.equal(review.provenance.where, 'provider');
  assert.deepEqual(review.provenance.provider, { id: 'local-review', model: 'review' });
  assert.equal(review.provenance.prompt!.name, 'sentinel.review.general');
  assert.equal(review.counts.modelObservations!.n, 1);
  assert.equal(review.counts.turns!.n, 2);
  assert.equal(review.counts.tokensIn!.n, 80);
  assert.equal(review.counts.findings, null, 'a model never makes findings');
  assert.deepEqual(review.after.sort(), ['sentinel.stage.check.secrets-gitleaks', 'sentinel.stage.inventory']);
  assert.equal(answer.scan.counts.coverage!.n, 2);
  assert.equal(answer.scan.counts.coverage!.of, 2);
  assert.equal(answer.scan.counts.agentic.n, 1);
  assert.equal(answer.scan.policy.word, 'sentinel.viewer.policy.notEvaluated');
  assert.equal(answer.scan.duration!.ms, 290000);
  assert.deepEqual(answer.scan.cost, {
    basis: 'recorded',
    amount: '0.0048',
    currency: 'USD',
    scope: 'sentinel.viewer.scope.scan',
    source: 'sentinel viewer read model draft-1 · attempt usage',
  });
  // Report counts are the report's own objects, never refolded here; the disputed one is not shown as one fact.
  assert.equal(answer.scan.counts.seenByNoStage!.source, 'sentinel report fold draft-1');
  assert.equal(answer.scan.counts.unknownScopeBoundaries, null);
  assert.equal(answer.scan.absent.unknownScopeBoundaries, 'sentinel.viewer.absent.foldsDisagree');
  assert.equal(answer.scan.id, 'run-synthetic-three');
  assert.equal(answer.scan.source!.sources.n, 1);
  assert.ok(assertCountsSound(answer) > 20);
  assert.doesNotMatch(JSON.stringify(answer), /"c#1"|"g#2"|"r#2"/, 'internal unit keys never leave the fold');
});

test('the stage answer reads turns by the closed grammar and never the evidence the model was served', () => {
  const answer = stageAnswer('example-app', synthetic(), 'sentinel.stage.review.general')!;
  assert.equal(answer.prompt!.text, 'You are reviewing.');
  const [first, second] = answer.units[0]!.review!.turns;
  assert.equal(first!.sent!.key, 'sentinel.viewer.turn.task');
  assert.equal(first!.sent!.files!.n, 2);
  assert.equal(first!.counts.inputBytes!.n, 100);
  assert.equal(first!.text, undefined, 'a stage list carries no exchange text');
  assert.deepEqual(first!.reply, { key: 'sentinel.viewer.turn.read', path: 'src/a.ts', lines: [1, 2] });
  assert.deepEqual(second!.sent, {
    key: 'sentinel.viewer.turn.toolResult',
    tool: 'read',
    ok: true,
    path: 'src/a.ts',
    lines: [1, 2],
  });
  assert.equal(second!.reply!.key, 'sentinel.viewer.turn.final');
  assert.equal(second!.reply!.verdict, 'finding');
  assert.equal(second!.reply!.claims!.n, 1);
  assert.deepEqual(answer.units[0]!.reviewed!.kind, 'files');
  assert.doesNotMatch(JSON.stringify(answer), /SECRET-LOOKING/);
  assert.equal(answer.units[0]!.review!.observations[0]!.message, 'withTx opens no transaction.');
  assert.equal(stageAnswer('example-app', synthetic(), 'sentinel.stage.absent'), null);
  const check = stageAnswer('example-app', synthetic(), 'sentinel.stage.check.secrets-gitleaks')!;
  assert.equal(check.units[0]!.label, 'src/a.ts');
  assert.equal(check.units[0]!.counts.files.n, 1);
  assert.equal(check.units[0]!.review, null);
  assert.equal(check.units[0]!.reviewed, null);
  assertCountsSound(answer);
});

test('a secret match withholds every file name, prompt and model text, and keeps the numbers', () => {
  const scan = synthetic({ withheld: true, review: { status: 'withheld', units: [] } });
  const pipeline = scanAnswer('example-app', scan);
  const stage = stageAnswer('example-app', scan, 'sentinel.stage.check.pattern-semgrep')!;
  const review = stageAnswer('example-app', scan, 'sentinel.stage.review.general')!;
  assert.equal(pipeline.review, 'withheld');
  assert.equal(pipeline.scan.counts.modelObservations, null);
  assert.equal(pipeline.scan.absent.modelObservations, 'sentinel.viewer.absent.withheld');
  assert.equal(stage.units[0]!.label, null);
  assert.equal(stage.units[0]!.counts.files.n, 1);
  assert.equal(review.prompt, null);
  assert.equal(review.units[0]!.review, null);
  for (const text of ['src/a.ts', 'src/b.ts', 'withTx', 'You are reviewing'])
    assert.equal(JSON.stringify([pipeline, stage, review]).includes(text), false, text);
  assert.equal(
    sentOf('{"tool":"read","ok":true,"data":{"path":"src/a.ts","startLine":1,"endLine":2}}', true)!.path,
    undefined,
  );
  assert.equal(replyOf('{"action":"read","path":"src/a.ts","startLine":1,"endLine":2}', true)!.path, undefined);
});

test('states, costs and absences are said, never shown as zero', () => {
  const running = synthetic({
    state: 'running',
    outcome: null,
    completedAt: null,
    result: null,
    report: { absent: 'sentinel.viewer.absent.notFinished' },
  });
  const units = running.units.map((u, i) =>
    i === 4
      ? { ...u, work: { ...u.work!, state: 'running' }, attempts: [attempt({ endedAt: null, accepted: false })] }
      : i === 5
        ? { ...u, work: null, attempts: [], outputs: null }
        : u,
  );
  const answer = scanAnswer('example-app', { ...running, units });
  assert.equal(answer.stages[4]!.status, 'running');
  assert.equal(answer.stages[4]!.duration, null);
  assert.equal(answer.stages[5]!.status, 'waiting');
  assert.equal(answer.scan.policy.word, 'sentinel.viewer.policy.inProgress');
  assert.equal(answer.scan.counts.findings, null);
  assert.equal(answer.scan.absent.findings, 'sentinel.viewer.absent.notFinished');
  assert.equal(answer.scan.counts.coverage, null);
  assert.deepEqual(
    answer.scan.counts.stages.breakdown!.map((p) => [p.key, p.n]),
    [
      ['sentinel.viewer.count.part.done', 4],
      ['sentinel.viewer.count.part.running', 1],
      ['sentinel.viewer.count.part.waiting', 1],
    ],
  );
  const canceled = scanAnswer('example-app', { ...running, units, state: 'canceled' });
  assert.equal(canceled.stages[5]!.status, 'not-run');
  assert.equal(canceled.scan.policy.word, 'sentinel.viewer.policy.stopped');
  const none = costOf([attempt()], 's', 'x');
  assert.equal(none.basis, 'none');
  assert.equal(costOf([attempt({ usage: { certainty: 'unknown', inputTokens: 5 } })], 's', 'x').basis, 'unobserved');
  assert.equal(
    costOf([attempt({ usage: { certainty: 'confirmed', inputTokens: 5, outputTokens: 1 } })], 's', 'x').basis,
    'unobserved',
    'a subscription CLI with no price is unobserved, never $0',
  );
  const mixed = costOf(
    [
      attempt({ usage: { certainty: 'confirmed', monetaryCost: '0.1', currency: 'USD' } }),
      attempt({ usage: { certainty: 'confirmed', monetaryCost: '0.1', currency: 'EUR' } }),
    ],
    's',
    'x',
  );
  assert.equal(mixed.basis, 'mixed');
  assert.equal(mixed.amount, null);
  const added = costOf(
    [
      attempt({ usage: { certainty: 'confirmed', monetaryCost: '0.0048', currency: 'USD' } }),
      attempt({ usage: { certainty: 'confirmed', monetaryCost: '0.0852', currency: 'USD' } }),
    ],
    's',
    'x',
  );
  assert.equal(added.amount, '0.09', 'decimal amounts are added exactly');
  assert.equal(stageName('check', 'unknown-adapter'), 'sentinel.viewer.stage.otherCheck');
  assert.equal(stageName('something', null), 'sentinel.viewer.stage.other');
  assert.equal(replyOf('not json', false)!.key, 'sentinel.viewer.turn.unreadable');
  const failing = synthetic();
  const trace = failing.review.units[0]!;
  const failed = stageAnswer(
    'example-app',
    {
      ...failing,
      review: {
        status: 'available',
        units: [{ ...trace, turns: [{ ...trace.turns[0]!, outcome: 'failed', reply: null }] }],
      },
    },
    'sentinel.stage.review.general',
  )!;
  assert.deepEqual(failed.units[0]!.review!.turns[0]!.reply, { key: 'sentinel.viewer.turn.failed' });
  const list = scansAnswer('example-app', [scanRow(synthetic())], { total: 3, before: null });
  assert.equal(list.counts.scans.n, 3);
  assert.equal(list.counts.shown.n, 1);
  assert.equal(list.counts.shown.of, 3);
  assert.deepEqual(list.page, { before: null, older: 3 }, 'the next older page is below the oldest number listed');
  assert.equal(list.more, true);
  const first = scansAnswer('example-app', [scanRow(synthetic({ number: 1 }))], { total: 3, before: 2 });
  assert.deepEqual(first.page, { before: 2, older: null });
  assert.equal(first.more, false);
  assert.equal(list.readOnly, true);
  assertCountsSound(list);
});

test('an opened check or review carries what ran, its retained outputs and the exchange words, bounded', () => {
  const scan = synthetic();
  const big = 'x'.repeat(READ_MODEL_LIMITS.outputChars + 10);
  const detail = {
    invocation: gitleaksInvocation,
    outputs: [
      { ...output('sentinel-driver-finding/draft-1'), text: '{"rule":"aws-key","line":3}', reason: null },
      { ...output('application/json'), text: big, reason: null },
      { ...output('farsight-analysis', 'source'), text: 'export const source = 1;', reason: null },
      { ...output('application/octet-stream'), text: null, reason: 'sentinel.viewer.raw.binary' },
    ],
  };
  const opened = unitAnswer('example-app', scan, 'sentinel.stage.check.secrets-gitleaks', 1, detail)!;
  assert.equal(opened.schema, READ_MODEL_SCHEMAS.unit);
  assert.equal(opened.invocation!.image!.architecture, 'arm64');
  assert.equal(opened.outputs[0]!.text, '{"rule":"aws-key","line":3}');
  assert.equal(opened.outputs[0]!.key, 'sentinel.viewer.io.findings');
  assert.equal(opened.outputs[0]!.size!.n, 120);
  assert.equal(opened.outputs[1]!.text!.length, READ_MODEL_LIMITS.outputChars);
  assert.equal(opened.outputs[1]!.truncated, true);
  assert.equal(opened.outputs[2]!.text, null, 'the source itself is never streamed here');
  assert.equal(opened.outputs[2]!.withheld, 'sentinel.viewer.raw.source');
  assert.equal(opened.outputs[3]!.withheld, 'sentinel.viewer.raw.binary');
  assert.equal(unitAnswer('example-app', scan, 'sentinel.stage.check.secrets-gitleaks', 2, detail), null);
  assertCountsSound(opened);
  // A review opened: each exchange's retained words, bounded, beside the closed-grammar reading.
  const review = unitAnswer('example-app', scan, 'sentinel.stage.review.general', 1, {
    invocation: null,
    outputs: [],
  })!;
  const [first, second] = review.unit.review!.turns;
  assert.equal(first!.text!.sent!.text, '{"task":"general review","files":["src/a.ts","src/b.ts"]}');
  assert.equal(first!.text!.reply!.text, '{"action":"read","path":"src/a.ts","startLine":1,"endLine":2}');
  assert.match(second!.text!.sent!.text, /SECRET-LOOKING TEXT/, 'the owner reads the served evidence when opened');
  assert.equal(second!.text!.reply, null, 'the final reply is the verdict and observations');
  assert.equal(review.invocationAbsent, 'sentinel.viewer.where.notYet');
  const long = synthetic();
  const trace = long.review.units[0]!;
  const longer = unitAnswer(
    'example-app',
    {
      ...long,
      review: { status: 'available', units: [{ ...trace, turns: [{ ...trace.turns[0]!, sent: 'y'.repeat(5000) }] }] },
    },
    'sentinel.stage.review.general',
    1,
    { invocation: null, outputs: [] },
  )!;
  assert.equal(longer.unit.review!.turns[0]!.text!.sent!.text.length, READ_MODEL_LIMITS.turnChars);
  assert.equal(longer.unit.review!.turns[0]!.text!.sent!.truncated, true);
  // A secret match withholds every output's text and every message, and keeps the numbers.
  const withheld = synthetic({ withheld: true, review: { status: 'withheld', units: [] } });
  const hidden = unitAnswer('example-app', withheld, 'sentinel.stage.check.secrets-gitleaks', 1, detail)!;
  assert.ok(hidden.outputs.every((o) => o.text === null && o.withheld === 'sentinel.viewer.absent.withheld'));
  assert.equal(hidden.outputs[0]!.size!.n, 120);
  assert.equal(JSON.stringify(hidden).includes('aws-key'), false);
  assert.equal(outputView(withheld, detail.outputs[0]!).text, null);
});

test("retained text leaves with none of this computer's folders in it", () => {
  const roots = ['/srv/build/ws', '/srv/build/ws/.farsight/sentinel/store', '/opt/node/v24/bin/node', '/opt/node/v24'];
  const text = [
    'workspace /srv/build/ws/src/a.ts',
    'store "/srv/build/ws/.farsight/sentinel/store/objects/ab"',
    'node /opt/node/v24/bin/node --import file:///opt/node/v24/lib/gate.js',
    'home /Users/example/workspace/.farsight/sentinel/store',
    'linux /home/someone/x.ts · tmp /private/var/folders/x/T/y · windows C:\\Users\\me\\ws',
    'escaped "C:\\\\Users\\\\me\\\\ws"',
    'kept: src/a.ts, /input/abc, workspace:src/b.ts',
  ].join('\n');
  const out = scrubHostText(text, roots);
  for (const leak of ['/srv/build', '/opt/node', '/Users/', '/home/', '/private/', 'C:\\'])
    assert.equal(out.includes(leak), false, leak);
  assert.match(out, /workspace <host path>\n/);
  assert.match(out, /store "<host path>"/);
  assert.match(out, /kept: src\/a\.ts, \/input\/abc, workspace:src\/b\.ts/, 'relative and container paths stay');
  // The fold applies the folder rule to whatever it is handed: an accepted output, an exchange, an observation.
  const scan = synthetic();
  const opened = unitAnswer('example-app', scan, 'sentinel.stage.check.secrets-gitleaks', 1, {
    invocation: null,
    outputs: [
      {
        ...output('application/json'),
        text: '{"at":"/Users/example/workspace/.farsight/sentinel/store"}',
        reason: null,
      },
    ],
  })!;
  assert.equal(opened.outputs[0]!.text, '{"at":"<host path>"}');
  const trace = scan.review.units[0]!;
  const review = unitAnswer(
    'example-app',
    {
      ...scan,
      review: {
        status: 'available',
        units: [
          {
            ...trace,
            observations: [{ ...trace.observations[0]!, message: 'see /home/me/ws/src/a.ts' }],
            turns: [{ ...trace.turns[0]!, sent: '{"task":"x","files":[],"root":"/Users/me/ws"}' }],
          },
        ],
      },
    },
    'sentinel.stage.review.general',
    1,
    { invocation: null, outputs: [] },
  )!;
  assert.equal(review.unit.review!.turns[0]!.text!.sent!.text, '{"task":"x","files":[],"root":"<host path>"}');
  assert.equal(review.unit.review!.observations[0]!.message, 'see <host path>');
});

test('argv leaves with no host path and no token in it', () => {
  const child = scrubArgv(
    [
      '/opt/node/bin/node',
      '--import',
      'file:///Users/someone/lib/launch-gate.js',
      '/Users/someone/store/scratch/w-1/input',
      '--sentinel-token=fixture',
      '--api-key=fixture',
      'plain',
      42,
    ],
    'child',
  );
  assert.deepEqual(child, [
    '<host path>',
    '--import',
    '<host path>',
    '<host path>',
    '--sentinel-token=<redacted>',
    '--api-key=<redacted>',
    'plain',
    '<other>',
  ]);
  assert.deepEqual(scrubArgv(['/bin/sh', '/input/abc', '--config=/home/me/x'], 'container'), [
    '/bin/sh',
    '/input/abc',
    '<host path>',
  ]);
  assert.equal(scrubArgv(Array(64).fill('a'), 'container').length, READ_MODEL_LIMITS.argvItems);
});

test('the route table answers GET reads only, from the paired origin only', () => {
  const run = 'run-' + 'a'.repeat(32);
  assert.deepEqual(readRoute('/api/sentinel/scans'), { kind: 'scans', before: null });
  assert.deepEqual(readRoute('/api/sentinel/scans/before/12'), { kind: 'scans', before: 12 });
  assert.deepEqual(readRoute(`/api/sentinel/scans/${run}`), { kind: 'scan', runId: run });
  assert.deepEqual(readRoute(`/api/sentinel/scans/${run}/stages/sentinel.stage.check.secrets-gitleaks`), {
    kind: 'stage',
    runId: run,
    stage: 'sentinel.stage.check.secrets-gitleaks',
  });
  assert.deepEqual(readRoute(`/api/sentinel/scans/${run}/stages/sentinel.stage.check.secrets-gitleaks/units/3`), {
    kind: 'unit',
    runId: run,
    stage: 'sentinel.stage.check.secrets-gitleaks',
    unit: 3,
  });
  assert.deepEqual(readRoute(`/api/sentinel/scans/${run}/report`), { kind: 'report', runId: run, format: 'md' });
  assert.deepEqual(readRoute(`/api/sentinel/scans/${run}/report/html`), { kind: 'report', runId: run, format: 'html' });
  assert.deepEqual(readRoute('/api/sentinel/pipeline'), { kind: 'pipeline' });
  assert.deepEqual(routeOperation({ kind: 'pipeline' }), { op: 'owner-ui.pipeline', body: {} });
  for (const bad of [
    '/api/sentinel/scans/before',
    '/api/sentinel/scans/before/0',
    '/api/sentinel/scans/before/x',
    '/api/sentinel/scans/-1',
    '/api/sentinel/scans/.hidden',
    `/api/sentinel/scans/${run}?x=1`,
    `/api/sentinel/scans/${run}/stages/..%2F..`,
    `/api/sentinel/scans/${run}/stages/%E0%A4%A`,
    `/api/sentinel/scans/${run}/stages/x/units/0`,
    `/api/sentinel/scans/${run}/stages/x/units/a`,
    `/api/sentinel/scans/${run}/stages/x/other/1`,
    `/api/sentinel/scans/${run}/report/exe`,
    '/api/sentinel/runs',
    '/api/sentinel/pipeline/x',
    '/api/sentinel/pipeline?x=1',
    '/api/other',
  ])
    assert.equal(readRoute(bad), null, bad);
  assert.deepEqual(routeOperation({ kind: 'stage', runId: run, stage: 'x' }), {
    op: 'owner-ui.stage',
    body: { runId: run, stage: 'x' },
  });
  assert.deepEqual(routeOperation({ kind: 'unit', runId: run, stage: 'x', unit: 2 }), {
    op: 'owner-ui.unit',
    body: { runId: run, stage: 'x', unit: 2 },
  });
  assert.deepEqual(routeOperation({ kind: 'scans', before: null }), { op: 'owner-ui.scans', body: {} });
  assert.deepEqual(routeOperation({ kind: 'scans', before: 5 }), { op: 'owner-ui.scans', body: { before: 5 } });
  const origin = 'http://127.0.0.1:4500';
  assert.equal(corsHeaders(origin, origin)['access-control-allow-origin'], origin);
  assert.equal(corsHeaders('http://evil.example', origin)['access-control-allow-origin'], undefined);
  assert.equal(corsHeaders(undefined, origin)['access-control-allow-origin'], undefined);
  assert.equal(preflightHeaders('http://evil.example', origin), null);
  assert.equal(preflightHeaders(origin, origin)!['access-control-allow-methods'], 'GET');
  assert.equal(preflightHeaders(origin, origin)!['access-control-allow-headers'], 'authorization');
});

test(
  'a genuine completed scan reads as its stages, after the source is gone, without one ledger write',
  { ...needsStore, timeout: 90000 },
  async (t) => {
    const f = await completedPreviewScan(t);
    rmSync(join(f.ws.path, 'src'), { recursive: true });
    const sequence = f.store.ledger.currentSequence();
    const list = await f.call('owner-ui.scans');
    assert.equal(list.schema, READ_MODEL_SCHEMAS.scans);
    assert.equal(list.scans.length, 1);
    assert.equal(list.scans[0].number, 1);
    assert.equal(list.scans[0].id, f.runId);
    assert.equal(list.counts.scans.n, 1);
    assert.deepEqual(list.page, { before: null, older: null });
    assert.equal((await f.call('owner-ui.scans', { before: 1 })).scans.length, 0);
    assert.equal(list.scans[0].state, 'completed');
    assert.equal(list.scans[0].policy.reasonCode, 'sentinel.service.previewNotCoverage');
    assert.equal(list.scans[0].cost.basis, 'none');
    assert.deepEqual(
      list.scanAction,
      { available: true, reasonCode: null },
      'a deterministic scan starts from a browser',
    );
    const scan = await f.call('owner-ui.scan', { runId: f.runId });
    assert.deepEqual(
      scan.stages.map((s: any) => [s.name, s.kind, s.status, s.provenance.where]),
      [
        ['sentinel.viewer.stage.capture', 'builtin', 'done', 'in-process'],
        ['sentinel.viewer.stage.parse', 'builtin', 'done', 'in-process'],
        ['sentinel.viewer.stage.inventory', 'builtin', 'done', 'in-process'],
        ['sentinel.viewer.stage.preview', 'builtin', 'done', 'child'],
      ],
    );
    assert.ok(scan.stages.every((s: any) => s.provenance.implementation.registry === 'current'));
    assert.ok(scan.stages.every((s: any) => /^sha256:[0-9a-f]{64}$/.test(s.provenance.implementation.digest)));
    // What the preview check ran comes from its try's own authenticated invocation record.
    const ran = scan.stages[3].provenance;
    assert.equal(ran.invocation.isolation, 'child');
    assert.equal(ran.implementation.versionFrom, 'invocation');
    assert.equal(ran.invocation.adapter.digest, ran.implementation.digest);
    assert.ok(ran.invocation.argv.includes('<host path>'), 'the host Node and folders are scrubbed');
    assert.ok(ran.invocation.argv.some((a: string) => a.startsWith('--sentinel-token=<redacted>')));
    assert.equal(scan.stages[0].provenance.invocation.isolation, 'in-process');
    assert.equal(scan.stages[0].provenance.invocation.operation, 'capture', "Sentinel's own operation, as recorded");
    assert.equal(scan.stages[0].provenance.invocation.limits, null);
    assert.equal(scan.stages[3].reads.at(-1).count.n, 1, 'the check read one captured file');
    // The report's numbers are the report's: the same counts report.open prints for this scan.
    const delivered: any = await f.service.handle('report.open', { runId: f.runId, format: 'json' }, by);
    let json = '';
    for (let offset = 0; offset < delivered.formatBytes;) {
      const chunk: any = await f.service.handle('delivery.read', { deliveryId: delivered.deliveryId, offset }, by);
      const bytes = Buffer.from(chunk.base64, 'base64');
      json += bytes.toString('utf8');
      offset += bytes.length;
    }
    const doc = JSON.parse(json);
    assert.deepEqual(scan.scan.counts.findings, doc.counts.findings);
    assert.deepEqual(scan.scan.counts.seenByNoStage, doc.counts.seenByNoStage);
    assert.equal(scan.scan.counts.unknownScopeBoundaries, null, 'the folds disagree: neither number is shown');
    assert.equal(scan.scan.absent.unknownScopeBoundaries, 'sentinel.viewer.absent.foldsDisagree');
    const stage = await f.call('owner-ui.stage', { runId: f.runId, stage: scan.stages[3].id });
    assert.equal(stage.units.length, 1);
    assert.equal(stage.units[0].label, 'src/one.ts');
    assert.equal(stage.units[0].attempts[0].accepted, true);
    // One check opened: its retained outputs, as text when they are text and not the source itself.
    const opened = await f.call('owner-ui.unit', { runId: f.runId, stage: scan.stages[3].id, unit: 1 });
    assert.equal(opened.schema, READ_MODEL_SCHEMAS.unit);
    assert.equal(opened.invocation.isolation, 'child');
    assert.ok(opened.outputs.length > 0);
    const findings = opened.outputs.find((o: any) => o.text?.includes('sentinel-preview-findings/draft-1'));
    assert.ok(findings, "the preview check's own findings document, as it was kept");
    assert.equal(findings.size.n, Buffer.byteLength(findings.text));
    assert.equal(findings.truncated, false);
    const parse = await f.call('owner-ui.unit', { runId: f.runId, stage: scan.stages[1].id, unit: 1 });
    assert.equal(parse.invocation.operation, 'parse');
    // The parsed source itself is linked from the parser's result, never one of its outputs, and never streamed.
    assert.deepEqual(
      parse.outputs.map((o: any) => [o.schema, o.privacy]),
      [['sentinel-parser-result/draft-1', 'source-derived']],
    );
    assert.ok(parse.outputs.every((o: any) => o.privacy !== 'source' || o.text === null));
    for (const answer of [opened, parse])
      for (const host of [f.ws.path, f.store.storePath, process.execPath])
        assert.equal(JSON.stringify(answer).includes(host), false, 'no host path leaves: ' + host);
    await assert.rejects(
      f.call('owner-ui.unit', { runId: f.runId, stage: scan.stages[3].id, unit: 2 }),
      (e: any) => e.code === 'sentinel.viewer.unitUnknown',
    );
    const report = await f.call('owner-ui.scan-report', { runId: f.runId, format: 'md' });
    assert.match(report.formatDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(report).sort(), ['deliveryId', 'format', 'formatBytes', 'formatDigest', 'number']);
    assert.equal(report.number, 1);
    await assert.rejects(
      f.call('owner-ui.scan', { runId: 'run-' + '0'.repeat(32) }),
      (e: any) => e.code === 'sentinel.viewer.scanUnknown',
    );
    await assert.rejects(f.call('owner-ui.scan', { number: 1 }), 'a display number is not an address');
    await assert.rejects(f.call('owner-ui.scan', { runId: '../x' }));
    await assert.rejects(
      f.call('owner-ui.stage', { runId: f.runId, stage: 'sentinel.stage.absent' }),
      (e: any) => e.code === 'sentinel.viewer.stageUnknown',
    );
    await assert.rejects(f.call('owner-ui.scans', { extra: 1 }));
    // A read is not authority: an unpaired proof reads nothing.
    await assert.rejects(f.service.handle('owner-ui.scans', { proof: 'e'.repeat(64), revision: 1 }, by));
    assert.equal(f.store.ledger.currentSequence(), sequence, 'reading wrote nothing');
    for (const answer of [list, scan, stage, opened, parse]) {
      assertNoLedgerIds(answer, [f.runId]);
      assert.ok(assertCountsSound(answer) > 0);
    }
  },
);

test(
  'a genuine review stage shows its runner, model, prompt, turns, tokens, cost and cited observation',
  { ...needsStore, timeout: 180000 },
  async (t) => {
    const f = await completedReviewScan(t);
    assert.deepEqual(
      (await f.call('owner-ui.scans')).scanAction,
      { available: false, reasonCode: 'sentinel.review.foregroundRequired' },
      'a configured model stage is refused from a browser, said before a press',
    );
    const scan = await f.call('owner-ui.scan', { runId: f.runId });
    const agents = scan.stages.filter((s: any) => s.kind === 'agent');
    assert.equal(agents.length, 2);
    assert.equal(scan.scan.counts.agentic.n, 2);
    assert.equal(scan.scan.counts.modelObservations.n, 2);
    assert.deepEqual(
      scan.levels.at(-1).slice().sort(),
      agents.map((s: any) => s.id).sort(),
      'the two review stages ran side by side',
    );
    for (const stage of agents) {
      assert.deepEqual(stage.provenance.provider, { id: 'local-review', model: 'review' });
      assert.equal(stage.provenance.model.requested, 'review-model:1');
      assert.equal(stage.provenance.where, 'provider');
      assert.match(stage.provenance.prompt.digest, /^sha256:/);
      assert.equal(stage.counts.tokensIn.n, 80);
      assert.equal(stage.counts.tokensOut.n, 6);
      assert.equal(stage.counts.turns.n, 2);
      assert.equal(stage.cost.basis, 'recorded');
      // the runner is what the review ran through, read from the admitted review; the provider entry stays apart
      assert.deepEqual(stage.provenance.runner, { id: 'hosted-api', mode: 'brokered', local: true });
      // the turn limit is the admitted spec's own (the session's maxSteps), read by the id the plan pins
      assert.equal(stage.counts.turns.unit, 'sentinel.viewer.count.turnsOf');
      assert.equal(stage.counts.turns.of, 12);
      assert.deepEqual(stage.review.outcome, 'completed');
      assert.equal(stage.counts.inspected.n, 1, 'the model asked for one file');
      assert.equal(stage.counts.inspected.of, stage.counts.inputs.n, 'of the files the review was given');
    }
    const general = agents.find((s: any) => s.name === 'sentinel.viewer.stage.reviewGeneral');
    const stage = await f.call('owner-ui.stage', { runId: f.runId, stage: general.id });
    assert.match(stage.prompt.text, /You are reviewing/);
    const review = stage.units[0].review;
    assert.equal(review.verdict, 'finding');
    assert.deepEqual(
      review.turns.map((x: any) => [x.sent?.key, x.reply?.key]),
      [
        ['sentinel.viewer.turn.task', 'sentinel.viewer.turn.read'],
        ['sentinel.viewer.turn.toolResult', 'sentinel.viewer.turn.final'],
      ],
    );
    assert.equal(review.turns[0].reply.path, 'src/original.ts');
    assert.equal(review.observations[0].message, 'Original fixture review candidate.');
    assert.equal(review.observations[0].citations[0].path, 'src/original.ts');
    assert.doesNotMatch(JSON.stringify(stage), /export const original/, 'a stage list never copies served text');
    assert.equal(stage.units[0].reviewed.kind, 'files');
    // One review opened: every exchange's retained words, bounded, for the paired owner only.
    const opened = await f.call('owner-ui.unit', { runId: f.runId, stage: general.id, unit: 1 });
    const words = opened.unit.review.turns;
    assert.match(words[0].text.sent.text, /"task"/);
    assert.match(words[0].text.reply.text, /"action":"read"/, "the model's own intermediate reply");
    assert.match(words[1].text.sent.text, /export const original/, 'what Sentinel served, as retained');
    assert.equal(opened.disclosure, 'owner-private');
    const guided = agents.find((s: any) => s.name === 'sentinel.viewer.stage.reviewGuided');
    const rule = (await f.call('owner-ui.stage', { runId: f.runId, stage: guided.id })).units[0].reviewed;
    assert.equal(rule.kind, 'rule', 'a guided review names the rule it reviewed');
    assert.match(rule.rule, /^sentinel\./);
    for (const answer of [scan, stage, opened]) {
      assertNoLedgerIds(answer, [f.runId]);
      assertCountsSound(answer);
    }
  },
);

test('a review names its runner apart from its provider, the files the model read of those given, and an unfinished end', () => {
  const base = synthetic();
  const trace = base.review.units[0]!;
  const ran = synthetic({
    review: {
      status: 'available',
      units: [
        {
          ...trace,
          runner: 'copilot-cli',
          mode: 'brokered',
          disclosure: 'hosted',
          turnLimit: 3,
          verdict: null,
          outcome: 'unfinished',
        },
      ],
    },
  });
  const answer = scanAnswer('example-app', ran);
  const review = answer.stages.find((s) => s.kind === 'agent')!;
  assert.deepEqual(review.provenance.runner, { id: 'copilot-cli', mode: 'brokered', local: false });
  assert.deepEqual(review.provenance.provider, { id: 'local-review', model: 'review' }, 'the provider entry, apart');
  // given and read are two counts with their own words: two files given, one asked for
  assert.equal(review.counts.inputs.n, 2);
  assert.equal(review.counts.inputs.unit, 'sentinel.viewer.count.inputs');
  assert.deepEqual(
    [review.counts.inspected!.n, review.counts.inspected!.of, review.counts.inspected!.unit],
    [1, 2, 'sentinel.viewer.count.inspected'],
  );
  // the work is done; the review's own record says unfinished, after 2 of the 3 turns it was allowed
  assert.equal(review.status, 'done');
  assert.equal(review.review!.outcome, 'unfinished');
  assert.deepEqual([review.review!.unfinished.n, review.review!.unfinished.of], [1, 1]);
  assert.deepEqual(
    [review.counts.turns!.n, review.counts.turns!.of, review.counts.turns!.unit, review.counts.turns!.bizUnit],
    [2, 3, 'sentinel.viewer.count.turnsOf', 'sentinel.viewer.count.exchangesOf'],
  );
  const stage = stageAnswer('example-app', ran, review.id)!;
  const row = stage.units[0]!;
  assert.equal(row.review!.outcome, 'unfinished');
  assert.deepEqual(row.review!.runner, { id: 'copilot-cli', mode: 'brokered', local: false });
  assert.deepEqual([row.counts.turns!.n, row.counts.turns!.of], [2, 3]);
  assert.deepEqual([row.counts.inspected!.n, row.counts.inspected!.of], [1, 2]);
  assert.ok(assertCountsSound(answer) > 20);
  assertCountsSound(stage);
  // an older record names no runner and no limit: the runner is unknown and the turns are counted alone
  const older = scanAnswer('example-app', base).stages.find((s) => s.kind === 'agent')!;
  assert.equal(older.provenance.runner, null);
  assert.equal(older.counts.turns!.unit, 'sentinel.viewer.count.turns');
  assert.equal(older.counts.turns!.of, undefined);
  assert.equal(older.review!.outcome, 'completed');
});
