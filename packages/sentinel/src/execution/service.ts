// Internal: worker execution bound to a store opened through openStore(). The public SentinelStore has no owner
// or resource registration, by design; this service resolves the store's owner through the package-internal
// binding (store/owner-binding.ts) and never hands it out. Not in the package's exports: PR 08's scheduler is
// its caller. There is no other production path to an owner than openStore().
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import { ContainerBackend, type DockerRunner } from './isolation.js';
import { TRUSTED_ADAPTERS, type AdapterRegistry } from './registry.js';
import { superviseAttempt, type AttemptRequest, type WorkerOutcome } from './supervisor.js';

export type ServiceAttempt = Omit<AttemptRequest, 'owner' | 'registry' | 'backend' | 'scratchRoot'>;

export interface ExecutionService {
  /** The connected container runtime, when containers were asked for. */
  readonly backend?: ContainerBackend;
  run(attempt: ServiceAttempt): Promise<WorkerOutcome>;
}

export interface ExecutionServiceOptions {
  /** A private (0700, this user's) folder for attempt work folders and the client's empty configuration. */
  scratchRoot: string;
  /** Defaults to the production registry. */
  registry?: AdapterRegistry;
  /** Connect and qualify the local container runtime now; external adapters cannot run without it. */
  containers?: boolean;
  signal?: AbortSignal;
  /** Package-internal test seam: wraps the container runtime client (fault injection). */
  wrapRunner?: (runner: DockerRunner) => DockerRunner;
}

export async function createExecutionService(store: SentinelStore, options: ExecutionServiceOptions): Promise<ExecutionService> {
  const owner = boundOwner(store);
  owner.assertHeld();
  const registry = options.registry ?? TRUSTED_ADAPTERS;
  const backend = options.containers
    ? await ContainerBackend.connect({ privateDir: options.scratchRoot, ...(options.signal ? { signal: options.signal } : {}), ...(options.wrapRunner ? { wrapRunner: options.wrapRunner } : {}) })
    : undefined;
  return Object.freeze({
    ...(backend ? { backend } : {}),
    run: (attempt: ServiceAttempt) => superviseAttempt({
      ...attempt, owner, registry, scratchRoot: options.scratchRoot, ...(backend ? { backend } : {}),
    }),
  });
}
