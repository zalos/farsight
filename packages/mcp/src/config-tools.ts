/**
 * The `config_files` tool (docs/proposals/journey-organisation-and-config-files.md §5.4): every
 * farsight.config.json each source holds — the root file and the ones scoped to a folder — with the
 * fields each gave, what was ignored, the conflicts between them and the notes. Read only: an agent
 * edits the files with its own tools and calls refresh_graph; Farsight never writes into a source.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configFilesText, configOverviewLines, type GraphMeta } from '@farsight/core';

export interface ConfigToolsContext {
  server: McpServer;
  /** the live graph's meta — re-read on every call, so a refresh_graph is seen */
  meta: () => GraphMeta;
}

export interface ConfigTools {
  /** `config: <repo> — 3 config files (…) · 1 conflict` per source with more than its root file, for graph_overview */
  overviewLines(): string[];
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function registerConfigTools(ctx: ConfigToolsContext): ConfigTools {
  ctx.server.registerTool('config_files', {
    title: 'Config files — every farsight.config.json per source',
    description: 'Every farsight.config.json each source holds: the root file, which speaks for the whole source, and any file in a folder below it, which speaks only for the code under that folder and names paths relative to it. One line per file — its path, root or the folder it is scoped to, the fields it gives and any it ignored (projects and tooling are root-only) — then the conflicts between files (two glossary words for one name: the nearer file\'s stands under its folder; a function one file already made a guard; a second declaration of the same external import or store name: the first is kept) and the notes (unreadable files, paths that leave the source). json: true returns the ConfigMeta per source. Read only: edit the files with your own tools, then call refresh_graph. Use to find where a word, a tag or a declaration came from, or why a nested config did not apply.',
    inputSchema: {
      repo: z.string().optional().describe('limit to one source/repo name (see graph_overview)'),
      json: z.boolean().optional().describe('true = the ConfigMeta per source as JSON ({ files, conflicts, notes })'),
    },
  }, async ({ repo, json }) => {
    const metas = ctx.meta().config ?? {};
    if (json) {
      const picked = Object.fromEntries(Object.entries(metas).filter(([r]) => !repo || r === repo));
      return text(JSON.stringify(picked, null, 2));
    }
    return text(configFilesText(metas, repo).join('\n'));
  });
  return { overviewLines: () => configOverviewLines(ctx.meta().config) };
}
