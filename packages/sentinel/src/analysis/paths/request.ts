// Canonical structural requests (ADR 45): bounded source-derived data only. Parsing or identifying this object
// grants no access to retained evidence and no authority to execute, publish, confirm or import anything.
import type { ArtifactId, Digest, PathRequestEnvelope } from '../../contracts/index.js';
import { MAX_PATH_REQUEST_BYTES, MAX_PATH_REQUEST_QUERIES } from '../../contracts/pathrequest.js';
export { MAX_PATH_REQUEST_BYTES, MAX_PATH_REQUEST_QUERIES } from '../../contracts/pathrequest.js';
import { validateEnvelope } from '../../validate.js';
import { deepFreeze } from '../../policy/immutable.js';
import { digestOf } from '../../store/ledger-json.js';

export const PATH_REQUEST_SCHEMA = 'sentinel-path-request/draft-1' as const;
// The fixed worker protocol allows 1024 sealed IDs, including job, request and four retained roles.
export const PATHS_PROTOCOL_INPUT_LIMIT = 1024;
export const PATHS_RESERVED_INPUTS = 6;
export const PATHS_ADAPTER_ID = 'bounded-paths';

export class PathRequestError extends Error {
  readonly code: 'sentinel.paths.unbound' | 'sentinel.paths.invalidInput';
  constructor(readonly reason: 'invalid' | 'too-large' | 'unbound') {
    super(reason === 'unbound' ? 'sentinel.paths.unbound' : 'sentinel.paths.invalidInput');
    this.name = 'PathRequestError';
    this.code=reason==='unbound'?'sentinel.paths.unbound':'sentinel.paths.invalidInput';
  }
}

export interface CanonicalPathRequest {
  readonly id: ArtifactId;
  readonly value: Readonly<PathRequestEnvelope>;
}

/** Validates before copying or hashing; canonical order is explicit rather than guessed or silently broadened. */
export function pathRequestOf(value: unknown): CanonicalPathRequest {
  const queries = value !== null && typeof value === 'object' ? (value as { queries?: unknown }).queries : undefined;
  if (!Array.isArray(queries) || !queries.length || queries.length > MAX_PATH_REQUEST_QUERIES) throw new PathRequestError('invalid');
  const checked = validateEnvelope('pathrequest', value);
  if (!checked.ok) throw new PathRequestError('invalid');
  const copy = deepFreeze(structuredClone(checked.value));
  return Object.freeze({ id: digestOf(copy) as ArtifactId, value: copy });
}

/** The byte bound and strict UTF-8 check run before JSON parsing, schema work, sorting or any store access. */
export function parsePathRequest(document: string | Uint8Array): CanonicalPathRequest {
  const size = typeof document === 'string' ? Buffer.byteLength(document, 'utf8') : document.byteLength;
  if (size > MAX_PATH_REQUEST_BYTES) throw new PathRequestError('too-large');
  let value: unknown;
  try {
    const text = typeof document === 'string' ? document : new TextDecoder('utf-8', { fatal: true }).decode(document);
    value = JSON.parse(text);
  } catch { throw new PathRequestError('invalid'); }
  return pathRequestOf(value);
}


/** The linked task's deterministic request/generation identity, still data rather than execution authority. */
export function pathRequestRunId(request: unknown, terms: { ruleLockDigest: Digest; policyDigest: Digest; profileDigest: Digest }, generation = 0, unitSet?: readonly string[]): string {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 2_147_483_647) throw new PathRequestError('invalid');
  const { ruleLockDigest, policyDigest, profileDigest } = terms;
  for (const value of [ruleLockDigest, policyDigest, profileDigest]) if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new PathRequestError('invalid');
  if(unitSet!==undefined&&(!Array.isArray(unitSet)||!unitSet.length||unitSet.length>1024||unitSet.some(x=>typeof x!=='string'||x.length>65536)||new Set(unitSet).size!==unitSet.length||unitSet.reduce((n,x)=>n+Buffer.byteLength(x,'utf8'),0)>MAX_PATH_REQUEST_BYTES))throw new PathRequestError('invalid');
  const canonical = pathRequestOf(request);
  return `run-${digestOf({ structuralPaths: canonical.id, ruleLockDigest, policyDigest, profileDigest, generation, ...(unitSet?{unitSet:[...unitSet].sort()}:{}) }).slice(7, 39)}`;
}
