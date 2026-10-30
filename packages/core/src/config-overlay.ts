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
export { configSchema, configSchemaProblem } from '@farsight/graph';
