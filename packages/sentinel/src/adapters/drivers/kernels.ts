// The production check drivers and the registry definitions they belong to (internal: the trusted execution profile
// and the coordinator are their only callers; nothing here is exported from the package).
import type { ExternalAdapterDefinition } from '../../execution/registry.js';
import { OSV_ADAPTER } from '../osv/adapter.js';
import { PATTERN_ADAPTER } from '../pattern/adapter.js';
import { TRIVY_ADAPTER } from '../trivy/adapter.js';
import { ZIZMOR_ADAPTER } from '../zizmor/adapter.js';
import { osvDriver } from './osv.js';
import { patternDriver } from './pattern.js';
import { trivyDriver } from './trivy.js';
import { zizmorDriver } from './zizmor.js';
import type { CheckDriver } from './types.js';

export { DRIVER_REASONS, DriverError, fileScope } from './common.js';
export { PATTERN_SUPPORTED_RULES } from './pattern.js';
export { OSV_SUPPORTED_RULES, osvDatabaseId } from './osv.js';
export { TRIVY_SUPPORTED_RULES, TRIVY_CHECKS_DATABASE_ID } from './trivy.js';
export { ZIZMOR_SUPPORTED_RULES } from './zizmor.js';
export type * from './types.js';

/** What the scanner kernels need from the owner's settings. */
export interface ScannerOptions {
  /** The owner's advisory freshness bound: a snapshot older than this is stale (never complete). */
  readonly maxAdvisoryAgeMs: number;
}

/** Each production external adapter with its driver: registry definition and driver share one id. */
export function scannerKernels(
  options: ScannerOptions,
): ReadonlyMap<string, { definition: ExternalAdapterDefinition; driver: CheckDriver }> {
  const entries: [ExternalAdapterDefinition, CheckDriver][] = [
    [PATTERN_ADAPTER, patternDriver()],
    [OSV_ADAPTER, osvDriver({ maxDatabaseAgeMs: options.maxAdvisoryAgeMs })],
    [TRIVY_ADAPTER, trivyDriver()],
    [ZIZMOR_ADAPTER, zizmorDriver()],
  ];
  for (const [d, k] of entries)
    if (d.id !== k.adapterId) throw new Error(`the driver for ${d.id} names ${k.adapterId}`);
  return new Map(entries.map(([definition, driver]) => [definition.id, Object.freeze({ definition, driver })]));
}
