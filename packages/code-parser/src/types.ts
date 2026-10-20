import type { ExternalDecl, GraphFragment, GraphDocument, PortableGraph } from '@farsight/graph';

/** Options for syntax extraction. Farsight's enrichment switches are deliberately separate. */
export interface AdapterOptions {
  /** Low-level extraction defaults on; Farsight's composition layer opts in explicitly. */
  occurrences?: boolean;
  repoName?: string;
  include?: string[];
  exclude?: string[];
  /** Honor root and nested .gitignore files during discovery (default true). Explicit excludes still win. */
  gitignore?: boolean;
  testFiles?: 'include' | 'exclude';
  testGlobs?: { include?: string[]; exclude?: string[] };
  externals?: ExternalDecl[];
  plumbing?: string[];
  setup?: string[];
}
/** Compatibility type name for existing adapter implementations. */
export type IngestOptions = AdapterOptions;

export interface LanguageAdapter {
  readonly id: string;
  readonly version: string;
  readonly extensions: readonly string[];
  ingest(repoPath: string, options?: AdapterOptions): Promise<GraphFragment>;
}

export interface ParserLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  maxDurationMs?: number;
}

export interface ParseRepositoryOptions extends Omit<AdapterOptions, 'repoName' | 'occurrences'> {
  root: string;
  sourceId: string;
  signal?: AbortSignal;
  limits?: ParserLimits;
  /** Caller-supplied immutable input identities for a custom adapter, included in the fingerprint. */
  inputs?: Record<string, string>;
}

export interface Diagnostic {
  code: 'parse-error' | 'read-error' | 'read-boundary' | 'resource-limit' | 'cancelled' | 'unsupported' | 'adapter-error';
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  adapter?: string;
  line?: number;
  /** The affected graph declaration, when a limit applies to one declaration rather than the run. */
  nodeId?: string;
  reason?: string;
}

export interface FileAnalysis {
  path: string;
  status: 'analyzed' | 'skipped' | 'failed';
  reason?: string;
  adapter?: string;
  digest?: string;
}

export interface InputFingerprint {
  path: string;
  kind: 'content' | 'directory' | 'metadata' | 'missing';
  digest: string;
}

export interface AnalysisArtifact {
  format: 'farsight-analysis';
  schemaVersion: GraphDocument['schemaVersion'];
  graph: PortableGraph;
  analysis: {
    fingerprint: string;
    parser: { name: '@farsight/code-parser'; version: string };
    adapters: { id: string; version: string }[];
    inputs: InputFingerprint[];
    files: FileAnalysis[];
    diagnostics: Diagnostic[];
    complete: boolean;
    capabilities: string[];
    limits: string[];
  };
}
