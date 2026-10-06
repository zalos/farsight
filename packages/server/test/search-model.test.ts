// Fast travel's index (public/app/lib/search-model.js) — a proof and a guard. Proof: on the synthetic
// workspace (scripts/synth-graph.mjs, small preset) every query ranks exactly what shell.js `searchNodes`
// ranked before the index — the same score per node, the same order, ties to the earlier node — typed at
// once or one key at a time (the narrowing path), in scope or not. Guard: a keystroke over the folded
// strings stays well under the palette's 50 ms on that graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const M = await import(join(here, '..', 'public', 'app', 'lib', 'search-model.js'));
const SYN = await import(join(here, '..', '..', '..', 'scripts', 'synth-graph.mjs'));
type AnyRec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const graph = SYN.synthesize(SYN.parseArgs(['--preset', 'small']));
const nodes: AnyRec[] = graph.nodes;
// stand-ins for store.js bizName / bizLabel (the module touches window): any deterministic name works for the proof
const bizLabel = (n: AnyRec) => (n.facets && n.facets.business && n.facets.business.label) || String(n.name || '').replace(/([a-z])([A-Z])/g, '$1 $2');
const bizName = (n: AnyRec) => bizLabel(n).replace(/[_-]/g, ' ');
const repoOf = (n: AnyRec) => (n.loc && n.loc.repo) || String(n.id).split('::')[0];

/** shell.js searchNodes's node half as it was before the index (projects are ranked apart, unchanged). */
function naive(q: string, repos: Set<string> | null) {
  const raw = String(q || '').trim().toLowerCase();
  const terms = raw.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return nodes.filter((n) => (!repos || repos.has(repoOf(n))) && n.kind !== 'module' && n.kind !== 'package').map((n) => {
    const name = String(n.name || '').toLowerCase();
    const ident = name.split(':')[0]!.trim();
    const tail = String(n.id || '').split('::').pop()!.toLowerCase();
    const words = bizName(n).toLowerCase();
    const label = bizLabel(n).toLowerCase();
    const hay = (name + ' ' + words + ' ' + label + ' ' + (n.tags || []).join(' ') + ' ' + (n.docs || '') + ' ' + ((n.loc && n.loc.path) || '')).toLowerCase();
    let score = 0;
    if (ident === raw || tail === raw || name === raw || words === raw || label === raw) score += 100;
    for (const term of terms) {
      if (ident === term || words === term || label === term) score += 10;
      else if (ident.includes(term) || name.includes(term) || words.includes(term) || label.includes(term)) score += 5;
      else if ((n.tags || []).some((x: string) => x.includes(term))) score += 4;
      else if (hay.includes(term)) score += 1;
    }
    if (score > 0) score += M.KIND_BONUS[n.kind] || 0;
    return { n, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 12).map((r) => [r.n.id, r.score]);
}
const QUERIES = ['i', 'in', 'inv', 'invo', 'invoice', 'invoice p', 'invoice panel', 'list', 'listInvoice', 'ux', 'src01', 'flow',
  'approve a', 'billing', 'contract-9.spec', 'zzz', 'Refund', 'getcustomer', 'the', 'GET /api', '/api/invoices'];

test('every query ranks what the per-node scan ranked', () => {
  const index = M.buildSearchIndex(nodes, { bizName, bizLabel, repoOf });
  for (const repos of [null, new Set(['src01', 'src03'])]) {
    for (const q of QUERIES) {
      index.last = null;
      const got = M.searchIndex(index, q, repos).hits.map((h: AnyRec) => [h.n.id, h.score]);
      assert.deepEqual(got, naive(q, repos), `${q} in ${repos ? [...repos] : 'all'}`);
    }
  }
});

test('typed one key at a time, the narrowed answer is the full answer', () => {
  const index = M.buildSearchIndex(nodes, { bizName, bizLabel, repoOf });
  const repos = null;
  for (const word of ['invoice panel', 'approve a customer', 'src02-web']) {
    for (let i = 1; i <= word.length; i++) {
      const q = word.slice(0, i);
      const got = M.searchIndex(index, q, repos).hits.map((h: AnyRec) => [h.n.id, h.score]);
      assert.deepEqual(got, naive(q, repos), q);
    }
  }
  // a new scope is not narrowed from the last one
  const one = new Set(['src00']);
  assert.deepEqual(M.searchIndex(index, 'invoice', one).hits.map((h: AnyRec) => [h.n.id, h.score]), naive('invoice', one));
});

test('a keystroke over the folded strings is well under the palette budget', () => {
  const index = M.buildSearchIndex(nodes, { bizName, bizLabel, repoOf });
  const t0 = performance.now();
  for (const q of ['i', 'in', 'inv', 'invo', 'invoi', 'invoic', 'invoice']) M.searchIndex(index, q, null);
  const per = (performance.now() - t0) / 7;
  assert.ok(per < 25, `a keystroke took ${per.toFixed(1)} ms over ${nodes.length} nodes`);
});

test('fast travel finds a storyline by its name or id, outranks a journey on a tie, and lands on the Map (or the front door with the Map off)', () => {
  const metas = {
    app: { storylines: [{ id: 'invoice', name: 'An invoice, end to end', description: 'From upload to payment.', journeys: ['a', 'b'], branches: [{ id: 'c' }] }] },
    other: { storylines: [{ id: 'invoice', name: 'A duplicate id' }, { id: 'vendor', name: 'A vendor account', journeys: ['x'] }] },
  };
  const items = M.storylineTravelItems(metas, null, true);
  assert.deepEqual(items.map((x: AnyRec) => [x.id, x.repo, x.hash, x.steps, x.branches]), [
    ['storyline:invoice', 'app', '#/map?storyline=invoice', 2, 1],
    ['storyline:vendor', 'other', '#/map?storyline=vendor', 1, 0],
  ], 'one row per storyline id');
  assert.equal(M.storylineTravelItems(metas, null, false)[0].hash, '#/journeys?storyline=invoice');
  assert.deepEqual(M.storylineTravelItems(metas, new Set(['other']), true).map((x: AnyRec) => x.storyline), ['invoice', 'vendor'], 'scope narrows');
  const inv = items[0];
  const score = (q: string) => { const raw = q.toLowerCase(); return M.scoreStoryline(inv, raw, raw.split(/\s+/)); };
  assert.ok(score('invoice') > 0);
  assert.ok(score('invoice') > 100, 'an exact id is an exact hit');
  assert.ok(score('end to end') > 0);
  assert.ok(score('payment') > 0, 'its sentence counts, a little');
  assert.equal(score('nothing'), 0);
  // a word in the name scores as a journey's would, plus a higher kind bonus: the storyline leads a tie
  assert.equal(score('end'), 5 + M.KIND_BONUS.storyline);
  assert.ok(M.KIND_BONUS.storyline > M.KIND_BONUS.flow);
});
