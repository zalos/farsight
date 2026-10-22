// The Gitleaks adapter (PR 11): current-tree secret scanning through the PR 07 execution service, inside a pinned
// Linux container only. This module is the coordinator side: the trusted registration, the scan input the worker
// receives, and the reader that turns a worker outcome into checked observations and explicit coverage.
//
// - Registration. The container runs `node` with the worker module's compiled bytes as its program
//   (gitleaks-worker.ts), so the adapter digest pins the shim, and the image digest pins Node and Gitleaks. No
//   production pin is registered until a measured image exists: GITLEAKS_PINS is empty and nothing downloads one.
// - Input. The first input is a canonical manifest naming each captured file's source-relative path, content
//   digest and size; the others are exactly those contents. Nothing else from the repository reaches the worker,
//   and no repository ignore list, baseline or configuration is consulted (the worker's own header says how).
// - Reading. Every observation is re-validated here, outside the container, against its contract and against a
//   closed redaction shape: the detector's rule ID, a whole-line span of a captured file, a fixed message and fixed
//   limitation keys. Anything more is refused. A failed attempt, a refused observation or a captured file the
//   result does not account for makes the whole scan an error with a coded reason; it is never zero findings.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactId, CatalogKey, Digest, Id, ScopedReason } from '../contracts/common.js';
import type { ObservationEnvelope } from '../contracts/observation.js';
import type { CapturedInput, WorkerOutcome } from '../execution/supervisor.js';
import type { ExternalAdapterDefinition } from '../execution/registry.js';
import { canonicalJsonBytes } from '../store/objects.js';
import { validateEnvelope } from '../validate.js';
import {
  GITLEAKS_CONFIG, GITLEAKS_WORKER_FORMAT, MAX_FILE_BYTES, OBSERVATION_LIMITATIONS, OBSERVATION_MESSAGE, RULE_ID, SCAN_MANIFEST_SCHEMA,
  parseManifest, scopeOf, type ScanManifest,
} from './gitleaks-worker.js';

export { GITLEAKS_CONFIG, SCAN_MANIFEST_SCHEMA, type ScanManifest } from './gitleaks-worker.js';

export const GITLEAKS_ADAPTER_ID: Id = 'gitleaks';
export const OBSERVATION_MEDIA_TYPE = 'application/vnd.sentinel.observation+json';

