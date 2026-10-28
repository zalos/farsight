// The Sentinel surface's pure half (Sentinel v2 lane L-UX U-2): the address grammar of the five stops, the words a
// duration and a cost print with, the ladder's rows, the stage the dock shows, and the Scan button's state. The module
// is the one the viewer imports, so this tests the shipped code; the DOM half is the e2e spec sentinel-ladder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const m = await import(join(here, '..', 'public', 'app', 'lib', 'sentinel-model.js'));

const RUN = 'run-' + 'a'.repeat(32);
const blank = {
  stop: 'scans',
  scan: null,
  stage: null,
  unit: null,
  before: null,
  layout: 'list',
  pick: null,
  act: null,
};

test('the address names the stop, the scan by its run id, the stage, the open unit, the layout and the pick', () => {
  assert.deepEqual(m.sentinelPlace('#/sentinel'), blank);
  assert.equal(m.sentinelPlace('#/sentinel?do=scan').act, 'scan', 'a door may ask the SCANS stop for a scan');
  assert.equal(m.sentinelPlace(`#/sentinel/${RUN}?do=scan`).act, null, 'only the SCANS stop takes it');
  assert.equal(m.sentinelHash(m.sentinelPlace('#/sentinel?do=scan')), '#/sentinel', 'the address never keeps it');
  assert.deepEqual(m.sentinelPlace('#/sentinel?before=12'), { ...blank, before: 12 }, 'an older page of scans');
  assert.deepEqual(m.sentinelPlace(`#/sentinel/${RUN}`), {
    ...blank,
    stop: 'pipeline',
    scan: RUN,
    layout: 'ladder',
  });
  assert.deepEqual(m.sentinelPlace(`#/sentinel/${RUN}?layout=table&pick=sentinel.stage.capture`), {
    ...blank,
    stop: 'pipeline',
    scan: RUN,
    layout: 'table',
    pick: 'sentinel.stage.capture',
  });
  assert.deepEqual(m.sentinelPlace(`#/sentinel/${RUN}/sentinel.stage.review.general?unit=3`), {
    ...blank,
    stop: 'stage',
    scan: RUN,
    stage: 'sentinel.stage.review.general',
    unit: 3,
    layout: 'detail',
  });
  // a layout the stop does not have, or one not built, is the stop's default; an id the grammar refuses is the list
  assert.equal(m.sentinelPlace(`#/sentinel/${RUN}?layout=lanes`).layout, 'ladder');
  assert.equal(m.sentinelPlace('#/sentinel?layout=compare').layout, 'list');
  assert.equal(m.sentinelPlace('#/sentinel/.hidden').stop, 'scans');
  assert.equal(m.sentinelPlace('#/sentinel/%E0%A4%A').stop, 'scans');
  assert.equal(m.sentinelPlace(`#/sentinel/${RUN}/..%2F`).stop, 'pipeline');
  assert.equal(m.sentinelPlace(`#/sentinel/${RUN}/x?unit=0`).unit, null);
  assert.equal(m.sentinelPlace('#/map').stop, 'scans');
  for (const place of [
    { scan: null },
    { scan: RUN },
    { scan: RUN, layout: 'table' },
    { scan: RUN, pick: 'sentinel.stage.check.secrets-gitleaks' },
    { scan: RUN, stage: 'sentinel.stage.review.guided', layout: 'table' },
    { scan: RUN, stage: 'sentinel.stage.review.guided', unit: 4 },
    { before: 9 },
  ]) {
    const back = m.sentinelPlace(m.sentinelHash(place));
    assert.equal(back.scan, place.scan ?? null);
    assert.equal(back.stage, (place as any).stage ?? null);
    if ((place as any).layout) assert.equal(back.layout, (place as any).layout);
    if ((place as any).pick) assert.equal(back.pick, (place as any).pick);
    if ((place as any).unit) assert.equal(back.unit, (place as any).unit);
    if ((place as any).before) assert.equal(back.before, (place as any).before);
  }
  assert.equal(
    m.sentinelHash({ scan: RUN, layout: 'ladder' }),
    `#/sentinel/${RUN}`,
    'the default layout is not written',
  );
  assert.equal(
    m.sentinelHash({ scan: RUN, stage: 's', unit: 1 }),
    `#/sentinel/${RUN}/s`,
    'the first unit is not written',
  );
});

