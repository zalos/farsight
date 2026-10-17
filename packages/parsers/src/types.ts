import type { AdapterOptions } from '@farsight/code-parser';
export type { LanguageAdapter } from '@farsight/code-parser';

export interface IngestOptions extends AdapterOptions {
  /** Include individual call sites in the application graph; defaults off until a surface consumes them. */
  occurrences?: boolean;
  /** false = skip the OpenAPI post-pass (spec discovery + reconcile); default on */
  openapi?: boolean;
  /** false = do not apply the repo's farsight.config.json (tags, glossary, guards, entrypoints); default on */
  config?: boolean;
  /** false = skip the design post-pass (screens manifests + Figma freshness); default on */
  design?: boolean;
  /** false = skip test enrichment; historically also includes test source unless testFiles explicitly overrides it */
  tests?: boolean;
  /** false = skip the stories post-pass (CSF files → StoryRefs on components, Storybook discovery); default on */
  stories?: boolean;
  /** false = skip the projects pass (NX / workspaces discovery, `project` on every node, project → project imports); default on */
  projects?: boolean;
}
