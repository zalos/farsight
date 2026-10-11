// Copy as MCP call · curl · CLI (round 2026-10-10, proposal 9). `public/app/lib/copy-doors.js` decides the three
// copy doors every record carries; this suite holds each kind's three strings, the full id in every one, shell
// quoting, a count's re-check, and the lessons a settings file may hold (never a credential).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { copyDoors, shellQuote } = await import(join(here, '..', 'public', 'app', 'lib', 'copy-doors.js'));
const { settingsProblem, lessonsProblem } = await import(join(here, '..', 'dist', 'index.js'));

const O = { origin: 'http://localhost:4560' };
const texts = (kind: string, node: unknown) => Object.fromEntries(copyDoors(kind, node, O).map((d: { via: string; text: string }) => [d.via, d.text]));

test('a gate: the gate tool, /api/gate and the impact command, each with the full id', () => {
  const id = 'invoice-app::guard::requireScope(billing:write)';
  const t = texts('gate', { id, kind: 'guard' });
  assert.equal(t.mcp, `gate {"node_id":"${id}"}`);
  assert.equal(t.curl, `curl -s 'http://localhost:4560/api/gate?node=${encodeURIComponent(id)}'`);
  assert.equal(t.cli, `farsight impact '${id}' --tests`);
  assert.deepEqual(copyDoors('gate', { id, kind: 'guard' }, O).map((d: { word: string }) => d.word), ['door.copy.mcp', 'door.copy.curl', 'door.copy.cli']);
});

test('a call and a record are described; a journey and a screen are walked; a test and a package have their own tools', () => {
  assert.match(texts('call', { id: 'a::route::POST /x' }).mcp, /^describe_node \{"node_id":"a::route::POST \/x"\}$/);
  assert.match(texts('table', { id: 'a::table::invoices' }).curl, /\/api\/impact\?node=a%3A%3Atable%3A%3Ainvoices'$/);
  const j = texts('flow', { id: 'a::flow::billing', kind: 'flow' });
  assert.equal(j.mcp, 'journey {"entry":"a::flow::billing"}');
  assert.equal(j.cli, 'farsight journeys');
  assert.match(texts('screen', { id: 'a::page::/x', kind: 'page' }).cli, /^farsight impact 'a::page::\/x' --flows$/);
  assert.equal(texts('test', { id: 'a::test::t1' }).mcp, 'test_coverage {"test":"a::test::t1"}');
  const p = texts('package', { id: 'a::package::@scope/lib', kind: 'package' });
  assert.equal(p.cli, "farsight deps where '@scope/lib'");
  assert.match(p.curl, /deps\/where\?package=%40scope%2Flib'$/);
});

test('a count copies its re-check; a count without one and a record without an id have no doors', () => {
  const t = texts('count', { n: 3, recheck: { cli: 'farsight journeys', mcp: 'journeys' } });
  assert.deepEqual(t, { mcp: 'journeys {}', curl: "curl -s 'http://localhost:4560/api/state'", cli: 'farsight journeys' });
  assert.deepEqual(copyDoors('count', { n: 3 }, O), []);
  assert.deepEqual(copyDoors('gate', { kind: 'guard' }, O), []);
});

test('an id with a quote stays one shell word', () => {
  assert.equal(shellQuote("a::fn::it's"), "'a::fn::it'\\''s'");
});

test('lessons: plain words pass; a token, a key or a keychain reference is refused and never echoed', () => {
  const base = { sources: [], collections: [] };
  assert.equal(settingsProblem({ ...base, lessons: [{ text: 'The e2e card is Playwright; the unit card is node:test.', pinned: true, date: '2026-10-10' }] }), null);
  assert.equal(lessonsProblem(undefined), null);
  for (const bad of ['use keychain:farsight/jira-example', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Authorization: Bearer abcdefghijklmnop']) {
    const p = settingsProblem({ ...base, lessons: [{ text: bad }] });
    assert.match(String(p), /looks like a credential/);
    assert.ok(!String(p).includes(bad.split(' ').pop()!), 'the refusal never repeats the value');
  }
  assert.match(String(settingsProblem({ ...base, lessons: [{ text: 'x'.repeat(401).replace(/x/g, 'a b') }] })), /longer than 400/);
  assert.match(String(settingsProblem({ ...base, lessons: 'no' })), /must be an array/);
  assert.match(String(settingsProblem({ ...base, mcp: { tools: 'some' } })), /core or all/);
  assert.equal(settingsProblem({ ...base, mcp: { tools: 'all', budget: 12000 } }), null);
});
