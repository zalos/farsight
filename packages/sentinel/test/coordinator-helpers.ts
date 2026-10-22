// A synthetic plan for the coordinator tests: canonical run and work envelopes (the shape PR 06 will hand over)
// forming a diamond A → {B, C} → D, executed by built-in fake scanners from the hostile-worker fixture.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { builtInRegistry, inputs } from './execution-helpers.ts';
import { influenceManifest } from '../dist/execution/plan.js';
import { inputFingerprintOf } from '../dist/execution/supervisor.js';

const digest = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

export function syntheticPlan(root: string, behaviours: Record<string, string> = {}, options: { runId?: string; limits?: Record<string, number>; argument?: string; resources?: Record<string, Record<string, number>>; held?: Record<string, string>; registry?: any; adapterPrefix?: string; required?: (unit: string) => { checks: string[]; scope: string[] } | undefined } = {}) {
  const runId = options.runId ?? 'run-e4';
  const units = ['A', 'B', 'C', 'D'];
  const deps: Record<string, string[]> = { A: [], B: ['A'], C: ['A'], D: ['B', 'C'] };
  const behaviourOf = (u: string) => behaviours[u] ?? 'ok';
  const registry = options.registry ?? builtInRegistry(join(root, 'adapters'), [...new Set(units.map(behaviourOf))], options.limits ?? {}, options.argument);
  const prefix = options.adapterPrefix ?? 'test';
  const captured = inputs(root);
  const ids = captured.map(c => c.id);
  const run = {
    schema: 'sentinel-run/draft-1', id: runId, parentId: null, baselineId: null, snapshotId: 'snap-synthetic', planRevision: 1,
    coordinatorEpoch: 'epoch-planning', ruleLockDigest: digest('rules'), toolLockDigest: digest('tools'), policyRevisionDigest: digest('policy'),
    requestedScope: { sourceIds: ['synthetic'], profile: 'static' }, budgets: { maxTokens: null, maxCost: null, deadlineMs: 600_000 },
    createdAt: '2026-10-22T00:00:00Z', state: 'planned',
  };
  const works = units.map(u => {
    // Bound exactly as the coordinator checks: the adapter's digest, the actual inputs, the influence manifest.
    const adapter = registry.get(`${prefix}-${behaviourOf(u)}`);
    const w = {
      schema: 'sentinel-work/draft-1', id: `work-${u}`, revision: 1, runId, planRevision: 1,
      stage: { contract: 'sentinel.stage.synthetic', contractVersion: 'draft-1', kind: 'coded', implementationDigest: adapter.digest },
      dependencies: deps[u]!.map(d => ({ id: `work-${d}`, revision: 1 })),
      resources: { deadlineMs: 120_000, memoryBytes: 2_147_483_648, cpuQuota: 2, maxPids: 128, maxOutputBytes: 4_194_304, ...(options.resources?.[u] ?? {}) },
      coordinatorEpoch: 'epoch-planning', createdAt: '2026-10-22T00:00:00Z', activeAttemptId: null,
      ...(options.held?.[u] ? { state: 'disabled-by-policy', reasonCode: options.held[u] } : { state: 'pending' }),
    } as any;
    w.inputFingerprint = inputFingerprintOf(ids);
    w.influenceManifest = influenceManifest(w, adapter, ids).id;
    return w;
  });
  const plan = {
    run, works,
    adapterFor: (w: { id: string }) => `${prefix}-${behaviourOf(w.id.slice(5))}`,
    inputsFor: () => captured,
    ...(options.required ? { requiredCoverage: (w: { id: string }) => options.required!(w.id.slice(5)) } : {}),
  };
  return { plan: plan as any, registry, units };
}

/** Every plan unit's publication and how many publications each work revision got, read from the ledger. */
export function publications(store: any, runId: string) {
  const counts = new Map<string, number>();
  let after = 0;
  for (;;) {
    const page = store.ledger.readEvents({ after, limit: 500, runId });
    for (const e of page.events) if (e.kind === 'work-published') counts.set(e.work.id, (counts.get(e.work.id) ?? 0) + 1);
    if (!page.more) break;
    after = page.cursor;
  }
  return counts;
}

/** What the ledger holds for the plan's units, through its typed reads only. */
export function ledgerState(store: any, plan: any) {
  const attempts: Array<{ work: string; id: string; state: string; epoch: string }> = [];
  for (const w of plan.works) for (const a of store.ledger.listAttempts({ id: w.id, revision: w.revision })) attempts.push({ work: w.id, ...a });
  return {
    attempts,
    running: attempts.filter(a => a.state === 'running').length,
    openStages: store.ledger.listOpenStages(500).length,
    work: Object.fromEntries(plan.works.map((w: any) => [w.id, store.ledger.getWork({ id: w.id, revision: w.revision })])),
  };
}

/** node:22-alpine as an OCI index pinned by digest; installed ahead for the container tests, never pulled by them. */
export const CANARY_IMAGE = 'node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9';

/** The same diamond plan, executed by the hostile worker inside real containers (external adapters). */
export async function containerPlan(root: string, behaviours: Record<string, string> = {}) {
  const { readFileSync } = await import('node:fs');
  const { createAdapterRegistry } = await import('../dist/execution/registry.js');
  const { WORKER } = await import('./execution-helpers.ts');
  const source = readFileSync(WORKER, 'utf8');
  const kinds = [...new Set(['A', 'B', 'C', 'D'].map(u => behaviours[u] ?? 'ok'))];
  const registry = createAdapterRegistry(kinds.map(b => ({
    id: `canary-${b}`, version: '0.0.0-test', kind: 'external' as const, isolation: 'container' as const, image: CANARY_IMAGE,
    command: ['node', '--input-type=module', '-e', source, b], limits: { timeoutMs: 30_000, helloTimeoutMs: 15_000, cancelGraceMs: 2_000, memoryBytes: 256 * 1024 * 1024, pids: 64, tmpfsBytes: 16 * 1024 * 1024 },
  })));
  return { plan: syntheticPlan(root, behaviours, { registry, adapterPrefix: 'canary' }).plan, registry };
}
