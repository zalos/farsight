import type { FarsightConfig } from './config.js';

/** Workspace declarations about code; path blocks belong in the repository. */
export const CONFIG_OVERLAY_FIELDS = [
  'tags',
  'glossary',
  'guards',
  'gateTiers',
  'entrypoints',
  'setup',
  'validators',
  'internalRoutes',
  'externals',
  'stores',
  'lifecycle',
  'decisions',
  'frameworks',
  'patterns',
  'nodes',
] as const;
export type ConfigOverlay = Pick<FarsightConfig, Extract<(typeof CONFIG_OVERLAY_FIELDS)[number], keyof FarsightConfig>>;
export { configSchema, configSchemaProblem } from '@farsight/graph/config';
