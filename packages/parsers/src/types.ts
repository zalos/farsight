import type { AdapterOptions } from '@farsight/code-parser';
import type { FarsightConfig } from '@farsight/core';
export type { LanguageAdapter } from '@farsight/code-parser';

export interface IngestOptions extends AdapterOptions {
  /** Include individual call sites in the application graph; defaults off until a surface consumes them. */
  occurrences?: boolean;
  /** false = skip the OpenAPI post-pass (spec discovery + reconcile); default on */
  openapi?: boolean;
  /** false = do not apply the repo's farsight.config.json (tags, glossary, guards, entrypoints); default on */
  config?: boolean;
  /** Root-scoped workspace declarations, after the repository's root config. */
  configOverlay?: { config: FarsightConfig; from: string };
  /** OpenAPI documents registered for this code source in workspace settings. */
  openapiRegistered?: FarsightConfig['openapi'];
  /** Candidate paths dismissed in this workspace. */
  openapiIgnored?: string[];
  /** false = skip the design post-pass (screens manifests + Figma freshness); default on */
  design?: boolean;
  /** false = skip test enrichment; historically also includes test source unless testFiles explicitly overrides it */
  tests?: boolean;
  /** false = skip the stories post-pass (CSF files → StoryRefs on components, Storybook discovery); default on */
  stories?: boolean;
  /** false = skip the projects pass (NX / workspaces discovery, `project` on every node, project → project imports); default on */
  projects?: boolean;
}

/** The workspace declarations shared by server sync and MCP refresh, without a server dependency. */
export function sourceIngestOptions(source: {
  id: string;
  exclude?: string[];
  config?: FarsightConfig;
  openapi?: FarsightConfig['openapi'];
  openapiIgnore?: string[];
}): Pick<IngestOptions, 'exclude' | 'configOverlay' | 'openapiRegistered' | 'openapiIgnored'> {
  return {
    exclude: source.exclude,
    ...(source.config
      ? {
          configOverlay: {
            config: source.config,
            from: `.farsight/settings.json → sources[${source.id}].config`,
          },
        }
      : {}),
    openapiRegistered: source.openapi,
    openapiIgnored: source.openapiIgnore,
  };
}
