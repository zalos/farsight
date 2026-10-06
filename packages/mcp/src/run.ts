/**
 * Farsight MCP server — feeds the semantic graph back into LLMs/agents.
 * The same graph humans explore through lenses, exposed as structured,
 * token-efficient tools: orient, search, trace end-to-end flows, surface
 * validation/auth rules, and assess change impact.
 *
 * Run via `farsight mcp [--graph graph.json]` (or FARSIGHT_GRAPH env var).
 */
import { resolve, dirname, join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  lifecycleLines,
  GraphStore, buildIndex, setFreshnessMeta, search, trace, rulesFor, isDeclaredOnly, journey, journeySummary, journeyChoices, journeyTransactions, screensFor, resolveEntry, categorizeBranch, businessSummary,
  t,
  readModelHubState, resolveModelHubDir,
  stitchHttp, apiSurface, consumersOf, graphToSpec, reconcile, driftMarkdown, contractLines,
  designSurface, reconcileDesign, designDriftMarkdown, designGuide, flowStatusWord,
  testsSurface, testDetail, verifiedBy, verifiedThrough, formatMetric, evidenceWord, caseWord, countedLine, countedText, breakdownText,
  impactOf, IMPACT_MAX_HOPS, impactTestsV1, impactTestsReaching, nodesInHunks, flowActions,
  testsMatrixV1, testsMatrixCsv, testsIdentity, stepCoverage,
  SnapshotDb, parseSyncRef, diffGraphs, changeSentence, toSarif, toMarkdown, CHANGE_KINDS,
  type GraphDiff, type ImpactFlowRef,
  type ImpactCut, type ImpactNode, type ImpactReport,
  type CoverageFacts, type CoverageTestRef,
  type GraphIndex, type GraphNode, type GraphEdge, type Subgraph, type Direction, type JourneyStep,
  storybookLive, type StoriesAnswer, type StorybookStatus,
  type ModelHubState, type Activity, buildLine, buildInfo, installState, currencyAdvice,
  projectFacets, projectGraph, projectsSummaryLine,
  depsRowOf, counted,
} from '@farsight/core';

/** `changed` said as what moved: a working tree that differs from HEAD is not a new commit (the Changes spine agrees). */
const changedWords = (changedBy?: 'commit' | 'working-tree'): string =>
  changedBy === 'working-tree' ? '⚠ the files changed after this run without a new commit — the working tree differs from HEAD' : '⚠ the source changed after this run';
import { ingestRepo, readSpecSource, readManifestSource, repoContentDigest } from '@farsight/parsers';
import { registerWorkTools } from './work.js';
import { registerConfigTools } from './config-tools.js';
import { registerJourneysTools } from './journeys-tools.js';

/** Serve the graph over stdio — what `farsight mcp` runs. */
export async function runMcpServer(graphArg?: string): Promise<void> {
  const { server, graphPath, nodeCount } = createMcpServer(graphArg);
  await server.connect(new StdioServerTransport());
  console.error(`farsight-mcp: serving ${graphPath} (${nodeCount()} nodes)`);
}

/**
 * The server with every tool registered and nothing connected — `runMcpServer`
 * puts it on stdio, and the package's tests put it on an in-memory transport so
 * each tool is driven exactly as an agent drives it.
 */
export function createMcpServer(graphArg?: string): { server: McpServer; graphPath: string; nodeCount: () => number } {
const graphPath = resolve(graphArg ?? process.env.FARSIGHT_GRAPH ?? 'graph.json');

// mutable so refresh_graph can swap the loaded graph in place
let store = GraphStore.load(graphPath);
let { nodes, edges } = store.toJSON();
let index: GraphIndex = buildIndex(nodes, edges);
setFreshnessMeta(index, store.meta);

// ── rendering (compact, stable, greppable) ──────────────────────

function ref(n: GraphNode): string {
  const loc = n.loc ? ` ${n.loc.repo}/${n.loc.path}:${n.loc.line}` : '';
  return `[${n.kind}] ${n.name} —${loc || ' (no source loc)'} \`${n.id}\``;
}

function nodeDetail(n: GraphNode, full = false): string {
  const lines = [ref(n)];
  // lead with the plain-language business summary — but only when it adds signal:
  // authored @business (not in docs) yes; the docs-first-sentence fallback would
  // just repeat the docs line below, so skip it there.
  const summary = businessSummary(n);
  if (summary && summary !== n.name && !(n.docs && n.docs.trim().startsWith(summary))) {
    lines.push(`  ⓘ ${summary}`);
  }
  // deprecated is load-bearing for an agent about to build on this node
  if (n.tags.includes('deprecated')) {
    const reason = n.docs?.match(/Deprecated:.*?(?=\s(?:See:|Since )|$)/s)?.[0];
    lines.push(`  ⚠ ${reason ?? 'deprecated'}`);
  }
  if (n.docs) lines.push(`  docs: ${n.docs.replace(/\n/g, ' ')}`);
  // references that are links: @see URLs, the design this screen was built from
  for (const l of n.links ?? []) {
    if (l.kind === 'see' && l.url) lines.push(`  see: ${l.url}`);
    // the document's own title first, its path after it — the same fact the HUD's doc chip prints (R21)
    else if (l.kind === 'doc' && l.ref) lines.push(`  doc: ${l.title ? `${l.title} · ${l.ref}` : l.ref}`);
  }
  if (n.design) {
    const d = n.design;
    const status = d.status === 'both' ? 'designed + built' : d.status === 'design-only' ? 'designed, not built' : 'built, not designed';
    lines.push(`  design: ${status}${d.id ? ` · ${d.id}` : ''}${d.name ? ` "${d.name}"` : ''}${d.url ? ` · ${d.url}` : ''}${d.lastModified ? ` · modified ${d.lastModified} (${d.freshness ?? 'unknown'})` : ''}${d.operations?.length ? ` · uses ${d.operations.join(', ')}` : ''}`);
    for (const x of d.drift ?? []) lines.push(`    ⚠ design drift ${x.kind}: ${x.message}`);
  }
  // a third party this code reaches: what kind of system it is, through which client,
  // and how we knew — an SDK specifier, a constant host, or farsight.config.json (R4)
  if (n.external) {
    const x = n.external;
    lines.push(`  external: ${x.kind}${x.via ? ` · via ${x.via}` : ''} · known from ${x.source}${x.ref ? ` (${x.ref})` : ''}`);
  }
  // a dependency: which kind, the range its package.json files declare, who imports it and what journeys it reaches
  if (n.kind === 'package' && n.package) lines.push(...packageLines(n));
  // the data store a table (or a store-like external) lives in, and which rule named it (data-stores.md §3.1)
  if (n.store) {
    const st = n.store;
    lines.push(`  store: ${st.name} · ${st.kind}${st.engine ? ` · ${st.engine}` : ''} · known from ${st.via}${st.ref ? ` (${st.ref})` : ''}`);
  }
  // the record's status lifecycle read from the code: statuses in order, each move with its writer (core lifecycle.ts)
  if (n.lifecycle) lines.push(...lifecycleLines(n).map((l) => `  ${l}`));
  // the workspace project the node sits in, its type and its tags by dimension (dependencies-and-nx.md §2.2)
  const projRepo = n.loc?.repo ?? n.id.split('::')[0]!;
  if (n.project && store.meta.projects?.[projRepo]?.tool !== 'none') {
    const repo = projRepo;
    const f = projectFacets(n, store.meta.projects?.[repo]);
    const dims = store.meta.projects?.[repo]?.tagDimensions ?? [];
    const words = Object.entries(f?.byDimension ?? {}).map(([k, vs]) => `${dims.find((d) => d.key === k)?.label ?? k} ${vs.map((v) => v.word).join(', ')}`);
    if (f?.other.length) words.push(`other ${f.other.join(', ')}`);
    lines.push(`  project: ${n.project.name}${n.project.type ? ` · ${n.project.type}` : ''} · ${n.project.root}${words.length ? ` · ${words.join(' · ')}` : ''}`);
  }
  // what verifies this — declared · reached · verified, never conflated
  const covers = verifiedBy(index, n.id);
  // a table is never covered directly: a test reaches it through the function that reads or writes it (01 §3.2)
  const through = !covers.length && n.kind === 'table' ? verifiedThrough(index, n.id) : [];
  if (covers.length) {
    const sc = stepCoverage(index, n.id);
    lines.push(`  verified by: ${covers.length} test(s)${sc ? ` — e2e ${sc.e2e} · unit/integration ${sc.unit}${sc.observed ? ' · a run observed it' : ''}` : ''}`);
    for (const t of covers.slice(0, 8)) {
      const how = t.evidence === 'declared' ? 'declared by the test author'
        : t.evidence === 'static' ? 'inferred from what the test imports or opens'
        : t.runLevel ? `reached by the ${t.level} run` : 'reached when the test ran';
      const run = t.at ? ` · ${t.status ?? 'unknown'} ${t.at.slice(0, 10)}${t.stale ? ' ⚠ stale' : t.freshness === 'unknown' ? ' (freshness unknown)' : ''}` : '';
      lines.push(`    ${t.level === 'e2e' ? '◎' : '○'} ${t.name} — ${how}${run}`);
    }
    if (covers.length > 8) lines.push(`    … +${covers.length - 8} more`);
  } else if (through.length) {
    lines.push('  verified by: nothing directly — no test in the graph names this table');
    lines.push(`  reached by ${through.length} test(s) through its accessors:`);
    for (const t of through.slice(0, 8)) {
      const accessor = (t.via ? index.byId.get(t.via)?.name : undefined) ?? t.via ?? '?';
      const cls = t.evidence === 'observed' ? 'verified by a run' : t.evidence === 'static' ? 'reached by tests' : 'declared only';
      lines.push(`    ${accessor} ← ${t.name} (${cls})`);
    }
    if (through.length > 8) lines.push(`    … +${through.length - 8} more`);
  } else if (testsIndexed()) {
    lines.push('  verified by: nothing — no test in the graph reaches this node');
  }
  if (n.test) {
    const t = n.test;
    lines.push(`  test: ${t.level} · ${t.runner}${t.project ? ` · ${t.project}` : ''}${t.suite.length ? ` · ${t.suite.join(' › ')}` : ''}`);
    if (t.declares?.length) lines.push(`    declares: ${t.declares.join(', ')}`);
    if (t.unresolved?.length) lines.push(`    ⚠ declares ${t.unresolved.join(', ')}, which nothing in the graph matches`);
    if (t.run) lines.push(`    last run: ${t.run.status} at ${t.run.at} — ${t.run.freshness === 'unchanged' ? 'the source is unchanged since' : t.run.freshness === 'changed' ? changedWords(t.run.changedBy) : 'whether the source changed since is unknown (no digest recorded)'}`);
  }
  if (n.signature) lines.push(`  definition: ${n.signature.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (n.tags.length) lines.push(`  tags: ${n.tags.join(', ')}`);
  // what the API spec declares about a route, and where it disagrees with the code
  if (n.contract) lines.push(...contractLines(n.contract));
  const outs = index.out.get(n.id) ?? [];
  const ins = index.in.get(n.id) ?? [];
  // how an edge was resolved, and what a typed or hook resolution set aside — the reader
  // sees that `Notifier.send` was reached through its declared type, and which twin was not drawn
  const how = (e: GraphEdge): string => {
    const r = e.resolution;
    if (!r) return '';
    const alt = r.alternatives?.length ? ` · alternatives: ${r.alternatives.map((id) => index.byId.get(id)?.name ?? id).join(', ')}` : '';
    return ` · ${r.technique} ${r.confidence}${alt}`;
  };
  // a hub (`cx`, a logger, `db`) has thousands of in-edges: the list is budgeted, and the cut says what it cut
  const cap = full ? Number.MAX_SAFE_INTEGER : NODE_EDGE_CAP;
  let drawnOut = 0;
  for (const e of outs) {
    const to = index.byId.get(e.to);
    if (!to) continue;
    if (drawnOut++ < cap) lines.push(`  → ${e.kind} ${to.name} (${to.kind}) \`${to.id}\`${how(e)}`);
  }
  if (drawnOut > cap) lines.push(`  → … +${drawnOut - cap} more outgoing edge(s) — full:true lists them`);
  let drawnIn = 0;
  for (const e of ins) {
    const from = index.byId.get(e.from);
    if (!from) continue;
    if (drawnIn++ < cap) lines.push(`  ← ${e.kind} by ${from.name} (${from.kind}) \`${from.id}\`${how(e)}`);
  }
  if (drawnIn > cap) lines.push(`  ← … +${drawnIn - cap} more incoming edge(s) — full:true lists them`);
  return lines.join('\n');
}

/**
 * describe_node's package block (docs/proposals/dependencies-and-nx.md §2.3): scope · version ·
 * declared in · importers · journeys reached, each number with its words. `farsight deps where`
 * and GET /api/deps/where list every importing file.
 */
function packageLines(n: GraphNode): string[] {
  const p = n.package!;
  const row = depsRowOf(index, n);
  const declared = p.declaredIn?.length
    ? `declared ${p.version ?? '(ranges differ)'} in ${p.declaredIn.join(', ')}${p.dev ? ' (devDependencies only)' : ''}`
    : p.scope === 'workspace' ? 'resolved by alias or workspace name, no package.json range' : 'declared in no package.json';
  const out = [`  package: ${p.scope}${p.project ? ` · project ${p.project}` : ''}${p.root ? ` · ${p.root}` : ''} · ${declared}`];
  if (new Set(row.versions.map((v) => v.range)).size > 1) out.push(`    ranges: ${row.versions.map((v) => `${v.where} ${v.range}`).join(' · ')}`);
  out.push(`    ${countedText(row.importers)} · ${countedText(row.journeys)}${row.journeyRefs.length ? ` — ${row.journeyRefs.map((j) => j.name).join(', ')}` : ''}`);
  if (p.externalId) out.push(`    the SDK of ${index.byId.get(p.externalId)?.name ?? p.externalId} (\`${p.externalId}\`)`);
  if (p.note) out.push(`    ⚠ ${p.note}`);
  out.push('    every importing file: farsight deps where ' + n.name + ' · impact_of for what uses it per hop');
  return out;
}

/** Does this graph carry any test node? Decides whether "no test reaches this" is a finding or just silence. */
function testsIndexed(): boolean {
  for (const n of index.byId.values()) if (n.kind === 'test') return true;
  return false;
}

/** In-edge / out-edge budget for describe_node — a hub's thousand callers are counted, not printed. */
const NODE_EDGE_CAP = 40;

/** A guard or rule that is a checkpoint: the journey's own filter — config/env schemas and plumbing never gate a request. */
function isGate(n: GraphNode): boolean {
  if (n.kind === 'guard') return true;
  return n.kind === 'rule' && !n.tags.includes('env-schema') && !n.tags.includes('plumbing');
}

/** The guards/rules/flags that attach to a node by a `guards`/`validates` edge — the same edges `rulesFor` reads. */
function checksOn(nodeId: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const e of index.in.get(nodeId) ?? []) {
    if (e.kind !== 'guards' && e.kind !== 'validates') continue;
    const src = index.byId.get(e.from);
    if (src && (src.kind === 'guard' || src.kind === 'rule' || src.kind === 'flag') && !out.some((x) => x.id === src.id)) out.push(src);
  }
  return out;
}

const gateGlyph = (g: GraphNode): string => (g.kind === 'guard' ? '🔒' : g.kind === 'flag' ? '⚑' : '⛨');
const locOf = (n: { loc?: GraphNode['loc'] }): string => (n.loc ? `${n.loc.path}:${n.loc.line}` : '(no source loc)');

/** Journeys × actions per node — one journey walk per flow, so it is computed once per loaded graph. */
let flowsCache: { index: GraphIndex; map: Map<string, ImpactFlowRef[]> } | null = null;
function flowsByNode(): Map<string, ImpactFlowRef[]> {
  if (!flowsCache || flowsCache.index !== index) flowsCache = { index, map: flowActions(index) };
  return flowsCache.map;
}

/**
 * What an agent needs before editing a node, from folds that already exist:
 * what uses it (impactOf, per hop, never summed), where a request enters it
 * (the routes and pages upstream, with the gates on each), the checks on the
 * node itself, the journeys it appears in, and its API seam. Nothing here is
 * computed a second way — each line names the tool that answers it in full.
 */
