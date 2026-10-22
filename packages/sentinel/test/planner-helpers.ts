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
