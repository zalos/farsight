// The inspection mapping alone (ADR 44): library control facts → the coverage of the plan's inspection checks and one
// inspection report. Facts are inspection, never assessment: nothing here produces a finding or an observation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect, inspectionReport, CONTROLS_REASONS } from '../dist/frameworks/controls/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';

const ev = { snapshotId: 'snap', sourceId: 'app', relativePath: 'src/app.ts', content: `sha256:${'a'.repeat(64)}`, span: { startByte: 0, endByte: 1 } };
const fact = (surfaceId: string, property: string, verdict: string, reasonCode?: string, order = 0) => ({
  id: `f-${surfaceId.length}-${property}-${verdict}-${order}`, property, surfaceId, order, verdict,
  evidence: verdict === 'unknown' ? [] : [ev], ...(reasonCode ? { reasonCode } : {}),
});
const envelope = (facts: any[], frontiers: any[] = []) => ({ schema: 'sentinel-controls/draft-1', snapshotId: 'snap', framework: { id: 'express', version: '4.21.2' },
  packDigest: `sha256:${'b'.repeat(64)}`, environmentDigest: `sha256:${'c'.repeat(64)}`, registrationDigest: `sha256:${'d'.repeat(64)}`,
  capability: 'framework-order', facts, frontiers }) as any;
const lib = (framework: string, envelopes: any[], extra: Record<string, unknown> = {}) => ({ framework, packDigest: `sha256:${'b'.repeat(64)}`, envelopes, ...extra }) as any;
const check = (id: string, familyId: string, scopeId: string) => ({ id, familyId, scopeId });
const REPORT = `sha256:${'e'.repeat(64)}`;
const rowOf = (rows: any[], s: string, p: string) => rows.find(r => r.surfaceId === s && r.property === p);

test('a resolved fact is an established inspection, whichever its verdict, and never a finding', () => {
  const r = inspect([check('c1', 'sentinel.controls.authentication', 'app::route::GET /a'), check('c2', 'sentinel.controls.authentication', 'app::route::GET /b')],
    [lib('express', [envelope([fact('app::route::GET /a', 'authentication', 'applies'), fact('app::route::GET /b', 'authentication', 'does-not-apply')])])], 'app', REPORT);
  assert.deepEqual(r.coverage.coveredChecks, [{ checkId: 'c1', coverage: REPORT }, { checkId: 'c2', coverage: REPORT }]);
  assert.deepEqual(r.coverage.skipped, []);
  assert.deepEqual([rowOf(r.rows, 'app::route::GET /a', 'authentication').state, rowOf(r.rows, 'app::route::GET /b', 'authentication').verdict], ['established', 'does-not-apply']);
  const report = inspectionReport({ runId: 'run' }, [], r.rows, {} as any);
  assert.equal(report.assessment, 'none');
  assert.ok(!('findings' in report) && !('observations' in report), 'an inspection carries no finding');
});

test('unknown and disagreeing claims stay partial with their reason; no claim or an unmodeled property is not run', () => {
  const checks = [
    check('u', 'sentinel.controls.authorization', 'app::route::GET /u'), check('x', 'sentinel.controls.authentication', 'app::route::GET /x'),
    check('n', 'sentinel.controls.input-validation', 'app::route::GET /n'), check('m', 'sentinel.controls.input-validation', 'app::route::GET /x'),
  ];
  const r = inspect(checks, [
    lib('express', [envelope([fact('app::route::GET /u', 'authorization', 'unknown', 'sentinel.express.layerMatchUnknown'), fact('app::route::GET /x', 'authentication', 'applies')])]),
    lib('nest', [envelope([fact('app::route::GET /x', 'authentication', 'does-not-apply')])]),
  ], 'app', REPORT);
  assert.deepEqual(r.coverage.coveredChecks.map(c => c.checkId), ['u', 'x'], 'ran, but not complete');
  assert.deepEqual(r.coverage.skipped.map(s => `${s.scopeId} ${s.reasonCode}`), [
    'app::route::GET /n sentinel.controls.unclaimed', 'app::route::GET /u sentinel.express.layerMatchUnknown',
    'app::route::GET /x sentinel.controls.conflict', 'app::route::GET /x sentinel.controls.propertyNotModeled',
  ]);
  assert.equal(rowOf(r.rows, 'app::route::GET /x', 'authentication').state, 'partial');
  assert.deepEqual(rowOf(r.rows, 'app::route::GET /x', 'authentication').claims.map((c: any) => c.framework), ['express', 'nest']);
});

