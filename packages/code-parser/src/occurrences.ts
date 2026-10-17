import { occurrenceId, mergeOccurrences, type EdgeOccurrence, type GraphEdge } from '@farsight/graph';

export interface SyntaxSite {
  start: number;
  end: number;
  col: number;
  conditions?: string[];
}

/** Capture before relationship deduplication; add evidence without adding relationship edges. */
export class OccurrenceCollector {
  private readonly facts = new Map<string, EdgeOccurrence[]>();
  private key(edge: Pick<GraphEdge, 'kind' | 'from' | 'to' | 'meta'>): string {
    return `${edge.kind}|${edge.from}|${edge.to}|${edge.meta?.whenRef ?? ''}`;
  }

  record(edge: Pick<GraphEdge, 'kind' | 'from' | 'to' | 'meta'>, repo: string, path: string,
    line: number | undefined, site?: SyntaxSite): void {
    if (!site || !line || line < 1) return;
    const value: Omit<EdgeOccurrence, 'id'> = {
      loc: { repo, path: path.replaceAll('\\', '/'), line, col: site.col },
      span: { start: site.start, end: site.end },
      ...(site.conditions?.length ? { conditions: site.conditions } : {}),
      ...(edge.meta ? { meta: { ...edge.meta } } : {}),
    };
    const key = this.key(edge);
    const facts = this.facts.get(key) ?? [];
    facts.push({ id: occurrenceId(edge, value), ...value });
    this.facts.set(key, facts);
  }

  attach(edges: GraphEdge[]): void {
    for (const edge of edges) {
      const facts = this.facts.get(this.key(edge));
      if (!facts) continue;
      edge.occurrences = mergeOccurrences(edge.occurrences, facts.map(site => ({ ...site,
        ...(edge.resolution ? { resolution: { ...edge.resolution } } : {}),
      })));
    }
  }
}
