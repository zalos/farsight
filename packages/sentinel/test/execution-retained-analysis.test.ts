import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { Coordinator } from '../dist/execution/coordinator.js';
import { ANALYSIS_ROLES, createCheckDriverRegistry, retainedAuxiliary } from '../dist/execution/check-drivers.js';
import { retainedBytesOf, retainedAnalysisFor } from '../dist/execution/retained-analysis.js';
import { executablePlan } from '../dist/execution/plan.js';
import { planAnalysis, plannerAnalysisFrom, plannerSnapshotFrom } from '../dist/planner/index.js';
import { loadBootstrap } from '../dist/execution/bootstrap.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { needsStore } from './snapshot-helpers.ts';
import { retainedFixture } from './retained-analysis-helpers.ts';
const hash = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
function driver(s: any, auxiliary?: (a: any[], ctx: any) => any[]) {
  const seen: any[] = [];
  const d = {
    adapterId: 'sentinel-pattern',
    implementationDigest: s.registry.get('sentinel-pattern').digest,
    reads: { analysis: true as const },
    supportedRules: () =>
      s.analysis.pins.rules.map((r: any) => ({
        familyId: r.familyId,
        revision: r.revision,
        definitionDigest: r.definitionDigest,
      })),
    async prepare(ctx: any) {
      seen.push(ctx);
      assert.ok(Object.isFrozen(ctx));
      assert.ok(Object.isFrozen(ctx.analysis));
      const a = ctx.analysis;
      assert.equal(a.sourceId, ctx.unit.sourceId);
      assert.equal(a.snapshotId, ctx.plan.pins.snapshotId);
      assert.ok(a.entries.every((e: any) => e.sourceId === a.sourceId));
      const bytes = retainedBytesOf(a);
      const aux = [...retainedAuxiliary(ctx)];
      for (const item of aux) {
        assert.deepEqual(readFileSync(item.path), bytes[item.role as keyof typeof bytes]);
      }
      for (const fake of [{ ...a }, JSON.parse(JSON.stringify(a)), Object.create(a), new Proxy(a, {})])
        assert.throws(
          () => retainedBytesOf(fake),
          (e: any) => e.code === 'sentinel.execution.analysisUnavailable',
        );
      const mutable = retainedBytesOf(a);
      mutable['analysis-result'].fill(0);
      assert.notEqual(hash(mutable['analysis-result']), a.result.id);
      assert.equal(hash(retainedBytesOf(a)['analysis-result']), a.result.id);
      return {
        job: { checks: ctx.unit.checks, snapshot: a.snapshotId },
        auxiliary: auxiliary ? auxiliary(aux, ctx) : aux,
      };
    },
    async normalize(ctx: any, v: any) {
      for (const item of retainedAuxiliaryIds(ctx.analysis)) assert.equal(hash(v.sealed(item)), item);
      const read = JSON.parse(Buffer.from(v.output(v.outputs[0].id)).toString()).read;
      for (const input of ctx.inputs)
        assert.ok(read.some((r: any) => r.id === input.id && `sha256:${r.sha256}` === input.id));
      const incomplete = !ctx.analysis.result.value.parserComplete;
      return {
        coverage: {
          coveredChecks: v.result.coveredChecks,
          scannedSet: incomplete ? [] : v.result.scannedSet,
          actualReadSet: [...ctx.unit.scopes],
          skipped: [],
          unresolvedFrontiers: incomplete
            ? [{ scopeId: ctx.unit.sourceId, reasonCode: 'sentinel.coverage.unsupported' }]
            : [],
          granularity: 'per-file-per-rule' as const,
        },
        records: [],
      };
    },
  };
  return { drivers: createCheckDriverRegistry([d], s.registry), seen };
}
const retainedAuxiliaryIds = (a: any) => [a.result.id, a.index.id, a.artifact.id, a.manifest];
test(
  'actual coordinator passes original retained bytes, all repository inputs and atomically binds provenance',
  needsStore,
  async (t) => {
    const s = await retainedFixture(t),
      d = driver(s);
    const result = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(result.state, 'completed', JSON.stringify(result.failures));
    assert.equal(result.published, s.analysis.units.length, JSON.stringify(result.failures));
    assert.ok(d.seen.length);
    const ctx = d.seen[0];
    assert.equal(ctx.unit.inputs.length, 3, 'configuration and every captured source stay in the original unit inputs');
    const attempts = s.store.ledger.listAttempts(ctx.unit);
    assert.equal(attempts.length, 1);
    const report = await s.store.inspect();
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    const records = await Promise.all(
      report.reachable.map(async (id: string) => {
        try {
          return JSON.parse((await s.store.readArtifact(id)).toString());
        } catch {
          return null;
        }
      }),
    );
    const binding = records.find(
      (r) => r?.schema === 'sentinel-execution-binding/draft-1' && r.work.id === ctx.unit.id,
    );
    assert.deepEqual(binding.derived.analysis, {
      inventory: ctx.analysis.inventory,
      result: ctx.analysis.result.id,
      index: ctx.analysis.index.id,
      artifact: ctx.analysis.artifact.id,
      manifest: ctx.analysis.manifest,
    });
    assert.deepEqual(binding.derived.auxiliary.map((a: any) => a.role).sort(), [...ANALYSIS_ROLES].sort());
    assert.deepEqual(binding.sourceInputs, [...ctx.inputs.map((i: any) => i.id)].sort());
  },
);

