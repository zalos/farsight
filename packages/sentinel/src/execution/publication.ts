// Publication: turning one checked worker outcome into one accepted ledger publication, in the order the ledger's
// crash safety needs. Each step is a boundary the kill tests stop at:
//
//   before-staging   nothing durable yet for this result
//   after-staging    the artifact ids are pinned in the ledger (registerStaging), no bytes written
//   after-objects    every object is durable in the object store, not yet accepted
//   after-publish    the ledger accepted the publication (one per work revision, fenced by attempt and epoch)
//
// A crash at any boundary leaves a state recovery can finish: an open stage is aborted (its bytes wait for
// collection), and the work runs again under a new attempt; an accepted publication is never repeated.
import { readFileSync } from 'node:fs';
import type { ArtifactId, Id, WorkRef } from '../contracts/common.js';
import type { ResultMessage } from '../contracts/protocol.js';
import type { SentinelStore, StoredObject } from '../store/index.js';
import type { PublicationReceipt, StagedArtifact } from '../store/store-types.js';
import type { VerifiedOutput } from './supervisor.js';

export const PUBLICATION_BOUNDARIES = ['before-staging', 'after-staging', 'after-objects', 'after-publish'] as const;
export type PublicationBoundary = (typeof PUBLICATION_BOUNDARIES)[number];

export interface BoundaryContext {
  work: WorkRef;
  attemptId: Id;
}

/** Test seam: called at each boundary. Production passes none. */
export interface PublicationHooks {
  at?(boundary: PublicationBoundary, context: BoundaryContext): void;
}

/** The schema name the worker's result message is stored under. */
export const RESULT_SCHEMA = 'sentinel-worker/draft-1#result';

/** One stage per attempt, so recovery can tell an attempt's open stage from its published one. */
export const stageIdFor = (attemptId: Id): Id => `stage.${attemptId}`.slice(0, 128);

export interface PublishRequest {
  store: SentinelStore;
  work: WorkRef;
  attemptId: Id;
  result: ResultMessage;
  outputs: readonly VerifiedOutput[];
  endedAt: string;
  hooks?: PublicationHooks;
  /** Coordinator records published with the result (the influence manifest, the coverage evaluation), in order. */
  records?: ReadonlyArray<{ value: unknown; schema: string; privacy?: 'metadata' | 'source-derived' | 'source' }>;
  /** Checks the budget before staging, after every object write, and immediately before acceptance; throws to refuse. */
  beforeAccept?: () => void;
}

/**
 * Stage, store and publish one result. The result message is the first output and links every worker artifact,
 * so a publication always has at least one artifact and the artifacts stay reachable through it.
 */
export async function publishOutcome(request: PublishRequest): Promise<PublicationReceipt> {
  const { store, work, attemptId, hooks } = request;
  const context = { work, attemptId };
  const stageId = stageIdFor(attemptId);
  const artifactIds = request.outputs.map((o) => o.id);
  const resultIdentity = store.objects.identifyCanonicalJson(request.result);
  const records = (request.records ?? []).map((r) => ({
    ...r,
    identity: store.objects.identifyCanonicalJson(r.value),
  }));
  const recordIds = records.map((r) => r.identity.id);
  const staged: StagedArtifact[] = [
    {
      id: resultIdentity.id,
      schema: RESULT_SCHEMA,
      privacy: 'source-derived',
      links: [...new Set(artifactIds)].filter((id) => id !== resultIdentity.id),
    },
    ...records
      .filter(
        (r, i) =>
          r.identity.id !== resultIdentity.id &&
          recordIds.indexOf(r.identity.id) === i &&
          !artifactIds.includes(r.identity.id),
      )
      .map((r) => ({ id: r.identity.id, schema: r.schema, privacy: r.privacy ?? 'metadata' })),
    ...request.outputs
      .filter((o) => o.id !== resultIdentity.id)
      .map((o) => ({
        id: o.id,
        schema: o.mediaType.slice(0, 128) || 'application/octet-stream',
        privacy: 'source-derived' as const,
      })),
  ];

  request.beforeAccept?.();
  hooks?.at?.('before-staging', context);
  request.beforeAccept?.();
  store.ledger.registerStaging(stageId, staged, { work, attemptId });
  hooks?.at?.('after-staging', context);
  let receipts: StoredObject[];
  try {
    request.beforeAccept?.();
    receipts = [await store.objects.putCanonicalJson(request.result, { expect: resultIdentity })];
    request.beforeAccept?.();
    for (const r of records) {
      if (staged.some((s) => s.id === r.identity.id && s.schema === r.schema)) {
        receipts.push(await store.objects.putCanonicalJson(r.value, { expect: r.identity }));
        request.beforeAccept?.();
      }
    }
    for (const o of request.outputs) {
      if (o.id === resultIdentity.id) continue;
      const bytes = readFileSync(o.path);
      receipts.push(await store.objects.put(bytes, { expect: { id: o.id as ArtifactId, rawSize: bytes.byteLength } }));
      request.beforeAccept?.();
    }
  } catch (error) {
    // Nothing is accepted; the stage is removed so its pins do not outlive the attempt. Its bytes wait for collection.
    try {
      store.ledger.abortStaging(stageId);
    } catch {
      /* recovery aborts a stage left open */
    }
    throw error;
  }
  hooks?.at?.('after-objects', context);
  const outputs = [...new Set([resultIdentity.id, ...recordIds, ...artifactIds])];
  receipts = receipts.filter((r, i) => receipts.findIndex((x) => x.id === r.id) === i);
  // No await from here to the acceptance: what beforeAccept checked still holds when the ledger commits.
  try {
    request.beforeAccept?.();
  } catch (error) {
    try {
      store.ledger.abortStaging(stageId);
    } catch {
      /* recovery aborts a stage left open */
    }
    throw error;
  }
  const receipt = store.ledger.publish({ work, attemptId, stageId, receipts, outputs, endedAt: request.endedAt });
  hooks?.at?.('after-publish', context);
  return receipt;
}
