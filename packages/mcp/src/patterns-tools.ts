/** Explicit read-only pattern testing; registration defaults to the all tools tier. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t } from '@farsight/core';
import { testPatterns, patternsTestText, type IngestOptions } from '@farsight/parsers';

export function registerPatternsTools(ctx: {
  server: McpServer;
  roots: () => Record<string, string>;
  options: () => Record<string, IngestOptions>;
}): void {
  const word = (key: string) => t('config.patterns.' + key, 'professional');
  ctx.server.registerTool(
    'patterns_test',
    {
      title: word('toolTitle'),
      description: word('toolDescription'),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        repo: z.string().optional().describe(word('repoInput')),
        rule: z.string().optional().describe(word('ruleInput')),
        json: z.boolean().optional().describe(word('jsonInput')),
      },
    },
    async ({ repo, rule, json }) => {
      const text = (text: string, isError = false) => ({
        content: [{ type: 'text' as const, text }],
        ...(isError ? { isError } : {}),
      });
      const sources = Object.entries(ctx.roots()).filter(([r]) => !repo || r === repo);
      if (!sources.length) return text(word('sourceMissing').replace('{source}', repo ?? ''), true);
      const options = ctx.options();
      try {
        const results = [];
        for (const [name, root] of sources)
          results.push(await testPatterns(root, { ...options[root], repoName: name }, { rule }));
        return text(json ? JSON.stringify(results, null, 2) : results.map(patternsTestText).join('\n\n'));
      } catch {
        return text(word('failed'), true);
      }
    },
  );
}
