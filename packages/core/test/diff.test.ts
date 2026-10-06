// farsight-diff v1 contract tests: golden fixtures (two snapshot JSONs in →
// exact contract JSON out), schema validation against the frozen schema file,
// truncation semantics, policy gating, SARIF rendering.
//
// Fixtures are generated from examples/invoice-app by fixtures/make-fixtures.mjs
// (which documents the scripted mutation standing in for a second commit).
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphStore, diffGraphs, rowChangesOf, parsePolicy, applyPolicy, toSarif, toMarkdown, attributeChanges } from '../dist/index.js';
import type { GraphDiff, CommitRow, FileChange } from '../dist/index.js';
import { validate } from './validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);
const load = (name: string) => GraphStore.load(fixture(name));

const base = load('invoice-base.json');
const head = load('invoice-head.json');
const expected = JSON.parse(readFileSync(fixture('expected-diff.json'), 'utf8')) as GraphDiff;

test('golden fixture: diffGraphs(base, head) reproduces expected-diff.json exactly', () => {
  const diff = diffGraphs(base, head);
  assert.deepEqual(diff, expected);
  // byte-for-byte, not just structurally: field order is part of what we freeze in the fixture
  assert.equal(JSON.stringify(diff), JSON.stringify(expected));
});

test('golden fixture: the schema file validates the real output', () => {
  const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));
  const errors = validate(diffGraphs(base, head), schema);
  assert.deepEqual(errors, []);
  // and the gate block validates too
  const gated = applyPolicy(diffGraphs(base, head), parsePolicy('version: 1\nrules:\n  - rule: r\n    when: any\n    then: warn\n'));
  assert.deepEqual(validate(gated, schema), []);
});

test('the schema file rejects a non-conforming document', () => {
  const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));
  const broken = JSON.parse(JSON.stringify(expected));
  broken.changes[0].kind = 'route_repainted';
  delete broken.counts.guard_removed;
  assert.ok(validate(broken, schema).length >= 2);
});

test('contract basics: version string, labels, stable ids, per-change confidence', () => {
  const diff = diffGraphs(base, head);
  assert.equal(diff.schema, 'farsight-diff v1');
  assert.equal(diff.base, 'sync:39 · 76f7674');
  assert.equal(diff.head, 'sync:41 · 4677268');
  diff.changes.forEach((c, i) => assert.equal(c.id, `c${i + 1}`)); // deterministic order → stable ids
  for (const c of diff.changes) assert.ok(['resolved', 'HIGH', 'MEDIUM', 'LOW'].includes(c.confidence));
  // resolution-derived confidence appears once an edge is stamped (the fixture stamps one)
  assert.ok(diff.changes.some((c) => c.kind === 'edge_confidence_changed' && c.confidence === 'MEDIUM' && c.technique === 'name-match'));
});

test('truncation cuts changes but never counts', () => {
  const diff = diffGraphs(base, head, { limit: 2 });
  assert.equal(diff.truncated, true);
  assert.equal(diff.changes.length, 2);
  assert.deepEqual(diff.counts, expected.counts); // counts stay complete — CI asserts on completeness
  assert.equal(diffGraphs(base, head, { limit: 500 }).truncated, false);
});

test('diffGraphs accepts precomputed row changes (the SnapshotDb.changedBetween path)', () => {
  const diff = diffGraphs(base, head, { changes: rowChangesOf(base, head) });
  assert.deepEqual(diff, expected);
});

test('identical graphs diff to nothing', () => {
  const diff = diffGraphs(base, base);
  assert.equal(diff.changes.length, 0);
  assert.equal(diff.truncated, false);
  assert.ok(Object.values(diff.counts).every((n) => n === 0));
});

test('policy: facts in the diff, judgment in compliance.yml, exit code from the verdict', () => {
  const diff = diffGraphs(base, head);
  const failing = applyPolicy(diff, parsePolicy(
    'version: 1\nrules:\n  - rule: no-guard-removals\n    when: guard_removed\n    then: fail\n  - rule: announce-new-routes\n    when: route_added\n    then: warn\n',
    'test-policy',
  ));
  assert.equal(failing.gate!.result, 'fail');
  assert.equal(failing.gate!.exit, 1);
  assert.equal(failing.gate!.policy, 'test-policy');
  const guardRule = failing.gate!.rules.find((r) => r.rule === 'no-guard-removals')!;
  assert.equal(guardRule.result, 'fail');
  assert.deepEqual(guardRule.changes, ['c2']); // the finalize route's lost gate
  assert.equal(failing.gate!.rules.find((r) => r.rule === 'announce-new-routes')!.result, 'warn');
  assert.equal(diff.gate, undefined); // applyPolicy is immutable over its input

  const passing = applyPolicy(diff, parsePolicy('version: 1\nrules:\n  - rule: watch\n    when: severity:breaking\n    then: warn\n'));
  assert.equal(passing.gate!.result, 'pass');
  assert.equal(passing.gate!.exit, 0);
});

