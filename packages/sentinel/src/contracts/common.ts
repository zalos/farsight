// Shared draft building blocks for every Sentinel envelope. The JSDoc tags below are the one source of the
// published schema bounds: scripts/generate-schemas.mjs turns these types into schemas/*.schema.json.

/**
 * A SHA-256 content address, lower-case hex.
 * @pattern ^sha256:[0-9a-f]{64}$
 */
export type Digest = string;

/** An immutable object-store identity: the digest of canonical uncompressed bytes. */
export type ArtifactId = Digest;

/**
 * A ledger identifier. Opaque, bounded and free of path separators and whitespace.
 * @pattern ^[A-Za-z0-9][A-Za-z0-9._:-]*$
 * @maxLength 128
 */
export type Id = string;

/**
 * A stable code from the Sentinel catalog, never free text (`sentinel.reason.tooLarge`).
 * @pattern ^sentinel\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$
 * @maxLength 128
 */
export type CatalogKey = string;

/**
 * A UTC RFC 3339 timestamp with an explicit Z offset and a real calendar date (no leap second).
 * The pattern bounds each field; the `date-time` format check refuses a day the month does not have.
 * @pattern ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$
 * @format date-time
 */
export type Timestamp = string;

/**
 * A source-relative POSIX path: no leading or trailing slash, no `.`/`..` segment, no empty segment, no backslash or NUL.
 * @pattern ^(?![/])(?!.*[/]$)(?!(.*[/])?\.{1,2}([/]|$))(?!.*[/][/])[^\\\u0000]+$
 * @maxLength 4096
 */
export type RelativePath = string;

/**
 * A non-negative integer.
 * @asType integer
 * @minimum 0
 * @maximum 9007199254740991
 */
export type Count = number;

/**
 * A positive integer ordinal or revision.
 * @asType integer
 * @minimum 1
 * @maximum 2147483647
 */
export type Ordinal = number;

/**
 * A non-negative decimal amount written as a string, so money is never a binary float.
 * @pattern ^(0|[1-9][0-9]{0,15})(\.[0-9]{1,9})?$
 */
export type DecimalAmount = string;

/**
 * Untrusted text supplied by a producer (a scanner message, a rationale). Always escaped when rendered.
 * @maxLength 4000
 */
export type BoundedText = string;

/**
 * A short label (a severity as supplied, a framework name).
 * @minLength 1
 * @maxLength 200
 */
export type ShortText = string;

/** The same thing said in both registers; the report carries both so it never looks a label up later. */
export interface RegisterText {
  business: BoundedText;
  code: BoundedText;
}

/**
 * A canonical application-graph identity (`repo::path/to/File.tsx::Component`), a screen or a journey ID from
 * pinned context. Unlike a ledger `Id` it may contain `/` and `::`; it is bounded and free of control characters.
 * @minLength 1
 * @maxLength 1024
 * @pattern ^[^\u0000-\u001f\u007f]+$
 */
export type NodeId = string;

/**
 * A key in the shared two-register catalog (`count.unit.journeys`, `sentinel.count.findings`).
 * @pattern ^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$
 * @maxLength 128
 */
export type SharedCatalogKey = string;

/** A logical work unit at one immutable revision; every reference to work names both. */
export interface WorkRef {
  id: Id;
  revision: Ordinal;
}

/**
 * Zero-based, half-open UTF-8 byte offsets.
 */
export interface ByteSpan {
  startByte: Count;
  endByte: Count;
}

/** A citation into captured snapshot bytes. Source ID is part of identity: equal paths in two repositories differ. */
export interface SourceEvidence {
  snapshotId: Id;
  sourceId: Id;
  relativePath: RelativePath;
  content: ArtifactId;
  span: ByteSpan;
  quoteDigest?: Digest;
  nodeId?: NodeId;
  /** @maxLength 256 */
  occurrenceId?: string;
}

/**
 * A scope reference such as `<sourceId>:<relativePath>` or a surface ID. Untrusted protocol data: bounded,
 * free of control characters, never resolved as a filesystem path.
 * @pattern ^[A-Za-z0-9][^\u0000-\u001f\u007f]*$
 * @maxLength 4300
 */
export type ScopeId = string;

/** A coded reason attached to a scope (a skipped file, an unresolved frontier). */
export interface ScopedReason {
  scopeId: ScopeId;
  reasonCode: CatalogKey;
}
