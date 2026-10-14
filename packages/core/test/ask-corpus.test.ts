// The ASK corpus (outsider round 2026-10-13, F7): the questions three outsiders asked of the reference app, as they
// worded them, answered on the examples/invoice-app fixture. Each must land in the shape the corpus names — as worded,
// or read as its nearest shape with the reading printed first (*I read that as: …*), never silently — and a question
// no grammar over code can answer must say so with *did you mean*, never a guess. Fails when a question regresses to
// *not one of the shapes Ask understands*. Ingests the fixture with the built parsers into memory (no files written).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { GraphStore, stitchHttp, buildIndex, ask, askLines, readAs, countedProblems, STRINGS } from '../dist/index.js';
import type { GraphIndex, GraphMeta, TourClause, AskAnswer } from '../dist/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const corpus = JSON.parse(readFileSync(new URL('./fixtures/ask-corpus.json', import.meta.url), 'utf8')) as {
  questions: { from: string; q: string; shape?: string; reworded?: boolean; pick?: string; says?: string; outside?: string }[];
};

let index: GraphIndex;
let meta: GraphMeta;

before(async () => {
  const { ingestRepo } = await import(pathToFileURL(join(repoRoot, 'packages/parsers/dist/index.js')).href) as { ingestRepo: (root: string, o: { repoName: string }) => Promise<any> };
  const store = new GraphStore();
  const fragment = await ingestRepo(join(repoRoot, 'examples/invoice-app'), { repoName: 'invoice-app' });
  store.addFragment(fragment);
  stitchHttp(store);
  const { nodes, edges } = store.toJSON();
  index = buildIndex(nodes, edges);
  meta = store.meta;
});