test('policy: severity: and any matchers', () => {
  const diff = diffGraphs(base, head);
  const gated = applyPolicy(diff, parsePolicy(
    'version: 1\nrules:\n  - rule: all-breaking\n    when: severity:breaking\n    then: fail\n  - rule: everything\n    when: any\n    then: allow\n',
  ));
  const breaking = gated.gate!.rules[0]!;
  assert.deepEqual(breaking.changes, diff.changes.filter((c) => c.severity === 'breaking').map((c) => c.id));
  assert.equal(gated.gate!.rules[1]!.changes.length, diff.changes.length);
});

test('the repo-root compliance.yml (dogfood policy) parses and gates this fixture', () => {
  const text = readFileSync(join(here, '..', '..', '..', 'compliance.yml'), 'utf8');
  const gated = applyPolicy(diffGraphs(base, head), parsePolicy(text, 'compliance.yml'));
  assert.equal(gated.gate!.result, 'fail'); // the fixture removes a guard — the dogfood policy must catch it
  // A2.6: the uncovered_change rule parses, is applied, and never turns a warn into a block
  const uncovered = gated.gate!.rules.find((r) => r.rule === 'announce-uncovered-changes')!;
  assert.ok(uncovered, 'the dogfood policy announces uncovered changes');
  assert.ok(uncovered.result === 'warn' || uncovered.result === 'pass');
});

test('policy parser rejects what the subset does not promise', () => {
  assert.throws(() => parsePolicy('version: 2\nrules:\n'), /unsupported version/);
  assert.throws(() => parsePolicy('version: 1\nrules:\n  - rule: x\n    when: guard_removed\n'), /needs rule\/when\/then/);
  assert.throws(() => parsePolicy('version: 1\nrules:\n  - rule: x\n    when: any\n    then: explode\n'), /then must be/);
  assert.throws(() => parsePolicy('nested:\n  deep: true\n'), /unsupported line|cannot parse/);
});

test('SARIF rendering: one result per change, severity → level', () => {
  const diff = diffGraphs(base, head);
  const sarif = toSarif(diff) as { version: string; runs: { results: { ruleId: string; level: string }[] }[] };
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0]!.results.length, diff.changes.length);
  const guard = sarif.runs[0]!.results.find((r) => r.ruleId === 'guard_removed')!;
  assert.equal(guard.level, 'error'); // breaking → error
  assert.equal(sarif.runs[0]!.results.find((r) => r.ruleId === 'message_added')!.level, 'note'); // info → note
});

test('markdown rendering mentions every non-zero kind', () => {
  const md = toMarkdown(diffGraphs(base, head));
  for (const [kind, count] of Object.entries(expected.counts)) {
    if ((count as number) > 0) assert.ok(md.includes(kind), `md missing ${kind}`);
  }
});

test('farsight-diff v1: the technique enumeration carries every ResolutionTechnique, additively', () => {
  const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));
  const doc = JSON.parse(JSON.stringify(diffGraphs(base, head))) as { changes: Record<string, unknown>[] };
  assert.ok(doc.changes.length >= 2, 'the fixture has changes to stamp');
  // a change derived from an edge the tests pass resolves, and one from the clarity phase's interface dispatch
  doc.changes[0]!.technique = 'route-literal';
  doc.changes[1]!.technique = 'interface';
  assert.deepEqual(validate(doc, schema), []);
  // an invented technique is still refused: the enumeration is closed, it just grew
  doc.changes[0]!.technique = 'vibes';
  assert.ok(validate(doc, schema).some((e) => e.includes('not in enum')));

  const techniques = schema.$defs.technique.enum as string[];
  const expected = [
    'static-import', 'fetch→route', 'db-builder', 'annotation-scan', 'DI-binding', 'name-match',
    'import-resolution', 'route-literal', 'coverage-report', 'method-name',
    'interface', 'hook-binding', 'sdk-import', 'constant-host',
    'raw-sql', 'same-file', 'jsx-render', 'detected',
    'work-key', 'callback-prop',
  ];
  assert.deepEqual([...techniques].sort(), [...expected].sort());
});

