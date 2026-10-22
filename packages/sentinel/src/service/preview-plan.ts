// The foundation-preview planner: one coded work unit (the preview detector) over every included file of one
// admitted snapshot, handed to the coordinator through PR 08's PlanBoundary. It stands behind the same seam as
// PR 06's planner and is replaced by it; it plans no scanner, framework check or model review, and says so.
//
// Rebuilding is deterministic: the same snapshot, policy revision and adapter give the same plan id, digest, work
// envelopes and inputs, so a later process (`run <planId>`) recreates exactly what `plan` disclosed and checks it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEnvelope } from '../contracts/run.js';
import type { WorkEnvelope } from '../contracts/work.js';
import type { ActionEffect } from '../contracts/index.js';
import type { PlanBoundary } from '../execution/coordinator.js';
import { createAdapterRegistry, type AdapterRegistry } from '../execution/registry.js';
import { inputFingerprintOf, type CapturedInput } from '../execution/supervisor.js';
import { restoreSnapshot } from '../snapshot/materialize.js';
import { canonicalJsonBytes } from '../store/objects.js';
import type { SentinelStore } from '../store/index.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_INPUTS_SCHEMA, PREVIEW_RULE } from '../adapters/preview-detector.js';

export const PREVIEW_PROFILE = 'static';
export const PREVIEW_STAGE = 'sentinel.stage.previewDetector';
const digest = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJsonBytes(v)).digest('hex')}`;

/** The built-in preview detector, registered for preview plans only (the production registry stays empty). */
export const PREVIEW_ADAPTERS: AdapterRegistry = createAdapterRegistry([{
  id: PREVIEW_DETECTOR_ID, version: 'preview-1', kind: 'built-in', isolation: 'child',
  module: fileURLToPath(new URL('../adapters/preview-detector.js', import.meta.url)),
}]);

/** What a plan discloses before anything runs. */
export interface PlanDisclosure {
  readonly planId: string;
  readonly planDigest: string;
  readonly snapshotId: string;
  readonly profile: string;
  /** What admitting the run may do: local artifacts only (no network, no external tool, no model, no spend). */
  readonly effects: readonly ActionEffect[];
  readonly stages: readonly { readonly work: string; readonly adapter: string; readonly rule: string; readonly inputs: number }[];
  readonly label: 'foundation-preview';
}

export interface PreparedPlan {
  readonly disclosure: PlanDisclosure;
  readonly boundary: PlanBoundary;
}

/**
 * Builds the preview plan for an admitted snapshot. `workDir` must be a new private folder: the snapshot is restored
 * into it (read-only) and the inputs manifest written beside it; the coordinator copies and hashes both again.
 */
export async function previewPlan(store: SentinelStore, options: {
  snapshotId: string; policyRevision: string; workDir: string; now: string;
}): Promise<PreparedPlan> {
  const adapter = PREVIEW_ADAPTERS.get(PREVIEW_DETECTOR_ID);
  mkdirSync(options.workDir, { mode: 0o700 });
  const tree = join(options.workDir, 'tree');
  const restored = await restoreSnapshot(store, options.snapshotId, tree);
  const files = restored.materialization.sources.flatMap(s => s.files.map(f => ({
    id: f.content, path: `${s.sourceId}/${f.path}`, onDisk: join(tree, s.sourceId, ...f.path.split('/')),
  })));
  // One input per distinct content; the manifest names every captured path for it.
  const byId = new Map<string, string>();
  for (const f of files) if (!byId.has(f.id)) byId.set(f.id, f.onDisk);
  const manifestBytes = canonicalJsonBytes({ schema: PREVIEW_INPUTS_SCHEMA, files: files.map(f => ({ id: f.id, path: f.path })) });
  const manifestPath = join(options.workDir, 'inputs.json');
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600, flag: 'wx' });
  const manifestId = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  const inputs: CapturedInput[] = [...byId].map(([id, path]) => ({ id, path })).concat({ id: manifestId, path: manifestPath });
  const inputIds = inputs.map(i => i.id) as `sha256:${string}`[];

  // The plan's identity is what it would read and do: the captured inventory (not the capture's time), the policy
  // revision, the adapter and its rule. The same workspace content under the same policy plans to the same id.
  const identity = { inventory: restored.record.inventoryDigest, policyRevision: options.policyRevision, adapter: adapter.digest, rule: PREVIEW_RULE };
  const planDigest = digest(identity);
  const planId = `plan-${planDigest.slice(7, 39)}`;
  const run: RunEnvelope = {
    schema: 'sentinel-run/draft-1', id: planId, parentId: null, baselineId: null, snapshotId: options.snapshotId, planRevision: 1,
    coordinatorEpoch: store.epoch, ruleLockDigest: digest({ rule: PREVIEW_RULE }), toolLockDigest: adapter.digest,
    policyRevisionDigest: options.policyRevision,
    requestedScope: { sourceIds: restored.snapshot.sources.map(s => s.sourceId), profile: PREVIEW_PROFILE },
    budgets: { maxTokens: null, maxCost: null, deadlineMs: 600_000 }, createdAt: options.now, state: 'planned',
  } as RunEnvelope;
  const work: WorkEnvelope = {
    // Work ids are unique across the ledger, so each plan's unit is named after its plan.
    schema: 'sentinel-work/draft-1', id: `work-${planId}`, revision: 1, runId: planId, planRevision: 1,
    stage: { contract: PREVIEW_STAGE, contractVersion: 'draft-1', kind: 'coded', implementationDigest: adapter.digest },
    inputFingerprint: inputFingerprintOf(inputIds),
    // The snapshot's manifest: an admitted artifact, so the retained work names something the ledger keeps.
    influenceManifest: store.ledger.getSnapshot(options.snapshotId)!.manifest,
    dependencies: [],
    resources: { deadlineMs: 120_000, memoryBytes: 2_147_483_648, cpuQuota: 2, maxPids: 128, maxOutputBytes: 4_194_304 },
    coordinatorEpoch: store.epoch, createdAt: options.now, state: 'pending', activeAttemptId: null,
  } as unknown as WorkEnvelope;
  const disclosure: PlanDisclosure = Object.freeze({
    planId, planDigest, snapshotId: options.snapshotId, profile: PREVIEW_PROFILE, effects: Object.freeze(['local-artifacts'] as ActionEffect[]),
    stages: Object.freeze([Object.freeze({ work: work.id, adapter: PREVIEW_DETECTOR_ID, rule: PREVIEW_RULE, inputs: inputs.length })]),
    label: 'foundation-preview',
  });
  const boundary: PlanBoundary = Object.freeze({
    run, works: Object.freeze([work]),
    adapterFor: () => PREVIEW_DETECTOR_ID,
    inputsFor: () => inputs,
  });
  return Object.freeze({ disclosure, boundary });
}

/** The plan record kept beside the workspace's settings until the ledger can read a run back (see the report). */
export interface PlanRecord {
  readonly schema: 'sentinel-plan-record/draft-1';
  readonly planId: string;
  readonly planDigest: string;
  readonly snapshotId: string;
  readonly policyRevision: string;
}
