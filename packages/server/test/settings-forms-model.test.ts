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

test('clean or empty node summaries do not inherit flat file warnings, while older reports retain fallback', () => {
  const file = { path: '.farsight/settings.json → sources[app].config', from: 'workspace' };
  const node = { kind: 'guard', name: 'Session' };
  const notes = ['An unrelated source note.'];
  assert.deepEqual(M.declaredAuditNotes({ files: [{ ...file, nodes: [node] }], notes }, 'app', node), []);
  assert.deepEqual(M.declaredAuditNotes({ files: [{ ...file, nodes: [] }], notes }, 'app', node), []);
  assert.deepEqual(M.declaredAuditNotes({ files: [file], notes }, 'app', node), notes);
});

test('unchanged saved rules are not gated by source edits or object-key order', () => {
  const rule = { id: 'one', files: ['*.ts'], match: { call: 'portal.get' }, emit: { kind: 'flag', name: 'Portal' } };
  const source = { id: 'app', type: 'local', path: 'source', config: { patterns: [rule] } };
  const loaded = { sources: [source] };
  const draft = M.clone(loaded);
  draft.sources[0].exclude = ['generated/**'];
  draft.sources[0].config.patterns[0] = { emit: rule.emit, match: rule.match, files: rule.files, id: rule.id };
  assert.deepEqual(M.untestedPatterns(loaded, draft, new Set()), []);
  assert.equal(M.patternStamp(source, rule), M.patternStamp(source, draft.sources[0].config.patterns[0]));
});

test('form value folds preserve typed captures, replace matchers and remove fields hidden by emit-kind changes', () => {
  const row = {
    path: 'patterns',
    value: {
      files: [],
      match: { call: 'old' },
      emit: { kind: 'route', method: 'GET', path: '', handler: 'enclosing', name: '' },
    },
  };
  M.updateFormValue(row, 'match.args', 'path=0\nhandler=-1\nmethod=pair:method');
  assert.deepEqual(row.value.match.args, { path: 0, handler: -1, method: 'pair:method' });
  M.updateFormValue(row, 'files', 'src/*.ts\n  lib/*.ts');
  assert.deepEqual(row.value.files, ['src/*.ts', 'lib/*.ts']);
  M.updateFormValue(row, '$matcher', 'regex');
  assert.deepEqual(row.value.match, { regex: '' });
  M.updateFormValue(row, 'emit.kind', 'guard');
  assert.deepEqual(row.value.emit, { kind: 'guard', handler: 'enclosing' });
  M.updateFormValue(row, 'emit.requires', '$role');
  M.updateFormValue(row, 'emit.kind', 'queue');
  assert.deepEqual(row.value.emit, { kind: 'queue', handler: 'enclosing' });
  const doc = { path: 'openapi', value: { path: 'api.yaml', name: 'API' } };
  M.updateFormValue(doc, '$document', 'https://example.com/api.yaml');
  assert.deepEqual(doc.value, { url: 'https://example.com/api.yaml', name: 'API' });
  const external = { path: 'externals', value: {} };
  M.updateFormValue(external, 'store', 'false');
  assert.equal(external.value.store, false);
  M.updateFormValue(external, 'store', '');
  assert.equal(Object.hasOwn(external.value, 'store'), false);
});

test('registration merge retains an edited document and newly registered or dismissed candidates', () => {
  const before = { openapi: [{ path: 'a.yaml', name: 'A' }], openapiIgnore: ['old.yaml'] };
  const draft = { openapi: [{ path: 'a.yaml', name: 'Renamed' }], openapiIgnore: ['draft.yaml'] };
  const current = {
    openapi: [{ path: 'a.yaml', name: 'A' }, { path: 'registered.yaml' }],
    openapiIgnore: ['old.yaml', 'dismissed.yaml'],
  };
  assert.deepEqual(M.mergeSettings(before, draft, current), {
    openapi: [{ path: 'a.yaml', name: 'Renamed' }, { path: 'registered.yaml' }],
    openapiIgnore: ['draft.yaml', 'dismissed.yaml'],
  });
});
