// A synthetic, admitted plan for the coordinator tests. A tiny real repository is captured into the test's store
// (PR 04), and an analysis revision in PR 06's canonical sentinel-plan/draft-1 form is admitted with a real rule lock,
// effective policy and execution profile (plans.ts): four check units in a diamond A → {B, C} → D, each covering one
// required check over a captured file and executed by a built-in fake scanner from the hostile-worker fixture.
// Hand-built only so each unit can be given its own behaviour and dependencies; every field is checked the way a
// planned revision is (validateEnvelope, verifyPlanRevision, planBoundaryFor, verifyWorkEnvelope).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { admitPlan } from '../dist/execution/plans.js';
import { executionProfileRecord } from '../dist/execution/profile.js';
import { createCapabilityTable } from '../dist/planner/index.js';
import { checkIdOf, checkUnitIdOf } from '../dist/planner/identity.js';
import { captureSnapshot, openSnapshot } from '../dist/snapshot/index.js';
import { digestOf } from '../dist/store/ledger-json.js';
import { validateEnvelope } from '../dist/validate.js';
import { WORKER } from './execution-helpers.ts';
import { lockedRules, policyView } from './planner-helpers.ts';
import { commitRepo } from './snapshot-helpers.ts';

const digest = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
export const SOURCE = 'synthetic';
export const FILES: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n', 'src/c.ts': 'export const c = 3;\n', 'src/d.ts': 'export const d = 4;\n' };
export const UNITS = ['A', 'B', 'C', 'D'] as const;
const DEPS: Record<string, string[]> = { A: [], B: ['A'], C: ['A'], D: ['B', 'C'] };
export const RESOURCES = { deadlineMs: 120_000, memoryBytes: 2_147_483_648, cpuQuota: 2, maxPids: 128, maxOutputBytes: 4_194_304 };
export const PARSE = { selection: { gitignore: true, testFiles: 'include' as const }, limits: { maxFiles: 100, maxFileBytes: 65536, maxTotalBytes: 1 << 20, maxEntries: 10_000, maxDurationMs: 60_000 } };

export interface SyntheticOptions {
  runId?: string;
  limits?: Record<string, number>;
  argument?: string;
  /** The check stage's resource grant (every check unit's work resources), over RESOURCES. */
  resources?: Record<string, number>;
  /** Units whose check is not required. */
  optional?: string[];
  registry?: any;
  adapterPrefix?: string;
  deadlineMs?: number;
  /** A child run: its parent, an admitted snapshot to reuse instead of capturing, and published work A depends on. */
  parentId?: string;
  snapshotId?: string;
  reuse?: Array<{ id: string; revision: number }>;
  /** An effective policy to admit the plan under (an adopted one), instead of one made here for its rules. */
  policy?: any;
  /** Where the synthetic repository is committed; `<root>/repo` by default. */
  repo?: string;
}

/** The trusted registry for these behaviours: one built-in adapter each, wrapper modules written once under root. */
export function syntheticRegistry(root: string, behaviours: string[], limits: Record<string, number> = {}, argument?: string) {
  const dir = join(root, 'adapters');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return createAdapterRegistry([...new Set(behaviours)].map(b => {
    const module = join(dir, `${b}.mjs`);
    const text = `globalThis.SENTINEL_BEHAVIOR = ${JSON.stringify(b)}; globalThis.SENTINEL_ARGUMENT = ${JSON.stringify(argument ?? null)};\nawait import(${JSON.stringify(new URL(`file://${WORKER}`).href)});\n`;
    if (!existsSync(module)) writeFileSync(module, text);
    const merged: Record<string, number> = { timeoutMs: 15_000, cancelGraceMs: 1_000, helloTimeoutMs: 5_000, ...limits };
    merged.helloTimeoutMs = Math.min(merged.helloTimeoutMs!, merged.timeoutMs!);
    merged.cancelGraceMs = Math.min(merged.cancelGraceMs!, merged.timeoutMs!);
    return { id: `test-${b}`, version: '0.0.0-test', kind: 'built-in' as const, isolation: 'child' as const, module, limits: merged, coverage: 'per-file-per-rule' as const };
  }));
}

export const behaviourOf = (behaviours: Record<string, string>, u: string) => behaviours[u] ?? 'ok';
export const registryFor = (root: string, behaviours: Record<string, string> = {}, options: SyntheticOptions = {}) =>
  options.registry ?? syntheticRegistry(root, UNITS.map(u => behaviourOf(behaviours, u)), options.limits ?? {}, options.argument);

/**
 * Capture the synthetic repository, admit the analysis revision, and return the run to open the coordinator with.
 * The run itself is recorded by the coordinator's first run().
 */
