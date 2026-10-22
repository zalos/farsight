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
export type PublicationBoundary = typeof PUBLICATION_BOUNDARIES[number];

export interface BoundaryContext { work: WorkRef; attemptId: Id }

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
}

/**
 * Stage, store and publish one result. The result message is the first output and links every worker artifact,
 * so a publication always has at least one artifact and the artifacts stay reachable through it.
 */
export async function publishOutcome(request: PublishRequest): Promise<PublicationReceipt> {
  const { store, work, attemptId, hooks } = request;
  const context = { work, attemptId };
  const stageId = stageIdFor(attemptId);
  const artifactIds = request.outputs.map(o => o.id);
  const resultIdentity = store.objects.identifyCanonicalJson(request.result);
  const staged: StagedArtifact[] = [
    { id: resultIdentity.id, schema: RESULT_SCHEMA, privacy: 'source-derived', links: [...new Set(artifactIds)].filter(id => id !== resultIdentity.id) },
    ...request.outputs.filter(o => o.id !== resultIdentity.id)
      .map(o => ({ id: o.id, schema: o.mediaType.slice(0, 128) || 'application/octet-stream', privacy: 'source-derived' as const })),
  ];

  hooks?.at?.('before-staging', context);
  store.ledger.registerStaging(stageId, staged, { work, attemptId });
  hooks?.at?.('after-staging', context);
  let receipts: StoredObject[];
  try {
    receipts = [await store.objects.putCanonicalJson(request.result, { expect: resultIdentity })];
    for (const o of request.outputs) {
      if (o.id === resultIdentity.id) continue;
      const bytes = readFileSync(o.path);
      receipts.push(await store.objects.put(bytes, { expect: { id: o.id as ArtifactId, rawSize: bytes.byteLength } }));
    }
  } catch (error) {
    // Nothing is accepted; the stage is removed so its pins do not outlive the attempt. Its bytes wait for collection.
    try { store.ledger.abortStaging(stageId); } catch { /* recovery aborts a stage left open */ }
    throw error;
  }
  hooks?.at?.('after-objects', context);
  const receipt = store.ledger.publish({ work, attemptId, stageId, receipts, outputs: [resultIdentity.id, ...artifactIds.filter(id => id !== resultIdentity.id)], endedAt: request.endedAt });
  hooks?.at?.('after-publish', context);
  return receipt;
}