function changeContext(n: GraphNode): string[] {
  const out = ['', '## before you change it'];
  let up: ImpactReport | undefined;
  try { up = impactOf(index, n.id, { hops: 3, direction: 'upstream', perHopCap: 200 }); } catch { up = undefined; }
  if (up) {
    const clauses = up.hops.map((h) => h.hop === 1 ? `${h.found} use it directly` : h.hop === 2 ? `${h.found} more reach it through those` : `${h.found} more at ${h.hop} hops`);
    out.push(`used by: ${clauses.length ? clauses.join(' · ') : 'none indexed — nothing in this graph uses it'}${up.bound === 'floor' ? ' (≥ a floor)' : ''} — within 3 hops upstream, never added together; impact_of lists each with the tests to run`);
  }
  // where a request comes in: the node itself when it is a route or a page, else the entries upstream
  const entries: { node: GraphNode; hop: number }[] = [];
  if (n.kind === 'route' || n.kind === 'page') entries.push({ node: n, hop: 0 });
  for (const h of up?.hops ?? []) for (const x of h.nodes) {
    const node = index.byId.get(x.nodeId);
    if (node && (node.kind === 'route' || node.kind === 'page')) entries.push({ node, hop: x.hop });
  }
  if (entries.length) {
    out.push(`entered through ${entries.length} route(s)/page(s) within 3 hops — the checks in force on each:`);
    for (const { node, hop } of entries.slice(0, 10)) {
      const checks = checksOn(node.id).filter(isGate);
      // the journey's rule: a route that is not built carries its spec security as a planned gate
      const spec = isDeclaredOnly(node) ? (node.contract?.security ?? []).filter((sec) => !checks.some((c) => c.name === sec)) : [];
      const words = [
        ...checks.map((c) => `${gateGlyph(c)} ${c.name}`),
        ...spec.map((sec) => `🔒 ${sec} (planned — the spec requires it, the route is not built)`),
      ];
      out.push(`  ⇢ [${node.kind}] ${node.name}${hop ? ` · hop ${hop}` : ' · this node'} — ${words.length ? words.join(' · ') : 'no gate indexed'} \`${node.id}\``);
    }
    if (entries.length > 10) out.push(`  … +${entries.length - 10} more entry point(s) — impact_of lists them`);
  } else if (up) {
    out.push('entered through: none indexed — no route or page reaches it within 3 hops (a job, a script, or a cut path)');
  }
  // checks attached to this node itself
  const own = checksOn(n.id);
  if (own.length) {
    out.push(`checks on this node: ${own.map((c) => `${gateGlyph(c)} ${c.name}${isGate(c) ? '' : ' (config/env schema — not a gate)'} \`${c.id}\``).join(' · ')}`);
  }
  // a guard or rule: what it protects
  if (n.kind === 'guard' || n.kind === 'rule' || n.kind === 'flag') {
    const targets = (index.out.get(n.id) ?? []).filter((e) => e.kind === 'guards' || e.kind === 'validates')
      .map((e) => index.byId.get(e.to)).filter((x): x is GraphNode => !!x);
    out.push(targets.length
      ? `applies to ${targets.length}: ${targets.slice(0, 10).map((x) => `${x.name} (${x.kind})`).join(' · ')}${targets.length > 10 ? ` … +${targets.length - 10} more` : ''}`
      : 'applies to: none indexed — no guards/validates edge leaves it');
  }
  // the API seam: who calls a route, and what the spec says
  if (n.kind === 'route') {
    const consumers = consumersOf(index, n.id);
    out.push(`API: ${n.contract ? `contract ${n.contract.status}` : 'no spec on file'} · ${consumers.length} consumer(s)${consumers.length ? ` — ${consumers.slice(0, 5).map((c) => c.caller.name).join(', ')}${consumers.length > 5 ? ` +${consumers.length - 5}` : ''}` : ''} — api_surface lists them with call sites`);
  }
  // the journeys it appears in, and the actions inside them
  if (nodes.some((x) => x.kind === 'flow')) {
    const flows = flowsByNode().get(n.id) ?? [];
    if (flows.length) {
      out.push(`journeys: in ${flows.length} — ${flows.slice(0, 6).map((f) => `${f.name} (${f.actions.slice(0, 2).map((a) => `${a.screen ? `${a.screen} › ` : ''}${a.label}`).join('; ')}${f.actions.length > 2 ? ` +${f.actions.length - 2}` : ''})`).join(' · ')}${flows.length > 6 ? ` … +${flows.length - 6}` : ''} — journey prints each`);
    } else {
      out.push('journeys: not involved — no journey in this graph reaches it');
    }
  }
  return out;
}

const LANE_ORDER = ['component', 'route', 'guard', 'rule', 'function', 'table', 'queue', 'flag', 'external'];
/** Output budgets, the same discipline every printer here keeps: a cut list says what it cut. */
const LANE_CAP = 25;
const EDGE_CAP = 60;
const RULE_CAP = 30;

/**
 * The neighbourhood, in kind lanes — the shape `trace_flow` has always returned.
 * `extra` is additive (B5.3): every node says how many edges from the seed it is,
 * and the walk's stops are printed instead of being silently absent.
 */
function renderSubgraph(sub: Subgraph, title: string, extra?: { hopOf: Map<string, number>; cuts: ImpactCut[]; bound: 'exact' | 'floor'; note?: string }): string {
  const lines = [`# ${title}`, `${sub.nodes.length} nodes, ${sub.edges.length} edges${extra ? ` · ${extra.bound === 'floor' ? '≥ a floor' : 'exact'}` : ''}`];
  if (extra?.bound === 'floor' && extra.note) lines.push(`≥ a floor: ${extra.note}`);
  lines.push('');
  const byKind = new Map<string, GraphNode[]>();
  for (const n of sub.nodes) {
    if (!byKind.has(n.kind)) byKind.set(n.kind, []);
    byKind.get(n.kind)!.push(n);
  }
  for (const kind of LANE_ORDER) {
    const group = byKind.get(kind);
    if (!group) continue;
    lines.push(`## ${kind}s (${group.length})`);
    // the output budget every printer in this file keeps: a long lane says how long it is
    const sorted = group.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of sorted.slice(0, LANE_CAP)) {
      const hop = extra?.hopOf.get(n.id);
      lines.push(`${ref(n)}${hop != null ? ` · ${hop === 0 ? 'the seed' : `hop ${hop}`}` : ''}`);
      if (n.docs) lines.push(`  ${n.docs.replace(/\n/g, ' ').slice(0, 140)}`);
    }
    if (sorted.length > LANE_CAP) lines.push(`… +${sorted.length - LANE_CAP} more ${kind}(s)`);
    lines.push('');
  }
  lines.push(`## edges (${sub.edges.length})`);
  let drawn = 0;
  for (const e of sub.edges) {
    const from = index.byId.get(e.from), to = index.byId.get(e.to);
    if (!from || !to) continue;
    if (drawn++ >= EDGE_CAP) continue;
    lines.push(`${from.name} --${e.kind}--> ${to.name}`);
  }
  if (drawn > EDGE_CAP) lines.push(`… +${drawn - EDGE_CAP} more edge(s)`);
  // where the walk stopped, by reason — never added together: two stops routinely sit
  // in front of the same nodes, so each count answers "how much more is behind this one"
  if (extra?.cuts.length) {
    lines.push('', '## not walked');
    const byReason = new Map<string, ImpactCut[]>();
    for (const c of extra.cuts) byReason.set(c.reason, [...(byReason.get(c.reason) ?? []), c]);
    for (const [reason, cs] of byReason) {
      if (reason === 'shared') {
        for (const c of cs.slice(0, 8)) lines.push(`  shared          ${c.name} — used by ${c.direct}, not opened (${c.behind} behind it)`);
        if (cs.length > 8) lines.push(`  … +${cs.length - 8} more shared helper(s) not opened`);
      } else if (reason === 'hops') {
        lines.push(`  the hop budget  ${cs.length} node(s) were reached at the edge of the walk and not expanded`);
      } else if (reason === 'cap') {
        for (const c of cs) lines.push(`  over the cap    ${c.behind} node(s) found at hop ${c.hop} and not listed`);
      } else {
        for (const c of cs.slice(0, 4)) lines.push(`  ${reason === 'setup' ? 'start-up, once ' : 'afterwards     '} ${c.name}`);
        if (cs.length > 4) lines.push(`  … +${cs.length - 4} more ${reason === 'setup' ? 'start-up' : 'afterwards'} node(s)`);
      }
    }
  }
  const rules = rulesFor(index, sub);
  if (rules.length) {
    lines.push('', `## rules & gates in this flow (${rules.length})`);
    for (const r of rules.slice(0, RULE_CAP)) lines.push(`${r.rule.kind === 'guard' ? '🔒' : '⛨'} ${r.rule.name} → applies to ${r.appliesTo.name} (${r.appliesTo.loc ? `${r.appliesTo.loc.path}:${r.appliesTo.loc.line}` : ''})`);
    if (rules.length > RULE_CAP) lines.push(`… +${rules.length - RULE_CAP} more rule/gate application(s)`);
  }
  return lines.join('\n');
}

type Scope = { repo?: string; group?: string };

/** Seeds for a flow: an exact id, else the top search hits — optionally held to one repo / group so a name match in an unrelated script cannot pull a flow off topic. */
function resolveSeeds(query: string, scope: Scope = {}): GraphNode[] {
  const direct = index.byId.get(query);
  if (direct) return [direct];
  return search(index, query, { ...scope, limit: 5 });
}

const SCOPE_INPUTS = {
  repo: z.string().optional().describe('limit to one source/repo name (see graph_overview)'),
  group: z.string().optional().describe('limit to one logical group (@group) — keeps a flow on topic when names collide'),
};

/**
 * The journey as the business lane reads it: per screen, each client-side
 * action (in the manifest's order) and the parts it runs at the two tiers the
 * band draws, in their authored words — the identifier only where nobody wrote
 * any. Gates, decisions, what was declared and not called, and coverage per
 * screen. The same `journeySummary` fold the timeline prints; nothing re-derived.
 */
function businessView(sum: ReturnType<typeof journeySummary>): string[] {
  const out: string[] = [];
  const biz = sum.business;
  if (biz.description) out.push('', biz.description);
  for (const l of biz.docs) if (l.url || l.ref) out.push(`doc: ${l.title ? `${l.title} · ` : ''}${l.url ?? l.ref}`);
  const lk = sum.links;
  for (const l of lk.requires) out.push(`◀ requires: ${l.name} \`${l.id}\``);
  for (const l of lk.leadsTo) out.push(`▶ leads to: ${l.name} \`${l.id}\``);
  for (const l of lk.partOf) out.push(`⧉ part of: ${l.name} \`${l.id}\``);
  for (const sg of sum.segments) {
    const sc = sg.screen;
    out.push('', `## ${sg.index + 1} · ${sc ? `${sc.designId ? `${sc.designId} ` : ''}${sc.name}${sc.business && sc.business !== sc.name ? ` — ${sc.business}` : ''}` : 'before the first screen'}`);
    const cov = sum.coverage?.segments[sg.index];
    if (cov) out.push(`   verified: ${cov.tests.length ? `${formatMetric(cov.metric)} of ${cov.metric.scopeLabel} · ${cov.e2e === 'none' ? 'no end-to-end test' : `e2e ${cov.e2e}`}` : 'none indexed'}`);
    const moments = [...sg.moments].sort((a, b) => a.rank - b.rank || a.index - b.index);
    for (const mo of moments) {
      const head = `• ${mo.label}${mo.business && mo.business !== mo.label ? ` — ${mo.business}` : ''}${mo.declared ? '' : ' (not in the screen\'s design)'}`;
      // an action the journey already took on an earlier screen was told there: one line, not its parts again
      if (mo.repeat) { out.push(`${head} ↺ already done on an earlier screen`); continue; }
      out.push(head);
      const mine = sg.markers.filter((m) => m.moment === mo.index && !m.helper && (m.tier ?? 0) <= 1);
      // the parts, in their authored words; a line that repeats the one above it or the action's
      // own headline (a route's handler carries its route's summary) is said once
      const said = new Set([mo.label, mo.business].filter((x): x is string => !!x));
      const parts = mine.filter((m) => (m.kind === 'step' || m.kind === 'call') && !m.repeat);
      let shown = 0;
      for (const m of parts) {
        const words = m.title ?? (m.kind === 'call' && m.method ? `${m.method} ${m.path ?? ''}`.trim() : m.name);
        if (m.kind !== 'call' && said.has(words)) continue;
        said.add(words);
        if (shown++ >= 8) continue;
        out.push(`${'   '.repeat((m.tier ?? 0) + 1)}${m.kind === 'call' ? 'asks the server: ' : ''}${words}${m.planned ? ' (planned — not built)' : ''}`);
      }
      if (shown > 8) out.push(`   … +${shown - 8} more part(s) — view:timeline lists them`);
      const again = mine.filter((m) => (m.kind === 'step' || m.kind === 'call') && m.repeat).length;
      if (again) out.push(`   ↺ ${again} part(s) already run earlier in this journey`);
      // what it keeps, sends and reaches — one line each, names deduplicated
      const names = (pred: (m: typeof mine[number]) => boolean) => [...new Set(mine.filter(pred).map((m) => m.name))];
      const reads = names((m) => m.kind === 'record' && m.op !== 'writes');
      const writes = names((m) => m.kind === 'record' && m.op === 'writes');
      if (reads.length || writes.length) out.push(`   records: ${[writes.length ? `writes ${writes.join(', ')}` : '', reads.length ? `reads ${reads.join(', ')}` : ''].filter(Boolean).join(' · ')}`);
      const sends = names((m) => m.kind === 'message');
      if (sends.length) out.push(`   sends: ${sends.join(', ')}`);
      const reaches = names((m) => m.kind === 'external');
      if (reaches.length) out.push(`   reaches: ${reaches.join(', ')}`);
      if (mo.afterwards.length) out.push(`   afterwards: ${[...new Set(mo.afterwards.map((x) => x.title ?? x.name))].join(' · ')}`);
    }
    for (const d of sg.declaredOnly) out.push(`⋯ ${d.label} — declared for this screen, not called by code`);
    if (sg.gates.length) out.push(`   gates: ${sg.gates.map((g) => `${g.kind === 'rule' ? '⛨' : '🔒'} ${g.name}${g.planned ? ' (planned)' : ''}${g.count > 1 ? ` ×${g.count}` : ''}`).join(' · ')}`);
    // business decisions in their labels; a guard-class branch is a check, counted beside the gates rather than printed as code
    const bizDecisions = sg.decisions.filter((d) => d.class === 'business');
    const guardDecisions = sg.decisions.length - bizDecisions.length;
    if (bizDecisions.length) out.push(`   decisions: ${bizDecisions.map((d) => `⑂ ${d.label}`).join(' · ')}`);
    // one number for what nobody put in plain language, the same the HUD prints in every register
    const un = sg.counted?.notInWords;
    if (un?.n) out.push(`   ${countedText(un, { lens: 'business' })} (${breakdownText({ ...un, breakdown: un.breakdown?.filter((p) => p.n) })}) — view:timeline forks:true lists them`);
    else if (guardDecisions || sg.untranslated) out.push(`   ${[guardDecisions ? `${guardDecisions} guard branch(es)` : '', sg.untranslated ? `${sg.untranslated} technical condition(s) not translated` : ''].filter(Boolean).join(' · ')} — view:timeline forks:true lists them`);
  }
  const sys = sum.system;
  if (sys.records.length) out.push('', `records: ${sys.records.map((r) => `${r.name}${r.ops.length ? ` (${r.ops.join('/')})` : ''}`).join(' · ')}`);
  if (sys.messages.length) out.push(`messages: ${sys.messages.map((m) => m.name).join(' · ')}`);
  if (sys.externals.length) out.push(`third parties: ${sys.externals.map((m) => m.name).join(' · ')}`);
  return out;
}

// via → arrow glyph for the journey timeline
const JOURNEY_ARROW: Record<JourneyStep['via'], string> = {
  entry: '▶', calls: '→', http: '⇄', renders: '↳', publishes: '⇒', consumes: '⇐', reads: '↢', writes: '↣', planned: '⋯',
};

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

// ── server ──────────────────────────────────────────────────────

const server = new McpServer({ name: 'farsight', version: '0.0.1' });

// work items (Jira / Azure DevOps): read tools always, write tools only where a source grants an agent the action
const work = registerWorkTools({ server, graphPath, index: () => index, roots: () => store.roots });
// every farsight.config.json per source — the root's and the ones scoped to a folder (config-tools.ts)
const configTools = registerConfigTools({ server, meta: () => store.meta });
// journeys by persona and group, in declared order (journey-organisation-and-config-files.md §4.4)
const journeysTools = registerJourneysTools({ server, index: () => index, meta: () => store.meta });

server.registerTool('graph_overview', {
  title: 'Graph overview',
  description: 'Orient in the codebase graph: which Farsight build is running (version · built · commit) and which wrote the graph, whether a newer build is installed, which graph file and workspace, freshness (when it was ingested), repos, node counts by kind, top tags, and entry points (pages, routes, UI components, and design flows — named features from a screens manifest that run as journeys; one journeys line counts them by persona and group, which the journeys tool lists). Also the tests freshness line, what is in it (flows, route prefixes, tables, third parties, queues), how much change history exists, and the work sources (Jira / Azure DevOps) with their freshness, items by state and which work_* write tools this server grants. Ends with "keeping current": what is out of date and the steps to check, update, restart and re-ingest. Use first in every session, and again when a result looks stale.',
  inputSchema: {},
}, async () => {
  if (!nodes.length) {
    return text([
      '⚠ The graph is empty: 0 nodes, 0 edges.',
      'Has the repo been ingested since code landed? A repo with no parseable source also produces this.',
      'Fix: call the refresh_graph tool (re-ingests recorded sources), or run `farsight ingest <dir>` and restart.',
    ].join('\n'));
  }
  const byKind: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  const repos = new Set<string>();
  for (const n of nodes) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    n.tags.forEach((t) => (tagCounts[t] = (tagCounts[t] ?? 0) + 1));
    if (n.loc) repos.add(n.loc.repo);
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const meta = store.meta;
  const freshness = meta.generatedAt
    ? `generated: ${meta.generatedAt}${meta.files ? ` · ${meta.files} source files` : ''}${meta.sourceHash ? ` · source-hash ${meta.sourceHash}` : ''}${meta.sync != null ? ` · sync:${meta.sync}` : ''} — if the code has changed since, call refresh_graph`
    : 'generated: unknown (older snapshot without metadata) — call refresh_graph if in doubt';
  const ingestedBy = meta.farsight ? `${meta.farsight.version} · built ${meta.farsight.built}${meta.farsight.commit ? ` · commit ${meta.farsight.commit}` : ''}` : 'unknown (graph written before builds were stamped)';
  const lines = [
    `Farsight semantic graph: ${nodes.length} nodes, ${edges.length} edges`,
    // which Farsight: the running build, and the build that wrote the graph — a consumer checks both before trusting a feature is there
    `running: ${buildLine()}`,
    `graph ingested by: ${ingestedBy}`,
    // which graph: the HUD's sync chip says the same thing, so a stale/other-workspace graph is caught on both sides
    `graph: ${graphPath}${meta.workspace ? ` · workspace "${meta.workspace}"` : ''}${meta.graphPath && resolve(meta.graphPath) !== graphPath ? ` (written as ${meta.graphPath})` : ''}`,
    freshness,
    `repos: ${[...repos].join(', ')}`,
    `kinds: ${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join('  ')}`,
    `tags: ${topTags.map(([t, c]) => `${t}(${c})`).join(', ')}`,
    ...testsLines(), ...storiesOverviewLines(), ...projectsOverviewLines(), ...configTools.overviewLines(),
    '',
    '## what is in it',
    ...journeysTools.overviewLines(),
    ...flowLines(),
    ...routePrefixLines(),
    ...dataLines(),
    ...queueLines(),
    ...(nodes.some((n) => n.kind === 'flow' || n.design) ? ['', 'design: screens and flows are in the graph — design_surface lists them; journey from a flow walks a feature screen by screen; design_guide explains how to author one.'] : []),
    ...historyLines(),
    ...work.overviewLines(),
    '',
    ...currencyLines(),
  ];
  return text(lines.join('\n'));
});

/** One line when a source recorded its projects: the tool, projects by type, dependencies, and projects per tag value of each dimension. */
function projectsOverviewLines(): string[] {
  // a source with no workspace tool is one project, itself — nothing to say beyond its name
  if (!Object.values(store.meta.projects ?? {}).some((m) => m.tool !== 'none')) return [];
  const line = projectsSummaryLine(projectGraph(index, store.meta.projects));
  return line ? [`projects: ${line}`] : [];
}