export async function syntheticPlan(store: any, root: string, behaviours: Record<string, string> = {}, options: SyntheticOptions = {}) {
  const runId = options.runId ?? 'run-e4';
  const registry = registryFor(root, behaviours, options);
  const prefix = options.adapterPrefix ?? 'test';
  const repo = options.repo ?? join(root, 'repo');
  if (!existsSync(repo)) commitRepo(repo, FILES);
  const snapshot = options.snapshotId ? (await openSnapshot(store, options.snapshotId)).snapshot
    : (await captureSnapshot(store, { mode: 'committed-tree', sources: [{ sourceId: SOURCE, repositoryId: 'example/synthetic', root: repo }] })).snapshot;
  const files = snapshot.entries.filter((e: any) => e.kind === 'file' && e.disposition === 'included')
    .map((e: any) => ({ sourceId: e.sourceId, relativePath: e.relativePath, content: e.content }))
    .sort((a: any, b: any) => (a.relativePath < b.relativePath ? -1 : 1));
  // One locked rule per adapter, since a check runs only under the adapter its rule names.
  const adapterOfUnit = (u: string) => `${prefix}-${behaviourOf(behaviours, u)}`;
  const adapterIds = [...new Set(UNITS.map(adapterOfUnit))].sort();
  const familyOf = (adapterId: string) => `sentinel.test.r${adapterIds.indexOf(adapterId)}`;
  const { lock, pin, view, pack, files: packFiles } = lockedRules(adapterIds.map(a => ({ familyId: familyOf(a), adapterId: a })), []);
  const policy = options.policy ?? policyView(view.rules.map((r: any) => r.familyId)).policy;
  // Each unit covers one required check over its own captured file, under the adapter of its behaviour.
  const scopeOf = (u: string) => `${SOURCE}:src/${u.toLowerCase()}.ts`;
  const checkOf = (u: string) => ({ familyId: familyOf(adapterOfUnit(u)), ruleRevision: 1, scopeKind: 'source-file', scopeId: scopeOf(u), sourceId: SOURCE,
    environment: snapshot.environmentProfileDigest, mode: 'deterministic', required: !options.optional?.includes(u), state: 'planned', unit: { id: `work-${u}`, revision: 1 } });
  const checkIds = Object.fromEntries(UNITS.map(u => [u, checkIdOf(checkOf(u))]));
  const ids = Object.fromEntries(UNITS.map(u => [u, checkUnitIdOf({ runId, revision: 1, adapterId: adapterOfUnit(u), sourceId: SOURCE, checks: [checkIds[u]!] })])) as Record<string, string>;
  const checks = UNITS.map(u => { const c = checkOf(u); return { id: checkIds[u]!, ...c, unit: { id: ids[u]!, revision: 1 } }; });
  const used = new Map<string, string>();
  const units = UNITS.map((u, i) => {
    const adapterId = adapterOfUnit(u);
    const implementationDigest = registry.get(adapterId).digest;
    used.set(adapterId, implementationDigest);
    const inputs = files.filter((f: any) => f.relativePath === `src/${u.toLowerCase()}.ts`);
    return { id: ids[u]!, revision: 1, stage: 'check', contract: 'sentinel.stage.check.synthetic', implementationDigest, sourceId: SOURCE, adapterId,
      dependencies: [...DEPS[u]!.map(d => ({ id: ids[d]!, revision: 1 })), ...(u === 'A' ? options.reuse ?? [] : [])].sort((a, b) => (a.id < b.id ? -1 : 1)), inputFingerprint: digest(`fingerprint ${u}`), checks: [checks[i]!.id],
      scopes: [scopeOf(u)], inputs, inputSetDigest: digestOf(inputs) };
  });
  const profile = executionProfileRecord({ id: 'profile-test', registry, capabilities: createCapabilityTable(registry, []), permits: [] } as any,
    { capture: RESOURCES, parse: RESOURCES, inventory: RESOURCES, check: { ...RESOURCES, ...(options.resources ?? {}) } } as any, PARSE);
  const required = checks.filter(c => c.required).length;
  const body: any = {
    schema: 'sentinel-plan/draft-1', runId, revision: 1, kind: 'analysis', previous: null,
    pins: { snapshotId: snapshot.id, inventoryDigest: snapshot.inventoryDigest, environment: snapshot.environmentProfileDigest, ruleLockDigest: pin,
      policyDigest: policy.revision, profileId: profile.id,
      rules: view.rules.map((r: any) => ({ familyId: r.familyId, revision: r.revision, definitionDigest: r.definitionDigest, packDigest: r.packDigest, adapterId: r.adapterId })), tools: [], databases: [], analyses: [{ sourceId: SOURCE, analysisFingerprint: 'fp-synthetic' }],
      operations: { capture: null, parse: null, inventory: null }, adapters: [...used].sort().map(([adapterId, d]) => ({ adapterId, digest: d })), capabilities: [] },
    reused: [...(options.reuse ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)), units: [...units].sort((a, b) => (a.id < b.id ? -1 : 1)), checks: [...checks].sort((a, b) => (a.id < b.id ? -1 : 1)), ruleGaps: [],
    tallies: { checks: { 'planned': 4, 'unsupported': 0, 'applicability-unknown': 0, 'scope-unavailable': 0, 'scope-unknown': 0 }, required, requiredNotPlanned: 0, units: 4 },
    requiredCoverageAchievable: true,
  };
  const plan = { ...body, digest: digestOf(body) };
  const checked = validateEnvelope('plan', plan);
  if (!checked.ok) throw new Error(`synthetic plan invalid: ${JSON.stringify(checked.errors[0])}`);
  await admitPlan(store, { plan, ruleLock: lock, policy, profile });
  const run = {
    schema: 'sentinel-run/draft-1', id: runId, parentId: options.parentId ?? null, baselineId: null, snapshotId: snapshot.id, planRevision: 1,
    coordinatorEpoch: 'epoch-planning', ruleLockDigest: pin, toolLockDigest: pin, policyRevisionDigest: policy.revision,
    requestedScope: { sourceIds: [SOURCE], profile: profile.id }, budgets: { maxTokens: null, maxCost: null, deadlineMs: options.deadlineMs ?? 600_000 },
    createdAt: '2026-10-22T00:00:00Z', state: 'planned',
  };
  return { runId, run: run as any, registry, plan, units: [...UNITS], ids, pack, packFiles };
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
export function ledgerState(store: any, plan: { units: Array<{ id: string; revision: number }> }) {
  const attempts: Array<{ work: string; id: string; state: string; epoch: string }> = [];
  for (const w of plan.units) for (const a of store.ledger.listAttempts({ id: w.id, revision: w.revision })) attempts.push({ work: w.id, ...a });
  return {
    attempts,
    running: attempts.filter(a => a.state === 'running').length,
    openStages: store.ledger.listOpenStages(500).length,
    work: Object.fromEntries(plan.units.map((w: any) => [w.id, store.ledger.getWork({ id: w.id, revision: w.revision })])),
  };
}

/** node:22-alpine as an OCI index pinned by digest; installed ahead for the container tests, never pulled by them. */
export const CANARY_IMAGE = 'node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9';

/** The registry for the same diamond executed by the hostile worker inside real containers (external adapters). */
export async function containerRegistry(behaviours: Record<string, string> = {}) {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(WORKER, 'utf8');
  const kinds = [...new Set(UNITS.map(u => behaviours[u] ?? 'ok'))];
  return createAdapterRegistry(kinds.map(b => ({
    id: `canary-${b}`, version: '0.0.0-test', kind: 'external' as const, isolation: 'container' as const, image: CANARY_IMAGE,
    command: ['node', '--input-type=module', '-e', source, b], coverage: 'per-file-per-rule' as const,
    limits: { timeoutMs: 30_000, helloTimeoutMs: 15_000, cancelGraceMs: 2_000, memoryBytes: 256 * 1024 * 1024, pids: 64, tmpfsBytes: 16 * 1024 * 1024 },
  })));
}

/** The synthetic diamond's unit ids by letter, read from an admitted plan (each unit covers src/<letter>.ts). */
export function unitIdsOf(plan: { units: Array<{ id: string; scopes: string[] }> }): Record<string, string> {
  return Object.fromEntries(plan.units.map(u => [u.scopes[0]!.slice(`${SOURCE}:src/`.length, -3).toUpperCase(), u.id]));
}

/** Explicit trusted pass-through drivers for the synthetic service fixture, never a production fallback. */
export async function syntheticServiceDrivers(store: any, registry: any, runId: string) {
  const { loadPlan } = await import('../dist/execution/plans.js');
  const { createCheckDriverRegistry } = await import('../dist/execution/check-drivers.js');
  const latest = store.ledger.latestPlan(runId);
  const { plan } = await loadPlan(store, runId, latest.revision);
  return createCheckDriverRegistry(registry.ids.filter((id: string) => registry.get(id).kind !== 'operation').map((adapterId: string) => ({
    adapterId, implementationDigest: registry.get(adapterId).digest,
    supportedRules: () => plan.pins.rules.filter((r: any) => r.adapterId === adapterId),
    async prepare() { return { job: null, auxiliary: [] }; },
    async normalize(_ctx: any, v: any) { return { coverage: v.result, records: [] }; },
  })), registry);
}
