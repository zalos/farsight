// The manifest a caller supplies beside a report: which fixed format it is, what producer the caller expects, and the
// scope the caller says was tested. All of it is caller-stated data. It narrows what is read (an observation outside
// it stays unbound) and is compared with what the report says about itself; it never proves an owner association, a
// deployment, a run or a source. Closed fields, bounded lists.
import { COOKIE_PROPERTIES, IMPORT_FORMATS, ImportBudget, ImportRefusal, isObject, type CookieProperty, type ImportFormat, type Json } from './types.js';
import { TOKEN, isCanonicalOrigin } from './http.js';
import { parseStrictJson } from './strict-json.js';

export interface ImportManifest {
  readonly schema: 'sentinel-import-manifest/draft-1';
  readonly format: ImportFormat;
  /** What the caller expects the report to say about its producer; null compares nothing. */
  readonly producer: { readonly name: string | null; readonly version: string | null };
  readonly tested: {
    readonly origins: readonly string[];
    readonly methods: readonly string[];
    readonly properties: readonly CookieProperty[];
    readonly directions: readonly ('inbound' | 'outbound')[];
  };
  /** Identifiers the caller associates with the report. Recorded as stated; nothing here checks them. */
  readonly context: { readonly [k in typeof CONTEXT_KEYS[number]]?: string };
}

const CONTEXT_KEYS = ['runId', 'snapshotId', 'sourceId', 'environmentDigest', 'deploymentDigest'] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TEXT = /^[\x20-\x7e]{1,256}$/;

const invalid = (pointer: string): never => { throw new ImportRefusal('sentinel.import.manifestInvalid', pointer); };

function closed(v: Json | undefined, pointer: string, required: readonly string[], optional: readonly string[] = []): asserts v is { readonly [k: string]: Json } {
  if (!isObject(v)) invalid(pointer);
  const o = v as { readonly [k: string]: Json };
  for (const k of required) if (!Object.hasOwn(o, k)) invalid(`${pointer}/${k}`);
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) invalid(pointer);
}

function stringList(v: Json | undefined, pointer: string, max: number, check: (s: string) => boolean): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return invalid(pointer);
  const out: string[] = [];
  (v as readonly Json[]).forEach((s, i) => {
    if (typeof s !== 'string' || !check(s) || out.includes(s)) invalid(`${pointer}/${i}`);
    out.push(s as string);
  });
  return out;
}

const nullableText = (v: Json | undefined, pointer: string): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || !TEXT.test(v)) return invalid(pointer);
  return v;
};

export function checkedManifest(bytes: Uint8Array, budget: ImportBudget): { manifest: ImportManifest; byteOrderMark: boolean } {
  if (bytes.length > budget.limits.manifestBytes) throw new ImportRefusal('sentinel.import.tooLarge');
  let parsed;
  try { parsed = parseStrictJson(bytes, budget); } catch (e) {
    if (e instanceof ImportRefusal && (e.code === 'sentinel.import.deadlineExceeded' || e.code === 'sentinel.import.budgetExhausted')) throw e;
    return invalid('');
  }
  const m = parsed.value;
  closed(m, '', ['schema', 'format', 'producer', 'tested'], ['context']);
  if (m.schema !== 'sentinel-import-manifest/draft-1') invalid('/schema');
  if (typeof m.format !== 'string' || !(IMPORT_FORMATS as readonly string[]).includes(m.format)) invalid('/format');
  closed(m.producer, '/producer', ['name', 'version']);
  const producer = { name: nullableText(m.producer.name, '/producer/name'), version: nullableText(m.producer.version, '/producer/version') };
  closed(m.tested, '/tested', ['origins', 'methods', 'properties', 'directions']);
  const tested = {
    origins: stringList(m.tested.origins, '/tested/origins', 16, isCanonicalOrigin),
    methods: stringList(m.tested.methods, '/tested/methods', 16, s => s.length <= 32 && TOKEN.test(s)),
    properties: stringList(m.tested.properties, '/tested/properties', COOKIE_PROPERTIES.length, s => (COOKIE_PROPERTIES as readonly string[]).includes(s)) as CookieProperty[],
    directions: stringList(m.tested.directions, '/tested/directions', 2, s => s === 'inbound' || s === 'outbound') as ('inbound' | 'outbound')[],
  };
  const context: Record<string, string> = {};
  if (m.context !== undefined) {
    closed(m.context, '/context', [], CONTEXT_KEYS);
    for (const k of CONTEXT_KEYS) {
      const v = m.context[k];
      if (v === undefined) continue;
      const ok = typeof v === 'string' && (k.endsWith('Digest') ? DIGEST.test(v) : ID.test(v));
      if (!ok) invalid(`/context/${k}`);
      context[k] = v as string;
    }
  }
  return {
    manifest: { schema: 'sentinel-import-manifest/draft-1', format: m.format as ImportFormat, producer, tested, context },
    byteOrderMark: parsed.byteOrderMark,
  };
}
