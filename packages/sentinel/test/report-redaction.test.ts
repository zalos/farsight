// The fail-closed projection of a report whose run has accepted secret-scan matches: the scanner reports whole lines,
// not the value, so every source- or context-controlled string is withheld, while generated structure, counts,
// catalog words and references are kept. Original inert synthetic values only; no assertion prints one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withholdSecretRun, SECRET_RUN_WITHHELD } from '../dist/service/full-report.js';

const VALUE = ['aB9', ':', 'xQ'].join('');
const digest = `sha256:${'a'.repeat(64)}`;
const place = (ids: string[]) => ({
  binding: 'matched',
  context: { artifact: digest, sourceBindingReceipt: digest, projectionVersion: 'sentinel-place/draft-1' },
  nodeIds: ids,
  screens: ids.map((id) => ({
    id,
    label: { business: `screen ${VALUE}`, code: id },
    via: 'direct-use',
    evidenceArtifact: digest,
  })),
  journeys: [{ id: `fixture::flow::${VALUE}`, label: { business: VALUE, code: VALUE }, screenIds: ids }],
  personas: [
    {
      id: `persona-${VALUE}`,
      label: { business: VALUE, code: VALUE },
      screenIds: ids,
      declared: true,
      evidenceArtifact: digest,
    },
  ],
  counts: {
    screens: {
      n: ids.length,
      unit: 'sentinel.count.screens',
      scope: 'sentinel.scope.finding',
      source: 'fold',
      breakdown: [{ key: 'k', n: ids.length, label: VALUE }],
    },
  },
  limitationKeys: ['sentinel.place.truncated'],
});
const doc = () => ({
  schema: 'sentinel-report/draft-1',
  id: `report.${'b'.repeat(32)}`,
  completeness: 'partial',
  run: { id: `run-${'e'.repeat(32)}`, snapshotId: 'snap-1', planRevision: 2 },
  findings: [
    {
      id: `finding.${'c'.repeat(40)}`,
      observationIds: ['obs.1'],
      ruleFamilyId: 'sentinel.sql.concat',
      severity: 'high',
      comparison: 'persistent',
      title: { business: `issue at ${VALUE}`, code: `sentinel.sql.concat at src/${VALUE}.ts:1` },
      explanation: { business: `It is used by the ${VALUE} screen.`, code: `message ${VALUE}` },
      evidence: [
        {
          id: `ev.${'d'.repeat(32)}`,
          state: 'embedded',
          excerpt: `q = "${VALUE}"`,
          content: digest,
          location: { relativePath: `src/${VALUE}.ts`, startByte: 0, endByte: 3, startLine: 1, endLine: 1 },
        },
        {
          id: `ev.${'f'.repeat(32)}`,
          state: 'withheld',
          reasonCode: 'sentinel.report.withheld.secret',
          content: digest,
        },
      ],
      place: place([`finding.${VALUE}`, `fixture::page::${VALUE}`]),
    },
  ],
  gaps: [
    {
      checkId: 'chk-1',
      status: 'partial',
      reasonCode: 'sentinel.report.gap.partial',
      explanation: { business: 'covered only part', code: 'chk-1: partial' },
      place: place([`fixture::page::${VALUE}`]),
    },
  ],
  decisions: [
    {
      dispositionId: 'disp-1',
      findingId: `finding.${'c'.repeat(40)}`,
      validity: 'valid',
      expiresAt: null,
      rationale: VALUE,
    },
  ],
  definitions: [{ key: 'sentinel.count.findings', text: { business: 'findings', code: 'findings' }, define: 'issues' }],
  artifactClosure: [digest],
});
const words = new Map([
  [
    'sentinel.sql.concat',
    {
      title: { business: 'SQL built from strings', code: 'sentinel.sql.concat' },
      explanation: { business: 'A query is built by joining strings.', code: 'concat' },
    },
  ],
]);

test('a run with secret matches withholds every source and context string, whatever its spelling or shape', () => {
  const out = withholdSecretRun(doc(), words);
  assert.ok(!JSON.stringify(out).includes(VALUE), 'no position keeps the matched value');
  assert.ok(!JSON.stringify(out).includes('src/'), 'no source path remains');
  const f = out.findings[0];
  assert.deepEqual(f.title, words.get('sentinel.sql.concat')!.title, 'titles come from the rule pack only');
  assert.ok(f.explanation.business.startsWith('A query is built by joining strings.'));
  assert.ok(f.evidence.every((e: any) => e.state === 'withheld' && !e.location && !e.excerpt));
  assert.equal(f.evidence[0].reasonCode, SECRET_RUN_WITHHELD);
  assert.equal(f.evidence[1].reasonCode, 'sentinel.report.withheld.secret', 'a secret finding keeps its own reason');
});

test('generated structure, counts, references and the limitation survive the projection', () => {
  const before = doc();
  const out = withholdSecretRun(before, words);
  for (const k of ['schema', 'id', 'completeness']) assert.equal(out[k], (before as any)[k]);
  assert.deepEqual(out.run, before.run);
  assert.equal(out.findings[0].id, before.findings[0]!.id);
  assert.deepEqual(
    [out.findings[0].severity, out.findings[0].comparison, out.findings[0].observationIds],
    ['high', 'persistent', ['obs.1']],
  );
  assert.deepEqual(
    out.gaps[0].explanation,
    before.gaps[0]!.explanation,
    'a gap explanation is catalog words and generated facts',
  );
  const p = out.findings[0].place;
  assert.equal(p.binding, 'matched');
  assert.deepEqual(p.context, before.findings[0]!.place.context);
  assert.equal(p.screens.length, 2);
  assert.equal(p.counts.screens.n, 2);
  assert.equal(p.counts.screens.unit, 'sentinel.count.screens');
  assert.deepEqual(
    p.journeys[0].screenIds,
    p.screens.map((s: any) => s.id),
    'references still match',
  );
  assert.equal(
    out.gaps[0].place.screens[0].id,
    p.screens[1].id,
    'the same context id is the same opaque word everywhere',
  );
  assert.ok([p, out.gaps[0].place].every((x: any) => x.limitationKeys.includes(SECRET_RUN_WITHHELD)));
  assert.ok(
    out.definitions.some((d: any) => d.key === SECRET_RUN_WITHHELD && d.text.business && d.define),
    'the limitation is defined in the report',
  );
  assert.deepEqual([out.decisions[0].dispositionId, out.decisions[0].validity], ['disp-1', 'valid']);
  assert.ok(!JSON.stringify(out.decisions).includes(VALUE), 'an unlisted decision field is withheld');
});
