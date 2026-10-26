// The trusted adapter registry: the only source of what a worker is allowed to be. A registration is built by
// Sentinel's own code, never read from a repository, a settings file or a worker. Each adapter's digest is the
// SHA-256 of its canonical definition (for a built-in worker, including its module bytes), so a worker that
// announces another identity, or a definition changed after registration, is refused.
//
// Three kinds exist and they are not interchangeable:
// - external: a third-party tool. Container isolation only, an image pinned by digest, a fixed argument list.
// - built-in: a worker shipped in Sentinel's own package (parsers and similar). A local child process with no
//   inherited environment; its module is hashed at registration and again before every start.
// - operation: one of Sentinel's own bootstrap operations (capture, parse, inventory), run by the coordinator in its
//   own process over the store it owns, never as a worker. Its digest covers the bytes of the Sentinel module that
//   implements it, so a plan bound to it is bound to that implementation.
//
// A check adapter also states the finest coverage granularity its engine can establish (`coverage`, default
// `aggregate`). The coordinator never records coverage finer than this, whatever a result claims.
// No production external adapter is registered yet; PR 10 onwards adds them with their measured pins.
import { reviewOperationPath } from './assets.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Digest, Id } from '../contracts/common.js';
import type { CoverageGranularity } from '../contracts/coverage.js';
import type { ResourcePolicy } from '../contracts/work.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { ExecutionError } from './errors.js';
import { CAPTURE_IMPLEMENTATION_URL } from '../snapshot/capture.js';
import { PARSE_IMPLEMENTATION_URL } from '../snapshot/parser.js';
import { INVENTORY_IMPLEMENTATION_URL } from './bootstrap.js';

/**
 * Limits for one attempt. The ceilings are PR 01's accepted resource defaults (feasibility-decisions.json
 * resourceDefaults): an adapter may lower any of them and raise none. stdout and stderr together are held to
 * the accepted 4 MiB of process output.
 */
export interface AdapterLimits {
  memoryBytes: number;
  cpus: number;
  pids: number;
  tmpfsBytes: number;
  timeoutMs: number;
  /** Protocol bytes on stdout. */
  stdoutBytes: number;
  /** Diagnostic bytes kept from stderr; more is counted and dropped, never parsed. */
  stderrBytes: number;
  maxFrameBytes: number;
  /** Total bytes the worker may leave in its output folder, and the per-file size ceiling. */
  outputBytes: number;
  /** How long a canceled worker has to acknowledge before it is stopped. */
  cancelGraceMs: number;
  /** How long a worker has to announce itself after it starts. */
  helloTimeoutMs: number;
}

/** The accepted ceilings (and the defaults). */
export const ACCEPTED_CEILINGS: Readonly<AdapterLimits> = Object.freeze({
  memoryBytes: 2_147_483_648,
  cpus: 2,
  pids: 128,
  tmpfsBytes: 268_435_456,
  timeoutMs: 120_000,
  stdoutBytes: 3_932_160,
  stderrBytes: 262_144,
  maxFrameBytes: 1_048_576,
  // No accepted figure exists for the output folder; the per-object ceiling (maxDecodedObjectBytes, 16 MiB) bounds
  // what the store can accept, and this is held to the scratch figure the matrix accepted for temporary storage.
  outputBytes: 268_435_456,
  cancelGraceMs: 5_000,
  helloTimeoutMs: 15_000,
});
export const DEFAULT_ADAPTER_LIMITS: Readonly<AdapterLimits> = ACCEPTED_CEILINGS;
export const MAX_PROCESS_OUTPUT_BYTES = 4_194_304;

const LIMIT_FLOORS: Record<keyof AdapterLimits, number> = {
  memoryBytes: 16 * 1024 * 1024,
  cpus: 1,
  pids: 8,
  tmpfsBytes: 1024 * 1024,
  timeoutMs: 100,
  stdoutBytes: 1024,
  stderrBytes: 0,
  maxFrameBytes: 1024,
  outputBytes: 0,
  cancelGraceMs: 0,
  helloTimeoutMs: 100,
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
  /** The finest coverage the engine establishes; `aggregate` when absent. */
  coverage?: CoverageGranularity;
}

export interface BuiltInAdapterDefinition {
  id: Id;
  version: string;
  kind: 'built-in';
  isolation: 'child';
  /** Absolute path of the worker module, run with this process's Node and no inherited environment. */
  module: string;
  limits?: Partial<AdapterLimits>;
  /** The finest coverage the worker establishes; `aggregate` when absent. */
  coverage?: CoverageGranularity;
}

