// The trusted adapter registry: the only source of what a worker is allowed to be. A registration is built by
// Sentinel's own code, never read from a repository, a settings file or a worker. Each adapter's digest is the
// SHA-256 of its canonical definition (for a built-in worker, including its module bytes), so a worker that
// announces another identity, or a definition changed after registration, is refused.
//
// Two kinds exist and they are not interchangeable:
// - external: a third-party tool. Container isolation only, an image pinned by digest, a fixed argument list.
// - built-in: a worker shipped in Sentinel's own package (parsers and similar). A local child process with no
//   inherited environment; its module is hashed at registration and again before every start.
// No production external adapter is registered yet; PR 10 onwards adds them with their measured pins.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Digest, Id } from '../contracts/common.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { ExecutionError } from './errors.js';

/** Ceilings for one attempt. Defaults are PR 01's accepted proposal (feasibility-decisions.json resourceDefaults). */
export interface AdapterLimits {
  memoryBytes: number;
  cpus: number;
  pids: number;
  tmpfsBytes: number;
  timeoutMs: number;
  /** Total protocol bytes on stdout. */
  stdoutBytes: number;
  /** Diagnostic bytes kept from stderr; more is counted and dropped, never parsed. */
  stderrBytes: number;
  maxFrameBytes: number;
  /** Total bytes the worker may leave in its output folder. */
  outputBytes: number;
  /** How long a canceled worker has to acknowledge before it is stopped. */
  cancelGraceMs: number;
  /** How long a worker has to announce itself after it starts. */
  helloTimeoutMs: number;
}

export const DEFAULT_ADAPTER_LIMITS: Readonly<AdapterLimits> = Object.freeze({
  memoryBytes: 2_147_483_648, cpus: 2, pids: 128, tmpfsBytes: 268_435_456, timeoutMs: 120_000,
  stdoutBytes: 4_194_304, stderrBytes: 262_144, maxFrameBytes: 1_048_576, outputBytes: 268_435_456,
  cancelGraceMs: 5_000, helloTimeoutMs: 15_000,
});

const LIMIT_BOUNDS: Record<keyof AdapterLimits, [number, number]> = {
  memoryBytes: [16 * 1024 * 1024, 16 * 1024 ** 3], cpus: [1, 64], pids: [8, 4096], tmpfsBytes: [1024 * 1024, 4 * 1024 ** 3],
  timeoutMs: [100, 24 * 3_600_000], stdoutBytes: [1024, 1024 ** 3], stderrBytes: [0, 64 * 1024 * 1024],
  maxFrameBytes: [1024, 4 * 1024 * 1024], outputBytes: [0, 16 * 1024 ** 3], cancelGraceMs: [0, 120_000], helloTimeoutMs: [100, 300_000],
};

export const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

export interface ExternalAdapterDefinition {
  id: Id;
  version: string;
  kind: 'external';
  isolation: 'container';
  /** `repository@sha256:<digest>`; installed ahead of time, never pulled at run time. */
  image: string;
  /** The executable and its fixed arguments inside the image. Nothing from a repository is added. */
  command: readonly string[];
  limits?: Partial<AdapterLimits>;
}

export interface BuiltInAdapterDefinition {
  id: Id;
  version: string;
  kind: 'built-in';
  isolation: 'child';
  /** Absolute path of the worker module, run with this process's Node and no inherited environment. */
  module: string;
  limits?: Partial<AdapterLimits>;
}

export type AdapterDefinition = ExternalAdapterDefinition | BuiltInAdapterDefinition;

export type TrustedAdapter =
  | (Readonly<Omit<ExternalAdapterDefinition, 'limits'>> & { readonly digest: Digest; readonly limits: Readonly<AdapterLimits> })
  | (Readonly<Omit<BuiltInAdapterDefinition, 'limits'>> & { readonly digest: Digest; readonly limits: Readonly<AdapterLimits>; readonly moduleDigest: Digest });

export interface AdapterRegistry {
  get(id: Id): TrustedAdapter;
  readonly ids: readonly Id[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const invalid = (reason: string): never => { throw new ExecutionError('sentinel.execution.adapterInvalid', { reason }); };

function limitsOf(partial: Partial<AdapterLimits> | undefined): Readonly<AdapterLimits> {
  const limits = { ...DEFAULT_ADAPTER_LIMITS, ...(partial ?? {}) };
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS) as [keyof AdapterLimits, [number, number]][]) {
    const v = limits[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) invalid(`limit ${key}`);
  }
  if (Object.keys(limits).length !== Object.keys(DEFAULT_ADAPTER_LIMITS).length) invalid('unknown limit');
  return Object.freeze(limits);
}

/** Hash a built-in module's bytes; refuses links and non-files. */
export function moduleDigestOf(path: string): Digest {
  let s;
  try { s = lstatSync(path); } catch { return invalid('module unreadable'); }
  if (!s.isFile()) invalid('module is not a regular file');
  return sha256(readFileSync(path));
}

function trusted(def: AdapterDefinition): TrustedAdapter {
  if (!def || typeof def !== 'object') invalid('definition');
  if (!ID.test(def.id ?? '')) invalid('id');
  if (typeof def.version !== 'string' || !def.version || def.version.length > 64) invalid('version');
  const limits = limitsOf(def.limits);
  if (def.kind === 'external') {
    if (def.isolation !== 'container') throw new ExecutionError('sentinel.execution.adapterIsolationRefused', { adapter: (def as AdapterDefinition).id });
    if (!IMAGE_REFERENCE.test(def.image ?? '')) invalid('image must be pinned as repository@sha256:<digest>');
    if (!Array.isArray(def.command) || !def.command.length || def.command.length > 64
      || def.command.some(a => typeof a !== 'string' || a.length > 65_536 || a.includes('\0'))
      || def.command.reduce((n, a) => n + a.length, 0) > 262_144) invalid('command');
    const body = { id: def.id, version: def.version, kind: def.kind, isolation: def.isolation, image: def.image, command: [...def.command], limits };
    return Object.freeze({ ...body, command: Object.freeze([...def.command]), digest: sha256(canonicalJsonBytes(body)) });
  }
  if (def.kind === 'built-in') {
    if (def.isolation !== 'child') invalid('built-in workers run as a child process');
    if (typeof def.module !== 'string' || !isAbsolute(def.module)) invalid('module must be an absolute path');
    const moduleDigest = moduleDigestOf(def.module);
    const body = { id: def.id, version: def.version, kind: def.kind, isolation: def.isolation, module: def.module, moduleDigest, limits };
    return Object.freeze({ ...body, digest: sha256(canonicalJsonBytes(body)) });
  }
  return invalid('kind');
}

export function createAdapterRegistry(definitions: readonly AdapterDefinition[]): AdapterRegistry {
  const byId = new Map<Id, TrustedAdapter>();
  for (const def of definitions) {
    const adapter = trusted(def);
    if (byId.has(adapter.id)) invalid(`duplicate id ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  const ids = Object.freeze([...byId.keys()]);
  return Object.freeze({
    ids,
    get(id: Id): TrustedAdapter {
      const adapter = byId.get(id);
      if (!adapter) throw new ExecutionError('sentinel.execution.adapterUnknown', { adapter: String(id).slice(0, 128) });
      return adapter;
    },
  });
}

/** The production registry. Empty until the scanner PRs register their measured, pinned adapters. */
export const TRUSTED_ADAPTERS: AdapterRegistry = createAdapterRegistry([]);
