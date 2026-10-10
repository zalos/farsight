// The gate card's fold (swarm-fixes 2026-10-05, finding 4). `public/app/lib/gate-card-model.js` decides what the
// one card says for any gate whichever surface opened it: the facts the page has by lookup (never a scan of the
// graph's edges), the sentence — written words, else the @guard requirement, else who should write it — and the
// service's calls and tests, capped with the rest counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { gateFacts, gateSentence, gateCardModel, nameParts, GATE_CARD_CAP, tierLine, preconditionCode } = await import(join(here, '..', 'public', 'app', 'lib', 'gate-card-model.js'));

const G = 'app::src/auth.ts::requireOwner';
const R = 'app::src/rules.ts::invoiceShape';
const C = 'app::src/env.ts::resolveDevLogin';
const byId: Record<string, any> = {
  [G]: { id: G, kind: 'guard', name: 'requireOwner: owns the invoice', loc: { repo: 'app', path: 'src/auth.ts', line: 12 }, docs: 'Refuses anyone but the owner. More text.', project: { name: 'auth' }, tags: ['auth'] },
  [R]: { id: R, kind: 'rule', name: 'invoiceShape', loc: { repo: 'app', path: 'src/rules.ts', line: 3 }, tags: [] },
  [C]: { id: C, kind: 'guard', name: 'resolveDevLogin: dev sign-in only under mock', tags: ['auth', 'config-check'], facets: { business: { description: 'Keeps the developer sign-in out of real environments.' } } },
  'app::src/svc.ts::approve': { id: 'app::src/svc.ts::approve', kind: 'function', name: 'approve' },
  'app::route::POST /invoices': { id: 'app::route::POST /invoices', kind: 'route', name: 'POST /invoices' },
};
// the per-node edge index (store.js S.EDGES_OF): only the gate's own edges are read
let reads = 0;
const edgesOf = {
  get(id: string) {
    reads++;
    if (id === G) return [
      { kind: 'guards', from: G, to: 'app::src/svc.ts::approve' },
      { kind: 'guards', from: G, to: 'app::route::POST /invoices' },
      { kind: 'guards', from: G, to: 'app::route::POST /invoices' },
      { kind: 'calls', from: 'app::src/svc.ts::approve', to: G },
    ];
    if (id === R) return [{ kind: 'validates', from: R, to: 'app::route::POST /invoices' }];
    return [];
  },
};
const ctx = { byId, edgesOf };

test('the facts by lookup: kind, words, place and what it sits on — each part once, from the gate\'s own edges', () => {
  reads = 0;
  const f = gateFacts(G, ctx);
  assert.equal(f.gateKind, 'guard');
  assert.equal(f.configCheck, false);
  assert.equal(f.ident, 'requireOwner');
  assert.equal(f.phrase, 'owns the invoice');
  assert.equal(f.docs, 'Refuses anyone but the owner.');
  assert.equal(f.project, 'auth');
  assert.deepEqual(f.sitsOn.map((p: any) => p.id), ['app::src/svc.ts::approve', 'app::route::POST /invoices']);
  assert.equal(reads, 1, 'one lookup, no scan');
  assert.equal(gateFacts(R, ctx).gateKind, 'rule');
  assert.equal(gateFacts(C, ctx).configCheck, true, 'the parser\'s tag');
  assert.equal(gateFacts(G, ctx, { config: true }).configCheck, true, 'the journey\'s word');
  assert.equal(gateFacts('app::src/svc.ts::approve', ctx), null, 'not a gate');
  assert.deepEqual(nameParts('a: b: c'), { ident: 'a', phrase: 'b: c' });
});

