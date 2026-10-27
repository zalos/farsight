import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { rerunRun, executeRun, notExecutableHere } from '../dist/service/canonical.js';
import { publicRegistry } from '../dist/service/scanner-profile.js';
import { loadPlan } from '../dist/execution/plans.js';

test(
  'owner-promoted framework pack reaches the actual public driver with no external assets',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER, { run: false });
    assert.equal(f.admitted.plan.units.length, 1);
    assert.equal(f.admitted.plan.units[0].adapterId, 'framework-controls');
    assert.equal(await notExecutableHere(f.store, f.runId, publicRegistry(f.ws.trustDir)), undefined);
    rmSync(join(f.path, 'src'), { recursive: true, force: true });
    const result = await f.run();
    assert.equal(result.state, 'completed', JSON.stringify(result.failures));
    assert.equal(result.published, 1);
    const pub = f.store.ledger.getPublication(f.admitted.plan.units[0])!;
    const reports = pub.outputs.filter((o) => o.schema === 'sentinel-driver-report/draft-1');
    assert.equal(reports.length, 1);
    const report = JSON.parse((await f.store.readArtifact(reports[0].id)).toString());
    assert.equal(report.assessment, 'none');
    assert.equal(report.findings, 0);
    assert.equal(report.extent, 3);
    assert.ok(report.checks.every((c: any) => c.state === 'partial'));
    assert.equal(
      pub.outputs.some((o) => o.schema === 'sentinel-driver-finding/draft-1'),
      false,
    );
  },
);

test(
  'mandatory framework rules without promotion remain gaps and never launch an inspection',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER, { promote: false, run: false });
    assert.equal(f.admitted.plan.units.length, 0);
    assert.equal(f.admitted.plan.ruleGaps.length, 3);
    assert.ok(f.admitted.plan.ruleGaps.every((g) => g.required));
  },
);

test(
  'a strict framework selection reuses genuine retained parser evidence after source removal',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER, { preview: true });
    const unit = f.admitted.plan.units.find((u) => u.adapterId === 'framework-controls')!;
    for (const u of f.admitted.plan.units) {
      const pub = f.store.ledger.getPublication(u);
      assert.ok(pub);
      const attempt = f.store.ledger.getAttempt(pub.attemptId);
      const inv = JSON.parse((await f.store.readArtifact(attempt.envelope.invocation)).toString());
      assert.equal(
        Object.hasOwn(inv, 'job'),
        u.adapterId === 'framework-controls',
        'preview invocation retains the absent-job form',
      );
    }
    assert.ok(f.admitted.plan.units.length > 1);
    rmSync(join(f.path, 'src'), { recursive: true, force: true });
    const child: any = await rerunRun(f.store, f.runId, [unit.id], f.terms);
    assert.ok(child.disclosure, JSON.stringify(child));
    assert.equal(child.preview.all, false);
    const done = await executeRun(f.store, child.disclosure.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir });
    assert.equal(done.state, 'completed', JSON.stringify(done.failures));
    assert.equal(done.published, 1);
    const admitted = await loadPlan(f.store, child.disclosure.runId, 1);
    for (const h of admitted.selection!.held)
      assert.equal(f.store.ledger.countAttempts({ id: h.unit, revision: 1 }), 0);
  },
);

test('ordinary public imports and help do not load the native inspection parser', async () => {
  const { spawnSync } = await import('node:child_process');
  const source = `import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){if(s==='oxc-parser')throw new Error('native parser loaded during import');return n(s,c)}});await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});await import(${JSON.stringify(new URL('../dist/store/index.js', import.meta.url).href)});process.argv=[process.execPath,'farsight-sentinel','--help'];await import(${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /farsight-sentinel/);
});
