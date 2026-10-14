/**
 * Tool tiers (round 2026-10-10, proposal 9). Thirty-odd tools is a long menu for an agent that only needs to
 * orient, find, walk and check: the **core** tier is the handful that answers those, and **all** is every tool
 * this build registers. Core is the default; `.farsight/settings.json → mcp.tools` chooses (the workspace's
 * word wins), else the `FARSIGHT_TOOLS` environment variable, else core. `tools` and `expand` are in both
 * tiers — one lists the menu, the other returns what a budget left out.
 *
 * Pure: the names, and the rule that picks the tier.
 */

export type ToolTier = 'core' | 'all';

/**
 * The core tier: orient (`graph_overview`, `journeys`), find (`search_graph`), read one thing (`describe_node`,
 * `gate`), walk (`journey`, `trace_flow`), check a change (`impact_of`, `test_coverage`), and `affected` when a
 * code-host source grants agents read (it is not registered otherwise), and `ask` — a question in plain words
 * answered from the graph, which lands an agent on the ids every other tool takes (the tour it sits beside is long,
 * and in the all tier), and `roles` — who may do what, the first question an outsider asks. Read-only, every one.
 */
export const CORE_TOOLS: readonly string[] = [
  'graph_overview', 'journeys', 'journey', 'describe_node', 'search_graph', 'trace_flow', 'impact_of', 'gate', 'test_coverage',
  'affected', 'ask', 'roles',
];

/** In both tiers: the menu itself, and the call that returns what a budget left out. */
export const ALWAYS_TOOLS: readonly string[] = ['tools', 'expand'];

/** Is this tool on in this tier? */
export function inTier(name: string, tier: ToolTier): boolean {
  return tier === 'all' || CORE_TOOLS.includes(name) || ALWAYS_TOOLS.includes(name);
}

/** The tier a tool belongs to — the smallest one it is in. */
export function tierOf(name: string): ToolTier {
  return CORE_TOOLS.includes(name) || ALWAYS_TOOLS.includes(name) ? 'core' : 'all';
}

/** Where the tier on in this session came from. */
export type TierFrom = 'settings' | 'env' | 'default';

/**
 * The tier for this session: `settings` (`mcp.tools` in `.farsight/settings.json`) wins over `env`
 * (`FARSIGHT_TOOLS`), and core is the default. Anything else in either place is ignored with its word kept,
 * so `tools` can say what it did not understand.
 */
export function resolveTier(settings: unknown, env: string | undefined): { tier: ToolTier; from: TierFrom; ignored?: string } {
  const norm = (v: unknown): ToolTier | null => (v === 'core' || v === 'all' ? v : null);
  const s = norm(settings);
  if (s) return { tier: s, from: 'settings' };
  const e = norm(env?.trim().toLowerCase());
  const ignored = settings != null && settings !== '' ? String(settings) : env && !e ? env : undefined;
  if (e) return { tier: e, from: 'env', ...(ignored ? { ignored } : {}) };
  return { tier: 'core', from: 'default', ...(ignored ? { ignored } : {}) };
}

/** The one line `graph_overview` ends with: which tier is on, how many tools, and how to get the other. */
export function tierLine(o: { tier: ToolTier; from: TierFrom; on: number; registered: number }): string {
  const from = o.from === 'settings' ? '.farsight/settings.json → mcp.tools' : o.from === 'env' ? 'FARSIGHT_TOOLS' : 'the default';
  return o.tier === 'core'
    ? `tools: the core tier is on (${o.on} of ${o.registered} tools, from ${from}) — for every tool set "mcp": { "tools": "all" } in .farsight/settings.json or FARSIGHT_TOOLS=all and restart this server; the tools tool lists them all`
    : `tools: every tool is on (${o.on} of ${o.registered}, from ${from}) — "mcp": { "tools": "core" } (or FARSIGHT_TOOLS=core when settings name none) keeps the core tools plus tools and expand; the tools tool lists each with its tier`;
}