/**
 * The named features a manifest declares, each with the one status word the HUD
 * prints for it. The overview used to list every way in — on the reference app that was a
 * hundred lines of routes and pages before anything else could be read; where a
 * person can start is what `design_surface` and `api_surface` answer in full.
 */
function flowLines(): string[] {
  const flows = nodes.filter((n) => n.kind === 'flow');
  if (!flows.length) return [];
  const built = (f: GraphNode) => {
    const screens = (index.out.get(f.id) ?? []).filter((e) => e.kind === 'renders').map((e) => index.byId.get(e.to)).filter((n): n is GraphNode => !!n);
    return { b: screens.filter((n) => !!n.loc).length, t: screens.length };
  };
  const rows = flows.slice(0, 12).map((f) => {
    const { b, t } = built(f);
    return `flow ${f.name} — ${flowStatusWord(b, t).text} \`${f.id}\``;
  });
  if (flows.length > rows.length) rows.push(`… +${flows.length - rows.length} more — design_surface lists them all`);
  return rows;
}

/**
 * Routes by their shared prefix rather than one line each: an overview says how
 * big the surface is and where it lives, and `api_surface` lists every
 * operation with its contract when that is the question.
 */
function routePrefixLines(): string[] {
  const routes = nodes.filter((n) => n.kind === 'route');
  if (!routes.length) return [];
  const by: Record<string, number> = {};
  for (const r of routes) {
    const path = r.name.replace(/^[A-Z]+\s+/, '');
    const key = path.split('/').filter(Boolean).slice(0, 3).map((p) => (p.startsWith(':') || p.startsWith('{') ? '*' : p)).join('/');
    by[key ? `/${key}` : '/'] = (by[key ? `/${key}` : '/'] ?? 0) + 1;
  }
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const rest = routes.length - top.reduce((a, [, c]) => a + c, 0);
  return [`routes: ${routes.length} — ${top.map(([k, c]) => `${k} (${c})`).join(' · ')}${rest > 0 ? ` · +${rest} elsewhere` : ''} — api_surface lists them with their contracts`];
}

/** What the code keeps and who else it calls: tables and third parties by name. */
function dataLines(): string[] {
  const out: string[] = [];
  const tables = nodes.filter((n) => n.kind === 'table');
  if (tables.length) {
    const names = tables.slice(0, 14).map((n) => n.name);
    out.push(`tables: ${tables.length} — ${names.join(', ')}${tables.length > names.length ? `, +${tables.length - names.length} more` : ''}`);
  }
  const ext = nodes.filter((n) => n.kind === 'external');
  if (ext.length) out.push(`third parties: ${ext.map((n) => `${n.name}${n.external ? ` (${n.external.kind})` : ''}`).join(' · ')}`);
  if (nodes.some((n) => n.kind === 'package')) {
    const pk = nodes.filter((n) => n.kind === 'package');
    const third = pk.filter((n) => n.package?.scope !== 'workspace').length;
    const c = counted(pk.length, 'count.unit.packages', 'count.scope.workspace', 'mcp graph_overview → package nodes', { breakdown: [
      { key: 'count.part.packagesThirdParty', n: third }, { key: 'count.part.packagesWorkspace', n: pk.length - third }] });
    out.push(`dependencies: ${countedText(c, { scope: false })} (${breakdownText(c)}) — search_graph kind:package, describe_node <package id>, farsight deps list`);
  }
  const unknown = nodes.filter((n) => n.kind === 'unknown');
  if (unknown.length) out.push(`unresolved calls: ${unknown.length} — a fetch this build could not match to a route; describe_node names each`);
  return out;
}

/**
 * One line per queue: who reads it, and who writes it — with the producer fact
 * said straight. A queue whose only producer is a script under `scripts/` has no
 * production producer, and saying "produced by pilot-e2e.mjs" would read as if
 * the app published it (R8).
 */
function queueLines(): string[] {
  const queues = nodes.filter((n) => n.kind === 'queue');
  if (!queues.length) return [];
  const out = ['', '## queues'];
  for (const q of queues) {
    const consumers = (index.out.get(q.id) ?? []).filter((e) => e.kind === 'consumes')
      .map((e) => index.byId.get(e.to)).filter((n): n is GraphNode => !!n);
    const producers = (index.in.get(q.id) ?? []).filter((e) => e.kind === 'publishes')
      .map((e) => index.byId.get(e.from)).filter((n): n is GraphNode => !!n);
    const scriptsOnly = producers.length > 0 && producers.every((n) => n.loc?.path.startsWith('scripts/'));
    const produced = !producers.length
      ? 'no producer indexed'
      : scriptsOnly
        ? `no production producer (${[...new Set(producers.map((n) => n.loc!.path))].join(', ')} only)`
        : `produced by ${producers.filter((n) => !n.loc?.path.startsWith('scripts/')).map((n) => n.name).join(', ')}`;
    const consumed = consumers.length ? `consumed by ${consumers.map((n) => n.name).join(', ')}` : 'no consumer indexed';
    out.push(`queue ${q.name} — ${consumed}; ${produced}`);
  }
  return out;
}

/**
 * The tests freshness line: how much is indexed, what the coverage floor is, and
 * every blind spot the ingest recorded. Silent when no test node exists, so a
 * graph from before this pass reads exactly as it did.
 */
function testsLines(): string[] {
  if (!testsIndexed()) return [];
  const surface = testsSurface(index, null, store.meta.tests);
  const c = surface.counts;
  const out = [
    `tests: ${c.cases} case(s) in ${c.files} file(s) · ${c.covers} covers edge(s) (declared ${c.declared} · inferred ${c.static} · observed ${c.observed}) · coverage ${formatMetric(surface.metric)} of ${surface.metric.scopeLabel}`,
  ];
  for (const s of surface.sources) out.push(`  ${s.repo} · ${s.level} · ${s.runner} — ${s.counted ? `${countedText(s.counted.files, { scope: false })}, ${countedText(s.counted.cases)} (${breakdownText({ ...s.counted.cases, breakdown: s.counted.cases.breakdown?.filter((p) => p.n) })})` : `${s.files} file(s), ${s.cases} case(s)`}; ${s.freshness}`);
  // blind spots by kind: `gaps[]` is ordered by the ingest (missing artefacts first), so three kinds
  // is the shape of what is missing without printing every sentence here (03 §3.4).
  const gaps = Object.values(store.meta.tests ?? {}).flatMap((m) => m?.gaps ?? []);
  if (gaps.length) {
    const byKind = new Map<string, { n: number; text: string }>();
    for (const g of gaps) {
      const seen = byKind.get(g.kind);
      if (seen) seen.n++;
      else byKind.set(g.kind, { n: 1, text: g.text });
    }
    const kinds = [...byKind.entries()];
    for (const [kind, k] of kinds.slice(0, 3)) out.push(`  ⚠ ${kind}${k.n > 1 ? ` ×${k.n}` : ''}: ${k.text}`);
    if (kinds.length > 3) out.push(`  ⚠ … +${kinds.length - 3} more kind(s) of blind spot — test_coverage lists them all`);
  } else {
    // a graph written before `gaps[]` existed carries only the folded sentences
    for (const b of surface.blindSpots.slice(0, 3)) out.push(`  ⚠ ${b}`);
    if (surface.blindSpots.length > 3) out.push(`  ⚠ … +${surface.blindSpots.length - 3} more blind spot(s) — test_coverage lists them all`);
  }
  return out;
}

/** One line per repo with stories: counts from the files and where its Storybook runs (no probe — the `stories` tool asks it). Silent otherwise. */
function storiesOverviewLines(): string[] {
  return Object.entries(store.meta.stories ?? {}).map(([repo, m]) =>
    `stories: ${repo} — ${m.stories} stories over ${m.components} components from ${m.files} story file(s)${m.storybooks.length ? ` · Storybook ${m.storybooks.map((b) => b.url ?? b.configDir).join(', ')}` : ''} — the stories tool says whether it is running`);
}

/** "keeping current": is a newer build installed than this MCP runs, does the graph match it, and the steps to fix either — the same recipe the CLI and the HUD print. */
function currencyLines(): string[] {
  const m = store.meta;
  const a = currencyAdvice({ role: 'mcp', running: buildInfo(), install: installState(), graph: { farsight: m.farsight, generatedAt: m.generatedAt, sync: m.sync } });
  // the findings say what is wrong; the four-step runbook lives in `farsight
  // status`, which is where someone goes to fix it — repeating it on every
  // overview cost a tenth of the budget to say the same thing again
  // a stale or failing work source is out of date too, and work_sync is what fixes it
  const workStale = work.currencyFindings();
  const findings = [...a.findings, ...workStale];
  return [
    `## keeping current — ${!findings.length ? 'up to date: the installed build, this process and the graph agree' : `${findings.length} thing(s) out of date`}`,
    ...findings.map((x) => `⚠ ${x}`),
    ...(a.ok ? [] : ['run `farsight status` for the check · update · restart · re-ingest steps']),
  ];
}

server.registerTool('search_graph', {
  title: 'Search the graph',
  description: 'Find nodes (functions, routes, pages, components, tables, guards, rules, tests, flows…) by name, tag, docs, or path. Returns ranked matches with their ids and source locations. Use to turn a word from a request ("invoice approval", a symbol, a file) into node ids, then pass an id to describe_node, impact_of, journey or test_coverage. Narrow with kind, tag, repo or group when names collide.',
  inputSchema: {
    query: z.string().describe('search terms, e.g. "invoice finalize"'),
    // derived from the loaded graph so the filter list can't drift from what the parser emits
    kind: z.string().optional().describe(`filter: ${[...new Set(nodes.map((n) => n.kind))].sort().join('|') || 'component|page|route|function|table|rule|guard|queue'}`),
    tag: z.string().optional().describe('filter by tag, e.g. "invoice"'),
    ...SCOPE_INPUTS,
  },
}, async ({ query, kind, tag, repo, group }) => {
  const results = search(index, query, { kind, tag, repo, group });
  if (!results.length) return text(`no matches for "${query}"`);
  return text(results.map(ref).join('\n'));
});

server.registerTool('describe_node', {
  title: 'Describe a node — and what to know before changing it',
  description: 'Everything about one node an agent needs before editing it: the plain-language summary, docs and doc links, definition, tags, source location, design and API contract, the tests that verify it (declared · inferred · observed, with last run and freshness), and every in/out edge with how it was resolved. Ends with "before you change it": what uses it per hop (never summed), the routes/pages a request enters through and the gates in force on each (a not-yet-built route\'s spec security as a planned gate), the checks on the node itself, what a guard/rule applies to, a route\'s consumers, and the journeys and actions it appears in. Use after search_graph to understand one symbol; use impact_of for the full dependent list and test selection, journey for execution order.',
  inputSchema: {
    node_id: z.string().describe('node id from search/overview/trace output'),
    full: z.boolean().optional().describe(`list every edge instead of the first ${NODE_EDGE_CAP} each way`),
    context: z.boolean().optional().describe('include the "before you change it" section (default on; off skips its impact and journey walks)'),
  },
}, async ({ node_id, full, context }) => {
  const n = index.byId.get(node_id);
  if (!n) return text(`unknown node id: ${node_id}. Use search_graph to find ids.`);
  const lines = [nodeDetail(n, !!full)];
  lines.push(...(await nodeStoriesLines(n)));
  if (context !== false) lines.push(...changeContext(n));
  return text(lines.join('\n'));
});

// ── stories (ADR 9): read from the story files; drawn by a running Storybook, never started here ──

/** One Storybook's state in a line: where, whether it answered, and how to start it when it did not. */
function storybookLine(b: StorybookStatus): string {
  const where = b.url ? `${b.url}${b.urlFrom && b.urlFrom !== 'config' ? ` (url from ${b.urlFrom})` : ''}` : 'no url recorded';
  if (b.reachable) {
    const c = b.counts!;
    return `Storybook ${b.name ?? b.configDir} at ${where}: running — index lists ${c.stories} stories + ${c.docs} docs; ${c.resolved} matched a node, ${c.unresolved} matched nothing${b.notListed?.length ? `; ${b.notListed.length} story(ies) in the files are not listed yet (restart it)` : ''}`;
  }
  return `Storybook ${b.name ?? b.configDir} at ${where}: not reached (${b.error ?? 'unreachable'})${b.command ? ` — start it with \`${b.command}\`` : ''}; Farsight never starts it`;
}

/** describe_node's stories block: every story of a component with its id, name and live frame URL. Nothing for a node outside any Storybook repo with no stories. */
async function nodeStoriesLines(n: GraphNode): Promise<string[]> {
  if (n.kind !== 'component' && n.kind !== 'page') return [];
  const repo = n.loc?.repo ?? n.id.split('::')[0]!;
  const books = store.meta.stories?.[repo]?.storybooks ?? [];
  if (!n.stories?.length && !books.length) return [];
  let answer: StoriesAnswer;
  try { answer = await storybookLive([...index.byId.values()], store.meta.stories, { repos: new Set([repo]), timeoutMs: 1200 }); }
  catch { return []; }
  const list = answer.byNode[n.id] ?? [];
  const out = ['', `## stories (${list.filter((s) => s.type === 'story').length})`];
  for (const b of answer.storybooks) out.push(storybookLine(b));
  if (!list.length) { out.push('none indexed — no story file names this component as the one it renders'); return out; }
  for (const s of list) {
    const where = s.file ? ` — ${s.file}:${s.line}` : '';
    const live = s.frame ? ` · ${s.frame}` : s.inGraph && answer.storybooks.some((b) => b.reachable) ? ' · not listed by the running Storybook' : '';
    out.push(`${s.type === 'docs' ? 'docs' : 'story'} ${s.name} \`${s.id}\`${s.title ? ` (${s.title})` : ''}${where}${live}`);
    if (s.docs) out.push(`   ${s.docs}`);
  }
  return out;
}

server.registerTool('stories', {
  title: 'Stories — components drawn on their own, and the Storybooks that draw them',
  description: 'Every Storybook the graph recorded (from a `.storybook/main.*` in the repo or farsight.config.json → storybook): its URL, whether it is running right now, and how its /index.json mapped onto component nodes — matched by story id, component file or title — with every entry that matched nothing named and its reason. Then the components that carry stories, with their counts. Pass node for one component\'s stories with the iframe URL of each (describe_node prints the same block). Read only: Farsight never starts a Storybook. Use to find a component\'s visual states, to check which stories a running Storybook is missing, or to fix names that do not map.',
  inputSchema: {
    repo: z.string().optional().describe('limit to one source/repo name'),
    node: z.string().optional().describe('one component node id — its stories with live frame URLs'),
  },
}, async ({ repo, node }) => {
  if (node) {
    const n = index.byId.get(node);
    if (!n) return text(`unknown node id: ${node}. Use search_graph to find ids.`);
    const lines = await nodeStoriesLines(n);
    return text(lines.length ? [ref(n), ...lines].join('\n') : `${ref(n)}\nno stories: not a component, and its repo records no Storybook`);
  }
  const answer = await storybookLive([...index.byId.values()], store.meta.stories, { repos: repo ? new Set([repo]) : null, fresh: true });
  const metas = Object.entries(store.meta.stories ?? {}).filter(([r]) => !repo || r === repo);
  if (!metas.length) return text('no stories in the graph — no repo has a .storybook/main.* or *.stories.* files (or the graph predates the stories pass; call refresh_graph).');
  const lines: string[] = [];
  for (const [r, m] of metas) {
    lines.push(`${r}: ${m.stories} stories over ${m.components} components from ${m.files} story file(s)${m.unresolved.length ? ` · ${m.unresolved.length} file(s) reached no component` : ''}`);
    for (const u of m.unresolved) lines.push(`   ⚠ ${u.file}: ${u.reason}${u.component ? ` (${u.component})` : ''} — ${u.stories} stories`);
  }
  lines.push('');
  for (const b of answer.storybooks) {
    lines.push(storybookLine(b));
    for (const u of (b.unresolved ?? []).slice(0, 60)) lines.push(`   ✗ ${u.type} \`${u.id}\` (${u.title} / ${u.name}): ${u.reason}${u.path ? ` — componentPath → ${u.path}` : ''}${u.candidates?.length ? ` — candidates ${u.candidates.join(', ')}` : ''}`);
    if ((b.unresolved?.length ?? 0) > 60) lines.push(`   … ${b.unresolved!.length - 60} more`);
    for (const id of (b.notListed ?? []).slice(0, 20)) lines.push(`   · in the files, not listed: ${id}`);
    if ((b.notListed?.length ?? 0) > 20) lines.push(`   … ${b.notListed!.length - 20} more not listed`);
  }
  lines.push('', '## components with stories');
  const rows = Object.entries(answer.byNode).map(([id, list]) => ({ n: index.byId.get(id), list })).filter((x) => x.n)
    .sort((a, b) => ((a.list[0]?.title ?? '') + a.n!.name).localeCompare((b.list[0]?.title ?? '') + b.n!.name));
  for (const { n, list } of rows) {
    const live = list.filter((s) => s.live).length;
    lines.push(`${list[0]?.title ?? n!.name} — ${list.filter((s) => s.type === 'story').length} stories${live ? ` (${live} live)` : ''} \`${n!.id}\``);
  }
  return text(lines.join('\n'));
});

