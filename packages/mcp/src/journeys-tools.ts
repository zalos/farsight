/**
 * The MCP `journeys` tool (docs/proposals/journey-organisation-and-config-files.md §4.4): the
 * journeys organised by persona, then by group, in the order the manifests and the config
 * declare. Text is the tree as headings and one line per journey; `json: true` is the
 * `JourneyTree` itself. The same core `journeyTree()` behind `/api/journeys` and
 * `farsight journeys`, so the three cannot disagree. Read-only: an agent reorganises the
 * journeys by editing the manifest or the config with its own tools, then `refresh_graph`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  journeyTree, pickJourneys, journeyTreeLines, journeyTreeSummary, journeyPlacements, storylinePlacements, unknownStorylineText,
  type GraphIndex, type GraphMeta, type JourneyTree,
} from '@farsight/core';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export interface JourneysToolsContext {
  server: McpServer;
  index: () => GraphIndex;
  meta: () => GraphMeta;
}

export interface JourneysTools {
  /** the `journeys:` line for graph_overview — silent when the graph has no flows */
  overviewLines(): string[];
  /** where a flow sits (`Billing › Invoices`), for the journey tool's header — empty for anything else */
  placementLine(nodeId: string): string;
}

/** Register `journeys` on `server`. */
export function registerJourneysTools(ctx: JourneysToolsContext): JourneysTools {
  const tree = (repo?: string): JourneyTree => journeyTree(ctx.index(), ctx.meta().journeys, repo ? new Set([repo]) : null);

  ctx.server.registerTool('journeys', {
    title: 'Journeys by persona and group',
    description: 'The product\'s journeys (design flows) organised the way the design declares them: one heading per persona (who the journey is for), one per group under it (the ways in, then the things a person can do), and one line per journey in the declared order — its status word (built · partly built n of m · designed, not built), how many of its screens are built, whether it is the persona\'s way in (start here), and its node id to open with the journey tool. A journey made for two personas is listed under each; the counts at the top count it once. Before the personas come the storylines: each a named chain of journeys across features and personas (the whole life of one business thing, an invoice from upload to payment), its journeys numbered in order with their node ids. Ends with notes (a config placement naming a flow no manifest declares, a storyline naming a journey nobody declares). The organisation comes from the manifests\' personas[] / groups[] / storylines[] / flows[].persona|group|order and the farsight.config.json journeys block — design_guide explains them; edit those files and call refresh_graph to reorganise. Pass json:true for the JourneyTree document (the same one GET /api/journeys returns). Use first to see who the product is for, where each person starts and what they can do, and to find the flow id the journey tool takes.',
    inputSchema: {
      repo: z.string().optional().describe('limit to one source/repo name'),
      persona: z.string().optional().describe('one persona, by id or name (case-insensitive)'),
      group: z.string().optional().describe('one group, by id or name (case-insensitive)'),
      storyline: z.string().optional().describe('one storyline, by id or name (case-insensitive): that storyline\'s steps in order, and under the personas only its journeys'),
      json: z.boolean().optional().describe('return the JourneyTree as JSON instead of text'),
    },
  }, async ({ repo, persona, group, storyline, json }) => {
    const whole = tree(repo);
    let t = whole;
    if (persona || group || storyline) t = pickJourneys(t, { ...(persona ? { persona } : {}), ...(group ? { group } : {}), ...(storyline ? { storyline } : {}) });
    if (json) return text(JSON.stringify(t, null, 2));
    if (storyline && !t.storylines.length) return text(unknownStorylineText(whole, storyline));
    if (!t.personas.length && (persona || group || storyline)) return text(`no journey under ${[persona && `persona "${persona}"`, group && `group "${group}"`, storyline && `storyline "${storyline}"`].filter(Boolean).join(' and ')} — call journeys with no filter to see the personas, groups and storylines there are`);
    return text(journeyTreeLines(t, { openHint: '(open with journey)' }).join('\n'));
  });

  return {
    overviewLines() {
      const t = tree();
      if (!t.counts.journeys.n) return [];
      return [`journeys: ${journeyTreeSummary(t)} — the journeys tool lists them by ${t.counts.storylines?.n ? 'storyline, then ' : ''}persona and group`];
    },
    placementLine(nodeId: string) {
      const t = tree();
      const where = journeyPlacements(t, nodeId);
      if (!where.length) return '';
      const stories = storylinePlacements(t, nodeId);
      return `shown under: ${where.map((w) => `${w.persona} › ${w.group}${w.pinned ? ' (start here)' : ''}`).join(' · ')}`
        + (stories.length ? `\nin storyline: ${stories.map((s) => (s.branch
          // a branch: the step it leaves from, the condition that takes it, and where it comes back
          ? `${s.name} · branch of ${s.branch.ofName} (\`${s.branch.of}\`) · when ${s.branch.when}${s.branch.rejoins ? ` · back to ${s.branch.rejoinsName} (\`${s.branch.rejoins}\`)` : ' · does not come back'}`
          : `${s.name} · step ${s.step} of ${s.of}${s.prev ? ` · before: \`${s.prev}\`` : ''}${s.next ? ` · next: \`${s.next}\`` : ''}`)).join(' · ')}` : '');
    },
  };
}
