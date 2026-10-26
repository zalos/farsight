// The trusted check-driver seam: a driver bound to an adapter by id and implementation digest prepares the exact job
// and auxiliary inputs for an admitted unit (with its rules' pinned pack bytes), and normalizes the verified result
// into the coverage view and records of the same publication. The coordinator alone runs the attempt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Coordinator } from '../dist/execution/coordinator.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { bindingId } from '../dist/execution/plan.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { syntheticPlan, syntheticRegistry, UNITS } from './coordinator-helpers.ts';

const roots: string[] = [];
after(() => roots.forEach(removeScratch));
const ALL = Object.fromEntries(UNITS.map((u) => [u, 'covering-ok']));
const refused = (re: RegExp) => (e: any) =>
  e?.code === 'sentinel.execution.adapterInvalid' && re.test(e.detail?.reason ?? '');

function driver(registry: any, over: Record<string, unknown> = {}, rules: any[] = []) {
  const seen: any[] = [];
  const d = {
    adapterId: 'test-covering-ok',
    implementationDigest: registry.get('test-covering-ok').digest,
    supportedRules: () =>
      rules.map((r: any) => ({ familyId: r.familyId, revision: r.revision, definitionDigest: r.definitionDigest })),
    async prepare(ctx: any) {
      seen.push(ctx);
      assert.equal(ctx.analysis, null, 'a driver without an explicit read declaration receives no retained evidence');
      const config = join(ctx.workDir, 'rules.yml');
      writeFileSync(
        config,
        ctx.rules.flatMap((r: any) => r.files.map((f: any) => `${r.rule.familyId} ${f.path} ${f.digest}`)).join('\n'),
      );
      return {
        job: {
          checks: ctx.checks.map((c: any) => c.id),
          inputs: ctx.inputs.map((i: any) => i.id),
          rules: ctx.rules.map((r: any) => r.rule.familyId),
        },
        auxiliary: [{ path: config, role: 'rule' }],
      };
    },
    async normalize(ctx: any, verified: any) {
      // The attempt's sealed copies are the bytes each input names; the job prepare returned comes back.
      for (const i of ctx.inputs)
        assert.equal(`sha256:${createHash('sha256').update(verified.sealed(i.id)!).digest('hex')}`, i.id);
      assert.ok(verified.job && Array.isArray(verified.job.checks));
      return {
        coverage: {
          coveredChecks: verified.result.coveredChecks,
          scannedSet: verified.result.scannedSet,
          skipped: [],
          unresolvedFrontiers: [],
          granularity: 'per-file-per-rule',
        },
        records: [
          {
            value: {
              schema: 'sentinel-test-observations/draft-1',
              unit: ctx.unit.id,
              artifacts: verified.outputs.map((o: any) => o.id),
            },
            schema: 'sentinel-test-observations/draft-1',
          },
        ],
      };
    },
    ...over,
  };
  return { d, seen };
}

test('a driver binds to its adapter by id and implementation digest; anything else is refused', async () => {
  const s = scratch('drivers-bind');
  roots.push(s.root);
  const registry = syntheticRegistry(s.root, ['covering-ok']);
  const { d } = driver(registry);
  assert.ok(createCheckDriverRegistry([d as any], registry).driverFor('test-covering-ok'));
  assert.throws(
    () => createCheckDriverRegistry([{ ...d, implementationDigest: `sha256:${'0'.repeat(64)}` } as any], registry),
    refused(/another implementation digest/),
  );
  assert.throws(
    () => createCheckDriverRegistry([{ ...d, adapterId: 'test-absent' } as any], registry),
    refused(/not registered/),
  );
  assert.throws(() => createCheckDriverRegistry([d as any, d as any], registry), refused(/two drivers/));
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, ALL, { registry });
    await assert.rejects(
      Coordinator.open({
        store,
        runId: p.runId,
        run: p.run,
        registry,
        scratchRoot: s.work,
        drivers: { ids: [], driverFor: () => d } as any,
      }),
      refused(/createCheckDriverRegistry/),
    );
  } finally {
    store.close();
  }
});

