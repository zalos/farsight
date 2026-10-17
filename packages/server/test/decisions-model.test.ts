// The viewer's decisions module (lib/decisions.js, the 2026-10-13 outsider round, F8): the rows `GET /api/decisions`
// answers, indexed by the nodes they bear on, and the chip's words — pure parts only (the card reads the catalog).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
(globalThis as any).window = (globalThis as any).window ?? globalThis;
(globalThis as any).document = (globalThis as any).document ?? { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
const { indexDecisions } = await import(join(here, '..', 'public', 'app', 'lib', 'decisions.js'));

test('decisions are indexed by every node they bear on, and by source and id', () => {
  const rows = [
    { repo: 'r', id: 'D1', declared: true, state: 'open', title: 'Limit', nodes: ['r::a', 'r::b'], sites: [] },
    { repo: 'r', id: 'D2', declared: false, nodes: ['r::a'], sites: [{ path: 'x.ts', line: 3, symbol: 'FLAG' }] },
  ];
  const ix = indexDecisions(rows);
  assert.deepEqual(ix.byNode.get('r::a').map((r: any) => r.id), ['D1', 'D2']);
  assert.deepEqual(ix.byNode.get('r::b').map((r: any) => r.id), ['D1']);
  assert.equal(ix.byId.get('r|D2').declared, false);
  assert.equal(ix.byNode.get('r::c'), undefined);
});