const faults: Array<[string, (value: any, snapshot: any) => void]> = [
  [
    'inventory run',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.runId = 'another-run';
    },
  ],
  [
    'inventory snapshot',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.snapshotId = 'another-snapshot';
    },
  ],
  [
    'inventory digest',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.inventoryDigest = `sha256:${'0'.repeat(64)}`;
    },
  ],
  [
    'inventory manifest',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.manifest = v.analyses[0].result;
    },
  ],
  [
    'missing source analysis',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.analyses = [];
    },
  ],
  [
    'duplicate source analysis',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.analyses.push({ ...v.analyses[0] });
    },
  ],
  [
    'source fingerprint',
    (v) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.analyses[0].analysisFingerprint = 'other-fingerprint';
    },
  ],
  [
    'foreign parser result publication',
    (v, s) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.analyses[0].result = s.manifest;
    },
  ],
  [
    'result index cross-id',
    (v, s) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.analyses[0].index = s.manifest;
    },
  ],
  [
    'result artifact cross-id',
    (v, s) => {
      if (v.schema === 'sentinel-bootstrap-inventory/draft-1') v.analyses[0].artifact = s.manifest;
    },
  ],
  [
    'result selection',
    (v) => {
      if (v.schema === 'sentinel-parser-result/draft-1')
        v.selection = { ...v.selection, gitignore: !v.selection.gitignore };
    },
  ],
  [
    'result limits',
    (v) => {
      if (v.schema === 'sentinel-parser-result/draft-1') v.limits = { ...v.limits, maxFiles: v.limits.maxFiles + 1 };
    },
  ],
  [
    'index source',
    (v) => {
      if (v.schema === 'sentinel-parser-index/draft-1') v.sourceId = 'other-source';
    },
  ],
  [
    'index snapshot',
    (v) => {
      if (v.schema === 'sentinel-parser-index/draft-1') v.snapshotId = 'other-snapshot';
    },
  ],
  [
    'index fingerprint',
    (v) => {
      if (v.schema === 'sentinel-parser-index/draft-1') v.analysisFingerprint = 'other-fingerprint';
    },
  ],
  [
    'artifact source',
    (v) => {
      if (v.format === 'farsight-analysis') v.graph.repo = 'other-source';
    },
  ],
  [
    'artifact fingerprint',
    (v) => {
      if (v.format === 'farsight-analysis') v.analysis.fingerprint = 'other-fingerprint';
    },
  ],
  [
    'artifact format',
    (v) => {
      if (v.format === 'farsight-analysis') v.format = 'unrelated-document';
    },
  ],
];
for (const [name, fault] of faults)
  test(`genuinely published hostile ${name} never launches a check`, needsStore, async (t) => {
    const s = await retainedFixture(t, { fault }),
      d = driver(s);
    assert.ok(
      s.store.ledger.getPublication(s.inventory),
      'the actual coordinator accepted the faulty bootstrap observation',
    );
    const summary = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(summary.published, 0, JSON.stringify(summary.failures));
    assert.ok(
      summary.failures.some((f) => f.code === 'sentinel.execution.analysisUnavailable' && f.attemptId === null),
      JSON.stringify(summary.failures),
    );
    assert.equal(d.seen.length, 0, 'the driver never receives unverified evidence');
    for (const unit of s.analysis.units) assert.equal(s.store.ledger.listAttempts(unit).length, 0);
  });
for (const kind of ['duplicate', 'foreign-schema'] as const)
  test(`actual inventory publication ${kind} refuses before launch`, needsStore, async (t) => {
    const s = await retainedFixture(t, {
        items(items) {
          const i = items.find((i) => i.schema === 'sentinel-bootstrap-inventory/draft-1');
          if (!i) return;
          if (kind === 'duplicate') items.push({ ...i, value: { ...i.value, runId: 'another-run' } });
          else i.schema = 'sentinel-unrelated-record/draft-1';
        },
      }),
      d = driver(s);
    const summary = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(summary.published, 0);
    assert.ok(
      summary.failures.some((f) => f.code === 'sentinel.execution.analysisUnavailable' && f.attemptId === null),
    );
  });
