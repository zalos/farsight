// Placing a finding on the application (PR 19, ADR 38) through Farsight's own cached core folds over the pinned
// context: `flowWalks` (each journey's and screen's node sets), `impactOf` + `affectedReach` (who depends on a node,
// placed on journeys), `personaOfScreen` (who uses a screen, with where that came from). A screen whose walk contains
// the finding's symbol uses it directly; a screen reached only through dependents may be affected. Screens are
// deduplicated across journeys, overlapping personas are kept, and bounds are explicit. Reachability is navigation
// evidence, never proof of exploitation. Both registers come from the same fold.
import { buildIndex, type GraphIndex } from '@farsight/core/dist/query.js';
import { affectedReach, flowWalks } from '@farsight/core/dist/affected.js';
import { impactOf } from '@farsight/core/dist/impact.js';
import { personaOfScreen } from '@farsight/core/dist/journeys.js';
import type { FindingPlace, ReportCount } from '../contracts/index.js';
import { PROJECTION_VERSION, type PinnedContext, type PlaceReason } from './context.js';

const MAX = { nodeIds: 256, screens: 512, journeys: 512, personas: 64 } as const;
const SOURCE = 'sentinel place fold draft-1';
const indexes = new WeakMap<object, GraphIndex>();

function indexOf(ctx: PinnedContext): GraphIndex {
  const g = ctx.graph!;
  let ix = indexes.get(g);
  if (!ix) indexes.set(g, ix = buildIndex(g.nodes as never, g.edges as never));
  return ix;
}

const count = (n: number, unit: string, of?: number, breakdown?: ReportCount['breakdown']): ReportCount => ({
  n, unit, scope: 'sentinel.scope.finding', source: SOURCE, ...(of !== undefined && of > n ? { of } : {}), ...(breakdown?.length ? { breakdown } : {}),
});

/** An empty place: nothing is placed, and why. */
export function unplaced(binding: FindingPlace['binding'], reasons: readonly string[], ctx?: PinnedContext): FindingPlace {
  return {
    binding: binding === 'matched' ? 'unavailable' : binding,
    ...(ctx?.artifact && binding !== 'unavailable' ? { context: { artifact: ctx.artifact.id, sourceBindingReceipt: ctx.receipt.id, projectionVersion: PROJECTION_VERSION } } : {}),
    nodeIds: [], screens: [], journeys: [], personas: [],
    counts: { screens: count(0, 'sentinel.count.screens'), journeys: count(0, 'count.unit.journeys'), personas: count(0, 'count.unit.personas') },
    limitationKeys: [...new Set(reasons)].sort().slice(0, 32),
  };
}