server.registerTool('trace_flow', {
  title: 'Trace a flow end-to-end',
  description: 'The neighbourhood around a node: resolves a query (or node id) to seed nodes and returns what connects to them across UI, routes, services and data, with every node\'s distance from the seed and validation/auth rules called out. Tests are never followed — a test is evidence about a node, not a dependent of it — and plumbing and rendered primitives are listed where they are met rather than opened, so one utility does not pull in the application. Use to map an unfamiliar area around a symbol or feature. The default direction is **upstream** (what uses these seeds). For what a node uses, in order, call `journey`; for what uses it, by distance and with its evidence, call `impact_of`.',
  inputSchema: {
    query: z.string().describe('feature description, symbol name, or node id — e.g. "invoice process" or "finalizeInvoice"'),
    direction: z.enum(['downstream', 'upstream', 'both']).optional().describe('default upstream — `both` answers two questions at once and is rarely what a change needs'),
    depth: z.number().int().min(1).max(8).optional().describe(`hops from the seeds, default 3; more than ${IMPACT_MAX_HOPS} is refused with a sentence`),
    expand_shared: z.boolean().optional().describe('open plumbing and rendered primitives instead of stopping at them (default off)'),
    ...SCOPE_INPUTS,
  },
}, async ({ query, direction, depth, expand_shared, repo, group }) => {
  const seeds = resolveSeeds(query, { repo, group });
  if (!seeds.length) return text(`nothing in the graph matches "${query}"`);
  const dirs: ('upstream' | 'downstream')[] = direction === 'both' ? ['upstream', 'downstream'] : [direction ?? 'upstream'];
  const hops = depth ?? 3;
  // the same fold `impact_of` answers with (docs/proposals/dependency-impact.md §6), run
  // once per direction. A neighbourhood tool lists more per hop than a change answer does,
  // so the cap is raised — and when it still fires it is printed as a cut, never dropped.
  const reports: ImpactReport[] = [];
  try {
    for (const d of dirs) for (const s of seeds) {
      reports.push(impactOf(index, s.id, { hops, direction: d, perHopCap: 200, ...(expand_shared ? { expandShared: true } : {}) }));
    }
  } catch (err) {
    return text((err as Error).message);
  }
  const hopOf = new Map<string, number>(seeds.map((s) => [s.id, 0]));
  const edgesById = new Map<string, GraphEdge>();
  for (const r of reports) {
    for (const h of r.hops) for (const n of h.nodes) {
      const known = hopOf.get(n.nodeId);
      if (known == null || n.hop < known) hopOf.set(n.nodeId, n.hop);
      edgesById.set(n.via.id, { id: n.via.id, kind: n.via.kind, from: n.via.from, to: n.via.to, ...(n.via.resolution ? { resolution: n.via.resolution } : {}) });
    }
  }
  const sub: Subgraph = {
    nodes: [...hopOf.keys()].map((id) => index.byId.get(id)!).filter(Boolean),
    edges: [...edgesById.values()],
  };
  const cuts = reports.flatMap((r) => r.cutPoints);
  const note = reports.find((r) => r.uncertainty)?.uncertainty?.note;
  return text(renderSubgraph(sub, `flow: ${query} (seeds: ${seeds.map((s) => s.name).join(', ')} · ${dirs.join(' + ')} · ${hops} hop(s))`, {
    hopOf, cuts,
    bound: reports.some((r) => r.bound === 'floor') ? 'floor' : 'exact',
    ...(note ? { note } : {}),
  }));
});

server.registerTool('journey', {
  title: 'Run a journey — ordered execution timeline',
  description: 'Play a feature through: a depth-first, call-site-ordered walk of what runs when an entry point fires — client → HTTP → route (with auth gates) → service → data writes → emitted events, across the HTTP boundary and repos. Returns a compact indented timeline (no code bodies). Entry may be a page, route, function, a designed-but-unbuilt screen (its operations become planned calls) or a design FLOW by name (e.g. "Vendor (contractor) validation": each screen in order, then the code / HTTP / gates under it; the HUD shows the same walk with the screens\' images). Declared-only operations continue as planned steps. Use to see execution order, not just what connects (that is trace_flow). Printed as the blueprint timeline: what the user sees (screens), linked journeys (◀ requires · leads to ▶ · part of), the business (docs, gates, rules, decisions), records & messages, then what the system does — system rows in request order (the screen asks · browser → the API → the service does · server → records → messages), one header per segment (screen), a `#### action` per client-side action inside it, and on every call both ends of the HTTP seam (← from the fetch line → handled at the handler, or "not built yet"). The same fold the HUD draws. Pass view:"business" for the storyboard in plain words (what each screen\'s actions do, gates, decisions — no code paths): use it to explain a feature or check a change against intent; use the default timeline to find the code to edit.',
  inputSchema: {
    entry: z.string().describe('entry point: a node id, or a query resolved to the best handler/component/route/page — e.g. "onSend" or a full node id'),
    depth: z.number().int().min(1).max(40).optional().describe('max call-nesting depth, default 20'),
    forks: z.boolean().optional().describe('include the categorized list of every conditional (if/switch/catch…) along the journey'),
    full: z.boolean().optional().describe('print every step, including the subtrees under a step the walk already ran — off by default, because a repeat is the same work a second time'),
    view: z.enum(['timeline', 'business']).optional().describe('timeline (default) = every step with code locations · business = the storyboard in plain words: per screen, each action with the parts it runs (their authored titles), the gates, decisions and records — no code paths'),
    ...SCOPE_INPUTS,
  },
}, async ({ entry, depth, forks, full, view, repo, group }) => {
  const seed = resolveEntry(index, entry, { repo, group });
  if (!seed) return text(`nothing in the graph matches "${entry}"`);
  const j = journey(index, seed.id, depth != null ? { maxDepth: depth } : {});
  if (!j.steps.length) return text(`no runnable journey from ${seed.name} (${seed.id})`);
  const built = j.steps.length - j.plannedCount;
  // cut points are local: a subtree the walk did not follow, named where it happened. Only the
  // global step budget truncates, so `⚠ truncated at cap` means "there is more everywhere", not
  // "this one branch went deep".
  // a re-visit hides nothing — the subtree was printed the first time — so it is reported apart
  const hidden = j.cutPoints.filter((c) => c.reason !== 'repeat');
  const revisits = j.cutPoints.length - hidden.length;
  const byReason = hidden.reduce<Record<string, number>>((acc, c) => { acc[c.reason] = (acc[c.reason] ?? 0) + 1; return acc; }, {});
  const cutSummary = (hidden.length
    ? ` · ${hidden.length} cut point(s): ${Object.entries(byReason).map(([r, n]) => `${r} ×${n}`).join(' · ')}`
    : '') + (revisits ? ` · ${revisits} re-visit(s) not re-walked` : '');
  // the boot is one step however many requests reach it, and deferred work is named
  // where it was registered and never walked — both are counted apart from the request (R2/R3)
  const setupCount = j.steps.filter((s) => s.setup).length;
  const deferredCount = j.steps.filter((s) => s.deferred).length;
  const asideSummary = (setupCount ? ` · ${setupCount} start-up` : '') + (deferredCount ? ` · ${deferredCount} afterwards` : '');
  // one written call with several implementations behind it: printed once as a choice, its
  // candidates listed under it, and never as a run of sibling steps (blocker 3)
  const choiceAt = journeyChoices(index, j);
  const choiceCount = new Set([...choiceAt.values()]).size;
  // which side of a transaction boundary each hop is written on — the same fold the HUD
  // draws, so an agent and a reader cannot be told different things (blocker 8). The words
  // come from the catalog for the same reason.
  const tx = journeyTransactions(index, j);
  const txWord = (order: number): string => {
    const side = tx.sideOf.get(order);
    return side ? ` · ${t(side === 'inside' ? 'journey.tx.inside' : 'journey.tx.after', 'professional')}` : '';
  };
  const choiceSummary = choiceCount ? ` · ${choiceCount} place(s) where one of several runs` : '';
  // the blueprint bands — what the user sees · the business · what the system produces — before the timeline
  const sum = journeySummary(index, j, screensFor(index, seed.id));
  const k = sum.counts;
  const lines = [
    `Journey from ${seed.name} — ${built} step(s)${j.plannedCount ? ` + ${j.plannedCount} planned (declared in the spec, not yet built)` : ''}${asideSummary}${choiceSummary}${cutSummary}${j.truncated ? ' · ⚠ truncated at cap' : ''}`,
    `entry: ${seed.id}`,
    // a flow says where the front door shows it: persona › group (journeys lists the rest)
    ...(seed.kind === 'flow' && journeysTools.placementLine(seed.id) ? [journeysTools.placementLine(seed.id)] : []),
    // the numbers the HUD's header prints — the same typed counts, each group naming the
    // scope it counts over (docs/COUNTS.md), so an agent quotes the number a reader sees
    sum.counted
      ? countedLine([
        sum.counted.screens, sum.counted.built, sum.counted.gates, sum.counted.checks, sum.counted.decisions, sum.counted.notInWords,
        sum.counted.actions, sum.counted.again, sum.counted.declaredNotCalled, sum.counted.actionStops,
      ], { lens: view === 'business' ? 'business' : 'code' }) + ` · ${k.records} record(s) · ${k.messages} message(s)`
      : `on this walk: ${k.screens} screen(s) · ${k.gates} gate(s), met ${k.checks} time(s) · ${k.decisions} decision(s) · ${k.records} record(s) · ${k.messages} message(s)${k.called || k.declaredNotCalled ? ` · operations: ${k.called} called by code, ${k.declaredNotCalled} declared, not called${k.again ? ` (+${k.again} called again later)` : ''}` : ''}`,
  ];
  if (view === 'business') return text([...lines, ...businessView(sum)].join('\n'));
  if (sum.user.length) {
    lines.push('', '## what the user sees');
    for (const u of sum.user) {
      const design = u.designId ? ` · design ${u.designId} (${u.designStatus === 'both' ? 'designed + built' : u.designStatus === 'design-only' ? 'designed, not built' : 'built, not designed'}${u.hasImage ? ', image on file' : ''})` : '';
      lines.push(`${u.kind === 'flow' ? '⧉' : '▭'} [${u.kind}] ${u.name}${u.business && u.business !== u.name ? ` — ${u.business}` : ''}${u.loc ? ` — ${u.loc.path}:${u.loc.line}` : ''}${design} \`${u.id}\``);
      for (const l of u.links) if (l.url || l.ref) lines.push(`   ${l.kind}: ${l.url ?? l.ref}`);
    }
  }
  if (sum.coverage) {
    const c = sum.coverage.journey;
    lines.push(`coverage: ${formatMetric(c.metric)} of ${c.metric.scopeLabel} — ${c.note}`);
  }
  const lk = sum.links;
  if (lk.requires.length || lk.leadsTo.length || lk.partOf.length) {
    lines.push('', '## linked journeys');
    const ref = (l: typeof lk.requires[number]) => `${l.name}${l.designId ? ` (${l.designId})` : ''} — ${l.built} of ${l.screens} screens built · ${l.how} \`${l.id}\``;
    for (const l of lk.requires) lines.push(`◀ requires: ${ref(l)}`);
    for (const l of lk.leadsTo) lines.push(`▶ leads to: ${ref(l)}`);
    for (const l of lk.partOf) lines.push(`⧉ part of: ${ref(l)}`);
  }
  const biz = sum.business;
  if (biz.description || biz.docs.length || biz.gates.length || biz.rules.length || biz.decisions.length) {
    lines.push('', '## the business');
    if (biz.description) lines.push(biz.description);
    for (const l of biz.docs) if (l.url || l.ref) lines.push(`doc: ${l.title ? `${l.title} · ` : ''}${l.url ?? l.ref}`);
    if (biz.gates.length) lines.push(`gates: ${biz.gates.map((g) => `🔒 ${g.name}${g.planned ? ' (planned)' : ''}`).join(' · ')}`);
    if (biz.rules.length) lines.push(`rules: ${biz.rules.map((r) => `⛨ ${r.name}`).join(' · ')}`);
    if (biz.decisions.length) lines.push(`decisions: ${biz.decisions.slice(0, 8).map((d) => `⑂ ${d.label}${d.class === 'guard' ? ' (guard)' : ''}`).join(' · ')}${biz.decisions.length > 8 ? ` … +${biz.decisions.length - 8}` : ''}`);
    // conditions nobody wrote a business label for are counted, never dressed up as decisions
    if (biz.untranslated.count || biz.untranslated.guardsUnlabelled) {
      const by = Object.entries(biz.untranslated.byCategory).map(([c, n]) => `${c} ×${n}`).join(' · ');
      const un = sum.counted?.notInWords;
      lines.push(un
        ? `${countedText(un)}: ${breakdownText(un)}${by ? ` — the technical ones by kind: ${by}` : ''}`
        : `${biz.untranslated.count} technical condition(s) not translated (${by})`);
    }
  }
  const sys = sum.system;
  if (sys.records.length || sys.messages.length || sys.externals.length || sys.afterwards.length) {
    lines.push('', '## records & messages');
    if (sys.records.length) lines.push(`records: ${sys.records.map((r) => `${r.name}${r.ops.length ? ` (${r.ops.join('/')})` : ''}`).join(' · ')}`);
    if (sys.messages.length) lines.push(`messages: ${sys.messages.map((m) => m.name).join(' · ')}`);
    // a third party says what kind of system it is, so "the ERP" can be read without knowing the host (R4)
    if (sys.externals.length) {
      lines.push(`external: ${sys.externals.map((m) => {
        const k = index.byId.get(m.id)?.external?.kind;
        return `${m.name}${k ? ` (${k})` : ''}`;
      }).join(' · ')}`);
    }
    // registered on this journey, runs on its own afterwards — never walked here
    if (sys.afterwards.length) lines.push(`afterwards: ${sys.afterwards.map((a) => a.name).join(' · ')}`);
  }
  // rows read as the request path downward: the screen asks · the API · the service does · records · messages
  const rowLabel = (key: string) => {
    const r = sum.systems.find((x) => x.key === key);
    if (!r) return key;
    if (r.kind === 'api') return `API · ${r.label}`;
    if (r.kind === 'repo') return r.side === 'ux' ? `the screen asks · ${r.label} · browser` : `the service does · ${r.label} · server`;
    return r.label;
  };
  lines.push('', `## what the system does${sys.repos.length > 1 ? ` (across ${sys.repos.join(', ')})` : ''}${sum.systems.length ? ` — rows: ${sum.systems.map((r) => `${rowLabel(r.key)}${r.planned ? ' (planned)' : ''}`).join(' · ')}` : ''}`);
  // segment headers: one per screen, with the gates it meets (deduped) — the blueprint timeline's columns.
  // Inside a segment, a `#### action` sub-heading opens each client-side action and its consequences.
  const segAt = new Map(sum.segments.map((sg) => [sg.from, sg] as const));
  const momentAt = new Map<number, { seg: number; moment: typeof sum.segments[number]['moments'][number] }>();
  const markerAt = new Map<number, typeof sum.segments[number]['markers'][number]>();
  for (const sg of sum.segments) {
    for (const mo of sg.moments) if (sg.moments.length > 1 || mo.callStep != null) momentAt.set(mo.from, { seg: sg.index, moment: mo });
    for (const mk of sg.markers) markerAt.set(mk.stepOrder, mk);
  }
  // what would run a deferred hook later: the hook-binding edge the parser resolved
  // (`meta.via: 'hook'`). Absent, the honest answer is only "not walked".
  const runsWhen = (nodeId: string): string => {
    const callers = (index.in.get(nodeId) ?? [])
      .filter((e) => e.meta?.via === 'hook')
      .map((e) => index.byId.get(e.from)?.name)
      .filter((n): n is string => !!n);
    const named = [...new Set(callers)];
    return named.length ? ` (runs when ${named.join(' or ')} runs, not walked)` : ' (not walked)';
  };
  const seamOf = (order: number): string => {
    const mk = markerAt.get(order);
    if (!mk || mk.kind !== 'call') return '';
    const from = mk.caller ? ` ← from ${mk.caller.path}:${mk.caller.line}` : '';
    const to = mk.handler ? ` → handled ${mk.handler.path}:${mk.handler.line}` : ' → handled: not built yet';
    return from + to;
  };
  // A step the walk already ran is printed once, as ↺, and what hangs under it is
  // not printed again — it is the same work a second time, and on the reference app's
  // submission flow those subtrees are two thirds of the output. `full: true`
  // prints them; the header still counts every step either way.
  let foldUnder: { depth: number } | null = null;
  let folded = 0;
  for (const s of j.steps) {
    if (foldUnder && s.depth > foldUnder.depth) { folded++; continue; }
    foldUnder = null;
    if (!full && s.repeat) foldUnder = { depth: s.depth };
    const n = index.byId.get(s.nodeId);
    if (!n) continue;
    const sg = segAt.get(s.order);
    if (sg) {
      const gates = sg.gates.map((g) => `${g.kind === 'rule' ? '⛨' : '🔒'} ${g.name}${g.planned ? ' (planned)' : ''}${g.count > 1 ? ` ×${g.count}` : ''}`).join(' · ');
      lines.push(`### segment ${sg.index + 1}${sg.screen ? ` · ${sg.screen.designId ? `${sg.screen.designId} ` : ''}${sg.screen.name}` : ' · before the first screen'} — ${sg.counts.calls} call(s)${sg.counts.planned ? `, ${sg.counts.planned} planned` : ''}${sg.counts.records ? `, ${sg.counts.records} record(s)` : ''}${sg.counts.messages ? `, ${sg.counts.messages} message(s)` : ''}${gates ? ` — ${gates}` : ''}`);
      // one coverage line per segment when the graph knows about tests at all
      const cov = sum.coverage?.segments[sg.index];
      // the end-to-end rung by name, never a boolean: `reached` means a test body
      // carries a route literal (`route-literal` LOW) and is not a verification
      // (swarm 2026-09-23, blocker 6)
      if (cov) lines.push(`  verified by: ${cov.tests.length ? `${formatMetric(cov.metric)} of ${cov.metric.scopeLabel} · e2e ${cov.counts.e2e} · unit ${cov.counts.unit} · ${cov.e2e === 'none' ? 'no end-to-end test' : `e2e ${cov.e2e}`}` : 'nothing'} — ${cov.note}`);
    }
    const mo = momentAt.get(s.order);
    if (mo) lines.push(`#### action ${mo.moment.index + 1} · ${mo.moment.label}${mo.moment.repeat ? ' ↺ already walked' : ''}${mo.moment.component ? ` — in ${mo.moment.component.label}${mo.moment.component.stepOrder < mo.moment.from ? ', still open' : ''}` : ''}`);
    if (sg?.screen && sg.from === s.order) continue; // the screen row itself is the segment header
    if (s.planned && s.planned.kind !== 'calls') {
      const p = s.planned;
      lines.push(`${'  '.repeat(s.depth)}⋯ (planned) ${p.kind === 'receives' ? 'receives' : p.kind === 'returns' ? 'returns' : 'step:'} ${p.label}${p.detail ? ` (${p.detail})` : ''}`);
      continue;
    }
    if (s.planned) {
      // the design says this unbuilt screen calls this operation — the route is real, the call is not yet
      const loc = n.loc ? `${n.loc.path}:${n.loc.line}` : '(declared in the spec — not yet built)';
      let line = `${'  '.repeat(s.depth)}⋯ (planned call · design) [${n.kind}] ${n.name} — ${loc}`;
      for (const g of s.gates) line += ` ${g.kind === 'guard' ? '🔒' : '⛨'} ${g.name}${g.planned ? ' (planned)' : ''}`;
      lines.push(line + seamOf(s.order));
      continue;
    }
    const loc = n.loc ? `${n.loc.path}:${n.loc.line}` : n.contract ? '(declared in the spec — not yet built)' : n.design?.status === 'design-only' ? `(designed${n.design.id ? ` as ${n.design.id}` : ''} — not yet built)` : '(no source loc)';
    // the boot is printed once and never descended; deferred work is named where it was
    // registered. Neither is a hop of this request, so neither takes an arrow (R2/R3).
    // a call the code resolves when it runs: the call once, then every implementation that
    // could answer it. None of them is presented as the one that ran — the code does not say.
    const ch = choiceAt.get(s.order);
    if (ch && ch.candidates[0]!.stepOrder === s.order) {
      const where = ch.at ? ` — ${ch.at.path}:${ch.at.line}` : '';
      const when = s.conditions?.length
        ? ` [when ${s.conditions[0]!.business ?? s.conditions[0]!.requires}${s.conditions.length > 1 ? ` +${s.conditions.length - 1}` : ''}]`
        : '';
      const aside = ch.setAside.length ? ` · set aside: ${ch.setAside.join(', ')}` : '';
      lines.push(`${'  '.repeat(s.depth)}${JOURNEY_ARROW[s.via]} [choice] ${ch.label}${where} — one of ${ch.candidates.length}; which one runs is settled when the app runs, not in the code${aside}${when}`);
    }
    const last = !!ch && ch.candidates[ch.candidates.length - 1]!.stepOrder === s.order;
    const lead = ch ? (last ? '└' : '├') : s.setup ? '⚙ (start-up, once)' : s.deferred ? '⧗ (afterwards)' : JOURNEY_ARROW[s.via];
    let line = `${'  '.repeat(s.depth)}${lead} [${n.kind}] ${n.name} — ${loc}`;
    // the words the band prints for this part — authored, never a humanized guess (R7c); only on
    // the two tiers the band draws, so the drill-down below them stays as terse as it was
    const mkr = markerAt.get(s.order);
    if (mkr?.title && mkr.title !== n.name && !mkr.helper && (mkr.tier ?? 0) <= 1) line += ` “${mkr.title}”`;
    if (s.crossRepo && s.via !== 'http') line += ' ⇄';
    for (const g of s.gates) line += ` ${g.kind === 'guard' ? '🔒' : '⛨'} ${g.name}${g.planned ? ' (planned)' : ''}`;
    // the condition gating this hop: which branch arm the call site sits in.
    // Prefer the plain-language label over the raw predicate (no duplication).
    // the condition belongs to the call site; on a choice it is printed once, on the choice line
    if (s.conditions?.length && !ch) {
      const c = s.conditions[0]!;
      line += ` [when ${c.business ?? c.requires}${s.conditions.length > 1 ? ` +${s.conditions.length - 1}` : ''}]`;
    }
    line += txWord(s.order);
    if (s.deferred) line += runsWhen(s.nodeId);
    else if (s.cycle) line += ' (cycle)';
    else if (s.repeat) line += ' ↺ already walked';
    // both ends of the seam on an http hop: where the UX made the call, where the API starts
    lines.push(line + seamOf(s.order));
  }
  if (folded) lines.push('', `${folded} step(s) under a ↺ already-walked step are not printed again — pass full:true for the whole walk.`);
  // absent is not a side: an older graph carries no transaction flag, and a title that
  // claims one transaction must not be read as confirmed by our silence
  if (!tx.known) lines.push('', t('journey.drill.txFallback', 'professional'));
  // what the reader has not seen, and why — the detail behind the header's count.
  if (hidden.length) {
    lines.push('', '## cut points');
    const nameAt = (order: number): string => {
      const st = j.steps.find((s) => s.order === order);
      return st ? (index.byId.get(st.nodeId)?.name ?? st.nodeId) : 'the entry';
    };
    const why: Record<string, string> = {
      depth: 'past the depth budget',
      steps: 'the step budget ran out here',
    };
    for (const c of hidden.slice(0, 20)) {
      lines.push(`✂ ${nameAt(c.parentStep)} · ${why[c.reason] ?? c.reason} · ${index.byId.get(c.nodeId)?.name ?? c.nodeId} (depth ${c.depth})`);
    }
    if (hidden.length > 20) lines.push(`… ${hidden.length - 20} more`);
  }
  // forks along the pathway: every conditional inside the visited nodes, categorized
  const forkNodes = [...new Set(j.steps.map((s) => s.nodeId))]
    .map((id) => index.byId.get(id))
    .filter((n): n is NonNullable<typeof n> => !!n?.branches?.length);
  if (forkNodes.length) {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const n of forkNodes) for (const b of n.branches!) { counts[categorizeBranch(b)] = (counts[categorizeBranch(b)] ?? 0) + 1; total++; }
    const byCat = Object.entries(counts).map(([c, k]) => `${c} ${k}`).join(' · ');
    lines.push('', `⑂ ${total} fork(s) along this journey (${byCat})${forks ? '' : ' — pass forks:true to list them'}`);
    if (forks) {
      const forkLines: string[] = [];
      for (const n of forkNodes) {
        for (const b of n.branches!) {
          if (forkLines.length >= 40) break;
          // prefer the plain-language label over the raw condition/arm names (terser, one meaning)
          const arms = b.kind === 'switch' || b.kind === 'catch' ? ` arms: ${b.arms.map((a) => a.business ?? a.label).join(' | ')}` : '';
          forkLines.push(`⑂ [${categorizeBranch(b)}${b.exits ? '·exits' : ''}] ${n.loc?.path ?? '?'}:${b.line} ${b.kind} (${b.business ?? b.condition})${arms}`);
        }
      }
      lines.push(...forkLines);
      if (total > forkLines.length) lines.push(`… ${total - forkLines.length} more (capped)`);
    }
  }
  return text(lines.join('\n'));
});

