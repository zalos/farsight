// Classes, raw SQL and queue clients in the TS adapter: a data layer written as
// classes over `pg` with SQL strings (no ORM) still yields tables with columns,
// reads / writes from the methods that run the statements, method-name call
// resolution from services into the production repository (its in-memory twin
// set aside) and publishes / consumes on the queue a worker binds by constant.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlTables, sqlOps } from '../dist/shared/sql.js';
import { ingestRepo } from '../dist/index.js';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-sql-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('sqlTables: CREATE TABLE with constraints yields the table and its column names', () => {
  const t = sqlTables(`
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY,
  contractor_id uuid NOT NULL REFERENCES contractors(id),
  status text NOT NULL CHECK (status IN ('DRAFT','SUBMITTED')),
  total_cents bigint,
  CONSTRAINT invoices_number_unique UNIQUE (contractor_id, invoice_number),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (status);
CREATE TABLE "public"."invoice_lines" (id uuid PRIMARY KEY, invoice_id uuid, amount int);`);
  assert.deepEqual(t.map((x) => x.name), ['invoices', 'invoice_lines']);
  assert.deepEqual(t[0]!.columns, ['id', 'contractor_id', 'status', 'total_cents', 'created_at']);
  assert.deepEqual(t[1]!.columns, ['id', 'invoice_id', 'amount']);
});

test('sqlOps: reads from FROM / JOIN, writes from INSERT / UPDATE / DELETE, CTEs are not tables, prose is not SQL', () => {
  assert.deepEqual(sqlOps('SELECT c.* FROM contact_vendor_links l JOIN contractors c ON c.id = l.contractor_id WHERE l.contact_id = $1'),
    [{ table: 'contact_vendor_links', op: 'select', write: false }, { table: 'contractors', op: 'select', write: false }]);
  assert.deepEqual(sqlOps('INSERT INTO audit_events (id, kind) VALUES ($1, $2) RETURNING *'), [{ table: 'audit_events', op: 'insert', write: true }]);
  assert.deepEqual(sqlOps('UPDATE invoices SET status = $2, updated_at = now() WHERE id = $1 RETURNING *'), [{ table: 'invoices', op: 'update', write: true }]);
  assert.deepEqual(sqlOps('DELETE FROM invoice_lines WHERE invoice_id = $1'), [{ table: 'invoice_lines', op: 'delete', write: true }]);
  assert.deepEqual(sqlOps('WITH due AS (SELECT id FROM bc_outbox WHERE status = $1) UPDATE bc_outbox o SET status = $2 FROM due WHERE o.id = due.id'),
    [{ table: 'bc_outbox', op: 'update', write: true }, { table: 'bc_outbox', op: 'select', write: false }]);
  assert.deepEqual(sqlOps('No such tracking link.'), []);
});

test('sqlOps: an English sentence that starts with a keyword is filtered by the caller shape, not here', () => {
  // the adapter only feeds template/string literals inside functions; a prose
  // literal that happens to start with "select" would read `the` as a table —
  // acceptable noise, documented rather than hidden
  assert.deepEqual(sqlOps('select the account from the list').map((o) => o.table), ['the']);
});

