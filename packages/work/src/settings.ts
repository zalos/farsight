// Work sources from `.farsight/settings.json` (`sources[]` entries with `type: 'work'`, §10).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import type { SourceConfig } from './provider.js';

/** Every enabled work source the workspace declares; a fixture `path` is resolved against the workspace. */
export function loadWorkSources(workspace: string): SourceConfig[] {
  const file = join(workspace, '.farsight', 'settings.json');
  if (!existsSync(file)) return [];
  const s = JSON.parse(readFileSync(file, 'utf8')) as { sources?: Record<string, unknown>[] };
  return (s.sources ?? [])
    .filter((x) => x.type === 'work' && x.enabled !== false)
    .map((x) => {
      const cfg = { mode: 'read-only', scope: { projects: [] }, ...x } as unknown as SourceConfig;
      if (cfg.path && !isAbsolute(cfg.path)) cfg.path = resolve(workspace, cfg.path);
      return cfg;
    });
}
