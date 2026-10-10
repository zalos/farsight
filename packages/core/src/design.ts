/**
 * Design as a lens over the same graph (docs/proposals/design-source.md).
 *
 * A design manifest (`docs/design/screens.json`) names the screens a product
 * was designed with — the Figma frame, an image, the route each screen lives
 * at, the operations it uses. Farsight reconciles it against the `page` and
 * `component` nodes the adapters found, exactly the way an OpenAPI document
 * is reconciled against routes: matched screens gain a `design` reference,
 * designed-but-unbuilt screens are added as `page` nodes with no source
 * location, drift is computed ONCE here and stored. Pure — reading files and
 * talking to Figma lives in parsers/server.
 */
import type { GraphNode, GraphEdge, GraphFragment, DesignRef, DesignDriftKind, Loc, NodeLink, JourneyPersonaDecl, JourneyGroupDecl, JourneyStorylineDecl, JourneysMeta } from './graph.js';
import { t } from './strings.js';
import { buildIndex, type GraphIndex } from './query.js';

// ── manifest ─────────────────────────────────────────────────────────────

export interface DesignScreen {
  /** the name the docs use — "SCR-07" */
  id: string;
  name?: string;
  /** the page's identity: the route path, spelled any way (`/track/[token]`, `/track/{token}`, `/track/:token`) */
  route?: string;
  /** a component's name, for a screen that is not a page */
  component?: string;
  /** Figma node id ("26-9" or "26:9"), or a URL carrying `node-id` */
  nodeId?: string;
  url?: string;
  /** repo-relative image (png/jpg/svg/webp) — a reference; the server serves it path-confined */
  image?: string;
  /** operationIds the design says this screen uses */
  operations?: string[];
  phase?: string;
  description?: string;
  /**
   * The numbered steps a screen's spec and its tests refer to — `SCR-07.2`. A
   * `@covers SCR-07.2` resolves to this screen and keeps the step on the edge,
   * so a claim about one step of a screen is not an unresolved id (R33).
   */
  steps?: { id: string; name: string; operation?: string }[];
  /** work items this screen is built for (Jira keys, Azure DevOps ids) — a declared `tracks` link (work-items-sync.md §9) */
  work?: string[];
}

/**
 * A named user flow — a feature the business names ("Vendor (contractor)
 * validation"): an ordered set of screens, the documents that describe it,
 * the operations it spans. Becomes a `flow` node and a journey entry: the
 * journey walks each screen in order, and each screen continues into its own
 * code (built) or planned calls (designed only).
 */
export interface DesignFlow {
  id: string;
  name: string;
  description?: string;
  /** screen ids, in the order a person meets them */
  screens: string[];
  /** repo-relative documents (ADRs, product docs) or URLs that describe the flow */
  docs?: string[];
  /** operationIds the flow spans beyond what its screens list */
  operations?: string[];
  phase?: string;
  /** linked journeys: flow ids that must happen before this one / that follow it (also derived from a longer flow's screen order) */
  requires?: string[];
  leadsTo?: string[];
  /**
   * who this flow is for — a persona id or name from `personas[]`, or several; a value no
   * `personas[]` entry declares is a persona of its own (journey-organisation-and-config-files.md §4.1)
   */
  persona?: string | string[];
  /** who answers for it; absent prints as an absence word, never a guess */
  owner?: string;
  /** the group it sits in under its persona(s) — a `groups[]` id or name; absent = the persona's *Other journeys* */
  group?: string;
  /** its place in the group, ascending; ties and absences keep the order the flows are written in */
  order?: number;
  /** work items this flow is for (Jira keys, Azure DevOps ids) — a declared `tracks` link (work-items-sync.md §9) */
  work?: string[];
}

export interface DesignManifest {
  name?: string;
  /** who the journeys are for, in the order they are shown */
  personas?: JourneyPersonaDecl[];
  /** groups of journeys under a persona, in the order they are shown; one with `persona` exists under that persona only */
  groups?: JourneyGroupDecl[];
  /** storylines: named chains of journeys across features and personas, each its flow ids in order */
  storylines?: JourneyStorylineDecl[];
  figma?: { file?: string; token?: string };
  screens: DesignScreen[];
  flows?: DesignFlow[];
  /**
   * The product surfaces the docs scope, with or without screens — a customer
   * site nobody has drawn yet is a row that says *not started*, which is a
   * fact worth showing rather than an absence the reader has to infer.
   */
  surfaces?: { id: string; name: string; status?: 'built' | 'partly built' | 'not started'; description?: string }[];
}

export function isDesignManifest(x: unknown): x is DesignManifest {
  if (!x || typeof x !== 'object') return false;
  const m = x as DesignManifest;
  return Array.isArray(m.screens) && m.screens.length > 0 && m.screens.every((s) => s && typeof s === 'object' && typeof s.id === 'string');
}

export interface DesignSource {
  repo: string;
  /** repo-relative manifest path, or a URL */
  path: string;
  name?: string;
  /** design-side freshness the reader could establish (Figma lastModified, else the manifest's own) */
  lastModified?: string;
  freshness?: 'figma' | 'manifest';
}

/** Figma file key from a design/file URL, or undefined. */
export function figmaFileKey(url: string | undefined): string | undefined {
  const m = url?.match(/figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
  return m?.[1];
}

/** Figma node id from a URL's `node-id` (URL form `26-9`), normalized to `26-9`. */
export function figmaNodeId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).searchParams.get('node-id')?.replace(':', '-') ?? undefined; } catch { return undefined; }
}

export function designNodeId(repo: string, manifestPath: string): string {
  return `${repo}::design::${manifestPath}`;
}

/** The `design` node for one manifest — the file itself, like the `api` node for a spec. */
export function designNodeOf(manifest: DesignManifest, source: DesignSource): GraphNode {
  const name = source.name ?? manifest.name ?? source.path;
  const file = manifest.figma?.file;
  const isUrl = /^https?:\/\//.test(source.path);
  return {
    id: designNodeId(source.repo, source.path),
    kind: 'design',
    name,
    tags: ['design'],
    signature: [`${manifest.screens.length} screen${manifest.screens.length === 1 ? '' : 's'}`, file ? `figma ${figmaFileKey(file) ?? file}` : '', source.lastModified ? `modified ${source.lastModified} (${source.freshness ?? 'manifest'})` : ''].filter(Boolean).join(' · '),
    ...(isUrl ? {} : { loc: { repo: source.repo, path: source.path, line: 1 } as Loc }),
    ...(file ? { links: [{ kind: 'design' as const, url: file }] } : {}),
    // the manifest's own scope travels with the design node: a surface nobody has
    // drawn yet is still something the product promises
    ...(manifest.surfaces?.length
      ? { design: { status: 'both' as const, origin: 'manifest' as const, surfaces: manifest.surfaces } }
      : {}),
    facets: { business: { label: name } },
  };
}