/** Places canonical node ids (the parser's, under the snapshot source id) on the pinned context. */
export function placeNodes(ctx: PinnedContext | undefined, nodeIds: readonly string[], options: { hops?: number } = {}): FindingPlace {
  if (!ctx) return unplaced('unavailable', ['sentinel.place.noContext']);
  if (ctx.binding !== 'matched' || !ctx.graph || !ctx.artifact) return unplaced(ctx.binding, ctx.reasons, ctx);
  const limitations = new Set<PlaceReason>();
  if (!nodeIds.length) return { ...unplaced('unavailable', ['sentinel.place.noAnchorSymbol'], ctx), binding: 'matched', context: contextOf(ctx) };
  const index = indexOf(ctx);
  // Parser ids use the snapshot source id; the context graph uses its repository name for the same source.
  const toContext = (id: string) => (id.startsWith(`${ctx.sourceId}::`) ? `${ctx.repo}::${id.slice(ctx.sourceId.length + 2)}` : id);
  const ids = [...new Set(nodeIds.map(toContext))].sort();
  const present = ids.filter(id => index.byId.has(id));
  if (present.length < ids.length) limitations.add('sentinel.place.nodeNotInContext');
  const walks = flowWalks(index);
  type Hit = { flowId: string; via: 'direct-use' | 'potential-impact' };
  const screens = new Map<string, { name: string; hits: Hit[] }>();
  const add = (screenId: string, name: string, flowId: string, via: Hit['via']) => {
    const s = screens.get(screenId) ?? { name, hits: [] };
    s.hits.push({ flowId, via });
    screens.set(screenId, s);
  };
  for (const f of walks) for (const s of f.screens) if (present.some(id => s.nodes.has(id))) add(s.screenId, s.name, f.id, 'direct-use');
  for (const id of present) {
    const reach = affectedReach(index, impactOf(index, id, { hops: options.hops ?? 2 }));
    for (const s of reach.screens) if (s.hop > 0) add(s.screenId, s.name, s.flowId, 'potential-impact');
  }
  if (present.length && !screens.size) limitations.add('sentinel.place.notOnScreen');
  const artifact = ctx.artifact.id;
  const label = (id: string, name?: string) => {
    const n = index.byId.get(id) as { name?: string; design?: { id?: string } } | undefined;
    const business = (name ?? n?.name ?? id).slice(0, 4000);
    return { business, code: (n?.design?.id ? `${n.design.id} ${id}` : id).slice(0, 4000) };
  };
  const placed = [...screens.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, s]) => ({
    id, label: label(id, s.name), via: s.hits.some(h => h.via === 'direct-use') ? 'direct-use' as const : 'potential-impact' as const,
    evidenceArtifact: artifact, flows: [...new Set(s.hits.map(h => h.flowId))].sort(),
  }));
  const journeyMap = new Map<string, Set<string>>();
  for (const s of placed) for (const f of s.flows) journeyMap.set(f, (journeyMap.get(f) ?? new Set()).add(s.id));
  const metas = (ctx.graph.meta?.journeys ?? undefined) as Parameters<typeof personaOfScreen>[1];
  const personas = new Map<string, { label: { business: string; code: string }; screenIds: Set<string>; declared: boolean }>();
  for (const s of placed) {
    for (const f of s.flows) {
      const p = personaOfScreen(index, metas, s.id, f);
      if (!p) continue;
      const had = personas.get(p.persona) ?? { label: { business: (p.personaName ?? p.persona).slice(0, 4000), code: `${p.persona} (${p.personaFrom})`.slice(0, 4000) }, screenIds: new Set<string>(), declared: p.declared };
      had.screenIds.add(s.id);
      personas.set(p.persona, had);
    }
  }
  const allScreens = placed.length, allJourneys = journeyMap.size, allPersonas = personas.size;
  if (allScreens > MAX.screens || allJourneys > MAX.journeys || allPersonas > MAX.personas || ids.length > MAX.nodeIds) limitations.add('sentinel.place.truncated');
  const shown = placed.slice(0, MAX.screens);
  const shownIds = new Set(shown.map(s => s.id));
  const journeys = [...journeyMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, MAX.journeys).map(([id, set]) => ({
    id, label: label(id), screenIds: [...set].filter(s => shownIds.has(s)).sort(),
  }));
  const personaRows = [...personas.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, MAX.personas).map(([id, p]) => ({
    id, label: p.label, screenIds: [...p.screenIds].filter(s => shownIds.has(s)).sort(), declared: p.declared, evidenceArtifact: artifact,
  }));
  const direct = shown.filter(s => s.via === 'direct-use').length;
  return {
    binding: 'matched', context: contextOf(ctx),
    nodeIds: ids.slice(0, MAX.nodeIds),
    screens: shown.map(({ flows: _f, ...s }) => s),
    journeys, personas: personaRows,
    counts: {
      screens: count(shown.length, 'sentinel.count.screens', allScreens, [
        ...(direct ? [{ key: 'sentinel.count.part.directUse', n: direct }] : []),
        ...(shown.length - direct ? [{ key: 'sentinel.count.part.potentialImpact', n: shown.length - direct }] : []),
      ]),
      journeys: count(journeys.length, 'count.unit.journeys', allJourneys),
      personas: count(personaRows.length, 'count.unit.personas', allPersonas),
    },
    limitationKeys: [...limitations].sort(),
  };
}

function contextOf(ctx: PinnedContext): NonNullable<FindingPlace['context']> {
  return { artifact: ctx.artifact!.id, sourceBindingReceipt: ctx.receipt.id, projectionVersion: PROJECTION_VERSION };
}