server.registerTool('list_rules', {
  title: 'Gates & rules — where behaviour is enforced',
  description: 'Every checkpoint around a feature, split the way the journey splits them: GATES (auth/access guards and request validation a request must pass), RULES that are config/env schemas (validated at start-up — never a gate on a request), FEATURE FLAGS, and planned gates (security the API spec declares on a route not built yet). Each one once, with its plain-language summary, source location and every node it applies to. The header names the scope it counted over. Use before changing behaviour behind a route or form, or to answer "who can do this / what is checked". For one node\'s gates in force, describe_node; for gates in execution order, journey.',
  inputSchema: {
    query: z.string().describe('feature, tag, symbol, or node id'),
    depth: z.number().int().min(1).max(5).optional().describe('hops around the seeds to collect from, both directions — default 3'),
    ...SCOPE_INPUTS,
  },
}, async ({ query, depth, repo, group }) => {
  const seeds = resolveSeeds(query, { repo, group });
  if (!seeds.length) return text(`nothing matches "${query}"`);
  const hops = depth ?? 3;
  const sub = trace(index, seeds.map((s) => s.id), 'both', hops);
  const applications = rulesFor(index, sub);
  // one entry per checkpoint, with every node it applies to — the application count is a separate number
  const byRule = new Map<string, { rule: GraphNode; appliesTo: GraphNode[] }>();
  for (const a of applications) {
    const have = byRule.get(a.rule.id) ?? { rule: a.rule, appliesTo: [] };
    if (!have.appliesTo.some((x) => x.id === a.appliesTo.id)) have.appliesTo.push(a.appliesTo);
    byRule.set(a.rule.id, have);
  }
  const all = [...byRule.values()].sort((a, b) => a.rule.name.localeCompare(b.rule.name));
  const guards = all.filter((r) => r.rule.kind === 'guard');
  const validation = all.filter((r) => r.rule.kind === 'rule' && isGate(r.rule));
  const config = all.filter((r) => r.rule.kind === 'rule' && !isGate(r.rule));
  const flags = all.filter((r) => r.rule.kind === 'flag');
  // the journey's planned gates: security the spec declares on a route that is not built yet
  const specOnly: { route: GraphNode; sec: string }[] = [];
  for (const node of sub.nodes) {
    if (node.kind !== 'route' || !isDeclaredOnly(node)) continue;
    const inCode = new Set(checksOn(node.id).map((c) => c.name));
    for (const sec of node.contract?.security ?? []) if (!inCode.has(sec)) specOnly.push({ route: node, sec });
  }
  if (!all.length && !specOnly.length) {
    return text(`no gates or rules indexed around "${query}" — scope: the ${sub.nodes.length} node(s) within ${hops} hop(s) of ${seeds.map((s) => s.name).join(', ')}, both directions`);
  }
  const apps = (rs: typeof all) => rs.reduce((a, r) => a + r.appliesTo.length, 0);
  const lines = [
    `# gates & rules around ${seeds.map((s) => s.name).join(', ')}`,
    `scope: the ${sub.nodes.length} node(s) within ${hops} hop(s) of the seed(s), both directions${repo ? ` · repo ${repo}` : ''}${group ? ` · group ${group}` : ''}`,
    `${guards.length} guard(s) · ${validation.length} validation rule(s) — ${apps(guards) + apps(validation)} application(s) to node(s) in scope${config.length ? ` · ${config.length} config/env schema(s)` : ''}${flags.length ? ` · ${flags.length} flag(s)` : ''}${specOnly.length ? ` · ${specOnly.length} planned (spec-only route)` : ''}`,
  ];
  const print = (heading: string, rs: typeof all, note?: string) => {
    if (!rs.length) return;
    lines.push('', `## ${heading} (${rs.length})${note ? ` — ${note}` : ''}`);
    for (const { rule, appliesTo } of rs.slice(0, RULE_CAP)) {
      lines.push(`${gateGlyph(rule)} ${rule.name} — ${rule.loc ? `${rule.loc.repo}/${rule.loc.path}:${rule.loc.line}` : '(no source loc)'}${rule.tags.includes('declared') ? ' · declared in farsight.config.json' : ''} \`${rule.id}\``);
      const summary = businessSummary(rule);
      if (summary && summary !== rule.name) lines.push(`   ⓘ ${summary}`);
      lines.push(`   applies to ${appliesTo.length}: ${appliesTo.slice(0, 8).map((a) => `${a.name} (${a.kind}${a.loc ? ` ${a.loc.path}:${a.loc.line}` : ''})`).join(' · ')}${appliesTo.length > 8 ? ` … +${appliesTo.length - 8} more` : ''}`);
    }
    if (rs.length > RULE_CAP) lines.push(`… +${rs.length - RULE_CAP} more — narrow with repo:/group: or a smaller depth`);
  };
  print('gates — guards', guards, 'auth/access checks a request must pass');
  print('gates — validation rules', validation, 'input a request must satisfy');
  if (specOnly.length) {
    lines.push('', `## planned — the spec requires it on a route that is not built (${specOnly.length})`);
    for (const x of specOnly.slice(0, RULE_CAP)) lines.push(`🔒 ${x.sec} → ${x.route.name} — ${locOf(x.route)} \`${x.route.id}\``);
  }
  print('config & env schemas', config, 'validated at start-up; journeys do not count them as gates');
  print('feature flags', flags);
  return text(lines.join('\n'));
});

server.registerTool('impact_of', {
  title: 'Change impact — what uses this, by distance, and which tests to run',
  description: 'What uses a node, answered **per hop and never summed**: hop 1 is what uses it directly (one edge, with its verb, its call site and how it was resolved), hop 2 what reaches it through those, and so on to 5 hops. Reachability is not consequence — a path existing does not mean a change travels along it, so every line keeps the edge\'s own verb (reads · writes · calls · guards · renders) and nothing is called "broken" or "affected". Counts are a floor while anything was cut, capped, unstamped, resolved at run time, or the checkout no longer matches the graph — and the reason is printed. Paths that exist only because of container construction (start-up) or because a callback runs later (afterwards) are reported apart. Use before editing a symbol, or with changed:["path:from-to", …] after editing, to see the dependents and the tests that reach them; format:"impact-tests" returns the frozen farsight-impact-tests v1 JSON (select per runner, unselectable, fallback) a CI job can run. For what this node *uses*, in order, call `journey`; for the neighbourhood around it, `trace_flow`.',
  inputSchema: {
    node_id: z.string().optional().describe('node id (or exact symbol name) to assess — or pass changed instead'),
    changed: z.array(z.string()).optional().describe('changed ranges instead of a node: "path", "path:line" or "path:from-to" — every node whose definition starts inside is a seed (a floor: the graph records no end line)'),
    hops: z.number().int().min(1).max(8).optional().describe(`how far to walk, default 2; more than ${IMPACT_MAX_HOPS} is refused with a sentence`),
    direction: z.enum(['upstream', 'downstream']).optional().describe('upstream = what uses this (default) · downstream = what this uses, as a set'),
    tests: z.boolean().optional().describe('attach the tests that cover each hop — on by default'),
    flows: z.boolean().optional().describe('which journeys and actions each dependent appears in — off by default: it costs one journey walk per flow'),
    include_setup: z.boolean().optional().describe('walk edges that exist only because of container construction (default off — the boot is not a dependent)'),
    include_deferred: z.boolean().optional().describe('walk edges into work that runs later on its own (default off — reported apart)'),
    expand_shared: z.boolean().optional().describe('open plumbing and rendered primitives instead of stopping at them (default off — expanding `cx` reports the application)'),
    full: z.boolean().optional().describe('list every dependent at every hop instead of the first few'),
    format: z.enum(['text', 'json', 'impact-tests']).optional().describe('text (default) · json = the bare ImpactReport (an array for several seeds) · impact-tests = the frozen farsight-impact-tests v1 document'),
    repo: z.string().optional().describe('resolve node_id / changed only inside this source/repo'),
  },
}, async ({ node_id, changed, hops, direction, tests, flows, include_setup, include_deferred, expand_shared, full, format, repo }) => {
  type Seed = { node: GraphNode; from: 'node' | 'hunk'; hunk?: string };
  const seeds: Seed[] = [];
  const unmatched: string[] = [];
  if (changed?.length) {
    // one rule, in core, shared with `farsight impact --changed`
    const r = nodesInHunks(repo ? nodes.filter((n) => n.loc?.repo === repo) : nodes, changed);
    unmatched.push(...r.unmatched);
    for (const h of r.seeds) seeds.push({ node: h.node, from: 'hunk', hunk: h.hunk });
    if (!seeds.length) return text(`no node in the graph is defined in ${changed.join(', ')} — nothing to report (the graph records where a definition starts, not where it ends)`);
  } else {
    if (!node_id) return text('impact_of needs node_id or changed.');
    const found = resolveSeeds(node_id, repo ? { repo } : {});
    if (!found.length) return text(`unknown node: ${node_id}`);
    seeds.push({ node: found[0]!, from: 'node' });
  }
  const budget = hops ?? 2;
  const wantTests = tests !== false;
  const digest = digestCheck();
  const opts = {
    hops: budget,
    direction: (direction ?? 'upstream') as 'upstream' | 'downstream',
    tests: wantTests,
    ...(flows ? { flows: true } : {}),
    ...(include_setup ? { includeSetup: true } : {}),
    ...(include_deferred ? { includeDeferred: true } : {}),
    ...(expand_shared ? { expandShared: true } : {}),
  };
  const asOfFor = (repoName: string) => {
    const dm = digest(repoName);
    return {
      ...(store.meta.sync != null ? { sync: store.meta.sync } : {}),
      ...(store.meta.commit ? { commit: store.meta.commit } : {}),
      farsight: buildLine(),
      ...(dm === undefined ? {} : { digestMatches: dm }),
    };
  };
  const repoOfSeed = (n: GraphNode): string => n.loc?.repo ?? n.id.split('::')[0] ?? '';
  let reports: { seed: Seed; report: ImpactReport }[];
  try {
    reports = seeds.map((seed) => ({ seed, report: impactOf(index, seed.node.id, { ...opts, asOf: asOfFor(repoOfSeed(seed.node)) }) }));
  } catch (err) {
    // a refused budget is a sentence, not a stack trace (§8)
    return text((err as Error).message);
  }

  if (format === 'impact-tests') {
    const stale = seeds.some((s) => digest(repoOfSeed(s.node)) === false);
    return text(JSON.stringify(impactTestsV1(
      index,
      reports.map(({ seed, report }) => ({ report, from: seed.from, ...(seed.hunk ? { hunk: seed.hunk } : {}) })),
      testsIdentity(store.meta),
      stale ? { digestMatches: false } : {},
    ), null, 2));
  }
  if (format === 'json') return text(JSON.stringify(reports.length === 1 ? reports[0]!.report : reports.map((r) => r.report), null, 2));

  const out: string[] = [];
  for (const u of unmatched) out.push(`⚠ nothing in the graph is defined in ${u} — it is not in the answer`);
  for (const { seed, report } of reports) {
    if (out.length) out.push('');
    out.push(...impactText(report, seed.node, budget, opts, !!full, seed.hunk, digest(repoOfSeed(seed.node))));
  }
  return text(out.join('\n'));
});

/**
 * Does the graph still describe the checkout? The content digest the ingest
 * recorded against the tree on disk now — `undefined` (unknown, never false)
 * when no digest was recorded or the root is not on this machine. Memoized per
 * call, since several seeds usually share one repo.
 */
function digestCheck(): (repo: string) => boolean | undefined {
  const seen = new Map<string, boolean | undefined>();
  const excludes = workspaceExcludes();
  return (repo: string) => {
    if (seen.has(repo)) return seen.get(repo);
    let v: boolean | undefined;
    try {
      const recorded = store.repoMeta(repo)?.sourceDigest;
      const root = store.roots[repo];
      v = recorded && root && existsSync(root) ? repoContentDigest(root, excludes[root] ? { exclude: excludes[root] } : {}) === recorded : undefined;
    } catch { v = undefined; }
    seen.set(repo, v);
    return v;
  };
}