test('one library\'s positions fold along the request path; only libraries that disagree conflict', () => {
  const s = 'app::route::GET /a';
  // A chain that permits the path, then method security that requires a principal: the control applies.
  const r = inspect([check('c', 'sentinel.controls.authentication', s)],
    [lib('spring', [envelope([fact(s, 'authentication', 'does-not-apply', undefined, 1), fact(s, 'authentication', 'applies', undefined, 3)])])], 'app', REPORT);
  assert.deepEqual([rowOf(r.rows, s, 'authentication').state, rowOf(r.rows, s, 'authentication').verdict], ['established', 'applies']);
  // Any unresolved position leaves it partial, whatever another position says.
  const u = inspect([check('c', 'sentinel.controls.authentication', s)],
    [lib('spring', [envelope([fact(s, 'authentication', 'applies', undefined, 1), fact(s, 'authentication', 'unknown', 'sentinel.spring.interceptor', 2)])])], 'app', REPORT);
  assert.deepEqual([rowOf(u.rows, s, 'authentication').state, rowOf(u.rows, s, 'authentication').reasonCode], ['partial', 'sentinel.spring.interceptor']);
});

test('a refused library leaves every check short of established; a library that claims nothing limits nothing', () => {
  const s = 'app::route::GET /a';
  const refused = inspect([check('c', 'sentinel.controls.authentication', s)],
    [lib('express', [envelope([fact(s, 'authentication', 'applies')])]), lib('spring', [], { refused: 'sentinel.controls.libraryRefused' })], 'app', REPORT);
  assert.equal(rowOf(refused.rows, s, 'authentication').state, 'partial');
  assert.ok(refused.coverage.skipped.some(x => x.reasonCode === 'sentinel.controls.libraryRefused'));
  const silent = inspect([check('c', 'sentinel.controls.authentication', s)],
    [lib('express', [envelope([fact(s, 'authentication', 'applies')])]), lib('nest', [envelope([], [{ scopeId: 'app:src/main.ts', reasonCode: 'sentinel.nest.bootstrapNotFound' }])])], 'app', REPORT);
  assert.deepEqual(silent.coverage.unresolvedFrontiers, [], 'Nest found no Nest surface here: its frontier bears on nothing');
  assert.equal(rowOf(silent.rows, s, 'authentication').state, 'established');
  const claimed = inspect([check('c', 'sentinel.controls.authentication', s)],
    [lib('express', [envelope([fact(s, 'authentication', 'applies')], [{ scopeId: 'app:src/app.ts', reasonCode: 'sentinel.express.registrationDynamic' }])])], 'app', REPORT);
  assert.deepEqual(claimed.coverage.unresolvedFrontiers, [{ scopeId: 'app:src/app.ts', reasonCode: 'sentinel.express.registrationDynamic' }]);
});

test('only the modeled properties are inspection families; every reason is a catalog word', () => {
  const r = inspect([check('c', 'sentinel.controls.csrf', 'app::route::GET /a')], [], 'app', REPORT);
  assert.deepEqual(r.coverage.skipped, [{ scopeId: 'app::route::GET /a', reasonCode: 'sentinel.controls.familyUnsupported' }]);
  for (const code of [...CONTROLS_REASONS, 'sentinel.controls.jobInvalid', 'sentinel.controls.rule.authentication', 'sentinel.controls.rule.authorization',
    'sentinel.controls.rule.inputValidation', 'sentinel.controls.limitation.inspectionOnly']) assert.ok(STRINGS[code]?.define, code);
});
