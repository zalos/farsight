// Data stores on the map (docs/proposals/data-stores.md), shaped over the fixture's own answers with page.route
// (ADR 8, the suite's fault pattern) for what the fixture's answer does not carry. The tables' store comes from the
// fixture config (Invoice DB, via config) and the stub leaves it alone; the ERP used as a store is not reached by
// Billing cycle (calling it would add a sixth system to the pinned journey), so the stub adds it — written on
// finalize, and reached on the list read with no method recorded. Every addition is skipped when the real answer
// already carries it.
import type { Page } from '@playwright/test';

export const ERP_ID = 'invoice-app::external::Example ERP';
export const DB = { name: 'Invoice DB', kind: 'sql', engine: 'postgres', via: 'config', ref: 'stores[0]' };
const ERP_STORE = { name: 'Example ERP', kind: 'erp', via: 'config', ref: 'ERP_HOST' };

type AnyRec = Record<string, any>;

export async function stubStores(page: Page) {
  // a disposed response means the page moved on; the stub steps aside rather than fail the test at teardown
  await page.route(/\/graph$/, async (r) => {
    let g: AnyRec;
    try { g = await (await r.fetch()).json(); } catch { return; }
    for (const n of g.nodes) {
      if (n.kind === 'table' && n.id.startsWith('invoice-app::table::')) n.store = n.store || DB;
      if (n.id === ERP_ID) { n.store = n.store || ERP_STORE; n.external = { ...(n.external || { kind: 'erp' }), store: true }; }
    }
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(g) });
  });
  await page.route(/\/api\/journey\?entry=invoice-app(%3A%3A|::)flow(%3A%3A|::)billing-cycle$/, async (r) => {
    let d: AnyRec;
    try { d = await (await r.fetch()).json(); } catch { return; }
    for (const s of d.summary.segments) for (const m of s.markers || []) if (m.kind === 'record' && !m.store) m.store = { name: DB.name, kind: DB.kind };
    const seg = d.summary.segments[1];
    const calls = (seg.markers as AnyRec[]).filter((m) => m.kind === 'call');
    const list = calls.find((m) => m.name === 'GET /invoices');
    const fin = calls.find((m) => String(m.name).endsWith('/finalize'));
    const has = (under: number) => (seg.markers as AnyRec[]).some((m) => m.nodeId === ERP_ID && m.under === under);
    const ext = (call: AnyRec, op?: string) => ({
      stepOrder: call.stepOrder + 0.5, depth: (call.depth || 4) + 1, nodeId: ERP_ID, name: 'Example ERP', kind: 'external', via: 'calls',
      system: 'external:Example ERP', moment: call.moment, under: call.stepOrder, tier: 0, store: { name: ERP_STORE.name, kind: ERP_STORE.kind }, ...(op ? { op } : {}),
    });
    if (list && !has(list.stepOrder)) seg.markers.push(ext(list));
    if (fin && !has(fin.stepOrder)) seg.markers.push(ext(fin, 'writes'));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
}
