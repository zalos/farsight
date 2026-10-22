// A trusted planner profile for the planner suites: a real adapter registry (PR 07) holding a built-in pattern
// adapter, a built-in bootstrap operation and an external advisory scanner pinned by image digest, and a capability
// table built over it. Nothing is started; registration only hashes the built-in module.
import { fileURLToPath } from 'node:url';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createCapabilityTable } from '../dist/planner/index.js';

const MODULE = fileURLToPath(new URL('./fixtures/workers/hostile-worker.mjs', import.meta.url));
export const OSV_IMAGE = `osv-scanner@sha256:${'a'.repeat(64)}`;

export const registry = createAdapterRegistry([
  { id: 'sentinel-pattern', version: '1', kind: 'built-in', isolation: 'child', module: MODULE },
  { id: 'sentinel-bootstrap', version: '1', kind: 'built-in', isolation: 'child', module: MODULE },
  { id: 'osv', version: '2.0.0', kind: 'external', isolation: 'container', image: OSV_IMAGE, command: ['osv-scanner', '--offline'] },
]);

const ESTABLISHED = [
  { capability: 'source-bytes', adapterId: 'sentinel-pattern', evidence: 'synthetic: built-in pattern adapter' },
  { capability: 'pattern-match', adapterId: 'sentinel-pattern', evidence: 'synthetic: built-in pattern adapter' },
  { capability: 'source-span', adapterId: 'sentinel-pattern', evidence: 'synthetic: built-in pattern adapter' },
  { capability: 'call-occurrence', adapterId: 'sentinel-pattern', evidence: 'synthetic: parser occurrences', perFileParse: true },
  { capability: 'dependency-manifest', adapterId: 'osv', evidence: 'synthetic: advisory scanner' },
  { capability: 'advisory-database', adapterId: 'osv', evidence: 'synthetic: advisory scanner' },
];

/**
 * A profile over the trusted registry. Every established capability is permitted unless listed in `forbid`;
 * `framework-order` and anything else not established stays unavailable whatever the profile permits.
 */
export function trustedProfile(options: { forbid?: string[]; permitExtra?: string[]; bootstrap?: boolean } = {}) {
  const permits = [...ESTABLISHED.map(f => f.capability), ...(options.permitExtra ?? [])].filter(c => !(options.forbid ?? []).includes(c));
  return {
    id: 'profile-local', registry, capabilities: createCapabilityTable(registry, ESTABLISHED), permits,
    ...(options.bootstrap === false ? {} : { operations: { capture: 'sentinel-bootstrap', parse: 'sentinel-bootstrap', inventory: 'sentinel-bootstrap' } }),
  };
}

// ---- planner inputs through the real adapters ----

import { createHash } from 'node:crypto';
import { emptyLock, lockDigest, validatePack } from '../dist/rules/index.js';
import { DEFAULT_SETTINGS, effectivePolicy } from '../dist/policy/index.js';
import { plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom, plannerSnapshotFrom } from '../dist/planner/index.js';

const D = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

export interface RuleSpec {
  familyId: string; revision?: number; languages?: string[]; scopeKind?: string; frameworks?: string[]; requires?: string[]; adapterId?: string;
}

/** A rule definition as a pack manifest holds it, from the fields planning reads. */
export const definitionOf = (r: RuleSpec) => ({
  familyId: r.familyId, revision: r.revision ?? 1, titleKey: 'sentinel.rule.fixture',
  applicability: { languages: r.languages ?? ['typescript', 'javascript'], scopeKind: r.scopeKind ?? 'source-file', ...(r.frameworks ? { frameworks: r.frameworks } : {}) },
  requires: r.requires ?? ['source-bytes', 'pattern-match'], implementation: { adapterId: r.adapterId ?? 'sentinel-pattern', rulePath: `detectors/${r.familyId}.yml` },
  meaning: 'candidate', severity: 'high', evidenceRequired: ['source-span'], limitationKeys: [], mappings: { cwe: ['CWE-95'] },
  fixtures: { positive: [`fixtures/${r.familyId}-bad.ts`], negative: [`fixtures/${r.familyId}-good.ts`] },
});

