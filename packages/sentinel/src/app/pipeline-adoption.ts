// Owner adoption of `.farsight/sentinel/pipeline.json`, exactly as the settings are adopted (policy/adoption.ts): the
// file sits in a checkout, so its place there proves nothing. An adoption record in the owner's trust folder names
// the pipeline's digest, which covers the file's bytes and the digest of every stage and skill pack it names, and
// the canonical workspace identity it was adopted for. A changed byte (the file's or a pack's) is not adopted.
//
// The receipt is a `settings.adopt` receipt for the pipeline's digest and a target naming the pipeline: the same owner
// action and the same three verdicts as the settings, and an intent the settings' own adoption can never match.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActionIntent,
  Digest,
  PackRef,
  PipelineAdoptionEnvelope,
  PipelineDefinition,
} from '../contracts/index.js';
import { validateEnvelope } from '../validate.js';
import { canonicalDigest, sha256Digest } from '../policy/digest.js';
import { PolicyError } from '../policy/errors.js';
import { assertTrustOutside, workspaceIdentity, type WorkspaceIdentity } from '../policy/adoption.js';
import { intentDigest, receiptAuthority, stamp, type ConsumedReceipt } from '../policy/receipts.js';
import { ensurePrivateDir, readCheckoutFile, readPrivateFile, writePrivateFileAtomic } from '../policy/user-state.js';
import { MAX_PIPELINE_BYTES, PIPELINE_PATH, PipelineError, packRefsOf, parsePipeline } from './pipeline.js';

/** The target a pipeline adoption's intent names beside the workspace, so it is never a settings adoption. */
export const PIPELINE_TARGET = 'sentinel.pipeline';

/** How far the workspace's pipeline file is trusted. Only `adopted` is planned from. */
export type PipelineTrust = 'missing' | 'not-adopted' | 'changed' | 'adopted' | 'invalid';

/** The workspace's pipeline as read now, with the digest that covers it and the pack bytes it names. */
export interface WorkspacePipeline {
  readonly pipeline: PipelineDefinition;
  readonly fileDigest: Digest;
  /** Every pack the pipeline names, with the digest of its bytes now; a pack that is not there is `null`. */
  readonly packs: readonly { readonly ref: PackRef; readonly digest: Digest | null }[];
  readonly digest: Digest;
}

/** Resolves a stage or skill pack reference to the digest of its bytes, or undefined when it is not promoted. */
export type PackResolver = (ref: PackRef) => Digest | undefined;

/** No stage or skill pack is promoted in this build yet: every reference resolves to nothing. */
export const NO_PACKS: PackResolver = () => undefined;

/** The pipeline's digest: its file's bytes and every pack it names, in a fixed order. */
export function pipelineDigestOf(fileDigest: Digest, packs: WorkspacePipeline['packs']): Digest {
  return canonicalDigest({
    kind: 'sentinel-pipeline-digest/1',
    file: fileDigest,
    packs: [...packs].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
  }) as Digest;
}

/** Reads and parses the workspace's pipeline file, or undefined when there is none. */
export function readWorkspacePipeline(
  workspace: string,
  resolve: PackResolver = NO_PACKS,
): WorkspacePipeline | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = readCheckoutFile(join(workspace, PIPELINE_PATH), MAX_PIPELINE_BYTES, 'sentinel.policy.settingsUnreadable', {
      nonblocking: true,
    });
  } catch (e) {
    if (e instanceof PolicyError) throw new PipelineError('sentinel.pipeline.unreadable', e.message);
    throw e;
  }
  if (!bytes) return undefined;
  const pipeline = parsePipeline(bytes);
  const fileDigest = sha256Digest(bytes) as Digest;
  const packs = packRefsOf(pipeline).map((ref) => Object.freeze({ ref, digest: resolve(ref) ?? null }));
  return Object.freeze({
    pipeline,
    fileDigest,
    packs: Object.freeze(packs),
    digest: pipelineDigestOf(fileDigest, packs),
  });
}

const adoptionFile = (ws: WorkspaceIdentity) => `pipeline-adoption-${ws.digest.slice('sha256:'.length)}.json`;

function trustFolder(trustDir: string, ws: WorkspaceIdentity, readOnly: boolean): string {
  assertTrustOutside(trustDir, ws.path);
  if (!readOnly) ensurePrivateDir(trustDir, 'sentinel.policy.trustDirUnsafe');
  return trustDir;
}

