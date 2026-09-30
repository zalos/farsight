import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureProvider, INVOICE_APP_FIXTURE } from '../dist/index.js';
import type { PullPage, SourceConfig, WorkListDocument } from '@farsight/work';
import { WORK_SCHEMA } from '@farsight/work';
import { validate } from '../../core/test/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-work-v1.schema.json'), 'utf8'));

function copyFixture(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'work-fixture-')), 'invoice-app');
  cpSync(INVOICE_APP_FIXTURE, dir, { recursive: true });
  return dir;
}
const cfg = (path: string): SourceConfig => ({ id: 'invoice-jira', type: 'work', provider: 'fixture', path, scope: { projects: ['INV'] } });
async function drain(it: AsyncIterable<PullPage>): Promise<PullPage[]> {
  const out: PullPage[] = [];
  for await (const p of it) out.push(p);
  return out;
}

test('fixture: a pull round-trips full → incremental → delete → nothing new', async () => {
  const p = createFixtureProvider();
  const s = await p.connect(cfg(copyFixture()), undefined);
  const full = await drain(p.pull(s, null, { projects: ['INV'] }));
  assert.equal(full.length, 2);
  assert.equal(full.at(-1)!.isLast, true);
  assert.equal(full.flatMap((x) => x.items).length, 8);
  const c0 = full.at(-1)!.cursor!;
  const inc = await drain(p.pull(s, c0, { projects: ['INV'] }));
  assert.deepEqual(inc.flatMap((x) => x.items.map((i) => i.key)).sort(), ['INV-5', 'INV-6', 'INV-9']);
  const del = await drain(p.pull(s, inc.at(-1)!.cursor, { projects: ['INV'] }));
  assert.deepEqual(del[0]!.deleted, ['work::invoice-jira::INV-7']);
  const quiet = await drain(p.pull(s, del.at(-1)!.cursor, { projects: ['INV'] }));
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0]!.items.length, 0);
  assert.equal(quiet[0]!.cursor, del.at(-1)!.cursor);
});

test('fixture: every recorded item is a valid farsight-work v1 record', async () => {
  const p = createFixtureProvider();
  const s = await p.connect(cfg(copyFixture()), undefined);
  const all = [...(await drain(p.pull(s, null, { projects: [] }))), ...(await drain(p.pull(s, '2026-09-18T10:00:00.000Z', { projects: [] })))];
  const doc: WorkListDocument = { schema: WORK_SCHEMA, generatedAt: 'now', sources: ['invoice-jira'], items: all.flatMap((x) => x.items) };
  assert.deepEqual(validate(doc, schema), []);
  const cats = new Set(doc.items.map((i) => i.type.category));
  for (const c of ['epic', 'story', 'task', 'bug']) assert.ok(cats.has(c as never), c);
});

test('fixture: discover, can, apply bumps the revision and hydrate reflects it', async () => {
  const dir = copyFixture();
  let t = 0;
  const p = createFixtureProvider({ now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, t++)) });
  const s = await p.connect(cfg(dir), undefined);
  const sch = await p.discover(s);
  assert.deepEqual(sch.states.map((x) => x.category), ['todo', 'in-progress', 'done']);
  const [inv8] = await p.hydrate(s, ['work::invoice-jira::INV-8']);
  assert.equal((await p.can(s, inv8!, 'transition')).allowed, false);
  assert.equal((await p.can(s, inv8!, 'comment')).allowed, true);
  const [inv5] = await p.hydrate(s, ['work::invoice-jira::INV-5']);
  const r = await p.apply(s, { id: 'i1', item: inv5!.id, action: 'comment', payload: { body: 'on it' }, requestedBy: { kind: 'human', id: '5b10ac8d82e05b22cc7d4ef5' }, baseRevision: inv5!.revision });
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(dir, 'applied.jsonl')));
  const [after] = await p.hydrate(s, [inv5!.id]);
  assert.equal(after!.revision, r.revision);
  assert.equal(after!.comments.at(-1)!.body.text, 'on it');
  assert.equal(after!.comments.at(-1)!.author.name, 'Ben Lindqvist');
  const stale = await p.apply(s, { id: 'i2', item: inv5!.id, action: 'comment', payload: { body: 'late' }, requestedBy: { kind: 'human', id: 'x' }, baseRevision: inv5!.revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
});
