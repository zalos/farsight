// The viewer's read model (Sentinel v2 lane L-UX U-1): the pure fold over plain records, the HTTP route table, and
// the owner-ui read operations over genuine retained scans (preview check; mock-model review stages). No Docker, no
// live model and no forged accepted records: every genuine record is the owner service's own publication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { STRINGS } from '@farsight/core/dist/strings.js';
import {
  costOf,
  replyOf,
  scanAnswer,
  scansAnswer,
  scanRow,
  sentOf,
  stageAnswer,
  stageName,
  READ_MODEL_SCHEMAS,
  type AttemptRecord,
  type ScanRecord,
  type UnitRecord,
} from '../dist/transport/http/read-model.js';
import { corsHeaders, preflightHeaders, readRoute, routeOperation } from '../dist/transport/http/routes.js';
import { needsStore } from './snapshot-helpers.ts';
import { by, completedPreviewScan, completedReviewScan } from './helpers/read-model-fixture.ts';

/** Every Counted anywhere in a value: words in the catalog, a breakdown that sums, `n` within `of`. */
function assertCountsSound(value: unknown, path = '$'): number {
  let seen = 0;
  if (Array.isArray(value)) value.forEach((v, i) => (seen += assertCountsSound(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    const v = value as Record<string, any>;
    if (typeof v.n === 'number' && typeof v.unit === 'string' && typeof v.scope === 'string') {
      seen++;
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

/** No ledger id or artifact handle in an answer: a scan is a number, a stage its contract. */
function assertNoLedgerIds(value: unknown) {
  const text = JSON.stringify(value);
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
  outputs: ['application/json'],
  ...over,
});
function synthetic(over: Partial<ScanRecord> = {}): ScanRecord {
  const capture = unit('c#1', 'capture', { outputs: ['sentinel-bootstrap-capture/draft-1'] });
  const parse = unit('p#1', 'parse', { dependencies: ['c#1'], outputs: ['sentinel-parser-result/draft-1'] });
  const inventory = unit('i#1', 'inventory', {
    dependencies: ['p#1'],
    outputs: ['sentinel-bootstrap-inventory/draft-1'],
  });
  const check = (key: string, adapter: string, scope: string) =>
    unit(key, 'check', {
      planRevision: 2,
      contract: `sentinel.stage.check.${adapter}`,
      adapterId: adapter,
      dependencies: ['i#1'],
      checks: 1,
      scopes: [`workspace:${scope}`],
      inputs: 1,
      work: { state: 'published', reason: null, kind: 'external-tool', deadlineMs: 120000, reusedFrom: null },
      attempts: [attempt({ worker: 'container' })],
      outputs: ['sentinel-driver-finding/draft-1', 'sentinel-coverage/draft-1'],
    });
  const review = unit('r#2', 'review-general', {
    planRevision: 2,
    contract: 'sentinel.stage.review.general',
    adapterId: 'sentinel.review.general',
    dependencies: ['i#1', 'g#2'],
    scopes: ['workspace'],
    inputs: 2,
    review: { providerId: 'local-review', modelId: 'review' },
    work: { state: 'published', reason: null, kind: 'agentic', deadlineMs: 120000, reusedFrom: null },
    attempts: [
      attempt({
        usage: { certainty: 'confirmed', inputTokens: 80, outputTokens: 6, monetaryCost: '0.0048', currency: 'USD' },
      }),
    ],
    outputs: ['sentinel-review-record/draft-1', 'sentinel-observation/draft-1'],
  });
  return {
    number: 3,
    parentNumber: null,
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
      check('g#2', 'secrets-gitleaks', 'src/a.ts'),
      check('s#2', 'pattern-semgrep', 'src/b.ts'),
      review,
    ],
    adapters: {
      'secrets-gitleaks': {
        version: '8.30.1',
        kind: 'external',
        image: 'ghcr.io/example/gitleaks@sha256:' + '2'.repeat(64),
        command: ['gitleaks', 'dir'],
        registry: 'current',
      },
      'pattern-semgrep': { version: null, kind: 'external', image: null, command: null, registry: 'changed' },
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
      unknownScopeBoundaries: {
        n: 0,
        unit: 'sentinel.count.unknownBoundaries',
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
  assert.equal(secrets.provenance.image, 'ghcr.io/example/gitleaks@sha256:' + '2'.repeat(64));
  assert.equal(secrets.provenance.where, 'container');
  assert.equal(patterns.provenance.implementation.registry, 'changed');
  assert.equal(patterns.provenance.implementation.version, null, 'a changed adapter never lends its version');
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
  // Report counts are the report's own objects, never refolded here.
  assert.equal(answer.scan.counts.seenByNoStage!.source, 'sentinel report fold draft-1');
  assert.ok(assertCountsSound(answer) > 20);
  assert.doesNotMatch(JSON.stringify(answer), /"c#1"|"g#2"|"r#2"/, 'internal unit keys never leave the fold');
});

test('the stage answer reads turns by the closed grammar and never the evidence the model was served', () => {
  const answer = stageAnswer('example-app', synthetic(), 'sentinel.stage.review.general')!;
  assert.equal(answer.prompt!.text, 'You are reviewing.');
  const [first, second] = answer.units[0]!.review!.turns;
  assert.deepEqual(first!.sent, { key: 'sentinel.viewer.turn.task', files: 2 });
  assert.deepEqual(first!.reply, { key: 'sentinel.viewer.turn.read', path: 'src/a.ts', lines: [1, 2] });
  assert.deepEqual(second!.sent, {
    key: 'sentinel.viewer.turn.toolResult',
    tool: 'read',
    ok: true,
    path: 'src/a.ts',
    lines: [1, 2],
  });
  assert.deepEqual(second!.reply, { key: 'sentinel.viewer.turn.final', verdict: 'finding', claims: 1 });
  assert.doesNotMatch(JSON.stringify(answer), /SECRET-LOOKING/);
  assert.equal(answer.units[0]!.review!.observations[0]!.message, 'withTx opens no transaction.');
  assert.equal(stageAnswer('example-app', synthetic(), 'sentinel.stage.absent'), null);
  const check = stageAnswer('example-app', synthetic(), 'sentinel.stage.check.secrets-gitleaks')!;
  assert.equal(check.units[0]!.label, 'src/a.ts');
  assert.equal(check.units[0]!.review, null);
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
  assert.equal(stage.units[0]!.files, 1);
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
  const list = scansAnswer('example-app', [scanRow(synthetic())], false);
  assert.equal(list.counts.scans.n, 1);
  assert.equal(list.readOnly, true);
  assertCountsSound(list);
});

test('the route table answers GET reads only, from the paired origin only', () => {
  assert.deepEqual(readRoute('/api/sentinel/scans'), { kind: 'scans' });
  assert.deepEqual(readRoute('/api/sentinel/scans/12'), { kind: 'scan', number: 12 });
  assert.deepEqual(readRoute('/api/sentinel/scans/12/stages/sentinel.stage.check.secrets-gitleaks'), {
    kind: 'stage',
    number: 12,
    stage: 'sentinel.stage.check.secrets-gitleaks',
  });
  assert.deepEqual(readRoute('/api/sentinel/scans/3/report'), { kind: 'report', number: 3, format: 'md' });
  assert.deepEqual(readRoute('/api/sentinel/scans/3/report/html'), { kind: 'report', number: 3, format: 'html' });
  for (const bad of [
    '/api/sentinel/scans/0',
    '/api/sentinel/scans/-1',
    '/api/sentinel/scans/run-0123',
    '/api/sentinel/scans/1?x=1',
    '/api/sentinel/scans/1/stages/..%2F..',
    '/api/sentinel/scans/1/stages/%E0%A4%A',
    '/api/sentinel/scans/1/report/exe',
    '/api/sentinel/runs',
    '/api/other',
  ])
    assert.equal(readRoute(bad), null, bad);
  assert.deepEqual(routeOperation({ kind: 'stage', number: 2, stage: 'x' }), {
    op: 'owner-ui.stage',
    body: { number: 2, stage: 'x' },
  });
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
    assert.equal(list.scans[0].state, 'completed');
    assert.equal(list.scans[0].policy.reasonCode, 'sentinel.service.previewNotCoverage');
    assert.equal(list.scans[0].cost.basis, 'none');
    assert.deepEqual(
      list.scanAction,
      { available: true, reasonCode: null },
      'a deterministic scan starts from a browser',
    );
    const scan = await f.call('owner-ui.scan', { number: 1 });
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
    assert.deepEqual(scan.scan.counts.unknownScopeBoundaries, doc.counts.unknownScopeBoundaries);
    const stage = await f.call('owner-ui.stage', { number: 1, stage: scan.stages[3].id });
    assert.equal(stage.units.length, 1);
    assert.equal(stage.units[0].label, 'src/one.ts');
    assert.equal(stage.units[0].attempts[0].accepted, true);
    const report = await f.call('owner-ui.scan-report', { number: 1, format: 'md' });
    assert.match(report.formatDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(report).sort(), ['deliveryId', 'format', 'formatBytes', 'formatDigest']);
    await assert.rejects(f.call('owner-ui.scan', { number: 2 }), (e: any) => e.code === 'sentinel.viewer.scanUnknown');
    await assert.rejects(f.call('owner-ui.scan', { number: 'run-1' }));
    await assert.rejects(
      f.call('owner-ui.stage', { number: 1, stage: 'sentinel.stage.absent' }),
      (e: any) => e.code === 'sentinel.viewer.stageUnknown',
    );
    await assert.rejects(f.call('owner-ui.scans', { extra: 1 }));
    // A read is not authority: an unpaired proof reads nothing.
    await assert.rejects(f.service.handle('owner-ui.scans', { proof: 'e'.repeat(64), revision: 1 }, by));
    assert.equal(f.store.ledger.currentSequence(), sequence, 'reading wrote nothing');
    for (const answer of [list, scan, stage]) {
      assertNoLedgerIds(answer);
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
    const scan = await f.call('owner-ui.scan', { number: 1 });
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
    }
    const general = agents.find((s: any) => s.name === 'sentinel.viewer.stage.reviewGeneral');
    const stage = await f.call('owner-ui.stage', { number: 1, stage: general.id });
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
    assert.doesNotMatch(JSON.stringify(stage), /export const original/, 'the served evidence text is never copied');
    for (const answer of [scan, stage]) {
      assertNoLedgerIds(answer);
      assertCountsSound(answer);
    }
  },
);