// ── attribution (2026-09-23, chunk H4) ────────────────────────────────────
// The contract gains one optional field and nothing else moves: `diffGraphs`
// still reads no git and no history table, so a diff produced without
// attribution is byte for byte the document frozen in July.

const schemaFile = () =>
  JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'));

test('farsight-diff v1: attribution is an optional addition — the frozen output has none, the schema holds both shapes', () => {
  const schema = schemaFile();
  const plain = diffGraphs(base, head);
  // the whole point of the split: producing a diff never invents attribution
  assert.ok(plain.changes.every((c) => !('attribution' in c)));
  assert.equal(JSON.stringify(plain), JSON.stringify(expected)); // byte-identical, field order included
  assert.deepEqual(validate(plain, schema), []);

  const doc = JSON.parse(JSON.stringify(plain)) as { changes: Record<string, unknown>[] };
  doc.changes[0]!.attribution = { commits: ['9ded681', '0052772'], level: 'file', unindexed: 2 };
  doc.changes[1]!.attribution = { commits: [], level: 'file', unindexed: 0 }; // the earned empty list
  assert.deepEqual(validate(doc, schema), []);

  // the granularity is a literal, so no producer can quietly promote it to node level
  doc.changes[0]!.attribution = { commits: ['9ded681'], level: 'node', unindexed: 0 };
  assert.ok(validate(doc, schema).some((e) => e.includes('expected const')));
  // and the floor travels with the list: a list without its unindexed count is not the field
  doc.changes[0]!.attribution = { commits: ['9ded681'], level: 'file' };
  assert.ok(validate(doc, schema).some((e) => e.includes('missing required "unindexed"')));
  // an invented sub-field is refused like every other addition to a closed object
  doc.changes[0]!.attribution = { commits: ['9ded681'], level: 'file', unindexed: 0, because: 'vibes' };
  assert.ok(validate(doc, schema).some((e) => e.includes('unexpected property "because"')));
});

test('farsight-diff v1: attributeChanges adds the field to a real document and moves nothing else', () => {
  const schema = schemaFile();
  const plain = diffGraphs(base, head);
  const commit = (sha: string, at: string, subject: string, indexed: boolean): CommitRow =>
    ({ repo: 'invoice-app', sha, at, author: 'Ada', email: 'ada@example.com', subject, parents: [], merge: false, indexed, syncs: indexed ? [41] : [] });
  const commits: CommitRow[] = [
    commit('aaaaaaa', '2026-09-20T10:00:00.000Z', 'routes', true),
    commit('bbbbbbb', '2026-09-19T10:00:00.000Z', 'routes and schemas', false),
  ];
  const touched = (sha: string, path: string): FileChange => ({ repo: 'invoice-app', sha, path, status: 'modified' });
  const files: FileChange[] = [
    touched('aaaaaaa', 'src/server/routes.ts'),
    touched('bbbbbbb', 'src/server/routes.ts'),
    touched('bbbbbbb', 'src/server/schemas.ts'),
  ];

  const out = attributeChanges(plain, { commits, files });
  assert.deepEqual(validate(out, schema), []); // the enriched document is still farsight-diff v1

  const by = new Map(out.changes.map((c) => [c.id, c.attribution]));
  // c2 is the guard removed in routes.ts: both commits touched that file, newest first, and one
  // of them no sync ever ingested — which is exactly what makes the list a floor, not a fact
  assert.deepEqual(by.get('c2'), { commits: ['aaaaaaa', 'bbbbbbb'], level: 'file', unindexed: 1 });
  assert.deepEqual(by.get('c6'), { commits: ['bbbbbbb'], level: 'file', unindexed: 1 }); // schemas.ts
  // CreateInvoiceForm.tsx: the history was read and nothing in it touched that file
  assert.deepEqual(by.get('c8'), { commits: [], level: 'file', unindexed: 0 });
  // record_columns_changed and message_added have no loc — no file to join on, so no claim
  assert.equal(by.get('c4'), undefined);
  assert.equal(by.get('c5'), undefined);

  // the diff handed in was copied, not enriched in place: still the frozen fixture
  assert.equal(JSON.stringify(plain), JSON.stringify(expected));
  // and a repository with no history rows gains no field at all — absent ≠ the empty list above
  assert.ok(attributeChanges(plain, { commits: [], files: [] }).changes.every((c) => !('attribution' in c)));
});
