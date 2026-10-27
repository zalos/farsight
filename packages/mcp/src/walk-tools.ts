/**
 * The MCP `tour` and `ask` tools (round 2026-10-10, proposal 8): the guided walk over a storyline or a journey, and a
 * question answered from the graph — core `tourOf()` and `ask()`, the same folds behind `GET /api/tour`,
 * `GET /api/ask`, `farsight tour` and `farsight ask`, so the four cannot disagree. Every line ends with the node ids
 * it cites, in backticks, so an agent follows them with describe_node / gate / journey and a budget cut names
 * what it left out.
 *
 * `ask` is in the core tier: it is an agent's door to the rest — a question in plain words lands on the node ids the
 * other tools take. `tour` is in the all tier: it is long (a stop per screen and per hand-off), and an agent that
 * wants one journey's facts has `journey` in the core tier already.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { tourOf, tourLines, ask, askLines, journeyTree, type GraphIndex, type GraphMeta } from '@farsight/core';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export interface WalkToolsContext {
  server: McpServer;
  index: () => GraphIndex;
  meta: () => GraphMeta;
}

/** Register `tour` and `ask` on `server`. */
export function registerWalkTools(ctx: WalkToolsContext): void {
  ctx.server.registerTool(
    'tour',
    {
      title: 'Walk me through it — a storyline or a journey, stop by stop, every clause cited',
      description:
        "A guided walk over a storyline (a named chain of journeys) or one journey, assembled from the graph — never written by a model. One stop per screen in the order the storyline runs (each screen once), and one per hand-off: a move the code makes to a record (draft → submitted → approved…). A screen stop says what the screen is for (its @business sentence or the design description), who uses it, the actions it starts, the records it reads and writes and the store each lives in, the checks that matter to the business on its actions (the technical ones counted), and the one test verdict with the scope it counts over. A hand-off stop says who moves the record to which status with which action on which screen and the code that writes it (file:line), whether the code checks the status it moves from (or says not checked by the code), what must be true first (each precondition with its evidence word), and the tests of the move. A clause that refers back says which stop. Every line ends with the node ids it cites. Long: a storyline of five journeys is twenty-odd stops — for one journey's facts use journey; for one question use ask. Pass business:true for the business register (no code names; the ids are dropped too), json:true for the Tour document (the same one GET /api/tour returns).",
      inputSchema: {
        target: z
          .string()
          .describe('a storyline id or name (journeys lists them), or a flow node id, name or design id'),
        repo: z
          .string()
          .optional()
          .describe('the source that declares the storyline, when two sources declare one of the same id'),
        persona: z
          .string()
          .optional()
          .describe('whose words a status is printed in, by persona id or name, where a journey is for several'),
        business: z.boolean().optional().describe('the business register: words only, no code names, no ids'),
        json: z.boolean().optional().describe('return the Tour document as JSON instead of text'),
      },
    },
    async ({ target, repo, persona, business, json }) => {
      const tour = tourOf(ctx.index(), target, {
        metas: ctx.meta().journeys,
        ...(repo ? { repo } : {}),
        ...(persona ? { persona } : {}),
      });
      if (!tour) {
        const tree = journeyTree(ctx.index(), ctx.meta().journeys, repo ? new Set([repo]) : null);
        return text(
          `no storyline or journey "${target}"${repo ? ` in ${repo}` : ''} — storylines: ${tree.storylines.map((s) => `${s.id} (${s.name}, ${s.repo})`).join(' · ') || 'none declared'}; or pass a flow node id (journeys lists them)`,
        );
      }
      if (json) return text(JSON.stringify(tour, null, 2));
      return text(tourLines(tour, { business: !!business }).join('\n'));
    },
  );

  ctx.server.registerTool(
    'ask',
    {
      title: 'Ask — a question answered from the graph, every line cited',
      description:
        "Answers a question in plain words from the graph — a small grammar, not a model, so it never guesses. Seven shapes: (1) where is <record> set to <status>, and what must be true first — the function that writes that status (file:line), the action and screen of the journey that runs it, what must be true first (the move's own status check or not checked by the code, each precondition with its tier and evidence word, the decisions on the way, the technical checks counted), the test cases that prove the writer under the one verdict with its scope, and the path from the screen to the record; (2) what guards <action | route | screen> — its gates and rules by tier, each with its evidence; (3) how does <A> reach <B> — the shortest chain of calls, requests, renders, reads and writes the graph knows, hop by hop, or no path the graph knows; (4) what proves <screen | action | gate> — the cases with their own last runs; (5) who may <action> — the roles the code hands the role check on the action (read from the code, never a description), and which roles can do which actions as a table; (6) can <thing> be configured — the settings, switches and set-up screens whose words meet it, or that none was found; (7) what happens to <record> once it is <status> — the moves out of it and the screens that reach the record. A question worded another way is read as its nearest shape and the first line of the answer says how it was read (I read that as: …); any other question gets the shapes back. Every line ends with the node ids it cites — follow them with describe_node, gate or journey. Pass repo to keep one source (two sources may both have an invoices record), business:true for the business register, json:true for the AskAnswer document (the same one GET /api/ask returns). Use it to land on the ids the other tools take, from the words a person used.",
      inputSchema: {
        question: z.string().describe('the question, in plain words'),
        repo: z.string().optional().describe('limit to one source/repo name'),
        business: z.boolean().optional().describe('the business register: words only, no code names, no ids'),
        json: z.boolean().optional().describe('return the AskAnswer document as JSON instead of text'),
      },
    },
    async ({ question, repo, business, json }) => {
      const a = ask(ctx.index(), question, { metas: ctx.meta().journeys, ...(repo ? { repo } : {}) });
      if (json) return text(JSON.stringify(a, null, 2));
      return text(askLines(a, { business: !!business }).join('\n'));
    },
  );
}