/** The reader's form of one impact report — the same words the CLI prints, per hop, never summed. */
function impactText(report: ImpactReport, seed: GraphNode, budget: number, opts: { tests: boolean; flows?: boolean } & Record<string, unknown>, full: boolean, hunk: string | undefined, digestMatches: boolean | undefined): string[] {
  const EVIDENCE = { declared: 'declared', static: 'reached', observed: 'observed' } as const;
  const kinds = (m: Record<string, number>): string =>
    Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${n} ${k}`).join(' · ');
  const site = (n: ImpactNode): string => { const l = n.via.loc ?? n.loc; return l ? `${l.path}:${l.line}` : '(no source loc)'; };

  // one clause per distance. There is no total line anywhere in this printer, because
  // the number that turned this question into a haystack was the sum of these.
  const clause = (h: { hop: number; found: number }): string => h.hop === 1
    ? `${h.found} thing(s) ${report.direction === 'upstream' ? 'use it directly' : 'it uses directly'}`
    : h.hop === 2 ? `${h.found} more reach it through those`
    : `${h.found} more at ${h.hop} hops`;
  const asOf = [report.asOf.sync != null ? `sync ${report.asOf.sync}` : null, report.asOf.commit ? report.asOf.commit.slice(0, 7) : null]
    .filter(Boolean).join(' · ');
  const lines = [
    report.hops.length
      ? `${seed.name}${hunk ? ` (changed in ${hunk})` : ''} — ${report.hops.map(clause).join(', ')}${asOf ? ` (${asOf})` : ''}`
      : `${seed.name}${hunk ? ` (changed in ${hunk})` : ''} — none indexed: nothing in this graph ${report.direction === 'upstream' ? 'uses it' : 'it uses'}${asOf ? ` (${asOf})` : ''}`,
    report.bound === 'floor'
      ? `≥ a floor: ${report.uncertainty?.note ?? 'something about this answer is incomplete'}.`
      : 'exact: nothing was cut and every path records how it was resolved.',
    digestMatches === true ? 'the checkout still matches this graph' : digestMatches === false ? '⚠ the checkout no longer matches this graph — call refresh_graph' : 'whether the checkout still matches this graph is unknown (no digest recorded, or the source is not on this machine)',
    'Each line is the edge\'s own verb — a path is not a claim that a change travels along it.',
  ];

  const PER_HOP = full ? Number.MAX_SAFE_INTEGER : 12;
  for (const h of report.hops) {
    const head = h.hop === 1 ? (report.direction === 'upstream' ? 'uses it directly' : 'it uses directly')
      : h.hop === 2 ? 'reaches it through those' : `reaches it through ${h.hop - 1} others`;
    lines.push('', `## hop ${h.hop} — ${head} (${h.found} · ${kinds(h.byKind)})`);
    for (const n of h.nodes.slice(0, PER_HOP)) {
      const parent = n.path.length > 2 ? index.byId.get(n.path[n.path.length - 2]!)?.name : undefined;
      const how = n.via.resolution ? `${n.via.resolution.technique} ${n.via.resolution.confidence}` : 'not recorded';
      const extra = [
        parent ? `via ${parent}` : null,
        `how we know: ${how}`,
        n.hop > 1 && n.strength.unstamped ? `${n.strength.unstamped} edge(s) on this path record nothing` : null,
        n.oneOf ? (parent === n.oneOf.chosen
          ? `one of several — the code chooses this one at run time, ${n.oneOf.alternatives.length} set aside`
          : `one of several — the code chooses ${n.oneOf.chosen} at run time, ${n.oneOf.alternatives.length} set aside`) : null,
        n.shared ? 'shared — listed, not opened' : null,
        n.declaredOnly ? 'not built' : null,
      ].filter(Boolean).join(' · ');
      lines.push(`  ${n.via.kind.padEnd(9)} ${n.name}   ${site(n)}   ${extra}`);
    }
    if (h.nodes.length > PER_HOP) lines.push(`  … +${h.nodes.length - PER_HOP} more listed at this hop (full:true prints them)`);
    if (h.found > h.nodes.length) lines.push(`  … ${h.found} found here, ${h.nodes.length} listed — the ${h.found - h.nodes.length} over the cap are counted in this hop's kinds and stand under "not walked"`);
    if (opts.tests) {
      // the union over hops 1..h, each test once (core `impactTestsReaching`): the CLI
      // and the viewer print the same set under the same words, and it never goes down
      const reach = impactTestsReaching(report, h.hop);
      const label = h.hop === 1 ? 'hop 1' : `hops 1–${h.hop}, each test once`;
      if (!reach.total) { lines.push(`  tests reaching ${label}: none indexed`); continue; }
      const byLevel = new Map<string, CoverageTestRef[]>();
      for (const t of reach.tests) byLevel.set(t.level, [...(byLevel.get(t.level) ?? []), t]);
      const parts = [...byLevel.entries()].sort().map(([lvl, ts]) => {
        const ev = ts.reduce<Record<string, number>>((a, t) => { a[EVIDENCE[t.evidence]] = (a[EVIDENCE[t.evidence]] ?? 0) + 1; return a; }, {});
        return `${ts.length} ${lvl} (${kinds(ev)})`;
      });
      if (!byLevel.has('e2e')) parts.push('no e2e');
      lines.push(`  tests reaching ${label}: ${parts.join(' · ')}`);
    }
  }

  // ── what it did not walk. Never added up: two stops routinely sit in front of the
  // same ancestors, so each `behind` answers only "how much more is behind this one".
  const notWalked: string[] = [];
  const hopCuts = report.cutPoints.filter((c) => c.reason === 'hops');
  if (hopCuts.length) {
    // the ring one hop past the budget, counted once as a set — a second walk, not a sum
    let ring: number | null = null;
    if (budget < IMPACT_MAX_HOPS) {
      try { ring = impactOf(index, seed.id, { ...opts, hops: budget + 1, tests: false, flows: false }).hops[budget]?.found ?? 0; } catch { ring = null; }
    }
    notWalked.push(ring != null
      ? `  the ${budget}-hop edge     ${ring} more node(s) one hop further out, behind ${hopCuts.length} stop(s)`
      : `  the ${budget}-hop edge     ${hopCuts.length} stop(s) — ${IMPACT_MAX_HOPS} hops is as far as this answer goes`);
  }
  for (const c of report.cutPoints.filter((x) => x.reason === 'shared')) {
    notWalked.push(`  shared            ${c.name} — used by ${c.direct}, not opened (${c.behind} node(s) behind it)`);
  }
  for (const c of report.cutPoints.filter((x) => x.reason === 'cap')) {
    notWalked.push(`  over the cap      ${c.behind} dependent(s) found at hop ${c.hop} and not listed`);
  }
  for (const n of report.excluded.setup) notWalked.push(`  start-up, once    ${n.name} — reached only through container construction`);
  for (const n of report.excluded.deferred) notWalked.push(`  afterwards        ${n.name} — registered here, run later by something else`);
  if (notWalked.length) lines.push('', '## not walked', ...notWalked.slice(0, full ? notWalked.length : 12));
  if (!full && notWalked.length > 12) lines.push(`  … +${notWalked.length - 12} more stops (full:true prints them)`);

  if (opts.flows) {
    const all = report.hops.flatMap((h) => h.nodes).flatMap((n) => n.flows ?? []);
    const byFlow = new Map(all.map((f) => [f.flowId, f]));
    const actions = all.reduce((a, f) => a + f.actions.length, 0);
    const total = [...index.byId.values()].filter((n) => n.kind === 'flow').length;
    lines.push('', byFlow.size
      ? `Journeys: ${byFlow.size} of ${total} reach it, in ${actions} action reference(s) — ${[...byFlow.values()].map((f) => f.name).join(' · ')}`
      : `Journeys: not involved — no journey in this graph reaches it`);
  }
  return lines;
}

/** Exclude globs per absolute source root, from the workspace settings next to the graph — what refresh_graph and the digest check both honour. */
function workspaceExcludes(): Record<string, string[]> {
  const excludeByPath: Record<string, string[]> = {};
  try {
    const settings = JSON.parse(readFileSync(join(dirname(graphPath), '.farsight', 'settings.json'), 'utf8'));
    for (const src of settings.sources ?? []) {
      if (typeof src.path === 'string' && Array.isArray(src.exclude)) {
        excludeByPath[resolve(dirname(graphPath), src.path)] = src.exclude;
      }
    }
  } catch { /* no workspace settings — no excludes */ }
  return excludeByPath;
}

server.registerTool('refresh_graph', {
  title: 'Re-ingest and reload the graph',
  description: 'Re-runs ingest for the graph\'s recorded source roots and reloads in place (workspace source excludes honoured). Use when the code has changed since graph_overview\'s generated timestamp, or when impact_of says the checkout no longer matches the graph — the snapshot does not update itself. It overwrites the graph file this server was started with.',
  inputSchema: {},
}, async () => {
  const roots = Object.entries(store.roots).filter(([repo]) => repo);
  if (!roots.length) {
    return text('graph records no source roots to re-ingest — run `farsight ingest <dir>` and restart the MCP server.');
  }
  // exclude globs live in workspace settings next to the graph, when present
  const excludeByPath = workspaceExcludes();

  const prev = { nodes: nodes.length, edges: edges.length };
  const fresh = new GraphStore();
  const skipped: string[] = [];
  for (const [repo, root] of roots) {
    if (!existsSync(root)) { skipped.push(`${repo} (${root} missing)`); continue; }
    // ingestRepo applies the repo's farsight.config.json itself
    const fragment = await ingestRepo(root, { repoName: repo, exclude: excludeByPath[root] });
    fresh.roots[repo] = root;
    fresh.addFragment(fragment);
  }
  stitchHttp(fresh);
  fresh.meta.workspace = store.meta.workspace ?? basename(dirname(graphPath));
  fresh.save(graphPath);
  store = fresh;
  ({ nodes, edges } = store.toJSON());
  index = buildIndex(nodes, edges);
  setFreshnessMeta(index, store.meta);
  const lines = [
    `re-ingested ${roots.length - skipped.length} source root(s): ${nodes.length} nodes, ${edges.length} edges (was ${prev.nodes}/${prev.edges})`,
    `generated: ${store.meta.generatedAt} · source-hash ${store.meta.sourceHash ?? 'n/a'}`,
  ];
  if (skipped.length) lines.push(`skipped: ${skipped.join(', ')}`);
  // the graph is fresh, but the parser that wrote it is whatever this process loaded at start
  const inst = installState();
  if (inst.newerInstalled) lines.push(`⚠ a newer Farsight build is installed than this MCP process runs (started ${inst.startedAt}, install written ${inst.installedAt}) — reconnect the MCP server and call refresh_graph again so the graph is written by the new parsers`);
  return text(lines.join('\n'));
});

// ── Change history: what moved between two syncs (farsight-diff v1) ─────────

/** The snapshot store next to the graph — where `farsight ingest` and the server's sync write — or undefined when none exists. Never created here. */
function historyDbPath(): string | undefined {
  const p = join(dirname(graphPath), '.farsight', 'farsight.db');
  return existsSync(p) ? p : undefined;
}