/** A validated pack of `rules`, a lock entry for it as promotion writes it, and the planner's lock view. */
export function lockedRules(rules: RuleSpec[], tools: { adapterId: string; version: string; artifactDigest: string }[] = [{ adapterId: 'osv', version: '2.0.0', artifactDigest: D('osv') }]) {
  const files = new Map<string, Uint8Array>();
  const defs = rules.map(definitionOf);
  files.set('sentinel-pack.json', Buffer.from(JSON.stringify({ schema: 'sentinel-rulepack/draft-1', packId: 'fixture-pack', version: '1.0.0', rights: { spdx: 'MIT', origin: 'sentinel-original' }, rules: defs })));
  for (const r of defs) { files.set(r.implementation.rulePath, Buffer.from('rule\n')); for (const f of [...r.fixtures.positive, ...r.fixtures.negative]) files.set(f, Buffer.from('fixture\n')); }
  const pack = validatePack(files);
  const NOW = new Date('2026-10-22T12:00:00.000Z');
  const at = '2026-10-22T12:00:00.000000000Z';
  const lock = { ...emptyLock(NOW), revision: 2, previous: lockDigest(emptyLock(NOW)),
    packs: [{ ...structuredClone((pack as any).entry), promotion: { receipt: D('receipt'), at } }],
    databases: [{ databaseId: 'osv-db', snapshotDigest: D('osv db snapshot'), capturedAt: '2026-10-22T00:00:00Z', rights: { spdx: 'CC-BY-4.0', origin: 'third-party' as const, upstream: { name: 'osv', revision: '2026-10-22' } }, promotion: { receipt: D('receipt'), at } }],
    tools: tools.map(t => ({ ...t, platform: 'linux-x64', rights: { spdx: 'Apache-2.0', origin: 'third-party' as const, upstream: { name: t.adapterId, revision: t.version } }, promotion: { receipt: D('receipt'), at } })) };
  return { pack, lock, pin: lockDigest(lock as never), view: plannerLockFrom(lock as never, [pack], lockDigest(lock as never)) };
}

/** The effective policy: `mandatory` families from adopted settings, `requested` from the repository's config. */
export function policyView(mandatory: string[], options: { requested?: string[]; requireCompleteCoverage?: boolean; requiredCapabilities?: string[] } = {}) {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), mandatoryRules: mandatory,
    thresholds: { failOnSeverity: 'high' as const, requireCompleteCoverage: options.requireCompleteCoverage ?? false, requiredCapabilities: (options.requiredCapabilities ?? []) as never[] } };
  const repoConfig = options.requested ? { schema: 'sentinel-repoconfig/draft-1' as const, requestedRules: options.requested, disabledRules: [], thresholds: {}, suppressions: [], providers: [] } : null;
  const policy = effectivePolicy({ trust: 'adopted', settings, settingsDigest: D(`settings ${mandatory.join()}`), repoConfig, repoConfigDigest: repoConfig ? D('repo config') : null });
  return { policy, view: plannerPolicyFrom(policy) };
}

/** A valid snapshot envelope over `entries`, and the planner's snapshot view. */
export function snapshotView(sourceIds: string[], entries: unknown[], frameworkVersions: unknown[] = [], id = 'snap-1') {
  const envelope = {
    schema: 'sentinel-snapshot/draft-1', id, inventoryDigest: D(`inventory ${id}`), createdAt: '2026-10-22T12:00:00Z',
    capture: { mode: 'committed-tree', policyDigest: D('capture policy') }, environmentProfileDigest: D('environment'),
    sources: sourceIds.map(sourceId => ({ sourceId, repositoryId: `example/${sourceId}`, commit: '0123456789abcdef0123456789abcdef01234567', dirty: false, capturedAt: '2026-10-22T12:00:00Z' })),
    entries, frameworkVersions, artifacts: { parser: [], diagnostics: [] },
  };
  return { envelope, view: plannerSnapshotFrom(envelope as never) };
}

/** Parser evidence for one source, in the parser result's shape. */
export const analysisView = (sourceId: string, files: { path: string; class: string }[], surfaces: { nodeId: string; path: string; kind: string }[] = [], fingerprint = `fp-${sourceId}`) =>
  plannerAnalysisFrom({ sourceId, result: { analysisFingerprint: fingerprint, entries: files }, index: { nodes: surfaces } } as never);

export const included = (sourceId: string, relativePath: string) =>
  ({ sourceId, relativePath, kind: 'file' as const, disposition: 'included' as const, content: D(`${sourceId}/${relativePath}`), bytes: 10, generated: false });
