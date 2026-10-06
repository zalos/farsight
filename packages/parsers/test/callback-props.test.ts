// Callback props (parsers/src/callback-props.ts): a screen that is a form makes no call of its own —
// its submit runs `onConfirm(...)`, a prop — and the parent wrote the arrow that calls the API, here
// two components up with the middle one passing the prop straight through. The shape the reference
// app reported on 2026-10-05: a state screen bound to `MarkPaidForm` read *0 actions · calls: none
// indexed* while its page carried the POST. The child that runs the function is where the person
// presses the button, so the call is credited there — and never to a shared component rendered from
// many places. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo } from '../dist/index.js';
import { buildIndex, journey, journeySummary, screensFor } from '@farsight/core';
import type { GraphFragment } from '@farsight/core';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-cbprops-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const FILES: Record<string, string> = {
  'package.json': '{"name":"cb"}',
  'src/api.ts': [
    "export function markPaid(id: string, body: { paidOn: string }) { return fetch(`/api/payouts/${id}/mark-paid`, { method: 'POST', body: JSON.stringify(body) }); }",
    "export function recordIntent(id: string) { return fetch(`/api/payouts/${id}/intent`, { method: 'POST' }); }",
    "export function loadPayout(id: string) { return fetch(`/api/payouts/${id}`); }",
  ].join('\n'),
  'src/model.ts': [
    'export function markPaidState(status: string, roles: string[]) {',
    "  if (!roles.includes('approver')) return { enabled: false, reason: 'Marking paid needs the approver role.' };",
    "  if (status === 'PAID') return { enabled: false, reason: 'Already paid.' };",
    '  return { enabled: true };',
    '}',
    'export function formatAmount(n: number) { return `$${n}`; }',
  ].join('\n'),
  'src/server.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.post('/api/payouts/:id/mark-paid', (req, res) => res.json({}));",
    "app.post('/api/payouts/:id/intent', (req, res) => res.json({}));",
    "app.get('/api/payouts/:id', (req, res) => res.json({}));",
  ].join('\n'),
  // a shared primitive: rendered from several places, so it runs a different function at each
  'src/Button.tsx': [
    'export function Button({ onClick, children }: { onClick?: () => void; children?: unknown }) {',
    '  return <button onClick={onClick}>{children}</button>;',
    '}',
  ].join('\n'),
  'src/WeeklyCycle.tsx': [
    "import { useState } from 'react';",
    "import { markPaid, recordIntent, loadPayout } from './api';",
    "import { markPaidState, formatAmount } from './model';",
    "import { Button } from './Button';",
    'export function WeeklyCycle({ id, roles }: { id: string; roles: string[] }) {',
    '  const [busy, setBusy] = useState(false);',
    '  const act = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); setBusy(false); };',
    '  const paid = markPaidState(\'SCHEDULED\', roles);',
    '  const amount = formatAmount(200);',
    '  const payout = loadPayout(id);',
    '  return (',
    '    <section>',
    '      <Payout',
    '        id={id}',
    '        paid={paid}',
    '        amount={amount}',
    '        payout={payout}',
    '        onMarkPaid={(paidOn: string) =>',
    '          act(async () => {',
    '            await markPaid(id, { paidOn });',
    '          })',
    '        }',
    '      />',
    '      <Button onClick={() => recordIntent(id)}>Record intent</Button>',
    '    </section>',
    '  );',
    '}',
    // the middle component: decides on one value, shows another, passes the callback straight through
    'function Payout({ id, paid, amount, payout, onMarkPaid }: { id: string; paid: { enabled: boolean }; amount: string; payout: unknown; onMarkPaid: (d: string) => Promise<void> }) {',
    '  return (',
    '    <article>',
    '      {paid.enabled ? <MarkPaidForm onConfirm={onMarkPaid} /> : <p>{amount}</p>}',
    '      <Button onClick={() => {}}>Cancel</Button>',
    '      <pre>{String(payout)}</pre>',
    '    </article>',
    '  );',
    '}',
    'function MarkPaidForm({ onConfirm }: { onConfirm: (paidOn: string) => Promise<void> }) {',
    "  const [paidOn] = useState('2026-10-05');",
    '  return (',
    '    <form',
    '      onSubmit={(event) => {',
    '        event.preventDefault();',
    '        void onConfirm(paidOn);',
    '      }}',
    '    >',
    '      <Button>Confirm — mark paid</Button>',
    '    </form>',
    '  );',
    '}',
  ].join('\n'),
  'docs/design/screens.json': JSON.stringify({
    name: 'cb',
    screens: [
      { id: 'OPS-05', name: 'Weekly cycle', component: 'WeeklyCycle' },
      { id: 'OPS-05.mark-paid', name: 'Weekly cycle — confirm the payout is paid', component: 'MarkPaidForm' },
    ],
    flows: [{ id: 'weekly', name: 'Weekly cycle', screens: ['OPS-05', 'OPS-05.mark-paid'] }],
  }),
};

