// Edge resolution: the techniques the adapters already knew and did not record
// (B5.1, docs/proposals/dependency-impact.md §3.4). Each test pins one technique
// to the fact that earns it, and the last one pins the abstentions: an edge the
// adapter cannot characterise stays unstamped rather than borrowing a tier.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import type { GraphEdge, GraphFragment } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-res-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** every edge of a kind whose endpoints' names match, with the resolution as a flat string */
function edgesOf(g: GraphFragment, kind: GraphEdge['kind']) {
  const name = (id: string) => g.nodes.find((n) => n.id === id)?.name ?? id;
  return g.edges.filter((e) => e.kind === kind).map((e) => ({
    from: name(e.from), to: name(e.to), via: e.meta?.via, deferred: e.meta?.deferred,
    res: e.resolution ? `${e.resolution.technique}/${e.resolution.confidence}` : null,
  }));
}

test('raw SQL reads and writes are stamped raw-sql; a builder chain is db-builder', async () => {
  const dir = tempRepo({
    'src/migrate.ts': 'export const SCHEMA = `CREATE TABLE invoices (id uuid PRIMARY KEY, total_cents bigint);`;\n',
    'src/repo.ts': `
export async function listInvoices(db: any) {
  return db.query('SELECT id FROM invoices WHERE status = $1', ['DRAFT']);
}
export async function insertInvoice(db: any) {
  return db.query(\`INSERT INTO invoices (id) VALUES ($1)\`, ['x']);
}
export async function countDrafts(db: any) {
  return db.invoices.findMany({ where: { status: 'DRAFT' } });
}
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const reads = edgesOf(g, 'reads');
  const writes = edgesOf(g, 'writes');
  // the SELECT and the INSERT both named their table out of the statement text
  assert.equal(reads.find((e) => e.from === 'listInvoices' && e.to === 'invoices')?.res, 'raw-sql/HIGH');
  assert.equal(writes.find((e) => e.from === 'insertInvoice' && e.to === 'invoices')?.res, 'raw-sql/HIGH');
  // the builder chain named it structurally instead
  assert.equal(reads.find((e) => e.from === 'countDrafts' && e.to === 'invoices')?.res, 'db-builder/HIGH');
  // raw-sql says in the open that it is a text parse; db-builder resolved a chain
  const raw = g.edges.find((e) => e.kind === 'writes' && e.resolution?.technique === 'raw-sql')!;
  assert.equal(raw.resolution!.status, 'heuristic');
  assert.equal(g.edges.find((e) => e.resolution?.technique === 'db-builder')!.resolution!.status, 'resolved');
});

test('a call keeps the route its name took: same-file for a sibling and this.x(), static-import across files', async () => {
  const dir = tempRepo({
    'src/helpers.ts': 'export function sanitize(s: string) { return s.trim(); }\n',
    'src/service.ts': `
import { sanitize } from './helpers.js';
function local(x: string) { return x; }
export class InvoiceService {
  submit(x: string) { return this.check(sanitize(local(x))); }
  check(x: string) { return x.length > 0; }
}
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const calls = edgesOf(g, 'calls');
  assert.equal(calls.find((e) => e.from === 'InvoiceService.submit' && e.to === 'local')?.res, 'same-file/HIGH');
  assert.equal(calls.find((e) => e.from === 'InvoiceService.submit' && e.to === 'InvoiceService.check')?.res, 'same-file/HIGH');
  assert.equal(calls.find((e) => e.from === 'InvoiceService.submit' && e.to === 'sanitize')?.res, 'static-import/HIGH');
});

test('a declared @guard gates by annotation; the call that also runs it keeps the symbol route', async () => {
  const dir = tempRepo({
    'src/guards.ts': `
/** @guard submit readiness */
export function assertReady(x: number) { if (x < 1) throw new Error('no'); return x; }
`,
    'src/route.ts': `
import { assertReady } from './guards.js';
export function submit(x: number) { return assertReady(x); }
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const guards = edgesOf(g, 'guards');
  const gate = guards.find((e) => e.to === 'submit')!;
  // the edge is a *gate* because a developer said so — not because the import resolved
  assert.equal(gate.res, 'annotation-scan/HIGH');
  assert.match(g.edges.find((e) => e.kind === 'guards')!.resolution!.note!, /@guard/);
  // the same guard has a body, so it is also run: that edge is an ordinary resolved call
  const run = edgesOf(g, 'calls').find((e) => e.from === 'submit' && e.via === 'guard')!;
  assert.equal(run.res, 'static-import/HIGH');
});

test('a middleware nobody declared is detected by its shape, at MEDIUM', async () => {
  const dir = tempRepo({
    'src/api.ts': `
import express from 'express';
const app = express();
app.get('/invoices', requireScope('billing:read'), (req: any, res: any) => res.json([]));
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const gate = g.edges.find((e) => e.kind === 'guards')!;
  assert.equal(gate.resolution!.technique, 'detected');
  assert.equal(gate.resolution!.confidence, 'MEDIUM');
  assert.equal(gate.resolution!.status, 'heuristic');
  // and it says what it matched on, so the reader can disagree with it
  assert.match(gate.resolution!.note!, /nobody declared it a guard/);
});

test('a middleware.ts file guards by convention, and the stamp says the matcher was not read', async () => {
  const dir = tempRepo({
    'middleware.ts': 'export function middleware(req: Request) { return req; }\n',
    'app/invoices/page.tsx': 'export default function InvoicesPage() { return <main>invoices</main>; }\n',
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const gate = g.edges.find((e) => e.kind === 'guards')!;
  assert.equal(gate.resolution!.technique, 'detected');
  assert.equal(gate.resolution!.confidence, 'MEDIUM');
  assert.match(gate.resolution!.note!, /matcher is not read/);
});

test('a JSX child is jsx-render; a router entry naming a component is not', async () => {
  const dir = tempRepo({
    'src/InvoiceRow.tsx': 'export function InvoiceRow() { return <li>row</li>; }\n',
    'src/InvoiceList.tsx': `
import { InvoiceRow } from './InvoiceRow';
export function InvoiceList() { return <ul><InvoiceRow /></ul>; }
`,
    'src/routes.tsx': `
import { InvoiceList } from './InvoiceList';
export const routes = [{ path: '/invoices', component: InvoiceList }];
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const renders = edgesOf(g, 'renders');
  assert.equal(renders.find((e) => e.from === 'InvoiceList' && e.to === 'InvoiceRow')?.res, 'jsx-render/HIGH');
  // the page node's component came from a route configuration, not from a tree the
  // caller writes: no technique names that, so it records nothing rather than borrow one
  assert.equal(renders.find((e) => e.from === '/invoices' && e.to === 'InvoiceList')?.res, null);
});

test('records nothing stays its own state: the abstentions this chunk refuses to stamp', async () => {
  const dir = tempRepo({
    'src/container.ts': `
export function buildContainer() {
  return { hooks: { invoiceCreated: async () => { await notify(); } } };
}
export async function notify() { return 1; }
`,
    'src/guards.ts': '/** @guard signed in */\nexport function requireUser(x: number) { if (!x) throw new Error("no"); return x; }\n',
    'src/handler.ts': `
import { requireUser } from './guards.js';
export function createInvoice(x: number) { return requireUser(x); }
`,
    'src/api.ts': `
import express from 'express';
import { createInvoice } from './handler.js';
const app = express();
app.post('/invoices', createInvoice);
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  // 1. the host → callback edge: the callee is a function literal written in place,
  //    which no technique names (recorded as a deliberate absence in chunk A1.3)
  const cb = edgesOf(g, 'calls').find((e) => e.deferred === true)!;
  assert.ok(cb, 'the container binds a hook');
  assert.equal(cb.res, null);
  // 2. the gate a route inherits from its named handler: a second-order edge about a
  //    different pair of nodes, so the handler's own technique is not copied onto it
  const mirrored = edgesOf(g, 'guards').find((e) => e.via === 'handler')!;
  assert.ok(mirrored, 'the route inherits the handler gate');
  assert.equal(mirrored.res, null);
  // and the edge it was derived from is stamped, so the absence is a choice, not a gap
  assert.equal(edgesOf(g, 'guards').find((e) => e.to === 'createInvoice')?.res, 'annotation-scan/HIGH');
});

test('the Java adapter records what its annotations and field types already told it', async () => {
  const dir = tempRepo({
    'src/main/java/app/Invoice.java': `
package app;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
@Entity
public class Invoice {
  @Id private String id;
  private String status;
}
`,
    'src/main/java/app/InvoiceRepository.java': `
package app;
import org.springframework.data.jpa.repository.JpaRepository;
public interface InvoiceRepository extends JpaRepository<Invoice, String> {}
`,
    'src/main/java/app/InvoiceController.java': `
package app;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
@RestController
@RequestMapping("/invoices")
public class InvoiceController {
  private final InvoiceRepository repo;
  public InvoiceController(InvoiceRepository repo) { this.repo = repo; }

  @PostMapping("/{id}/submit")
  @PreAuthorize("hasRole('BILLING')")
  public String submit(@PathVariable String id) {
    audit(id);
    return repo.save(new Invoice()).toString();
  }

  private void audit(String id) { }
}
`,
  });
  const g = await ingestRepo(dir, { repo: 'r' });
  const calls = edgesOf(g, 'calls');
  // a method of this very type
  assert.equal(calls.find((e) => e.from === 'InvoiceController.submit' && e.to === 'InvoiceController.audit')?.res, 'same-file/HIGH');
  // the mapping annotation is why the route reaches the handler at all
  assert.equal(calls.find((e) => e.to === 'InvoiceController.submit')?.res, 'annotation-scan/HIGH');
  // @PreAuthorize is the gate
  assert.equal(edgesOf(g, 'guards')[0]?.res, 'annotation-scan/HIGH');
  // an inherited repository op names its table through the entity the repo is typed on
  assert.equal(edgesOf(g, 'writes').find((e) => e.to === 'invoice')?.res, 'db-builder/HIGH');
});
