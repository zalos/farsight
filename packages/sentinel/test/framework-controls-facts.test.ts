// The inspection mapping alone (ADR 44): library control facts → the coverage of the plan's repository-scoped
// inspection checks, one row per surface and property, and one inspection report. Facts are inspection, never
// assessment: nothing here produces a finding or an observation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect, inspectionReport, libraryPresent, CONTROLS_REASONS } from '../dist/frameworks/controls/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';

const ev = {
  snapshotId: 'snap',
  sourceId: 'app',
  relativePath: 'src/app.ts',
  content: `sha256:${'a'.repeat(64)}`,
  span: { startByte: 0, endByte: 1 },
};
const fact = (surfaceId: string, property: string, verdict: string, reasonCode?: string, order = 0) => ({
  id: `f-${surfaceId}-${property}-${verdict}-${order}`,
  property,
  surfaceId,
  order,
  verdict,
  evidence: verdict === 'unknown' ? [] : [ev],
  ...(reasonCode ? { reasonCode } : {}),
});
const envelope = (facts: any[], frontiers: any[] = [], version: string | null = '4.21.2') =>
  ({
    schema: 'sentinel-controls/draft-1',
    snapshotId: 'snap',
    framework: { id: 'express', version },
    packDigest: `sha256:${'b'.repeat(64)}`,
    environmentDigest: `sha256:${'c'.repeat(64)}`,
    registrationDigest: `sha256:${'d'.repeat(64)}`,
    capability: 'framework-order',
    facts,
    frontiers,
  }) as any;
const lib = (framework: string, envelopes: any[], extra: Record<string, unknown> = {}) =>
  ({ framework, packDigest: `sha256:${'b'.repeat(64)}`, envelopes, ...extra }) as any;
// Repository-scoped checks: one per family, all on the source's own scope.
const check = (p: string) => ({ id: `app|${p}`, familyId: `sentinel.controls.${p}`, scopeId: 'app' });
const REPORT = `sha256:${'e'.repeat(64)}`;
const A = 'app::route::GET /a';
const B = 'app::route::GET /b';
const rowOf = (rows: any[], s: string, p: string) => rows.find((r) => r.surfaceId === s && r.property === p);
const stateOf = (r: any, p: string) => r.checks.find((c: any) => c.familyId === `sentinel.controls.${p}`);

test('every surface established: the check is complete, whichever the verdicts, and the report holds no finding', () => {
  const r = inspect(
    [check('authentication')],
    [lib('express', [envelope([fact(A, 'authentication', 'applies'), fact(B, 'authentication', 'does-not-apply')])])],
    [A, B],
    REPORT,
  );
  assert.deepEqual(r.coverage.coveredChecks, [{ checkId: 'app|authentication', coverage: REPORT }]);
  assert.deepEqual(r.coverage.scannedSet, ['app']);
  assert.deepEqual(r.coverage.skipped, []);
  assert.equal(r.coverage.granularity, 'aggregate');
  assert.deepEqual(stateOf(r, 'authentication'), {
    checkId: 'app|authentication',
    familyId: 'sentinel.controls.authentication',
    state: 'complete',
    reasons: [],
  });
  assert.deepEqual(
    [rowOf(r.rows, A, 'authentication').verdict, rowOf(r.rows, B, 'authentication').verdict],
    ['applies', 'does-not-apply'],
  );
  const report = inspectionReport({ runId: 'run' }, [], r.rows, r.checks, {} as any);
  assert.equal(report.assessment, 'none');
  assert.ok(!('findings' in report) && !('observations' in report), 'an inspection carries no finding');
});

test('one surface short of established leaves the whole check partial with its reason, and its own row says why', () => {
  const C = 'app::route::GET /c';
  const r = inspect(
    [check('authorization'), check('authentication'), check('input-validation')],
    [
      lib('express', [
        envelope([
          fact(A, 'authorization', 'unknown', 'sentinel.express.layerMatchUnknown'),
          fact(A, 'authentication', 'applies'),
          fact(B, 'authentication', 'applies'),
        ]),
      ]),
      lib('nest', [envelope([fact(B, 'authentication', 'does-not-apply')])]),
    ],
    [A, B, C],
    REPORT,
  );
  assert.deepEqual(stateOf(r, 'authorization').reasons, [
    'sentinel.controls.propertyNotModeled',
    'sentinel.controls.unclaimed',
    'sentinel.express.layerMatchUnknown',
  ]);
  assert.deepEqual(stateOf(r, 'authentication').reasons, ['sentinel.controls.conflict', 'sentinel.controls.unclaimed']);
  assert.deepEqual(stateOf(r, 'input-validation').reasons, [
    'sentinel.controls.propertyNotModeled',
    'sentinel.controls.unclaimed',
  ]);
  for (const p of ['authorization', 'authentication', 'input-validation']) assert.equal(stateOf(r, p).state, 'partial');
  assert.deepEqual(
    r.coverage.coveredChecks.map((c) => c.checkId),
    ['app|authentication', 'app|authorization', 'app|input-validation'],
    'ran, but not complete',
  );
  assert.deepEqual(
    [rowOf(r.rows, C, 'authentication').state, rowOf(r.rows, C, 'authentication').reasonCode],
    ['not-run', 'sentinel.controls.unclaimed'],
  );
  assert.deepEqual(
    rowOf(r.rows, B, 'authentication').claims.map((c: any) => c.framework),
    ['express', 'nest'],
  );
  assert.ok(
    r.coverage.skipped.every((s) => s.scopeId === 'app'),
    'limits are scoped to the check, the union over its families',
  );
});