// ── reconcile: design ↔ code ─────────────────────────────────────────────

/** `/track/[token]` · `/track/{token}` · `/track/:token` → `/track/:param`; trailing slash dropped; route groups `(x)` dropped. */
/**
 * One status word for a flow, in one place — the HUD, MCP and the CLI all ask
 * here, so a flow cannot read *partly built* on one surface and *designed, not
 * built* on another (the clarity pass §3.1: a flow is built, partly built
 * n of m, or designed, not built; "not built" is said of a screen or a route,
 * never of a whole flow).
 *
 * Returns the catalog key so a register-aware consumer can print its own
 * words, and the professional rendering for the ones that print text.
 */
export function flowStatusWord(built: number, total: number): { key: string; text: string } {
  const key = total > 0 && built >= total ? 'journey.status.built'
    : built > 0 ? 'journey.status.partly'
    : 'journey.status.designedNotBuilt';
  const text = t(key, 'professional').replace('{n}', String(built)).replace('{m}', String(total));
  return { key, text };
}

export function screenRouteKey(route: string): string {
  let p = route.trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.split('/').filter((s) => s !== '' && !(s.startsWith('(') && s.endsWith(')'))).map((s) => (/^(\[.*\]|\{.*\}|:.+|\$\{.*\})$/.test(s) ? ':param' : s)).join('/');
  return '/' + p;
}

export interface DesignDrift { kind: DesignDriftKind; message: string }

export interface FlowRow {
  nodeId: string;
  id: string;
  name: string;
  description?: string;
  /** screen design ids, in order */
  screens: string[];
  docs: string[];
  /** the same documents with the title ingest read from each one (R21) — `docs` stays the bare refs for older consumers */
  docLinks: NodeLink[];
  operations: string[];
  phase?: string;
  /** both = every screen is built · design-only = at least one screen is not */
  status: 'both' | 'design-only';
  built: number;
  total: number;
  /** who the flow is for (one persona or several), and who answers for it — absent means the manifest does not say */
  persona?: string | string[];
  owner?: string;
  /** the manifest's group and order for it (journeyTree applies the config's overrides on top) */
  group?: string;
  order?: number;
  /** where it sits in its manifest's flows (0-based); absent on a graph ingested before the manifest order was kept */
  position?: number;
  /** flow ids that must happen before this one / that follow it, as the manifest declares them */
  requires: string[];
  leadsTo: string[];
  /** the source it belongs to */
  repo: string;
  drift: DesignDrift[];
}

export interface DesignReconcile {
  design: { id: string; name: string; path: string };
  /** named flows: screens in order, how many are built, drift (unknown screen ids, operations no contract declares) */
  flows: { flow: DesignFlow; nodeId: string; screenNodeIds: string[]; built: number; drift: DesignDrift[]; position?: number }[];
  /** designed and built: the screen resolved to a page/component in the code */
  matched: { screen: DesignScreen; nodeId: string; drift: DesignDrift[] }[];
  /** designed, not built: no page/component at that route/name */
  designOnly: { screen: DesignScreen; nodeId: string; drift: DesignDrift[] }[];
  /** a screen row with neither route nor component — listed, flagged, never dropped */
  unmatched: DesignScreen[];
  /** built, not designed: pages in the repo with no design row */
  codeOnly: { nodeId: string; name: string; loc?: Loc }[];
  counts: { screens: number; built: number; designOnly: number; codeOnly: number; unmatched: number; drift: number };
}

export interface DesignReconcileOptions {
  /** the repo whose pages the manifest describes; omitted = the source's repo */
  repo?: string;
  /** stamp this design id instead of the one derived from the source path (proposed manifests) */
  designId?: string;
}

function repoOfNode(n: GraphNode): string { return n.loc?.repo ?? n.id.split('::')[0]!; }

/** operationId → route node, over every contract in the graph. */
export function operationIndex(index: GraphIndex): Map<string, GraphNode> {
  const out = new Map<string, GraphNode>();
  for (const n of index.byId.values()) {
    const op = n.contract?.spec?.operationId;
    if (n.kind === 'route' && op && !out.has(op)) out.set(op, n);
  }
  return out;
}

const REACH = new Set<string>(['calls', 'renders', 'http']);

/** Routes a screen reaches (bounded downstream walk over calls/renders/http), keyed by node id. */
export function routesReachedFrom(index: GraphIndex, fromId: string, maxDepth = 8): GraphNode[] {
  const seen = new Set<string>([fromId]);
  const routes: GraphNode[] = [];
  let frontier = [fromId];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.out.get(id) ?? []) {
        if (!REACH.has(e.kind) || seen.has(e.to)) continue;
        seen.add(e.to);
        const n = index.byId.get(e.to);
        if (!n) continue;
        if (n.kind === 'route') routes.push(n);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return routes;
}

/**
 * Reconcile a manifest against the pages/components of one repo. Pure, no
 * mutation — `applyDesignToFragment` writes the result into a fragment at
 * ingest; the server/CLI/MCP call this directly for a proposed manifest.
 */
