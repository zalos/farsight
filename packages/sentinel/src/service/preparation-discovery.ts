// Admitted readiness resolution only: no acquisition or engine scan. Every client uses the held store's lease.
import type { SentinelStore } from '../store/index.js';
import type { ScratchLease } from './scratch-lease.js';
import type { DockerRunner } from '../execution/isolation.js';
import { TRIVY_CHECKS_BUNDLE } from '../adapters/trivy/adapter.js';
import { externalDrivers } from './scanner-profile.js';
import {
  installedAdapters,
  heldDatabases,
  assertPreparationAssetProvenance,
  ScannerAssetError,
} from './scanner-assets.js';
import { FRAMEWORK_CONTROLS_ADAPTER_ID, frameworkAvailable } from './framework-adapter.js';
import { checkPreparationClock, PreparationError, type PreparationClock } from './preparation-clock.js';
import {
  preparationTerms,
  preparationInputBytes,
  preparationResolvedBytes,
  checkPreparationProfile,
  type PreparationInputs,
  type PreparationAvailability,
} from './preparation-inputs.js';

const MISSING = new Set([
  'sentinel.assets.missing',
  'sentinel.execution.imageMissing',
  'sentinel.execution.isolationUnavailable',
  'sentinel.execution.backendUnqualified',
]);
/** Error details and producer text never become journal/readiness metadata. */
const absent = (error: unknown): string | null => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && MISSING.has(code) ? code : null;
};
/** What deciding an external stage's readiness reads. */
interface ExternalEnv {
  readonly terms: ReturnType<typeof preparationTerms>;
  readonly clock: PreparationClock;
  readonly lease: ScratchLease;
  readonly wrapRunner: (runner: DockerRunner) => DockerRunner;
  readonly signal: AbortSignal | undefined;
}
/**
 * The offline databases a fixed-recipe stage needs before the source is captured: both OSV ecosystems for the advisory
 * stage, the checks bundle for Trivy, none otherwise.
 */
function databaseIdsOf(adapterId: string): string[] {
  if (adapterId === 'advisories-osv') return ['osv:npm', 'osv:Maven'];
  if (adapterId === 'iac-trivy') return ['trivy-checks'];
  return [];
}
/**
 * Why an external scanner stage is not ready, or null when it is: `sentinel.preparation.toolMissing` without a shipped
 * driver or an adopted tool pin, `sentinel.plan.toolMismatch` when the pin is another version or image, a missing or
 * mismatched database (`sentinel.preparation.databaseMissing`, `sentinel.preparation.databaseMismatch`), or a missing
 * image or runtime from installing it. The provenance of every pin it reads is checked first; an installed asset that
 * has gone missing is `sentinel.assets.invalid`, and any other failure throws.
 */
