// Producer-fault robustness at the accepted-record boundary. These deliberately injected records are not normal
// producer output: a single exact record is altered while canonicalized, genuinely stored/accepted, and the live
// object is restored at the existing accepted-start hook before normalization. No store receipt is fabricated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { Coordinator } from '../dist/execution/coordinator.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { fullReport } from '../dist/service/full-report.js';
import { executeRun } from '../dist/service/canonical.js';
import { frameworkAdapter } from '../dist/service/framework-adapter.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { CONTROLS_JOB_SCHEMA } from '../dist/frameworks/controls/definitions.js';
import { canonicalJsonBytes } from '../dist/store/objects.js';

for (const mode of ['null', 'number', 'malformed', 'unsealed', 'other-sealed', 'binding-job'] as const) {
  test(`accepted serialization fault ${mode} refuses report readback`, needsStore, async t => {
    const f = await frameworkFixture(t, ORDER, { run: false });
    const unit = f.admitted.plan.units.find(u => u.adapterId === 'framework-controls')!;
    assert.ok(unit);
    const registry = publicRegistry(f.ws.trustDir);
    const assets = await scannerExecution(f.store, f.runId, f.ws.trustDir, f.work, registry);
    const keys = Object.keys;
    let target: any, original: any, storedId: string | undefined, fired = 0;
    const wrong = mode === 'null' ? null : mode === 'number' ? 7 : mode === 'malformed' ? 'x'
      : mode === 'other-sealed' ? unit.inputs[0]!.content : `sha256:${'f'.repeat(64)}`;
    const restore = () => { if (target) { if (mode === 'binding-job') { if (target.derived.job !== original) target.derived.job = original; } else if (target.job !== original) target.job = original; } };
    const mock = t.mock.method(Object, 'keys', function(value: any) {
      const match = mode === 'binding-job' ? value?.schema === 'sentinel-execution-binding/draft-1' && value.plan?.runId === f.runId
        : value?.format === 'sentinel-invocation/draft-1' && value.store === f.store.storeId;
      if (!fired && match && value.work?.id === unit.id && value.work?.revision === unit.revision) {
        target = value; original = mode === 'binding-job' ? value.derived.job : value.job;
        if (mode === 'binding-job') value.derived.job = wrong; else value.job = wrong;
        fired++;
      }
      return keys(value);
    });
    try {
      const coordinator = await Coordinator.open({ ...assets, store: f.store, runId: f.runId, registry, scratchRoot: f.work,
        hooks: { at(boundary) { if (boundary === 'after-attempt-start' && target) {
          storedId = f.store.objects.identify(canonicalJsonBytes(target)).id;
          restore();
        } } },
      });
      const done = await coordinator.run();
      assert.equal(done.state, 'completed', JSON.stringify(done));
      assert.equal(fired, 1, 'exactly one intended record was altered');
      assert.ok(storedId);
    } finally { restore(); mock.mock.restore(); }
    const stored = JSON.parse((await f.store.readArtifact(storedId!)).toString());
    assert.equal(f.store.objects.identify(canonicalJsonBytes(stored)).id, storedId, 'accepted original bytes genuinely hash');
    assert.equal(mode === 'binding-job' ? stored.derived.job : stored.job, wrong);
    await assert.rejects(fullReport({ store: f.store, runId: f.runId, workspace: f.path, trustDir: f.ws.trustDir,
      now: new Date('2026-10-22T00:00:00Z'), disclosure: 'shareable' }), (e: any) => e.code === 'sentinel.report.evidenceUnbound');
  });
}


for (const mode of ['foreign-unit', 'binding-job', 'output-job'] as const) {
  test(`genuine attempt normalization refuses ${mode}`, needsStore, async t => {
    const f = await frameworkFixture(t, ORDER, { run: false });
    const registry = publicRegistry(f.ws.trustDir), base = frameworkAdapter(f.ws.trustDir).driver;
    let reached = 0;
    const drivers = createCheckDriverRegistry([{ ...base, async normalize(ctx: any, verified: any) {
      reached++;
      const job = structuredClone(verified.job), binding = structuredClone(verified.binding);
      if (mode === 'foreign-unit') job.binding.unit.id = 'foreign-unit';
      if (mode === 'binding-job') binding.derived.job = ctx.unit.inputs[0].content;
      return base.normalize(ctx, { ...verified, job, binding, output(id: string) {
        const bytes = verified.output(id);
        if (mode !== 'output-job') return bytes;
        const doc = JSON.parse(Buffer.from(bytes).toString()); doc.job = ctx.unit.inputs[0].content;
        return Buffer.from(JSON.stringify(doc));
      } });
    } }], registry);
    const done = await executeRun(f.store, f.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir, registry, drivers });
    assert.ok(reached > 0);
    assert.equal(done.published, 0);
    for (const unit of f.admitted.plan.units) assert.equal(f.store.ledger.getPublication(unit), null);
    assert.ok(done.failures.length > 0, JSON.stringify(done));
  });
}

test('captured hostile job-shaped JSON and identical source bodies cannot deny or alter the trusted inspection', needsStore, async t => {
  const clean = await frameworkFixture(t, ORDER);
  const hostile = await frameworkFixture(t, { ...ORDER,
    'hostile.json': JSON.stringify({ schema: CONTROLS_JOB_SCHEMA, snapshotId: 'foreign-snapshot', sourceId: 'foreign', analysis: {}, properties: [] }),
    'duplicate-a.txt': 'identical inert source body', 'duplicate-b.txt': 'identical inert source body',
  });
  const request = (f: any) => ({ store:f.store, runId:f.runId, workspace:f.path, trustDir:f.ws.trustDir,
    now:new Date('2026-10-22T00:00:00Z'), disclosure:'shareable' as const });
  const [a,b] = await Promise.all([fullReport(request(clean)), fullReport(request(hostile))]);
  const rows = (r: any) => r.document.inspections[0].rows.map((row: any) => [row.surfaceId,row.property,row.state,row.verdict,row.reasonCode]);
  assert.deepEqual(rows(b), rows(a));
  const unit = hostile.admitted.plan.units[0], pub = hostile.store.ledger.getPublication(unit)!;
  const attempt = hostile.store.ledger.getAttempt(pub.attemptId)!;
  const inv = JSON.parse((await hostile.store.readArtifact(attempt.envelope.invocation!)).toString());
  const identical = unit.inputs.filter(i => i.relativePath.startsWith('duplicate-'));
  assert.equal(identical.length, 2); assert.equal(identical[0].content, identical[1].content);
  assert.equal(inv.inputs.filter((id:string) => id === identical[0].content).length, 1);
  const raw = JSON.parse((await hostile.store.readArtifact(pub.outputs.find(o => o.schema === 'application/vnd.sentinel.framework-controls+json')!.id)).toString());
  assert.equal(inv.job, raw.job);
  const selected = JSON.parse((await hostile.store.readArtifact(inv.job)).toString());
  assert.equal(selected.sourceId, unit.sourceId);
  assert.equal(selected.binding.unit.id, unit.id);
});