/** One line for graph_overview: how much history exists, and which tool reads it. */
function historyLines(): string[] {
  const p = historyDbPath();
  if (!p) return [];
  let db: SnapshotDb | undefined;
  try {
    db = new SnapshotDb(p);
    const rows = db.list(10_000);
    if (!rows.length) return [];
    const latest = rows[0]!;
    return [`history: ${rows.length} snapshot(s), sync ${rows[rows.length - 1]!.sync}–${latest.sync} (latest ${latest.at}) — graph_changes says what changed between two`];
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

const SEVERITY_ORDER = ['breaking', 'notable', 'info'] as const;

server.registerTool('graph_changes', {
  title: 'What changed between two syncs',
  description: 'The semantic diff between two snapshots of the graph — the frozen farsight-diff v1 document the Changes tab, `farsight diff` and `farsight gate` use: routes, gates (guards), rules, records and their columns, messages, journeys, tests and coverage added or removed, renames, and edge-confidence changes, each with its severity (breaking · notable · info) and one sentence. Code-body edits that change none of those are deliberately not reported. Default compares the latest sync with the one before it. Use to review what a change did to the system\'s shape, to check a refactor removed no gate or route, or to catch coverage lost. list:true lists the recorded syncs. format:"json" is the frozen document; "md" and "sarif" are its renderings.',
  inputSchema: {
    from: z.string().optional().describe('base: "sync:N", "N" or "latest" — default the sync before `to`'),
    to: z.string().optional().describe('head: "sync:N", "N" or "latest" (default)'),
    kind: z.string().optional().describe(`text only — hold the list to one change kind: ${CHANGE_KINDS.join('|')}`),
    limit: z.number().int().min(1).optional().describe('cap the change list (counts stay complete and the document says it was truncated)'),
    format: z.enum(['text', 'json', 'md', 'sarif']).optional().describe('text (default) · json = farsight-diff v1 · md · sarif'),
    list: z.boolean().optional().describe('list the recorded syncs (newest first) instead of diffing'),
  },
}, async ({ from, to, kind, limit, format, list }) => {
  const p = historyDbPath();
  if (!p) {
    return text(`no snapshot history next to this graph (${join(dirname(graphPath), '.farsight', 'farsight.db')} does not exist) — every \`farsight ingest\` and server sync writes one snapshot; run two, then ask again.`);
  }
  let db: SnapshotDb;
  try { db = new SnapshotDb(p); } catch (err) { return text((err as Error).message); }
  try {
    if (list) {
      const rows = db.list(50);
      if (!rows.length) return text('no snapshots recorded yet.');
      return text([
        `${rows.length} most recent sync(s) — newest first`,
        ...rows.map((r) => `sync:${r.sync}${r.pinned ? ' (pinned)' : ''} · ${r.at} · ${r.commit ? r.commit.slice(0, 7) : 'no commit recorded'} · ${r.nodes} nodes · ${r.edges} edges · digest ${r.digest}`),
      ].join('\n'));
    }
    const toRef = parseSyncRef(to ?? 'latest');
    if (toRef === null) return text(`to expects sync:<N>, N or latest (got "${to}")`);
    let head, base;
    try { head = db.read(toRef); } catch (err) { return text((err as Error).message); }
    const fromRef = from ? parseSyncRef(from) : db.previous(head.ref.sync) ?? null;
    if (fromRef === null) return text(from ? `from expects sync:<N>, N or latest (got "${from}")` : `no snapshot before sync:${head.ref.sync} to compare against — pass from:"sync:<N>"`);
    try { base = db.read(fromRef); } catch (err) { return text((err as Error).message); }
    const diff: GraphDiff = diffGraphs(base.store, head.store, {
      changes: db.changedBetween(base.ref.sync, head.ref.sync),
      ...(limit ? { limit } : {}),
    });
    if (format === 'json') return text(JSON.stringify(diff, null, 2));
    if (format === 'sarif') return text(JSON.stringify(toSarif(diff), null, 2));
    if (format === 'md') return text(toMarkdown(diff));
    const nonzero = Object.entries(diff.counts).filter(([, n]) => n > 0);
    const bySev = diff.changes.reduce<Record<string, number>>((a, c) => { a[c.severity] = (a[c.severity] ?? 0) + 1; return a; }, {});
    const lines = [
      `# changes ${diff.base} → ${diff.head}`,
      nonzero.length
        ? `counts (every change of a kind farsight-diff v1 carries, between these two syncs): ${nonzero.map(([k, n]) => `${k} ${n}`).join(' · ')}`
        : 'no change of a kind farsight-diff v1 carries — routes, gates, rules, records, messages, journeys, tests, coverage. Code-body edits are not in this contract, so this is not a claim nothing was edited.',
      ...(diff.changes.length ? [`listed: ${SEVERITY_ORDER.filter((sv) => bySev[sv]).map((sv) => `${bySev[sv]} ${sv}`).join(' · ')}${diff.truncated ? ' — the list is truncated; the counts above are complete' : ''}`] : []),
    ];
    const shown = kind ? diff.changes.filter((c) => c.kind === kind) : diff.changes;
    const CAP = 60;
    let printed = 0;
    for (const sev of SEVERITY_ORDER) {
      const group = shown.filter((c) => c.severity === sev);
      if (!group.length) continue;
      lines.push('', `## ${sev} (${group.length})`);
      for (const c of group) {
        if (printed >= CAP) break;
        printed++;
        lines.push(`- ${c.id} [${c.kind}] ${changeSentence(c)}${c.loc ? ` — ${c.loc.path}:${c.loc.line}` : ''}${c.journey && c.journey.id !== c.subject.id ? ` · journey ${c.journey.name}` : ''} \`${c.subject.id}\``);
      }
    }
    if (shown.length > printed) lines.push('', `… +${shown.length - printed} more listed change(s) not printed — kind:<kind> narrows, format:"json" returns the whole document`);
    return text(lines.join('\n'));
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
});

// ── APIs: spec ↔ code (docs/proposals/openapi-surface.md) ────────────────

server.registerTool('api_surface', {
  title: 'API surfaces — operations, consumers, drift',
  description: 'Every HTTP API in the graph: spec-backed surfaces (one per OpenAPI/Swagger document) and implied ones (repos that serve routes with no spec on file). Per operation: status (both | spec-only = declared, not implemented | code-only = implemented, undocumented), the spec summary, gates, consumer count, and drift. Pass api to list one surface\'s operations with their consumers and call sites. Use before changing or adding an endpoint: who calls it, what the spec promises, and where the two already disagree.',
  inputSchema: {
    api: z.string().optional().describe('api surface id (from the list) — e.g. "invoice-app::api::openapi.yaml" or "<repo>::api::implemented"'),
    repo: z.string().optional().describe('limit to one source/repo name'),
  },
}, async ({ api, repo }) => {
  const apis = apiSurface(index, repo ? new Set([repo]) : null);
  if (!apis.length) return text('no HTTP routes in the graph — nothing to list.');
  if (!api) {
    const lines = ['API surfaces (spec = backed by a document · implied = routes exist, no spec on file)', ''];
    for (const a of apis) {
      const c = a.counts;
      lines.push(`${a.kind === 'spec' ? '▣' : '▢'} ${a.name}${a.version ? ` v${a.version}` : ''} — repo ${a.repo} — \`${a.id}\``);
      lines.push(`   ${a.kind === 'spec' ? `spec: ${a.specPath}` : 'implied from code — no spec on file (api_spec generates one)'}`);
      lines.push(`   operations ${c.operations} · declared ${c.declared} · implemented ${c.implemented} · not implemented ${c.notImplemented}${a.specSource ? ' (spec-only source — not a gap)' : ''} · undocumented ${c.undocumented} · consumers ${c.consumers} · gated ${c.gated} · drift ${c.drift}`);
    }
    return text(lines.join('\n'));
  }
  const a = apis.find((x) => x.id === api);
  if (!a) return text(`no API surface with id ${api}. Known: ${apis.map((x) => x.id).join(', ')}`);
  const lines = [`${a.name}${a.version ? ` v${a.version}` : ''} — ${a.kind === 'spec' ? a.specPath : 'implied from code'} — repo ${a.repo}`, ''];
  for (const op of a.operations.slice(0, 80)) {
    const flags = [op.status !== 'both' ? op.status : '', op.deprecated ? 'deprecated' : ''].filter(Boolean).join(' · ');
    lines.push(`${op.method} ${op.path}${flags ? ` [${flags}]` : ''}${op.summary ? ` — ${op.summary}` : ''}${op.loc ? ` — ${op.loc.path}:${op.loc.line}` : ' — (no source: declared only)'}${op.specLine != null ? ` · spec:${op.specLine}` : ''} \`${op.routeId}\``);
    if (op.gates.length) lines.push(`   🔒 ${op.gates.join(', ')}`);
    const consumers = consumersOf(index, op.routeId);
    for (const c of consumers.slice(0, 6)) {
      lines.push(`   ← ${c.caller.name}${c.caller.loc ? ` ${c.caller.loc.path}:${c.line ?? c.caller.loc.line}` : ''}${c.crossRepo ? ` (${c.caller.loc?.repo ?? 'other repo'}${c.confidence ? `, ${c.confidence}` : ''})` : ''}${c.screens.length ? ` ⇠ ${c.screens.map((s) => s.name).join(', ')}` : ''} \`${c.callerId}\``);
    }
    if (consumers.length > 6) lines.push(`   … ${consumers.length - 6} more consumer(s)`);
    for (const d of op.drift) lines.push(`   ⚠ ${d.kind}: ${d.message}`);
  }
  if (a.operations.length > 80) lines.push(`… ${a.operations.length - 80} more operation(s) (capped)`);
  return text(lines.join('\n'));
});

server.registerTool('api_drift', {
  title: 'API drift — a spec against the code',
  description: 'Where an OpenAPI/Swagger document and the implemented routes disagree: declared-but-not-implemented, implemented-but-undocumented, and matched operations whose security / deprecation / request body differ. Without spec it reports the drift recorded at ingest for the specs found in the repos; with spec (a path or URL) it reconciles a proposed document on the fly — nothing is stored. Use to check a spec edit against the code before committing it, or to list what the code still owes the spec.',
  inputSchema: {
    spec: z.string().optional().describe('path or URL of a proposed spec; omit to report the ingest-time drift'),
    repo: z.string().optional().describe('source/repo name to reconcile against (recommended with spec)'),
  },
}, async ({ spec, repo }) => {
  if (spec) {
    try {
      const parsed = await readSpecSource(spec);
      const r = reconcile(parsed.doc, index, { repo: repo ?? 'proposed', path: spec, lineOf: parsed.lineOf }, repo ? { repo } : {});
      return text(driftMarkdown(r));
    } catch (err) {
      return text(`could not read ${spec}: ${(err as Error).message}`);
    }
  }
  const apis = apiSurface(index, repo ? new Set([repo]) : null).filter((a) => a.kind === 'spec');
  if (!apis.length) return text('no spec-backed API in the graph — pass spec:<path|url> to check a document, or add openapi.yaml to the repo and refresh_graph.');
  const lines: string[] = [];
  for (const a of apis) {
    lines.push(`# ${a.name} (${a.specPath}) — drift ${a.counts.drift}: not implemented ${a.counts.notImplemented} · undocumented ${a.counts.undocumented}`);
    for (const op of a.operations) for (const d of op.drift) lines.push(`- ${op.method} ${op.path}${op.loc ? ` (${op.loc.path}:${op.loc.line})` : ''}: ${d.kind} — ${d.message}`);
    if (!a.counts.drift) lines.push('- no drift — the spec and the code agree.');
    lines.push('');
  }
  return text(lines.join('\n'));
});

server.registerTool('api_spec', {
  title: 'Generate an OpenAPI document from the code',
  description: 'An OpenAPI 3.1 document for one repo, built from its implemented routes: parameters from the path, request bodies from validation rules, security from guards, summaries from doc comments / @business / the existing spec. Everything the parser could not see is marked x-farsight-inferred; every operation carries x-farsight-source (file:line). JSON text. Use to bootstrap or refresh a spec for an API that has none, then check it with api_drift.',
  inputSchema: { repo: z.string().describe('source/repo name (see graph_overview or api_surface)') },
}, async ({ repo }) => {
  const doc = graphToSpec(index, { repo, meta: store.meta });
  if (!Object.keys(doc.paths ?? {}).length) return text(`no implemented routes for repo "${repo}"`);
  const json = JSON.stringify(doc, null, 2);
  return text(json.length > 60_000 ? json.slice(0, 60_000) + '\n… (truncated at 60k chars — use `farsight api spec --repo ' + repo + ' --out openapi.yaml` for the full file)' : json);
});

// ── Design: screens ↔ code (docs/proposals/design-source.md) ──────────────

server.registerTool('design_surface', {
  title: 'Design sources — screens, designed vs built, drift',
  description: 'Every design source in the graph (one per screens manifest / Figma file): its FLOWS (named features — screens in order, N of M built, docs, operations; each runs as a journey from its node id or name) and per screen its status (designed + built | designed, not built | built, not designed), the route it lives at, the Figma deep link, whether an image is on file, the operations the design says it uses, and drift against the code. A designed-but-unbuilt screen still runs as a journey (its operations become planned calls). Pass design to list one source\'s flows and screens. design_guide explains how to author the manifest. Use to find which features exist and how far each is built, and the flow ids journey and test_coverage take.',
  inputSchema: {
    design: z.string().optional().describe('design source id (from the list) — e.g. "invoice-app::design::docs/design/screens.json"'),
    repo: z.string().optional().describe('limit to one source/repo name'),
  },
}, async ({ design, repo }) => {
  const designs = designSurface(index, repo ? new Set([repo]) : null);
  if (!designs.length) return text('no design source in the graph — add docs/design/screens.json to a repo (see docs/proposals/design-source.md) and call refresh_graph.');
  if (!design) {
    const lines = ['Design sources (a screens manifest, optionally a Figma file)', ''];
    for (const d of designs) {
      const c = d.counts;
      lines.push(`▣ ${d.name} — repo ${d.repo} — \`${d.id}\``);
      lines.push(`   manifest: ${d.manifestPath}${d.figmaFile ? ` · figma: ${d.figmaFile}` : ''}${d.signature ? ` · ${d.signature}` : ''}`);
      lines.push(`   screens ${c.screens} · designed ${c.designed} · built ${c.built} · not built ${c.designOnly} · undesigned pages ${c.codeOnly} · flows ${c.flows} · drift ${c.drift}`);
      for (const f of d.flows) lines.push(`   ↳ flow ${f.name} [${flowStatusWord(f.built, f.total).text}] \`${f.nodeId}\``);
    }
    return text(lines.join('\n'));
  }
  const d = designs.find((x) => x.id === design);
  if (!d) return text(`no design source with id ${design}. Known: ${designs.map((x) => x.id).join(', ')}`);
  const lines = [`${d.name} — ${d.manifestPath} — repo ${d.repo}`, ''];
  if (d.flows.length) {
    lines.push('## flows (features — journey from the node id or the name)');
    for (const f of d.flows) {
      lines.push(`${f.id} ${f.name} [${flowStatusWord(f.built, f.total).text}] — ${f.screens.join(' → ')} \`${f.nodeId}\``);
      if (f.description) lines.push(`   ${f.description}`);
      // paths, not titles: this is the catalogue an agent opens files from — `describe_node <flow>` prints each doc's title beside its path
      if (f.docs.length) lines.push(`   docs: ${f.docs.join(', ')}`);
      if (f.operations.length) lines.push(`   spans: ${f.operations.join(', ')}`);
      for (const x of f.drift) lines.push(`   ⚠ ${x.kind}: ${x.message}`);
    }
    lines.push('', '## screens');
  }
  for (const sc of d.screens.slice(0, 80)) {
    const status = sc.status === 'both' ? 'designed + built' : sc.status === 'design-only' ? 'designed, not built' : 'built, not designed';
    lines.push(`${sc.designId ?? '-'} ${sc.name} [${status}] — ${sc.route ?? sc.kind}${sc.loc ? ` — ${sc.loc.path}:${sc.loc.line}` : ''}${sc.phase ? ` · phase ${sc.phase}` : ''} \`${sc.nodeId}\``);
    if (sc.url) lines.push(`   design: ${sc.url}${sc.hasImage ? ' (image on file)' : ''}${sc.lastModified ? ` · modified ${sc.lastModified} (${sc.freshness ?? 'manifest'})` : ''}`);
    if (sc.operations.length) lines.push(`   uses: ${sc.operations.join(', ')}`);
    for (const x of sc.drift) lines.push(`   ⚠ ${x.kind}: ${x.message}`);
  }
  if (d.screens.length > 80) lines.push(`… ${d.screens.length - 80} more screen(s) (capped)`);
  return text(lines.join('\n'));
});

server.registerTool('design_guide', {
  title: 'How to author a design-backed journey',
  description: 'The recipe for making a feature walkable as one journey — screens (Figma frames or images), code, API calls, gates and documents on one timeline: the docs/design/screens.json manifest format (screens + flows), what the graph derives from it before any code exists, how to write the code so it joins the design, and the verify-as-you-go loop with these tools. Use (read it) before creating or editing a screens manifest.',
  inputSchema: {},
}, async () => text(designGuide()));

server.registerTool('design_drift', {
  title: 'Design drift — a screens manifest against the code',
  description: 'Where a design (screens manifest) and the built pages disagree: designed-but-not-built, built-but-undesigned, and screens whose listed operations the code never reaches or do not exist in any API contract. Without manifest it reports the drift recorded at ingest; with manifest (a path or URL) it reconciles a proposed manifest on the fly — nothing is stored. Use after editing screens.json or building a screen, to see what still disagrees.',
  inputSchema: {
    manifest: z.string().optional().describe('path or URL of a proposed screens manifest; omit to report the ingest-time drift'),
    repo: z.string().optional().describe('source/repo name to reconcile against (recommended with manifest)'),
  },
}, async ({ manifest, repo }) => {
  if (manifest) {
    try {
      const parsed = await readManifestSource(manifest);
      const r = reconcileDesign(parsed.manifest, index, { repo: repo ?? 'proposed', path: manifest, ...(parsed.lastModified ? { lastModified: parsed.lastModified, freshness: parsed.freshness } : {}) }, repo ? { repo } : {});
      return text(designDriftMarkdown(r));
    } catch (err) {
      return text(`could not read ${manifest}: ${(err as Error).message}`);
    }
  }
  const designs = designSurface(index, repo ? new Set([repo]) : null);
  if (!designs.length) return text('no design source in the graph — pass manifest:<path|url> to check one, or add docs/design/screens.json to the repo and refresh_graph.');
  const lines: string[] = [];
  for (const d of designs) {
    lines.push(`# ${d.name} (${d.manifestPath}) — drift ${d.counts.drift}: not built ${d.counts.designOnly} · undesigned ${d.counts.codeOnly}`);
    for (const sc of d.screens) for (const x of sc.drift) lines.push(`- ${sc.designId ?? sc.name} (${sc.route ?? sc.kind}): ${x.kind} — ${x.message}`);
    if (!d.counts.drift) lines.push('- no drift — the design and the code agree.');
    lines.push('');
  }
  return text(lines.join('\n'));
});

/**
 * One line per test file: its verdict counts (flaky its own bucket, never
 * passed) and its last run with freshness — failing and stale files first,
 * because those are what an agent must know about before trusting a green.
 */
function suiteLines(suites: ReturnType<typeof testsSurface>['suites']): string[] {
  if (!suites.length) return [];
  const weight = (s: typeof suites[number]) => (s.counts.failed ? 0 : s.counts.flaky ? 1 : s.lastRun?.stale ? 2 : !s.lastRun ? 3 : 4);
  const sorted = [...suites].sort((a, b) => weight(a) - weight(b) || a.file.localeCompare(b.file));
  const out = [`## files (${suites.length}) — failing, flaky and stale first`];
  for (const s of sorted.slice(0, 25)) {
    const k = s.counts;
    const verdict = [`${k.passed} passed`, k.failed ? `${k.failed} failed` : '', k.flaky ? `${k.flaky} flaky` : '', k.skipped ? `${k.skipped} skipped` : '', k.unknown ? `${k.unknown} not run` : ''].filter(Boolean).join(', ');
    const run = s.lastRun
      ? `last run ${s.lastRun.at.slice(0, 10)} — ${s.lastRun.freshness === 'unchanged' ? 'source unchanged since' : s.lastRun.freshness === 'changed' ? changedWords(s.lastRun.changedBy) : 'freshness unknown'}`
      : 'no run observed';
    out.push(`- ${s.repo}/${s.file} · ${s.level}${s.project ? ` · ${s.project}` : ''} — ${k.cases} case(s): ${verdict} · ${run}`);
  }
  if (sorted.length > 25) out.push(`… +${sorted.length - 25} more file(s) — raw:true returns them all`);
  out.push('');
  return out;
}

server.registerTool('test_coverage', {
  title: 'Tests & coverage — what verifies this',
  description: "What the test suite says about the code — unit, integration and e2e alike: the catalogue (suites per file with pass/fail/flaky and last run, freshness against the source digest, blind spots), the journeys × tests matrix, and what covers one flow, one node or one test. Evidence is always labelled — declared (a test author's @covers claim), inferred (what the test imports or opens), observed (a coverage/results report saw it run) — and the end-to-end word per journey says what lifted it (observed · reached · declared · none). A claim is never reported as an observation, and a percentage never appears without the scope it was computed over. Use node: before changing a symbol (what verifies it), flow: for a feature, gaps:true for what nothing reaches, matrix:\"json\"|\"csv\" for the frozen farsight-tests-matrix v1 document a CI job or spreadsheet reads. For the tests to run after a change, impact_of format:\"impact-tests\".",
  inputSchema: {
    flow: z.string().optional().describe('a flow id, design id or name — its row of the journeys × tests matrix'),
    node: z.string().optional().describe('a node id — what verifies just that node'),
    test: z.string().optional().describe('a test node id — its suite, its covers edges by evidence class, and its last run'),
    level: z.enum(['unit', 'integration', 'e2e']).optional().describe('hold the catalogue to one level'),
    gaps: z.boolean().optional().describe('list what no test reaches, by node id'),
    raw: z.boolean().optional().describe('return the raw JSON surface instead of the text summary'),
    matrix: z.enum(['json', 'csv']).optional().describe('the frozen farsight-tests-matrix v1 document (json) or its rows (csv) — journeys × tests with identity, e2e word, evidence counts and freshness'),
    ...SCOPE_INPUTS,
  },
}, async ({ flow, node, test: testId, level, gaps, raw, matrix, repo, group }) => {
  if (!testsIndexed()) {
    return text([
      'No tests are indexed in this graph.',
      'Either the sources have none, or their spec files were excluded from ingest (check `exclude` on the source, and the `tests` block of the repo’s farsight.config.json).',
      'Fix: drop the spec-file excludes, then call refresh_graph.',
    ].join('\n'));
  }
  const scope = repo ? new Set([repo]) : null;

  // ── the evidence words. A claim nobody ran is never called verified (AGENTS.md); the run is its own fact. ──
  // a coverage report is observed evidence attributed to the run, never *verified* (docs/COUNTS.md)
  // a declared e2e case its results report says passed is observed for what it declares — worded as that
  // one case's word is core's `caseWord` — the same rule as a scope's, the case alone as the scope
  const caseWordText = (r: CoverageTestRef): string => t(caseWord(r).key, 'professional');
  // one evidence word, from the fold: the same key the HUD's chip prints, so an
  // agent and a reader are never told two things about one flow at one sync. It
  // reads `evidenceWord` where the fold carries it — which is where the run-level
  // attribution lives (*seen by a coverage run*, not *verified by a run*) — and
  // stale keeps its ⚠ clause because the professional register's word does not
  // carry one.
  const chipWord = (c: Pick<CoverageFacts, 'chip'> & { observedBy?: CoverageFacts['observedBy']; evidenceWord?: CoverageFacts['evidenceWord']; observation?: CoverageFacts['observation'] }): string => {
    const w = c.evidenceWord ?? evidenceWord(c.chip, c.observedBy);
    if (w.cls === 'none') return 'nothing reaches it';
    return t(w.key, 'professional') + (w.cls === 'stale'
      ? (c.observation?.changedBy === 'working-tree' ? ' ⚠ the working tree differs from HEAD since the run (no new commit)' : ' ⚠ the code changed since')
      : '');
  };
  /**
   * The evidence word for one flow. A flow whose design declares screens and has
   * built none of them cannot be proven by a test that never opened it: the
   * covering tests reached code it shares with others, so the word is *not
   * built* and the class is reported as belonging to that shared code (swarm
   * 2026-09-23, blocker 2). A chip a flow has earned is printed unchanged.
   */
  const flowEvidenceWord = (c: CoverageFacts): string =>
    c.sharedEvidence
      ? `not built — no screen of its ${c.sharedEvidence.screens} is built, so the tests reach code it shares with other flows (${chipWord(c)} of that shared code)`
      : chipWord(c);
  const FRESH: Record<'unchanged' | 'changed' | 'unknown', string> = {
    unchanged: 'the source is unchanged since',
    changed: '⚠ the code changed after this run',
    unknown: 'no source digest was recorded, so freshness is unknown',
  };
  /** FRESH, with a `changed` on the run's own commit said as the working tree (never a new commit) */
  const fresh = (f: 'unchanged' | 'changed' | 'unknown', changedBy?: 'commit' | 'working-tree'): string =>
    f === 'changed' ? changedWords(changedBy) : FRESH[f];
  /** the end-to-end word and what lifted it — a header-only `@covers` reads *declared*, never a tick (README, the body rule). */
  const e2ePhrase = (c: CoverageFacts, long = false): string => {
    const v = c.e2eVia;
    const word = c.e2e === 'none' ? 'no e2e' : `e2e ${c.e2e}`;
    if (!v) return word;
    const shared = v.sharedWith.length
      ? ` (shared with ${v.sharedWith.slice(0, 2).map((f) => f.name).join(', ')}${v.sharedWith.length > 2 ? ` +${v.sharedWith.length - 2}` : ''})`
      : '';
    return `${word}${v.name ? ` via ${v.name}` : ''}${long ? ` — ${v.testName}${v.line != null ? `:${v.line}` : ''}` : ''}${shared}`;
  };
  /** every run behind one case, one per project — `desktop-1440 passed · mobile-390 flaky (1 retry)`. */
  const runsOf = (t: CoverageTestRef): string => {
    const runs = index.byId.get(t.id)?.test?.runs ?? [];
    const rows = runs.length
      ? runs.map((r) => ({ project: r.project, status: r.status, retries: r.retries }))
      : t.at ? [{ project: t.project, status: t.status ?? 'unknown', retries: t.retries }] : [];
    return rows.map((r) => `${r.project ?? 'default'} ${r.status ?? 'unknown'}${r.retries ? ` (${r.retries} retr${r.retries === 1 ? 'y' : 'ies'})` : ''}`).join(' · ');
  };
  /** one covering test: what it is, how we know, and — apart from that — what the run said. */
  const testLine = (t: CoverageTestRef): string => {
    const level = t.runLevel ? `${t.level} run report` : t.level;
    const inactive = t.inactive ? ' · inactive (.skip/.todo — it lifts nothing)' : '';
    const runs = runsOf(t);
    const run = runs
      ? ` · run ${runs}${t.at ? ` ${t.at.slice(0, 10)}` : ''} — ${fresh(t.freshness ?? 'unknown', t.changedBy)}`
      : ' · no run observed';
    return `  ${t.level === 'e2e' ? '◎' : '○'} ${t.name} — ${level} · ${caseWordText(t)}${inactive}${run} \`${t.id}\``;
  };

  if (testId) {
    const d = testDetail(index, testId);
    if (!d) return text(`unknown test id: ${testId}. Use test_coverage with no arguments, or search_graph kind:test.`);
    if (raw) return text(JSON.stringify(d, null, 2));
    const lines = [
      `# ${d.name}`,
      `${d.test.level} · ${d.test.runner}${d.test.project ? ` · ${d.test.project}` : ''} — ${d.repo}/${d.test.file}${d.loc ? `:${d.loc.line}` : ''}`,
      ...(d.test.suite.length ? [`suite: ${d.test.suite.join(' › ')}`] : []),
      ...(d.docs ? [`docs: ${d.docs}`] : []),
      ...(d.test.declares?.length ? [`declares: ${d.test.declares.join(', ')}`] : []),
      ...(d.test.unresolved?.length ? [`⚠ declares ${d.test.unresolved.join(', ')}, which nothing in the graph matches`] : []),
      ...(d.test.run ? [`last run: ${d.test.run.status} at ${d.test.run.at}${d.test.run.durationMs != null ? ` (${d.test.run.durationMs}ms)` : ''} — ${d.test.run.freshness === 'unchanged' ? 'the source is unchanged since' : d.test.run.freshness === 'changed' ? changedWords(d.test.run.changedBy) : 'whether the source changed since is unknown (the reporter recorded no digest)'}`] : ['no run observed']),
      '',
      '## covers',
    ];
    for (const c of d.covers) lines.push(`- [${c.kind}] ${c.name} — ${c.evidence}${c.confidence ? ` · ${c.confidence} · ${c.technique}` : ''}${c.note ? ` · ${c.note}` : ''} \`${c.nodeId}\``);
    if (!d.covers.length) lines.push('- nothing in the graph — this test is an orphan');
    if (d.journeys.length) lines.push('', `journeys: ${d.journeys.map((x) => `${x.name} \`${x.id}\``).join(' · ')}`);
    return text(lines.join('\n'));
  }

  if (node) {
    const n = index.byId.get(node) ?? resolveEntry(index, node, { ...(repo ? { repo } : {}), ...(group ? { group } : {}) });
    if (!n) return text(`nothing in the graph matches: ${node}`);
    // the fold the journey gutter and the inspector read — so an agent and a reader get one answer;
    // its refs include a route's handler at the same file:line (one place in the code, one verdict)
    const step = stepCoverage(index, n.id);
    const covers = step?.tests.length ? step.tests : verifiedBy(index, n.id);
    if (raw) return text(JSON.stringify({ node: n.id, covers, ...(step ? { coverage: step } : {}) }, null, 2));
    if (!covers.length) {
      // a table is never covered directly: tests reach it through the functions that read and write it
      const through = n.kind === 'table' ? verifiedThrough(index, n.id) : [];
      if (through.length) {
        return text([
          `${n.name} (${n.kind}) \`${n.id}\``,
          'verified by: nothing directly — no test in the graph names this table',
          `reached by ${through.length} test(s) through its accessors:`,
          ...through.slice(0, 20).map((t) => `${testLine(t)} · via ${(t.via ? index.byId.get(t.via)?.name : undefined) ?? t.via ?? '?'}`),
          ...(through.length > 20 ? [`  … +${through.length - 20} more`] : []),
        ].join('\n'));
      }
      return text(`${n.name} (${n.kind}) \`${n.id}\`\nverified by: nothing — no test in the graph reaches this node.${step === undefined ? ' (not built: declared only, so no test could reach it)' : ''}`);
    }
    return text([
      `${n.name} (${n.kind}) \`${n.id}\``,
      `verified by ${covers.length} test(s)${step ? ` — e2e ${step.e2e} · unit/integration ${step.unit}${step.observed ? ' · observed by a run' : ' · no run observed it'}` : ''}:`,
      // the one verdict of this node — the word the HUD's chip prints — then its cases by their own runs, a count
      ...(step?.verdict ? [`evidence: ${chipWord({ chip: step.chip ?? 'none', evidenceWord: step.verdict.word, ...(step.observation ? { observation: step.observation } : {}) })}${step.verdict.status ? ` · the run behind it: ${step.verdict.status}` : ''}`,
        `their own last runs: ${countedText(step.verdict.runs)} (${breakdownText({ ...step.verdict.runs, breakdown: (step.verdict.runs.breakdown ?? []).filter((p) => p.n) })})`] : []),
      ...(step?.sameLoc?.length ? [`read with ${step.sameLoc.map((id) => `\`${id}\``).join(', ')} — the same file:line`] : []),
      ...covers.map(testLine),
      ...(step?.note ? [step.note] : []),
    ].join('\n'));
  }

  /** A capped, named group — MCP output budgets (the 2026-07 MCP agent review P0). */
  const testGroup = (label: string, tests: CoverageTestRef[], cap = 12): string[] => {
    if (!tests.length) return [`${label} (0): none`];
    const out = [`${label} (${tests.length}):`, ...tests.slice(0, cap).map(testLine)];
    if (tests.length > cap) out.push(`  … +${tests.length - cap} more`);
    return out;
  };

  // the level holds every count to one level, not only the rows (docs/COUNTS.md); the matrix is never level-filtered
  const surface = testsSurface(index, scope, store.meta.tests, matrix ? {} : { level });
  // every number below is as of one sync, commit and content digest — the matrix's identity block
  const identity = testsIdentity(store.meta);
  if (matrix) {
    // the same fold and identity `farsight tests matrix` and GET /api/tests/matrix emit
    const doc = testsMatrixV1(index, surface, identity);
    return text(matrix === 'csv' ? testsMatrixCsv(doc.rows) : JSON.stringify(doc, null, 2));
  }
  const identityLine = `as of ${identity.sync != null ? `sync ${identity.sync}` : 'an unnumbered sync'}${identity.source_commit ? ` · ${identity.source_commit.slice(0, 7)}` : ''}${Object.keys(identity.source_digest).length ? ` · digest ${Object.entries(identity.source_digest).map(([r, d]) => `${r} ${d.slice(0, 10)}`).join(', ')}` : ' · no content digest recorded (run freshness reads unknown)'}`;
  if (flow) {
    const row = surface.journeys.find((r) => r.flowId === flow || r.designId === flow || r.name.toLowerCase() === flow.toLowerCase())
      ?? surface.journeys.find((r) => r.name.toLowerCase().includes(flow.toLowerCase()));
    if (!row) return text(`no flow matches "${flow}". Flows in scope: ${surface.journeys.map((r) => r.name).join(', ') || 'none'}`);
    if (raw) return text(JSON.stringify(row, null, 2));
    const c = row.coverage;
    const lines = [
      `# ${row.name}${row.designId ? ` (${row.designId})` : ''} — ${formatMetric(c.metric)} of ${c.metric.scopeLabel}`,
      identityLine,
      `${row.built} of ${row.screens} screen(s) built · evidence: ${flowEvidenceWord(c)}`,
      // a count line, never a verdict — each number with its scope and, for e2e, its evidence split
      c.counted
        ? `tests: ${countedLine([c.counted.tests, c.counted.observed, c.counted.runReports])}\n  e2e: ${countedText(c.counted.e2e)} (${breakdownText(c.counted.e2e)})`
        : `tests: ${c.counts.tests.e2e} e2e · ${c.counts.tests.unit} unit · ${c.counts.tests.integration} integration · ${c.counts.tests.observed} observed${c.counts.tests.runLevel ? ` · ${c.counts.tests.runLevel} run-level report(s)` : ''}`,
      `end to end: ${e2ePhrase(c, true)}`,
      // the run is its own fact, never folded into the evidence word
      // the run that earned the evidence word, apart from the covering tests' own last run
      c.observation
        ? `observed by: ${c.observation.by === 'runs' ? `${c.observation.reports} coverage report(s), no case named`
          : c.observation.by === 'declaration' ? `${c.observation.cases} end-to-end case(s) a results report says passed, by their own declaration (@covers) — no coverage measured which lines they ran`
            : `${c.observation.cases} case(s) a results report named${c.observation.declared ? ` (${c.observation.declared} of them by their own declaration)` : ''}`} · ${c.observation.at.slice(0, 10)} · ${c.observation.status} — ${fresh(c.observation.freshness, c.observation.changedBy)}`
        : 'observed by: nothing — no run reached this flow',
      // the cases' own runs are a count beside the verdict, never a second verdict (swarm 2026-10-05, finding 1)
      c.verdict?.runs.n
        ? `their own last runs: ${countedText(c.verdict.runs)} (${breakdownText({ ...c.verdict.runs, breakdown: (c.verdict.runs.breakdown ?? []).filter((p) => p.n) })})${c.run?.projects.length ? ` · project(s) ${c.run.projects.join(', ')}` : ''}`
        : 'their own last runs: no case reaches this flow',
      c.note,
      row.gap,
      '',
      // an agent pays for every token: name a dozen, then say how many more
      ...testGroup('declared', row.declared),
      ...testGroup('inferred', row.inferred),
      ...testGroup('observed', row.observed),
    ];
    if (gaps) {
      lines.push('', `## what no test reaches (${c.metric.gaps.length})`);
      for (const g of c.metric.gaps.slice(0, 60)) lines.push(`- ${g.name}${g.loc ? ` — ${g.loc.path}:${g.loc.line}` : ''} \`${g.nodeId}\``);
      if (c.metric.gaps.length > 60) lines.push(`… +${c.metric.gaps.length - 60} more — narrow the scope with node: or repo:`);
    }
    return text(lines.join('\n'));
  }

  if (raw) return text(JSON.stringify({ identity, ...surface }, null, 2));
  const c = surface.counts;
  const lines = [
    `# tests — ${surface.counted ? countedLine([surface.counted.cases, surface.counted.files, surface.counted.sources]) : `${c.cases} case(s) in ${c.files} file(s)`}, ${c.covers} covers edge(s)`,
    identityLine,
    `evidence (covers edges): declared ${c.declared}${c.declaredPassed ? ` (${c.declaredPassed} by an end-to-end case that passed — observed, by its own declaration, wherever a scope is read)` : ''} · inferred ${c.static} · observed ${c.observed}`,
    `coverage: ${formatMetric(surface.metric)} of ${surface.metric.scopeLabel}${surface.metric.bound === 'floor' ? ' (a floor: ' + surface.metric.uncertainty?.note + ')' : ''}`,
    '',
    '## suites',
    ...surface.sources
      .filter((sc) => !level || sc.level === level)
      .map((sc) => `- ${sc.repo} · ${sc.level} · ${sc.runner} — ${sc.counted ? `${countedText(sc.counted.files, { scope: false })}, ${countedText(sc.counted.cases)} (${breakdownText({ ...sc.counted.cases, breakdown: sc.counted.cases.breakdown?.filter((p) => p.n) })})` : `${sc.files} file(s), ${sc.cases} case(s)`}; ${sc.freshness}${sc.counted?.passedByDeclaration ? `\n  ${countedText(sc.counted.passedByDeclaration, { scope: false })}: ${breakdownText(sc.counted.passedByDeclaration)}` : ''}`),
    '',
    ...suiteLines(surface.suites.filter((sr) => !level || sr.level === level)),
    '## journeys × tests',
    ...surface.journeys.map((r) => `- ${r.name}: ${formatMetric(r.coverage.metric)} of ${r.coverage.metric.scopeLabel} · ${e2ePhrase(r.coverage)} · declared ${r.declared.length} · inferred ${r.inferred.length} · observed ${r.observed.length} — ${r.gap} \`${r.flowId}\``),
  ];
  if (!surface.journeys.length) lines.push('- no flows in scope — add a screens manifest (design_guide) to get the matrix');
  if (surface.orphans.length) {
    lines.push('', `## orphans (${surface.orphans.length})`);
    for (const o of surface.orphans.slice(0, 20)) {
      lines.push(`- ${o.reason === 'unresolved-claim' ? `declares ${o.declares?.join(', ')}, which nothing in the graph matches` : 'covers nothing the graph knows'} — ${o.file}${o.line ? `:${o.line}` : ''} · ${o.name}`);
    }
  }
  if (surface.blindSpots.length) {
    lines.push('', '## blind spots');
    // the ingest already folded gaps of the same kind into one sentence with ×n (03 §3.4), so these
    // are distinct shapes: print them. The cap is a budget, not a fold, and says so when it bites.
    for (const b of surface.blindSpots.slice(0, 40)) lines.push(`⚠ ${b}`);
    if (surface.blindSpots.length > 40) lines.push(`⚠ … +${surface.blindSpots.length - 40} more blind spot(s), each a different shape — raw:true returns them all`);
  }
  if (gaps) {
    lines.push('', `## what no test reaches (${surface.metric.gaps.length})`);
    for (const g of surface.metric.gaps.slice(0, 60)) lines.push(`- ${g.name}${g.loc ? ` — ${g.loc.path}:${g.loc.line}` : ''} \`${g.nodeId}\``);
    if (surface.metric.gaps.length > 60) lines.push(`… +${surface.metric.gaps.length - 60} more — pass flow: or repo: to narrow the scope`);
  }
  return text(lines.join('\n'));
});