test('ingest: class methods, SQL reads/writes on CREATE TABLE tables, method-name calls, queue publishes/consumes', async () => {
  const dir = tempRepo({
    'package.json': '{"name":"sqlrepo"}',
    'src/migrations.ts': [
      'export const MIGRATION = `',
      'CREATE TABLE IF NOT EXISTS invoices (',
      '  id uuid PRIMARY KEY,',
      '  status text NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS audit_events (id uuid PRIMARY KEY, kind text);',
      '`;',
    ].join('\n'),
    'src/repos/pg.ts': [
      '/**',
      ' * Postgres repositories.',
      ' * @group data',
      ' */',
      'export class PgInvoiceRepository {',
      '  constructor(private readonly q: { query: (s: string, p?: unknown[]) => Promise<any> }) {}',
      '  /** @business Saves a new invoice draft. */',
      '  async createDraft(input: { id: string }) {',
      '    const res = await this.q.query(`INSERT INTO invoices (id, status) VALUES ($1, $2) RETURNING *`, [input.id, "DRAFT"]);',
      '    await this.audit(input.id);',
      '    return res.rows[0];',
      '  }',
      '  async getById(id: string) {',
      "    const res = await this.q.query('SELECT * FROM invoices WHERE id = $1', [id]);",
      '    return res.rows[0] ?? null;',
      '  }',
      '  private async audit(id: string) {',
      '    await this.q.query(`INSERT INTO audit_events (id, kind) VALUES ($1, $2)`, [id, "invoice.created"]);',
      '  }',
      '}',
    ].join('\n'),
    'src/repos/in-memory.ts': [
      'export class InMemoryInvoiceRepository {',
      '  rows: any[] = [];',
      '  async createDraft(input: { id: string }) { this.rows.push(input); return input; }',
      '  async getById(id: string) { return this.rows.find((r) => r.id === id) ?? null; }',
      '}',
    ].join('\n'),
    'src/service.ts': [
      'export async function submitInvoice(repos: { invoices: { createDraft: (i: any) => Promise<any> } }, id: string) {',
      '  const draft = await repos.invoices.createDraft({ id });',
      '  return draft;',
      '}',
      '/**',
      ' * Submits a draft: readiness first, then the transaction.',
      ' * @guard submit readiness',
      ' */',
      'export async function submitDraft(q: { query: (s: string) => Promise<any> }, id: string) {',
      '  await q.query(`UPDATE invoices SET status = $2 WHERE id = $1`);',
      '  await q.query(`INSERT INTO tracking_tokens (id) VALUES ($1)`);',
      '}',
      'export async function POST(q: any, id: string) { return submitDraft(q, id); }',
    ].join('\n'),
    'src/config.ts': "export const QUEUE_DOCUMENTS = 'q-documents';",
    'src/worker.ts': [
      "import { QUEUE_DOCUMENTS } from './config';",
      'export async function main(queueService: any) {',
      '  const queue = queueService.getQueueClient(QUEUE_DOCUMENTS);',
      '  const poison = queueService.getQueueClient("q-documents-poison");',
      '  const { receivedMessageItems } = await queue.receiveMessages({ numberOfMessages: 1 });',
      '  for (const item of receivedMessageItems) await poison.sendMessage(item.messageText);',
      '}',
    ].join('\n'),
  });
  const g = await ingestRepo(dir, { repoName: 'sqlrepo', openapi: false, design: false, tests: false });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = (kind: string) => g.edges.filter((e) => e.kind === kind);

  // tables from CREATE TABLE, with columns, located in the migration file
  const invoices = byId.get('sqlrepo::table::invoices');
  assert.ok(invoices, 'invoices table node');
  assert.equal(invoices!.signature, 'columns: id, status');
  assert.equal(invoices!.loc?.path, 'src/migrations.ts');
  assert.ok(byId.get('sqlrepo::table::audit_events'));

  // class methods are function nodes named Class.method, grouped under the class doc's @group
  const create = byId.get('sqlrepo::src/repos/pg.ts::PgInvoiceRepository.createDraft');
  assert.ok(create, 'method node');
  assert.equal(create!.kind, 'function');
  assert.equal(create!.group, 'data');
  assert.equal(create!.facets?.business?.description, 'Saves a new invoice draft.');
  assert.equal(byId.get('sqlrepo::src/repos/in-memory.ts::InMemoryInvoiceRepository.createDraft')?.group, 'InMemoryInvoiceRepository');

  // SQL reads / writes from the method that runs the statement, with the statement as the edge's code
  const w = edges('writes').find((e) => e.from === create!.id && e.to === 'sqlrepo::table::invoices');
  assert.ok(w, 'createDraft writes invoices');
  assert.equal(w!.meta?.op, 'insert');
  assert.match(String(w!.meta?.code), /^INSERT INTO invoices/);
  const r = edges('reads').find((e) => e.from === 'sqlrepo::src/repos/pg.ts::PgInvoiceRepository.getById' && e.to === 'sqlrepo::table::invoices');
  assert.ok(r, 'getById reads invoices');
  assert.equal(r!.meta?.op, 'select');
  // and both say how they were resolved: the name came out of the statement (B5.1)
  assert.equal(w!.resolution?.technique, 'raw-sql');
  assert.equal(r!.resolution?.technique, 'raw-sql');
  // this.audit() → the sibling method, which writes audit_events
  const auditId = 'sqlrepo::src/repos/pg.ts::PgInvoiceRepository.audit';
  const self = edges('calls').find((e) => e.from === create!.id && e.to === auditId);
  assert.ok(self, 'this.audit() resolves to the sibling method');
  assert.equal(self!.resolution?.technique, 'same-file');
  assert.ok(edges('writes').find((e) => e.from === auditId && e.to === 'sqlrepo::table::audit_events'));

  // repos.invoices.createDraft(…) → the production class, the in-memory twin set aside, MEDIUM and said so
  const svc = 'sqlrepo::src/service.ts::submitInvoice';
  const mc = edges('calls').find((e) => e.from === svc && e.to === create!.id);
  assert.ok(mc, 'service reaches PgInvoiceRepository.createDraft by method name');
  assert.equal(mc!.resolution?.technique, 'method-name');
  assert.equal(mc!.resolution?.confidence, 'MEDIUM');
  assert.match(String(mc!.resolution?.note), /2 classes declare createDraft; in-memory \/ mock twins set aside/);
  assert.ok(!edges('calls').find((e) => e.from === svc && e.to.includes('InMemory')), 'no edge to the in-memory twin');

  // a @guard function with a body is a gate on its caller AND a step the caller runs: both edges exist,
  // and the writes inside it stay reachable from the handler
  const submitDraft = 'sqlrepo::src/service.ts::submitDraft';
  const post = 'sqlrepo::src/service.ts::POST';
  assert.equal(byId.get(submitDraft)?.kind, 'guard');
  assert.ok(edges('guards').find((e) => e.from === submitDraft && e.to === post), 'guards edge back at the caller');
  const gc = edges('calls').find((e) => e.from === post && e.to === submitDraft);
  assert.ok(gc, 'calls edge into the guard function');
  assert.equal(gc!.meta?.via, 'guard');
  assert.ok(edges('writes').find((e) => e.from === submitDraft && e.to === 'sqlrepo::table::tracking_tokens'), 'the guard body writes tracking_tokens');

  // queues: the name follows the imported constant; the worker consumes one and publishes to the poison twin
  const q = byId.get('sqlrepo::queue::q-documents');
  assert.ok(q, 'queue node from the imported constant');
  const worker = 'sqlrepo::src/worker.ts::main';
  assert.ok(edges('consumes').find((e) => e.from === q!.id && e.to === worker), 'queue → worker consumes');
  assert.ok(edges('publishes').find((e) => e.from === worker && e.to === 'sqlrepo::queue::q-documents-poison'), 'worker → poison publishes');
});
