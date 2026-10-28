/**
 * The MCP `roles` tool (outsider round 2026-10-13, worklist F4): who may do what — every action a role check stands
 * in front of, the roles the code lists for it, where the list was read from, the journeys that reach it and the
 * test that proves it. Core `roleTable()`, the same fold behind `GET /api/roles`, `farsight roles` and the gate
 * card's *who may do what*, so the four cannot disagree. In the core tier: *who may approve* is the first question
 * every outsider asked.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { roleTable, roleTableLines, type GraphIndex } from '@farsight/core';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export interface RolesToolsContext {
  server: McpServer;
  index: () => GraphIndex;
}

/** Register `roles` on `server`. */
export function registerRolesTools(ctx: RolesToolsContext): void {
  ctx.server.registerTool(
    'roles',
    {
      title: 'Who may do what — the role × action table, read from the code',
      description:
        'Every action (route) a role check stands in front of, with the roles the code lists for it — read from the named list the check is handed at that call site (requireOpsRole(p, ROLES.approve) → ops.approver), never declared — where the list was read from (the constant), the guard, the journeys and screens whose walk reaches the action, and the test that reaches it quoted by its own name with its last run and the one verdict. An action whose role list is not a named list is still a row: roles not read. Counts: actions behind a role check (roles read · not read), distinct roles, actions reached by a case whose last run passed. Use it to answer who may approve, close or requeue something, or what one role may do, before changing a role list or a guard. Pass action (an id or words: "approve", "approve an invoice") for who may do one thing; role (ops.admin or admin) for what one role may do; repo for one source; business:true for the business register; json:true for the RoleTable document (the same one GET /api/roles returns). Who holds a role is data the code does not carry — the table never says.',
      inputSchema: {
        action: z
          .string()
          .optional()
          .describe(
            'one action: a route or handler node id, or words matched against its path, summary and @business words',
          ),
        role: z
          .string()
          .optional()
          .describe('only the actions that list this role (ops.admin, or its last word: admin)'),
        repo: z.string().optional().describe('limit to one source/repo name'),
        business: z.boolean().optional().describe('the business register: words only, no code names, no ids'),
        all: z.boolean().optional().describe('list every action instead of the first 60'),
        json: z.boolean().optional().describe('return the RoleTable document as JSON instead of text'),
      },
    },
    async ({ action, role, repo, business, all, json }) => {
      const t = roleTable(ctx.index(), {
        ...(action ? { action } : {}),
        ...(role ? { role } : {}),
        ...(repo ? { repo } : {}),
      });
      if (json) return text(JSON.stringify(t, null, 2));
      if (!t.rows.length && (action || role))
        return text(
          `no action behind a role check matches${action ? ` "${action}"` : ''}${role ? ` for role ${role}` : ''} — call roles with no arguments for the whole table`,
        );
      return text(
        roleTableLines(t, { business: !!business, ...(all ? { cap: Number.MAX_SAFE_INTEGER } : {}) }).join('\n'),
      );
    },
  );
}
