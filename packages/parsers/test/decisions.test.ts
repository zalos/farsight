// Declared decisions, off-platform steps, party externals and cited documents (the 2026-10-13 outsider round, F8 +
// F11). The invoice app declares one decision (D1, open, with an ADR) on its manifest, names it in code above the
// approval, names a second one (D2) in code only above a module-level flag constant, declares a step the customer's
// bank does outside the app and the bank as a party; then small synthetic sources for the collision note, the config
// override and an ADR cited in a sentence. Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo, readDocQuote } from '../dist/index.js';
import {
  buildIndex,
  decisionsFor,
  decisionsCounted,
  countedProblems,
  offPlatformSteps,
  partiesOf,
} from '@farsight/core';

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');
const temps: string[] = [];
process.on('exit', () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-decisions-'));
  temps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const only = { openapi: false, tests: false, stories: false, projects: false } as const;
const screens = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ screens: [{ id: 'S-1', name: 'One', route: '/one' }], ...extra });

test('the invoice app: D1 declared and named above the approval, D2 named in code only above a flag constant', async () => {
  const g = await ingestRepo(join(EXAMPLES, 'invoice-app'), { repoName: 'invoice-app', ...only });
  const m = g.meta!.decisions!;
  assert.ok(m, 'meta.decisions is folded at ingest');
  const d1 = m.decisions.find((d) => d.id === 'D1')!;
  assert.equal(d1.declared, true);
  assert.equal(d1.state, 'open');
  assert.equal(d1.owner, 'Operations lead');
  assert.equal(d1.from, 'docs/design/screens.json');
  // the comment sits above the approval's doc comment: the node is the function under both
  assert.deepEqual(
    d1.sites.map((s) => `${s.path}:${s.nodeId?.split('::').pop()}`),
    ['src/server/approvals.ts:approveInvoice'],
  );
  assert.equal(d1.sites[0]!.text, 'one approver, whatever the amount, until a limit is decided');
  // affects INV-01 → the list page's node
  assert.ok(d1.nodes.includes('invoice-app::page::/invoices'), d1.nodes.join(', '));
  // the ADR quoted verbatim: its title and its first paragraph, the Status line apart
  assert.equal(d1.docRef?.title, 'ADR 0001 — Approval has no amount limit yet');
  assert.ok(
    d1.docRef?.quote?.startsWith('An invoice is approved by one person holding the billing admin scope'),
    d1.docRef?.quote,
  );
  const d2 = m.decisions.find((d) => d.id === 'D2')!;
  assert.equal(d2.declared, false);
  assert.equal(d2.sites[0]!.symbol, 'SEND_PAYMENT_REMINDERS');
  assert.equal(d2.sites[0]!.nodeId, undefined);
  assert.ok(
    m.notes.some((n) => n.includes('"D2" is named in code')),
    m.notes.join('\n'),
  );
  // the node carries the id; decisionsFor finds it
  const index = buildIndex(g.nodes, g.edges);
  const approve = g.nodes.find((n) => n.id === 'invoice-app::src/server/approvals.ts::approveInvoice')!;
  assert.deepEqual(approve.decisions, ['D1']);
  assert.deepEqual(
    decisionsFor(index, { 'invoice-app': m }, approve.id).map((d) => d.id),
    ['D1'],
  );
  // the counts: three ways by state, two by citation, each a sound partition
  const c = decisionsCounted({ 'invoice-app': m });
  assert.equal(c.decisions.n, 2);
  assert.deepEqual(
    c.decisions.breakdown!.map((p) => p.n),
    [1, 0, 1],
  );
  assert.deepEqual(
    c.cited.breakdown!.map((p) => p.n),
    [2, 0],
  );
  assert.deepEqual([...countedProblems(c.decisions), ...countedProblems(c.cited)], []);
});