/** What a pipeline adoption confirms: these pipeline and pack bytes, for this workspace. */
export function pipelineAdoptionIntent(
  workspace: string,
  resolve: PackResolver = NO_PACKS,
): { intent: ActionIntent; read: WorkspacePipeline } {
  const ws = workspaceIdentity(workspace);
  const read = readWorkspacePipeline(ws.path, resolve);
  if (!read) throw new PipelineError('sentinel.pipeline.unreadable', `${PIPELINE_PATH} does not exist`);
  const missing = read.packs.find((p) => p.digest === null);
  if (missing) throw new PipelineError('sentinel.pipeline.unknownPack', `${missing.ref} is not a promoted pack`);
  return {
    read,
    intent: {
      action: 'settings.adopt',
      input: read.digest,
      effects: [],
      budget: { maxTokens: null, maxCost: null, currency: null },
      scope: { profile: null, provider: null, targets: [ws.digest, PIPELINE_TARGET] },
    },
  };
}

/** Records the owner's adoption of the workspace's pipeline, with a receipt spent for exactly its intent. */
export function adoptPipeline(options: {
  workspace: string;
  trustDir: string;
  receipt: ConsumedReceipt;
  now: Date;
  resolve?: PackResolver;
}): PipelineAdoptionEnvelope {
  const ws = workspaceIdentity(options.workspace);
  const dir = trustFolder(options.trustDir, ws, false);
  const { intent, read } = pipelineAdoptionIntent(ws.path, options.resolve);
  const authority = receiptAuthority(options.receipt);
  if (!authority || authority.action !== 'settings.adopt' || authority.intentDigest !== intentDigest(intent))
    throw new PipelineError(
      'sentinel.pipeline.adoptionUnauthorized',
      'adoption needs the owner’s spent receipt for this pipeline in this workspace',
    );
  const record: PipelineAdoptionEnvelope = {
    schema: 'sentinel-pipeline-adoption/draft-1',
    workspaceIdentity: ws.digest as Digest,
    workspacePath: ws.path,
    pipelineId: read.pipeline.id,
    revision: read.pipeline.revision,
    fileDigest: read.fileDigest,
    packs: read.packs.map((p) => ({ ref: p.ref, digest: p.digest! })),
    digest: read.digest,
    receipt: authority.digest as Digest,
    adoptedAt: stamp(options.now),
  };
  const checked = validateEnvelope('pipelineadoption', record);
  if (!checked.ok)
    throw new PipelineError(
      'sentinel.pipeline.adoptionUnauthorized',
      `the adoption record does not validate: ${checked.errors[0]?.message ?? 'invalid'}`,
    );
  writePrivateFileAtomic(dir, adoptionFile(ws), Buffer.from(JSON.stringify(record)), 'sentinel.policy.trustDirUnsafe');
  return Object.freeze(record);
}

/** The workspace's pipeline and how far it is trusted. Only `adopted` carries a pipeline to plan from. */
export function loadPipeline(options: {
  workspace: string;
  trustDir: string;
  resolve?: PackResolver;
  readOnly?: boolean;
}): { trust: PipelineTrust; read?: WorkspacePipeline; error?: PipelineError } {
  const ws = workspaceIdentity(options.workspace);
  let read: WorkspacePipeline | undefined;
  try {
    read = readWorkspacePipeline(ws.path, options.resolve);
  } catch (e) {
    if (e instanceof PipelineError) return { trust: 'invalid', error: e };
    throw e;
  }
  if (!read) return { trust: 'missing' };
  const dir = trustFolder(options.trustDir, ws, options.readOnly === true);
  let recordBytes: Buffer | undefined;
  try {
    recordBytes = readPrivateFile(
      join(realpathSync.native(dir), adoptionFile(ws)),
      64 * 1024,
      'sentinel.policy.trustDirUnsafe',
      {
        repairTemporaryAliases: options.readOnly !== true,
      },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') recordBytes = undefined;
    else throw e;
  }
  if (!recordBytes) return { trust: 'not-adopted', read };
  let record: unknown;
  try {
    record = JSON.parse(recordBytes.toString('utf8'));
  } catch {
    return { trust: 'not-adopted', read };
  }
  const checked = validateEnvelope('pipelineadoption', record);
  if (!checked.ok || checked.value.workspaceIdentity !== ws.digest || checked.value.workspacePath !== ws.path)
    return { trust: 'not-adopted', read };
  return { trust: checked.value.digest === read.digest ? 'adopted' : 'changed', read };
}