for (const bootstrap of ['none', 'parse', 'two'] as const)
  test(`canonical plan with ${bootstrap} bootstrap dependency is not analysis authority`, needsStore, async (t) => {
    if (bootstrap === 'none') {
      await assert.rejects(retainedFixture(t, { bootstrap }), (e: any) => e.code === 'sentinel.plan.invalidInput');
      return;
    }
    const s = await retainedFixture(t, { bootstrap }),
      d = driver(s);
    const summary = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(summary.published, 0);
    assert.ok(
      summary.failures.some((f) => f.code === 'sentinel.execution.analysisUnavailable' && f.attemptId === null),
      JSON.stringify(summary.failures),
    );
    assert.equal(d.seen.length, 0);
  });
for (const role of ['missing', 'duplicate', 'substituted', 'toString', 'constructor', '__proto__'])
  test(`retained auxiliary ${role} refuses before the attempt`, needsStore, async (t) => {
    const s = await retainedFixture(t),
      d = driver(s, (aux) => {
        if (role === 'missing') return aux.slice(1);
        if (role === 'duplicate') return [...aux, aux[0]];
        if (role === 'substituted') return [{ ...aux[0], path: aux[1].path }, ...aux.slice(1)];
        return [...aux, { path: aux[2].path, role }];
      });
    const summary = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(summary.published, 0);
    assert.ok(
      summary.failures.some((f) => f.code === 'sentinel.execution.inputMismatch' && f.attemptId === null),
      JSON.stringify(summary.failures),
    );
    for (const unit of s.analysis.units) assert.equal(s.store.ledger.listAttempts(unit).length, 0);
  });
test('file-scoped units cannot acquire whole-source parser evidence', needsStore, async (t) => {
  const s = await retainedFixture(t, { scope: 'source-file' }),
    d = driver(s);
  const summary = await (
    await Coordinator.open({
      store: s.store,
      runId: s.run.id,
      registry: s.registry,
      scratchRoot: s.work,
      drivers: d.drivers,
    })
  ).run();
  assert.equal(summary.published, 0);
  assert.equal(d.seen.length, 0);
  assert.ok(summary.failures.every((f) => f.code === 'sentinel.execution.analysisUnavailable' && f.attemptId === null));
});
test(
  'read declarations are validated and copied deeply, while plan/evidence forgeries grant nothing',
  needsStore,
  async (t) => {
    const s = await retainedFixture(t),
      reads: any = { analysis: true };
    const base: any = {
      adapterId: 'sentinel-pattern',
      implementationDigest: s.registry.get('sentinel-pattern').digest,
      supportedRules: () => [],
      prepare: async () => ({ job: {}, auxiliary: [] }),
      normalize: async () => ({ coverage: {}, records: [] }),
    };
    for (const invalid of [
      null,
      [],
      { analysis: false },
      { analysis: 1 },
      { files: true },
      { analysis: true, extra: true },
      Object.create({ analysis: true }),
      { [Symbol('hidden')]: true },
      {
        get analysis() {
          return true;
        },
      },
    ])
      assert.throws(
        () => createCheckDriverRegistry([{ ...base, reads: invalid }], s.registry),
        (e: any) => e.code === 'sentinel.execution.adapterInvalid',
      );
    const registry = createCheckDriverRegistry([{ ...base, reads }], s.registry);
    reads.analysis = false;
    assert.deepEqual(registry.driverFor(base.adapterId)!.reads, { analysis: true });
    assert.ok(Object.isFrozen(registry.driverFor(base.adapterId)!.reads));
    const admitted = await loadPlan(s.store, s.run.id, 2),
      current = s.store.ledger.getRun(s.run.id)!;
    const plan = await executablePlan(s.store, admitted, current.envelope, 2, s.registry, s.work),
      unit = plan.unitOf(s.analysis.units[0]!).unit;
    await assert.rejects(
      executablePlan({ ...s.store } as any, admitted, current.envelope, 2, s.registry, s.work),
      /not a store opened/,
    );
    await assert.rejects(
      retainedAnalysisFor({ ...s.store } as any, plan, unit, s.record, new AbortController().signal),
      (e: any) => e.code === 'sentinel.execution.analysisUnavailable',
    );
    for (const fake of [{ ...plan }, Object.create(plan), new Proxy(plan, {})])
      await assert.rejects(
        retainedAnalysisFor(s.store, fake as any, unit, s.record, new AbortController().signal),
        (e: any) => e.code === 'sentinel.execution.analysisUnavailable',
      );
    await assert.rejects(
      retainedAnalysisFor(s.store, plan, { ...unit }, s.record, new AbortController().signal),
      (e: any) => e.code === 'sentinel.execution.analysisUnavailable',
    );
    const other = { id: 'unproved-work', revision: 1 };
    (plan.external as Set<string>).add('unproved-work@1');
    assert.equal(plan.reusedProven(other), false, 'the public compatibility set cannot alter the proven reuse closure');
    await assert.rejects(
      retainedAnalysisFor(
        s.store,
        plan,
        unit,
        {
          ...s.record,
          parse: {
            ...s.record.parse,
            selection: { ...s.record.parse.selection, gitignore: !s.record.parse.selection.gitignore },
          },
        },
        new AbortController().signal,
      ),
      (e: any) => e.code === 'sentinel.execution.analysisUnavailable',
    );
  },
);