test("one library's positions fold along the request path; only libraries that disagree conflict", () => {
  const r = inspect(
    [check('authentication')],
    [
      lib('spring', [
        envelope([
          fact(A, 'authentication', 'does-not-apply', undefined, 1),
          fact(A, 'authentication', 'applies', undefined, 3),
        ]),
      ]),
    ],
    [A],
    REPORT,
  );
  assert.deepEqual(
    [stateOf(r, 'authentication').state, rowOf(r.rows, A, 'authentication').verdict],
    ['complete', 'applies'],
  );
  const u = inspect(
    [check('authentication')],
    [
      lib('spring', [
        envelope([
          fact(A, 'authentication', 'applies', undefined, 1),
          fact(A, 'authentication', 'unknown', 'sentinel.spring.interceptor', 2),
        ]),
      ]),
    ],
    [A],
    REPORT,
  );
  assert.deepEqual(
    [rowOf(u.rows, A, 'authentication').state, rowOf(u.rows, A, 'authentication').reasonCode],
    ['partial', 'sentinel.spring.interceptor'],
  );
});

test('a surface is established only when every library that claims it answers the property (review blocker)', () => {
  // Express claims S for authentication only; Nest claims S and says input validation applies. Express gives no answer
  // for input validation on a surface it claims, so input validation there is not established.
  const r = inspect(
    [check('input-validation')],
    [
      lib('express', [envelope([fact(A, 'authentication', 'does-not-apply')])]),
      lib('nest', [envelope([fact(A, 'input-validation', 'applies'), fact(A, 'authentication', 'does-not-apply')])]),
    ],
    [A],
    REPORT,
  );
  assert.deepEqual(
    [
      rowOf(r.rows, A, 'input-validation').state,
      rowOf(r.rows, A, 'input-validation').reasonCode,
      rowOf(r.rows, A, 'input-validation').verdict,
    ],
    ['partial', 'sentinel.controls.propertyNotModeled', null],
  );
  assert.deepEqual(stateOf(r, 'input-validation'), {
    checkId: 'app|input-validation',
    familyId: 'sentinel.controls.input-validation',
    state: 'partial',
    reasons: ['sentinel.controls.propertyNotModeled'],
  });
  // The silent library is not outvoted by agreement either: both answering is what establishes it.
  const both = inspect(
    [check('authentication')],
    [
      lib('express', [envelope([fact(A, 'authentication', 'does-not-apply')])]),
      lib('nest', [envelope([fact(A, 'authentication', 'does-not-apply')])]),
    ],
    [A],
    REPORT,
  );
  assert.equal(stateOf(both, 'authentication').state, 'complete');
});

test("a refused library keeps the check partial; all refusing leaves it not run; only a present library's frontiers count", () => {
  const ok = lib('express', [envelope([fact(A, 'authentication', 'applies')])]);
  const refused = inspect(
    [check('authentication')],
    [ok, lib('spring', [], { refused: 'sentinel.controls.libraryRefused' })],
    [A],
    REPORT,
  );
  assert.deepEqual(stateOf(refused, 'authentication'), {
    checkId: 'app|authentication',
    familyId: 'sentinel.controls.authentication',
    state: 'partial',
    reasons: ['sentinel.controls.libraryRefused'],
  });
  const none = inspect(
    [check('authentication')],
    [lib('spring', [], { refused: 'sentinel.controls.libraryRefused' })],
    [A],
    REPORT,
  );
  assert.equal(stateOf(none, 'authentication').state, 'not-run');
  assert.deepEqual(none.coverage.coveredChecks, []);
  // Nest found no Nest here (no version, no fact): its "no bootstrap" limits nothing.
  const absent = lib('nest', [
    envelope([], [{ scopeId: 'app:src/main.ts', reasonCode: 'sentinel.nest.bootstrapNotFound' }], null),
  ]);
  assert.equal(libraryPresent(absent), false);
  const silent = inspect([check('authentication')], [ok, absent], [A], REPORT);
  assert.deepEqual([silent.coverage.unresolvedFrontiers, stateOf(silent, 'authentication').state], [[], 'complete']);
  // A present library's frontier is part of the repository it did not inspect.
  const gap = inspect(
    [check('authentication')],
    [
      lib('express', [
        envelope(
          [fact(A, 'authentication', 'applies')],
          [{ scopeId: 'app:src/app.ts', reasonCode: 'sentinel.express.routeNotInGraph' }],
        ),
      ]),
    ],
    [A],
    REPORT,
  );
  assert.deepEqual(gap.coverage.unresolvedFrontiers, [
    { scopeId: 'app:src/app.ts', reasonCode: 'sentinel.express.routeNotInGraph' },
  ]);
  assert.deepEqual(stateOf(gap, 'authentication').reasons, ['sentinel.express.routeNotInGraph']);
  // Next with a project but no surfaces names its source gap outside any envelope: present.
  assert.equal(
    libraryPresent(
      lib('next', [], { frontiers: [{ scopeId: 'app:pages/', reasonCode: 'sentinel.next.reason.pagesRouter' }] }),
    ),
    true,
  );
});

test('only the modeled properties are inspection families; every reason is a catalog word', () => {
  const r = inspect([{ id: 'x', familyId: 'sentinel.controls.csrf', scopeId: 'app' }], [], [A], REPORT);
  assert.deepEqual(r.coverage.skipped, [{ scopeId: 'app', reasonCode: 'sentinel.controls.familyUnsupported' }]);
  for (const code of [
    ...CONTROLS_REASONS,
    'sentinel.controls.jobInvalid',
    'sentinel.controls.rule.authentication',
    'sentinel.controls.rule.authorization',
    'sentinel.controls.rule.inputValidation',
    'sentinel.controls.limitation.inspectionOnly',
  ])
    assert.ok(STRINGS[code]?.define, code);
});