let cached: GraphFragment | undefined;
async function graph(): Promise<GraphFragment> {
  cached ??= await ingestRepo(tempRepo(FILES), { repoName: 'cb', openapi: false, tests: false, stories: false, projects: false });
  return cached;
}
const id = (name: string) => `cb::src/WeeklyCycle.tsx::${name}`;
const cbEdges = (g: GraphFragment) => g.edges.filter((e) => e.resolution?.technique === 'callback-prop');

test('the form that runs onConfirm carries the call its grandparent wrote, through a pass-through parent', async () => {
  const g = await graph();
  const e = g.edges.find((x) => x.kind === 'calls' && x.from === id('MarkPaidForm') && x.to === 'cb::src/api.ts::markPaid');
  assert.ok(e, 'MarkPaidForm → markPaid');
  assert.equal(e!.resolution?.technique, 'callback-prop');
  assert.equal(e!.resolution?.confidence, 'MEDIUM');
  assert.equal(e!.meta?.via, 'callback-prop');
  assert.equal(e!.meta?.prop, 'onConfirm');
  assert.equal(e!.meta?.handedBy, id('WeeklyCycle'));
  // the line is where the child runs it — the submit handler — so the walk orders it among the child's own steps
  assert.equal(e!.meta?.line, FILES['src/WeeklyCycle.tsx']!.split('\n').findIndex((l) => l.includes('void onConfirm(paidOn)')) + 1);
  // the parent keeps its own edge: the arrow is written in its body
  assert.ok(g.edges.some((x) => x.kind === 'calls' && x.from === id('WeeklyCycle') && x.to === 'cb::src/api.ts::markPaid' && !x.resolution?.technique.startsWith('callback')));
  // the pass-through parent only hands it on: it runs nothing
  assert.ok(!g.edges.some((x) => x.from === id('Payout') && x.to === 'cb::src/api.ts::markPaid'));
});

test('a shared component rendered from many places is never credited with one caller\'s function', async () => {
  const g = await graph();
  assert.ok(!g.edges.some((x) => x.from === 'cb::src/Button.tsx::Button' && x.to === 'cb::src/api.ts::recordIntent'));
  assert.ok(!cbEdges(g).some((x) => x.from === 'cb::src/Button.tsx::Button'));
});

test('a value the parent computed is credited only where the child decides on it, and never a data load', async () => {
  const g = await graph();
  const v = g.edges.find((x) => x.from === id('Payout') && x.to === 'cb::src/model.ts::markPaidState');
  assert.ok(v, 'Payout decides on paid.enabled → shows markPaidState\'s answer');
  assert.equal(v!.meta?.via, 'prop-value');
  // shown, not decided on: no edge
  assert.ok(!g.edges.some((x) => x.from === id('Payout') && x.to === 'cb::src/model.ts::formatAmount'));
  // a fetch is the parent's load, not an answer the child shows
  assert.ok(!g.edges.some((x) => x.from === id('Payout') && x.to === 'cb::src/api.ts::loadPayout'));
  assert.equal(cbEdges(g).length, 2, cbEdges(g).map((x) => `${x.from} → ${x.to}`).join('\n'));
});

test('the journey walks the state screen into its call, the route and on — the same walk every surface reads', async () => {
  const g = await graph();
  const index = buildIndex(g.nodes, g.edges);
  const flow = g.nodes.find((n) => n.kind === 'flow')!;
  const j = journey(index, flow.id);
  const sum = journeySummary(index, j, screensFor(index, flow.id));
  const seg = sum.segments.find((s) => s.screen?.designId === 'OPS-05.mark-paid');
  assert.ok(seg, 'the state row is a segment');
  // the segment opens at the form and its first step is the call the form runs (in this small
  // fixture the page's later siblings follow it in the same segment; on a real page they do not)
  assert.ok(seg!.counts.calls >= 1);
  assert.equal(seg!.markers[0]!.name, 'markPaid');
  assert.ok(seg!.markers.some((m) => m.kind === 'call' && m.name.includes('/mark-paid')), seg!.markers.map((m) => m.name).join(', '));
});
