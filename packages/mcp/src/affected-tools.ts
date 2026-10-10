/**
 * The MCP `affected` tool (round 2026-10-10, proposal 6): what a pull request or a commit range touches —
 * the same `readChange()` and core `affectedRange()` behind `farsight affected`, so the agent and the
 * terminal read one change one way. Registered only when a `code-host` source in .farsight/settings.json
 * grants agents `read` (`allow.agents`); it never posts — posting is a person's, through the CLI's three
 * verdicts and `--confirm`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { affectedRange, affectedLines, journeyTree, buildLine, type GraphIndex, type GraphMeta, type TestsMatrixIdentity } from '@farsight/core';
import { loadCodeHostSources, agentsMayRead, readChange } from '@farsight/work';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export interface AffectedToolsContext {
  server: McpServer;
  workspace: string;
  index: () => GraphIndex;
  meta: () => GraphMeta;
  roots: () => Record<string, string>;
}

/** Register `affected` when a code-host source lets agents read; returns whether it did. */
export function registerAffectedTools(ctx: AffectedToolsContext): boolean {
  const hosts = (() => { try { return loadCodeHostSources(ctx.workspace); } catch { return []; } })();
  if (!agentsMayRead(hosts)) return false;
  ctx.server.registerTool('affected', {
    title: 'Affected — what a pull request or a commit range touches, and the tests to run',
    description: 'Give a pull request number (pr) or two commits (from, to). Answers with the parts the changed lines sit in, the journeys whose walk runs them (with their storyline step), the gates and rules, record writes (and the status a writer moves) and calls on the changed path, and every test case that reaches the change once, with its own last run and a verdict line. Reachability, never consequence; a floor where a hunk could only be credited by file. json:true returns the frozen farsight-affected v1 document. Read-only: posting the comment and the check is done by a person with `farsight affected --pr N --post --confirm`.',
    inputSchema: {
      pr: z.number().int().min(1).optional().describe('a pull request number on the code host'),
      from: z.string().optional().describe('the commit the range starts after'),
      to: z.string().optional().describe('the commit the range ends at'),
      repo: z.string().optional().describe('the graph source the change belongs to (default: the code-host source\'s)'),
      hops: z.number().int().min(1).max(5).optional().describe('how far out to look, default 2'),
      json: z.boolean().optional().describe('the farsight-affected v1 document instead of words'),
    },
  }, async ({ pr, from, to, repo, hops, json }) => {
    if (!pr && !(from && to)) return text('affected needs pr, or from and to.');
    const roots = ctx.roots();
    const meta = ctx.meta();
    const repos = Object.keys(roots);
    const host = hosts.find((h) => !repo || (h.source ?? h.repo.split('/').pop()) === repo) ?? hosts[0];
    const source = repo ?? host?.source ?? host?.repo.split('/').pop() ?? repos[0];
    if (!source || !repos.includes(source)) return text(`no source "${source ?? ''}" in the graph — name one with repo (${repos.join(', ')})`);
    let change;
    try {
      change = await readChange({ root: roots[source]!, ask: pr ? { pr } : { from: from!, to: to! }, ...(host ? { host } : {}), who: 'agent' });
    } catch (err) {
      return text((err as Error).message);
    }
    const identity: TestsMatrixIdentity = {
      ...(meta.sync != null ? { sync: meta.sync } : {}),
      ...(meta.commit ? { source_commit: meta.commit } : {}),
      source_digest: {}, farsight: buildLine(), generated_at: new Date().toISOString(),
    };
    const doc = affectedRange(ctx.index(), {
      repo: source, range: change.range, commits: change.commits, files: change.files,
      ...(change.history ? { history: change.history } : {}), ...(hops ? { hops } : {}),
      tree: journeyTree(ctx.index(), meta.journeys), identity,
    });
    return text(json ? JSON.stringify(doc, null, 2) : affectedLines(doc).join('\n'));
  });
  return true;
}
