// Paths worker data boundary (ADR 45). This pure reader verifies sealed bytes and source binding, not the
// authority to use them: request admission and the driver must obtain the shared retained-source proof first.
// It launches nothing, reads no workspace paths, publishes nothing, and assigns no security coverage.
import { createHash } from 'node:crypto';
import type { ArtifactId, PathEvidenceEnvelope, PathRequestEnvelope, SnapshotEnvelope } from '../../contracts/index.js';
import type { AnalysisArtifact } from '@farsight/code-parser';
import type { ParserIndex, ParserResult } from '../../snapshot/parser.js';
import { validateEnvelope } from '../../validate.js';
import { boundedCallPaths } from './paths.js';
import { parsePathRequest, PathRequestError } from './request.js';

export const PATHS_JOB_SCHEMA = 'sentinel-bounded-paths-job/draft-1';
export const PATHS_OUTPUT_SCHEMA = 'sentinel-bounded-paths-output/draft-1';
export const PATHS_OUTPUT_MEDIA = 'application/vnd.sentinel.bounded-paths+json';
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_JOB_BYTES = 4096;
const MAX_INPUTS = 200_006;
const ID = /^sha256:[0-9a-f]{64}$/;

/** Only immutable object references; the request itself names the exact ancestor, queries, source and bounds. */
export interface PathsJob {
  readonly schema: typeof PATHS_JOB_SCHEMA;
  readonly request: ArtifactId;
  readonly snapshot: ArtifactId;
  readonly analysis: { readonly artifact: ArtifactId; readonly result: ArtifactId; readonly index: ArtifactId };
}

export interface PathsOutput {
  readonly schema: typeof PATHS_OUTPUT_SCHEMA;
  readonly job: ArtifactId;
  readonly request: ArtifactId;
  readonly ancestor: PathRequestEnvelope['ancestor'];
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly evidence: PathEvidenceEnvelope;
  /** What this invocation read, never a substitute for the coordinator's sealed-input/admission proof. */
  readonly actualReadSet: readonly ArtifactId[];
}

const hash = (b: Uint8Array): ArtifactId => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const fail = (): never => { throw new PathRequestError('unbound'); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function keys(v: unknown, names: readonly string[]): v is Record<string, unknown> {
  return object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
}
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); }
}

/** Fixed closed protocol: no worker path, function, profile, authorization, or caller-selected file read. */
export function parsePathsJob(bytes: Uint8Array): PathsJob {
  if (bytes.byteLength > MAX_JOB_BYTES) return fail();
  const value = json(bytes);
  if (!keys(value, ['schema', 'request', 'snapshot', 'analysis']) || value.schema !== PATHS_JOB_SCHEMA
    || !keys(value.analysis, ['artifact', 'result', 'index'])
    || [value.request, value.snapshot, ...Object.values(value.analysis)].some(v => typeof v !== 'string' || !ID.test(v))) return fail();
  return value as unknown as PathsJob;
}

/**
 * Inspects one job using only its attempt's sealed input IDs. The callback is an object-byte reader, never a path
 * reader. Canonical admission/producer authority is deliberately not reconstructed from these structural objects.
 */
export async function inspectPathInputs(jobBytes: Uint8Array, inputs: readonly string[], read: (id: ArtifactId) => Promise<Uint8Array>): Promise<PathsOutput> {
  const job = parsePathsJob(jobBytes);
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS || inputs.some(id => typeof id !== 'string' || !ID.test(id))) return fail();
  const allowed = new Set(inputs);
  const jobId = hash(jobBytes);
  if (!allowed.has(jobId)) return fail();
  const cache = new Map<ArtifactId, Promise<Uint8Array>>();
  const actual = new Set<ArtifactId>([jobId]);
  const get = (id: ArtifactId): Promise<Uint8Array> => {
    if (!allowed.has(id) || !ID.test(id)) return Promise.reject(new PathRequestError('unbound'));
    let pending = cache.get(id);
    if (!pending) {
      pending = (async () => {
        const returned = await read(id);
        if (!(returned instanceof Uint8Array) || returned.byteLength > MAX_OBJECT_BYTES) return fail();
        const bytes = Uint8Array.from(returned);
        if (hash(bytes) !== id) return fail();
        actual.add(id);
        return bytes;
      })();
      cache.set(id, pending);
    }
    return pending;
  };
  // The job supplied by the launcher must itself be the same sealed bytes, not an independent look-alike argument.
  if (!Buffer.from(await get(jobId)).equals(Buffer.from(jobBytes))) return fail();
  const request = parsePathRequest(await get(job.request));
  if (request.id !== job.request) return fail();
  const rawSnapshot = json(await get(job.snapshot));
  const checked = validateEnvelope('snapshot', rawSnapshot);
  if (!checked.ok) return fail();
  const snapshot = checked.value as SnapshotEnvelope;
  const artifact = json(await get(job.analysis.artifact)) as AnalysisArtifact;
  const result = json(await get(job.analysis.result)) as ParserResult & { artifact: ArtifactId; index: ArtifactId };
  const index = json(await get(job.analysis.index)) as ParserIndex;
  const { snapshotId, sourceId, ancestor, queries, bounds } = request.value;
  if (snapshot.id !== snapshotId || !snapshot.sources.some(s => s.sourceId === sourceId)
    || result?.schema !== 'sentinel-parser-result/draft-1' || index?.schema !== 'sentinel-parser-index/draft-1'
    || result.snapshotId !== snapshotId || result.sourceId !== sourceId
    || result.artifact !== job.analysis.artifact || result.index !== job.analysis.index
    || result.analysisFingerprint !== index.analysisFingerprint || artifact?.analysis?.fingerprint !== result.analysisFingerprint) return fail();
  const captured = new Set(snapshot.entries.filter(e => e.sourceId === sourceId && e.kind === 'file' && e.disposition === 'included').map(e => 'content' in e ? e.content : ''));
  const evidence = await boundedCallPaths({
    snapshot, analysis: { sourceId, artifact, index }, queries, bounds,
    readContent: id => captured.has(id as ArtifactId) ? get(id as ArtifactId) : Promise.reject(new PathRequestError('unbound')),
  });
  const output: PathsOutput = {
    schema: PATHS_OUTPUT_SCHEMA, job: jobId, request: request.id, ancestor: { ...ancestor }, snapshotId, sourceId,
    evidence, actualReadSet: [...actual].sort(),
  };
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_OBJECT_BYTES) return fail();
  return output;
}