test('the driver prepares the exact job with pinned rule bytes; job and auxiliary inputs are recorded apart from the source inputs; normalize governs coverage', async () => {
  const s = scratch('drivers-run');
  roots.push(s.root);
  const registry = syntheticRegistry(s.root, ['covering-ok']);
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, ALL, { registry });
    const { d, seen } = driver(registry, {}, p.plan.pins.rules);
    const drivers = createCheckDriverRegistry([d as any], registry);
    const c = await Coordinator.open({
      store,
      runId: p.runId,
      run: p.run,
      registry,
      scratchRoot: s.work,
      drivers,
      packs: [{ pack: p.pack, files: p.packFiles }],
    });
    const summary = await c.run();
    assert.equal(summary.outcome, 'complete-coverage', JSON.stringify(summary.failures));
    assert.equal(seen.length, 4, 'prepare ran once per unit');
    const ctx = seen.find((x) => x.unit.id === p.ids.A);
    assert.equal(ctx.rules.length, 1);
    assert.ok(
      ctx.rules[0].files.every((f: any) => f.bytes.length > 0 && /^sha256:/.test(f.digest)),
      'rule files with their pinned bytes',
    );
    // The binding keeps the plan's exact source inputs apart from the job and auxiliary inputs.
    const unit = p.plan.units.find((u: any) => u.id === p.ids.A);
    const [a] = store.ledger.listAttempts({ id: p.ids.A, revision: 1 });
    const invocation = JSON.parse(
      (await store.readArtifact(store.ledger.getAttempt(a.id).envelope.invocation)).toString('utf8'),
    );
    const report = await store.inspect();
    const bindings = await Promise.all(
      report.reachable.map(async (id: string) => {
        try {
          return JSON.parse((await store.readArtifact(id)).toString('utf8'));
        } catch {
          return null;
        }
      }),
    );
    const binding = bindings.find((b) => b?.schema === 'sentinel-execution-binding/draft-1' && b.work.id === p.ids.A)!;
    assert.deepEqual(binding.sourceInputs, unit.inputs.map((i: any) => i.content).sort());
    assert.equal(binding.derived.auxiliary.length, 1);
    assert.equal(binding.derived.auxiliary[0].role, 'rule');
    assert.deepEqual(
      binding.inputs,
      [...binding.sourceInputs, binding.derived.job, binding.derived.auxiliary[0].id].sort(),
    );
    assert.deepEqual(invocation.inputs, binding.inputs, 'the worker read exactly the bound inputs');
    const job = JSON.parse((await store.readArtifact(binding.derived.job)).toString('utf8'));
    assert.deepEqual(job.rules, [ctx.rules[0].rule.familyId]);
    assert.ok(report.reachable.includes(binding.derived.auxiliary[0].id), 'the auxiliary input is a retained record');
    assert.ok(report.reachable.includes(bindingId(binding)));
    // The driver's records are in the same publication; its prepared folders are gone.
    assert.ok(
      store.ledger
        .getPublication({ id: p.ids.A, revision: 1 })
        .outputs.some((o: any) => o.schema === 'sentinel-test-observations/draft-1'),
    );
    assert.deepEqual(
      readdirSync(s.work).filter((n) => n.startsWith('prep.')),
      [],
    );
  } finally {
    store.close();
  }
});

test('normalize decides the coverage view: an engine that establishes only aggregate coverage cannot complete per-file checks', async () => {
  const s = scratch('drivers-coarse');
  roots.push(s.root);
  const registry = syntheticRegistry(s.root, ['covering-ok']);
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, ALL, { registry });
    const { d } = driver(
      registry,
      {
        async normalize(_ctx: any, v: any) {
          return {
            coverage: {
              coveredChecks: v.result.coveredChecks,
              scannedSet: v.result.scannedSet,
              skipped: [],
              unresolvedFrontiers: [],
              granularity: 'aggregate',
            },
            records: [],
          };
        },
      },
      p.plan.pins.rules,
    );
    const summary = await (
      await Coordinator.open({
        store,
        runId: p.runId,
        run: p.run,
        registry,
        scratchRoot: s.work,
        drivers: createCheckDriverRegistry([d as any], registry),
      })
    ).run();
    assert.equal(summary.outcome, 'partial-coverage');
    assert.ok(summary.coverage!.checks.every((c: any) => c.reasonCode === 'sentinel.plan.coverageTooCoarse'));
  } finally {
    store.close();
  }
});

