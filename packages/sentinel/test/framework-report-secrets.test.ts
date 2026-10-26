// Real pinned Gitleaks + trusted framework worker publications. Opt-in is mandatory in the native scanner job;
// a missing image or Docker fails after opt-in. No successful grant, receipt, attempt or publication is fabricated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { nativeSecrets } from './sol-report-helpers.ts';
import { fullReport } from '../dist/service/full-report.js';
import { scannerReportOf } from '../dist/reports/scanner.js';
import { rerunRun, executeRun, planWorkspaceCanonical } from '../dist/service/canonical.js';
import { scannerExecution, publicRegistry } from '../dist/service/scanner-profile.js';
import { Coordinator } from '../dist/execution/coordinator.js';
const files = (secret: boolean) => ({
  ...ORDER,
  '.env': secret ? `api_key = "${GENERIC_VALUE}"\n` : 'EXAMPLE_SETTING=public\n',
  ['src/' + (secret ? GENERIC_VALUE : 'public-example') + '.ts']: 'export const originalExample=42;\n',
  'src/app.ts': ORDER['src/app.ts'].replace('/reports', secret ? '/' + GENERIC_VALUE : '/public-example'),
});
const req = (f: any, runId = f.runId) => ({
  store: f.store,
  runId,
  workspace: f.path,
  trustDir: f.ws.trustDir,
  now: new Date('2026-10-22T00:00:00Z'),
  disclosure: 'private' as const,
});
function withheld(r: any) {
  assert.equal(r.withheldForSecrets, true);
  for (const value of [r.json, r.markdown, r.html, JSON.stringify(r.sarif)])
    absent(value, 'inspection delivery', GENERIC_VALUE);
  assert.match(r.document.inspections[0].sourceId, /^withheld-/);
  assert.equal(r.document.inspections[0].assessment, 'none');
  for (const row of r.document.inspections[0].rows) assert.match(row.surfaceId, /^withheld-/);
  for (const lib of r.document.inspections[0].libraries)
    for (const v of lib.versions) if (v !== null) assert.match(v, /^withheld-/);
  assert.deepEqual(r.sarif.runs[0].properties.inspections, r.document.inspections);
}
for (const secret of [true, false])
  test(
    `inspection delivery preserves ${secret ? 'current, selected and baseline secret privacy' : 'clean source identities and versions'}`,
    nativeSecrets,
    async (t) => {
      const f = await frameworkFixture(t, files(secret), { secrets: true });
      const current = await fullReport(req(f));
      if (secret) withheld(current);
      else {
        assert.equal(current.withheldForSecrets, false);
        assert.ok(current.json.includes('4.21.2'));
        assert.ok(current.document.inspections[0].rows.some((r) => !r.surfaceId.startsWith('withheld-')));
      }
      const control = f.admitted.plan.units.find((u) => u.adapterId === 'framework-controls');
      const child: any = await rerunRun(f.store, f.runId, [control.id], f.terms);
      assert.ok(child.disclosure);
      rmSync(join(f.path, 'src'), { recursive: true, force: true });
      assert.equal(
        (await executeRun(f.store, child.disclosure.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir })).state,
        'completed',
      );
      const selected = await fullReport(req(f, child.disclosure.runId));
      assert.equal(selected.withheldForSecrets, secret);
      if (secret) withheld(selected);
      const minimal = await scannerReportOf(f.store, child.disclosure.runId, req(f).now, { trustDir: f.ws.trustDir });
      assert.deepEqual(minimal.inspections, selected.document.inspections);
      absent(JSON.stringify(minimal), 'minimal inspection', GENERIC_VALUE);
      if (secret) {
        mkdirSync(join(f.path, 'src'));
        for (const [path, text] of Object.entries(files(false))) writeFileSync(join(f.path, path), text);
        const clean = (await planWorkspaceCanonical(f.store, f.terms)).disclosure.runId;
        assert.equal(
          (await executeRun(f.store, clean, { scratchRoot: f.work, trustDir: f.ws.trustDir })).state,
          'completed',
        );
        assert.equal((await fullReport(req(f, clean))).withheldForSecrets, false);
        withheld(await fullReport({ ...req(f, clean), baselineRunId: f.runId }));
      }
    },
  );
for (const secret of [true, false])
  test(
    `inspection child authenticates ${secret ? 'secret' : 'clean'} accepted results of a genuinely canceled ancestor`,
    nativeSecrets,
    async (t) => {
      const f = await frameworkFixture(t, files(secret), { secrets: true, run: false });
      const registry = publicRegistry(f.ws.trustDir);
      const secretUnit = f.admitted.plan.units.find((u) => u.adapterId === 'secrets-gitleaks');
      let canceled = false;
      const coordinator = await Coordinator.open({
        ...(await scannerExecution(f.store, f.runId, f.ws.trustDir, f.work, registry)),
        store: f.store,
        runId: f.runId,
        registry,
        scratchRoot: f.work,
        hooks: {
          at(boundary, ctx) {
            if (boundary === 'after-publish' && ctx.work.id === secretUnit.id) {
              canceled = true;
              coordinator.cancel();
            }
          },
        },
      });
      assert.equal((await coordinator.run()).state, 'canceled');
      assert.equal(canceled, true);
      assert.ok(f.store.ledger.getPublication(secretUnit));
      const control = f.admitted.plan.units.find((u) => u.adapterId === 'framework-controls');
      const child: any = await rerunRun(f.store, f.runId, [control.id], f.terms);
      assert.ok(child.disclosure, JSON.stringify(child));
      assert.equal(
        (await executeRun(f.store, child.disclosure.runId, { scratchRoot: f.work, trustDir: f.ws.trustDir })).state,
        'completed',
      );
      const selected = await fullReport(req(f, child.disclosure.runId));
      assert.equal(selected.withheldForSecrets, secret);
      if (secret) withheld(selected);
      else assert.ok(selected.json.includes('4.21.2'));
      const minimal = await scannerReportOf(f.store, child.disclosure.runId, req(f).now, { trustDir: f.ws.trustDir });
      assert.deepEqual(minimal.inspections, selected.document.inspections);
      absent(JSON.stringify(minimal), 'canceled ancestor minimal inspection', GENERIC_VALUE);
    },
  );
