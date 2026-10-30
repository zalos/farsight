import { test } from 'node:test';
import assert from 'node:assert/strict';
const M = await import('../public/app/lib/settings-model.js');

const forms = {
  gates: {
    frameworks: {
      spring: {
        security: { 'Policy.With.Dot': { label: '$action on $resource', tier: 'policy', requires: '$action' } },
        listeners: { Event: 'pair:topic' },
      },
      nest: { guards: { Tenant: { label: 'Tenant' } } },
      express: { middleware: { session: { label: 'Session' } } },
    },
    guards: { Session: ['GET /invoices'] },
    gateTiers: { Session: 'policy' },
  },
  endpoints: {
    frameworks: {
      spring: { mappings: { ApiRoute: { method: 'pair:method', path: 'arg:0' } }, delegates: ['*Delegate'] },
      nest: { verbs: { JsonGet: 'GET' } },
    },
    nodes: [
      { kind: 'guard', name: 'Session' },
      {
        kind: 'route',
        name: 'GET /invoices',
        loc: 'src/api.ts:1',
        handler: 'src/api.ts::list',
        guards: ['Session'],
        business: 'List invoices',
      },
      { kind: 'queue', name: 'Invoice events' },
    ],
  },
  patterns: {
    patterns: [
      {
        id: 'custom',
        files: ['src/**/*.{ts,js}'],
        match: { call: 'router.$METHOD', args: { path: 0, handler: -1, method: 'pair:method' } },
        emit: { kind: 'route', method: '$METHOD', path: '$path', handler: '$handler', tags: ['billing'] },
        business: 'Invoices',
      },
    ],
  },
  nodes: {
    nodes: [
      { kind: 'guard', name: 'Session', tier: 'policy', business: 'Signed in' },
      { kind: 'external', name: 'Payments' },
      { kind: 'queue', name: 'Events' },
      { kind: 'route', name: 'POST /invoices', guards: ['Session'] },
    ],
  },
  openapi: {
    openapi: [
      { path: 'docs/api.yaml', name: 'Invoices', phase: 'live', phaseOrder: ['draft', 'live'] },
      { url: 'https://example.com/api.json' },
    ],
    openapiIgnore: ['docs/old.json'],
  },
  words: {
    glossary: { 'Invoice.submit': { label: 'Submit invoice', description: 'Send for approval' } },
    tags: { billing: ['Invoice', 'src/billing/'] },
    entrypoints: { Billing: ['submit'] },
  },
  externals: {
    externals: [
      { import: '@example/client', name: 'ERP', kind: 'erp', store: false },
      { kind: 'party', name: 'Supplier', role: 'Sends invoices', persona: 'supplier' },
    ],
    stores: [{ name: 'Billing', kind: 'relational', engine: 'postgres', tables: ['Invoice'] }],
  },
};
for (const [form, block] of Object.entries(forms)) {
  test(`${form}: form → JSON → form preserves every entry and unowned sibling`, () => {
    const input = { ...block, setup: ['createApp'] };
    const rows = M.rowsOf(input, form);
    const json = JSON.parse(JSON.stringify(M.blockOf(rows, input, form)));
    assert.deepEqual(json, input);
    assert.deepEqual(M.rowsOf(json, form), rows);
    assert.deepEqual(
      M.rowsOf(M.formBlock(input, form), form).map(({ index: _, ...r }: any) => r),
      rows.map(({ index: _, ...r }: any) => r),
    );
    assert.deepEqual(input.setup, ['createApp']);
  });
}
test('route rows share nodes without losing non-route siblings, including after remove and reorder', () => {
  const block = {
    nodes: [
      { kind: 'guard', name: 'Gate' },
      { kind: 'route', name: 'GET /a' },
      { kind: 'queue', name: 'Events' },
      { kind: 'route', name: 'GET /b' },
    ],
  };
  const rows = M.rowsOf(block, 'endpoints');
  rows.reverse();
  assert.deepEqual(
    M.blockOf(rows, block, 'endpoints').nodes.map((n: any) => n.name),
    ['Gate', 'GET /b', 'Events', 'GET /a'],
  );
  assert.deepEqual(M.blockOf([], block, 'endpoints').nodes, [block.nodes[0], block.nodes[2]]);
});
test('overlay edits are dirty and survive an unrelated concurrent settings save', () => {
  const before = { sources: [{ id: 'app', config: forms.words }] };
  const draft = M.clone(before);
  const rows = M.rowsOf(draft.sources[0].config, 'words');
  rows[0].value.label = 'Send invoice';
  draft.sources[0].config = M.blockOf(rows, draft.sources[0].config, 'words');
  assert.ok(M.dirty(before, draft));
  assert.ok(M.needsSync(before, draft));
  assert.equal(
    M.mergeSettings(before, draft, { ...before, theme: 'light' }).sources[0].config.glossary['Invoice.submit'].label,
    'Send invoice',
  );
});
test('test acknowledgements are bound to a source and complete rule, and apply across sections', () => {
  const source = { id: 'app', type: 'local', path: 'source', config: forms.patterns };
  const before = { sources: [{ ...source, config: {} }] };
  const draft = { sources: [M.clone(source)] };
  const acknowledgements = new Set();
  assert.equal(M.untestedPatterns(before, draft, acknowledgements).length, 1);
  acknowledgements.add(M.patternStamp(source, source.config.patterns[0]));
  assert.deepEqual(M.untestedPatterns(before, draft, acknowledgements), []);
  draft.sources[0].config.patterns[0].emit.path = '/changed';
  assert.equal(M.untestedPatterns(before, draft, acknowledgements).length, 1);
  assert.deepEqual(M.untestedPatterns(draft, draft, new Set()), []);
  draft.sources[0] = M.clone(source);
  draft.sources[0].path = 'other';
  assert.equal(M.untestedPatterns(before, draft, acknowledgements).length, 1);
});
test('the label preview follows capture substitution and falls back on any missing capture', () => {
  assert.equal(
    M.labelPreview('$action on $resource', { action: 'approve', resource: 'invoice' }, 'Policy'),
    'approve on invoice',
  );
  assert.equal(M.labelPreview('$action on $missing', { action: 'approve' }, 'Policy'), 'Policy');
});
test('pattern result counts retain their source and a breakdown that sums', () => {
  const counts = M.patternTestCounted({
    report: {
      rules: [
        { id: 'a', matched: 2 },
        { id: 'b', matched: 1 },
      ],
    },
  });
  assert.equal(counts.rules.n, 2);
  assert.equal(counts.matches.n, 3);
  assert.equal(
    counts.matches.breakdown.reduce((sum: number, p: any) => sum + p.n, 0),
    3,
  );
});

test('declared audit uses the parser’s structured kind/name association, including after reorder', () => {
  const path = '.farsight/settings.json → sources[app].config';
  const report = {
    files: [
      {
        path,
        from: 'workspace',
        nodes: [
          { kind: 'route', name: 'GET /missing', notes: ['A handler is missing.'] },
          { kind: 'guard', name: 'Session', notes: [] },
        ],
      },
      { path: 'farsight.config.json', nodes: [{ kind: 'route', name: 'GET /missing', notes: ['A repository note.'] }] },
    ],
    notes: ['An unrelated source note.'],
  };
  assert.deepEqual(M.declaredAuditNotes(report, 'app', { kind: 'route', name: 'GET /missing' }), [
    'A handler is missing.',
  ]);
  assert.deepEqual(M.declaredAuditNotes(report, 'app', { kind: 'guard', name: 'Session' }), []);
  assert.deepEqual(M.declaredAuditNotes(report, 'app', { kind: 'route', name: 'GET /new' }), []);
});
