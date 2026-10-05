// Every detail is a door (round 2026-10-05 §3.2). `public/app/lib/detail-links.js`
// is the one builder the journey and the Map draw their doors from; this suite
// holds every row of the door table, the business register leaving the code
// doors out, and a detail the graph cannot name getting no door at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { detailLinks, editorDoor, editorHref } = await import(join(here, '..', 'public', 'app', 'lib', 'detail-links.js'));

const roots = { app: '/w/app' };
const guard = { id: 'app::src/auth.ts::requireOwner', kind: 'guard', name: 'requireOwner', loc: { repo: 'app', path: 'src/auth.ts', line: 12 } };
const rule = { id: 'app::src/rules.ts::invoiceShape', kind: 'rule', name: 'invoiceShape', loc: { repo: 'app', path: 'src/rules.ts', line: 3 } };
const route = {
  id: 'app::src/server.ts::POST /invoices', kind: 'route', name: 'POST /invoices', loc: { repo: 'app', path: 'src/server.ts', line: 40 },
  contract: { status: 'both', apiId: 'app::api::billing', spec: { path: 'openapi.yaml', line: 88, operationId: 'createInvoice' } },
};
const handler = { id: 'app::src/server.ts::createInvoice', kind: 'function', name: 'createInvoice', loc: { repo: 'app', path: 'src/server.ts', line: 52 } };
const table = { id: 'app::table::invoices', kind: 'table', name: 'invoices', loc: { repo: 'app', path: 'db/schema.sql', line: 7 } };
const testNode = { id: 'app::e2e/bill.spec.ts::bills', kind: 'test', name: 'bills', loc: { repo: 'app', path: 'e2e/bill.spec.ts', line: 5 } };
const work = { id: 'work::jira-example::KAN-3', kind: 'work', name: 'KAN-3', links: [{ kind: 'see', url: 'https://example.atlassian.net/browse/KAN-3' }] };
const manifest = { id: 'app::design::screens', kind: 'design', name: 'screens.json', loc: { repo: 'app', path: 'design/screens.json', line: 1 } };
const page = { id: 'app::page::/invoices', kind: 'page', name: '/invoices', loc: { repo: 'app', path: 'src/pages/Invoices.tsx', line: 1 },
  design: { status: 'both', origin: 'manifest', designId: manifest.id, url: 'https://www.figma.com/file/abc?node-id=1-2' } };
const pkg = { id: 'app::package::zod', kind: 'package', name: 'zod' };
const byId = Object.fromEntries([guard, rule, route, handler, table, testNode, work, manifest, page, pkg].map((n) => [n.id, n]));
const edgesOf = new Map([[route.id, [{ from: route.id, to: handler.id, kind: 'calls' }]]]);
const ctx = (extra = {}) => ({ byId, roots, edgesOf, lens: 'hybrid', flow: 'app::flow::billing', ...extra });
const words = (d: Array<{ word: string }>) => d.map((x) => x.word);

test('a gate or a rule: the editor at its line, then its card on the code map', () => {
  for (const [kind, n] of [['gate', guard], ['guard', guard], ['rule', rule]] as const) {
    const d = detailLinks(kind, n, ctx());
    assert.deepEqual(words(d), ['door.editor', 'door.codemap']);
    assert.equal(d[0].href, 'vscode://file/' + roots.app + '/' + n.loc.path + ':' + n.loc.line);
    assert.equal(editorDoor(d), d[0]);
  }
});

test('a call: the contract at its operation, the spec line, the handler in the editor, the code map', () => {
  const d = detailLinks('call', route, ctx());
  assert.deepEqual(words(d), ['door.contract', 'door.spec', 'door.handler', 'door.codemap']);
  assert.equal(d[0].href, '#/apis/app%3A%3Aapi%3A%3Abilling?op=' + encodeURIComponent(route.id));
  assert.equal(d[1].href, '#/apis/app%3A%3Aapi%3A%3Abilling?view=spec&line=88');
  assert.equal(d[2].href, 'vscode://file//w/app/src/server.ts:52', 'the handler from the route\'s calls edge');
  // the marker's own word for the handler wins over the edge
  const m = detailLinks('route', route, ctx({ handler: { path: 'src/other.ts', line: 9 } }));
  assert.equal(m[2].href, 'vscode://file//w/app/src/other.ts:9');
});

test('a record, store or third party: its card on the code map and its schema in the editor', () => {
  for (const kind of ['record', 'table', 'message', 'external']) {
    assert.deepEqual(words(detailLinks(kind, table, ctx())), ['door.codemap', 'door.schema']);
  }
});

test('a test: the cases kept to the journey and the test file', () => {
  const d = detailLinks('test', testNode, ctx());
  assert.deepEqual(words(d), ['door.cases', 'door.testFile']);
  assert.equal(d[0].href, '#/tests?flow=app%3A%3Aflow%3A%3Abilling');
});

test('a work chip: the item on the work board and the tracker in a new tab', () => {
  const d = detailLinks('work', work, ctx());
  assert.deepEqual(words(d), ['door.work', 'door.tracker']);
  assert.equal(d[1].external, true);
  assert.equal(d[1].href, 'https://example.atlassian.net/browse/KAN-3');
});

test('a screen: the page on the code map, the design file, Figma', () => {
  const d = detailLinks('screen', page, ctx());
  assert.deepEqual(words(d), ['door.page', 'door.design', 'door.figma']);
  assert.equal(d[2].external, true);
});

test('a package: where it is included', () => {
  const d = detailLinks('package', pkg, ctx());
  assert.deepEqual(d, [{ word: 'door.included', href: '#/codemap?view=package&package=app%3A%3Apackage%3A%3Azod' }]);
});

test('the business register draws no door into code — a gate is its words', () => {
  assert.deepEqual(detailLinks('gate', guard, ctx({ lens: 'business' })), []);
  assert.deepEqual(words(detailLinks('call', route, ctx({ lens: 'business' }))), ['door.contract']);
  assert.deepEqual(words(detailLinks('test', testNode, ctx({ lens: 'business' }))), ['door.cases']);
  assert.deepEqual(words(detailLinks('screen', page, ctx({ lens: 'business' }))), ['door.figma']);
});

test('a door the graph cannot name is not drawn', () => {
  // no root for the source: no editor door; not in the graph: no code-map door
  assert.deepEqual(detailLinks('gate', { ...guard, id: 'x::y' }, ctx({ roots: {} })), []);
  // a route with no contract and no handler: only its card
  assert.deepEqual(words(detailLinks('call', { id: route.id, kind: 'route', name: 'GET /x' }, ctx({ edgesOf: new Map() }))), ['door.codemap']);
  // a test with no journey and no file, a work item with no tracker link
  assert.deepEqual(detailLinks('test', { id: 't', kind: 'test' }, ctx({ flow: null })), []);
  assert.deepEqual(words(detailLinks('work', { id: 'work::s::K-1', kind: 'work' }, ctx())), ['door.work']);
  assert.deepEqual(detailLinks('gate', null, ctx()), []);
  assert.equal(editorDoor([]), null);
  assert.equal(editorHref(roots, 'app', 'https://x/spec.yaml', 1), null, 'a spec served from the web is not a file');
});