export type BootstrapOperation = 'capture' | 'parse' | 'inventory';

export type CoordinatorOperation = BootstrapOperation | 'review-guided' | 'review-general';

export interface OperationAdapterDefinition {
  id: Id;
  version: string;
  kind: 'operation';
  operation: CoordinatorOperation;
}

export type AdapterDefinition = ExternalAdapterDefinition | BuiltInAdapterDefinition | OperationAdapterDefinition;

export type TrustedAdapter =
  | (Readonly<Omit<ExternalAdapterDefinition, 'limits' | 'coverage'>> & {
      readonly digest: Digest;
      readonly limits: Readonly<AdapterLimits>;
      readonly coverage: CoverageGranularity;
    })
  | (Readonly<Omit<BuiltInAdapterDefinition, 'limits' | 'coverage'>> & {
      readonly digest: Digest;
      readonly limits: Readonly<AdapterLimits>;
      readonly moduleDigest: Digest;
      readonly coverage: CoverageGranularity;
    })
  | (Readonly<OperationAdapterDefinition> & {
      readonly digest: Digest;
      readonly limits: Readonly<AdapterLimits>;
      readonly moduleDigest: Digest;
      readonly coverage: 'aggregate';
    });

/**
 * The file each bootstrap operation's implementation runs from, as that module itself reports it (import.meta.url),
 * so the digest stays the implementation's bytes whether the code is in the workspace dist or a packed bundle chunk.
 */
const OPERATION_MODULES: Readonly<Record<BootstrapOperation, string>> = Object.freeze({
  capture: CAPTURE_IMPLEMENTATION_URL,
  parse: PARSE_IMPLEMENTATION_URL,
  inventory: INVENTORY_IMPLEMENTATION_URL,
});
const GRANULARITIES: readonly CoverageGranularity[] = ['per-file-per-rule', 'per-file', 'aggregate'];
const coverageOf = (v: unknown): CoverageGranularity => {
  if (v === undefined) return 'aggregate';
  if (!GRANULARITIES.includes(v as CoverageGranularity)) invalid('coverage granularity');
  return v as CoverageGranularity;
};

