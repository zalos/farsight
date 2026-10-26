// The additional production-driver boundary facts are trusted coordinator facts, with the original expected input
// binding kept distinct from the normalized actual reads. Malformed overrides cannot earn a publication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chmodSync, writeFileSync } from 'node:fs';
import { Coordinator } from '../dist/execution/coordinator.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { syntheticPlan, UNITS } from './coordinator-helpers.ts';
import { scratch, storeIn, removeScratch } from './execution-helpers.ts';
const ALL = Object.fromEntries(UNITS.map((u) => [u, 'covering-ok']));
for (const mode of ['foreign-read', 'unread-scan', 'changed-sealed-source', 'changed-output', 'limited-read'] as const)
  test(`normalized driver boundary: ${mode}`, async (t) => {
    const s = scratch('drivers-boundary');
    t.after(() => removeScratch(s.root));
    const store = await storeIn(s.root);
    t.after(() => store.close());
    const p = await syntheticPlan(store, s.root, ALL);
    let observed = false;
    const driver = {
      adapterId: 'test-covering-ok',
      implementationDigest: p.registry.get('test-covering-ok').digest,
      supportedRules: () => p.plan.pins.rules,
      async prepare(ctx: any) {
        return { job: { unit: ctx.unit.id }, auxiliary: [] };
      },
      async normalize(ctx: any, v: any) {
        assert.ok(Object.isFrozen(v.outcome));
        assert.ok(Object.isFrozen(v.outcome.invocation));
        assert.equal(v.outcome.result, v.result);
        assert.equal(v.outcome.outputs, v.outputs);
        observed = true;
        const actual = ctx.unit.scopes;
        if (mode === 'changed-output') {
          const output = v.outputs[0];
          assert.ok(output);
          chmodSync(output.path, 0o600);
          writeFileSync(output.path, 'changed output');
          v.output(output.id);
        }
        if (mode === 'changed-sealed-source') {
          const input = ctx.unit.inputs[0].content;
          const path = join(v.workDir, 'input', input.slice(7));
          chmodSync(path, 0o600);
          writeFileSync(path, 'changed sealed bytes');
        }
        return {
          coverage: {
            coveredChecks: v.result.coveredChecks,
            scannedSet: mode === 'foreign-read' ? [] : ctx.unit.scopes,
            actualReadSet: mode === 'foreign-read' ? ['foreign:unassigned'] : mode === 'unread-scan' ? [] : actual,
            skipped:
              mode === 'limited-read'
                ? ctx.unit.scopes.map((scopeId: string) => ({ scopeId, reasonCode: 'sentinel.drivers.notReported' }))
                : [],
            unresolvedFrontiers: [],
            granularity: 'per-file-per-rule',
          },
          records: [
            {
              schema: 'sentinel-test-derived-record/draft-1',
              value: { sourceDerived: true, unit: ctx.unit.id },
              privacy: 'source-derived' as const,
            },
          ],
        };
      },
    };
    const result = await (
      await Coordinator.open({
        store,
        runId: p.runId,
        run: p.run,
        registry: p.registry,
        scratchRoot: s.work,
        drivers: createCheckDriverRegistry([driver as any], p.registry),
        retry: { maxAttempts: 1 },
      })
    ).run();
    assert.ok(observed);
    if (mode === 'limited-read') {
      assert.equal(result.outcome, 'partial-coverage');
      assert.ok(result.coverage!.checks.every((c: any) => c.status !== 'complete'));
      const pub = store.ledger.getPublication({ id: p.ids.A, revision: 1 })!;
      const record = pub.outputs.find((o: any) => o.schema === 'sentinel-test-derived-record/draft-1')!;
      assert.equal(record.privacy, 'source-derived');
    } else {
      assert.equal(result.published, 0);
      assert.equal(result.outcome, 'execution-failure');
      assert.ok(
        result.failures.some(
          (f: any) =>
            f.code ===
            (mode === 'changed-sealed-source'
              ? 'sentinel.execution.inputMismatch'
              : mode === 'changed-output'
                ? 'sentinel.execution.outputMismatch'
                : 'sentinel.execution.resultMismatch'),
        ),
      );
    }
  });
