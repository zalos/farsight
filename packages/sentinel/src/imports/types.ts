// Imported scanner reports, Stage A (PR 20): the shared vocabulary of the pure readers. A report is untrusted bytes a
// caller supplied. Reading it proves only what those bytes say: a tool's claims and, where a supported complete HTTP
// representation exists, facts about the Set-Cookie lines in it. Nothing here binds a report to a run, a captured
// source or an owner, places a location in source, or counts as a check Sentinel executed; that is a later, reviewed
// stage. Every limit is global per import and every exhaustion is a refusal, never a shorter result labelled complete.
// The limits are cooperative: the work is counted and the clock read inside every long loop, which bounds what this
// code does; it is not preemptive I/O or memory enforcement. objectMembers is per object; jsonValues, decoded
// UTF-8 string bytes and work bound the aggregate document.

/** Why a whole import is refused. Fixed codes and a bounded opaque diagnostic path: never a member name or value from the report. */
export const IMPORT_REFUSAL_CODES = Object.freeze([
  'sentinel.import.fileUnreadable', 'sentinel.import.notRegularFile', 'sentinel.import.linkRefused', 'sentinel.import.hardLinkRefused',
  'sentinel.import.fileChanged', 'sentinel.import.tooLarge', 'sentinel.import.archiveUnsupported', 'sentinel.import.invalidUtf8',
  'sentinel.import.jsonMalformed', 'sentinel.import.jsonDuplicateKey', 'sentinel.import.jsonTooDeep', 'sentinel.import.budgetExhausted',
  'sentinel.import.deadlineExceeded', 'sentinel.import.manifestInvalid', 'sentinel.import.formatMismatch', 'sentinel.import.formatMalformed',
  'sentinel.import.producerMismatch', 'sentinel.import.outputTooLarge',
] as const);
export type ImportRefusalCode = typeof IMPORT_REFUSAL_CODES[number];

/** Why one part of an accepted document is not a fact. The document is still read; this part stays unknown. */
export const IMPORT_UNKNOWN_CODES = Object.freeze([
  'sentinel.import.referenceUnresolved', 'sentinel.import.referenceConflict', 'sentinel.import.externalProperties',
  'sentinel.import.noExchange', 'sentinel.import.noResponse', 'sentinel.import.responseConflict', 'sentinel.import.missingHeader',
  'sentinel.import.headerMalformed', 'sentinel.import.headerFolded', 'sentinel.import.headerTruncated', 'sentinel.import.headerAmbiguous',
  'sentinel.import.statusMalformed', 'sentinel.import.versionUnsupported', 'sentinel.import.redirect',
  'sentinel.import.requestMalformed', 'sentinel.import.requestInconsistent', 'sentinel.import.originUnknown',
  'sentinel.import.outsideStatedScope', 'sentinel.import.cookieMalformed', 'sentinel.import.commaAmbiguous',
  'sentinel.import.attributeDuplicate', 'sentinel.import.attributeMalformed', 'sentinel.import.sameSiteUnrecognized',
  'sentinel.import.selectorAmbiguous', 'sentinel.import.duplicateInResponse', 'sentinel.import.deletionCookie',
  'sentinel.import.sequenceUnsupported', 'sentinel.import.locationConflict', 'sentinel.import.locationUnresolved',
  'sentinel.import.hashInvalid', 'sentinel.import.uriRejected', 'sentinel.import.producerUnknown',
] as const);
export type ImportUnknownCode = typeof IMPORT_UNKNOWN_CODES[number];

/** What every normalized import says about itself, whatever it contains. */
export const IMPORT_LIMITATION_KEYS = Object.freeze([
  'sentinel.import.importedNotExecuted', 'sentinel.import.toolScopeOnly', 'sentinel.import.noWholeApplicationClaim',
  'sentinel.import.suppliedBytesOnly', 'sentinel.import.callerStatedManifest', 'sentinel.import.unbound',
] as const);

export const IMPORT_FORMATS = Object.freeze(['sarif-2.1.0', 'zap-traditional-json', 'zap-traditional-json-plus'] as const);
export type ImportFormat = typeof IMPORT_FORMATS[number];

/** The adapter's own identity: a different version may read the same bytes differently, so it is part of the output. */
export const IMPORT_ADAPTER = Object.freeze({ id: 'sentinel.import.reports', version: '3' });