test('the not-built stops and layouts are named, and never reachable', () => {
  assert.deepEqual(
    m.SENTINEL_STOPS.filter((s: any) => !s.built).map((s: any) => s.id),
    ['entries', 'path'],
  );
  assert.deepEqual(
    m.SENTINEL_LAYOUTS.scans.filter((l: any) => !l.built).map((l: any) => l.id),
    ['compare'],
  );
});

test('durations and costs read as the mocks do, and an unobserved price is never $0', () => {
  assert.equal(m.durationWords(412), '412 ms');
  assert.equal(m.durationWords(4100), '4.1 s');
  assert.equal(m.durationWords(48000), '48 s');
  assert.equal(m.durationWords(130000), '2 m 10 s');
  assert.equal(m.durationWords(119999), '2 m 00 s', 'never 1 m 60 s');
  assert.equal(m.durationWords(9980), '10 s');
  assert.equal(m.bytesWords(412), '412 bytes');
  assert.equal(m.bytesWords(1), '1 byte');
  assert.equal(m.bytesWords(5549), '5.4 KiB');
  assert.equal(m.bytesWords(2147483648), '2 GiB');
  assert.equal(m.bytesWords(null), '');
  assert.equal(m.durationWords(3_900_000), '1 h 05 m');
  assert.equal(m.durationWords(null), '');
  assert.deepEqual(m.costWords({ basis: 'recorded', amount: '0.09', currency: 'USD' }), {
    key: 'sentinel.viewer.cost.recorded',
    amount: '$0.09',
  });
  assert.deepEqual(m.costWords({ basis: 'recorded', amount: '0.09', currency: 'EUR' }).amount, '0.09 EUR');
  assert.deepEqual(m.costWords({ basis: 'unobserved', amount: null, currency: null }), {
    key: 'sentinel.viewer.cost.unobserved',
    amount: '',
  });
  assert.equal(m.costWords({ basis: 'none' }).key, 'sentinel.viewer.cost.none');
  assert.equal(m.costWords({ basis: 'mixed' }).key, 'sentinel.viewer.cost.mixed');
});

const stage = (id: string, number: number, over: any = {}) => ({
  id,
  number,
  kind: 'builtin',
  status: 'done',
  provenance: {
    kind: 'builtin',
    where: 'in-process',
    implementation: {
      adapter: 'sentinel-capture',
      version: '1',
      digest: 'sha256:' + '7'.repeat(64),
      registry: 'current',
    },
    invocation: null,
    invocationAbsent: 'sentinel.viewer.invocation.none',
    provider: null,
    model: null,
    prompt: null,
    skills: null,
  },
  ...over,
});

test('the ladder draws a level as one row, side by side, and the dock picks a stage the reader can read', () => {
  const scan = {
    stages: [
      stage('a', 1),
      stage('b', 2),
      stage('c', 3, { status: 'running' }),
      stage('d', 4, { kind: 'agent', status: 'waiting' }),
    ],
    levels: [['a'], ['b', 'c'], ['d']],
  };
  assert.deepEqual(
    m.ladderRows(scan).map((row: any[]) => row.map((s) => s.id)),
    [['a'], ['b', 'c'], ['d']],
  );
  assert.equal(m.pickedStage(scan, 'b').id, 'b');
  assert.equal(m.pickedStage(scan, 'nope').id, 'c', 'the running stage when the pick is gone');
  assert.equal(m.pickedStage({ stages: [stage('a', 1), stage('d', 2, { kind: 'agent' })] }, null).id, 'd');
  assert.equal(m.pickedStage({ stages: [] }, null), null);
  assert.equal(m.scanLive({ state: 'running' }), true);
  assert.equal(m.scanLive({ state: 'completed' }), false);
});