test('the invoice app: the customer bank is a party no code reaches, and INV-01 declares a step it does', async () => {
  const g = await ingestRepo(join(EXAMPLES, 'invoice-app'), { repoName: 'invoice-app', ...only });
  const index = buildIndex(g.nodes, g.edges);
  const parties = partiesOf(index, 'invoice-app');
  assert.deepEqual(
    parties.map((p) => p.name),
    ['Customer bank'],
  );
  assert.equal(parties[0]!.external?.kind, 'party');
  assert.equal(parties[0]!.loc, undefined);
  assert.equal((index.in.get(parties[0]!.id) ?? []).length, 0, 'declared, no code reaches it');
  const list = g.nodes.find((n) => n.design?.id === 'INV-01')!;
  const steps = offPlatformSteps(index, list);
  assert.deepEqual(
    steps.map((s) => `${s.id}:${s.by}:${s.party?.name}`),
    ['INV-01.1:partner:Customer bank'],
  );
  // the ERP stays the declared client class it was
  assert.ok(g.nodes.some((n) => n.kind === 'external' && n.name === 'Example ERP'));
});

test('the invoice app: a flow that lists the ADR cites it, and the doc node quotes it', async () => {
  const g = await ingestRepo(join(EXAMPLES, 'invoice-app'), { repoName: 'invoice-app', ...only });
  const doc = g.nodes.find((n) => n.kind === 'doc' && n.doc?.path === 'docs/decisions/0001-approval-limits.md')!;
  assert.ok(
    doc,
    g.nodes
      .filter((n) => n.kind === 'doc')
      .map((n) => n.id)
      .join(', '),
  );
  assert.equal(doc.doc?.status, 'Proposed');
  assert.equal(doc.loc, undefined);
  const flow = g.nodes.find((n) => n.kind === 'flow' && n.design?.id === 'draft-and-send')!;
  assert.ok(
    g.edges.some((e) => e.kind === 'cites' && e.from === flow.id && e.to === doc.id),
    'the flow cites the ADR',
  );
  assert.ok(g.nodes.some((n) => n.kind === 'doc' && n.doc?.path === 'docs/design/flows.md'));
});

test('two manifests use one id for two decisions: a note, and the first is kept', async () => {
  const dir = repo({
    'docs/design/screens.json': screens({ decisions: [{ id: 'D7', title: 'Vendor card timing', state: 'open' }] }),
    'apps/admin/docs/design/screens.json': JSON.stringify({
      screens: [{ id: 'A-1', name: 'Admin', route: '/admin' }],
      decisions: [{ id: 'D7', title: 'Banking-change verification', state: 'open', owner: 'Finance' }],
    }),
    'src/a.ts': '// DECISION(D7) queue the card on approval\nexport function approve() { return 1; }\n',
  });
  const g = await ingestRepo(dir, { repoName: 'r', ...only });
  const m = g.meta!.decisions!;
  assert.equal(m.decisions.length, 1);
  // manifests are read in path order: apps/admin/… before docs/…
  assert.equal(m.decisions[0]!.title, 'Banking-change verification');
  assert.equal(m.decisions[0]!.from, 'apps/admin/docs/design/screens.json');
  assert.ok(
    m.notes.some((n) => n.includes('one id for two decisions')),
    m.notes.join('\n'),
  );
  assert.equal(m.decisions[0]!.sites[0]!.nodeId, 'r::src/a.ts::approve');
});

test('the config overrides a manifest decision field by field, and may declare one of its own', async () => {
  const dir = repo({
    'docs/design/screens.json': screens({ decisions: [{ id: 'D1', title: 'Limit', state: 'open' }] }),
    'farsight.config.json': JSON.stringify({
      decisions: [
        { id: 'D1', state: 'decided', decided: '2026-10-01' },
        { id: 'D9', title: 'Identity', state: 'decided' },
        { id: 'D3' },
      ],
    }),
    'src/a.ts':
      'export function f() {\n  // DECISION(D9) one identity across clients\n  return g();\n}\nfunction g() { return 2; }\n',
  });
  const g = await ingestRepo(dir, { repoName: 'r', ...only });
  const m = g.meta!.decisions!;
  const d1 = m.decisions.find((d) => d.id === 'D1')!;
  assert.equal(d1.state, 'decided');
  assert.equal(d1.decided, '2026-10-01');
  assert.equal(d1.title, 'Limit');
  assert.equal(d1.from, 'farsight.config.json');
  const d9 = m.decisions.find((d) => d.id === 'D9')!;
  assert.equal(d9.declared, true);
  // inside a body: the innermost node holding the line
  assert.equal(d9.sites[0]!.nodeId, 'r::src/a.ts::f');
  assert.ok(
    m.notes.some((n) => n.includes('"D3" is named by farsight.config.json')),
    m.notes.join('\n'),
  );
  assert.ok(!m.decisions.some((d) => d.id === 'D3'));
});