export interface AdapterRegistry {
  get(id: Id): TrustedAdapter;
  readonly ids: readonly Id[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const invalid = (reason: string): never => {
  throw new ExecutionError('sentinel.execution.adapterInvalid', { reason });
};

function limitsOf(partial: Partial<AdapterLimits> | undefined): Readonly<AdapterLimits> {
  for (const key of Object.keys(partial ?? {})) if (!(key in ACCEPTED_CEILINGS)) invalid(`unknown limit ${key}`);
  const given = partial ?? {};
  const limits = { ...ACCEPTED_CEILINGS, ...given };
  // Defaults that depend on a lowered limit follow it; an explicit contradiction is still refused below.
  if (given.helloTimeoutMs === undefined) limits.helloTimeoutMs = Math.min(limits.helloTimeoutMs, limits.timeoutMs);
  if (given.cancelGraceMs === undefined) limits.cancelGraceMs = Math.min(limits.cancelGraceMs, limits.timeoutMs);
  if (given.maxFrameBytes === undefined) limits.maxFrameBytes = Math.min(limits.maxFrameBytes, limits.stdoutBytes);
  for (const key of Object.keys(ACCEPTED_CEILINGS) as (keyof AdapterLimits)[]) {
    const v = limits[key];
    // May lower an accepted ceiling, never raise one.
    if (!Number.isSafeInteger(v) || v < LIMIT_FLOORS[key] || v > ACCEPTED_CEILINGS[key]) invalid(`limit ${key}`);
  }
  if (limits.stdoutBytes + limits.stderrBytes > MAX_PROCESS_OUTPUT_BYTES)
    invalid('stdout and stderr exceed the process output ceiling');
  if (limits.maxFrameBytes > limits.stdoutBytes) invalid('limit maxFrameBytes');
  if (limits.helloTimeoutMs > limits.timeoutMs || limits.cancelGraceMs > limits.timeoutMs) invalid('limit timeouts');
  return Object.freeze(limits);
}

/**
 * The limits one attempt runs under: the adapter's, lowered by the work's own resource policy where that is
 * stricter (deadline, memory, CPU, processes, process output). A policy never raises a limit. The CPU quota may be
 * fractional (0.1–2); output is split so stdout and stderr together stay within the policy's output bound.
 */
export function effectiveLimits(adapter: Readonly<AdapterLimits>, policy?: ResourcePolicy): Readonly<AdapterLimits> {
  if (!policy) return adapter;
  const l = { ...adapter };
  l.timeoutMs = Math.min(l.timeoutMs, policy.deadlineMs);
  l.memoryBytes = Math.min(l.memoryBytes, policy.memoryBytes);
  l.cpus = Math.min(l.cpus, Math.max(0.1, Math.round(policy.cpuQuota * 100) / 100));
  l.pids = Math.min(l.pids, policy.maxPids);
  const combined = Math.min(l.stdoutBytes + l.stderrBytes, policy.maxOutputBytes);
  if (combined < l.stdoutBytes + l.stderrBytes) {
    l.stderrBytes = Math.min(l.stderrBytes, Math.floor(combined / 4));
    l.stdoutBytes = combined - l.stderrBytes;
  }
  l.maxFrameBytes = Math.min(l.maxFrameBytes, l.stdoutBytes);
  l.helloTimeoutMs = Math.min(l.helloTimeoutMs, l.timeoutMs);
  l.cancelGraceMs = Math.min(l.cancelGraceMs, l.timeoutMs);
  return Object.freeze(l);
}

/** Hash a built-in module's bytes; refuses links and non-files. */
export function moduleDigestOf(path: string): Digest {
  let s;
  try {
    s = lstatSync(path);
  } catch {
    return invalid('module unreadable');
  }
  if (!s.isFile()) invalid('module is not a regular file');
  return sha256(readFileSync(path));
}

function trusted(def: AdapterDefinition): TrustedAdapter {
  if (!def || typeof def !== 'object') invalid('definition');
  if (!ID.test(def.id ?? '')) invalid('id');
  if (typeof def.version !== 'string' || !def.version || def.version.length > 64) invalid('version');
  if (def.kind === 'operation') {
    const reviewing = def.operation === 'review-guided' || def.operation === 'review-general';
    if (!reviewing && !Object.hasOwn(OPERATION_MODULES, def.operation ?? '')) invalid('operation');
    const moduleDigest = moduleDigestOf(
      reviewing ? reviewOperationPath() : fileURLToPath(OPERATION_MODULES[def.operation as BootstrapOperation]),
    );
    const body = { id: def.id, version: def.version, kind: def.kind, operation: def.operation, moduleDigest };
    return Object.freeze({
      ...body,
      limits: ACCEPTED_CEILINGS,
      coverage: 'aggregate' as const,
      digest: sha256(canonicalJsonBytes(body)),
    });
  }
  const limits = limitsOf(def.limits);
  const coverage = coverageOf(def.coverage);
  if (def.kind === 'external') {
    if (def.isolation !== 'container')
      throw new ExecutionError('sentinel.execution.adapterIsolationRefused', {
        adapter: (def as AdapterDefinition).id,
      });
    if (!IMAGE_REFERENCE.test(def.image ?? '')) invalid('image must be pinned as repository@sha256:<digest>');
    if (
      !Array.isArray(def.command) ||
      !def.command.length ||
      def.command.length > 64 ||
      def.command.some((a) => typeof a !== 'string' || a.length > 65_536 || a.includes('\0')) ||
      def.command.reduce((n, a) => n + a.length, 0) > 262_144
    )
      invalid('command');
    const body = {
      id: def.id,
      version: def.version,
      kind: def.kind,
      isolation: def.isolation,
      image: def.image,
      command: [...def.command],
      limits,
      coverage,
    };
    return Object.freeze({
      ...body,
      command: Object.freeze([...def.command]),
      digest: sha256(canonicalJsonBytes(body)),
    });
  }
  if (def.kind === 'built-in') {
    if (def.isolation !== 'child') invalid('built-in workers run as a child process');
    if (typeof def.module !== 'string' || !isAbsolute(def.module)) invalid('module must be an absolute path');
    const moduleDigest = moduleDigestOf(def.module);
    const body = {
      id: def.id,
      version: def.version,
      kind: def.kind,
      isolation: def.isolation,
      module: def.module,
      moduleDigest,
      limits,
      coverage,
    };
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
      if (!adapter)
        throw new ExecutionError('sentinel.execution.adapterUnknown', { adapter: String(id).slice(0, 128) });
      return adapter;
    },
  });
}

/** The production registry. Empty until the scanner PRs register their measured, pinned adapters. */
export const TRUSTED_ADAPTERS: AdapterRegistry = createAdapterRegistry([]);
