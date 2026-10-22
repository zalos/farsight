import type { ArtifactId, CatalogKey, Count, Digest, Id, RelativePath, ShortText, Timestamp } from './common.js';

/** How the bytes were captured. A working copy is stability-checked, never an atomic Git revision. */
export type CaptureMode = 'committed-tree' | 'working-copy-stability-checked';

/** An included file: its captured bytes are retained. */
export interface IncludedFileEntry {
  sourceId: Id;
  relativePath: RelativePath;
  kind: 'file';
  disposition: 'included';
  content: ArtifactId;
  bytes: Count;
  generated: boolean;
}

/** A file that was enumerated but not captured. It is recorded, never silently dropped. */
export interface RecordedFileEntry {
  sourceId: Id;
  relativePath: RelativePath;
  kind: 'file';
  disposition: 'excluded' | 'refused' | 'unreadable' | 'too-large';
  reasonCode: CatalogKey;
  /** Size when it could be read from metadata (a too-large file), else absent. */
  bytes?: Count;
  generated: boolean;
}

/** A symlink is never followed out of an authorized root, so it has no captured referent. */
export interface SymlinkEntry {
  sourceId: Id;
  relativePath: RelativePath;
  kind: 'symlink';
  disposition: 'excluded' | 'refused';
  reasonCode: CatalogKey;
}

/** A directory whose descendants were not individually enumerated (an exclusion, a refusal, unreadable). */
export interface DirectoryBoundaryEntry {
  sourceId: Id;
  relativePath: RelativePath;
  kind: 'directory-boundary';
  disposition: 'excluded' | 'refused' | 'unreadable';
  reasonCode: CatalogKey;
  /** null: the descendants are unknown scope, never zero files. */
  knownDescendants: Count | null;
}

export type CaptureEntry = IncludedFileEntry | RecordedFileEntry | SymlinkEntry | DirectoryBoundaryEntry;

export interface SnapshotSource {
  sourceId: Id;
  /** @maxLength 512 */
  repositoryId: string;
  /**
   * The pinned commit, or null for a source with no Git revision.
   * @pattern ^[0-9a-f]{40}([0-9a-f]{24})?$
   */
  commit: string | null;
  dirty: boolean;
  capturedAt: Timestamp;
}

/**
 * A framework version resolved from a lockfile, or explicitly unknown with its reason.
 * @discriminator state
 */
export type FrameworkVersion =
  | {
      framework: ShortText;
      state: 'resolved';
      version: ShortText;
      provenance: { sourceId: Id; relativePath: RelativePath };
    }
  | {
      framework: ShortText;
      state: 'unknown';
      reasonCode: CatalogKey;
      /** The source the unresolved entry was read for, when known; without it the version is unknown for every source. */
      sourceId?: Id;
    };

/** sentinel-snapshot/draft-1 — immutable capture facts. Analysis outcomes are appended elsewhere, never here. */
export interface SnapshotEnvelope {
  schema: 'sentinel-snapshot/draft-1';
  id: Id;
  inventoryDigest: Digest;
  createdAt: Timestamp;
  capture: { mode: CaptureMode; policyDigest: Digest };
  environmentProfileDigest: Digest;
  /**
   * @minItems 1
   * @maxItems 64
   */
  sources: SnapshotSource[];
  /** @maxItems 200000 */
  entries: CaptureEntry[];
  /** @maxItems 256 */
  frameworkVersions: FrameworkVersion[];
  artifacts: {
    /** @maxItems 64 */
    parser: ArtifactId[];
    /** @maxItems 1024 */
    diagnostics: ArtifactId[];
  };
}
