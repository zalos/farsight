// Compare two syncs on a storyline (round 2026-10-10, proposal 7) — the parts that need no parser: the meta a sync
// keeps in history, the closed set of delta kinds pinned against a literal list and the frozen schema, the document
// built from a diff validating as farsight-diff v1, and --fail-on. The diff over a real second sync of
// examples/invoice-app is packages/server/test/storyline-diff.test.ts (it ingests, which core cannot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GraphStore,
  SnapshotDb,
  sqliteAvailable,
  DELTA_KINDS,
  DELTA_CHANGES,
  DELTA_DOORS,
  CHANGE_KINDS,
  COUNT_SCOPES,
  storylineDiffDocument,
  parseFailOn,
  countedProblems,
  t,
  resolveCompareFrom,
} from '../dist/index.js';
import type { GraphNode, StorylineDiff } from '../dist/index.js';
import { validate } from './validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-diff-v1.schema.json'), 'utf8'),
);
const opts = { skip: sqliteAvailable() ? false : 'node:sqlite unavailable on this runtime' };

test('a sync keeps its meta in history: the storylines come back, and an old sync says it kept none', opts, () => {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-compare-'));
  try {
    const db = new SnapshotDb(join(dir, 'farsight.db'));
    const store = new GraphStore();
    store.addFragment({
      repo: 'r',
      nodes: [{ id: 'r::a', kind: 'function', name: 'a', tags: [] } as GraphNode],
      edges: [],
    });
    store.meta.journeys = {
      r: {
        personas: [],
        groups: [],
        flows: {},
        notes: [],
        storylines: [{ id: 's', name: 'S', journeys: ['x'], from: 'docs/design/screens.json' }],
      } as never,
    };
    store.meta.graphPath = '/somewhere/graph.json';
    const ref = db.write(store);
    const back = db.read(ref.sync);
    assert.equal(back.metaKept, true);
    assert.deepEqual(back.store.meta.journeys, store.meta.journeys);
    // the identity fields are the snapshot row's, never a copy of the live graph's
    assert.equal(back.store.meta.sync, ref.sync);
    assert.equal(back.store.meta.graphPath, undefined);
    assert.equal(db.has(ref.sync), true);
    assert.equal(db.has(ref.sync + 1), false);
    assert.equal(db.syncAtOrBefore('1999-01-01'), undefined);
    assert.equal(db.syncAtOrBefore('2999-01-01'), ref.sync);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the five delta kinds are a closed set, pinned against a literal list and the frozen schema', () => {
  assert.deepEqual([...DELTA_KINDS], ['built', 'gate', 'writer', 'contract', 'verdict']);
  assert.deepEqual([...DELTA_CHANGES], ['added', 'removed', 'changed']);
  assert.deepEqual([...DELTA_DOORS], ['gate', 'move', 'cases', 'contract', 'screen']);
  assert.deepEqual(schema.$defs.deltaKind.enum, [...DELTA_KINDS]);
  assert.deepEqual(schema.$defs.delta.properties.change.enum, [...DELTA_CHANGES]);
  assert.deepEqual(schema.$defs.delta.properties.door.properties.kind.enum, [...DELTA_DOORS]);
  // farsight-diff v1 grew by one change kind per delta kind, additively: every earlier kind is where it was
  assert.deepEqual(
    CHANGE_KINDS.slice(-5),
    DELTA_KINDS.map((k) => `storyline_${k}`),
  );
  assert.deepEqual(schema.$defs.changeKind.enum, [...CHANGE_KINDS]);
  assert.deepEqual(schema.properties.counts.required, [...CHANGE_KINDS]);
  assert.ok((COUNT_SCOPES as readonly string[]).includes('count.scope.compare'));
  // every kind and every way it went has its words, both registers
  for (const k of DELTA_KINDS) {
    assert.notEqual(t(`compare.kind.${k}`), `compare.kind.${k}`);
    assert.notEqual(t(`count.part.delta.${k}`), `count.part.delta.${k}`);
  }
  for (const c of DELTA_CHANGES) assert.notEqual(t(`compare.change.${c}`), `compare.change.${c}`);
});

/** A diff as storylineDiff returns it, written by hand: one delta of each kind. */
function handDiff(): StorylineDiff {
  const counts = {
    n: 5,
    unit: 'count.unit.deltas',
    bizUnit: 'count.unit.deltas',
    scope: 'count.scope.compare',
    source: 'test',
    breakdown: DELTA_KINDS.map((k) => ({ key: `count.part.delta.${k}`, n: 1 })),
  };
  const s = (key: string, args: Record<string, string>) => ({ key, args });
  return {
    storyline: { id: 'invoice', name: 'An invoice, end to end', repo: 'invoice-app' },
    from: { sync: 1, at: '2026-10-01T00:00:00Z', metaKept: true },
    to: { sync: 2, at: '2026-10-08T00:00:00Z', commit: 'abcdef0123', metaKept: true },
    journeys: [{ flow: 'invoice-app::flow::billing-cycle', name: 'Billing cycle' }],
    deltas: [
      {
        id: 'd1',
        kind: 'built',
        change: 'added',
        subject: { id: 'p', name: 'Discard draft', kind: 'page' },
        journeys: ['invoice-app::flow::billing-cycle'],
        screen: { id: 'p', name: 'Discard draft', flow: 'invoice-app::flow::billing-cycle', index: 3 },
        from: 'notBuilt',
        to: 'built',
        sentence: s('compare.delta.built.added', { screen: 'Discard draft' }),
        biz: s('map.biz.compare.built.added', { screen: 'Discard draft' }),
        door: { kind: 'screen', key: 'compare.door.screen', flow: 'invoice-app::flow::billing-cycle', screen: 3 },
      },
      {
        id: 'd2',
        kind: 'gate',
        change: 'removed',
        subject: { id: 'g', name: 'requireScope: billing:read', kind: 'guard' },
        target: { id: 'r', name: 'GET /invoices', kind: 'route' },
        journeys: ['invoice-app::flow::billing-cycle'],
        tier: 'business',
        loc: { repo: 'invoice-app', path: 'src/server/routes.ts', line: 8 },
        sentence: s('compare.delta.gate.removed', {
          screen: 'Invoice list',
          gate: 'requireScope (billing:read)',
          call: 'GET /invoices',
        }),
        biz: s('map.biz.compare.gate.removed', { screen: 'Invoice list', words: 'billing:read' }),
        door: { kind: 'gate', key: 'compare.door.gate', node: 'g' },
      },
      {
        id: 'd3',
        kind: 'writer',
        change: 'added',
        subject: { id: 'w', name: 'approveInvoice', kind: 'function' },
        target: { id: 'invoices', name: 'invoices', kind: 'table' },
        journeys: [],
        status: 'approved',
        sentence: s('compare.delta.writer.added', { status: 'approved', writer: 'approveInvoice', record: 'invoices' }),
        biz: s('map.biz.compare.writer.added', { status: 'Approved', record: 'invoices' }),
        door: { kind: 'move', key: 'compare.door.move', node: 'w' },
      },
      {
        id: 'd4',
        kind: 'contract',
        change: 'added',
        subject: { id: 'o', name: 'POST /invoices/:id/send', kind: 'route' },
        journeys: ['invoice-app::flow::billing-cycle'],
        from: 'none',
        to: 'both',
        called: true,
        sentence: s('compare.delta.contract.added', { op: 'POST /invoices/:id/send' }),
        biz: s('map.biz.compare.contract.added', { what: 'Send an invoice' }),
        door: { kind: 'contract', key: 'compare.door.contract', node: 'o', api: 'invoice-app::api::openapi.yaml' },
      },
      {
        id: 'd5',
        kind: 'verdict',
        change: 'changed',
        subject: { id: 'invoice-app::flow::billing-cycle', name: 'Billing cycle', kind: 'flow' },
        journeys: ['invoice-app::flow::billing-cycle'],
        from: 'passed',
        to: 'skipped',
        sentence: s('compare.delta.verdict.changed', { journey: 'Billing cycle', from: 'passed', to: 'skipped' }),
        biz: s('map.biz.compare.verdict.changed', { journey: 'Billing cycle', from: 'passed', to: 'skipped' }),
        door: { kind: 'cases', key: 'compare.door.cases', flow: 'invoice-app::flow::billing-cycle' },
      },
    ],
    byJourney: [],
    counted: {
      deltas: counts,
      journeys: {
        n: 1,
        of: 1,
        unit: 'count.unit.journeysChanged',
        bizUnit: 'count.unit.journeysChanged',
        scope: 'count.scope.compare',
        source: 'test',
      },
    },
    notes: [],
  } as StorylineDiff;
}

test('the document is farsight-diff v1: one storyline_<kind> change per delta, counts complete, the storyline block', () => {
  const diff = handDiff();
  for (const c of Object.values(diff.counted)) assert.deepEqual(countedProblems(c), []);
  const doc = storylineDiffDocument(diff);
  assert.deepEqual(validate(doc, schema), []);
  assert.equal(doc.base, 'sync:1');
  assert.equal(doc.head, 'sync:2 · abcdef0');
  assert.deepEqual(
    doc.changes.map((c) => c.kind),
    ['storyline_built', 'storyline_gate', 'storyline_writer', 'storyline_contract', 'storyline_verdict'],
  );
  for (const k of CHANGE_KINDS) assert.equal(typeof doc.counts[k], 'number');
  assert.deepEqual(doc.storyline!.byKind, { built: 1, gate: 1, writer: 1, contract: 1, verdict: 1 });
  assert.equal(
    doc.changes[1]!.delta!.text,
    'Invoice list lost a gate: requireScope (billing:read) no longer guards GET /invoices',
  );
  assert.equal(doc.changes[1]!.delta!.biz, 'Invoice list lost a check: billing:read');
  assert.equal(doc.changes[0]!.permalink, '/compare/1...2#c1');
  assert.equal(doc.gate, undefined);
});

test('--fail-on: a listed kind that changed fails the gate block (exit 1); an unlisted one never does', () => {
  const doc = storylineDiffDocument(handDiff(), { failOn: ['gate', 'verdict'] });
  assert.deepEqual(validate(doc, schema), []);
  assert.equal(doc.gate!.result, 'fail');
  assert.equal(doc.gate!.exit, 1);
  assert.deepEqual(
    doc.gate!.rules.map((r) => [r.rule, r.changes]),
    [
      ['fail on gate', ['c2']],
      ['fail on verdict', ['c5']],
    ],
  );
  const quiet = handDiff();
  quiet.deltas = quiet.deltas.filter((d) => d.kind === 'built');
  assert.equal(storylineDiffDocument(quiet, { failOn: ['gate'] }).gate!.exit, 0);
  assert.deepEqual(parseFailOn('gate, verdict,colour'), { kinds: ['gate', 'verdict'], unknown: ['colour'] });
});

test(
  'the sync before is the newest earlier sync that read other code; no green run is an absence, not an error',
  opts,
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'farsight-compare-'));
    try {
      const db = new SnapshotDb(join(dir, 'farsight.db'));
      const at = (commit: string) => {
        const store = new GraphStore();
        store.addFragment({
          repo: 'r',
          nodes: [{ id: 'r::a', kind: 'function', name: 'a', tags: [] } as GraphNode],
          edges: [],
        });
        return db.write(store, { commit }).sync;
      };
      const one = at('a'.repeat(40));
      const two = at('b'.repeat(40));
      const three = at('b'.repeat(40));
      // swarm round 3: nine syncs re-read one commit, so *the sync before* compared to nothing — it skips them now
      assert.equal(db.previous(three), two);
      assert.equal(db.previousChanged(three), one);
      assert.deepEqual(resolveCompareFrom(db, 'previous', { head: three, storyline: 's' }), {
        sync: one,
        how: 'previous',
      });
      // the first sync has nothing before it, changed or not
      assert.equal(db.previousChanged(one), undefined);
      const green = resolveCompareFrom(db, 'last-green', { head: three, storyline: 's', lastGreen: () => undefined });
      assert.ok('error' in green && green.noGreen && green.absent === 'notIndexed');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