const sha256 = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}` as Digest;

/** The pinned configuration's digest: what an audit names as the configuration the scan ran with. */
export const GITLEAKS_CONFIG_DIGEST: Digest = sha256(GITLEAKS_CONFIG);

/** The worker program exactly as the container receives it. */
export function gitleaksWorkerSource(): string {
  return readFileSync(fileURLToPath(new URL('./gitleaks-worker.js', import.meta.url)), 'utf8');
}

/** A measured, installed image: the Gitleaks version inside it and the image pinned by digest. */
export interface GitleaksPin {
  /** The Gitleaks release in the image, e.g. `8.30.0`. */
  readonly version: string;
  /** `repository@sha256:<digest>`; installed ahead of time, never pulled at run time. */
  readonly image: string;
}

/**
 * The production pins. Empty: no Gitleaks image has been measured and installed yet, so no production secret scan
 * can run, and nothing here or in the execution service will fetch one. A pin is added with its measurement.
 */
export const GITLEAKS_PINS: readonly GitleaksPin[] = Object.freeze([]);

/** The trusted registration for one pin. The registry hashes it (command included) into the adapter digest. */
export function gitleaksAdapterDefinition(pin: GitleaksPin, id: Id = GITLEAKS_ADAPTER_ID): ExternalAdapterDefinition {
  return {
    id, version: pin.version, kind: 'external', isolation: 'container', image: pin.image,
    // `--` ends Node's options; the marker tells the program it is the worker, not an import.
    command: ['node', '--input-type=module', '-e', gitleaksWorkerSource(), '--', '--sentinel-gitleaks-worker'],
  };
}

export interface CapturedFile {
  /** Source-relative path as captured. */
  readonly relativePath: string;
  /** The captured content's digest. */
  readonly content: ArtifactId;
  /** Where the captured bytes are now (the execution service copies and re-hashes them). */
  readonly path: string;
  readonly bytes: number;
}

export interface ScanInput {
  readonly manifest: ScanManifest;
  readonly manifestId: ArtifactId;
  /** Manifest first, then each distinct content once: the order the worker relies on. */
  readonly inputs: readonly CapturedInput[];
}

/** Writes the canonical manifest into `dir` (a private folder) and returns the attempt's inputs. */
export function prepareScanInput(dir: string, scope: { snapshotId: Id; sourceId: Id; files: readonly CapturedFile[] }): ScanInput {
  const files = [...scope.files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const contents = new Map<ArtifactId, string>();
  for (const f of files) if (!contents.has(f.content)) contents.set(f.content, f.path);
  const manifest = parseManifest({
    schema: SCAN_MANIFEST_SCHEMA, snapshotId: scope.snapshotId, sourceId: scope.sourceId,
    files: files.map(f => ({ path: f.relativePath, content: f.content, bytes: f.bytes })),
  }, [...contents.keys()]);
  const bytes = canonicalJsonBytes(manifest);
  const manifestId = sha256(bytes);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifestPath = join(dir, `${manifestId.slice(7)}.json`);
  writeFileSync(manifestPath, bytes, { mode: 0o600 });
  return {
    manifest, manifestId,
    inputs: [{ id: manifestId, path: manifestPath }, ...[...contents].map(([id, path]) => ({ id, path }))],
  };
}

export type SecretsScanStatus = 'complete' | 'partial' | 'error';

export interface SecretsScanResult {
  readonly status: SecretsScanStatus;
  /** Why the scan is an error. Absent for complete and partial. */
  readonly reasonCode?: CatalogKey;
  readonly observations: readonly ObservationEnvelope[];
  /** Scopes the scanner read. Empty for an error: nothing is credited. */
  readonly scanned: readonly string[];
  /** Scopes not scanned, each with its reason. For an error, every captured file. */
  readonly skipped: readonly ScopedReason[];
  /** What the scan ran with, for the audit: tool version, image digest, configuration digest, adapter digest. */
  readonly audit: {
    readonly adapterId: Id;
    readonly adapterDigest: Digest;
    readonly toolVersion: string | null;
    readonly image: string | null;
    readonly imageId: string | null;
    readonly configDigest: Digest;
    readonly manifestId: ArtifactId;
  };
}

const WORKER_CODE = new RegExp(`^${GITLEAKS_WORKER_FORMAT.replace(/[./-]/g, m => `\\${m}`)} (sentinel\\.secrets\\.[a-z][A-Za-z]*)\\n$`);
const OBSERVATION_KEYS = 'evidence,id,limitationKeys,message,observedAt,originalSeverity,producer,producerRuleId,schema,snapshotId';
const EVIDENCE_KEYS = 'content,relativePath,snapshotId,sourceId,span';

class Refused extends Error { constructor(readonly code: CatalogKey) { super(code); } }

/** Checks one observation against the closed redaction shape. Throws Refused; never echoes the value it read. */
function checkObservation(bytes: Buffer, input: ScanInput, outcome: WorkerOutcome): ObservationEnvelope {
  const refuse = (): never => { throw new Refused('sentinel.secrets.outputRefused'); };
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return refuse(); }
  if (!canonicalJsonBytes(parsed).equals(bytes)) refuse();
  const valid = validateEnvelope('observation', parsed);
  if (!valid.ok) refuse();
  const o = valid.ok ? valid.value : refuse();
  if (Object.keys(o).sort().join(',') !== OBSERVATION_KEYS) refuse();
  const p = o.producer;
  if (p.kind !== 'scanner' || Object.keys(p).sort().join(',') !== 'adapterDigest,adapterId,attemptId,kind'
    || p.adapterId !== outcome.adapter.id || p.adapterDigest !== outcome.adapter.digest || p.attemptId !== outcome.attemptId) refuse();
  if (o.snapshotId !== input.manifest.snapshotId || !RULE_ID.test(o.producerRuleId) || o.originalSeverity !== 'unrated'
    || o.message !== OBSERVATION_MESSAGE || o.limitationKeys.join(',') !== OBSERVATION_LIMITATIONS.join(',')) refuse();
  if (o.evidence.length !== 1) refuse();
  const e = o.evidence[0]!;
  if (Object.keys(e).sort().join(',') !== EVIDENCE_KEYS || e.sourceId !== input.manifest.sourceId) refuse();
  const file = input.manifest.files.find(f => f.path === e.relativePath);
  if (!file || file.content !== e.content || e.span.endByte > file.bytes) refuse();
  return o;
}

/**
 * Turns a supervised outcome into the scan result. Never throws for anything the worker did; the diagnostics text
 * is matched against the worker's one coded line and otherwise discarded, never returned.
 */
export function readSecretsOutcome(outcome: WorkerOutcome, input: ScanInput, pin?: GitleaksPin): SecretsScanResult {
  const everyScope = input.manifest.files.map(f => scopeOf(input.manifest.sourceId, f.path));
  const audit = {
    adapterId: outcome.adapter.id, adapterDigest: outcome.adapter.digest, toolVersion: pin?.version ?? null,
    image: outcome.container?.image.reference ?? pin?.image ?? null, imageId: outcome.container?.image.id ?? null,
    configDigest: GITLEAKS_CONFIG_DIGEST, manifestId: input.manifestId,
  };
  const error = (reasonCode: CatalogKey): SecretsScanResult => ({
    status: 'error', reasonCode, observations: [], scanned: [],
    skipped: everyScope.map(scopeId => ({ scopeId, reasonCode })), audit,
  });
  if (outcome.state !== 'succeeded' || !outcome.result) {
    const coded = WORKER_CODE.exec(outcome.diagnostics.text)?.[1];
    return error((coded ?? outcome.code ?? 'sentinel.secrets.workerError') as CatalogKey);
  }
  if (!input.inputs.length || outcome.invocation.record.inputs.length !== input.inputs.length
    || !input.inputs.every(i => outcome.invocation.record.inputs.includes(i.id))) return error('sentinel.secrets.inputInvalid');
  const result = outcome.result;
  // Every captured file is scanned or skipped with a reason, once; nothing else is named.
  const scanned = [...result.scannedSet];
  const skipped = result.skipped.map(s => ({ scopeId: s.scopeId, reasonCode: s.reasonCode }));
  const named = [...scanned, ...skipped.map(s => s.scopeId)];
  const expected = new Set(everyScope);
  if (named.length !== expected.size || new Set(named).size !== named.length || named.some(s => !expected.has(s))
    || skipped.some(s => s.reasonCode !== 'sentinel.secrets.fileTooLarge')
    || skipped.some(s => (input.manifest.files.find(f => scopeOf(input.manifest.sourceId, f.path) === s.scopeId)?.bytes ?? 0) <= MAX_FILE_BYTES)) {
    return error('sentinel.secrets.coverageMismatch');
  }
  if (result.observations.length !== outcome.outputs.length || result.coveredChecks.length || result.unresolvedFrontiers.length) {
    return error('sentinel.secrets.outputRefused');
  }
  const observations: ObservationEnvelope[] = [];
  try {
    for (const out of outcome.outputs) {
      if (out.mediaType !== OBSERVATION_MEDIA_TYPE) throw new Refused('sentinel.secrets.outputRefused');
      observations.push(checkObservation(readFileSync(out.path), input, outcome));
    }
  } catch (e) {
    return error(e instanceof Refused ? e.code : 'sentinel.secrets.outputRefused');
  }
  if (new Set(observations.map(o => o.id)).size !== observations.length) return error('sentinel.secrets.outputRefused');
  return { status: skipped.length ? 'partial' : 'complete', observations, scanned, skipped, audit };
}
