// A hand-edited copy of a captured map fixture in the shapes docs/proposals/data-stores.md §3 names, shared by
// the map model and property tests. Not a test file itself (no `.test.ts`).
// The captured answers (map-billing-cycle-stores.json, map-billing-cycle-erp.json) cover the store and the ERP's
// reads and writes; a third party reached with no direction recorded on its own call is a shape no capture has, so
// these tests also carry a hand-edited copy in the proposal's shapes: the tables live in `Invoice DB` (config), the ERP is a store-like external written on
// finalize, and the list read reaches it once with no method recorded.
export type AnyRec = Record<string, any>;
export function withStores(src: AnyRec): { journey: AnyRec; nodes: AnyRec[] } {
  const c = JSON.parse(JSON.stringify(src));
  const db = { name: 'Invoice DB', kind: 'sql', engine: 'postgres', via: 'config', ref: 'stores[0]' };
  for (const n of c.nodes) if (n.kind === 'table') n.store = db;
  let erp = c.nodes.find((n: AnyRec) => n.id === 'invoice-app::external::Example ERP');
  if (!erp) {
    erp = { id: 'invoice-app::external::Example ERP', kind: 'external', name: 'Example ERP', tags: ['external', 'erp'], external: { kind: 'erp', source: 'config', via: 'ErpClient', ref: 'ERP_HOST' } };
    c.nodes.push(erp);
  }
  erp.store = { name: 'Example ERP', kind: 'erp', via: 'config', ref: 'ERP_HOST' };
  erp.external = { ...(erp.external || { kind: 'erp' }), store: true };
  const seg = c.journey.summary.segments[1];
  for (const s of c.journey.summary.segments) for (const m of s.markers || []) if (m.kind === 'record') m.store = { name: 'Invoice DB', kind: 'sql' };
  const ext = (stepOrder: number, under: number, moment: number, op?: string) => ({
    stepOrder, depth: 7, nodeId: erp.id, name: 'Example ERP', kind: 'external', via: 'calls',
    system: 'external:Example ERP', moment, under, tier: 0, store: { name: 'Example ERP', kind: 'erp' }, ...(op ? { op } : {}),
  });
  seg.markers.push(ext(15.5, 14, 0), ext(42.5, 36, 4), ext(42.6, 36, 4, 'writes'));
  return c;
}