test('an ADR named in a @business sentence is cited, and an anchor quotes its own section', async () => {
  const dir = repo({
    'docs/decisions/0007-partner-executed-payments.md':
      '# 0007 — Partner-executed payments\n\n- **Status:** Accepted\n\nThe payment partner moves the money; the platform only instructs it.\nIt never holds funds.\n\n## Context\n\nWhy.\n',
    'docs/product/open.md':
      '# Open decisions\n\nIntro.\n\n## D7 — Payee banking-change verification policy\n\nWho verifies a payee bank-detail change is undecided.\n\n## D8 — SLA\n\nNone.\n',
    'src/pay.ts':
      '/**\n * @business Instructs the partner to pay, as ADR 0007 sets out.\n */\nexport function pay() { return 1; }\n',
  });
  const g = await ingestRepo(dir, { repoName: 'r', ...only });
  const doc = g.nodes.find((n) => n.kind === 'doc')!;
  assert.equal(doc.doc?.title, '0007 — Partner-executed payments');
  assert.equal(doc.doc?.status, 'Accepted');
  assert.equal(
    doc.doc?.quote,
    'The payment partner moves the money; the platform only instructs it. It never holds funds.',
  );
  assert.ok(
    g.edges.some(
      (e) => e.kind === 'cites' && e.from === 'r::src/pay.ts::pay' && e.to === doc.id && e.meta?.via === 'text',
    ),
  );
  const d7 = readDocQuote(dir, 'docs/product/open.md', 'd7');
  assert.equal(d7?.title, 'D7 — Payee banking-change verification policy');
  assert.equal(d7?.quote, 'Who verifies a payee bank-detail change is undecided.');
  // a path that leaves the source is never read
  assert.equal(readDocQuote(dir, '../etc/passwd'), undefined);
});

test('a long first paragraph is cut at a word and says so; nothing is reworded', () => {
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  const dir = repo({ 'docs/long.md': `# Long\n\n${words}\n` });
  const ref = readDocQuote(dir, 'docs/long.md')!;
  assert.equal(ref.cut, true);
  assert.ok(ref.quote!.length <= 400);
  assert.ok(words.startsWith(ref.quote!));
  assert.ok(/word\d+$/.test(ref.quote!));
});

test('an ADR whose metadata is a block of long bold-key items quotes the paragraph after it, links read as their words', () => {
  const dir = repo({
    'docs/decisions/0031-sign-in.md':
      '# 0031 — Sign-in\n\n- **Status:** Accepted — amended by [ADR 0021](0021-x.md) (2026-09-05: a very long amendment note that runs on well past one hundred and twenty characters of text, as real ADRs do)\n- **Deciders:** the owner, for\n  everything in the tenant\n\nOperators sign in with **Entra ID** through the `openid-client` library; see [the plan](../plan.md).\n',
  });
  const ref = readDocQuote(dir, 'docs/decisions/0031-sign-in.md')!;
  assert.equal(ref.quote, 'Operators sign in with Entra ID through the openid-client library; see the plan.');
  assert.ok(ref.status!.startsWith('Accepted — amended by ADR 0021 (2026-09-05'), ref.status);
});

test('a leading quoted note is passed over for the first paragraph', () => {
  const dir = repo({
    'docs/adr/0015-x.md': '# 0015 — X\n\n> 2026-07-12 revisions:\n> 1. inverted\n\nThe system of record is the ERP.\n',
  });
  assert.equal(readDocQuote(dir, 'docs/adr/0015-x.md')!.quote, 'The system of record is the ERP.');
});