test('the sentence: written words first, then the requirement, else who should write it — by register', () => {
  const c = gateSentence(gateFacts(C, ctx), 'dev sign-in only under mock', 'hybrid');
  assert.equal(c.says.source, 'business');
  assert.equal(c.config, 'gate.config.sentence');
  const g = gateSentence(gateFacts(G, ctx), 'owns the invoice', 'hybrid');
  assert.deepEqual([g.says.source, g.says.key, g.says.words], ['phrase', 'gate.says.phrase', 'owns the invoice']);
  assert.equal(g.who, null);
  assert.equal(g.docs, 'Refuses anyone but the owner.');
  const r = gateSentence(gateFacts(R, ctx), '', 'code');
  assert.equal(r.says.key, 'gate.says.none');
  assert.deepEqual(r.who, { key: 'gate.who.code', vars: { ident: 'invoiceShape', path: 'src/rules.ts:3' } });
  const rb = gateSentence(gateFacts(R, ctx), '', 'business');
  assert.deepEqual(rb.who, { key: 'gate.who.bizNoProject', vars: {} });
  assert.equal(gateSentence(gateFacts(G, ctx), '', 'business').who.key, 'gate.who.biz');
  assert.equal(gateSentence(gateFacts(G, ctx), '', 'business').docs, '', 'the developer\'s doc comment is not the business register\'s');
  // a written sentence that is all code is no sentence in business
  const plain = (s: string) => (/[A-Z][a-z]+[A-Z]/.test(s) ? '' : s);
  const coded = { ...gateFacts(C, ctx), business: 'resolveDevLogin()' };
  assert.equal(gateSentence(coded, 'dev sign-in only under mock', 'business', plain).says.source, 'phrase');
});

test('the card: pending until the service answers, then the calls and tests capped with the rest counted', () => {
  const pending = gateCardModel(G, ctx, { answer: null });
  assert.equal(pending.pending, true);
  assert.equal(pending.calls, null);
  assert.equal(gateCardModel(G, ctx, { answer: false }).failed, true);
  const calls = Array.from({ length: GATE_CARD_CAP + 3 }, (_, i) => ({ id: 'r' + i, name: 'GET /r' + i, depth: i % 2 }));
  const tests = [{ id: 't1', name: 'owner only', level: 'unit', reaches: { nodeId: G } }, { id: 't2', name: 'e2e', level: 'e2e', reaches: { nodeId: 'r0' } }];
  const m = gateCardModel(G, ctx, { answer: { calls, pages: [], tests, testsOnGate: 1, counted: { calls: { n: calls.length } }, chip: 'reached', evidenceWord: { cls: 'reached', key: 'journey.evidence.reached' }, gate: { configCheck: true } } });
  assert.equal(m.kind, 'config', 'the service\'s word that it is a config check');
  assert.equal(m.calls.rows.length, GATE_CARD_CAP);
  assert.equal(m.calls.more, 3);
  assert.equal(m.calls.total, GATE_CARD_CAP + 3);
  assert.deepEqual(m.tests.rows.map((t: any) => t.onGate), [true, false]);
  assert.equal(m.evidence.chip, 'reached');
  assert.equal(gateCardModel('nope', ctx, {}), null);
});

// gates lane 2026-10-10: the card's tier line, from the service's fold, and a precondition's code form
test('the tier line says the tier, why, the code form outside business, and where the tier came from', () => {
  const pre = { record: 'contractors', field: 'status', requires: ['ACTIVE'], kind: 'state', else: '409 conflict' };
  const g = { tier: 'business', class: 'record-state', tierFrom: 'class', precondition: pre };
  assert.deepEqual(tierLine(g, 'hybrid'), {
    tier: 'business', tierKey: 'gate.tier.business', classKey: 'gate.class.record-state', fromKey: 'gate.tierFrom.class',
    code: 'contractors.status = ACTIVE', elseText: '409 conflict',
  });
  assert.equal(tierLine(g, 'business').code, '', 'the business register prints no code form');
  assert.equal(tierLine({ tier: 'policy', class: 'integrity', tierFrom: 'config' }, 'code').fromKey, 'gate.tierFrom.config');
  assert.equal(preconditionCode({ record: 'links', field: 'status', requires: [], excludes: ['PENDING', 'REJECTED'], kind: 'state' }), 'links.status not in {PENDING, REJECTED}');
  assert.equal(preconditionCode({ record: 'invoices', field: 'lines', requires: [], kind: 'present' }), 'invoices.lines not empty');
  assert.equal(preconditionCode({ record: 'invoices', field: 'status', requires: ['A', 'B'], kind: 'state' }), 'invoices.status in {A, B}');
});