async function externalReason(adapterId: string, env: ExternalEnv): Promise<string | null> {
  const { terms, clock, lease, wrapRunner, signal } = env;
  const definition = externalDrivers().get(adapterId)?.definition;
  const pin = terms.current.lock.tools.find((t) => t.adapterId === adapterId);
  if (!definition || !pin) return 'sentinel.preparation.toolMissing';
  if (pin.version !== definition.version || pin.artifactDigest !== definition.image.split('@')[1])
    return 'sentinel.plan.toolMismatch';
  // Before the source is captured there is no honest ecosystem-specific scope. This fixed recipe requires the
  // shipped OSV stage's complete two-ecosystem offline inputs; partial installations are recorded as a stage gap.
  const databaseIds = databaseIdsOf(adapterId);
  assertPreparationAssetProvenance(terms.trustDir, [
    pin,
    ...terms.current.lock.databases.filter((d) => databaseIds.includes(d.databaseId)),
  ]);
  clock.stillWithin();
  if (databaseIds.some((id) => !terms.current.lock.databases.some((d) => d.databaseId === id)))
    return 'sentinel.preparation.databaseMissing';
  if (
    adapterId === 'iac-trivy' &&
    !terms.current.lock.databases.some(
      (d) => d.databaseId === 'trivy-checks' && d.snapshotDigest === TRIVY_CHECKS_BUNDLE.layer,
    )
  )
    return 'sentinel.preparation.databaseMismatch';
  let reason: string | null = null;
  try {
    await installedAdapters(terms.trustDir, terms.current.lock, [adapterId], lease.path, wrapRunner, signal);
    clock.stillWithin();
  } catch (error) {
    clock.stillWithin();
    if (error instanceof ScannerAssetError && error.code === 'sentinel.assets.missing')
      throw new ScannerAssetError('sentinel.assets.invalid');
    const missing = absent(error);
    if (!missing) throw error;
    reason = missing;
  }
  if (reason === null && databaseIds.length) {
    assertPreparationAssetProvenance(
      terms.trustDir,
      terms.current.lock.databases.filter((d) => databaseIds.includes(d.databaseId)),
    );
    clock.stillWithin();
    try {
      heldDatabases(terms.trustDir, {
        ...terms.current.lock,
        databases: terms.current.lock.databases.filter((d) => databaseIds.includes(d.databaseId)),
      });
      clock.stillWithin();
    } catch (error) {
      clock.stillWithin();
      if (error instanceof ScannerAssetError && error.code === 'sentinel.assets.missing')
        reason = 'sentinel.preparation.databaseMissing';
      else throw error;
    }
  }
  return reason;
}
/**
 * Resolves the readiness of every stage a preparation requested, without acquiring anything or scanning: framework
 * controls need the promoted framework packs and their registry entry; an external scanner needs its pinned tool,
 * offline databases and installed image (`externalReason`). A stage the retained resolution recorded unavailable stays
 * a gap; one it recorded available that is no longer ready refuses with `sentinel.preparation.unavailable`. Every
 * container call runs through the held store's scratch lease under the preparation clock.
 */
export async function discoverPreparationProfile(
  store: SentinelStore,
  inputs: PreparationInputs,
  clock: PreparationClock,
  lease: ScratchLease,
  signal?: AbortSignal,
): Promise<PreparationInputs> {
  checkPreparationClock(store, clock);
  const terms = preparationTerms(store, inputs, () => clock.stillWithin());
  const requested = JSON.parse(preparationInputBytes(store, inputs).toString('utf8')).recipe
    .requestedAdapters as string[];
  const retained: PreparationAvailability[] | null = terms.resolved
    ? JSON.parse(preparationResolvedBytes(store, inputs).toString('utf8')).availability
    : null;
  const answers: PreparationAvailability[] = [],
    available = new Set<string>();
  const wrapRunner = (runner: DockerRunner): DockerRunner => {
    const owned = lease.wrapRunner(runner);
    return {
      runSync() {
        throw new PreparationError('sentinel.preparation.invalid');
      },
      start() {
        throw new PreparationError('sentinel.preparation.invalid');
      },
      async run(args, callerSignal) {
        clock.stillWithin();
        const signals = [signal, callerSignal].filter((s): s is AbortSignal => s !== undefined);
        const result = await owned.run(args, signals.length ? AbortSignal.any(signals) : undefined);
        clock.stillWithin();
        return result;
      },
    };
  };
  for (const adapterId of requested) {
    clock.stillWithin();
    const before = retained?.find((a) => a.adapterId === adapterId);
    // Historical unavailable stages stay gaps after capture, even if new local assets appeared. No silent upgrade.
    if (before?.available === false) {
      answers.push(before);
      continue;
    }
    let reason: string | null = null;
    if (adapterId === FRAMEWORK_CONTROLS_ADAPTER_ID) {
      if (!frameworkAvailable(terms.current.lock, terms.packs) || !terms.registry.ids.includes(adapterId))
        reason = 'sentinel.assets.missing';
    } else reason = await externalReason(adapterId, { terms, clock, lease, wrapRunner, signal });
    if (before?.available && reason !== null) throw new PreparationError('sentinel.preparation.unavailable');
    if (reason === null) available.add(adapterId);
    answers.push(Object.freeze({ adapterId, available: reason === null, reasonCode: reason }));
  }
  clock.stillWithin();
  return checkPreparationProfile(store, inputs, available, clock, answers);
}