export function reconcileDesign(manifest: DesignManifest, index: GraphIndex, source: DesignSource, opts: DesignReconcileOptions = {}): DesignReconcile {
  const repo = opts.repo ?? source.repo;
  const designId = opts.designId ?? designNodeId(source.repo, source.path);
  const pagesByRoute = new Map<string, GraphNode>();
  const componentsByName = new Map<string, GraphNode>();
  for (const n of index.byId.values()) {
    if (repoOfNode(n) !== repo || !n.loc) continue; // built = has a source location; a design-only page from an earlier pass is not built
    if (n.kind === 'page') { const k = screenRouteKey(n.name); if (!pagesByRoute.has(k)) pagesByRoute.set(k, n); }
    else if (n.kind === 'component' && !componentsByName.has(n.name)) componentsByName.set(n.name, n);
  }
  const ops = operationIndex(index);
  const matched: DesignReconcile['matched'] = [];
  const designOnly: DesignReconcile['designOnly'] = [];
  const unmatched: DesignScreen[] = [];
  const claimed = new Set<string>();
  let driftTotal = 0;

  for (const screen of manifest.screens) {
    const drift: DesignDrift[] = [];
    // operations the design names must exist in some contract
    for (const op of screen.operations ?? []) {
      if (!ops.has(op)) drift.push({ kind: 'operation-not-in-spec', message: `the design lists operation ${op}; no API contract declares it` });
    }
    let node: GraphNode | undefined;
    if (screen.route) node = pagesByRoute.get(screenRouteKey(screen.route));
    else if (screen.component) node = componentsByName.get(screen.component);
    else { unmatched.push(screen); driftTotal += drift.length; continue; }

    if (node && !claimed.has(node.id)) {
      claimed.add(node.id);
      // built: does the page actually reach what the design says it uses?
      if (screen.operations?.length) {
        const reached = routesReachedFrom(index, node.id);
        const reachedOps = new Set(reached.map((r) => r.contract?.spec?.operationId).filter((x): x is string => !!x));
        for (const op of screen.operations) {
          if (!ops.has(op) || reachedOps.has(op)) continue;
          const route = ops.get(op)!;
          drift.push({ kind: 'operation-unreached', message: `the design says this screen uses ${op} (${route.name}); the built page never reaches it${route.loc ? '' : ' — the operation itself is not implemented yet'}` });
        }
        for (const op of reachedOps) {
          if (!screen.operations.includes(op)) drift.push({ kind: 'operation-undeclared', message: `the built page calls ${op}; the design does not list it` });
        }
      }
      matched.push({ screen, nodeId: node.id, drift });
    } else {
      drift.unshift({ kind: 'design-only', message: 'designed; no page or component at this route in the indexed code' });
      const nodeId = screen.route ? `${repo}::page::${screenRouteKey(screen.route).replace(/:param/g, ':param')}` : `${repo}::component::${screen.component}`;
      designOnly.push({ screen, nodeId, drift });
    }
    driftTotal += drift.length;
  }

  const codeOnly: DesignReconcile['codeOnly'] = [];
  for (const n of pagesByRoute.values()) {
    if (claimed.has(n.id)) continue;
    codeOnly.push({ nodeId: n.id, name: n.name, ...(n.loc ? { loc: n.loc } : {}) });
    driftTotal++;
  }

  // flows: screens in order → node ids (built or declared), unknown ids and undeclared operations are drift
  const nodeIdOfScreen = new Map<string, { nodeId: string; built: boolean }>();
  for (const m of matched) nodeIdOfScreen.set(m.screen.id, { nodeId: m.nodeId, built: true });
  for (const d of designOnly) nodeIdOfScreen.set(d.screen.id, { nodeId: d.nodeId, built: false });
  const flows: DesignReconcile['flows'] = [];
  for (const flow of manifest.flows ?? []) {
    const drift: DesignDrift[] = [];
    const screenNodeIds: string[] = [];
    let built = 0;
    for (const sid of flow.screens ?? []) {
      const hit = nodeIdOfScreen.get(sid);
      if (!hit) { drift.push({ kind: 'screen-unknown', message: `flow ${flow.id} names screen ${sid}; the manifest defines no such screen (or it has no route/component)` }); continue; }
      screenNodeIds.push(hit.nodeId);
      if (hit.built) built++;
    }
    for (const op of flow.operations ?? []) {
      if (!ops.has(op)) drift.push({ kind: 'operation-not-in-spec', message: `flow ${flow.id} lists operation ${op}; no API contract declares it` });
    }
    const flowIds = new Set((manifest.flows ?? []).map((f) => f.id.toLowerCase()));
    for (const [field, ids] of [['requires', flow.requires], ['leadsTo', flow.leadsTo]] as const) {
      for (const fid of ids ?? []) if (!flowIds.has(fid.toLowerCase())) drift.push({ kind: 'flow-unknown', message: `flow ${flow.id} ${field} ${fid}; the manifest defines no such flow` });
    }
    driftTotal += drift.length;
    flows.push({ flow, nodeId: `${repo}::flow::${flow.id}`, screenNodeIds, built, drift, position: flows.length });
  }

  return {
    design: { id: designId, name: source.name ?? manifest.name ?? source.path, path: source.path },
    flows, matched, designOnly, unmatched, codeOnly,
    counts: { screens: manifest.screens.length, built: matched.length, designOnly: designOnly.length, codeOnly: codeOnly.length, unmatched: unmatched.length, drift: driftTotal },
  };
}

const URL_RE = /^https?:\/\//i;

/** `work: ["KAN-3"]` on a screen or flow → `work:KAN-3` tags, the declared link the server joins to a work item. */
function workTags(keys: string[] | undefined): string[] {
  return (keys ?? []).filter((k) => typeof k === 'string' && k.trim()).map((k) => `work:${k.trim().replace(/^#/, '')}`);
}

/** The `flow` node for a manifest flow: a journey entry that renders its screens in order. */
/** A manifest's `persona` as written: a trimmed string, a list of trimmed strings, or nothing (empty values dropped). */
export function personaValue(v: unknown): string | string[] | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
  return list.length > 1 ? list : list[0];
}

export function flowNodeOf(f: DesignReconcile['flows'][number], source: DesignSource, designId: string): GraphNode {
  const { flow } = f;
  const total = flow.screens?.length ?? 0;
  const links = (flow.docs ?? []).map((d) => (URL_RE.test(d) ? { kind: 'see' as const, url: d } : { kind: 'doc' as const, ref: d }));
  return {
    id: f.nodeId, kind: 'flow', name: flow.name,
    tags: ['entrypoint', 'flow', `design:${flow.id.toLowerCase()}`, ...(flow.phase ? [`phase:${String(flow.phase).toLowerCase()}`] : []), ...workTags(flow.work)],
    ...(flow.description ? { docs: flow.description } : {}),
    ...(links.length ? { links } : {}),
    design: {
      status: total > 0 && f.built === total ? 'both' : 'design-only', origin: 'manifest', designId,
      id: flow.id, name: flow.name,
      ...(flow.operations?.length ? { operations: flow.operations } : {}),
      ...(flow.phase ? { phase: String(flow.phase) } : {}),
      ...(flow.requires?.length ? { requires: flow.requires } : {}),
      ...(flow.leadsTo?.length ? { leadsTo: flow.leadsTo } : {}),
      ...(personaValue(flow.persona) ? { persona: personaValue(flow.persona)! } : {}),
      ...(flow.owner ? { owner: flow.owner } : {}),
      ...(typeof flow.group === 'string' && flow.group.trim() ? { group: flow.group.trim() } : {}),
      ...(typeof flow.order === 'number' && Number.isFinite(flow.order) ? { order: flow.order } : {}),
      ...(f.position != null ? { position: f.position } : {}),
      ...(source.lastModified ? { lastModified: source.lastModified, freshness: source.freshness ?? 'manifest' } : {}),
      ...(f.drift.length ? { drift: f.drift } : {}),
    },
    facets: { business: { label: flow.name, ...(flow.description ? { description: flow.description } : {}) } },
  };
}

