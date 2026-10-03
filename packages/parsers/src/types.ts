import type { ExternalDecl, GraphFragment } from '@farsight/core';

/**
 * Every language adapter implements this. Adapters are pure functions over a
 * repo directory: scan for their own extensions, emit one GraphFragment in the
 * shared schema (`@farsight/core` graph.ts). Registration lives in `index.ts`;
 * consumers never call an adapter directly — they go through `ingestRepo()`.
 */
export interface LanguageAdapter {
  id: string; // 'ts-js', 'java', ...
  extensions: string[]; // ['.ts', '.tsx'] / ['.java'] ...
  /** Async (tree-sitter adapters await WASM init). A repo with none of this adapter's files must return an empty fragment (meta.files 0). */
  ingest(repoPath: string, options?: IngestOptions): Promise<GraphFragment>;
}

export interface IngestOptions {
  repoName?: string;
  include?: string[];
  exclude?: string[];
  /** false = skip the OpenAPI post-pass (spec discovery + reconcile); default on */
  openapi?: boolean;
  /** false = do not apply the repo's farsight.config.json (tags, glossary, guards, entrypoints); default on */
  config?: boolean;
  /** false = skip the design post-pass (screens manifests + Figma freshness); default on */
  design?: boolean;
  /** false = skip the tests post-pass AND leave spec files to the language adapters (pre-tests behaviour); default on */
  tests?: boolean;
  /** false = skip the stories post-pass (CSF files → StoryRefs on components, Storybook discovery); default on */
  stories?: boolean;
  /** false = skip the projects pass (NX / workspaces discovery, `project` on every node, project → project imports); default on */
  projects?: boolean;
  /** extra/removed globs that claim a file as a test — from `farsight.config.json → tests`, passed to the adapters so they skip claimed files */
  testGlobs?: { include?: string[]; exclude?: string[] };
  /** declared third-party systems — from `farsight.config.json → externals`; renames/kinds the parser cannot infer */
  externals?: ExternalDecl[];
  /** globs whose functions are plumbing regardless of @business — from `farsight.config.json → plumbing` */
  plumbing?: string[];
  /** the functions that build the process container — from `farsight.config.json → setup`; roots of the setup closure */
  setup?: string[];
}