/** Identifier-shaped tokens — the e2e identifier walk's list (journey-numbers.pw.spec.ts). */
const IDENTIFIER = /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Z0-9]+_[A-Z0-9_]+\b|(?:^|[\s(])\/[\w.:{}-]+|\b(?:GET|POST|PUT|PATCH|DELETE)\b|\b[\w-]+\.(?:spec|test|pw)\b|\.(?:tsx?|jsx?|mjs|json)\b/;

const lines = (a: AskAnswer): TourClause[] => [...a.lead, ...a.sections.flatMap((s) => s.rows)];

function problems(a: AskAnswer, where: string): string[] {
  const out: string[] = [];
  for (const c of lines(a)) {
    if (!STRINGS[c.key]) out.push(`${where}: ${c.key} is not in the catalog`);
    if (c.bizKey && !STRINGS[c.bizKey]) out.push(`${where}: ${c.bizKey} is not in the catalog`);
    for (const id of c.cites) if (!index.byId.has(id)) out.push(`${where}: cites ${id}, not in the graph`);
    if ('count' in c.vars) { if (!c.counted) out.push(`${where} (${c.key}): {count} with no Counted`); else out.push(...countedProblems(c.counted, `${where} (${c.key})`)); }
    if (/\{\w+\}/.test(c.text) || /\{\w+\}/.test(c.biz)) out.push(`${where} (${c.key}): an unfilled placeholder`);
    const m = IDENTIFIER.exec(c.biz);
    if (m) out.push(`${where} (${c.key}): business prints "${m[0]}" — ${c.biz}`);
  }
  return out;
}

test('the ASK corpus: every question the outsiders asked lands in its shape, as worded or with its reading printed first', () => {
  const bad: string[] = [];
  const tally = { asWorded: 0, reworded: 0, outside: 0 };
  for (const e of corpus.questions) {
    const a = ask(index, e.q, { metas: meta.journeys });
    const where = `[${e.from}] ${e.q}`;
    if (e.outside) {
      tally.outside++;
      if (a.shape !== 'unknown') bad.push(`${where}: outside the grammar (${e.outside}), but read as ${a.shape}${a.reworded ? ` — “${a.reworded}”` : ''}`);
      else if (!a.shapes?.length) bad.push(`${where}: unknown without the shapes`);
      continue;
    }
    if (a.shape === 'unknown') { bad.push(`${where}: fell to did you mean — expected ${e.shape}`); continue; }
    if (a.shape !== e.shape) bad.push(`${where}: read as ${a.shape}, expected ${e.shape}`);
    if (e.reworded) {
      tally.reworded++;
      if (!a.reworded) bad.push(`${where}: answered as ${a.shape} with no reading printed`);
      else if (!/^ask\.reworded/.test(a.lead[0]!.key)) bad.push(`${where}: the reading is not the first line`);
    } else {
      tally.asWorded++;
      if (a.reworded) bad.push(`${where}: a shape as worded, but reworded as “${a.reworded}”`);
    }
    if (e.pick && !a.resolved.some((r) => r.id === e.pick) && !lines(a).some((c) => c.cites.includes(e.pick!))) bad.push(`${where}: did not pick ${e.pick} (picked ${a.resolved.map((r) => r.id).join(', ') || 'nothing'})`);
    if (e.says && !askLines(a).join('\n').includes(e.says)) bad.push(`${where}: never says “${e.says}”`);
    bad.push(...problems(a, where));
  }
  console.log(`ask corpus: ${corpus.questions.length} questions · ${tally.asWorded} in a shape as worded · ${tally.reworded} read as their nearest shape, the reading shown · ${tally.outside} outside the grammar`);
  assert.deepEqual(bad, []);
  assert.ok(corpus.questions.length >= 40);
});

test('the eight seed questions as worded: none falls to did you mean', () => {
  const seeds = corpus.questions.filter((e) => e.from === 'seed');
  assert.equal(seeds.length, 8);
  for (const e of seeds) assert.notEqual(ask(index, e.q, { metas: meta.journeys }).shape, 'unknown', e.q);
});

test('who may: the roles the code hands the check, from the code — and a role the code does not allow is refused in words', () => {
  const a = ask(index, 'Who is allowed to approve an invoice?', { metas: meta.journeys });
  assert.equal(a.shape, 'who');
  assert.equal(a.reworded, 'who may approve an invoice?');
  assert.equal(a.lead[0]!.text, 'I read that as: “who may approve an invoice?”');
  assert.match(a.lead[1]!.text, /billing:admin/);
  assert.match(a.lead[1]!.biz, /billing admin/);
  const no = ask(index, 'Can a reviewer approve an invoice?', { metas: meta.journeys });
  assert.ok(no.lead.some((c) => c.key === 'ask.who.no'), 'a role the code does not hand the check is a no');
  // asked in the shape itself, there is no reading line
  const asWorded = ask(index, 'who may approve an invoice', { metas: meta.journeys });
  assert.equal(asWorded.reworded, undefined);
  assert.equal(asWorded.shape, 'who');
});

test('what is required to <verb> <record>: the set shape, the verb read as the status it names — and said', () => {
  const a = ask(index, 'What is required to approve an invoice?', { metas: meta.journeys });
  assert.equal(a.shape, 'set');
  assert.equal(a.lead[0]!.key, 'ask.reworded.status');
  assert.equal(a.lead[0]!.text, 'I read that as: “where is invoice set to approved, and what must be true first?” — “approve” is the invoice’s status approved.');
  assert.ok(a.lead[0]!.cites.includes('invoice-app::table::invoices'));
  const r = readAs(index, 'When does the business actually pay, and where is the payment recorded?');
  assert.equal(r?.shape, 'set');
  assert.equal(r?.verb?.status, 'paid');
});

test('can it be configured: what the code holds, or the absence word scoped to the question — never *it cannot*', () => {
  const none = ask(index, 'Can you configure what is required on an invoice?', { metas: meta.journeys });
  assert.equal(none.shape, 'configure');
  assert.ok(none.lead.some((c) => c.key === 'ask.configure.none'));
  assert.match(none.lead.find((c) => c.key === 'ask.configure.none')!.text, /nothing of this kind was found/);
  const all = ask(index, 'what can be configured?', { metas: meta.journeys });
  assert.equal(all.shape, 'configure');
  const head = all.lead.find((c) => c.key === 'ask.configure.headAll');
  assert.ok(head && head.counted && head.counted.n >= 1, 'the fixture reads its settings from config/env.ts');
});

test('what happens when: the moves out of a status, or that nothing moves it on', () => {
  const a = ask(index, 'what happens to an invoice once it is open?', { metas: meta.journeys });
  assert.equal(a.shape, 'happens');
  assert.ok(a.lead.some((c) => c.key === 'ask.happens.head' || c.key === 'ask.happens.stays'));
  for (const c of lines(a)) assert.ok(STRINGS[c.key], c.key);
});
