import type { GraphFragment } from './graph.js';

/** The portable form excludes the checkout's mtime-based sourceHash. */
export type PortableGraph = Omit<GraphFragment, 'meta'> & {
  meta?: Omit<NonNullable<GraphFragment['meta']>, 'sourceHash'>;
};

export interface GraphDocument {
  format: 'farsight-graph';
  schemaVersion: 1;
  graph: PortableGraph;
  /** Named source set and its portable enrichment, when exporting a merged application graph. */
  sources?: GraphSource[];
}

export interface GraphSource {
  repo: string;
  meta?: Partial<NonNullable<PortableGraph['meta']>>;
}