test('pack bytes other than the lock pins, or a failing prepare, start no worker', async () => {
  const s = scratch('drivers-refuse');
  roots.push(s.root);
  const registry = syntheticRegistry(s.root, ['covering-ok']);
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, ALL, { registry });
    const tampered = new Map(p.packFiles);
    for (const k of tampered.keys()) if (k.startsWith('detectors/')) tampered.set(k, Buffer.from('changed\n'));
    const { d } = driver(registry, {}, p.plan.pins.rules);
    const summary = await (
      await Coordinator.open({
        store,
        runId: p.runId,
        run: p.run,
        registry,
        scratchRoot: s.work,
        drivers: createCheckDriverRegistry([d as any], registry),
        packs: [{ pack: p.pack, files: tampered }],
      })
    ).run();
    assert.equal(summary.published, 0);
    assert.ok(
      summary.failures.some((f: any) => f.code === 'sentinel.execution.inputMismatch' && f.attemptId === null),
      JSON.stringify(summary.failures),
    );
    assert.deepEqual(store.ledger.listAttempts({ id: p.ids.A, revision: 1 }), [], 'no attempt: nothing ran');
  } finally {
    store.close();
  }
  const s2 = scratch('drivers-prepare-fails');
  roots.push(s2.root);
  const registry2 = syntheticRegistry(s2.root, ['covering-ok']);
  const store2 = await storeIn(s2.root);
  try {
    const p2 = await syntheticPlan(store2, s2.root, ALL, { registry: registry2 });
    const { d } = driver(
      registry2,
      {
        async prepare() {
          throw Object.assign(new Error('unsupported rule'), { code: 'sentinel.execution.adapterInvalid' });
        },
      },
      p2.plan.pins.rules,
    );
    const summary = await (
      await Coordinator.open({
        store: store2,
        runId: p2.runId,
        run: p2.run,
        registry: registry2,
        scratchRoot: s2.work,
        drivers: createCheckDriverRegistry([d as any], registry2),
      })
    ).run();
    assert.equal(summary.published, 0);
    assert.deepEqual(
      store2.ledger.listAttempts({ id: p2.ids.A, revision: 1 }),
      [],
      'a driver that cannot prepare starts nothing',
    );
    assert.deepEqual(
      readdirSync(s2.work).filter((n) => n.startsWith('prep.')),
      [],
      'its prepared folder is removed',
    );
  } finally {
    store2.close();
  }
});

test('with drivers, every check unit needs one, over rules it runs at their pinned definition: otherwise nothing opens', async () => {
  const s = scratch('drivers-rules');
  roots.push(s.root);
  const registry = syntheticRegistry(s.root, ['covering-ok', 'ok']);
  const store = await storeIn(s.root);
  try {
    const p = await syntheticPlan(store, s.root, ALL, { registry });
    const open = (d: any) =>
      Coordinator.open({
        store,
        runId: p.runId,
        run: p.run,
        registry,
        scratchRoot: s.work,
        drivers: createCheckDriverRegistry([d], registry),
      });
    const planInvalid = (re: RegExp) => (e: any) =>
      e?.code === 'sentinel.execution.planInvalid' && re.test(e.detail?.reason ?? '');
    await assert.rejects(open(driver(registry).d), planInvalid(/does not run rule/), 'a driver that supports no rule');
    const wrong = p.plan.pins.rules.map((r: any) => ({ ...r, definitionDigest: `sha256:${'1'.repeat(64)}` }));
    await assert.rejects(
      open(driver(registry, {}, wrong).d),
      planInvalid(/does not run rule/),
      'the same family at another definition',
    );
    const other = {
      ...driver(registry, {}, p.plan.pins.rules).d,
      adapterId: 'test-ok',
      implementationDigest: registry.get('test-ok').digest,
    };
    await assert.rejects(open(other), planInvalid(/has no trusted driver/), 'a check adapter with no driver');
    assert.ok(await open(driver(registry, {}, p.plan.pins.rules).d));
  } finally {
    store.close();
  }
});
