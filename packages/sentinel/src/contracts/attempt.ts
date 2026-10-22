import type { ArtifactId, CatalogKey, Count, DecimalAmount, Digest, Id, Ordinal, Timestamp, WorkRef } from './common.js';

export type AttemptState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'canceled' | 'canceled-after-spend';

/** Confirmed spend and unknown usage are distinct facts; a timeout never proves a provider stopped billing. */
export type UsageCertainty = 'confirmed' | 'unknown' | 'not-applicable';

/** How a worker's identity is known. Host-reported identity is not provider attestation. */
export type IdentitySource = 'provider-response' | 'local-weight-digest' | 'host-reported' | 'self-reported' | 'unknown';

/** @discriminator kind */
export type AttemptWorker =
  | {
      kind: 'owned-child';
      /**
       * @asType integer
       * @minimum 1
       */
      pid: number;
      /** Recorded so recovery never kills by command-pattern matching. */
      processStartedAt: Timestamp;
    }
  | {
      kind: 'owned-container';
      /** @pattern ^[0-9a-f]{64}$ */
      containerId: string;
      ownershipLabels: { store: Id; attempt: Id; epoch: Id };
    }
  | {
      /**
       * One of Sentinel's own bootstrap operations (capture, parse, inventory), run by the coordinator in its own
       * process over the store it owns: there is no separate process to find. Its authority is the operation adapter
       * the plan pinned, by registry digest.
       */
      kind: 'coordinator-operation';
      adapterId: Id;
      adapterDigest: Digest;
    }
  | {
      kind: 'external-claim';
      fencingGeneration: Count;
      identitySource: IdentitySource;
    };

export interface AttemptUsage {
  certainty: UsageCertainty;
  inputTokens?: Count;
  outputTokens?: Count;
  monetaryCost?: DecimalAmount;
  /** @pattern ^[A-Z]{3}$ */
  currency?: string;
}

interface AttemptBase {
  schema: 'sentinel-attempt/draft-1';
  id: Id;
  work: WorkRef;
  ordinal: Ordinal;
  coordinatorEpoch: Id;
  operationId: Id;
  worker: AttemptWorker;
  startedAt: Timestamp;
  usage: AttemptUsage;
  /** The exact invocation record: executable digest, argv, redacted environment identity. Never a credential. */
  invocation?: ArtifactId;
}

export interface RunningAttempt extends AttemptBase {
  state: 'running';
}

export interface EndedAttempt extends AttemptBase {
  // Written out for the schema generator's discriminator.
  state: 'succeeded' | 'failed' | 'interrupted' | 'canceled' | 'canceled-after-spend';
  endedAt: Timestamp;
  /** @maxItems 1024 */
  outputs: ArtifactId[];
  error?: { code: CatalogKey; retryable: boolean; diagnostics?: ArtifactId };
}

/**
 * sentinel-attempt/draft-1 — one append-only execution of a work revision.
 * @discriminator state
 */
export type AttemptEnvelope = RunningAttempt | EndedAttempt;