test('the business register prints no provenance; code and hybrid print what ran, short', () => {
  const s = stage('a', 1);
  assert.deepEqual(m.provenanceParts(s, 'business'), []);
  assert.deepEqual(m.provenanceParts(s, 'code'), ['sentinel-capture 1', 'digest 77777777']);
  const tool = stage('t', 2, {
    kind: 'tool',
    provenance: {
      ...s.provenance,
      kind: 'tool',
      invocation: {
        attempt: 1,
        image: { reference: 'ghcr.io/example/gitleaks:8.30.1', id: 'sha256:' + 'ab'.repeat(32), architecture: 'arm64' },
      },
      implementation: { ...s.provenance.implementation, adapter: 'secrets-gitleaks', version: '8.30.1' },
    },
  });
  assert.deepEqual(m.provenanceParts(tool, 'hybrid'), [
    'secrets-gitleaks 8.30.1',
    'ghcr.io/example/gitleaks:8.30.1 · abababab… · arm64',
  ]);
  assert.equal(m.imageWords(null), '');
  const agent = stage('r', 3, {
    kind: 'agent',
    provenance: {
      ...s.provenance,
      kind: 'agent',
      provider: { id: 'local-review', model: 'review' },
      model: { requested: 'review-model:1', reported: 'review-model:1', source: 'host-reported' },
      prompt: { name: 'sentinel.review.general', revision: 1, digest: 'sha256:' + '4'.repeat(64), bytes: 10 },
      skills: [{ name: 'owasp-top10', revision: 2, digest: 'sha256:' + '5'.repeat(64), bytes: 9 }],
    },
  });
  assert.deepEqual(m.provenanceParts(agent, 'code'), [
    'local-review',
    'review-model:1',
    'prompt sentinel.review.general/1 (44444444…)',
    'skills owasp-top10/2',
  ]);
  assert.equal(m.shortDigest('sha256:' + 'f'.repeat(64)), 'ffffffff');
  assert.equal(m.shortDigest('not a digest'), '');
});

test('the Scan button is greyed with its reason, never a dead click', () => {
  assert.deepEqual(m.scanState({ readOnly: true, companion: true, paired: true }), {
    on: false,
    why: 'sys.readonly.control',
  });
  assert.equal(m.scanState({ readOnly: false, companion: false, paired: false }).why, 'sentinel.ownerUi.launch');
  assert.equal(m.scanState({ readOnly: false, companion: true, paired: false }).why, 'sentinel.viewer.scan.pairing');
  assert.deepEqual(
    m.scanState({ readOnly: false, companion: true, paired: true }),
    { on: false, why: 'sentinel.viewer.scan.checking' },
    'paired, but the list has not said yet: off, with why',
  );
  assert.deepEqual(m.doorState({ readOnly: false, action: null }), { on: false, why: 'sentinel.viewer.scan.unknown' });
  assert.deepEqual(m.doorState({ readOnly: true, action: { available: true } }), {
    on: false,
    why: 'sys.readonly.control',
  });
  assert.deepEqual(
    m.doorState({ readOnly: false, action: { available: false, reasonCode: 'sentinel.review.foregroundRequired' } }),
    { on: false, why: 'sentinel.review.foregroundRequired' },
  );
  assert.deepEqual(m.doorState({ readOnly: false, action: { available: true, reasonCode: null } }), {
    on: true,
    why: 'sentinel.viewer.scan.door',
  });
  assert.deepEqual(
    m.scanState({
      readOnly: false,
      companion: true,
      paired: true,
      action: { available: false, reasonCode: 'sentinel.review.foregroundRequired' },
    }),
    { on: false, why: 'sentinel.review.foregroundRequired' },
  );
  assert.deepEqual(
    m.scanState({ readOnly: false, companion: true, paired: true, action: { available: true, reasonCode: null } }),
    { on: true, why: 'sentinel.viewer.scan.define' },
  );
});

test('every word the model names is a catalog key the surface can print', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const keys = [
    ...m.SENTINEL_STOPS.map((s: any) => s.key),
    ...Object.values(m.SENTINEL_LAYOUTS).flatMap((ls: any) => ls.map((l: any) => l.key)),
    ...['done', 'running', 'waiting', 'failed', 'held', 'reused', 'not-run'].map((s) => m.statusKey(s)),
    ...['planned', 'running', 'pausing', 'paused', 'canceling', 'canceled', 'completed', 'awaiting'].map((s) =>
      m.statusKey(s, true),
    ),
    ...['builtin', 'tool', 'script', 'agent'].map((k) => m.kindChip(k).key),
    ...['in-process', 'child', 'container', 'external', 'provider', null].map((w) => m.whereKey(w)),
    ...['recorded', 'unobserved', 'none', 'mixed'].map(
      (b) => m.costWords({ basis: b, amount: '1', currency: 'USD' }).key,
    ),
    'sentinel.viewer.stop.notBuilt',
    'sentinel.viewer.scan.define',
    'sentinel.viewer.scan.pairing',
    'sentinel.viewer.scan.checking',
    'sentinel.viewer.scan.unknown',
    'sentinel.viewer.scan.door',
  ];
  for (const k of keys) assert.ok(Object.hasOwn(STRINGS, k), k);
});
