/**
 * Merge-time stitching across sources (V3 build plan §2.5, step 1 — pulled
 * forward for the APIs surface, scoped to HTTP). Adapters leave an
 * unresolved `fetch('/x')` pointing at an `unknown` stub (`repo::unknown::GET
 * /x`) instead of dropping it; once every fragment is in the store, this pass
 * re-points those edges at a route any other source declares — code or
 * spec — and removes stubs nothing references any more.
 *
 * Confidence is honest: a cross-source match is path-only (no host check),
 * so it is stamped `fetch→route · MEDIUM`; same-fragment matches made by the
 * adapter stay HIGH. A path served by more than one source is left
 * unresolved with the candidates listed — guessing would be worse.
 */
import type { GraphNode, GraphEdge } from './graph.js';
import type { GraphStore } from './store.js';
import { normalizeRoutePath } from './openapi.js';

export interface StitchReport {
  resolved: number;
  ambiguous: number;
  unresolved: number;
}

function methodPath(name: string): { method: string; path: string } | null {
  const m = name.match(/^([A-Z]+) (\S.*)$/);
  return m ? { method: m[1]!, path: m[2]! } : null;
}

export function stitchHttp(store: GraphStore): StitchReport {
  const nodes = store.allNodes();
  // route key → route ids, including spec base-path aliases (`/v1` + `/x`)
  const routesByKey = new Map<string, string[]>();
  const add = (key: string, id: string) => routesByKey.set(key, [...(routesByKey.get(key) ?? []), id]);
  for (const n of nodes) {
    if (n.kind !== 'route') continue;
    const mp = methodPath(n.name);
    if (!mp) continue;
    add(`${mp.method} ${normalizeRoutePath(mp.path)}`, n.id);
    for (const base of n.contract?.servers ?? []) add(`${mp.method} ${normalizeRoutePath(base + mp.path)}`, n.id);
  }

  const report: StitchReport = { resolved: 0, ambiguous: 0, unresolved: 0 };
  const stubIds = new Set(nodes.filter((n) => n.kind === 'unknown').map((n) => n.id));
  if (!stubIds.size) return report;

  for (const e of store.allEdges()) {
    if (e.kind !== 'http' || !stubIds.has(e.to)) continue;
    const stub = store.nodeById(e.to) as GraphNode | undefined;
    const mp = stub ? methodPath(stub.name) : null;
    if (!mp) { report.unresolved++; continue; }
    const norm = normalizeRoutePath(mp.path);
    // `fetch(\`${base}/healthz\`)` leaves a templated host as a leading `:param` — treat it as a host wildcard
    const hostless = norm.startsWith(':param/') ? norm.slice(':param'.length) : null;
    const candidates = [...new Set([...(routesByKey.get(`${mp.method} ${norm}`) ?? []), ...(hostless ? routesByKey.get(`${mp.method} ${hostless}`) ?? [] : [])])];
    if (candidates.length === 1) {
      const target = candidates[0]!;
      const sameRepo = target.split('::')[0] === e.from.split('::')[0];
      const stitched: GraphEdge = {
        ...e,
        to: target,
        resolution: {
          status: 'resolved',
          technique: 'fetch→route',
          confidence: sameRepo ? 'HIGH' : 'MEDIUM',
          note: sameRepo ? 'method + path match' : 'method + path match across sources (host not checked)',
        },
      };
      store.replaceEdge(e.id, stitched);
      report.resolved++;
    } else if (candidates.length > 1) {
      store.replaceEdge(e.id, { ...e, resolution: { status: 'unresolved', technique: 'fetch→route', confidence: 'LOW', candidates, note: 'more than one source serves this path' } });
      report.ambiguous++;
    } else {
      report.unresolved++;
    }
  }
  // drop stubs nothing points at any more
  const stillReferenced = new Set(store.allEdges().map((e) => e.to));
  for (const id of stubIds) if (!stillReferenced.has(id)) store.removeNode(id);
  return report;
}
