// Normalizing one imported report: exact report bytes and a caller-stated manifest in, a deterministic document out
// (the same bytes, manifest and adapter version always give the same canonical bytes). Synchronous throughout, so the
// caller's buffers are copied once at entry and nothing they do later can change what is read. The document records
// the tool's claims, the exchanges the report recorded and the Set-Cookie facts read from them, with every unknown
// and ignored field. It does not bind the report to a run, a capture, a source, an owner or a deployment, place any
// location in source, or say any check ran, protects anything, or covers the application.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import { isArchive, readImportFile } from './bounded-file.js';
import { Collector } from './collect.js';
import { checkedManifest, type ImportManifest } from './manifest.js';
import { readSarif } from './sarif.js';
import { parseStrictJson } from './strict-json.js';
import { IMPORT_ADAPTER, IMPORT_LIMITATION_KEYS, ImportBudget, ImportRefusal, type ImportFormat, type ImportLimits, type ImportRefusalCode, type Json } from './types.js';
import { readZap } from './zap.js';

export interface NormalizedImport {
  readonly schema: 'sentinel-import-normalized/draft-1';
  readonly adapter: { readonly id: string; readonly version: string };
  readonly format: ImportFormat;
  readonly input: { readonly rawDigest: string; readonly rawBytes: number; readonly byteOrderMark: boolean; readonly manifestDigest: string };
  /** The manifest as the caller stated it. Nothing in it is verified. */
  readonly callerStated: Pick<ImportManifest, 'producer' | 'tested' | 'context'>;
  readonly tool: Json;
  readonly claims: readonly Json[];
  readonly exchanges: readonly Json[];
  readonly cookies: readonly Json[];
  readonly unknowns: readonly { readonly pointer: string; readonly code: string }[];
  readonly ignored: readonly Json[];
  readonly limitationKeys: readonly string[];
}

export type ImportResult =
  | { readonly status: 'refused'; readonly code: ImportRefusalCode; readonly pointer: string | null }
  | { readonly status: 'normalized'; readonly document: NormalizedImport; readonly canonical: string; readonly digest: string };

export interface ImportOptions {
  /** May only lower the hard ceilings. */
  readonly limits?: Partial<ImportLimits>;
  /** A monotonic nanosecond clock, for tests only. */
  readonly clock?: () => bigint;
}

const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function deepFreeze<T>(v: T, budget: ImportBudget): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    budget.work();
    Object.freeze(v);
    for (const child of Object.values(v as object)) deepFreeze(child, budget);
  }
  return v;
}

/** Normalizes report bytes under a manifest. Refusals carry a fixed code and an opaque bounded diagnostic path, never report content. */
export function normalizeImport(report: Uint8Array, manifest: Uint8Array, options: ImportOptions = {}): ImportResult {
  let budget: ImportBudget;
  try { budget = new ImportBudget(options.limits, options.clock); } catch (e) { return refused(e); }
  if (!(report instanceof Uint8Array) || !(manifest instanceof Uint8Array)) return { status: 'refused', code: 'sentinel.import.fileUnreadable', pointer: null };
  // Refuse before the defensive copy: the synchronous API must honor lowered byte caps too.
  if (report.byteLength > budget.limits.rawBytes || manifest.byteLength > budget.limits.manifestBytes) {
    return { status: 'refused', code: 'sentinel.import.tooLarge', pointer: null };
  }
  try {
    budget.check();
    const raw = Buffer.from(report);
    const man = Buffer.from(manifest);
    budget.check();
    return run(raw, man, budget);
  } catch (e) { return refused(e); }
}

/** Reads both files with the bounded reader, then normalizes them. */
export function importFromFiles(reportPath: string, manifestPath: string, options: ImportOptions = {}): ImportResult {
  let budget: ImportBudget;
  try { budget = new ImportBudget(options.limits, options.clock); } catch (e) { return refused(e); }
  try {
    const man = readImportFile(manifestPath, budget.limits.manifestBytes, budget);
    const raw = readImportFile(reportPath, budget.limits.rawBytes, budget);
    return run(raw, man, budget);
  } catch (e) { return refused(e); }
}

function refused(e: unknown): ImportResult {
  if (e instanceof ImportRefusal) return { status: 'refused', code: e.code, pointer: e.pointer };
  if (e instanceof RangeError) return { status: 'refused', code: 'sentinel.import.budgetExhausted', pointer: null };
  throw e;
}

function run(raw: Buffer, man: Buffer, budget: ImportBudget): ImportResult {
  if (raw.length > budget.limits.rawBytes) throw new ImportRefusal('sentinel.import.tooLarge');
  if (isArchive(raw)) throw new ImportRefusal('sentinel.import.archiveUnsupported');
  const { manifest } = checkedManifest(man, budget);
  const rawDigest = sha(raw);
  budget.check();
  const parsed = parseStrictJson(raw, budget);
  const c = new Collector(rawDigest, manifest, budget);
  const tool = manifest.format === 'sarif-2.1.0' ? readSarif(parsed.value, c) : readZap(parsed.value, c, manifest.format === 'zap-traditional-json-plus');
  budget.check();
  const document: NormalizedImport = {
    schema: 'sentinel-import-normalized/draft-1',
    adapter: { ...IMPORT_ADAPTER },
    format: manifest.format,
    input: { rawDigest, rawBytes: raw.length, byteOrderMark: parsed.byteOrderMark, manifestDigest: sha(man) },
    callerStated: { producer: manifest.producer, tested: manifest.tested, context: manifest.context },
    tool, claims: c.claims, exchanges: c.exchanges, cookies: c.cookies, unknowns: c.unknowns, ignored: c.ignored,
    limitationKeys: [...IMPORT_LIMITATION_KEYS],
  };
  budget.check();
  const canonical = canonicalJson(document);
  budget.work(Math.ceil(canonical.length / 64) + 1);
  if (Buffer.byteLength(canonical, 'utf8') > budget.limits.normalizedBytes) throw new ImportRefusal('sentinel.import.outputTooLarge');
  budget.check();
  const digest = sha(canonical);
  deepFreeze(document, budget);
  budget.check();
  return { status: 'normalized', document, canonical, digest };
}