test(
  'a genuine selected child consumes its proven parent bootstrap after all original source is gone',
  needsStore,
  async (t) => {
    const s = await retainedFixture(t, { otherSource: true }),
      parent = driver(s);
    assert.equal(existsSync(s.repo), false);
    assert.equal(existsSync(s.otherRepo), false);
    const first = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: parent.drivers,
      })
    ).run();
    assert.equal(first.published, s.analysis.units.length, JSON.stringify(first.failures));
    const evidence = await loadBootstrap(s.store, s.run.id, s.inventory);
    const child = planAnalysis({
      runId: 'run-retained-child',
      revision: 1,
      previous: null,
      bootstrap: [s.inventory],
      profile: s.profile,
      snapshot: plannerSnapshotFrom(evidence.snapshot),
      analyses: evidence.analyses.map((a) => plannerAnalysisFrom(a as any)),
      lock: s.rules.view,
      policy: s.view,
    });
    const selection: any = {
      schema: 'sentinel-rerun-selection/draft-1',
      parent: {
        runId: s.run.id,
        revision: s.analysis.revision,
        planDigest: s.analysis.digest,
        snapshotId: s.snapshot.id,
      },
      selected: [{ parentUnit: s.analysis.units[0]!.id, unit: child.units[0]!.id }],
      downstream: [],
      held: child.units.slice(1).map((u) => ({ unit: u.id, parentUnit: null })),
      reused: child.reused,
    };
    await admitPlan(s.store, { plan: child, ruleLock: s.rules.lock, policy: s.policy, profile: s.record, selection });
    const d = driver({ ...s, analysis: child });
    const done = await (
      await Coordinator.open({
        store: s.store,
        runId: child.runId,
        run: { ...s.run, id: child.runId, parentId: s.run.id, planRevision: 1 },
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(done.published, 1, JSON.stringify(done.failures));
    assert.equal(d.seen.length, 1);
    assert.equal(child.units.length, 2, 'a strict subset of the two-source plan');
    assert.equal(selection.held.length, 1);
    const ctx = d.seen[0];
    assert.ok(ctx.analysis.entries.every((e: any) => e.sourceId === ctx.unit.sourceId));
    assert.ok(ctx.unit.inputs.every((i: any) => i.sourceId === ctx.unit.sourceId));
    assert.deepEqual(d.seen[0].analysis.inventory, { id: s.inventory.id, revision: s.inventory.revision });
    assert.equal(s.store.ledger.listAttempts(s.inventory).length, 1, 'the inventory was not parsed or published again');
  },
);
test(
  'incomplete parse is retained as unknown evidence rather than refused or upgraded to coverage',
  needsStore,
  async (t) => {
    const s = await retainedFixture(t, { incomplete: true }),
      d = driver(s);
    const summary = await (
      await Coordinator.open({
        store: s.store,
        runId: s.run.id,
        registry: s.registry,
        scratchRoot: s.work,
        drivers: d.drivers,
      })
    ).run();
    assert.equal(summary.published, s.analysis.units.length, JSON.stringify(summary.failures));
    assert.ok(d.seen.every((ctx) => ctx.analysis.result.value.parserComplete === false));
    assert.equal(summary.outcome, 'partial-coverage');
    assert.ok(summary.coverage!.checks.every((c) => c.status !== 'complete'));
  },
);
test('the four retained roles may accompany a distinct ordinary auxiliary input', needsStore, async (t) => {
  const s = await retainedFixture(t),
    d = driver(s, (aux, ctx) => {
      const path = ctx.workDir + '/ordinary-config.json';
      writeFileSync(path, '{"enabled":true}');
      return [...aux, { path, role: 'config' }];
    });
  const summary = await (
    await Coordinator.open({
      store: s.store,
      runId: s.run.id,
      registry: s.registry,
      scratchRoot: s.work,
      drivers: d.drivers,
    })
  ).run();
  assert.equal(summary.published, s.analysis.units.length, JSON.stringify(summary.failures));
});