server.registerTool('model_hub_state', {
  title: 'Model Hub — live AI runtime state',
  description: 'See what AI is running on this machine right now: local models grouped by capability category (text-to-speech, spoken rewrite/recap, …) with their runtime/license and whether they are actively running, the tools that drive them and the chains wiring tools together, live Ollama state (installed vs loaded), and Claude Code agent sessions observed via hooks. A runtime overlay (event stream + registry + Ollama), not the code graph. Use only for questions about local AI tooling on this machine, never for questions about the codebase.',
  inputSchema: {
    raw: z.boolean().optional().describe('return the raw JSON state payload verbatim instead of the text summary'),
  },
}, async ({ raw }) => {
  const state: ModelHubState = await readModelHubState();
  if (raw) return text(JSON.stringify(state, null, 2));

  const nowS = Math.floor(state.generatedAt / 1000);
  const ago = (ts: number | null | undefined): string => {
    if (ts == null) return 'never';
    const d = Math.max(0, nowS - ts);
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  };
  // ● = pulsing/active, ○ = idle. Mirrors the viewer's pulse liveness.
  const dot = (active: boolean) => (active ? '●' : '○');
  const activityNote = (a: Activity | undefined): string => {
    if (!a) return 'no activity recorded';
    if (a.active) return a.lastStart != null ? `active (started ${ago(a.lastStart)})` : 'active (loaded in Ollama)';
    if (a.lastEnd != null) return `idle (last ran ${ago(a.lastEnd)})`;
    if (a.lastStart != null) return `idle (last start ${ago(a.lastStart)})`;
    return 'idle (never observed running)';
  };

  const { registry, tools, models, sessions, ollama } = state;
  const dir = resolveModelHubDir();
  const empty =
    !registry.categories.length && !registry.tools.length && !registry.chains.length &&
    !Object.keys(tools).length && !Object.keys(models).length &&
    !sessions.length && !ollama.installed.length && !ollama.loaded.length;

  const lines: string[] = [`Model Hub — runtime AI state (snapshot ${new Date(state.generatedAt).toISOString()})`];

  if (empty) {
    lines.push(
      '',
      `⚠ No Model Hub data: ${dir} is missing or empty (no registry.json, no events, Ollama unreachable).`,
      'This is the runtime overlay written by local AI tools (speak-md, recap-md) and Claude Code hooks —',
      'run one of those tools, or start Ollama, to populate it.',
    );
    return text(lines.join('\n'));
  }

  // ── categories → models ──
  lines.push('', '## capability categories');
  if (!registry.categories.length) {
    lines.push('(none — registry.json has no categories)');
  } else {
    for (const cat of registry.categories) {
      lines.push(`${cat.name} (${cat.id})`);
      if (!cat.models.length) lines.push('  (no models)');
      for (const m of cat.models) {
        const a = models[m.id];
        const meta = [m.runtime, m.license].filter(Boolean).join(', ');
        lines.push(`  ${dot(!!a?.active)} ${m.id}${meta ? ` [${meta}]` : ''} — ${activityNote(a)}`);
      }
    }
  }

  // ── tools ──
  lines.push('', '## tools');
  if (!registry.tools.length) {
    lines.push('(none)');
  } else {
    for (const t of registry.tools) {
      const a = tools[t.id];
      const uses = t.uses?.length ? ` → ${t.uses.join(', ')}` : '';
      lines.push(`${dot(!!a?.active)} ${t.id}${uses} — ${activityNote(a)}`);
    }
  }

  // ── chains ──
  lines.push('', '## chains');
  if (!registry.chains.length) {
    lines.push('(none)');
  } else {
    for (const c of registry.chains) {
      const active = c.steps.some((s) => tools[s]?.active);
      lines.push(`${dot(active)} ${c.id}: ${c.steps.join(' → ')}${c.desc ? ` — ${c.desc}` : ''}`);
    }
  }

  // ── ollama ──
  lines.push('', '## ollama');
  lines.push(`installed: ${ollama.installed.length ? ollama.installed.join(', ') : '(none / unreachable)'}`);
  lines.push(`loaded (active): ${ollama.loaded.length ? ollama.loaded.join(', ') : '(none)'}`);

  // ── claude sessions ──
  lines.push('', '## claude sessions');
  if (!sessions.length) {
    lines.push('(none observed — Claude Code hooks may not be configured)');
  } else {
    for (const s of sessions) {
      const short = s.session.length > 8 ? `${s.session.slice(0, 8)}…` : s.session;
      const detail = s.active
        ? `active (last tool ${s.lastTool ?? '?'} ${ago(s.lastEventTs)})`
        : s.idle
          ? `idle (stopped ${ago(s.lastEventTs)})`
          : `inactive (last tool ${s.lastTool ?? '?'} ${ago(s.lastEventTs)})`;
      lines.push(`${dot(s.active)} ${short} — ${detail}`);
    }
  }

  return text(lines.join('\n'));
});

return { server, graphPath, nodeCount: () => nodes.length };
}