function refOf(screen: DesignScreen, manifest: DesignManifest, source: DesignSource, designId: string, status: DesignRef['status'], drift: DesignDrift[]): DesignRef {
  const nodeId = screen.nodeId?.replace(':', '-') ?? figmaNodeId(screen.url);
  const file = manifest.figma?.file;
  const url = screen.url ?? (file && nodeId ? `${file.split('?')[0]}?node-id=${nodeId}` : file);
  return {
    status, origin: 'manifest', designId,
    id: screen.id,
    ...(screen.name ? { name: screen.name } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(url ? { url } : {}),
    ...(screen.image ? { image: { kind: 'file' as const, path: screen.image } } : nodeId && file ? { image: { kind: 'figma' as const } } : {}),
    ...(source.lastModified ? { lastModified: source.lastModified, freshness: source.freshness ?? 'manifest' } : {}),
    ...(screen.operations?.length ? { operations: screen.operations } : {}),
    ...(screen.phase ? { phase: String(screen.phase) } : {}),
    ...(screen.steps?.length ? { steps: screen.steps } : {}),
    ...(drift.length ? { drift } : {}),
  };
}

/**
 * Ingest-time application: reconcile and write the result into the fragment —
 * matched screens gain `design`, design-only screens are added as `page`
 * nodes with no `loc`, code-only pages are stamped, and the `design` node
 * with its `contains` edges is added. Mutates in place.
 */
export function applyDesignToFragment(fragment: GraphFragment, manifest: DesignManifest, source: DesignSource): DesignReconcile {
  const index = buildIndex(fragment.nodes, fragment.edges);
  const result = reconcileDesign(manifest, index, source, { repo: fragment.repo });
  const design = designNodeOf(manifest, source);
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  if (!byId.has(design.id)) { fragment.nodes.push(design); byId.set(design.id, design); }
  let seq = fragment.edges.length;
  const contains = (to: string, undesigned = false) => {
    if (fragment.edges.some((e) => e.kind === 'contains' && e.from === design.id && e.to === to)) return;
    fragment.edges.push({ id: `d${seq++}`, kind: 'contains', from: design.id, to, ...(undesigned ? { meta: { undesigned: true } } : {}), resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' } } as GraphEdge);
  };
  for (const m of result.matched) {
    const node = byId.get(m.nodeId)!;
    // a manifest read earlier stamped this page *built, not designed* — it was not that manifest's
    // screen, and now one manifest designs it: the earlier stamp and its membership go (several
    // manifests per source, one per NX app, journey-organisation-and-config-files.md §4)
    if (node.design?.origin === 'manifest' && node.design.status === 'code-only') {
      for (let i = fragment.edges.length - 1; i >= 0; i--) {
        const e = fragment.edges[i]!;
        if (e.kind === 'contains' && e.to === node.id && e.from !== design.id && e.meta?.undesigned) fragment.edges.splice(i, 1);
      }
      node.tags = node.tags.filter((t) => t !== 'undesigned');
    }
    node.design = refOf(m.screen, manifest, source, design.id, 'both', m.drift);
    for (const t of [`design:${m.screen.id.toLowerCase()}`, ...workTags(m.screen.work)]) if (!node.tags.includes(t)) node.tags.push(t);
    // the design's name and sentence are the business words for a built screen (a glossary entry or @business still wins)
    const biz = { ...node.facets?.business };
    if (m.screen.name && !biz.label) biz.label = m.screen.name;
    if (m.screen.description && !biz.description) biz.description = m.screen.description;
    if (biz.label || biz.description) node.facets = { ...node.facets, business: biz as { label: string; description?: string } };
    contains(node.id);
  }
  for (const d of result.designOnly) {
    if (byId.has(d.nodeId)) continue;
    const s = d.screen;
    const node: GraphNode = {
      id: d.nodeId, kind: s.route ? 'page' : 'component', name: s.route ? screenRouteKey(s.route) : s.component!,
      tags: ['design-only', `design:${s.id.toLowerCase()}`, ...workTags(s.work)],
      ...(s.description ? { docs: s.description } : {}),
      design: refOf(s, manifest, source, design.id, 'design-only', d.drift),
      facets: { business: { label: s.name ?? s.id, ...(s.description ? { description: s.description } : {}) } },
    };
    fragment.nodes.push(node);
    byId.set(node.id, node);
    contains(node.id);
  }
  for (const c of result.codeOnly) {
    const node = byId.get(c.nodeId)!;
    if (node.design && node.design.origin === 'annotation') continue; // an @design annotation is a design row of its own
    // another manifest of this source designs this page: it is not *undesigned*, only not this manifest's
    if (node.design && node.design.origin === 'manifest' && node.design.status !== 'code-only' && node.design.designId !== design.id) continue;
    node.design = { status: 'code-only', origin: 'manifest', designId: design.id, drift: [{ kind: 'code-only', message: 'built; no screen in the design manifest describes this page' }] };
    if (!node.tags.includes('undesigned')) node.tags.push('undesigned');
    contains(node.id, true);
  }
  // flows: a node per flow, rendering its screens in order (meta.line carries the order for journey())
  for (const f of result.flows) {
    if (!byId.has(f.nodeId)) { const n = flowNodeOf(f, source, design.id); fragment.nodes.push(n); byId.set(n.id, n); }
    contains(f.nodeId);
    f.screenNodeIds.forEach((sid, i) => {
      if (fragment.edges.some((e) => e.kind === 'renders' && e.from === f.nodeId && e.to === sid)) return;
      fragment.edges.push({ id: `d${seq++}`, kind: 'renders', from: f.nodeId, to: sid, meta: { line: i + 1 }, resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH' } } as GraphEdge);
    });
  }
  return result;
}

/** A manifest with no code at all (a design-only source): design node + declared screens. */
export function designToFragment(manifest: DesignManifest, source: DesignSource): GraphFragment {
  const fragment: GraphFragment = { repo: source.repo, nodes: [], edges: [], meta: { files: 1, sourceHash: 'design' } };
  applyDesignToFragment(fragment, manifest, source);
  return fragment;
}

// ── the design surface: what the viewer, CLI and MCP list ────────────────

export interface ScreenRow {
  nodeId: string;
  /** the design's id for the screen ("SCR-07"); absent for code-only pages */
  designId?: string;
  name: string;
  kind: 'page' | 'component';
  route?: string;
  status: DesignRef['status'];
  url?: string;
  hasImage: boolean;
  operations: string[];
  phase?: string;
  lastModified?: string;
  freshness?: 'figma' | 'manifest';
  drift: DesignDrift[];
  loc?: Loc;
}

export interface DesignSurface {
  id: string;
  name: string;
  repo: string;
  manifestPath: string;
  figmaFile?: string;
  signature?: string;
  screens: ScreenRow[];
  /** named flows (features): screens in order, how many are built — each runs as a journey from its node id */
  flows: FlowRow[];
  /** product surfaces the manifest scopes, with or without screens (a "not started" one is still a row) */
  surfaces: NonNullable<DesignManifest['surfaces']>;
  counts: { screens: number; designed: number; built: number; designOnly: number; codeOnly: number; drift: number; flows: number };
}

function flowRow(index: GraphIndex, n: GraphNode): FlowRow {
  const d = n.design!;
  const screens = (index.out.get(n.id) ?? [])
    .filter((e) => e.kind === 'renders')
    .sort((a, b) => (Number(a.meta?.line) || 0) - (Number(b.meta?.line) || 0))
    .map((e) => index.byId.get(e.to))
    .filter((s): s is GraphNode => !!s);
  const built = screens.filter((s) => !!s.loc).length;
  return {
    nodeId: n.id, id: d.id ?? n.name, name: n.name,
    ...(n.docs ? { description: n.docs } : {}),
    screens: screens.map((s) => s.design?.id ?? s.name),
    docs: (n.links ?? []).map((l) => l.url ?? l.ref ?? '').filter(Boolean),
    docLinks: (n.links ?? []).filter((l) => l.kind !== 'design' && (l.url || l.ref)),
    operations: d.operations ?? [],
    ...(d.phase ? { phase: d.phase } : {}),
    status: screens.length > 0 && built === screens.length ? 'both' : 'design-only',
    built, total: screens.length,
    ...(d.persona ? { persona: d.persona } : {}),
    ...(d.owner ? { owner: d.owner } : {}),
    ...(d.group ? { group: d.group } : {}),
    ...(d.order != null ? { order: d.order } : {}),
    ...(d.position != null ? { position: d.position } : {}),
    requires: d.requires ?? [],
    leadsTo: d.leadsTo ?? [],
    repo: repoOfNode(n),
    drift: d.drift ?? [],
  };
}

function screenRow(n: GraphNode): ScreenRow {
  const d = n.design!;
  return {
    nodeId: n.id,
    ...(d.id ? { designId: d.id } : {}),
    name: d.name ?? n.facets?.business?.label ?? n.name,
    kind: n.kind === 'component' ? 'component' : 'page',
    ...(n.kind === 'page' ? { route: n.name } : {}),
    status: d.status,
    ...(d.url ? { url: d.url } : {}),
    hasImage: !!d.image,
    operations: d.operations ?? [],
    ...(d.phase ? { phase: d.phase } : {}),
    ...(d.lastModified ? { lastModified: d.lastModified } : {}),
    ...(d.freshness ? { freshness: d.freshness } : {}),
    drift: d.drift ?? [],
    ...(n.loc ? { loc: n.loc } : {}),
  };
}

/** Every design source in scope: one per `design` node with its screens (matched, declared, and code-only pages it stamped). */
export function designSurface(index: GraphIndex, scope?: Set<string> | null): DesignSurface[] {
  const out: DesignSurface[] = [];
  for (const n of index.byId.values()) {
    if (n.kind !== 'design') continue;
    const repo = repoOfNode(n);
    if (scope && !scope.has(repo)) continue;
    const members = (index.out.get(n.id) ?? [])
      .filter((e) => e.kind === 'contains')
      .map((e) => index.byId.get(e.to))
      .filter((s): s is GraphNode => !!s && !!s.design);
    const screens = members.filter((s) => s.kind !== 'flow').map(screenRow)
      .sort((a, b) => (a.designId ?? '~').localeCompare(b.designId ?? '~') || a.name.localeCompare(b.name));
    const flows = members.filter((s) => s.kind === 'flow').map((f) => flowRow(index, f)).sort((a, b) => a.name.localeCompare(b.name));
    const figmaFile = n.links?.find((l) => l.kind === 'design')?.url;
    out.push({
      id: n.id, name: n.name, repo, manifestPath: n.id.slice(`${repo}::design::`.length),
      ...(figmaFile ? { figmaFile } : {}),
      ...(n.signature ? { signature: n.signature } : {}),
      screens, flows,
      surfaces: n.design?.surfaces ?? [],
      counts: {
        screens: screens.length,
        designed: screens.filter((s) => s.status !== 'code-only').length,
        built: screens.filter((s) => s.status === 'both').length,
        designOnly: screens.filter((s) => s.status === 'design-only').length,
        codeOnly: screens.filter((s) => s.status === 'code-only').length,
        drift: screens.reduce((sum, s) => sum + s.drift.length, 0) + flows.reduce((sum, f) => sum + f.drift.length, 0),
        flows: flows.length,
      },
    });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
}

/**
 * The screens a journey starts from: the entry itself when it is a screen,
 * else the pages/components upstream of it (bounded walk over calls/renders/http).
 * Feeds the SCREEN band of the journey view — derived cards, never hand-placed.
 */
export function screensFor(index: GraphIndex, entryId: string, cap = 6): GraphNode[] {
  const entry = index.byId.get(entryId);
  if (!entry) return [];
  if (entry.kind === 'page' || entry.kind === 'component') return [entry];
  // a flow: its screens, in the order a person meets them
  if (entry.kind === 'flow') {
    return (index.out.get(entryId) ?? [])
      .filter((e) => e.kind === 'renders')
      .sort((a, b) => (Number(a.meta?.line) || 0) - (Number(b.meta?.line) || 0))
      .map((e) => index.byId.get(e.to))
      .filter((n): n is GraphNode => !!n);
  }
  const seen = new Set<string>([entryId]);
  const screens: GraphNode[] = [];
  let frontier = [entryId];
  for (let depth = 0; depth < 5 && frontier.length && screens.length < cap; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.in.get(id) ?? []) {
        if (!REACH.has(e.kind) || seen.has(e.from)) continue;
        seen.add(e.from);
        const n = index.byId.get(e.from);
        if (!n) continue;
        if (n.kind === 'page' || n.kind === 'component') { screens.push(n); if (screens.length >= cap) break; }
        next.push(e.from);
      }
    }
    frontier = next;
  }
  // pages first (a page is the screen a person names), then components
  return screens.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'page' ? -1 : 1));
}

/** Markdown rendering of a design reconcile (CLI `design diff`, MCP `design_drift`). */
export function designDriftMarkdown(r: DesignReconcile): string {
  const c = r.counts;
  const lines = [
    `# Design drift — ${r.design.name} (${r.design.path})`,
    `screens ${c.screens} · built ${c.built} · not built ${c.designOnly} · undesigned pages ${c.codeOnly}${c.unmatched ? ` · unmatched rows ${c.unmatched}` : ''}${r.flows.length ? ` · flows ${r.flows.length}` : ''} · drift ${c.drift}`,
    '',
  ];
  if (r.flows.length) {
    lines.push('## flows');
    for (const f of r.flows) {
      lines.push(`- ${f.flow.id} ${f.flow.name} — ${f.built} of ${f.flow.screens?.length ?? 0} screens built: ${(f.flow.screens ?? []).join(' → ')}`);
      for (const d of f.drift) lines.push(`    ${d.kind}: ${d.message}`);
    }
    lines.push('');
  }
  if (r.designOnly.length) {
    lines.push('## designed, not built');
    for (const d of r.designOnly) lines.push(`- ${d.screen.id}${d.screen.name ? ` ${d.screen.name}` : ''} — ${d.screen.route ?? d.screen.component}${d.screen.operations?.length ? ` · uses ${d.screen.operations.join(', ')}` : ''}`);
    lines.push('');
  }
  if (r.codeOnly.length) {
    lines.push('## built, not designed');
    for (const p of r.codeOnly) lines.push(`- ${p.name}${p.loc ? ` — ${p.loc.path}:${p.loc.line}` : ''}`);
    lines.push('');
  }
  const withDrift = r.matched.filter((m) => m.drift.length);
  if (withDrift.length) {
    lines.push('## built with differences');
    for (const m of withDrift) {
      lines.push(`- ${m.screen.id}${m.screen.name ? ` ${m.screen.name}` : ''} — ${m.nodeId}`);
      for (const d of m.drift) lines.push(`    ${d.kind}: ${d.message}`);
    }
    lines.push('');
  }
  if (r.unmatched.length) {
    lines.push('## rows with no route or component');
    for (const s of r.unmatched) lines.push(`- ${s.id}${s.name ? ` ${s.name}` : ''}`);
    lines.push('');
  }
  if (!r.designOnly.length && !r.codeOnly.length && !withDrift.length && !r.unmatched.length) lines.push('no drift — the design and the code agree.');
  return lines.join('\n');
}

// ── the guide: how to author a design-backed journey ─────────────────────

/**
 * The recipe an agent (or a person) follows to make a feature walkable as
 * one journey — screens, code, APIs, rules and docs on one timeline. Served
 * verbatim by the MCP `design_guide` tool and `GET /api/design/guide`, and
 * mirrored in docs/GETTING-STARTED.md §6 so the three cannot drift apart.
 */
export function designGuide(): string {
  return `# Farsight — design-backed journeys (screens + code + APIs + docs on one timeline)

Goal: a business person and a developer walk the SAME journey for a feature — the screens the
business recognises (Figma frames or images), beside the code, API calls, gates and documents the
developer trusts. Everything below is derived: the manifest declares intent, the graph supplies the
code, and drift says where they disagree. Nothing is drawn by hand.

## 1 · Author docs/design/screens.json (or declare it in farsight.config.json → design)

{
  "name": "Acme — Phase 1 journeys",
  "figma": { "file": "https://www.figma.com/design/<fileKey>", "token": "env:FIGMA_TOKEN" },
  "screens": [
    { "id": "SCR-07", "name": "Quick submit", "route": "/submit",
      "url": "https://www.figma.com/design/<fileKey>?node-id=26-9",
      "image": "docs/design/scr-07.png",
      "operations": ["lookupContractorByVendorId", "createSubmission"],
      "phase": "1", "description": "No login: vendor lookup, upload with OCR confirm, submit." }
  ],
  "flows": [
    { "id": "contractor-validation", "name": "Vendor (contractor) validation",
      "description": "A contractor proves who they are before an invoice can be submitted.",
      "screens": ["SCR-06", "SCR-07", "SCR-08"],
      "docs": ["docs/product/vendor-validation.md", "docs/decisions/0021-contractor-email-sessions.md"],
      "operations": ["lookupContractorByVendorId", "verifyContractor"], "phase": "1",
      "requires": ["contractor-sign-in"], "leadsTo": ["invoice-tracking"] }
  ]
}

- "$schema": "https://farsight.dev/schemas/farsight-design.schema.json" at the top lets an editor validate and complete
  the manifest (schemas/farsight-design.schema.json; farsight.config.json has schemas/farsight-config.schema.json).
- screens[].route is the screen's identity: the page's route path, spelled any way
  (/track/[token] · /track/{token} · /track/:token). Use "component" for a screen that is not a page.
- screens[].operations: the operationIds (from the OpenAPI spec) the screen uses. Checked against the
  contracts now, and against what the built page actually reaches once it exists.
- screens[].image: a repo-relative PNG/JPG/SVG/WebP. With FIGMA_TOKEN set, a screen with a Figma
  node-id gets its frame rendered and cached automatically (freshness from Figma's lastModified).
  Without a token the deep link still works — nothing breaks, the chip says freshness is "manifest".
- flows[] name a FEATURE: an ordered list of screen ids, the documents that describe it (repo-relative
  paths open in the editor; URLs open as links), and the operations it spans. A flow is a journey entry.
- flows[].requires / flows[].leadsTo (flow ids) join journeys: what must happen before this one and what
  follows it. Farsight also derives the joins from a longer flow's screen order (a flow whose screens
  sit just before / after yours inside "Route 2b" is a prerequisite / what follows) — declare them when
  the order alone does not say it.
- flows[].owner: who answers for the flow (a team or a person); absent prints as an absence word, never
  a guess. flows[].work and screens[].work: work-item keys (Jira "KAN-3", Azure DevOps "AB#4711") the
  flow or screen is built for — a declared link the Work tab and the work_* tools join on.
- surfaces[]: { id, name, status?: "built" | "partly built" | "not started", description? } — the
  product surfaces the docs scope, drawn or not; a surface nobody has drawn yet is still a row.

## 1½ · Organise the journeys: who they are for, in groups, in your order

The front door, the Portfolio, the Map, GET /api/journeys, the MCP journeys tool and the CLI
(farsight journeys) all show the journeys as persona → group → journeys, in the order you declare:

{
  "personas": [
    { "id": "contractor", "name": "Contractor", "description": "A vendor who submits and tracks invoices." },
    { "id": "ops", "name": "Operations", "description": "The team that verifies vendors and approves invoices." }
  ],
  "groups": [
    { "id": "access", "name": "Access", "description": "Ways in and out." },
    { "id": "vendor-accounts", "name": "Vendor accounts", "persona": "contractor" },
    { "id": "invoices", "name": "Invoices" }
  ],
  "flows": [
    { "id": "contractor-sign-in", "name": "Sign in with email", "persona": "contractor", "group": "access", "order": 1, "screens": ["CON-01"] },
    { "id": "vendor-account-creation", "name": "Create a vendor account", "persona": ["contractor", "ops"], "group": "vendor-accounts", "screens": ["CON-03", "OPS-04"] }
  ]
}

- personas[] { id, name, description? } — in the order they are shown.
- groups[] { id, name, description?, persona? } — in the order they are shown inside a persona. A group
  with "persona" exists under that persona only; one without exists under every persona that has a
  journey in it (Access under Contractor and Access under Operations are two sections, one word).
- flows[].persona — a persona id or name, or a list of them: a journey for two kinds of person is
  shown under each and counted once. A value no personas[] entry declares is a persona of its own,
  after the declared ones, alphabetically — so "Contractor and Operations" written as one string is a
  third persona; write ["contractor", "ops"] instead. No persona: the shared prefix of the flow's
  screen ids stands in (marked derived), else the trailing "Not grouped".
- flows[].group — a group id or name; undeclared is a group of its own after the declared ones; none,
  or a group that belongs to another persona, puts the journey in the persona's "Other journeys".
- flows[].order — a number, ascending inside the group; flows without one follow, and ties keep the
  order the flows are written in the manifest (never alphabetical).
- Matching is by id, then by name, case-insensitive and trimmed. One persona per id across every
  manifest of a source (and across sources): the first manifest to declare it gives its words.
- The persona's way in ("start here") is computed: the first journey nothing requires that has
  something built and the most screens.

The same block in farsight.config.json organises across manifests without editing them:

{ "journeys": {
    "personas": [ { "id": "ops" }, { "id": "contractor" } ],
    "groups":   [ { "id": "access", "name": "Ways in" } ],
    "flows":    [ { "id": "vendor-account-creation", "group": "access", "order": 3 } ] } }

The config's arrays are the order; an entry overrides the manifest entry with the same id field by
field (only the fields it gives); ids it does not name follow in manifest order. flows[] here only
places flows a manifest declares — an id no manifest declares is a note (journeys tool, notes), never
a journey.

Several farsight.config.json files: any farsight.config.json below the source root applies to its
own folder only, and every path in it is relative to that folder (an NX app's
apps/web/farsight.config.json says "design": [{ "manifest": "docs/design/screens.json" }] for
apps/web/docs/design/screens.json); lists add up, the nearer file wins for a node under two, and a
conflict is reported, never silent. Its journeys block organises the manifests under its folder.
"projects" and "tooling" are read from the root file only. The config_files tool lists the files read.

## 1¾ · Storylines: one business thing, end to end, across journeys and personas

A journey is one feature a person moves through. A storyline chains journeys into the whole life of one
business thing — an invoice from upload to payment, a vendor from creation to approval to removal —
across features and across personas, in order:

{
  "storylines": [
    { "id": "invoice", "name": "An invoice, end to end", "description": "From the contractor's upload to the week it is paid.",
      "journeys": ["contractor-sign-in", "invoice-submission", "invoice-review", "invoice-paid",
        { "id": "invoice-correction", "branchOf": "invoice-review", "when": "the reviewer asks the contractor to correct it",
          "rejoins": "invoice-review" }] },
    { "id": "vendor", "name": "A vendor account", "journeys": ["vendor-account-creation", "vendor-account-review"] }
  ]
}

- storylines[] { id, name, description?, journeys } — in the order they are shown; journeys are flow
  ids, in order. A storyline may chain the flows of every manifest of its source (an NX workspace's
  root manifest chaining its apps' journeys); a journey may be a step of several storylines.
- An id no manifest declares is a note (journeys tool, notes), never a step; an id named twice is
  one step, the first. Storylines chain the journeys of one source (across sources is left open).
- The same "storylines" list in the farsight.config.json journeys block overrides by id, field by
  field (a journeys list it gives replaces the whole list); its order comes first, the root file's
  before a nested file's; a nested file's storyline steps only through the manifests under its folder.
- A branch is a journey a case takes only when a condition holds — a correction, a rejection, a
  hold — not a step every case goes through. Write it as an object in journeys: { id, branchOf,
  when, rejoins? } — branchOf a step of the same storyline (the one it leaves from), when the
  condition in words (required: a branch is never drawn without it), rejoins the step it comes back
  at (leave it out when the case leaves the storyline there). A bare { id } is a step like "id".
  Never declare a branch the design did not decide: Farsight draws it as written and does not guess
  one from the code. A branch whose parent is not a step, with no when, or naming a journey that
  is already a step is a note and is not drawn; a rejoins that is not a step is dropped with a note.
  The storyline's journey count includes its branches (a breakdown says how many steps and branches).
- Where they show: the Journeys front door's Storylines section (a branch indented under its step,
  with its condition), the Map's storyline picker (one band in storyline order, a "then" line from
  each journey to the next, a branch below the step it leaves from with its condition on the line and
  a dashed line back, #/map?storyline=<id>; an id nobody declares says so and lists the ones there
  are), fast travel (⌘K finds a storyline by name or id), the journey header's "storyline · step n
  of m" (or "branch of <journey> · when …") with the journeys before and after, GET /api/journeys
  (tree.storylines[].branches), the MCP journeys tool (storyline: <id>) and farsight journeys
  --storyline <id>.
- Swimlanes: the Map's LAYOUT control (chain · lanes, #/map?storyline=<id>&layout=lanes, the w key)
  draws a storyline as lanes of who acts. The lanes are derived: one per persona that owns a journey
  of it (a branch on its first persona other than its step's), one per store its code writes to
  (from the walk's write markers), the screens in step order as columns, the record's moves in the
  store lane in the order its lifecycle declares them, each naming the code that makes it. Name,
  order or add to them with two optional lists on the storyline (manifest or config, a list given
  in config replaces the manifest's):
    "lanes": [ { "id": "billing", "persona": "billing", "surface": "invoice portal" },
               { "id": "ledger", "store": "Invoice DB", "name": "Invoices" } ],
    "handoffs": [ { "from": "billing-cycle#2", "to": "ledger", "kind": "moves", "status": "open" },
                  { "from": "ledger", "to": "invoice-review#1", "kind": "seen", "status": "open",
                    "when": "the review queue shows it" } ]
  A lane is { id, persona | store, surface?, name? }; a hand-off { from, to, kind: moves | seen,
  status?, when? } whose ends are a lane (its id, a persona id or a store name) or a screen written
  <journey id>#<n>. Nothing is drawn that the graph cannot find: a persona with no journey here, a
  store the storyline does not write, a status nothing moves, a seen screen that does not read the
  record — each is a note on the lanes' footer (and a lane for an undeclared persona, or a hand-off
  naming a journey outside the storyline, a note at ingest). No walk says which status a screen
  branches on, so a "seen" arrow is drawn only from a hand-off you declare.

An agent manages all of this with its own file tools — Farsight never writes into a code source: edit
the manifest or the config, call refresh_graph, then journeys to check the result.

## 1⅞ · A record's statuses in your people's words (farsight.config.json → lifecycle)

The code decides which statuses a record has and what moves it between them (a SQL CHECK, a z.enum, a
string union, a const list; each write of the field). Config only names them, per persona:

"lifecycle": {
  "invoices": {
    "views": { "billing": { "Being drafted": ["draft"], "Sent": ["open"], "Void (ended)": ["void"] } },
    "overlays": [ { "name": "Needs changes", "table": "review_requests", "when": "an open row" } ]
  }
}

- The key is the record's node id or table name; views are keyed by persona id (or name), and each word
  lists the statuses, as the code spells them, that persona calls by it. A status the code does not
  declare, a record with no lifecycle, or an overlay table the graph lacks is a note (Settings → config
  files, MCP config_files), never a fact. A status with no word prints the constant in plain words.
- An overlay is a condition a person sees that is not a status — a row in another table. It is drawn as a
  row of its own kind, with the code that writes that table.
- A nested farsight.config.json names only records whose statuses are declared under its folder; the
  nearer file's word stands (a lifecycle conflict records the disagreement).
- Where it shows: the journey header's status lifecycle and the Map property's Overview print the words of
  the journey's persona (business: the word, the constant in the tip; hybrid: both; code: the constant),
  and "what each one means" opens one table — the word · in the code · what moves it — the writer a door
  to the journey screen it runs from (GET /api/lifecycle?node=&flow=). describe_node prints the words.

## 2 · What the graph does with it (no code needed yet)

- Each screen resolves to the page/component node the code adapter emitted, or becomes a page node
  with no source location: status "designed + built" · "designed, not built" · "built, not designed".
- Each flow becomes a \`flow\` node (an entry point) that renders its screens in order.
- Drift is computed once at ingest: designed-only, code-only, operation-not-in-spec,
  operation-unreached (built page never reaches an operation it lists), operation-undeclared,
  screen-unknown (a flow names a screen the manifest lacks).
- A journey from a flow, or from a designed-but-unbuilt screen, already runs: screen ⋯ planned call
  → route → planned gate (the spec's security) → receives / does / returns (planned steps from the
  contract). When the page ships, the same journey grows real steps and \`farsight diff\` reports
  planned → built.

## 3 · Make the code join the design (as you build)

- One page per screen row, at the route the row names (App Router: app/(public)/submit/page.tsx).
- Thin client functions per operation named by operationId, each one fetch() to the contract path —
  fetch→route stitching then turns "spec-only" into "both" and the screen appears as a consumer.
- JSDoc on pages/components: the design sentence first, then \`@design SCR-07\` (or the Figma URL),
  \`@see <url>\` for docs, \`@group <feature>\`. \`@guard\` on session/token resolvers, \`@entrypoint\` on
  jobs, \`// @business\` on the decisions the design cares about.
- Capability URLs OpenAPI cannot gate: farsight.config.json → guards: { "tracking token":
  ["GET /api/v1/track/{token}"] } declares the gate on the route.

## 4 · Verify as you go (MCP tools, same facts as the HUD)

1. graph_overview — flows and screens appear under entry points; the graph path names the workspace;
   the journeys line counts them by persona and group. journeys lists them in that order.
2. design_surface — every screen's status, image on file, Figma link, operations, drift; flows with
   "N of M screens built".
3. journey entry:"Vendor (contractor) validation" — the feature timeline: each screen (SCREEN band with
   images in the HUD), then the code / HTTP / route / gate / record steps under it, planned steps
   dashed. Add repo:/group: to keep it on topic.
4. api_surface / api_drift — the operations the flow spans flip from spec-only to both as handlers land.
5. design_drift — reconcile a proposed manifest before committing it: design_drift manifest:<path>.
6. describe_node <screen or flow id> — the design block (status, id, freshness, operations, docs).
7. CLI equivalents: farsight design list · farsight journeys [--persona p] · farsight design diff
   --manifest <path> --repo <name> --strict.

## 5 · How a journey is drawn (HUD) and printed (MCP) — the blueprint timeline

Every journey — from a flow, a screen, a route or a function — folds into the same blueprint
(journeySummary(), returned as \`summary\` by /api/journey and printed by the journey tool): one
horizontal timeline, one SEGMENT per screen, three lanes stacked inside every segment:

  WHAT THE USER SEES   the screen, as designed: image / Figma frame, the design chip (designed + built ·
                       designed, not built · built, not designed · freshness), ⧉ the page and component
                       code, ⧉ Open design, the documents.
  ─────────────────── line of visibility ───────────────────
  THE BUSINESS         the flowchart, in words: ▶ start, gate checkpoints (🔒, once per screen), the step
                       the person takes, decisions (⑂) with their arms, rules (⛨), ■ end.
  WHAT THE SYSTEM DOES a grid: one ROW PER SYSTEM in request order — what the screen asks (the repo's
                       browser half), the API by its spec title, what the service does (the repo's
                       server half), records, messages, a third party — by one COLUMN PER MOMENT of
                       the screen (a client-side action and everything it caused). A column reads down
                       as one transaction, a row reads across as one system's part in the screen.
                       Every call is a SEAM CARD on the API row: method, operation, summary, contract
                       status, and both ends of the HTTP boundary (← the fetch line, → the handler, or
                       "not built yet"); clicking it splices caller · contract · handler in place.
                       Markers are dashed when declared, not built, ↺ when the walk already ran them,
                       ▸ when they are a helper inside their handler. A "rows | ladder" toggle (key l)
                       turns a segment on its side: systems as columns, time running down, one line
                       per step.
  LINKED JOURNEYS      ◀ what must happen before (requires) · what follows ▶ (leadsTo) · what this is
                       part of — declared in the manifest or derived from a longer flow's screen order.

## 6 · What a "Portfolio feature" is, in this model

A feature = a flow: its screens (designed vs built), the operations it spans (declared vs implemented
vs consumed), the gates on them, the records they touch, the documents that describe it. All of that is
one journey from the flow node — HUD: Journeys tab → Designs → the flow → Run journey; MCP: journey
entry:<flow name>. Counts on the design source (designed / built / not built / drift) are the
feature's progress, derived from the same nodes.`;
}