/** The three attributes a Set-Cookie line can show. Integrity and confidentiality are never derived from a report. */
export const COOKIE_PROPERTIES = Object.freeze(['cookie-secure', 'cookie-http-only', 'cookie-same-site'] as const);
export type CookieProperty = typeof COOKIE_PROPERTIES[number];

/** Hard ceilings, global per import. No caller, manifest or report can raise them. */
export const IMPORT_CEILINGS = Object.freeze({
  rawBytes: 16 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  normalizedBytes: 16 * 1024 * 1024,
  deadlineMs: 10_000,
  jsonDepth: 64,
  jsonValues: 2_000_000,
  objectMembers: 10_000,
  stringBytes: 8 * 1024 * 1024,
  decodedStringBytes: 32 * 1024 * 1024,
  work: 200_000_000,
  claims: 50_000,
  locations: 100_000,
  exchanges: 10_000,
  headerLines: 200_000,
  headerLineBytes: 16 * 1024,
  cookies: 20_000,
  observations: 60_000,
  unknowns: 50_000,
  ignored: 4_096,
});
export type ImportLimits = { -readonly [K in keyof typeof IMPORT_CEILINGS]: number };

export class ImportRefusal extends Error {
  readonly pointer: string | null;

  constructor(readonly code: ImportRefusalCode, pointer: string | null = null) {
    // Diagnostics never echo member names, including names supplied to this constructor directly. Only numeric
    // positions survive; all member segments are opaque. Bound before splitting as well as on the stored property.
    const safe = pointer === null ? null : pointer.slice(0, 256).split('/').map((part, i) =>
      i === 0 && part === '' ? '' : /^[0-9]{1,10}$/.test(part) ? part : '*').join('/').slice(0, 256);
    super(safe === null ? code : `${code} at ${safe}`);
    this.pointer = safe;
    this.name = 'ImportRefusal';
  }
}

/** One import's shared budget: counts, work and one absolute monotonic deadline. */
export class ImportBudget {
  readonly limits: Readonly<ImportLimits>;
  readonly #deadline: bigint;
  readonly #clock: () => bigint;
  readonly #used = new Map<string, number>();
  #work = 0;
  #sinceClock = 0;

  /** `limits` may only lower a ceiling. `clock` is a monotonic nanosecond clock, replaceable only by tests. */
  constructor(limits: Partial<ImportLimits> = {}, clock: () => bigint = process.hrtime.bigint) {
    // Invalid knobs use the existing typed refusal, never Object.entries' raw TypeError. Undefined means the
    // optional limits were omitted; an explicitly undefined field still fails the finite-integer check below.
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) throw new ImportRefusal('sentinel.import.budgetExhausted');
    const merged = { ...IMPORT_CEILINGS } as ImportLimits;
    for (const [k, v] of Object.entries(limits) as [keyof ImportLimits, number][]) {
      if (!Object.hasOwn(IMPORT_CEILINGS, k) || !Number.isSafeInteger(v) || v < 0) throw new ImportRefusal('sentinel.import.budgetExhausted');
      merged[k] = Math.min(v, IMPORT_CEILINGS[k]);
    }
    this.limits = Object.freeze(merged);
    this.#clock = clock;
    this.#deadline = clock() + BigInt(merged.deadlineMs) * 1_000_000n;
  }

  /** Charges `n` units of work; the clock is read at least every 4096 units. */
  work(n = 1): void {
    this.#work += n;
    if (this.#work > this.limits.work) throw new ImportRefusal('sentinel.import.budgetExhausted');
    this.#sinceClock += n;
    if (this.#sinceClock >= 4096) { this.#sinceClock = 0; this.check(); }
  }

  /** Reads the clock now. */
  check(): void {
    if (this.#clock() > this.#deadline) throw new ImportRefusal('sentinel.import.deadlineExceeded');
  }

  /** Counts `n` more of a global limit, refusing past it. */
  count(limit: 'claims' | 'locations' | 'exchanges' | 'headerLines' | 'cookies' | 'observations' | 'unknowns' | 'ignored' | 'jsonValues' | 'decodedStringBytes', n = 1): void {
    const used = (this.#used.get(limit) ?? 0) + n;
    if (used > this.limits[limit]) throw new ImportRefusal('sentinel.import.budgetExhausted');
    this.#used.set(limit, used);
    this.work(n);
  }
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type JsonObject = { readonly [k: string]: Json };
export const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
