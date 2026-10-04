// The project picker's model (lib/multi-pick-model.js): what a query leaves, in which order. The
// module is the one the viewer imports, so this suite tests the shipped code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const M = await import(join(here, '..', 'public', 'app', 'lib', 'multi-pick-model.js'));

const groups = [{ key: 'application', word: 'Applications' }, { key: 'library', word: 'Libraries' }, { key: 'e2e', word: 'End-to-end tests' }, { key: 'other', word: 'Other projects' }];
const options = [
  { id: 'nx::shared-util', word: 'shared-util', group: 'library', match: ['shared-util', 'Shared util', 'scope:shared', 'type:util', 'Shared', 'Utility'] },
  { id: 'nx::billing-ui', word: 'billing-ui', group: 'library', match: ['billing-ui', 'Billing ui', 'scope:billing', 'Billing'] },
  { id: 'nx::billing-web-e2e', word: 'billing-web-e2e', group: 'e2e', match: ['billing-web-e2e'] },
  { id: 'inv::invoice-app', word: 'invoice-app', group: 'other', match: ['invoice-app'] },
  { id: 'nx::billing-web', word: 'billing-web', group: 'application', match: ['billing-web', 'Billing web', 'scope:billing'] },
  { id: 'nx::ops-admin', word: 'ops-admin', group: 'application', match: ['ops-admin', 'Ops admin', 'scope:ops', 'Opérations'] },
];
const ids = (q: string) => M.shownOptions(options, groups, q).map((o: { id: string }) => o.id);

test('no query: every option, applications above libraries above end-to-end above the rest', () => {
  assert.deepEqual(ids(''), ['nx::billing-web', 'nx::ops-admin', 'nx::shared-util', 'nx::billing-ui', 'nx::billing-web-e2e', 'inv::invoice-app']);
});

test('a query narrows by name, by words and by tag, and keeps the group order', () => {
  assert.deepEqual(ids('bill'), ['nx::billing-web', 'nx::billing-ui', 'nx::billing-web-e2e']);
  // a tag finds what its name does not
  assert.deepEqual(ids('scope:shared'), ['nx::shared-util']);
  assert.deepEqual(ids('utility'), ['nx::shared-util']);
  // every term must match somewhere
  assert.deepEqual(ids('billing web'), ['nx::billing-web', 'nx::billing-web-e2e']);
  assert.deepEqual(ids('zzz'), []);
});

test('case and accents do not matter', () => {
  assert.deepEqual(ids('OPERATIONS'), ['nx::ops-admin']);
  assert.deepEqual(ids('opér'), ['nx::ops-admin']);
  assert.equal(M.fold('Ünïcode É'), 'unicode e');
});

test('a prefix outranks a word start, which outranks a substring, inside a group', () => {
  const o = { id: 'x', word: 'data-access', match: ['billing-data-access'] };
  assert.equal(M.matchScore(o, 'data'), 2);
  assert.equal(M.matchScore(o, 'acc'), 1);
  assert.equal(M.matchScore(o, 'ccess'), 0);
  assert.equal(M.matchScore(o, 'nope'), -1);
  const libs = [
    { id: 'a', word: 'shared-ui', group: 'library', match: [] },
    { id: 'b', word: 'ui-kit', group: 'library', match: [] },
  ];
  assert.deepEqual(M.shownOptions(libs, groups, 'ui').map((x: { id: string }) => x.id), ['b', 'a']);
});
